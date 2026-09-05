// tests/freshness.test.mjs
// Покрытие фиксов B6 (no_date → drop + warn) и B5 (честные счётчики fresh/stale/noDate).
//
// Тесты:
//   - чистый classifyFreshness (без HTTP/моков)
//   - _applyFreshnessFilter через parseWithStats с подменой внутреннего _loadArticles
//   - интеграционный: parseWithStats с моком rss-парсера/HTML через http.createServer

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Parser from 'rss-parser';
import { classifyFreshness, NoFreshArticlesError } from '../src/parser.js';
import { config } from '../src/config.js';

// ============ Чистый classifyFreshness ============

test('classifyFreshness(null) → "no_date"', () => {
  assert.equal(classifyFreshness(null, 7), 'no_date');
});

test('classifyFreshness(undefined) → "no_date"', () => {
  assert.equal(classifyFreshness(undefined, 7), 'no_date');
});

test('classifyFreshness: статья 10 дней назад при окне 7 → "stale"', () => {
  const old = new Date(Date.now() - 10 * 86_400_000);
  assert.equal(classifyFreshness(old, 7), 'stale');
});

test('classifyFreshness: сегодня → "fresh"', () => {
  assert.equal(classifyFreshness(new Date(), 7), 'fresh');
});

test('classifyFreshness: будущая дата (через 1с) → "fresh"', () => {
  const future = new Date(Date.now() + 1_000);
  assert.equal(classifyFreshness(future, 7), 'fresh');
});

test('classifyFreshness: окно=0 (фильтр выключен) → "fresh" даже для старой даты', () => {
  const old = new Date(Date.now() - 3 * 86_400_000);
  assert.equal(classifyFreshness(old, 0), 'fresh');
});

test('classifyFreshness: окно=0 + null → "no_date" (null всё равно null, фильтр не при чём)', () => {
  // Поведение согласовано: null → no_date, фильтр отключения не превращает его в fresh.
  assert.equal(classifyFreshness(null, 0), 'no_date');
});

// ============ parseWithStats через HTTP-мок RSS ============

async function startServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function portOf(srv) { return srv.address().port; }

function rssFixture(items) {
  // items: [{ title, link, pubDate }]
  const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const itemsXml = items.map((it) => `
    <item>
      <title>${escape(it.title)}</title>
      <link>${escape(it.link)}</link>
      <guid>${escape(it.link)}</guid>
      <pubDate>${escape(it.pubDate || '')}</pubDate>
    </item>
  `).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mock feed</title>
    <link>http://127.0.0.1/</link>
    <description>mock</description>
    ${itemsXml}
  </channel>
</rss>`;
}

test('parseWithStats: с real RSS-моком, где у части статей pubDate отсутствует — они не попадают в articles', async () => {
  // Мок-сервер: отдаёт RSS, где у 2-х статей есть pubDate, у 1-й — нет.
  const items = [
    { title: 'A',  link: 'http://127.0.0.1/a', pubDate: new Date(Date.now() - 2 * 86_400_000).toUTCString() },
    { title: 'B',  link: 'http://127.0.0.1/b', pubDate: '' }, // без даты → должна быть отброшена
    { title: 'C',  link: 'http://127.0.0.1/c', pubDate: new Date().toUTCString() },
  ];
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(rssFixture(items));
  });
  const originalFetchWindow = config.freshWindowDays;
  try {
    config.freshWindowDays = 7;
    // Импортируем уже после подмены config (динамический import не нужен — модуль уже загружен,
    // но нам важно только значение config.freshWindowDays, которое читается внутри).
    const { parseWithStats } = await import('../src/parser.js');
    const r = await parseWithStats(`http://127.0.0.1:${portOf(srv)}/feed.xml`);
    // B6: статьи без даты не попадают в articles
    assert.equal(r.articles.length, 2, `ожидалось 2 свежих, получено ${r.articles.length}`);
    const urls = r.articles.map((a) => a.url).sort();
    assert.deepEqual(urls, ['http://127.0.0.1/a', 'http://127.0.0.1/c']);
    // B5: честные счётчики
    assert.equal(r.stats.fresh, 2);
    assert.equal(r.stats.stale, 0);
    assert.equal(r.stats.noDate, 1, 'B6: 1 статья без даты должна быть посчитана в noDate');
    assert.equal(r.total, 3);
  } finally {
    config.freshWindowDays = originalFetchWindow;
    srv.close();
  }
});

