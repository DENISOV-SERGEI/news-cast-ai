// tests/publisher-vk.test.mjs
// Тесты для src/publisher.vk.js:
//   - needsDocsFallback: эвристика выбора пути (OG vs docs.save).
//   - publishToVK: 3 ветки (no-image / OG-путь / docs.save fallback) + edge cases.
//
// Как мокаем VK: подменяем globalThis.fetch. Все запросы к api.vk.com
// перенаправляются на локальный HTTP-сервер; upload_url отдаётся тем же
// сервером под отдельным путём. Это покрывает и vkCall(), и uploadToVKUploadUrl().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { _resetRateLimit } from '../src/rateLimit.js';
import { needsDocsFallback, publishToVK } from '../src/publisher.vk.js';

// ─── Вспомогательное: локальный HTTP-сервер для моков VK API и upload_url ───

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function portOf(srv) { return srv.address().port; }

/**
 * Подменяет globalThis.fetch так, чтобы все запросы к api.vk.com шли на
 * локальный сервер `srv` (тот же порт, тот же путь). upload_url отдаётся
 * под отдельным путём `/_upload/<id>` — мок сервера решает, как на него
 * ответить. Возвращает функцию восстановления.
 */
function installFetchMock(srv) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.vk.com') {
      const rewritten = new URL(`http://127.0.0.1:${portOf(srv)}${u.pathname}${u.search}`);
      return realFetch(rewritten, opts);
    }
    // upload_url обычно имеет вид https://pu.vk.com/... — не api.vk.com.
    // Для теста мы отдаём upload_url как http://127.0.0.1:port/_upload/...
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      return realFetch(url, opts);
    }
    // На всякий случай — passthrough.
    return realFetch(url, opts);
  };
  return () => { globalThis.fetch = realFetch; };
}

