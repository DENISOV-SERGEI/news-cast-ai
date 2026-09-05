// tests/site-articles.test.mjs
// Страница статей на сайте business_card: сбор из posts/*.json (топ-10 за 5 дней),
// генерация articles.html и articles/<slug>.html, удаление устаревших страниц,
// эскейпинг, атомарная запись, режим off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { exportSiteArticles, collectSiteArticles } from '../src/siteArticles.js';

// Уникальный временный каталог (параллельный запуск node --test).
const tmpRoot = path.join(tmpdir(), `nca-sitearticles-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const postsDir = path.join(tmpRoot, 'posts');
const articlesDir = path.join(tmpRoot, 'business_card', 'articles');
const listPath = path.join(tmpRoot, 'business_card', 'articles.html');

const DAY = 24 * 3600 * 1000;
const now = Date.now();

function postJson(over) {
  return {
    schema_version: 'content-adaptor/v2',
    source: { title: 'Original title', url: 'https://example.com/a', published_at: new Date(now - DAY).toISOString() },
    summary: { title: 'Русский заголовок' },
    social: {
      site_blog: {
        h1: 'H1',
        meta_description: 'Короткое описание',
        draft: 'Первый абзац статьи.\n\nВторой абзац статьи.',
        cta: 'CTA',
      },
    },
    ...over,
  };
}

async function seedPosts() {
  await mkdir(postsDir, { recursive: true });
  // a: свежая (1 день назад)
  await writeFile(path.join(postsDir, 'a.json'), JSON.stringify(postJson({
    source: { title: 'Fresh A', url: 'https://techcrunch.com/fresh-a', published_at: new Date(now - DAY).toISOString() },
    summary: { title: 'Свежая статья A' },
  })), 'utf-8');
  // b: свежая (2 дня назад)
  await writeFile(path.join(postsDir, 'b.json'), JSON.stringify(postJson({
    source: { title: 'Fresh B', url: 'https://www.deepmind.google/blog/fresh-b', published_at: new Date(now - 2 * DAY).toISOString() },
    summary: { title: 'Свежая статья B' },
  })), 'utf-8');
  // c: старая (15 дней назад — старше 14) → отфильтруется
  await writeFile(path.join(postsDir, 'c.json'), JSON.stringify(postJson({
    source: { title: 'Old C', url: 'https://marktechpost.com/old-c', published_at: new Date(now - 15 * DAY).toISOString() },
    summary: { title: 'Старая статья C' },
  })), 'utf-8');
  // d: без site_blog.draft → пропускается
  await writeFile(path.join(postsDir, 'd.json'), JSON.stringify(postJson({
    source: { title: 'No draft', url: 'https://example.com/no-draft', published_at: new Date(now - DAY).toISOString() },
    summary: { title: 'Без текста' },
    social: {},
  })), 'utf-8');
  // мусор не-json — не должен валить экспорт
  await writeFile(path.join(postsDir, 'broken.json'), '{ not json', 'utf-8');
}

async function setup() {
  await rm(tmpRoot, { recursive: true, force: true });
  await seedPosts();
  await mkdir(path.dirname(listPath), { recursive: true });
  config.postsDir = postsDir;
  config.siteArticlesDir = articlesDir;
  config.siteArticlesListPath = listPath;
  config.features.siteArticles = true;
}
await setup();

test('siteArticles: сбор — фильтр по 14 дням, поля, дедуп', async () => {
  const items = await collectSiteArticles();
  // a и b свежие; c старая отфильтрована; d без draft пропущена; broken пропущен
  assert.equal(items.length, 2);
  // Свежая первая
  assert.equal(items[0].title, 'Свежая статья A');
  assert.equal(items[1].title, 'Свежая статья B');
  for (const it of items) {
    assert.ok(it.slug.endsWith('.html'));
    assert.ok(it.text.length > 0);
    assert.ok(it.url.startsWith('http'));
    assert.match(it.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(it.source.length > 0);
  }
  // hostname без www.
  const b = items.find((i) => i.url.includes('deepmind'));
  assert.equal(b.source, 'deepmind.google');
});

test('siteArticles: генерация articles.html и страниц статей', async () => {
  const res = await exportSiteArticles();
  assert.equal(res.items, 2);
  assert.ok(existsSync(listPath));

  const list = await readFile(listPath, 'utf-8');
  assert.ok(list.includes('Статьи'));
  assert.ok(list.includes('articles/'));
  assert.ok(list.includes('Свежая статья A'));

  const files = await readdir(articlesDir);
  assert.equal(files.length, 2);
  const page = await readFile(path.join(articlesDir, files[0]), 'utf-8');
  assert.ok(page.includes('<h1'));
  assert.ok(page.includes('Источник:'));
  assert.ok(page.includes('Первый абзац статьи.'));
  assert.ok(page.includes('Второй абзац статьи.'));
});

test('siteArticles: устаревшие страницы удаляются', async () => {
  // Лишний файл в articles/ — не в текущем топе → должен быть удалён.
  await writeFile(path.join(articlesDir, 'stale.html'), '<html>stale</html>', 'utf-8');
  await exportSiteArticles();
  const files = await readdir(articlesDir);
  assert.ok(!files.includes('stale.html'));
  assert.equal(files.length, 2);
});

test('siteArticles: эскейпинг HTML в тексте и заголовке', async () => {
  await writeFile(path.join(postsDir, 'xss.json'), JSON.stringify(postJson({
    source: { title: 'XSS', url: 'https://example.com/xss', published_at: new Date(now - 3600e3).toISOString() },
    summary: { title: 'XSS <script>alert(1)</script>' },
    social: { site_blog: { draft: 'Текст <script>alert(1)</script> & <b>жирный</b>' } },
  })), 'utf-8');
  await exportSiteArticles();
  const files = await readdir(articlesDir);
  const page = await readFile(path.join(articlesDir, files.find((f) => f.includes('xss'))), 'utf-8');
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
  assert.ok(page.includes('&lt;b&gt;'));
});

test('siteArticles: tmp-файлы не остаются', async () => {
  await exportSiteArticles();
  const files = await readdir(articlesDir);
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  const listDir = path.dirname(listPath);
  const listFiles = await readdir(listDir);
  assert.ok(!listFiles.includes('articles.html.tmp'));
});

test('siteArticles: SITE_ARTICLES_DIR=off → экспорт пропускается', async () => {
  config.features.siteArticles = false;
  const res = await exportSiteArticles();
  assert.equal(res.skipped, true);
  assert.equal(res.filepath, null);
  config.features.siteArticles = true; // восстановить
});

test('siteArticles: несуществующая целевая директория → понятная ошибка', async () => {
  config.siteArticlesListPath = path.join(tmpRoot, 'no-such-dir', 'articles.html');
  await assert.rejects(() => exportSiteArticles(), /целевая директория не существует/);
  config.siteArticlesListPath = listPath; // восстановить
});