test('parseWithStats: stale-статья отбрасывается и попадает в stats.stale', async () => {
  const items = [
    { title: 'Old', link: 'http://127.0.0.1/old', pubDate: new Date(Date.now() - 30 * 86_400_000).toUTCString() },
    { title: 'New', link: 'http://127.0.0.1/new', pubDate: new Date().toUTCString() },
  ];
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(rssFixture(items));
  });
  const originalFetchWindow = config.freshWindowDays;
  try {
    config.freshWindowDays = 7;
    const { parseWithStats } = await import('../src/parser.js');
    const r = await parseWithStats(`http://127.0.0.1:${portOf(srv)}/feed.xml`);
    assert.equal(r.articles.length, 1);
    assert.equal(r.articles[0].url, 'http://127.0.0.1/new');
    assert.equal(r.stats.fresh, 1);
    assert.equal(r.stats.stale, 1);
    assert.equal(r.stats.noDate, 0);
  } finally {
    config.freshWindowDays = originalFetchWindow;
    srv.close();
  }
});

test('parseWithStats: freshWindowDays=0 → окно выключено, но no_date всё равно отбрасывается (B6)', async () => {
  const items = [
    { title: 'No date', link: 'http://127.0.0.1/x', pubDate: '' },
    { title: 'Old but ok', link: 'http://127.0.0.1/y', pubDate: new Date(Date.now() - 100 * 86_400_000).toUTCString() },
  ];
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(rssFixture(items));
  });
  const originalFetchWindow = config.freshWindowDays;
  try {
    config.freshWindowDays = 0;
    const { parseWithStats } = await import('../src/parser.js');
    const r = await parseWithStats(`http://127.0.0.1:${portOf(srv)}/feed.xml`);
    // Окно 0 → фильтр по возрасту выключен, но null-date по-прежнему отбрасывается (B6).
    assert.equal(r.articles.length, 1);
    assert.equal(r.articles[0].url, 'http://127.0.0.1/y');
    assert.equal(r.stats.fresh, 1);
    assert.equal(r.stats.stale, 0, 'при окне=0 не должно быть stale');
    assert.equal(r.stats.noDate, 1, 'B6: no_date отбрасывается даже при выключенном окне');
  } finally {
    config.freshWindowDays = originalFetchWindow;
    srv.close();
  }
});

test('parseWithStats: все статьи stale или no_date → NoFreshArticlesError', async () => {
  const items = [
    { title: 'Old',  link: 'http://127.0.0.1/old', pubDate: new Date(Date.now() - 60 * 86_400_000).toUTCString() },
    { title: 'None', link: 'http://127.0.0.1/none', pubDate: '' },
  ];
  const srv = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(rssFixture(items));
  });
  const originalFetchWindow = config.freshWindowDays;
  try {
    config.freshWindowDays = 7;
    const { parseWithStats } = await import('../src/parser.js');
    await assert.rejects(
      () => parseWithStats(`http://127.0.0.1:${portOf(srv)}/feed.xml`),
      (err) => {
        assert.ok(err instanceof NoFreshArticlesError, `должен быть NoFreshArticlesError, а не ${err?.constructor?.name}`);
        return true;
      },
    );
  } finally {
    config.freshWindowDays = originalFetchWindow;
    srv.close();
  }
});

// Sanity: rss-parser доступен (используется парсером под капотом)
test('rss-parser доступен (sanity)', () => {
  assert.ok(Parser, 'rss-parser импортируется');
});
