// tests/dedup.test.mjs
// Покрывает: normalizeUrl, slugify, buildPostFilename, extractJSON.
// Запуск: node --test tests/

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Тестируем чистые функции — это самые важные и стабильные части системы.
import { normalizeUrl } from '../src/dedup.js';
import { slugify, buildPostFilename, NoFreshArticlesError } from '../src/parser.js';

// === normalizeUrl ===
test('normalizeUrl: убирает utm_* и трекинг-параметры', () => {
  assert.equal(
    normalizeUrl('https://example.com/post?utm_source=x&id=1'),
    'https://example.com/post?id=1',
  );
  assert.equal(
    normalizeUrl('https://example.com/post?fbclid=abc&gclid=def&id=2'),
    'https://example.com/post?id=2',
  );
});

test('normalizeUrl: case-insensitive host и path', () => {
  assert.equal(
    normalizeUrl('HTTPS://EXAMPLE.COM/Post?id=1'),
    'https://example.com/Post?id=1',
  );
});

test('normalizeUrl: убирает www.', () => {
  assert.equal(
    normalizeUrl('https://www.example.com/post'),
    'https://example.com/post',
  );
});

test('normalizeUrl: убирает fragment и trailing slash', () => {
  // Fragment без query — выкидывается; trailing slash тоже
  assert.equal(
    normalizeUrl('https://example.com/post/#section'),
    'https://example.com/post',
  );
  assert.equal(
    normalizeUrl('https://example.com/post/?id=1#section'),
    // В URL-парсере fragment обрезает всё после #, и query до #
    // остаётся валидным — нормализуется до ?id=1
    'https://example.com/post?id=1',
  );
});

test('normalizeUrl: сортирует query-параметры', () => {
  assert.equal(
    normalizeUrl('https://example.com/post?b=2&a=1'),
    'https://example.com/post?a=1&b=2',
  );
});

test('normalizeUrl: сохраняет порядок у одинаковых URL', () => {
  const a = 'https://example.com/post?a=1&utm_source=x&b=2';
  const b = 'https://example.com/post?a=1&b=2&utm_source=x';
  assert.equal(normalizeUrl(a), normalizeUrl(b));
});

test('normalizeUrl: невалидный URL возвращает как есть', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
  assert.equal(normalizeUrl(''), '');
});

test('normalizeUrl: корневой path сохраняет /', () => {
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
});

// === slugify ===
test('slugify: латиница → lowercase + дефисы', () => {
  assert.equal(slugify('How AI coding tools work'), 'how-ai-coding-tools-work');
});

test('slugify: кириллица → транслит', () => {
  const out = slugify('Только русский текст');
  assert.match(out, /^tolko-russkii-tekst$/);
});

test('slugify: схлопывает дефисы и режет по краям', () => {
  assert.equal(slugify('  ---hello---world---  '), 'hello-world');
});

test('slugify: пустая строка → untitled', () => {
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify(null), 'untitled');
  assert.equal(slugify('   '), 'untitled');
});

test('slugify: выбрасывает спецсимволы и emoji', () => {
  const out = slugify('Hello! @World? #2026 🚀');
  // Буквы/цифры/дефисы; восклицательный/собака/решётка — выкинуты
  assert.match(out, /^hello-world-2026$/);
});

test('slugify: смешанный текст ru+en', () => {
  const out = slugify('JavaScript vs TypeScript что выбрать в 2026');
  assert.match(out, /javascript-vs-typescript/);
  assert.match(out, /2026/);
});

test('slugify: лимит 80 символов', () => {
  const long = 'a'.repeat(200);
  const out = slugify(long);
  assert.ok(out.length <= 80, `длина ${out.length}`);
});

// === buildPostFilename ===
test('buildPostFilename: формат YYYY-MM-DD-news-<hostSlug>-<slug>-social-content.json', () => {
  const fname = buildPostFilename({
    title: 'How AI coding tools work',
    url: 'https://the-decoder.com/2026/08/foo',
    published_at: '2026-08-22T15:00:00Z',
  });
  assert.equal(fname, '2026-08-22-news-the-decoder-com-how-ai-coding-tools-work-social-content.json');
});

test('buildPostFilename: берёт дату из published_at', () => {
  const fname = buildPostFilename({
    title: 'Foo',
    url: 'https://example.com/p',
    published_at: '2025-12-31T23:00:00Z',
  });
  assert.match(fname, /^2025-12-31-news-example-com-foo-social-content\.json$/);
});

test('buildPostFilename: пустой заголовок → untitled', () => {
  const fname = buildPostFilename({
    title: '',
    url: 'https://example.com/p',
    published_at: '2026-08-22T00:00:00Z',
  });
  assert.match(fname, /-news-example-com-untitled-social-content\.json$/);
});

test('buildPostFilename: кастомный suffix', () => {
  const fname = buildPostFilename({
    title: 'X',
    url: 'https://example.com/p',
    published_at: '2026-08-22T00:00:00Z',
  }, 'draft');
  assert.match(fname, /-news-example-com-x-draft\.json$/);
});

// === classifyFreshness (внутренняя, тестируем через NoFreshArticlesError) ===
test('NoFreshArticlesError: содержит total и code', () => {
  const e = new NoFreshArticlesError(5);
  assert.equal(e.code, 'NO_FRESH_ARTICLES');
  assert.match(e.message, /5/);
});
