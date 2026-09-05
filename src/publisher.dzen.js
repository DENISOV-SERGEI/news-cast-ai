// src/publisher.dzen.js
// Публикация поста в отдельный ПУБЛИЧНЫЙ Telegram-канал, откуда официальный
// бот @zen_sync_bot забирает контент в Яндекс Дзен.
//
// Зачем отдельный канал:
//   - Основной Telegram-канал обычно закрытый/для подписчиков и публикует
//     КОРОТКИЕ посты (social.telegram, ≤ 950 символов) без тегов.
//   - Дзену нужен развёрнутый текст (social.yandex_dzen, 1500-2500 символов)
//     с тегами и description в шапке. Если такой пост уйдёт в основной
//     канал — подписчики увидят длинную простыню.
//
//   Решение: отдельный публичный канал, в котором сидит @zen_sync_bot.
//   Бот сам слушает новые сообщения и переносит их в Дзен.
//
// Что делает publishToDzenSync:
//   1) Берёт social.yandex_dzen.{title, description, draft} (НЕ telegram).
//   2) Склеивает текст: title + description + draft (хештеги убраны по
//      требованию владельца канала — 2026-09-04).
//   3) Шлёт через Telegram Bot API ровно ОДНО сообщение в
//      TELEGRAM_DZEN_SYNC_CHAT_ID:
//        - с фото → sendPhoto, весь текст в caption (лимит 1024, длинное
//          обрезается с '…'. Дальше некуда: caption — единственный способ
//          держать фото и текст ОДНИМ постом);
//        - без фото → sendMessage (лимит 4096).
//
//   Почему строго одно сообщение: @zen_sync_bot превращает КАЖДОЕ сообщение
//   канала в отдельную статью Дзена. Раздельные sendPhoto + sendMessage
//   порождали две статьи (обложка отдельно, текст отдельно) — баг,
//   подтверждённый владельцем 2026-09-04.
//
// Контракт (как у остальных паблишеров):
//   - Бросает понятную ошибку, если фича выключена.
//   - Возвращает { messageId, chatId, attachmentType, method }.
//   - checkDzenSyncAccess(): getMe + getChat для синхронизирующего канала.

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { config, log } from './config.js';
import { rateLimit } from './rateLimit.js';
import { fetchWithTimeout } from './http.js';
import { escapeHtml } from './publisher.js';
import { decorateTitle } from './utils.js';

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
// Правила @zen_sync_bot (dzen.ru/help/ru/channel/cross-platform.html):
//   - заголовком статьи становится ПЕРВОЕ ПРЕДЛОЖЕНИЕ поста (макс. 140 символов);
//   - медиафайл переносится только если ≤ 20 МБ (берём с запасом).
const DZEN_TITLE_LIMIT = 140;
const DZEN_MAX_MEDIA_BYTES = 19 * 1024 * 1024;

/**
 * Гарантирует, что строка заканчивается знаком конца предложения.
 * Нужно для Дзена: первое предложение поста становится заголовком статьи.
 * Без финальной пунктуации Дзен склеит title со следующим предложением
 * (description) в один раздутый заголовок.
 */
function ensureSentenceEnd(s) {
  return /[.!?…]$/.test(s) ? s : s + '.';
}

/**
 * Обёртка над Telegram Bot API для синхронизирующего канала.
 * Структурно идентична telegramApiCall в publisher.js, но:
 *   - использует config.telegramDzenSyncChatId как chat_id (chat_id берётся
 *     из тела запроса, см. ниже);
 *   - возвращает ту же ошибку с retryable/retryAfter.
 *
 * @param {string} method — имя метода (sendMessage / sendPhoto).
 * @param {FormData} formData — уже сформированный multipart.
 * @returns {Promise<object>} json.result Telegram.
 */
async function telegramApiCallDzen(method, formData) {
  const url = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/${method}`;
  await rateLimit('telegram', config.telegramRateLimitMs);
  const res = await fetchWithTimeout(url, { method: 'POST', body: formData }, { timeoutMs: 30_000 });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Telegram Dzen ${method}: невалидный JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || !json.ok) {
    const desc = json.description || text.slice(0, 300);
    const e = new Error(`Telegram Dzen ${method}: HTTP ${res.status} ${desc}`);
    e.retryable = res.status === 429 || res.status >= 500;
    if (res.status === 429 && json.parameters?.retry_after) {
      e.retryAfter = Number(json.parameters.retry_after);
    }
    throw e;
  }
  return json.result;
}

/**
 * Формирует хештеги из массива тегов (для Яндекс Дзен).
 * Теги из social.yandex_dzen.tags уже идут как обычные слова без '#';
 * префиксуем и схлопываем пробелы.
 *
 * @param {string[]} tags
 * @returns {string} строка вида "#ai #нейросети #openai" или ''.
 */
export function buildHashtags(tags) {
  if (!Array.isArray(tags)) return '';
  const out = [];
  for (const t of tags) {
    const cleaned = String(t || '').trim().replace(/^#+/, '').replace(/\s+/g, '_');
    if (cleaned) out.push(`#${cleaned}`);
  }
  return out.join(' ');
}

