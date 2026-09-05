// src/publisher.vk.js
// Публикация одного поста в группу VK через wall.post.
//
// Два независимых пути загрузки картинки (оба с групповым токеном — user-token
// НЕ нужен; scope `photos` в 2026 не выдаётся Standalone-приложениям без
// отдельной модерации VK, см. memory/vk-user-token-blocked):
//
//   A) Open Graph (основной). В wall.post идёт текст + ссылка на оригинал. VK
//      сам подтягивает og:image со страницы источника и рендерит превью.
//      Работает без кода — это поведение VK по умолчанию при наличии URL.
//
//   B) docs.save (fallback). Если источник не отдаёт og:image, или VK-бот
//      заблокирован, или домен в VK_OG_FALLBACK_DOMAINS — грузим наш PNG:
//        1) docs.getWallUploadServer (group_id=VK_GROUP_ID) → upload_url
//        2) POST multipart/form-data на upload_url (formData: file=PNG)
//        3) docs.save → { type:'doc', doc:{id, owner_id, access_key, ...} }
//        4) wall.post с attachments=doc{owner_id}_{id}_{access_key}
//      VK отрендерит PNG как image-preview в посте.
//
// Без imagePath — сразу wall.post (owner_id=-VK_GROUP_ID, from_group=1).
//
// VK API:  POST https://api.vk.com/method/<method>, параметры и access_token —
//   в теле запроса (form-urlencoded), НЕ в query-string (безопасность, см. vkCall).
//
// Особенности:
//   - VK API возвращает {response: ...} при успехе и {error: {error_code, error_msg}}
//     при ошибке. Проверяем оба варианта.
//   - docs.* методы требуют scope `docs` — обычно доступен Standalone-приложениям
//     без модерации (в отличие от `photos`).
//   - На любую ошибку upload-шага падаем с понятным сообщением: post с фото
//     не пройдёт, но scheduler/per-channel дедуп не сломается.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config, log } from './config.js';
import { rateLimit } from './rateLimit.js';
import { fetchWithTimeout } from './http.js';
import { appendSourceLink, decorateTitle } from './utils.js';

const VK_API = 'https://api.vk.com/method';

async function vkCall(method, params, opts = {}) {
  // opts.token — переопределить токен. По умолчанию VK_ACCESS_TOKEN (групповой).
  // Все параметры (включая access_token) уходят в ТЕЛЕ POST-запроса
  // (application/x-www-form-urlencoded), а не в query-string — иначе токен
  // светится в access-логах прокси/VK и в сообщениях об ошибках с URL.
  const url = `${VK_API}/${method}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  body.set('access_token', opts.token || config.vkAccessToken);
  body.set('v', config.vkApiVersion);
  // Гейт по минимальному интервалу — защита от VK error_code=6 "Too many requests".
  // Один пост = 3-4 вызова API подряд; без гейта при серии постов получим 6.
  await rateLimit('vk', config.vkRateLimitMs);
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { timeoutMs: 20_000 },
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`VK ${method}: невалидный JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (json.error) {
    const code = json.error.error_code;
    const msg = json.error.error_msg || JSON.stringify(json.error);
    const e = new Error(`VK ${method} (code=${code}): ${msg}`);
    // 14 = капча, 5 = auth, 17 = redirect, 6 = too many requests — retryable
    e.retryable = code === 6 || code === 429;
    e.code = code;
    throw e;
  }
  return json.response;
}

/**
 * POST multipart/form-data на upload_url VK. Используется для загрузки PNG
 * как документа (docs.getWallUploadServer). Возвращает распарсенный JSON-ответ
 * upload_url (там лежит поле `file` — URL файла в VK CDN, который нужно
 * передать в docs.save).
 */
async function uploadToVKUploadUrl(uploadUrl, buffer, filename, fieldName = 'file') {
  const form = new FormData();
  form.append(fieldName, new Blob([buffer], { type: 'image/png' }), filename);
  const res = await fetchWithTimeout(
    uploadUrl,
    { method: 'POST', body: form },
    { timeoutMs: 60_000 },
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `VK upload ${fieldName}: невалидный JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok || json.error) {
    throw new Error(
      `VK upload ${fieldName}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return json;
}

/**
 * Загружает PNG как документ сообщества через docs.* и возвращает объект doc
 * ({id, owner_id, access_key, ...}) для последующего прикрепления к wall.post.
 */
async function uploadDoc(buffer, filename) {
  // 1) Получаем upload_url для документов сообщества. docs.getWallUploadServer
  //    работает с групповым токеном и не требует scope `photos` (это другой API).
  const server = await vkCall('docs.getWallUploadServer', {
    group_id: Math.abs(Number(config.vkGroupId)),
  });
  if (!server || !server.upload_url) {
    throw new Error(`docs.getWallUploadServer вернул неожиданный ответ: ${JSON.stringify(server)}`);
  }
  // 2) Загружаем файл. upload_url отдаёт {file: "<URL>"} — это URL файла в VK CDN.
  const uploaded = await uploadToVKUploadUrl(server.upload_url, buffer, filename, 'file');
  if (!uploaded.file) {
    throw new Error(`docs upload: VK не вернул file: ${JSON.stringify(uploaded)}`);
  }
  // 3) Сохраняем документ. VK API возвращает объект {type:'doc', doc:{id, owner_id, ...}}
  //    или массив таких (для batch). Достаём сам документ.
  const saved = await vkCall('docs.save', {
    file: uploaded.file,
    title: filename.replace(/\.png$/i, ''),
    tags: 'news,ai',
  });
  let doc;
  if (Array.isArray(saved)) {
    doc = saved[0];
  } else if (saved && typeof saved === 'object' && saved.doc) {
    // Обёртка {type, doc:{...}} — стандартный ответ docs.save.
    doc = saved.doc;
  } else {
    doc = saved; // плоский {id, owner_id, access_key}
  }
  if (!doc || !doc.id) {
    throw new Error(`docs.save вернул неожиданный формат: ${JSON.stringify(saved)}`);
  }
  return doc;
}

/**
 * Решает, нужен ли fallback на docs.save (т.е. OG-путь не сработает).
 * Возвращает true, если заведомо надо грузить наш PNG.
 */
export function needsDocsFallback(sourceUrl) {
  if (!sourceUrl) return true; // нет ссылки — VK нечего подтягивать
  let host;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return true; // невалидный URL — fallback
  }
  return config.vkOgFallbackDomains.includes(host);
}

