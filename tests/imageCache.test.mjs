// tests/imageCache.test.mjs
// Кэш картинок: детерминированный ключ, round-trip get/set, протухшая запись
// (файл удалён) = промах, устойчивость к битому JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  cacheKey, lookupImageCache, saveImageToCache, getCacheStats, _resetImageCache,
} from '../src/imageCache.js';

const tmpRoot = path.join(tmpdir(), `nca-imgcache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

test('cacheKey: детерминирован и нечувствителен к краевым пробелам', () => {
  assert.equal(cacheKey('hello'), cacheKey('hello'));
  assert.equal(cacheKey('  hello  '), cacheKey('hello')); // trim
  assert.equal(cacheKey('hello').length, 16);
  assert.notEqual(cacheKey('hello'), cacheKey('world'));
});

test('imageCache: round-trip save→lookup', async () => {
  const dir = path.join(tmpRoot, 'a');
  config.imageCachePath = path.join(dir, 'image_cache.json');
  _resetImageCache();

  const key = cacheKey('a prompt about robots');
  const img = path.join(dir, 'img.png');
  await mkdir(dir, { recursive: true });
  await writeFile(img, 'PNG');

  assert.equal(await lookupImageCache(key), null, 'до save — null');
  await saveImageToCache(key, 'a prompt about robots', img, 3);
  const hit = await lookupImageCache(key);
  assert.ok(hit, 'после save — есть');
  assert.equal(hit.filepath, img);
  assert.equal(hit.bytes, 3);
});

test('imageCache: протухшая запись (файл удалён) = промах', async () => {
  const dir = path.join(tmpRoot, 'b');
  config.imageCachePath = path.join(dir, 'image_cache.json');
  _resetImageCache();

  const key = cacheKey('ghost prompt');
  const img = path.join(dir, 'ghost.png');
  await mkdir(dir, { recursive: true });
  await writeFile(img, 'PNG');
  await saveImageToCache(key, 'ghost prompt', img, 3);

  await rm(img, { force: true }); // файл удалили вручную
  assert.equal(await lookupImageCache(key), null, 'без файла — промах, не вернём битый путь');
});

test('imageCache: устойчивость к битому JSON — новый пустой кэш', async () => {
  const dir = path.join(tmpRoot, 'c');
  config.imageCachePath = path.join(dir, 'broken_cache.json');
  await mkdir(dir, { recursive: true });
  await writeFile(config.imageCachePath, '{ не валидный json !!!', 'utf-8');
  _resetImageCache();

  assert.equal(await lookupImageCache('whatever'), null, 'битый файл → пустой кэш, не краш');
  const stats = await getCacheStats();
  assert.equal(stats.entries, 0);
});

test('imageCache: getCacheStats считает записи', async () => {
  const dir = path.join(tmpRoot, 'd');
  config.imageCachePath = path.join(dir, 'image_cache.json');
  _resetImageCache();

  const img = path.join(dir, 'x.png');
  await mkdir(dir, { recursive: true });
  await writeFile(img, 'PNG');
  await saveImageToCache(cacheKey('p1'), 'p1', img, 1);
  await saveImageToCache(cacheKey('p2'), 'p2', img, 1);
  const stats = await getCacheStats();
  assert.equal(stats.entries, 2);
});

test('cleanup', async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});