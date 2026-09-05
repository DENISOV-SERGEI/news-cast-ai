// tests/scheduleCsv.test.mjs
// Чистая функция parseScheduleCsv из src/utils.js. CSV-парсинг cron-выражений
// для SCHEDULE_CRON: split(',') + trim + filter(Boolean).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleCsv } from '../src/utils.js';

test('parseScheduleCsv: одно выражение без запятых', () => {
  assert.deepEqual(parseScheduleCsv('0 8 * * *'), ['0 8 * * *']);
});

test('parseScheduleCsv: два выражения через запятую', () => {
  assert.deepEqual(parseScheduleCsv('0 8 * * *,0 15 * * *'), ['0 8 * * *', '0 15 * * *']);
});

test('parseScheduleCsv: пустая строка → пустой массив', () => {
  assert.deepEqual(parseScheduleCsv(''), []);
});

test('parseScheduleCsv: trim пробелов вокруг выражений', () => {
  assert.deepEqual(
    parseScheduleCsv('  0 8 * * * , 0 15 * * *  '),
    ['0 8 * * *', '0 15 * * *'],
  );
});

test('parseScheduleCsv: пустые сегменты между запятыми отбрасываются', () => {
  assert.deepEqual(parseScheduleCsv('0 8 * * *,,0 15 * * *'), ['0 8 * * *', '0 15 * * *']);
});

test('parseScheduleCsv: null → пустой массив', () => {
  assert.deepEqual(parseScheduleCsv(null), []);
});

test('parseScheduleCsv: undefined → пустой массив', () => {
  assert.deepEqual(parseScheduleCsv(undefined), []);
});

test('parseScheduleCsv: только запятые → пустой массив', () => {
  assert.deepEqual(parseScheduleCsv(',,,'), []);
});

test('parseScheduleCsv: три выражения', () => {
  assert.deepEqual(
    parseScheduleCsv('0 8 * * *,0 12 * * *,0 15 * * *'),
    ['0 8 * * *', '0 12 * * *', '0 15 * * *'],
  );
});

test('parseScheduleCsv: не-строковый ввод (число) → строка через String()', () => {
  // Контракт утилиты: String(input || '') — числа приводятся к строке.
  // 0 falsy, поэтому даст [], 42 даст ['42'].
  assert.deepEqual(parseScheduleCsv(0), []);
  assert.deepEqual(parseScheduleCsv(42), ['42']);
});
