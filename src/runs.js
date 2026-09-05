// src/runs.js
// История прогонов пайплайна — основа наблюдаемости (O1).
//
// Хранилище: database/runs.json
//   {
//     "version": 1,
//     "last_daily_report_at": "ISO" | null,
//     "runs": [ { ... }, ... ]   // bounded: храним последние MAX_RUNS
//   }
//
// Запись run: {
//   started_at, finished_at, duration_ms, mode,
//   sources, found, fresh_count, no_date_count, stale_count,
//   source_blocked, stopword_filtered,
//   dedup_skipped, dropped_dup_pick, processed, ok, fail,
//   interrupted, pending_id, tokens: { prompt, completion, total }
// }
//
// Запись идёт в конце runOnceNow и publishPending. На её основе monitoring.js
// раз в сутки шлёт агрегатный отчёт в TELEGRAM_ERROR_CHAT_ID.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';

const SCHEMA_VERSION = 1;
const MAX_RUNS = 500;

function emptyIndex() {
  return { version: SCHEMA_VERSION, last_daily_report_at: null, runs: [] };
}

async function readIndex() {
  const file = config.runsPath;
  if (!existsSync(file)) return emptyIndex();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return emptyIndex();
    if (!Array.isArray(parsed.runs)) parsed.runs = [];
    parsed.version = parsed.version || SCHEMA_VERSION;
    parsed.last_daily_report_at = parsed.last_daily_report_at || null;
    return parsed;
  } catch (e) {
    log('warn', `[runs] Не удалось прочитать ${file}: ${e.message}. Создаю новую историю.`);
    return emptyIndex();
  }
}

async function writeIndexAtomic(index) {
  const file = config.runsPath;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await rename(tmp, file);
}

/**
 * Добавляет запись о прогоне. Баундит историю последними MAX_RUNS.
 * Чистит токены от undefined, чтобы JSON не пухнул null'ами.
 */
export async function appendRun(entry) {
  const index = await readIndex();
  const clean = {
    started_at: entry.started_at || new Date().toISOString(),
    finished_at: entry.finished_at || new Date().toISOString(),
    duration_ms: Number(entry.duration_ms) || 0,
    mode: entry.mode || 'once',
    sources: Number(entry.sources) || 0,
    found: Number(entry.found) || 0,
    fresh_count: Number(entry.fresh_count) || 0,
    no_date_count: Number(entry.no_date_count) || 0,
    stale_count: Number(entry.stale_count) || 0,
    source_blocked: Number(entry.source_blocked) || 0,
    stopword_filtered: Number(entry.stopword_filtered) || 0,
    dedup_skipped: Number(entry.dedup_skipped) || 0,
    dropped_dup_pick: Number(entry.dropped_dup_pick) || 0,
    processed: Number(entry.processed) || 0,
    ok: Number(entry.ok) || 0,
    fail: Number(entry.fail) || 0,
    interrupted: Boolean(entry.interrupted),
    pending_id: entry.pending_id || null,
    tokens: entry.tokens || null,
    // Автодеплой: { uploaded, deleted, error? } | null (не было деплоя в прогоне).
    deploy: entry.deploy || null,
  };
  index.runs.push(clean);
  if (index.runs.length > MAX_RUNS) {
    index.runs = index.runs.slice(-MAX_RUNS);
  }
  await writeIndexAtomic(index);
  return clean;
}

/** Все записи (копия массива). */
export async function getRuns() {
  const index = await readIndex();
  return index.runs;
}

/** Записи с finished_at >= sinceMs. */
export async function getRunsSince(sinceMs) {
  const runs = await getRuns();
  return runs.filter((r) => Date.parse(r.finished_at || r.started_at) >= sinceMs);
}

/** Время последнего отправленного ежедневного отчёта (ms) или null. */
export async function getLastDailyReportMs() {
  const index = await readIndex();
  return index.last_daily_report_at ? Date.parse(index.last_daily_report_at) : null;
}

/** Отмечает, что ежедневный отчёт отправлен в момент at (ISO). */
export async function markDailyReportSent(atIso) {
  const index = await readIndex();
  index.last_daily_report_at = atIso || new Date().toISOString();
  await writeIndexAtomic(index);
}

/**
 * Агрегирует записи с finished_at >= sinceMs в сводку для отчёта.
 */
export function summarizeRuns(runs) {
  const byMode = {};
  let found = 0, processed = 0, ok = 0, fail = 0, interrupted = 0;
  let fresh = 0, noDate = 0, stale = 0, sourceBlocked = 0, stopwordFiltered = 0;
  let droppedDupPick = 0;
  let prompt = 0, completion = 0, total = 0, hasTokens = 0;
  let deployRuns = 0, deployUploaded = 0, deployDeleted = 0, deployErrors = 0;
  let firstAt = null, lastAt = null;

  for (const r of runs) {
    byMode[r.mode] = (byMode[r.mode] || 0) + 1;
    found += r.found || 0;
    processed += r.processed || 0;
    ok += r.ok || 0;
    fail += r.fail || 0;
    fresh += r.fresh_count || 0;
    noDate += r.no_date_count || 0;
    stale += r.stale_count || 0;
    sourceBlocked += r.source_blocked || 0;
    stopwordFiltered += r.stopword_filtered || 0;
    droppedDupPick += r.dropped_dup_pick || 0;
    if (r.interrupted) interrupted++;
    if (r.tokens) {
      prompt += r.tokens.prompt_tokens || 0;
      completion += r.tokens.completion_tokens || 0;
      total += r.tokens.total_tokens || 0;
      hasTokens++;
    }
    if (r.deploy) {
      deployRuns++;
      deployUploaded += r.deploy.uploaded || 0;
      deployDeleted += r.deploy.deleted || 0;
      if (r.deploy.error) deployErrors++;
    }
    const t = Date.parse(r.finished_at || r.started_at);
    if (t) {
      if (firstAt === null || t < firstAt) firstAt = t;
      if (lastAt === null || t > lastAt) lastAt = t;
    }
  }
  return {
    count: runs.length,
    byMode,
    found, processed, ok, fail, interrupted,
    fresh, no_date: noDate, stale,
    source_blocked: sourceBlocked,
    stopword_filtered: stopwordFiltered,
    dropped_dup_pick: droppedDupPick,
    tokens: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, runs_with_tokens: hasTokens },
    deploy: { runs: deployRuns, uploaded: deployUploaded, deleted: deployDeleted, errors: deployErrors },
    firstAt, lastAt,
  };
}

export const RUNS_MAX = MAX_RUNS;