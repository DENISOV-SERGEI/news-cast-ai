// tests/http.test.mjs
// fetchWithTimeout: быстрый ответ проходит, медленный → TimeoutError
// (code=ETIMEDOUT, retryable=true, name=TimeoutError).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchWithTimeout, TimeoutError } from '../src/http.js';

async function startServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function portOf(srv) {
  return srv.address().port;
}

test('fetchWithTimeout: быстрый ответ возвращается как есть', async () => {
  const srv = await startServer((req, res) => res.end('ok'));
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${portOf(srv)}/`, {}, { timeoutMs: 5000 });
    assert.ok(res.ok);
    assert.equal(await res.text(), 'ok');
  } finally {
    srv.close();
  }
});

test('fetchWithTimeout: медленный ответ → TimeoutError с code/retryable', async () => {
  const srv = await startServer((req, res) => {
    // Не отвечаем 300мс — дольше таймаута 50мс.
    setTimeout(() => res.end('late'), 300);
  });
  try {
    await assert.rejects(
      () => fetchWithTimeout(`http://127.0.0.1:${portOf(srv)}/`, {}, { timeoutMs: 50 }),
      (err) => {
        assert.equal(err.name, 'TimeoutError', `name=${err.name}`);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.retryable, true);
        assert.ok(err.message.includes('50'));
        return true;
      },
    );
  } finally {
    // Дать серверу додать ответ, чтобы корректно закрыться.
    await new Promise((r) => setTimeout(r, 350));
    srv.close();
  }
});

test('fetchWithTimeout: throws TimeoutError — это инстанс TimeoutError', async () => {
  const srv = await startServer((req, res) => setTimeout(() => res.end('late'), 200));
  try {
    try {
      await fetchWithTimeout(`http://127.0.0.1:${portOf(srv)}/`, {}, { timeoutMs: 40 });
      assert.fail('должен был бросить');
    } catch (e) {
      assert.ok(e instanceof TimeoutError, 'должен быть инстансом TimeoutError');
    }
  } finally {
    await new Promise((r) => setTimeout(r, 250));
    srv.close();
  }
});

test('fetchWithTimeout: connection refused → бросает (не TimeoutError)', async () => {
  // Порт 1 почти наверняка никем не слушается.
  await assert.rejects(
    () => fetchWithTimeout('http://127.0.0.1:1/', {}, { timeoutMs: 2000 }),
    (err) => {
      assert.ok(err.name !== 'TimeoutError', `не должен быть TimeoutError (${err.name})`);
      return true;
    },
  );
});