const tmpRoot = await mkdtemp(path.join(tmpdir(), `nca-publisher-vk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));

async function makeFakePng() {
  const dir = await mkdtemp(path.join(tmpRoot, 'png-'));
  const file = path.join(dir, 'fake.png');
  // Минимальный PNG-сигнатура (8 байт) — для нашего теста не важно содержимое,
  // VK не валидирует magic numbers на этом шаге (мы их не отправляем на сервер).
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  return file;
}

// ─── needsDocsFallback ───

test('needsDocsFallback: домен в VK_OG_FALLBACK_DOMAINS → true', () => {
  const saved = config.vkOgFallbackDomains;
  config.vkOgFallbackDomains = ['techcrunch.com', 'deepmind.google'];
  try {
    assert.equal(needsDocsFallback('https://techcrunch.com/2026/08/23/x'), true);
    assert.equal(needsDocsFallback('https://www.techcrunch.com/2026/08/23/x'), true);
    assert.equal(needsDocsFallback('https://DEEPMIND.google/blog'), true);
  } finally {
    config.vkOgFallbackDomains = saved;
  }
});

test('needsDocsFallback: домен НЕ в списке → false', () => {
  const saved = config.vkOgFallbackDomains;
  config.vkOgFallbackDomains = ['techcrunch.com'];
  try {
    assert.equal(needsDocsFallback('https://marktechpost.com/2026/08/x'), false);
    assert.equal(needsDocsFallback('https://example.com/y'), false);
  } finally {
    config.vkOgFallbackDomains = saved;
  }
});

test('needsDocsFallback: пустой sourceUrl → true (нечего подтягивать)', () => {
  assert.equal(needsDocsFallback(''), true);
  assert.equal(needsDocsFallback(null), true);
  assert.equal(needsDocsFallback(undefined), true);
});

test('needsDocsFallback: невалидный URL → true (безопасный fallback)', () => {
  assert.equal(needsDocsFallback('not-a-url'), true);
  assert.equal(needsDocsFallback('://broken'), true);
});

test('needsDocsFallback: пустой VK_OG_FALLBACK_DOMAINS → false для любого URL', () => {
  const saved = config.vkOgFallbackDomains;
  config.vkOgFallbackDomains = [];
  try {
    assert.equal(needsDocsFallback('https://anything.com/x'), false);
  } finally {
    config.vkOgFallbackDomains = saved;
  }
});

// ─── publishToVK: без imagePath ───

test('publishToVK: без imagePath → wall.post без attachments', async () => {
  const calls = [];
  const srv = await startServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url.startsWith('/method/wall.post')) {
      res.end(JSON.stringify({ response: { post_id: 42 } }));
      return;
    }
    res.end(JSON.stringify({ error: { error_code: 404, error_msg: 'mock unexpected' } }));
  });
  const restore = installFetchMock(srv);
  const savedAccess = config.vkAccessToken;
  const savedGroup = config.vkGroupId;
  const savedOgFb = config.vkOgFallbackDomains;
  const savedRate = config.vkRateLimitMs;
  _resetRateLimit('vk');
  config.vkAccessToken = 'mock-group-token';
  config.vkGroupId = '240796546';
  config.vkOgFallbackDomains = [];
  config.vkRateLimitMs = 0;
  try {
    const json = {
      source: { url: 'https://example.com/article', title: 'X' },
      social: { vk: { title: 'T', draft: 'D', cta: 'C' } },
    };
    const result = await publishToVK(json, null);
    assert.equal(result.postId, 42);
    assert.equal(result.hasPhoto, false);
    assert.equal(result.ownerId, -240796546);
    // Только wall.post, никаких docs/photos вызовов.
    const methods = calls.map((c) => c.url.split('?')[0]);
    assert.deepEqual(methods, ['/method/wall.post']);
  } finally {
    config.vkAccessToken = savedAccess;
    config.vkGroupId = savedGroup;
    config.vkOgFallbackDomains = savedOgFb;
    config.vkRateLimitMs = savedRate;
    restore();
    srv.close();
  }
});

// ─── publishToVK: OG-путь (imagePath есть, но домен НЕ в fallback) ───

test('publishToVK: imagePath + OG-домен → wall.post БЕЗ attachment (OG)', async () => {
  const calls = [];
  const srv = await startServer((req, res) => {
    calls.push(req.url.split('?')[0]);
    if (req.url.startsWith('/method/wall.post')) {
      res.end(JSON.stringify({ response: { post_id: 100 } }));
      return;
    }
    res.end(JSON.stringify({ error: { error_code: 999, error_msg: 'should not be called' } }));
  });
  const restore = installFetchMock(srv);
  const savedAccess = config.vkAccessToken;
  const savedGroup = config.vkGroupId;
  const savedOgFb = config.vkOgFallbackDomains;
  const savedRate = config.vkRateLimitMs;
  _resetRateLimit('vk');
  config.vkAccessToken = 'mock-group-token';
  config.vkGroupId = '240796546';
  config.vkOgFallbackDomains = []; // пусто → OG для всех
  config.vkRateLimitMs = 0;
  let fakePng = null;
  try {
    fakePng = await makeFakePng();
    const json = {
      source: { url: 'https://marktechpost.com/2026/08/x', title: 'X' },
      social: { vk: { title: 'T', draft: 'D', cta: 'C' } },
    };
    const result = await publishToVK(json, fakePng);
    assert.equal(result.postId, 100);
    assert.equal(result.hasPhoto, false, 'OG-путь не прикрепляет наш PNG');
    // Никаких docs.* вызовов.
    const called = calls.some((u) => u.startsWith('/method/docs.'));
    assert.equal(called, false, `docs.* не должны вызываться в OG-пути, вызваны: ${calls.join(',')}`);
  } finally {
    config.vkAccessToken = savedAccess;
    config.vkGroupId = savedGroup;
    config.vkOgFallbackDomains = savedOgFb;
    config.vkRateLimitMs = savedRate;
    restore();
    srv.close();
    if (fakePng) await rm(path.dirname(fakePng), { recursive: true, force: true });
  }
});

// ─── publishToVK: docs.save fallback ───

test('publishToVK: imagePath + домен в fallback → docs.save → attachment', async () => {
  const calls = [];
  let wallPostBody = ''; // параметры wall.post теперь в теле POST, не в query
  const UPLOAD_PATH = '/_upload/abc';
  const srv = await startServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url.startsWith('/method/docs.getWallUploadServer')) {
      res.end(JSON.stringify({ response: { upload_url: `http://127.0.0.1:${portOf(srv)}${UPLOAD_PATH}` } }));
      return;
    }
    if (req.url.startsWith(UPLOAD_PATH)) {
      // Имитируем VK upload_url — он возвращает {file: "..."}.
      res.end(JSON.stringify({ file: 'https://vk.com/doc_userid_docid_accesskey' }));
      return;
    }
    if (req.url.startsWith('/method/docs.save')) {
      res.end(JSON.stringify({ response: { type: 'doc', doc: { id: 777, owner_id: -240796546, access_key: 'AK' } } }));
      return;
    }
    if (req.url.startsWith('/method/wall.post')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        wallPostBody = body;
        res.end(JSON.stringify({ response: { post_id: 200 } }));
      });
      return;
    }
    res.end(JSON.stringify({ error: { error_code: 999, error_msg: `unexpected ${req.url}` } }));
  });
  const restore = installFetchMock(srv);
  const savedAccess = config.vkAccessToken;
  const savedGroup = config.vkGroupId;
  const savedOgFb = config.vkOgFallbackDomains;
  const savedRate = config.vkRateLimitMs;
  _resetRateLimit('vk');
  config.vkAccessToken = 'mock-group-token';
  config.vkGroupId = '240796546';
  config.vkOgFallbackDomains = ['techcrunch.com']; // ← триггерит fallback
  config.vkRateLimitMs = 0;
  let fakePng = null;
  try {
    fakePng = await makeFakePng();
    const json = {
      source: { url: 'https://techcrunch.com/2026/08/x', title: 'X' },
      social: { vk: { title: 'T', draft: 'D', cta: 'C' } },
    };
    const result = await publishToVK(json, fakePng);
    assert.equal(result.postId, 200);
    assert.equal(result.hasPhoto, true);
    assert.equal(result.ownerId, -240796546);
    // Проверяем, что в wall.post ушёл attachment с doc-форматом (в теле POST).
    const wallCall = calls.find((c) => c.url.startsWith('/method/wall.post'));
    assert.ok(wallCall, 'wall.post должен быть вызван');
    const wallParams = new URLSearchParams(wallPostBody);
    assert.equal(wallParams.get('attachments'), 'doc-240796546_777_AK', `attachments в теле wall.post, получили: ${wallPostBody}`);
    // Токен идёт только в теле запроса — в URL его быть не должно.
    assert.ok(!wallCall.url.includes('access_token'), `access_token не должен попадать в URL: ${wallCall.url}`);
    assert.equal(wallParams.get('access_token'), 'mock-group-token', 'access_token должен быть в теле POST');
    // Проверяем порядок: getWallUploadServer → upload_url → docs.save → wall.post.
    const order = calls.map((c) => c.url.split('?')[0]);
    assert.deepEqual(order, [
      '/method/docs.getWallUploadServer',
      UPLOAD_PATH,
      '/method/docs.save',
      '/method/wall.post',
    ], `неверный порядок: ${order.join(' → ')}`);
  } finally {
    config.vkAccessToken = savedAccess;
    config.vkGroupId = savedGroup;
    config.vkOgFallbackDomains = savedOgFb;
    config.vkRateLimitMs = savedRate;
    restore();
    srv.close();
    if (fakePng) await rm(path.dirname(fakePng), { recursive: true, force: true });
  }
});

