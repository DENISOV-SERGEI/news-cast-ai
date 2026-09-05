// tests/dedup-urls.test.mjs
// Дополнительные кейсы для normalizeUrl, которые не покрыты в dedup.test.mjs.
// dedup.test.mjs оставлен как есть — здесь только РАСШИРЕНИЕ покрытия,
// чтобы не дублировать, а дополнять (см. бэклог A3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/dedup.js';

// === Базовые операции ===

test('normalizeUrl: смешанный регистр scheme/host нормализуется', () => {
  assert.equal(
    normalizeUrl('HTTPS://Example.COM/foo'),
    'https://example.com/foo',
  );
});

test('normalizeUrl: protocol http vs https — НЕ эквивалентны (разные scheme)', () => {
  // В текущей реализации scheme сохраняется; http и https дают разные ключи.
  // Это документируем как поведение: если потребуется унификация —
  // нужно явно менять normalizeUrl.
  assert.notEqual(
    normalizeUrl('http://example.com/foo'),
    normalizeUrl('https://example.com/foo'),
  );
});

// === Fragment / path ===

test('normalizeUrl: чистый fragment выкидывается', () => {
  assert.equal(
    normalizeUrl('https://example.com/foo#section'),
    'https://example.com/foo',
  );
});

test('normalizeUrl: путь с trailing slash эквивалентен без него', () => {
  assert.equal(
    normalizeUrl('http://example.com/foo/'),
    normalizeUrl('http://example.com/foo'),
  );
});

test('normalizeUrl: корневой path со trailing slash сохраняет /', () => {
  // ВАЖНО: для корня trailing slash сохраняется, чтобы https://a/
  // и https://a (без /) различались (важно для некоторых серверов).
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(
    normalizeUrl('https://example.com/?id=1'),
    'https://example.com/?id=1',
  );
});

test('normalizeUrl: множественные trailing slashes схлопываются в один', () => {
  assert.equal(
    normalizeUrl('https://example.com/foo///'),
    'https://example.com/foo',
  );
});

// === Query params ===

test('normalizeUrl: utm_* выкидываются полностью', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?utm_source=x&utm_medium=y&id=1'),
    'https://example.com/p?id=1',
  );
});

test('normalizeUrl: сортировка query params делает порядок无关имым', () => {
  const a = 'https://example.com/p?a=1&b=2&c=3';
  const b = 'https://example.com/p?c=3&a=1&b=2';
  assert.equal(normalizeUrl(a), normalizeUrl(b));
});

test('normalizeUrl: fbclid/gclid/mc_eid/mc_cid/_hsenc/_hsmi/igshid выкидываются', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?fbclid=x&gclid=y&mc_eid=z&mc_cid=w&id=1'),
    'https://example.com/p?id=1',
  );
  assert.equal(
    normalizeUrl('https://example.com/p?_hsenc=a&_hsmi=b&igshid=c&id=1'),
    'https://example.com/p?id=1',
  );
});

test('normalizeUrl: ref и source (точное совпадение) выкидываются', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?ref=twitter&source=fb&id=1'),
    'https://example.com/p?id=1',
  );
});

test('normalizeUrl: параметры без значений сохраняются как flag', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?flag&id=1'),
    'https://example.com/p?flag=&id=1',
  );
});

// === Edge cases ===

test('normalizeUrl: невалидный URL возвращается как есть (fallback)', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
  assert.equal(normalizeUrl('foo bar baz'), 'foo bar baz');
});

test('normalizeUrl: пустая строка → пустая строка', () => {
  assert.equal(normalizeUrl(''), '');
});

test('normalizeUrl: null → пустая строка', () => {
  assert.equal(normalizeUrl(null), '');
});

test('normalizeUrl: undefined → пустая строка', () => {
  assert.equal(normalizeUrl(undefined), '');
});

test('normalizeUrl: сложный URL с utm, fragment, www. и trailing slash', () => {
  assert.equal(
    normalizeUrl('HTTPS://WWW.Example.COM/Post/?id=1&utm_source=x#section'),
    'https://example.com/Post?id=1',
  );
});

test('normalizeUrl: порт НЕ сохраняется (u.hostname без порта)', () => {
  // ВНИМАНИЕ: текущая реализация использует u.hostname, который НЕ включает порт.
  // Это известное ограничение. Если потребуется сохранить порт — менять явно,
  // например на `${u.hostname}:${u.port}`.
  assert.equal(
    normalizeUrl('https://example.com:8080/foo'),
    'https://example.com/foo',
  );
});

test('normalizeUrl: URL с user:pass — credentials выкидываются URL-парсером', () => {
  // URL-парсер сам выкидывает user:pass. Документируем фактическое поведение.
  assert.equal(
    normalizeUrl('https://user:pass@example.com/foo'),
    'https://example.com/foo',
  );
});

test('normalizeUrl: URL без query → без ?', () => {
  assert.equal(
    normalizeUrl('https://example.com/post'),
    'https://example.com/post',
  );
});

test('normalizeUrl: все параметры — utm → пустой query', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?utm_source=x&utm_medium=y'),
    'https://example.com/p',
  );
});
