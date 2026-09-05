// tests/extractJSON.test.mjs
// Тестируем extractJSON (экспортирована из adapter.js специально для тестов).
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON } from '../src/adapter.js';

test('extractJSON: чистый JSON парсится', () => {
  const out = extractJSON('{"a":1,"b":"two"}');
  assert.deepEqual(out, { a: 1, b: 'two' });
});

test('extractJSON: рассуждения до JSON игнорируются', () => {
  const text = 'Let me analyze the article...\n\nThe summary is clear.\n\n{"summary":{"title":"X"},"image_prompt":"y"}';
  const out = extractJSON(text);
  assert.equal(out.summary.title, 'X');
  assert.equal(out.image_prompt, 'y');
});

test('extractJSON: финальный JSON (после рассуждений) приоритетнее раннего', () => {
  const text = 'I see {"partial": "garbage"} incomplete\n\nBut here is the real response:\n{"summary":{"title":"Final"},"image_prompt":"final"}';
  const out = extractJSON(text);
  assert.equal(out.summary.title, 'Final');
});

test('extractJSON: JSON внутри строки не ломает парсинг', () => {
  const text = '{"a":"value with \\"quote\\" and {brace}","b":2}';
  const out = extractJSON(text);
  assert.equal(out.a, 'value with "quote" and {brace}');
  assert.equal(out.b, 2);
});

test('extractJSON: текст без JSON → null', () => {
  assert.equal(extractJSON('no json here'), null);
  assert.equal(extractJSON(''), null);
});

test('extractJSON: вложенный JSON парсится целиком', () => {
  const text = '{"social":{"telegram":{"draft":"hi","title":"t"}}}';
  const out = extractJSON(text);
  assert.equal(out.social.telegram.title, 't');
  assert.equal(out.social.telegram.draft, 'hi');
});
