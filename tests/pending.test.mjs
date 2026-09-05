// tests/pending.test.mjs
// Ручная модерация: создание pending-прогона, добавление статей (с копией картинки),
// финализация (manifest + preview), чтение manifest, идемпотентность по articleId.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  generatePendingId, createPendingRun, addPendingArticle, finalizePendingRun,
  readPendingRun, updatePendingArticle, articleImagePath, listPendingRuns,
} from '../src/pending.js';

// Уникальный временный каталог для каждого файла тестов (параллельный запуск node --test).
const tmpRoot = path.join(tmpdir(), `nca-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

test('generatePendingId: формат YYYYMMDD-HHMMSS-<rand>', () => {
  const id = generatePendingId(new Date('2026-08-23T12:50:14Z'));
  // Часы локальные (Date#getHours), поэтому проверяем только структуру.
  assert.match(id, /^20260823-\d{6}-[a-z0-9]{1,8}$/);
  // Два вызова дают разные id (за счёт rand).
  assert.notEqual(generatePendingId(), generatePendingId());
});

test('pending: полный цикл create→add→finalize→read с картинкой', async () => {
  const dir = path.join(tmpRoot, 'a');
  config.pendingDir = dir;

  const { id, dir: runDir, manifest } = await createPendingRun(2);
  assert.ok(existsSync(runDir));
  assert.equal(manifest.status, 'pending');
  assert.equal(manifest.articles.length, 0);

  // Фейковая «картинка» — просто файл-маркер.
  const fakeImg = path.join(tmpRoot, 'fake-a.png');
  await mkdir(path.dirname(fakeImg), { recursive: true });
  await writeFile(fakeImg, 'PNGDATA');

  const fakeJson = {
    schema_version: 'content-adaptor/v2',
    source: { title: 'Test', url: 'https://ex.test/a', published_at: '2026-08-23T00:00:00Z' },
    social: { telegram: { title: 'T', draft: 'draft text', cta: 'cta' } },
  };

  const entry = await addPendingArticle(runDir, manifest, {
    articleId: 1, title: 'Test', source: fakeJson.source, json: fakeJson, imagePath: fakeImg,
  });
  assert.equal(entry.status, 'pending');
  assert.equal(entry.imageFile, 'article-1.png');
  assert.ok(existsSync(path.join(runDir, 'article-1.png')), 'картинка должна скопироваться в pending/');

  await finalizePendingRun(runDir, manifest);
  assert.ok(existsSync(path.join(runDir, 'preview.md')), 'preview.md должен появиться');

  const loaded = await readPendingRun(id);
  assert.equal(loaded.articles.length, 1);
  assert.equal(loaded.articles[0].json.social.telegram.draft, 'draft text');
  assert.equal(articleImagePath(loaded, 1), path.join(runDir, 'article-1.png'));
  assert.equal(articleImagePath(loaded, 999), null); // нет такой статьи
});

test('pending: addPendingArticle без картинки → imageFile=null', async () => {
  const dir = path.join(tmpRoot, 'b');
  config.pendingDir = dir;
  const { dir: runDir, manifest } = await createPendingRun(1);
  const entry = await addPendingArticle(runDir, manifest, {
    articleId: 1, title: 'NoImg', source: { url: 'u' }, json: { social: {} }, imagePath: null,
  });
  assert.equal(entry.imageFile, null);
});

test('pending: updatePendingArticle меняет статус и сохраняет', async () => {
  const dir = path.join(tmpRoot, 'c');
  config.pendingDir = dir;
  const { id, dir: runDir, manifest } = await createPendingRun(1);
  await addPendingArticle(runDir, manifest, {
    articleId: 1, title: 'X', source: { url: 'u1' }, json: { social: {} }, imagePath: null,
  });
  await finalizePendingRun(runDir, manifest);

  const loaded = await readPendingRun(id);
  await updatePendingArticle(loaded, 1, { status: 'published', publishedAt: '2026-08-23T12:00:00Z', results: { telegram: 'message_id=5' } });

  const reloaded = await readPendingRun(id);
  assert.equal(reloaded.articles[0].status, 'published');
  assert.equal(reloaded.articles[0].results.telegram, 'message_id=5');
});

test('pending: readPendingRun бросает на отсутствующем id', async () => {
  config.pendingDir = path.join(tmpRoot, 'd');
  await assert.rejects(() => readPendingRun('no-such-id'), /не найден/);
});

test('pending: listPendingRuns возвращает каталоги, свежие сверху', async () => {
  const dir = path.join(tmpRoot, 'e');
  config.pendingDir = dir;
  await createPendingRun(1);
  await createPendingRun(1);
  const list = await listPendingRuns();
  assert.equal(list.length, 2);
  // Свежий id лексически больше → должен идти первым.
  assert.ok(list[0] >= list[1]);
});

// Чистим за собой (best-effort, после всех тестов файла).
test('cleanup', async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});