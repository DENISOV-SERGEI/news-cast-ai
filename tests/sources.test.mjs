// tests/sources.test.mjs
// Проверяем: логика парсинга CSV, fetchAndParseAll кидает ошибку на пустой массив.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndParseAll } from '../src/parser.js';

// CSV-парсинг живёт в config.js через .split(',').map(trim).filter(Boolean).
// Воспроизводим ту же логику здесь, чтобы не зависеть от .env в проекте.
function parseSourcesCsv(csv) {
  return (csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

test('parseSourcesCsv: парсит CSV и убирает пустые/пробельные элементы', () => {
  const csv = 'https://a.example/feed, https://b.example/feed ,,https://c.example/feed';
  assert.deepEqual(parseSourcesCsv(csv), [
    'https://a.example/feed',
    'https://b.example/feed',
    'https://c.example/feed',
  ]);
});

test('parseSourcesCsv: пустая строка → []', () => {
  assert.deepEqual(parseSourcesCsv(''), []);
  assert.deepEqual(parseSourcesCsv(undefined), []);
  assert.deepEqual(parseSourcesCsv('   ,  ,  '), []);
});

test('parseSourcesCsv: один URL без запятых', () => {
  assert.deepEqual(parseSourcesCsv('https://x.example/feed'), ['https://x.example/feed']);
});

test('fetchAndParseAll: пустой массив → ошибка', async () => {
  await assert.rejects(
    () => fetchAndParseAll([]),
    /пустой массив источников/,
  );
  await assert.rejects(
    () => fetchAndParseAll(null),
    /пустой массив источников/,
  );
  await assert.rejects(
    () => fetchAndParseAll('not-an-array'),
    /пустой массив источников/,
  );
});

