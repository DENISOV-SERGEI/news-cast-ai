// tests/filters.test.mjs
// Пре-адаптационная фильтрация: блоклист доменов и стоп-слова в заголовках.
// Цель — отбрасывать мусор ДО того, как статьи попадут в Ollama.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedSource, hasStopwordTitle, applyFilters } from '../src/filters.js';

// === isBlockedSource ===
test('isBlockedSource: прямой домен в списке', () => {
  assert.equal(isBlockedSource('https://medium.com/foo', ['medium.com']), true);
});

test('isBlockedSource: www. префикс не мешает сравнению', () => {
  assert.equal(isBlockedSource('https://www.medium.com/foo', ['medium.com']), true);
});

test('isBlockedSource: parent-домен тоже ловится', () => {
  assert.equal(isBlockedSource('https://blog.medium.com/foo', ['medium.com']), true);
});

test('isBlockedSource: чужой домен — false', () => {
  assert.equal(isBlockedSource('https://example.com/foo', ['medium.com']), false);
});

test('isBlockedSource: пустой blocklist — false', () => {
  assert.equal(isBlockedSource('https://example.com/foo', []), false);
});

test('isBlockedSource: невалидный URL не падает, возвращает false', () => {
  assert.equal(isBlockedSource('not-a-url', ['medium.com']), false);
});

test('isBlockedSource: case-insensitive host', () => {
  // URL парсер сам понизит регистр hostname, но на всякий случай проверим,
  // что Medium.com и в списке, и в URL — матчатся.
  assert.equal(isBlockedSource('https://Medium.com/foo', ['medium.com']), true);
});

// === hasStopwordTitle ===
test('hasStopwordTitle: подстрока найдена в lowercase title', () => {
  assert.equal(hasStopwordTitle('Weekly Roundup #42', ['weekly roundup']), true);
});

test('hasStopwordTitle: подстрока "newsletter"', () => {
  assert.equal(hasStopwordTitle('Newsletter: Special Edition', ['newsletter']), true);
});

test('hasStopwordTitle: подстрока не найдена', () => {
  assert.equal(hasStopwordTitle('OpenAI Releases GPT-5', ['weekly roundup']), false);
});

test('hasStopwordTitle: пустой title — false', () => {
  assert.equal(hasStopwordTitle('', ['newsletter']), false);
});

test('hasStopwordTitle: пустой stopwords — false', () => {
  assert.equal(hasStopwordTitle('hello', []), false);
});

test('hasStopwordTitle: регистр заголовка не важен', () => {
  assert.equal(hasStopwordTitle('WEEKLY ROUNDUP', ['weekly roundup']), true);
});

// === applyFilters (интеграционный) ===
test('applyFilters: 5 статей → 2 source-blocked, 1 stopword, 2 ok', () => {
  const articles = [
    { title: 'OpenAI news', url: 'https://example.com/a' },          // ok
    { title: 'Weekly Roundup', url: 'https://medium.com/x' },        // blocked by source
    { title: 'DeepMind paper', url: 'https://example.com/b' },       // ok
    { title: 'Newsletter #5', url: 'https://another.com/c' },        // blocked by stopword
    { title: 'Reddit thread', url: 'https://reddit.com/r/foo' },    // blocked by source
  ];
  const result = applyFilters(articles, {
    sourceBlocklist: ['medium.com', 'reddit.com'],
    titleStopwords: ['newsletter'],
  });
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.bySource, 2);
  assert.equal(result.dropped.byStopword, 1);
  assert.deepEqual(
    result.kept.map((a) => a.title).sort(),
    ['DeepMind paper', 'OpenAI news'].sort(),
  );
});

test('applyFilters: пустые списки — все статьи проходят', () => {
  const articles = [
    { title: 'Anything', url: 'https://medium.com/foo' },
    { title: 'Newsletter', url: 'https://example.com/bar' },
  ];
  const result = applyFilters(articles, { sourceBlocklist: [], titleStopwords: [] });
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.bySource, 0);
  assert.equal(result.dropped.byStopword, 0);
});

test('applyFilters: article dropped by source не проверяется на stopword', () => {
  // medium.com в blocklist, заголовок содержит "newsletter" — должен
  // попасть ТОЛЬКО в bySource, не в byStopword.
  const articles = [
    { title: 'Newsletter on Medium', url: 'https://medium.com/x' },
  ];
  const result = applyFilters(articles, {
    sourceBlocklist: ['medium.com'],
    titleStopwords: ['newsletter'],
  });
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.bySource, 1);
  assert.equal(result.dropped.byStopword, 0);
});
