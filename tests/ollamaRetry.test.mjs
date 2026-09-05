// tests/ollamaRetry.test.mjs
// Тесты для единого контракта ретраев в callOllama / tryCallOllama.
//
// tryCallOllama экспортирована из src/adapter.js; она принимает opts.fetchFn
// (по умолчанию fetchWithTimeout из http.js), что позволяет подменять fetch
// в тестах без мок-фреймворков.
//
// Сценарии:
//   - 4xx (кроме 429) → Error без retryable (фатально);
//   - 429 / 5xx → Error с retryable=true;
//   - сетевая ошибка → Error с retryable=true;
//   - data.error → Error без retryable (фатально);
//   - finish_reason=length → { truncated:true, raw:... } (НЕ ошибка);
//   - callOllama через retryWithBackoff повторяет 3 раза на retryable и сдаётся;
//   - callOllama сразу падает на фатальной (одна попытка).
//
// Все тесты идут с очень короткими задержками (baseMs=1) и без джиттера, чтобы
// не задерживать прогон.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryCallOllama } from '../src/adapter.js';

/**
 * Создаёт мок-fetchFn, который вызывает handler() для получения Response.
 * handler получает (url, init, httpOpts) и должен вернуть Promise<Response>
 * или сам бросить ошибку (для имитации сетевых сбоев).
 */
function makeFetch(handler) {
  return async (url, init, httpOpts) => handler(url, init, httpOpts);
}