/**
 * Собирает «дзен-сообщение» для синхронизирующего Telegram-канала.
 *   - title — первая строка (жирный не поддерживается в parse_mode=HTML
 *     для простоты; используем emoji из decorateTitle).
 *   - description — короткое описание после заголовка (если есть).
 *   - draft — основной текст.
 *
 * Хештеги НЕ добавляются (решение владельца канала, 2026-09-04): в тексте
 * статьи они выглядят лишними, а обложку и рубрику Дзен берёт из поста.
 *
 * Эскейпинг: parse_mode=HTML → эскейпим & < > (escapeHtml из publisher.js).
 * Длина: возвращает { html, plain }. Если html.length > 4096 — это уже
 * за пределами Telegram sendMessage, надо резать.
 *
 * @param {object} json — content-adaptor/v2 JSON.
 * @returns {{ html: string, plain: string }}
 */
export function buildDzenMessage(json) {
  const zen = json?.social?.yandex_dzen;
  if (!zen || (!zen.draft && !zen.title)) {
    throw new Error('buildDzenMessage: в json нет social.yandex_dzen.{title,draft}');
  }
  const titleRaw = (zen.title || '').trim();
  const draft = (zen.draft || '').trim();
  const description = (zen.description || '').trim();

  // Тематический emoji в заголовке — как в VK/Telegram.
  let title = decorateTitle(titleRaw, draft);
  // Заголовок Дзена = первое предложение поста, лимит 140 символов:
  // точку добавляем всегда, переполнение сигнализируем (обрезать нельзя —
  // потеряем смысл; лучше увидеть в логе и поправить промпт).
  title = ensureSentenceEnd(title);
  if (title.length > DZEN_TITLE_LIMIT) {
    log('warn', `[dzen-sync] title ${title.length} символов > лимита Дзена (140): "${title.slice(0, 60)}…" — Дзен обрежет заголовок`);
  }

  const parts = [];
  if (title) parts.push(title);
  if (description) parts.push(description);
  if (draft) parts.push(draft);

  const plain = parts.join('\n\n');
  // HTML-эскейп каждой части по отдельности — чтобы между блоками остались \n\n.
  const html = parts.map(escapeHtml).join('\n\n');
  return { html, plain };
}

/**
 * Длина строки «по проводам»: multipart/form-data нормализует '\n' → '\r\n',
 * поэтому каждый перевод строки добавляет +1 символ к JS-длине. Telegram
 * считает лимит caption/text по фактически принятой строке — считаем так же.
 * (Регрессия 2026-09-04: caption 1021 JS-символа с 4 '\n' уезжал как 1025.)
 */
function wireLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.length + n;
}

/**
 * Обрезает html/plain до лимита с учётом длины ПОСЛЕ эскейпа и CRLF-
 * нормализации multipart (см. wireLength).
 *
 * Откат к границе в порядке приоритета: предложение → абзац → слово.
 * Это страховка от обрезания на пол фразы: даже если текст превысил лимит,
 * обрезка не оставит обрыв посреди предложения.
 *
 * @param {string} html
 * @param {number} limit
 * @returns {string}
 */
