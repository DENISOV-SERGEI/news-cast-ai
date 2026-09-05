// src/http.js
// fetch с таймаутом. Все внешние сетевые вызовы в проекте идут через эту обёртку,
// чтобы один зависший API не вешал прогон намертво (retry тут не поможет —
// зависший fetch не бросает ошибку, а просто ждёт).
//
// Контракт:
//   - При истечении timeoutMs бросает TimeoutError с code='ETIMEDOUT' и
//     retryable=true. Так imageGenerator (проверяет e.code === 'ETIMEDOUT')
//     и adapter (ставит retryable=true для любых netErr) подхватывают таймаут
//     как повторяемую ошибку и ретраят.
//   - publisher.js (Telegram) НЕ выставляет retryable на брошенных fetch
//     (только на HTTP 429/5xx) — поэтому таймаут Telegram НЕ ретраится
//     автоматически. Это намеренно: при таймауте мы не знаем, дошёл ли запрос,
//     и повтор sendPhoto рискует дублем. Лучше упасть и дать оператору
//     перепубликовать через --publish-pending.
//   - Сетевые ошибки (не таймаут) пробрасываются как есть — их повторяемость
//     решает вызывающая сторона.

// Маскирует секреты в URL перед записью в сообщение об ошибке/лог:
//   - query-параметр access_token=... (VK API);
//   - сегмент пути /bot<token>/ (Telegram Bot API — токен там обязателен).
function redactUrl(u) {
  if (typeof u !== 'string') return '(Request)';
  return u
    .replace(/([?&]access_token=)[^&]+/g, '$1***')
    .replace(/(\/bot)[^/]+(\/)/g, '$1***$2');
}

export class TimeoutError extends Error {
  constructor(url, ms) {
    super(`Таймаут ${ms}мс превышен: ${redactUrl(url)}`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.retryable = true;
    this.timeoutMs = ms;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * fetch с AbortController-таймаутом.
 *
 * @param {string|URL|Request} url
 * @param {object} [opts] — обычные fetch-опции (method, headers, body, …).
 * @param {object} [httpOpts]
 * @param {number} [httpOpts.timeoutMs=30000]
 * @param {AbortSignal} [opts.signal] — внешний сигнал; при abort(е) прервётся и наш таймаут.
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, opts = {}, httpOpts = {}) {
  const timeoutMs = httpOpts.timeoutMs && httpOpts.timeoutMs > 0
    ? httpOpts.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  // Пробрасываем внешний сигнал (если вызывающий передал свой AbortController).
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    // Превращаем abort по нашему таймауту в понятный TimeoutError.
    if (ctrl.signal.aborted && (e?.name === 'AbortError' || e?.name === 'TimeoutError')) {
      throw new TimeoutError(url, timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}