function okJson(body, { finishReason = 'stop' } = {}) {
  return new Response(JSON.stringify({
    choices: [
      { finish_reason: finishReason, message: { role: 'assistant', content: body } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function errorStatus(status, body = 'oops') {
  return new Response(body, { status });
}

const MODEL = 'test-model';
const PROMPT = 'hi';

// ===== tryCallOllama: единичные сценарии =====

test('tryCallOllama: 4xx (400) бросает без retryable — фатально', async () => {
  const fetchFn = makeFetch(() => errorStatus(400, 'bad request'));
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
    (err) => {
      assert.equal(err.retryable, false, '4xx (не 429) не должен быть retryable');
      assert.match(err.message, /HTTP 400/);
      return true;
    },
  );
});

test('tryCallOllama: 401/403/404 — фатальные (нет retryable)', async () => {
  for (const status of [401, 403, 404]) {
    const fetchFn = makeFetch(() => errorStatus(status, 'nope'));
    await assert.rejects(
      () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
      (err) => {
        assert.equal(err.retryable, false, `${status} не должен быть retryable`);
        return true;
      },
    );
  }
});

test('tryCallOllama: 429 — retryable=true (пограничный 4xx)', async () => {
  const fetchFn = makeFetch(() => errorStatus(429, 'rate limited'));
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
    (err) => {
      assert.equal(err.retryable, true, '429 обязан быть retryable');
      assert.match(err.message, /HTTP 429/);
      return true;
    },
  );
});

test('tryCallOllama: 5xx (500/502/503) — retryable=true', async () => {
  for (const status of [500, 502, 503, 504]) {
    const fetchFn = makeFetch(() => errorStatus(status, 'oops'));
    await assert.rejects(
      () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
      (err) => {
        assert.equal(err.retryable, true, `${status} должен быть retryable`);
        return true;
      },
    );
  }
});

test('tryCallOllama: сетевая ошибка — retryable=true', async () => {
  const fetchFn = makeFetch(() => {
    const e = new Error('ECONNREFUSED');
    throw e;
  });
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
    (err) => {
      assert.equal(err.retryable, true, 'сетевая ошибка должна быть retryable');
      assert.match(err.message, /network: ECONNREFUSED/);
      return true;
    },
  );
});

test('tryCallOllama: data.error (например, неизвестная модель) — фатально', async () => {
  // Подменим тело через кастомный Response
  const fakeFetch = async () => new Response(JSON.stringify({
    error: { message: 'model "foo" not found' },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn: fakeFetch }),
    (err) => {
      // Фатально = retryable либо false, либо undefined (defaultRetryOn
      // вернёт false для обоих). Главное — НЕ true.
      assert.notEqual(err.retryable, true, 'data.error не должен быть retryable');
      assert.match(err.message, /model "foo" not found/);
      return true;
    },
  );
});

test('tryCallOllama: невалидный JSON в теле (status 200) — retryable=true', async () => {
  const fetchFn = makeFetch(() => new Response('not json {{', {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
    (err) => {
      assert.equal(err.retryable, true, 'невалидный JSON должен быть retryable');
      assert.match(err.message, /bad JSON/);
      return true;
    },
  );
});

test('tryCallOllama: пустой content — retryable=true', async () => {
  const fetchFn = makeFetch(() => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
    (err) => {
      assert.equal(err.retryable, true, 'пустой content должен быть retryable');
      assert.match(err.message, /No content/);
      return true;
    },
  );
});

test('tryCallOllama: ответ без валидного JSON внутри — retryable=true', async () => {
  const fetchFn = makeFetch(() => okJson('просто текст без скобок'));
  await assert.rejects(
    () => tryCallOllama(MODEL, PROMPT, { fetchFn }),
    (err) => {
      assert.equal(err.retryable, true, 'no-valid-JSON должен быть retryable');
      assert.match(err.message, /No valid JSON/);
      return true;
    },
  );
});

test('tryCallOllama: успешный ответ — возвращает { value, usage }', async () => {
  const fetchFn = makeFetch(() => okJson('{"summary":{"title":"T"},"image_prompt":"P"}'));
  const res = await tryCallOllama(MODEL, PROMPT, { fetchFn });
  assert.equal(res.value.summary.title, 'T');
  assert.equal(res.value.image_prompt, 'P');
  assert.equal(res.usage.total_tokens, 30);
});

test('tryCallOllama: finish_reason=length возвращает sentinel { truncated, raw }', async () => {
  const fetchFn = makeFetch(() => okJson('{"summary":{"title":"T"', { finishReason: 'length' }));
  const res = await tryCallOllama(MODEL, PROMPT, { fetchFn });
  assert.equal(res.truncated, true);
  assert.match(res.raw, /"title":"T"/);
  // Это НЕ ошибка — должна быть возможность получить результат.
  assert.ok(res.value === undefined);
});

test('tryCallOllama: пустой content с fallback на reasoning — OK', async () => {
  const fetchFn = makeFetch(() => new Response(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        reasoning: '{"summary":{"title":"FromReasoning"},"image_prompt":"X"}',
      },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res = await tryCallOllama(MODEL, PROMPT, { fetchFn });
  assert.equal(res.value.summary.title, 'FromReasoning');
});

// ===== callOllama через retryWithBackoff =====

// callOllama не экспортирована — проверяем retry-цикл через прямой импорт
// и тонкий wrapper: используем retryWithBackoff + tryCallOllama в той же
// конфигурации, что и production callOllama.
import { retryWithBackoff } from '../src/retry.js';

// Воспроизводим сигнатуру callOllama (см. src/adapter.js).
async function callOllamaLike(model, prompt, opts = {}, fetchFn) {
  const maxTokens = opts.maxTokens;
  const result = await retryWithBackoff(
    () => tryCallOllama(model, prompt, { ...opts, maxTokens, fetchFn }),
    { retries: 3, baseMs: 1, factor: 1.1, jitterMs: 0, label: `test-callOllama:${model}` },
  );
  if (result && result.truncated) {
    const newMax = Math.min(maxTokens * 2, 32_000);
    if (newMax > maxTokens) {
      return callOllamaLike(model, prompt, { ...opts, maxTokens: newMax }, fetchFn);
    }
    // Дальше увеличивать некуда — best effort.
    return result;
  }
  return result;
}

test('callOllama: retryable ошибка → повторяет 3 раза и сдаётся (4 вызова fetch)', async () => {
  let calls = 0;
  const fetchFn = makeFetch(() => {
    calls++;
    return errorStatus(503, 'service unavailable');
  });
  await assert.rejects(
    () => callOllamaLike(MODEL, PROMPT, { maxTokens: 100 }, fetchFn),
    /HTTP 503/,
  );
  // 1 первичная + 3 повтора = 4 вызова fetch
  assert.equal(calls, 4);
});

test('callOllama: retryable до 2-х падений, затем успех — fetch вызван 3 раза', async () => {
  let calls = 0;
  const fetchFn = makeFetch(() => {
    calls++;
    if (calls < 3) return errorStatus(502, 'bad gateway');
    return okJson('{"summary":{"title":"OK"},"image_prompt":"X"}');
  });
  const res = await callOllamaLike(MODEL, PROMPT, { maxTokens: 100 }, fetchFn);
  assert.equal(res.value.summary.title, 'OK');
  assert.equal(calls, 3);
});

test('callOllama: фатальная 400 — сразу пробрасывается, без ретраев (1 вызов)', async () => {
  let calls = 0;
  const fetchFn = makeFetch(() => {
    calls++;
    return errorStatus(400, 'bad request');
  });
  await assert.rejects(
    () => callOllamaLike(MODEL, PROMPT, { maxTokens: 100 }, fetchFn),
    /HTTP 400/,
  );
  assert.equal(calls, 1, 'фатальная 4xx не должна ретраиться');
});

test('callOllama: data.error (фатально) — сразу пробрасывается (1 вызов)', async () => {
  let calls = 0;
  const fetchFn = makeFetch(() => {
    calls++;
    return new Response(JSON.stringify({ error: { message: 'unknown model' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  await assert.rejects(
    () => callOllamaLike(MODEL, PROMPT, { maxTokens: 100 }, fetchFn),
    /unknown model/,
  );
  assert.equal(calls, 1, 'API-ошибка не должна ретраиться');
});

test('callOllama: сетевая ошибка — ретраится до 4 вызовов fetch', async () => {
  let calls = 0;
  const fetchFn = makeFetch(() => {
    calls++;
    const e = new Error('ECONNRESET');
    throw e;
  });
  await assert.rejects(
    () => callOllamaLike(MODEL, PROMPT, { maxTokens: 100 }, fetchFn),
    /network: ECONNRESET/,
  );
  assert.equal(calls, 4);
});

test('callOllama: finish_reason=length → рекурсия с увеличенным maxTokens (1 доп. вызов)', async () => {
  let calls = 0;
  const seenMaxTokens = [];
  const fetchFn = makeFetch((url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    seenMaxTokens.push(body.max_tokens);
    // Первый вызов — finish_reason=length. Второй — успех.
    if (calls === 1) {
      return okJson('{"summary":{"title":"T"', { finishReason: 'length' });
    }
    return okJson('{"summary":{"title":"AfterRetry"},"image_prompt":"X"}');
  });
  const res = await callOllamaLike(MODEL, PROMPT, { maxTokens: 100 }, fetchFn);
  assert.equal(res.value.summary.title, 'AfterRetry');
  assert.equal(calls, 2, 'должно быть 2 вызова: первый truncated, второй успех');
  assert.equal(seenMaxTokens[0], 100);
  assert.equal(seenMaxTokens[1], 200, 'второй вызов должен иметь max_tokens=200');
});
