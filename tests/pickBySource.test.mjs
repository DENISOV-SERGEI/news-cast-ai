// tests/pickBySource.test.mjs
// Покрывает pickBySource из src/scheduler.js: группировка по hostname,
// сортировка внутри группы, выбор первой не-дублирующей статьи, счётчики.
//
// pickBySource экспортируется из src/scheduler.js. Это «чистая» функция в том
// смысле, что ей не нужен ни pipeline (Ollama, Telegram, …), ни файловые
// эффекты — только dedupFn. Поэтому тестируем без моков всего scheduler'а.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBySource } from '../src/scheduler.js';

// dedupFn-фабрика: помечает дубликатом любую статью, у которой url содержит
// подстроку `marker`. Это даёт детерминированное и читаемое поведение:
//   - по умолчанию (marker='old') — все статьи уникальны;
//   - явно сконструированные URL с 'old' — считаются дубликатами.
function makeDedup(marker = 'old') {
  return async (a) => ({ duplicate: typeof a?.url === 'string' && a.url.includes(marker) });
}

// Хелпер: конструирует статью с минимально нужными полями.
function art(url, publishedAt /* Date | null */) {
  return { title: `t-${url}`, url, publishedAt };
}

test('pickBySource: 3 источника с разной свежестью → 1 статья с каждого', async () => {
  const articles = [
    art('https://example-a.com/post1', new Date('2026-08-22T10:00:00Z')),
    art('https://example-b.com/post1', new Date('2026-08-22T11:00:00Z')),
    art('https://example-c.com/post1', new Date('2026-08-22T12:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup());
  assert.equal(r.picked.length, 3);
  assert.equal(r.droppedDup, 0);
  assert.equal(r.droppedEmpty, 0);
  assert.equal(r.byGroups.size, 3);
});

test('pickBySource: один источник полностью дубликаты → 2 статьи из 3 источников', async () => {
  const articles = [
    art('https://example-a.com/old1', new Date('2026-08-22T10:00:00Z')),
    art('https://example-a.com/old2', new Date('2026-08-22T09:00:00Z')),
    art('https://example-b.com/post1', new Date('2026-08-22T11:00:00Z')),
    art('https://example-c.com/post1', new Date('2026-08-22T12:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup('old'));
  assert.equal(r.picked.length, 2, 'только b и c — все a дубликаты');
  assert.equal(r.droppedDup, 2, '2 дубля из источника a');
  assert.equal(r.droppedEmpty, 1, '1 источник полностью пустой');
  const hosts = r.picked.map((a) => new URL(a.url).hostname);
  assert.ok(hosts.includes('example-b.com'));
  assert.ok(hosts.includes('example-c.com'));
  assert.ok(!hosts.includes('example-a.com'));
});

test('pickBySource: все статьи — дубликаты → picked.length === 0, droppedDup = N', async () => {
  const articles = [
    art('https://example-a.com/old1', new Date('2026-08-22T10:00:00Z')),
    art('https://example-b.com/old1', new Date('2026-08-22T11:00:00Z')),
    art('https://example-c.com/old1', new Date('2026-08-22T12:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup('old'));
  assert.equal(r.picked.length, 0);
  assert.equal(r.droppedDup, 3);
  assert.equal(r.droppedEmpty, 3);
});

test('pickBySource: источник без publishedAt идёт последним в порядке обхода', async () => {
  // У источников a и b — реальные даты, у c — null. По headTs=0 c идёт после.
  const articles = [
    art('https://example-c.com/post1', null),
    art('https://example-b.com/post1', new Date('2026-08-22T11:00:00Z')),
    art('https://example-a.com/post1', new Date('2026-08-22T10:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup());
  // Порядок по убыванию headTs: b (11:00), a (10:00), c (null → 0).
  assert.equal(r.picked.length, 3);
  assert.equal(new URL(r.picked[0].url).hostname, 'example-b.com');
  assert.equal(new URL(r.picked[1].url).hostname, 'example-a.com');
  assert.equal(new URL(r.picked[2].url).hostname, 'example-c.com');
});

test('pickBySource: внутри источника сортировка по publishedAt desc', async () => {
  // Намеренно перемешанный вход — у одного источника 3 статьи.
  const articles = [
    art('https://example-a.com/middle', new Date('2026-08-22T10:00:00Z')),
    art('https://example-a.com/oldest', new Date('2026-08-22T08:00:00Z')),
    art('https://example-a.com/newest', new Date('2026-08-22T12:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup());
  assert.equal(r.picked.length, 1);
  // Должна быть выбрана самая свежая.
  assert.equal(r.picked[0].url, 'https://example-a.com/newest');
});

test('pickBySource: порядок обхода источников — по убыванию свежести самой свежей статьи', async () => {
  // Пути специально без 'old' (дефолтный маркер дубликатов в makeDedup).
  const articles = [
    art('https://slow.com/p1', new Date('2026-08-20T00:00:00Z')),
    art('https://fast.com/p1', new Date('2026-08-23T00:00:00Z')),
    art('https://mid.com/p1', new Date('2026-08-21T12:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup());
  assert.equal(new URL(r.picked[0].url).hostname, 'fast.com');
  assert.equal(new URL(r.picked[1].url).hostname, 'mid.com');
  assert.equal(new URL(r.picked[2].url).hostname, 'slow.com');
});

test('pickBySource: первая статья источника — дубль, вторая — нет', async () => {
  // Свежесть у обеих одинаковая, но первая в RSS — дубль.
  // pickBySource должен пропустить первую и взять вторую.
  const articles = [
    art('https://example-a.com/old1', new Date('2026-08-22T12:00:00Z')),
    art('https://example-a.com/fresh1', new Date('2026-08-22T12:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup('old'));
  assert.equal(r.picked.length, 1);
  assert.equal(r.picked[0].url, 'https://example-a.com/fresh1');
  assert.equal(r.droppedDup, 1);
  assert.equal(r.droppedEmpty, 0);
});

test('pickBySource: пустой массив → пустой результат', async () => {
  const r = await pickBySource([], makeDedup());
  assert.equal(r.picked.length, 0);
  assert.equal(r.byGroups.size, 0);
  assert.equal(r.droppedDup, 0);
  assert.equal(r.droppedEmpty, 0);
});

test('pickBySource: www. вариант хоста объединяется в один источник', async () => {
  // www.example.com и example.com должны попасть в одну группу.
  const articles = [
    art('https://www.example.com/a', new Date('2026-08-22T10:00:00Z')),
    art('https://example.com/b', new Date('2026-08-22T09:00:00Z')),
  ];
  const r = await pickBySource(articles, makeDedup());
  assert.equal(r.byGroups.size, 1, 'www. и без — один источник');
  assert.equal(r.picked.length, 1);
  // Самая свежая — www.
  assert.equal(r.picked[0].url, 'https://www.example.com/a');
});
