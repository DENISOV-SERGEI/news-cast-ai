// src/retry.js
// Переиспользуемая обёртка повторных попыток с экспоненциальной задержкой.
//
// Контракт «retryable»: функция помечает ошибку полем `err.retryable = true`,
// если повтор имеет смысл (HTTP 429/5xx, transient network). По умолчанию
// повторяем ТОЛЬКО такие ошибки — фатальные (4xx кроме 429, невалидный JSON,
// отсутствие обязательных полей) пробрасываются сразу, без холостых попыток.
//
// Уважает `err.retryAfter` (секунды) — если сервер сказал ждать, ждём столько,
// а не по экспоненте (используется для 429 Too Many Requests у Telegram/VK).
//
// Особое внимание — идемпотентность: эту обёртку безопасно применять только к
// операциям, которые можно повторить без побочных дублей. Для Telegram sendPhoto
// повтор идёт только по 429/5xx (где запрос точно не дошёл), а не по сетевым
// ошибкам (где ответ мог потеряться, но сообщение — опубликоваться).

import { log } from './config.js';
import { sleep } from './utils.js';

function defaultRetryOn(err) {
  return Boolean(err && err.retryable);
}

/**
 * Вызывает fn с повторными попытками.
 *
 * @param {function} fn — async-функция (без аргументов).
 * @param {object} [opts]
 * @param {number} [opts.retries=3] — число ПОВТОРОВ (т.е. всего попыток retries+1).
 * @param {number} [opts.baseMs=1000] — базовая задержка.
 * @param {number} [opts.factor=2] — множитель для экспоненты.
 * @param {number} [opts.maxMs=30000] — потолок задержки.
 * @param {number} [opts.jitterMs=200] — случайный разброс, чтобы не сходились «волнами».
 * @param {(err:Error)=>boolean} [opts.retryOn] — свой критерий повторяемости.
 * @param {string} [opts.label] — метка для логов.
 * @returns {Promise<*>} результат fn
 */
export async function retryWithBackoff(fn, opts = {}) {
  const {
    retries = 3,
    baseMs = 1000,
    factor = 2,
    maxMs = 30_000,
    jitterMs = 200,
    retryOn = defaultRetryOn,
    label = '',
  } = opts;

  const tag = label ? `[retry:${label}]` : '[retry]';
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && retryOn(err);
      if (!canRetry) throw err;

      let delay;
      const retryAfter = Number(err?.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        // Сервер явно сказал, сколько ждать (429 Retry-After) — секунды → мс.
        delay = Math.min(retryAfter * 1000, maxMs * 4);
      } else {
        delay = Math.min(baseMs * Math.pow(factor, attempt), maxMs);
      }
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      const total = delay + jitter;
      log('warn', `${tag} попытка ${attempt + 1}/${retries} не удалась: ${err.message}. Повтор через ${total}ms`);
      await sleep(total);
    }
  }
  throw lastErr;
}