export function trimToLimit(html, limit = TELEGRAM_TEXT_LIMIT) {
  if (wireLength(html) <= limit) return html;
  const target = limit - 1; // резерв под '…'
  // Бинарный поиск границы по wire-длине (эскейп уже выполнен, '\n' → '\r\n').
  let lo = 0;
  let hi = html.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (wireLength(html.slice(0, mid)) <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  let cut = best;
  // 1) Граница предложения — последний знак конца предложения перед точкой реза.
  const lastSentence = Math.max(
    html.lastIndexOf('.', cut),
    html.lastIndexOf('!', cut),
    html.lastIndexOf('?', cut),
    html.lastIndexOf('…', cut),
  );
  if (lastSentence > cut * 0.5) {
    cut = lastSentence + 1; // включая знак конца предложения
  } else {
    // 2) Граница абзаца.
    const lastNl = html.lastIndexOf('\n', cut);
    if (lastNl > cut * 0.6) {
      cut = lastNl;
    } else {
      // 3) Граница слова.
      const lastSp = html.lastIndexOf(' ', cut);
      if (lastSp > 0) cut = lastSp;
    }
  }
  return html.slice(0, cut).trimEnd() + '…';
}

/**
 * Публикует пост в канал @zen_sync_bot (синхронизация с Яндекс Дзен).
 *
 * Алгоритм (ВСЕГДА ровно одно сообщение — иначе @zen_sync_bot плодит статьи):
 *   - есть фото → один sendPhoto, весь текст в caption. Лимит caption 1024
 *     символа: длинный текст обрезается trimToLimit с предупреждением (Дзен
 *     получит сокращённую версию статьи — это плата за «фото и текст в
 *     одном посте»).
 *   - нет фото → один sendMessage с полным текстом (лимит 4096, дальше режем).
 *
 * @param {object} json — content-adaptor/v2 JSON.
 * @param {string|null} imagePath — путь к PNG (опционально).
 * @returns {Promise<{ messageId: number, chatId: string|number, attachmentType: string, method: string }>}
 */
export async function publishToDzenSync(json, imagePath) {
  if (!config.features.dzenSync) {
    throw new Error('publishToDzenSync: TELEGRAM_DZEN_SYNC_CHAT_ID не задан в .env');
  }
  const { html } = buildDzenMessage(json);
  const chatId = config.telegramDzenSyncChatId;

  // Правило Дзена: медиа > 20 МБ бот не переносит. Проверяем заранее:
  // тяжёлое фото → fallback на текст-онли, чтобы статья не ушла без текста.
  let effectiveImagePath = imagePath;
  if (imagePath) {
    try {
      const { size } = await stat(imagePath);
      if (size > DZEN_MAX_MEDIA_BYTES) {
        log('warn', `[dzen-sync] изображение ${(size / 1024 / 1024).toFixed(1)} МБ > лимита Дзена (20 МБ) — шлю без фото`);
        effectiveImagePath = null;
      }
    } catch {
      // stat не сработал — readFile ниже сам кинет понятную ошибку.
    }
  }

  // Вариант с фото: всё одним sendPhoto, текст — в caption (лимит 1024).
  if (effectiveImagePath) {
    let caption = html;
    if (wireLength(html) > TELEGRAM_CAPTION_LIMIT) {
      log('warn', `[dzen-sync] текст ${wireLength(html)} символов > лимита caption (1024): обрезаю — Дзен получит сокращённую версию`);
      caption = trimToLimit(html, TELEGRAM_CAPTION_LIMIT);
    }
    log('info', `[dzen-sync] chat_id=${chatId}: sendPhoto (caption ${wireLength(caption)} символов)`);
    const png = await readFile(effectiveImagePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([png], { type: 'image/png' }), basename(effectiveImagePath));
    const result = await telegramApiCallDzen('sendPhoto', form);
    log('info', `[dzen-sync] Опубликовано: message_id=${result.message_id}`);
    return {
      messageId: result.message_id,
      chatId: result.chat?.id ?? chatId,
      attachmentType: 'photo',
      method: 'sendPhoto',
    };
  }

  // Без фото — один sendMessage (лимит 4096).
  let text = html;
  if (wireLength(html) > TELEGRAM_TEXT_LIMIT) {
    log('warn', `[dzen-sync] текст ${wireLength(html)} > 4096, обрезаю до лимита (модель выдала слишком длинный draft)`);
    text = trimToLimit(html, TELEGRAM_TEXT_LIMIT);
  }
  log('info', `[dzen-sync] chat_id=${chatId}: sendMessage (${wireLength(text)} символов)`);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('text', text);
  form.append('parse_mode', 'HTML');
  form.append('disable_web_page_preview', 'true');
  const result = await telegramApiCallDzen('sendMessage', form);
  log('info', `[dzen-sync] Опубликовано: message_id=${result.message_id}`);
  return {
    messageId: result.message_id,
    chatId: result.chat?.id ?? chatId,
    attachmentType: 'text',
    method: 'sendMessage',
  };
}

/** Диагностика: проверить, что синхро-канал доступен боту. */
export async function checkDzenSyncAccess() {
  if (!config.features.dzenSync) {
    log('warn', '[dzen-sync] TELEGRAM_DZEN_SYNC_CHAT_ID не задан — синхронизация с Дзен через Telegram будет пропущена');
    return false;
  }
  try {
    // getMe — проверить токен.
    const meUrl = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/getMe`;
    const meRes = await fetchWithTimeout(meUrl, {}, { timeoutMs: 15_000 });
    const meJson = await meRes.json();
    if (!meJson.ok) throw new Error(meJson.description || 'getMe вернул !ok');

    // getChat — проверить, что канал существует и бот — админ.
    const chatUrl = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/getChat?chat_id=${encodeURIComponent(config.telegramDzenSyncChatId)}`;
    const chatRes = await fetchWithTimeout(chatUrl, {}, { timeoutMs: 15_000 });
    const chatJson = await chatRes.json();
    if (!chatJson.ok) throw new Error(`getChat: ${chatJson.description}`);
    const title = chatJson.result.title || chatJson.result.username || chatJson.result.id;
    log('info', `[dzen-sync] Канал найден: "${title}" (id=${chatJson.result.id}, type=${chatJson.result.type})`);
    // Лёгкая проверка публичности: для канала Telegram возвращает type=channel.
    if (chatJson.result.type && chatJson.result.type !== 'channel' && chatJson.result.type !== 'supergroup') {
      log('warn', `[dzen-sync] Канал имеет type="${chatJson.result.type}", но @zen_sync_bot требует ПУБЛИЧНЫЙ канал. Убедитесь, что @zen_sync_bot добавлен.`);
    }
    return true;
  } catch (e) {
    log('error', `[dzen-sync] Не удалось подтвердить доступ: ${e.message}`);
    return false;
  }
}