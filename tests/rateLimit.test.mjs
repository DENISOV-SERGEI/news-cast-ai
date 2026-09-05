// tests/rateLimit.test.mjs
// Гейт минимального интервала: первый вызов мгновенный, второй — ждёт интервал;
// minIntervalMs=0 — без гейта; разные имена — независимы; _reset сбрасывает.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, _resetRateLimit } from '../src/rateLimit.js';

test('rateLimit: первый вызов мгновенный', async () => {
  _resetRateLimit('tg-1');
  const start = Date.now();
  await rateLimit('tg-1', 1000);
  assert.ok(Date.now() - start < 50, 'первый вызок не должен ждать');
});

test('rateLimit: второй вызов ждёт min интервал', async () => {
  _resetRateLimit('tg-2');
  const interval = 40;
  await rateLimit('tg-2', interval);
  const t0 = Date.now();
  await rateLimit('tg-2', interval);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= interval - 5, `должен ждать ~${interval}мс, ждал ${elapsed}мс`);
  assert.ok(elapsed < interval + 80, `не должен ждать сильно дольше, ждал ${elapsed}мс`);
});

test('rateLimit: minIntervalMs=0 — без гейта', async () => {
  _resetRateLimit('tg-3');
  await rateLimit('tg-3', 1000);
  const t0 = Date.now();
  await rateLimit('tg-3', 0);
  assert.ok(Date.now() - t0 < 50, 'нулевой интервал — мгновенно');
});

test('rateLimit: разные имена независимы', async () => {
  _resetRateLimit('a'); _resetRateLimit('b');
  const interval = 30;
  await rateLimit('a', interval);
  await rateLimit('b', interval);
  // b только что вызывался — следующий b должен ждать interval, а a (тоже недавно)
  // не должен влиять на только-что-сброшенный b.
  _resetRateLimit('b');
  const t1 = Date.now();
  await rateLimit('b', interval);
  assert.ok(Date.now() - t1 < 50, 'b не должен зависеть от a');
  // А несброшенный a должен ждать interval (зависит только от себя).
  const t2 = Date.now();
  await rateLimit('a', interval);
  assert.ok(Date.now() - t2 >= interval - 5, 'a должен ждать свой интервал');
});

test('_resetRateLimit: сбрасывает гейт', async () => {
  _resetRateLimit('r');
  await rateLimit('r', 1000);
  _resetRateLimit('r');
  const t0 = Date.now();
  await rateLimit('r', 1000);
  assert.ok(Date.now() - t0 < 50, 'после сброса первый вызов мгновенный');
});

test('rateLimit: серилизует параллельные вызовы (без пробела меньше интервала)', async () => {
  _resetRateLimit('par');
  const interval = 30;
  const t0 = Date.now();
  await Promise.all([
    rateLimit('par', interval),
    rateLimit('par', interval),
    rateLimit('par', interval),
  ]);
  const elapsed = Date.now() - t0;
  // Три вызова с интервалом 30мс — минимум ~60мс (1-й сразу, 2-й +30, 3-й +60).
  assert.ok(elapsed >= 60 - 10, `три вызова должны занять ~2 интервалов (${interval}×2), ждали ${elapsed}мс`);
});