// tests/runs.test.mjs
// История прогонов: append/get/aggregate, баунд по MAX_RUNS,
// mark/get last daily report, summarizeRuns корректно суммирует токены и режимы.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  appendRun, getRuns, getRunsSince, getLastDailyReportMs, markDailyReportSent,
  summarizeRuns, RUNS_MAX,
} from '../src/runs.js';

const tmpRoot = path.join(tmpdir(), `nca-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function makeRun(over = {}) {
  return {
    started_at: '2026-08-23T10:00:00.000Z',
    finished_at: '2026-08-23T10:01:00.000Z',
    duration_ms: 60_000,
    mode: 'once',
    sources: 1, found: 5, dedup_skipped: 1, processed: 3, ok: 2, fail: 1,
    interrupted: false, pending_id: null,
    tokens: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    ...over,
  };
}

test('appendRun + getRuns: round-trip', async () => {
  const dir = path.join(tmpRoot, 'a');
  config.runsPath = path.join(dir, 'runs.json');
  await mkdir(dir, { recursive: true });

  await appendRun(makeRun({ ok: 3, fail: 0 }));
  await appendRun(makeRun({ mode: 'dry-run', ok: 0, fail: 0 }));
  const runs = await getRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].mode, 'once');
  assert.equal(runs[1].mode, 'dry-run');
});

test('appendRun: баундит историю последними RUNS_MAX', async () => {
  const dir = path.join(tmpRoot, 'b');
  config.runsPath = path.join(dir, 'runs.json');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < RUNS_MAX + 5; i++) {
    await appendRun(makeRun({ ok: i }));
  }
  const runs = await getRuns();
  assert.equal(runs.length, RUNS_MAX, `должно быть ${RUNS_MAX}, а не ${runs.length}`);
  // Последние записи — самые свежие (ok = RUNS_MAX+4 .. RUNS_MAX)
  assert.equal(runs[runs.length - 1].ok, RUNS_MAX + 4);
  assert.equal(runs[0].ok, 5); // первые 5 (ok=0..4) отброшены, осталось с ok=5
});

test('summarizeRuns: суммирует counts, токены, разбивает по mode', () => {
  const runs = [
    makeRun({ mode: 'once', ok: 2, fail: 1, tokens: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } }),
    makeRun({ mode: 'dry-run', ok: 0, fail: 0, tokens: null }),
    makeRun({ mode: 'review', ok: 3, fail: 0, tokens: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 } }),
    makeRun({ mode: 'once', ok: 0, fail: 1, interrupted: true, tokens: { prompt_tokens: 10, completion_tokens: 20 } }),
  ];
  const s = summarizeRuns(runs);
  assert.equal(s.count, 4);
  assert.equal(s.byMode.once, 2);
  assert.equal(s.byMode['dry-run'], 1);
  assert.equal(s.byMode.review, 1);
  assert.equal(s.ok, 5);
  assert.equal(s.fail, 2);
  assert.equal(s.interrupted, 1);
  assert.equal(s.tokens.prompt_tokens, 160); // 100+50+10
  assert.equal(s.tokens.completion_tokens, 270); // 200+50+20
  assert.equal(s.tokens.total_tokens, 400); // 300+100+(10+20 fallback)
  assert.equal(s.tokens.runs_with_tokens, 3);
});

test('summarizeRuns: пустой массив — нули', () => {
  const s = summarizeRuns([]);
  assert.equal(s.count, 0);
  assert.equal(s.ok, 0);
  assert.equal(s.tokens.total_tokens, 0);
});

test('getRunsSince: фильтрует по finished_at', async () => {
  const dir = path.join(tmpRoot, 'c');
  config.runsPath = path.join(dir, 'runs.json');
  await mkdir(dir, { recursive: true });
  const t0 = '2026-08-23T10:00:00.000Z';
  const t1 = '2026-08-23T20:00:00.000Z';
  await appendRun(makeRun({ finished_at: t0 }));
  await appendRun(makeRun({ finished_at: t1 }));

  const since = Date.parse('2026-08-23T15:00:00.000Z');
  const runs = await getRunsSince(since);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].finished_at, t1);
});

test('last daily report: mark/get', async () => {
  const dir = path.join(tmpRoot, 'd');
  config.runsPath = path.join(dir, 'runs.json');
  await mkdir(dir, { recursive: true });
  assert.equal(await getLastDailyReportMs(), null);
  await markDailyReportSent('2026-08-23T10:00:00.000Z');
  const ms = await getLastDailyReportMs();
  assert.equal(ms, Date.parse('2026-08-23T10:00:00.000Z'));
});

test('cleanup', async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});