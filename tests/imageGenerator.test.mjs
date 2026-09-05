// tests/imageGenerator.test.mjs
// Интеграция generateImage с кэшем:
//   - первый вызов (промах) дёргает ProxyAPI, сохраняет файл, кладёт в кэш;
//   - повторный вызов с тем же промптом — кэш-попад, ProxyAPI НЕ дёргается;
//   - другой промпт — снова запрос.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm } from 'node:fs/promises';
import { existsSync as existsSyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { _resetImageCache } from '../src/imageCache.js';
import { generateImage, imageCacheKey, TARGET_IMAGE_SIZE_PX } from '../src/imageGenerator.js';
import { Jimp } from 'jimp';

// 1x1 прозрачный PNG.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/IVzAAAAAElFTkSuQmCC';

const tmpRoot = path.join(tmpdir(), `nca-imggen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

async function startMockProxyApi() {
  let requests = 0;
  const srv = createServer((req, res) => {
    if (req.url && req.url.includes('/images/generations')) {
      requests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, getRequests: () => requests };
}

test('generateImage: промах → генерация + кэш; повтор → кэш-попад без запроса', async () => {
  const work = path.join(tmpRoot, 'a');
  config.imagesDir = path.join(work, 'images');
  config.imageCachePath = path.join(work, 'image_cache.json');
  config.proxyImageModel = 'test-model';
  _resetImageCache();

  const mock = await startMockProxyApi();
  config.proxyApiBase = `http://127.0.0.1:${mock.srv.address().port}`;
  try {
    const prompt = 'flat blue geometric art about neural networks';

    // 1) Промах — генерация, файл появился, ProxyAPI дёрнут 1 раз.
    const r1 = await generateImage(prompt, 1);
    assert.equal(r1.cached, false);
    assert.ok(existsSyncSync(r1.filepath), 'файл должен быть сохранён');
    assert.match(r1.filename, /^img-[0-9a-f]{16}\.png$/);
    assert.equal(mock.getRequests(), 1);

    // 2) Тот же промпт — кэш-попад, файл тот же, запросов НЕ прибавилось.
    const r2 = await generateImage(prompt, 1);
    assert.equal(r2.cached, true);
    assert.equal(r2.filepath, r1.filepath, 'переиспользуем тот же файл');
    assert.equal(mock.getRequests(), 1, 'повторный вызов не должен дёргать ProxyAPI');

    // 3) Другой промпт — снова запрос.
    const r3 = await generateImage('a completely different prompt', 2);
    assert.equal(r3.cached, false);
    assert.notEqual(r3.filepath, r1.filepath, 'другой промпт → другой файл');
    assert.equal(mock.getRequests(), 2);
  } finally {
    mock.srv.close();
  }
});

test('generateImage: пустой промпт → ошибка', async () => {
  const work = path.join(tmpRoot, 'b');
  config.imagesDir = path.join(work, 'images');
  config.imageCachePath = path.join(work, 'image_cache.json');
  _resetImageCache();
  await assert.rejects(() => generateImage('   ', 1), /Пустой prompt/);
});

test('generateImage: имя файла детерминировано хешем промпта', async () => {
  const work = path.join(tmpRoot, 'c');
  config.imagesDir = path.join(work, 'images');
  config.imageCachePath = path.join(work, 'image_cache.json');
  config.proxyImageModel = 'test-model';
  _resetImageCache();
  const mock = await startMockProxyApi();
  config.proxyApiBase = `http://127.0.0.1:${mock.srv.address().port}`;
  try {
    const prompt = 'deterministic filename test';
    const r = await generateImage(prompt, 99); // index=99 не должен влиять на имя
    const expected = `img-${imageCacheKey(prompt)}.png`;
    assert.equal(r.filename, expected);
  } finally {
    mock.srv.close();
  }
});

// Целевой размер: площадь 1024×1024 уменьшается в 1,5 раза → сторона 836 (2026-09-04).
test('imageCacheKey: детерминирован и различает промпты', () => {
  assert.equal(TARGET_IMAGE_SIZE_PX, 836, '1024/√1,5 ≈ 836');
  assert.equal(imageCacheKey('some prompt'), imageCacheKey('some prompt'), 'одинаковый промпт → одинаковый ключ');
  assert.equal(imageCacheKey('  some prompt  '), imageCacheKey('some prompt'), 'трим учитывается');
  assert.notEqual(imageCacheKey('some prompt'), imageCacheKey('other prompt'), 'разные промпты → разные ключи');
});

test('generateImage: картинка 1200x900 от API даунскейлится до 836x836', async () => {
  const work = path.join(tmpRoot, 'd');
  config.imagesDir = path.join(work, 'images');
  config.imageCachePath = path.join(work, 'image_cache.json');
  config.proxyImageModel = 'test-model';
  _resetImageCache();

  const bigImg = new Jimp({ width: 1200, height: 900, color: 0xff3366ff });
  const bigPng = await bigImg.getBuffer('image/png');
  let requests = 0;
  const srv = createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: bigPng.toString('base64') }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  config.proxyApiBase = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await generateImage('resize me please', 1);
    assert.equal(r.cached, false);
    const saved = await Jimp.read(r.filepath);
    assert.equal(saved.bitmap.width, TARGET_IMAGE_SIZE_PX);
    assert.equal(saved.bitmap.height, TARGET_IMAGE_SIZE_PX);
    assert.equal(requests, 1, 'сервер получил ровно один запрос генерации');
  } finally {
    srv.close();
  }
});

test('cleanup', async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});