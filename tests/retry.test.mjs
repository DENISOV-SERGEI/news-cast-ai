// tests/retry.test.mjs
// Поведение retryWithBackoff: успех с первого раза, ретрай retryable-ошибки,
// немедленный проброс фатальной, уважение retryAfter, лимит попыток.
// Зависимости от .env нет: retryWithBackoff использует только log из config,
// а log уровня warn глушится LOG_LEVEL=info по умолчанию (но даже если печатает — тесту не мешает).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithBackoff } from '../src/retry.js';

const tickMs = 5;

function makeErr(msg, extra = {}) {
  const e = new Error(msg);
  Object.assign(e, extra);
  return e;
}

test('retryWithBackoff: успех с первого раза — fn вызвана 1 раз', async () => {
  let calls = 0;
  const res = await retryWithBackoff(async () => { calls++; return 42; }, { baseMs: tickMs });
  assert.equal(res, 42);
  assert.equal(calls, 1);
});

test('retryWithBackoff: повторяет retryable-ошибку до успеха', async () => {
  let calls = 0;
  const res = await retryWithBackoff(async () => {
    calls++;
    if (calls < 3) throw makeErr('transient', { retryable: true });
    return 'ok';
  }, { retries: 5, baseMs: tickMs });
  assert.equal(res, 'ok');
  assert.equal(calls, 3);
});

test('retryWithBackoff: фатальная ошибка пробрасывается сразу, без повторов', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls++;
      throw makeErr('bad request', { retryable: false });
    }, { retries: 5, baseMs: tickMs }),
    /bad request/,
  );
  assert.equal(calls, 1, 'повторного вызова быть не должно');
});

test('retryWithBackoff: ошибка без флага retryable не повторяется', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls++;
      throw new Error('plain error, no retryable flag');
    }, { retries: 5, baseMs: tickMs }),
    /plain error/,
  );
  assert.equal(calls, 1);
});

test('retryWithBackoff: сдаётся после retries попыток и пробрасывает последнюю ошибку', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => {
      calls++;
      throw makeErr(`attempt ${calls}`, { retryable: true });
    }, { retries: 2, baseMs: tickMs }),
    /attempt 3/,
  );
  // 1 первичная + 2 повтора = 3 вызова
  assert.equal(calls, 3);
});

test('retryWithBackoff: уважает err.retryAfter (секунды→мс) вместо экспоненты', async (t) => {
  //retryAfter в секундах; берём маленькое значение и проверяем, что ждём ~retryAfter*1000,
  //а не baseMs*factor^0. Чтобы тест не висел секунды, retryAfter = 0.02 (20мс).
  let calls = 0;
  const start = Date.now();
  await retryWithBackoff(async () => {
    calls++;
    if (calls < 2) throw makeErr('429', { retryable: true, retryAfter: 0.02 });
    return 'ok';
  }, { retries: 3, baseMs: 10_000, factor: 10, jitterMs: 0 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 20, `должен был ждать ~20мс (retryAfter), ждал ${elapsed}мс`);
  assert.ok(elapsed < 5_000, `не должен был ждать по экспоненте (baseMs=10000), ждал ${elapsed}мс`);
});

test('retryWithBackoff: свой retryOn переопределяет критерий', async () => {
  let calls = 0;
  const res = await retryWithBackoff(async () => {
    calls++;
    if (calls < 2) throw makeErr('always-retry-by-custom', {});
    return 'ok';
  }, { retries: 3, baseMs: tickMs, retryOn: () => true });
  assert.equal(res, 'ok');
  assert.equal(calls, 2);
});