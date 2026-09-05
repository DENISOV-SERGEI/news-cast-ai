// tests/cleanup.test.mjs
// Очистка старых артефактов (images/, sessions/, posts/) по RETENTION_DAYS.
// Используем tmp-директории и переопределяем config-пути — реальные данные не трогаем.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { cleanupOldFiles } from '../src/cleanup.js';

function makeOldFile(dir, name, ageMs) {
  const p = path.join(dir, name);
  writeFileSync(p, 'x');
  const old = new Date(Date.now() - ageMs);
  // utimesSync: atime, mtime
  utimesSync(p, old, old);
  return p;
}

test('cleanup: retentionDays=0 → skipped (очистка отключена)', async () => {
  const prev = config.retentionDays;
  config.retentionDays = 0;
  try {
    const res = await cleanupOldFiles();
    assert.equal(res.skipped, true);
    assert.equal(res.deletedFiles, 0);
  } finally {
    config.retentionDays = prev;
  }
});

test('cleanup: удаляет файлы старше retention, оставляет свежие', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cleanup-'));
  const images = path.join(base, 'images');
  const sessions = path.join(base, 'sessions');
  const posts = path.join(base, 'posts');
  mkdirSync(images, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(posts, { recursive: true });

  // Старый файл (40 дней) и свежий (1 день) в images/.
  makeOldFile(images, 'old.png', 40 * 24 * 3600 * 1000);
  makeOldFile(images, 'fresh.png', 1 * 24 * 3600 * 1000);
  // Старый файл в поддиректории sessions/YYYY-MM-DD.
  const oldDay = path.join(sessions, '2026-07-01');
  mkdirSync(oldDay, { recursive: true });
  makeOldFile(oldDay, 'article-1.txt', 40 * 24 * 3600 * 1000);
  // Свежий файл в posts/.
  makeOldFile(posts, 'fresh.json', 1 * 24 * 3600 * 1000);

  const prev = { images: config.imagesDir, sessions: config.sessionsDir, posts: config.postsDir, days: config.retentionDays };
  config.imagesDir = images;
  config.sessionsDir = sessions;
  config.postsDir = posts;
  config.retentionDays = 30;
  try {
    const res = await cleanupOldFiles();
    assert.equal(res.skipped, false);
    assert.equal(res.deletedFiles, 2); // old.png + article-1.txt

    assert.equal(existsSync(path.join(images, 'old.png')), false);
    assert.equal(existsSync(path.join(images, 'fresh.png')), true);
    assert.equal(existsSync(path.join(posts, 'fresh.json')), true);
    // Пустая поддиректория старой даты удалена.
    assert.equal(existsSync(oldDay), false);
  } finally {
    config.imagesDir = prev.images;
    config.sessionsDir = prev.sessions;
    config.postsDir = prev.posts;
    config.retentionDays = prev.days;
  }
});

test('cleanup: несуществующие директории → 0 удалений, без ошибок', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'cleanup-'));
  const prev = { images: config.imagesDir, sessions: config.sessionsDir, posts: config.postsDir, days: config.retentionDays };
  config.imagesDir = path.join(base, 'no-images');
  config.sessionsDir = path.join(base, 'no-sessions');
  config.postsDir = path.join(base, 'no-posts');
  config.retentionDays = 30;
  try {
    const res = await cleanupOldFiles();
    assert.equal(res.deletedFiles, 0);
  } finally {
    config.imagesDir = prev.images;
    config.sessionsDir = prev.sessions;
    config.postsDir = prev.posts;
    config.retentionDays = prev.days;
  }
});
