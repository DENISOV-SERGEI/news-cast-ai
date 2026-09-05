// tests/health.test.mjs
// Проверка «молчания» пайплайна (checkSilence + getLastRunMs): пустая история,
// свежий прогон, устаревший прогон, SILENCE_ALERT_HOURS=0, алерт при выключенном
// error-чате (alerted=false, но silent=true — exit code 1 всё равно нужен).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { appendRun, getLastRunMs } from '../src/runs.js';
import { checkSilence } from '../src/monitoring.js';

const tmpRoot = path.join(tmpdir(), `nca-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

async function useRunsDir(name) {
  const dir = path.join(tmpRoot, name);
  config.runsPath = path.join(dir, 'runs.json');
  // Тесты должны быть герметичными: без реальной отправки в error-чат
  // (в локальном .env TELEGRAM_ERROR_CHAT_ID может быть задан).
  config.telegramErrorChatId = '';
  config.features.errorChat = false;
  await mkdir(dir, { recursive: true });
}

const HOUR = 3600 * 1000;

test('getLastRunMs: пустая история → null', async () => {
  await useRunsDir('empty');
  assert.equal(await getLastRunMs(), null);
});

test('getLastRunMs: максимум по finished_at', async () => {
  await useRunsDir('max');
  await appendRun({ finished_at: '2026-09-05T10:00:00.000Z', mode: 'once' });
  await appendRun({ finished_at: '2026-09-05T12:30:00.000Z', mode: 'once' });
  assert.equal(await getLastRunMs(), Date.parse('2026-09-05T12:30:00.000Z'));
});

test('checkSilence: пустая история → silent (нет ни одного прогона)', async () => {
  await useRunsDir('silence-empty');
  config.silenceAlertHours = 6;
  const res = await checkSilence();
  assert.equal(res.silent, true);
  assert.match(res.reason, /История прогонов пуста/);
  // В тестах error-чат выключен → алерт не уходит, но silent=true
  // (CLI --health обязан выйти с кодом 1, чтобы внешний cron увидел проблему).
  assert.equal(res.alerted, false);
});

test('checkSilence: свежий прогон → not silent', async () => {
  await useRunsDir('fresh');
  config.silenceAlertHours = 6;
  await appendRun({ finished_at: new Date().toISOString(), mode: 'once', ok: 1 });
  const res = await checkSilence();
  assert.equal(res.silent, false);
  assert.equal(res.reason, null);
});

test('checkSilence: прогон старше SILENCE_ALERT_HOURS → silent', async () => {
  await useRunsDir('stale');
  config.silenceAlertHours = 6;
  await appendRun({ finished_at: new Date(Date.now() - 7 * HOUR).toISOString(), mode: 'schedule' });
  const res = await checkSilence();
  assert.equal(res.silent, true);
  assert.match(res.reason, /Последний прогон был 7 ч назад/);
});

test('checkSilence: SILENCE_ALERT_HOURS=0 → проверка отключена', async () => {
  await useRunsDir('disabled');
  config.silenceAlertHours = 0;
  const res = await checkSilence();
  assert.equal(res.silent, false);
  assert.equal(res.alerted, false);
  config.silenceAlertHours = 6;
});