// src/monitoring.js
// Уведомления об ошибках в отдельный Telegram-чат.
//
// Использование:
//   import { reportError, reportInfo } from './monitoring.js';
//   try { ... } catch (e) { reportError(e, { where: 'publishToVK' }); }
//
// Если TELEGRAM_ERROR_CHAT_ID не задан — функции работают как no-op,
// чтобы старый код не ломался.

import { config, log } from './config.js';
import { fetchWithTimeout } from './http.js';

const TELEGRAM_CAPTION_LIMIT = 4096; // sendMessage лимит

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s, limit) {
  if (!s) return '';
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…(truncated, +${s.length - limit} chars)`;
}

async function sendTelegram(text) {
  const url = `${config.telegramApiBase.replace(/\/$/, '')}/bot${config.telegramBotToken}/sendMessage`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramErrorChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }, { timeoutMs: 10_000 }); // алерт не должен блокировать основной поток
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram sendMessage: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
}

function buildMessage({ kind, err, context }) {
  const ts = new Date().toISOString();
  const ctxStr = context ? Object.entries(context)
    .map(([k, v]) => `${k}=<code>${escapeHtml(truncate(String(v), 200))}</code>`)
    .join('\n') : '';
  const errStr = err?.stack || err?.message || String(err);
  return [
    `🚨 <b>${kind}</b> @ <code>${ts}</code>`,
    ctxStr,
    '',
    `<pre>${escapeHtml(truncate(errStr, TELEGRAM_CAPTION_LIMIT - 600))}</pre>`,
  ].filter(Boolean).join('\n');
}

/**
 * Шлёт алерт об ошибке в TELEGRAM_ERROR_CHAT_ID.
 * Никогда не бросает — если Telegram недоступен, пишет в лог и возвращает false.
 */
export async function reportError(err, context) {
  const text = buildMessage({ kind: 'Error', err, context });
  if (!config.features.errorChat) {
    log('warn', `[monitoring] TELEGRAM_ERROR_CHAT_ID не задан, алерт подавлён: ${err?.message || err}`);
    return false;
  }
  try {
    await sendTelegram(text);
    return true;
  } catch (e) {
    log('error', `[monitoring] Не удалось отправить алерт: ${e.message}`);
    return false;
  }
}

export async function reportInfo(message, context) {
  const text = buildMessage({ kind: 'Info', err: { message }, context });
  if (!config.features.errorChat) return false;
  try {
    await sendTelegram(text);
    return true;
  } catch {
    return false;
  }
}

const DAILY_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Проверка «молчания» пайплайна: если последний прогон в runs.json старше
 * SILENCE_ALERT_HOURS (или истории нет вовсе) — алерт в TELEGRAM_ERROR_CHAT_ID.
 *
 * Вызывается из CLI-режима `--health`, который вешается на внешний cron
 * (планировщик ОС или CI): умерший long-running процесс сам о своей смерти
 * сообщить не может, поэтому проверка идёт снаружи.
 *
 * @returns {Promise<{silent: boolean, reason: string|null, lastRunMs: number|null, alerted: boolean}>}
 */
export async function checkSilence() {
  const hours = config.silenceAlertHours;
  if (hours === 0) {
    return { silent: false, reason: null, lastRunMs: null, alerted: false };
  }
  const { getLastRunMs } = await import('./runs.js');
  const lastRunMs = await getLastRunMs();
  const now = Date.now();
  let silent = false;
  let reason = null;
  if (lastRunMs === null) {
    silent = true;
    reason = 'История прогонов пуста (database/runs.json отсутствует или не содержит записей)';
  } else if (now - lastRunMs > hours * 3600 * 1000) {
    silent = true;
    const hoursSince = Math.floor((now - lastRunMs) / 3600_000);
    reason = `Последний прогон был ${hoursSince} ч назад (${new Date(lastRunMs).toISOString()})`;
  }
  if (!silent) {
    return { silent: false, reason: null, lastRunMs, alerted: false };
  }
  const alerted = await reportInfo(
    `⚠️ Пайплайн молчит: ${reason}. Проверьте, что запущен режим --schedule. (SILENCE_ALERT_HOURS=${hours})`,
  );
  return { silent, reason, lastRunMs, alerted };
}

/** Человекочитаемый текст сводки прогонов (HTML, для sendMessage). */
export function buildDailyReportText(summary, sinceIso) {
  const modeStr = Object.entries(summary.byMode)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ') || '—';
  const tok = summary.tokens;
  const tokStr = tok.runs_with_tokens > 0
    ? `prompt ${tok.prompt_tokens} / completion ${tok.completion_tokens} / total ${tok.total_tokens} (по ${tok.runs_with_tokens} прогонам)`
    : 'нет данных (генерации не было / usage не пришёл)';
  const dep = summary.deploy || { runs: 0, uploaded: 0, deleted: 0, errors: 0 };
  const depStr = dep.runs > 0
    ? `Деплой: ${dep.runs} прогонов, залито ${dep.uploaded} файлов, удалено ${dep.deleted}, ошибок ${dep.errors}`
    : 'Деплой: не было';
  return [
    '📊 <b>Сводка news-cast-ai</b>',
    `Период: с ${sinceIso}`,
    `Прогонов: <b>${summary.count}</b> (${modeStr})`,
    '',
    `Статей: найдено ${summary.found}, обработано ${summary.processed},`,
    `✅ успешно ${summary.ok}, ❌ упало ${summary.fail}, прервано ${summary.interrupted}`,
    '',
    `Отброшено по свежести: stale=${summary.stale || 0}, no_date=${summary.no_date || 0}`,
    `Отфильтровано: source=${summary.source_blocked || 0}, stopword=${summary.stopword_filtered || 0}`,
    `PickBySource: взято ${summary.processed || 0}/${(summary.processed || 0) + (summary.dropped_dup_pick || 0)} источников, отброшено дублей ${summary.dropped_dup_pick || 0}`,
    '',
    depStr,
    '',
    `Токены Ollama: ${tokStr}`,
  ].join('\n');
}

/**
 * Раз в сутки (DAILY_REPORT_INTERVAL_MS) шлёт в TELEGRAM_ERROR_CHAT_ID агрегат
 * прогонов за период с прошлого отчёта. Идемпотентна: время последней отправки
 * хранится в runs.json. Возвращает true, если отчёт отправлен.
 *
 * Триггерится из scheduler после каждого scheduled-прогона — поэтому отчёт
 * приходит «вместе» с регулярным расписанием, без отдельного крона.
 */
export async function maybeSendDailyReport() {
  if (!config.features.errorChat) return false;
  const { getLastDailyReportMs, getRunsSince, markDailyReportSent, summarizeRuns } = await import('./runs.js');
  const now = Date.now();
  const last = await getLastDailyReportMs();
  if (last !== null && now - last < DAILY_REPORT_INTERVAL_MS) {
    return false; // ещё не пора
  }
  const sinceMs = last !== null ? last : now - DAILY_REPORT_INTERVAL_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const runs = await getRunsSince(sinceMs);
  if (runs.length === 0) {
    // Прогонов не было — отчёт всё равно шлём (чтобы отметить период),
    // но можно и пропустить. Шлём пустой, чтобы оператор знал, что бот жив.
  }
  const summary = summarizeRuns(runs);
  const text = buildDailyReportText(summary, sinceIso);
  try {
    await sendTelegram(text);
    await markDailyReportSent(new Date(now).toISOString());
    log('info', `[monitoring] Ежедневный отчёт отправлен (${summary.count} прогонов)`);
    return true;
  } catch (e) {
    log('error', `[monitoring] Не удалось отправить ежедневный отчёт: ${e.message}`);
    return false;
  }
}
