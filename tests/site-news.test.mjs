// tests/site-news.test.mjs
// Экспорт агрегата «Новости» для сайта business_card: сбор из posts/*.json,
// сортировка по свежести, maxItems, формат полей, фильтрация, атомарная запись,
// режим off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { exportSiteNews, collectSiteNewsItems, buildRssXml } from '../src/siteNews.js';

// Уникальный временный каталог (параллельный запуск node --test).
const tmpRoot = path.join(tmpdir(), `nca-sitenews-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const postsDir = path.join(tmpRoot, 'posts');
const outDir = path.join(tmpRoot, 'business_card');
const outFile = path.join(outDir, 'news.json');

function postJson(over) {
  return {
    schema_version: 'content-adaptor/v2',
    source: { title: 'Original title', url: 'https://example.com/a', published_at: '2026-08-20T10:00:00.000Z' },
    summary: { title: 'Русский заголовок' },
    social: {},
    ...over,
  };
}

async function seedPosts() {
  await mkdir(postsDir, { recursive: true });
  // a: старая, с summary.title
  await writeFile(path.join(postsDir, 'a.json'), JSON.stringify(postJson({
    source: { title: 'Old story', url: 'https://techcrunch.com/old', published_at: '2026-08-20T10:00:00.000Z' },
    summary: { title: 'Старая новость' },
  })), 'utf-8');
  // b: самая свежая
  await writeFile(path.join(postsDir, 'b.json'), JSON.stringify(postJson({
    source: { title: 'Fresh story', url: 'https://www.deepmind.google/blog/fresh', published_at: '2026-08-23T15:00:00.000Z' },
    summary: { title: 'Свежая новость' },
  })), 'utf-8');
  // c: средняя, БЕЗ summary.title → берётся source.title
  await writeFile(path.join(postsDir, 'c.json'), JSON.stringify(postJson({
    source: { title: 'Mid original title', url: 'https://marktechpost.com/mid', published_at: '2026-08-21T12:00:00.000Z' },
    summary: {},
  })), 'utf-8');
  // d: без url → фильтруется
  await writeFile(path.join(postsDir, 'd.json'), JSON.stringify(postJson({
    source: { title: 'No url story', url: '', published_at: '2026-08-22T12:00:00.000Z' },
  })), 'utf-8');
  // e: без published_at → fallback на mtime (самый свежий по записи)
  await writeFile(path.join(postsDir, 'e.json'), JSON.stringify(postJson({
    source: { title: 'Mtime story', url: 'https://example.com/mtime' },
    summary: { title: 'Новость без даты статьи' },
  })), 'utf-8');
  // мусор не-json — не должен валить экспорт
  await writeFile(path.join(postsDir, 'broken.json'), '{ not json', 'utf-8');
}

async function setup() {
  await rm(tmpRoot, { recursive: true, force: true });
  await seedPosts();
  await mkdir(outDir, { recursive: true });
  config.postsDir = postsDir;
  config.businessCardNewsPath = outFile;
  config.features.businessCardNews = true;
}
await setup();

test('siteNews: сбор, сортировка по свежести, maxItems', async () => {
  const items = await collectSiteNewsItems({ freshDays: 30 });
  // 4 валидные карточки (d без url отфильтрована, broken пропущена)
  assert.equal(items.length, 4);
  // Самая свежая — e (mtime, записана последней), затем b (2026-08-23)
  assert.equal(items[0].title, 'Новость без даты статьи');
  assert.equal(items[1].title, 'Свежая новость');
  assert.equal(items[2].title, 'Mid original title'); // fallback на source.title
  assert.equal(items[3].title, 'Старая новость');

  const res = await exportSiteNews({ maxItems: 2, freshDays: 30 });
  assert.equal(res.items, 2);
  const out = JSON.parse(await readFile(outFile, 'utf-8'));
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].title, 'Новость без даты статьи');
  assert.equal(out.items[1].title, 'Свежая новость');
});

test('siteNews: формат полей item + updated_at', async () => {
  const res = await exportSiteNews({ maxItems: 5, freshDays: 30 });
  assert.equal(res.items, 4);
  const out = JSON.parse(await readFile(outFile, 'utf-8'));
  assert.match(out.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  for (const it of out.items) {
    assert.deepEqual(Object.keys(it), ['title', 'url', 'article_url', 'date', 'source']);
    assert.match(it.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(it.title.length > 0);
    assert.ok(it.url.startsWith('http'));
    // article_url — ссылка на страницу статьи на самом сайте.
    assert.match(it.article_url, /^articles\/.+\.html$/);
  }
  // source — hostname без www.
  const bItem = out.items.find((i) => i.url.includes('deepmind'));
  assert.equal(bItem.source, 'deepmind.google');
  assert.equal(bItem.date, '2026-08-23');
});

test('siteNews: элементы без url/title не попадают в выдачу', async () => {
  const items = await collectSiteNewsItems({ freshDays: 30 });
  assert.ok(!items.some((i) => i.url === ''));
  assert.ok(!items.some((i) => i.title === 'No url story'));
});

test('siteNews: атомарная запись — tmp-файл не остаётся', async () => {
  await exportSiteNews({ freshDays: 30 });
  const files = await readdir(outDir);
  assert.deepEqual(files.sort(), ['news.json', 'rss.xml']);
  assert.ok(!existsSync(`${outFile}.tmp`));
});

test('siteNews: rss.xml генерируется рядом с news.json', async () => {
  await exportSiteNews({ freshDays: 30 });
  const rssFile = path.join(outDir, 'rss.xml');
  const raw = await readFile(rssFile, 'utf-8');
  assert.match(raw, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(raw, /<rss version="2\.0">/);
  assert.match(raw, /<language>ru<\/language>/);
  assert.match(raw, /<lastBuildDate>.+<\/lastBuildDate>/);
  // Элементы — в том же порядке свежести, что и в news.json
  const titles = [...raw.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1]);
  assert.ok(titles.includes('Новости AI')); // title канала
  assert.ok(titles.includes('Свежая новость'));
  // Русские заголовки не эскейпнуты как unicode
  assert.ok(raw.includes('Свежая новость'));
});

test('siteNews: buildRssXml — эскейпинг спецсимволов', () => {
  const xml = buildRssXml([{
    title: 'OpenAI & "агенты" <вышли> в интернет',
    url: 'https://example.com/a&b',
    article_url: 'articles/x.html',
    date: '2026-09-05',
    source: 'example.com',
  }], { siteUrl: '' });
  assert.ok(xml.includes('<title>OpenAI &amp; &quot;агенты&quot; &lt;вышли&gt; в интернет</title>'));
  // Битых XML-узлов не осталось
  assert.ok(!xml.includes('<title>OpenAI & '));
  assert.match(xml, /<link>articles\/x\.html<\/link>/); // без siteUrl — относительная ссылка
});

test('siteNews: buildRssXml — абсолютные ссылки при заданном siteUrl', () => {
  const xml = buildRssXml([{
    title: 'Тест',
    url: 'https://example.com/a',
    article_url: 'articles/x.html',
    date: '2026-09-05',
    source: 'example.com',
  }], { siteUrl: 'https://your-site.ru/' }); // слэш на конце срезается
  assert.match(xml, /<link>https:\/\/your-site\.ru\/articles\/x\.html<\/link>/);
  assert.match(xml, /<link>https:\/\/your-site\.ru<\/link>/); // link канала
  assert.match(xml, /<pubDate>Sat, 05 Sep 2026 00:00:00 GMT<\/pubDate>/);
});

test('siteNews: SITE_RSS_PATH=off → rss.xml не генерируется', async () => {
  const rssFile = path.join(outDir, 'rss.xml');
  await rm(rssFile, { force: true });
  config.features.siteRss = false;
  try {
    await exportSiteNews({ freshDays: 30 });
    assert.ok(existsSync(outFile), 'news.json пишется как обычно');
    assert.ok(!existsSync(rssFile), 'rss.xml не создан');
  } finally {
    config.features.siteRss = true; // восстановить
  }
});

test('siteNews: BUSINESS_CARD_NEWS_PATH=off → экспорт пропускается', async () => {
  await rm(outFile, { force: true });
  config.features.businessCardNews = false;
  const res = await exportSiteNews({ freshDays: 30 });
  assert.equal(res.skipped, true);
  assert.equal(res.filepath, null);
  assert.ok(!existsSync(outFile));
  config.features.businessCardNews = true; // восстановить
});

test('siteNews: несуществующая целевая директория → понятная ошибка', async () => {
  config.businessCardNewsPath = path.join(tmpRoot, 'no-such-dir', 'news.json');
  await assert.rejects(() => exportSiteNews(), /целевая директория не существует/);
  config.businessCardNewsPath = outFile; // восстановить
});

test('siteNews: русские заголовки в JSON не эскейпнуты', async () => {
  await exportSiteNews({ freshDays: 30 });
  const raw = await readFile(outFile, 'utf-8');
  assert.ok(raw.includes('Свежая новость'));
  assert.ok(!raw.includes(String.fromCharCode(92,117,48,52,50,49)));
});

test('siteNews: dzen_links.json — dzen_url прикрепляется по url и по title', async () => {
  // Карта живёт в ../database относительно postsDir — сидаем зеркало в tmp.
  const dbDir = path.join(tmpRoot, 'database');
  await mkdir(dbDir, { recursive: true });
  await writeFile(path.join(dbDir, 'dzen_links.json'), JSON.stringify({
    links: [
      { match: 'https://www.deepmind.google/blog/fresh', dzen_url: 'https://dzen.ru/a/test-fresh' },
      { match: 'Старая новость', dzen_url: 'https://dzen.ru/a/test-old' },
    ],
  }), 'utf-8');
  try {
    const items = await collectSiteNewsItems({ freshDays: 30 });
    const fresh = items.find((i) => i.url.includes('deepmind'));
    const old = items.find((i) => i.url.includes('techcrunch.com/old'));
    const mid = items.find((i) => i.url.includes('marktechpost'));
    assert.equal(fresh.dzen_url, 'https://dzen.ru/a/test-fresh', 'матч по url');
    assert.equal(old.dzen_url, 'https://dzen.ru/a/test-old', 'матч по title');
    assert.equal(mid.dzen_url, undefined, 'без записи в карте — поля нет');
  } finally {
    await rm(dbDir, { recursive: true, force: true }); // не влиять на другие тесты
  }
});

test('siteNews: битый dzen_links.json не валит сборку', async () => {
  const dbDir = path.join(tmpRoot, 'database');
  await mkdir(dbDir, { recursive: true });
  await writeFile(path.join(dbDir, 'dzen_links.json'), '{ broken', 'utf-8');
  try {
    const items = await collectSiteNewsItems({ freshDays: 30 });
    assert.ok(items.length > 0);
    assert.ok(!items.some((i) => i.dzen_url));
  } finally {
    await rm(dbDir, { recursive: true, force: true });
  }
});

test('siteNews: регламент «топ-10 за 14 дней» — старые статьи отфильтрованы', async () => {
  const dir2 = path.join(tmpRoot, 'posts-fresh');
  await mkdir(dir2, { recursive: true });
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  // свежая (1 день назад) — должна попасть
  await writeFile(path.join(dir2, 'fresh.json'), JSON.stringify(postJson({
    source: { title: 'Fresh', url: 'https://example.com/fresh', published_at: new Date(now - day).toISOString() },
    summary: { title: 'Свежая' },
  })), 'utf-8');
  // старая (15 дней назад — старше 14) — должна отфильтроваться
  await writeFile(path.join(dir2, 'old.json'), JSON.stringify(postJson({
    source: { title: 'Old', url: 'https://example.com/old', published_at: new Date(now - 15 * day).toISOString() },
    summary: { title: 'Старая' },
  })), 'utf-8');
  const prev = config.postsDir;
  config.postsDir = dir2;
  try {
    const items = await collectSiteNewsItems(); // freshDays=14 по умолчанию
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Свежая');
  } finally {
    config.postsDir = prev;
  }
});