test('publishToVK: docs.save упал → ошибка пробрасывается (не маскируется)', async () => {
  const srv = await startServer((req, res) => {
    if (req.url.startsWith('/method/docs.getWallUploadServer')) {
      res.end(JSON.stringify({ response: { upload_url: `http://127.0.0.1:${portOf(srv)}/_upload/abc` } }));
      return;
    }
    if (req.url.startsWith('/_upload/abc')) {
      res.end(JSON.stringify({ file: 'https://vk.com/doc_x' }));
      return;
    }
    if (req.url.startsWith('/method/docs.save')) {
      res.end(JSON.stringify({ error: { error_code: 7, error_msg: 'permission denied' } }));
      return;
    }
    res.end(JSON.stringify({ response: { post_id: 1 } }));
  });
  const restore = installFetchMock(srv);
  const savedAccess = config.vkAccessToken;
  const savedGroup = config.vkGroupId;
  const savedOgFb = config.vkOgFallbackDomains;
  const savedRate = config.vkRateLimitMs;
  _resetRateLimit('vk');
  config.vkAccessToken = 'mock-group-token';
  config.vkGroupId = '240796546';
  config.vkOgFallbackDomains = ['techcrunch.com'];
  config.vkRateLimitMs = 0;
  let fakePng = null;
  try {
    fakePng = await makeFakePng();
    const json = {
      source: { url: 'https://techcrunch.com/x', title: 'X' },
      social: { vk: { title: 'T', draft: 'D', cta: 'C' } },
    };
    await assert.rejects(
      () => publishToVK(json, fakePng),
      (err) => {
        assert.ok(err.message.includes('docs.save'), `должна быть ошибка docs.save, получили: ${err.message}`);
        assert.ok(err.message.includes('code=7'), `должен быть error_code 7: ${err.message}`);
        return true;
      },
    );
  } finally {
    config.vkAccessToken = savedAccess;
    config.vkGroupId = savedGroup;
    config.vkOgFallbackDomains = savedOgFb;
    config.vkRateLimitMs = savedRate;
    restore();
    srv.close();
    if (fakePng) await rm(path.dirname(fakePng), { recursive: true, force: true });
  }
});

test('publishToVK: VK_ACCESS_TOKEN не задан → падает с понятным сообщением', async () => {
  // config.features.vk вычисляется один раз при загрузке модуля и не
  // пересчитывается. Чтобы протестировать раннюю проверку токена, временно
  // переопределяем features.vk.
  const srv = await startServer((req, res) => {
    res.end(JSON.stringify({ error: { error_code: 15, error_msg: 'mock unexpected' } }));
  });
  const restore = installFetchMock(srv);
  const savedFeatures = config.features.vk;
  config.features.vk = false;
  try {
    const json = {
      source: { url: 'https://example.com/x', title: 'X' },
      social: { vk: { title: 'T', draft: 'D', cta: 'C' } },
    };
    await assert.rejects(
      () => publishToVK(json, null),
      (err) => {
        assert.ok(err.message.includes('VK_ACCESS_TOKEN'), err.message);
        return true;
      },
    );
  } finally {
    config.features.vk = savedFeatures;
    restore();
    srv.close();
  }
});