/**
 * Публикует пост в группу VK.
 *
 * @param {object} json — полный JSON по схеме content-adaptor/v2
 * @param {string|null} imagePath — путь к PNG (опционально)
 * @returns {Promise<{ postId: number, ownerId: number, hasPhoto: boolean }>}
 */
export async function publishToVK(json, imagePath) {
  if (!config.features.vk) {
    throw new Error('publishToVK: VK_ACCESS_TOKEN / VK_GROUP_ID не заданы в .env');
  }
  const vk = json?.social?.vk;
  if (!vk || !vk.draft) {
    throw new Error('publishToVK: в json нет social.vk.draft');
  }

  const titleRaw = (vk.title || '').trim();
  const draft = (vk.draft || '').trim();
  const cta = (vk.cta || '').trim();
  // Заголовок префиксуем тематическим emoji (если его там ещё нет).
  const title = decorateTitle(titleRaw, draft);
  // VK не любит пустые блоки, склеиваем с одиночными переносами.
  const body = [title, draft, cta].filter(Boolean).join('\n\n');
  // Ссылка на оригинал добавляется кодом, не моделью, чтобы не сломать URL.
  // VK сам подтянет og:image со страницы источника — это наш основной путь.
  const message = appendSourceLink(body, json?.source?.url, config.sourceLinkLabel);
  const ownerId = -Math.abs(Number(config.vkGroupId));

  // 1) Attachment (если imagePath задан и OG-путь не подходит).
  //    needsDocsFallback: true → идём через docs.save; false → полагаемся на OG.
  let attachment = null;
  if (imagePath) {
    const sourceUrl = json?.source?.url || '';
    if (!needsDocsFallback(sourceUrl)) {
      log('info', '[vk] OG-путь: полагаемся на og:image источника, attachment не прикрепляем');
    } else {
      log('info', '[vk] OG-fallback → docs.save: загружаю PNG как документ');
      const buf = await readFile(imagePath);
      const doc = await uploadDoc(buf, basename(imagePath));
      attachment = `doc${doc.owner_id}_${doc.id}_${doc.access_key || ''}`.replace(/_+$/, '');
      log('info', `[vk] docs.save OK: ${attachment}`);
    }
  }

  // 2) wall.post — групповым токеном (от имени сообщества).
  const postParams = {
    owner_id: ownerId,
    from_group: 1,
    message,
    signed: 0,
    publish_date: 0,
  };
  if (attachment) postParams.attachments = attachment;

  const resp = await vkCall('wall.post', postParams);
  // wall.post возвращает объект {post_id, ...}; для scheduler/per-channel дедупа
  // и логов нужен скаляр post_id. Если VK вернул что-то странное — падаем с понятным сообщением.
  const postId =
    typeof resp === 'number'
      ? resp
      : resp && typeof resp === 'object' && resp.post_id != null
        ? Number(resp.post_id)
        : null;
  if (postId == null) {
    throw new Error(`publishToVK: wall.post вернул неожиданный ответ: ${JSON.stringify(resp)}`);
  }
  log('info', `[vk] Опубликовано: post_id=${postId} (фото: ${attachment ? 'да' : 'нет'})`);
  return { postId, ownerId, hasPhoto: Boolean(attachment) };
}

/** Проверяет токен и группу (groups.getById). */
export async function checkVKAccess() {
  if (!config.features.vk) {
    log('warn', '[vk] VK_ACCESS_TOKEN / VK_GROUP_ID не заданы — публикация в VK будет пропущена');
    return false;
  }
  try {
    const resp = await vkCall('groups.getById', { group_id: config.vkGroupId });
    const g = Array.isArray(resp) ? resp[0] : resp;
    log('info', `[vk] Группа найдена: "${g.name}" (id=${g.id}, screen=${g.screen_name || '-'})`);
    return true;
  } catch (e) {
    log('error', `[vk] Не удалось подтвердить доступ: ${e.message}`);
    return false;
  }
}
