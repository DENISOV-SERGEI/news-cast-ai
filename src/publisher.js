// Публикация одного поста (фото + подпись) в Telegram через Bot API.
//
// Алгоритм:
//   1) Берёт готовый JSON из posts/article-{index}.json (схема content-adaptor/v2).
//   2) Берёт social.telegram.draft и image_path.
//   3) POST {telegramApiBase}/bot{token}/sendPhoto (multipart/form-data).
//      Поля: chat_id, photo=<файл>, caption=<draft>.
//
// Telegram ограничивает caption до 1024 символов для sendPhoto. Если текст длиннее —
// обрезаем по последнему переводу строки, не ломая слова/абзацы.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config, log } from './config.js';
import { rateLimit } from './rateLimit.js';
import { fetchWithTimeout } from './http.js';
import { appendSourceLink, decorateTitle } from './utils.js';

const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_TEXT_LIMIT = 4096;

async function telegramApiCall(method, formData) {
  const url = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/${method}`;
  // Гейт по минимальному интервалу — защита от rate-limit/бана при всплеске
  // (публикация серии постов + monitoring + retry-волна).
  await rateLimit('telegram', config.telegramRateLimitMs);
  const res = await fetchWithTimeout(url, { method: 'POST', body: formData }, { timeoutMs: 30_000 });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Telegram ${method}: невалидный JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || !json.ok) {
    const desc = json.description || text.slice(0, 300);
    const e = new Error(`Telegram ${method}: HTTP ${res.status} ${desc}`);
    // 429 = Too Many Requests, 5xx = серверная ошибка Telegram — повторяем.
    // 4xx (кроме 429) — фатально (неверный токен, неверный chat_id и т.п.).
    e.retryable = res.status === 429 || res.status >= 500;
    if (res.status === 429 && json.parameters?.retry_after) {
      // Telegram просит подождать N секунд перед следующим запросом.
      e.retryAfter = Number(json.parameters.retry_after);
    }
    throw e;
  }
  return json.result;
}

/**
 * Эскейпит &, <, > для parse_mode=HTML в Telegram. Без этого сырой < или & в
 * тексте модели (а DeepSeek иногда вставляет) даёт 400 и пост падает.
 * `>` эскейпим для симметрии (Telegram требует экранировать & < >).
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Собирает капшон для Telegram (parse_mode=HTML): эскейпит каждую часть и
 * безопасно обрезает до limit С УЧЁТОМ длины после эскейпа.
 *
 * Эскейп удлиняет строку (& → &amp;), поэтому нельзя обрезать по RAW-длине —
 *escaped вариант может превысить 1024 → 400. Делаем бинарный поиск макс. cut
 * в RAW так, чтобы escapeHtml(raw.slice(0,cut)).length <= limit-1, затем
 * откатываем cut к границе слова/строки (в RAW) — резать entity нельзя.
 *
 * @param {string[]} parts — [title, draft, cta] (пустые отбрасываются).
 * @param {number} [limit=1024]
 * @returns {string} HTML-безопасный капшон ≤ limit символов.
 */
export function buildCaption(parts, limit = TELEGRAM_CAPTION_LIMIT) {
  const raw = (Array.isArray(parts) ? parts : [parts]).filter(Boolean).join('\n\n');
  if (!raw) return '';
  const escFull = escapeHtml(raw);
  if (escFull.length <= limit) return escFull;

  const target = limit - 1; // 1 символ резервируем под многоточие
  // Монотонность: длина escapeHtml(raw.slice(0,n)) не убывает по n → бинарный поиск.
  let lo = 0;
  let hi = raw.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (escapeHtml(raw.slice(0, mid)).length <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Откат к границе слова/строки (в RAW) — режем аккуратно, не посередине слова.
  let cut = best;
  const lastNl = raw.lastIndexOf('\n', cut);
  if (lastNl > cut * 0.6) {
    cut = lastNl;
  } else {
    const lastSp = raw.lastIndexOf(' ', cut);
    if (lastSp > 0) cut = lastSp;
  }
  return escapeHtml(raw.slice(0, cut)).trimEnd() + '…';
}

/**
 * Публикует один пост в Telegram.
 *
 * @param {object} post — минимум { json: <content-adaptor/v2 JSON>, imagePath: string }.
 * @returns {Promise<{ messageId: number, chatId: string|number, attachmentType: string }>}
 */
export async function publishPost(post) {
  const { json, imagePath } = post;
  if (!json || !json.social || !json.social.telegram || !json.social.telegram.draft) {
    throw new Error('publishPost: нет social.telegram.draft в JSON поста');
  }

  const titleRaw = (json.social.telegram.title || '').trim();
  const draft = (json.social.telegram.draft || '').trim();
  const cta = (json.social.telegram.cta || '').trim();
  // Заголовок префиксуем тематическим emoji (если его там ещё нет).
  const title = decorateTitle(titleRaw, draft);

  // Ссылка на оригинал статьи добавляется кодом паблишера, а не LLM —
  // чтобы модель не сломала URL. Текст берётся из SOURCE_LINK_LABEL.
  const sourceUrl = json?.source?.url || '';
  const body = [title, draft, cta].filter(Boolean).join('\n\n');
  const bodyWithLink = appendSourceLink(body, sourceUrl, config.sourceLinkLabel);

  // Без картинки: идём через sendMessage (лимит 4096 символов). С картинкой —
  // через sendPhoto (caption-лимит 1024, режется в buildCaption).
  if (!imagePath) {
    log('info', `Публикую в Telegram chat_id=${config.telegramChatId} текстом (без фото)…`);
    const text = buildCaption([bodyWithLink], TELEGRAM_TEXT_LIMIT);
    const form = new FormData();
    form.append('chat_id', String(config.telegramChatId));
    form.append('text', text);
    form.append('parse_mode', 'HTML');
    form.append('disable_web_page_preview', 'true');
    const result = await telegramApiCall('sendMessage', form);
    log('info', `Опубликовано (текст): message_id=${result.message_id}`);
    return {
      messageId: result.message_id,
      chatId: result.chat?.id ?? config.telegramChatId,
      attachmentType: 'text',
    };
  }

  // Заголовок включаем в подпись, чтобы он не потерялся при скрытии превью.
  // buildCaption эскейпит &<> (parse_mode=HTML) и режет по ESCAPED-длине ≤ 1024.
  // Передаём уже склеенный текст как один блок — ссылка должна попасть в капшон
  // целиком, даже если режется.
  const caption = buildCaption([bodyWithLink]);

  log('info', `Публикую в Telegram chat_id=${config.telegramChatId} фото ${basename(imagePath)}…`);

  const png = await readFile(imagePath);
  const form = new FormData();
  form.append('chat_id', String(config.telegramChatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML'); // допускаем минимальную разметку, если скилл её добавит
  form.append('photo', new Blob([png], { type: 'image/png' }), basename(imagePath));

  const result = await telegramApiCall('sendPhoto', form);
  log('info', `Опубликовано: message_id=${result.message_id}`);
  return {
    messageId: result.message_id,
    chatId: result.chat?.id ?? config.telegramChatId,
    attachmentType: 'photo',
  };
}

/** Диагностика: проверить, что бот доступен и chat_id валиден. */
export async function checkTelegramAccess() {
  try {
    const url = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/getMe`;
    const res = await fetchWithTimeout(url, {}, { timeoutMs: 15_000 });
    const json = await res.json();
    if (!json.ok) throw new Error(json.description || 'getMe вернул !ok');
    log('info', `Бот найден: @${json.result.username} (id=${json.result.id})`);

    // Пробуем получить chat (без сообщения — просто getChat)
    const chatUrl = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/getChat?chat_id=${encodeURIComponent(config.telegramChatId)}`;
    const chatRes = await fetchWithTimeout(chatUrl, {}, { timeoutMs: 15_000 });
    const chatJson = await chatRes.json();
    if (!chatJson.ok) throw new Error(`getChat: ${chatJson.description}`);
    log('info', `Чат найден: "${chatJson.result.title || chatJson.result.username || chatJson.result.id}"`);

    return true;
  } catch (e) {
    log('error', `Не удалось подтвердить доступ к Telegram: ${e.message}`);
    return false;
  }
}
