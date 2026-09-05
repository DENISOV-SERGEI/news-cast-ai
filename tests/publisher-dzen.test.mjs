// tests/publisher-dzen.test.mjs
// Тесты для src/publisher.dzen.js:
//   - buildHashtags: префиксация '#', схлопывание пробелов, edge cases.
//   - buildDzenMessage: эскейп HTML, склейка title+description+draft+hashtags,
//     ошибка при пустом social.yandex_dzen.
//   - publishToDzenSync: 3 ветки (короткий+фото / средний текст / длинный
//     текст с обрезкой), проверка отправки в правильный chat_id, без фото.
//   - checkDzenSyncAccess: фича выключена → false, чат недоступен → false,
//     чат доступен → true.
//
// Как мокаем Telegram: подменяем globalThis.fetch. Запросы к api.telegram.org
// перенаправляются на локальный HTTP-сервер. Возвращаем реалистичные JSON-ы.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { _resetRateLimit } from '../src/rateLimit.js';
import {
  buildHashtags,
  buildDzenMessage,
  publishToDzenSync,
  checkDzenSyncAccess,
  trimToLimit,
} from '../src/publisher.dzen.js';

// ─── Вспомогательное: локальный HTTP-сервер для моков Telegram API ───

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function portOf(srv) { return srv.address().port; }

/**
 * Подменяет globalThis.fetch так, чтобы запросы к api.telegram.org шли на
 * локальный сервер srv. Тот же путь, те же параметры — мок сервера решает,
 * как отвечать. Возвращает функцию восстановления.
 */
function installFetchMock(srv) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.telegram.org') {
      const rewritten = new URL(`http://127.0.0.1:${portOf(srv)}${u.pathname}${u.search}`);
      return realFetch(rewritten, opts);
    }
    return realFetch(url, opts);
  };
  return () => { globalThis.fetch = realFetch; };
}

const tmpRoot = await mkdtemp(path.join(tmpdir(), `nca-publisher-dzen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));

async function makeFakePng() {
  const dir = await mkdtemp(path.join(tmpRoot, 'png-'));
  const file = path.join(dir, 'fake.png');
  // Минимальная PNG-сигнатура — Telegram на этом шаге содержимое не валидирует.
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  return file;
}

// ─── buildHashtags ───

test('buildHashtags: простой список → "#ai #openai #gpt"', () => {
  assert.equal(buildHashtags(['ai', 'openai', 'gpt']), '#ai #openai #gpt');
});

test('buildHashtags: схлопывает пробелы внутри тега в "_"', () => {
  assert.equal(buildHashtags(['open source', 'deep learning']), '#open_source #deep_learning');
});

test('buildHashtags: убирает уже-стоящий "#" префикс', () => {
  assert.equal(buildHashtags(['#ai', '##tech']), '#ai #tech');
});

test('buildHashtags: пустой массив → пустая строка', () => {
  assert.equal(buildHashtags([]), '');
  assert.equal(buildHashtags(null), '');
  assert.equal(buildHashtags(undefined), '');
});

test('buildHashtags: пустые/пробельные теги пропускаются', () => {
  assert.equal(buildHashtags(['ai', '', '   ', 'gpt']), '#ai #gpt');
});

// ─── buildDzenMessage ───

test('buildDzenMessage: полный набор → html + plain со всеми секциями', () => {
  const json = {
    social: {
      yandex_dzen: {
        title: 'GPT-5 release',
        description: 'Краткое описание',
        draft: 'Длинный текст статьи про релиз.',
        tags: ['ai', 'openai'],
      },
    },
  };
  const { html, plain } = buildDzenMessage(json);
  assert.ok(html.includes('GPT-5 release'), 'title присутствует');
  assert.ok(html.includes('Краткое описание'), 'description присутствует');
  assert.ok(html.includes('Длинный текст'), 'draft присутствует');
  // Хештеги убраны из текста Дзен-постов (решение владельца, 2026-09-04).
  assert.ok(!html.includes('#ai') && !html.includes('#openai'), 'hashtags НЕ должны попадать в текст');
  assert.ok(!plain.includes('#ai'), 'hashtags НЕ должны попадать в plain');
  assert.equal(plain.includes('GPT-5 release'), true);
  // title префиксуется тематическим emoji (для "GPT-5 release" → 🤖 🧠).
  assert.ok(/^(\p{Extended_Pictographic})/u.test(plain), 'title префиксован emoji');
});

test('buildDzenMessage: HTML-эскейп — & < > безопасно экранируются', () => {
  const json = {
    social: {
      yandex_dzen: {
        title: 'A & B < C',
        draft: 'Тест > и < символов',
      },
    },
  };
  const { html } = buildDzenMessage(json);
  assert.ok(html.includes('A &amp; B &lt; C'), '& экранируется');
  assert.ok(html.includes('Тест &gt; и &lt; символов'), '< и > экранируются');
  // Голый '<' и '&' НЕ должны появиться в HTML (только в эскейпнутом виде).
  assert.equal(html.includes('Тест > и < символов'), false, 'не должно быть голых < и >');
});

test('buildDzenMessage: пустой yandex_dzen → ошибка', () => {
  assert.throws(() => buildDzenMessage({ social: {} }), /yandex_dzen/);
  assert.throws(() => buildDzenMessage({ social: { yandex_dzen: {} } }), /yandex_dzen/);
});

test('buildDzenMessage: только description (без draft) → всё равно работает', () => {
  const json = {
    social: {
      yandex_dzen: { title: 'Заголовок', description: 'Описание' },
    },
  };
  const { html } = buildDzenMessage(json);
  assert.ok(html.includes('Заголовок'));
  assert.ok(html.includes('Описание'));
});

// ─── trimToLimit: обрезка по границе предложения (не на пол фразы) ───

test('trimToLimit: режет по границе предложения, не на пол фразы', () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение.';
  const out = trimToLimit(text, 30);
  assert.ok(out.endsWith('…'), 'должен заканчиваться на …');
  const body = out.slice(0, -1);
  assert.ok(/[.!?…]$/.test(body), `обрезка должна быть на границе предложения: "${body}"`);
  assert.ok(body.length <= 30, `длина ${body.length} ≤ 30`);
});

test('trimToLimit: точка реза в середине слова → откат к границе предложения', () => {
  const text = 'Первое предложение. Второе предложение. Третье предложение.';
  // limit=25: точка реза попадает в середину "Второе" — должен откатиться к точке.
  const out = trimToLimit(text, 25);
  const body = out.slice(0, -1);
  assert.ok(/[.!?…]$/.test(body), `обрезка должна быть на границе предложения: "${body}"`);
  assert.ok(!body.endsWith('Втор'), `не должно быть обрыва на пол слова: "${body}"`);
});

test('trimToLimit: текст без знаков конца предложения → откат к границе слова', () => {
  const text = 'Слово '.repeat(20).trim();
  const out = trimToLimit(text, 30);
  const body = out.slice(0, -1);
  assert.ok(body.endsWith('Слово'), `обрезка должна быть на границе слова: "${body}"`);
  assert.ok(body.length <= 30, `длина ${body.length} ≤ 30`);
});

// ─── publishToDzenSync: фича выключена → ошибка ───

test('publishToDzenSync: TELEGRAM_DZEN_SYNC_CHAT_ID не задан → понятная ошибка', async () => {
  const saved = config.features.dzenSync;
  config.features.dzenSync = false;
  try {
    const json = { social: { yandex_dzen: { title: 'T', draft: 'D' } } };
    await assert.rejects(
      () => publishToDzenSync(json, null),
      (err) => {
        assert.ok(err.message.includes('TELEGRAM_DZEN_SYNC_CHAT_ID'), err.message);
        return true;
      },
    );
  } finally {
    config.features.dzenSync = saved;
  }
});

// ─── publishToDzenSync: короткий текст + фото → sendPhoto ───

test('publishToDzenSync: короткий текст + фото → один sendPhoto с caption', async () => {
  const calls = [];
  const srv = await startServer(async (req, res) => {
    // Считываем тело multipart, чтобы убедиться, что chat_id там есть.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf-8');
    calls.push({ method: req.method, url: req.url, body });
    if (req.url.includes('sendPhoto')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 500, chat: { id: -100999 } } }));
      return;
    }
    res.end(JSON.stringify({ ok: false, description: 'mock unexpected: ' + req.url }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedRate = config.telegramRateLimitMs;
  const savedFeatures = config.features.dzenSync;
  _resetRateLimit('telegram');
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '@dzen_sync_channel';
  config.telegramRateLimitMs = 0;
  config.features.dzenSync = true;
  let fakePng = null;
  try {
    fakePng = await makeFakePng();
    // Короткий текст (< 1024 символов).
    const json = {
      social: {
        yandex_dzen: {
          title: 'Заголовок',
          description: 'Описание',
          draft: 'Текст статьи',
          tags: ['ai'],
        },
      },
    };
    const result = await publishToDzenSync(json, fakePng);
    assert.equal(result.messageId, 500);
    assert.equal(result.method, 'sendPhoto');
    assert.equal(result.attachmentType, 'photo');
    // chat_id в multipart-body (Telegram Bot API принимает chat_id как поле form-data).
    const photoCall = calls.find((c) => c.url.includes('sendPhoto'));
    assert.ok(photoCall, 'sendPhoto должен быть вызван');
    assert.ok(photoCall.body.includes('@dzen_sync_channel'), `chat_id должен быть в multipart-body: ${photoCall.body}`);
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.telegramRateLimitMs = savedRate;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
    if (fakePng) await rm(path.dirname(fakePng), { recursive: true, force: true });
  }
});

// ─── publishToDzenSync: длинный текст (> 1024) + фото → ОДИН sendPhoto с обрезанным caption ───
// Регрессия-фикс 2026-09-04: раздельные sendPhoto + sendMessage @zen_sync_bot
// превращал в ДВЕ статьи Дзена. Теперь всегда ровно одно сообщение.

test('publishToDzenSync: длинный текст (> 1024) + фото → один sendPhoto, caption обрезан ≤ 1024', async () => {
  const calls = [];
  const srv = await startServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf-8');
    calls.push({ url: req.url.split('?')[0], body });
    if (req.url.includes('sendPhoto')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 600, chat: { id: -100999 } } }));
      return;
    }
    // sendMessage теперь НЕ должен вызываться вовсе.
    res.end(JSON.stringify({ ok: false, description: 'mock unexpected: ' + req.url }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedRate = config.telegramRateLimitMs;
  const savedFeatures = config.features.dzenSync;
  _resetRateLimit('telegram');
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '@dzen_sync_channel';
  config.telegramRateLimitMs = 0;
  config.features.dzenSync = true;
  let fakePng = null;
  try {
    fakePng = await makeFakePng();
    // Длинный текст (~1800 символов) — раньше провоцировал sendPhoto+sendMessage.
    const longDraft = 'Слово '.repeat(300).trim();
    const json = {
      social: {
        yandex_dzen: {
          title: 'Заголовок',
          description: 'Описание',
          draft: longDraft,
          tags: ['ai'],
        },
      },
    };
    const result = await publishToDzenSync(json, fakePng);
    assert.equal(result.messageId, 600);
    assert.equal(result.method, 'sendPhoto');
    assert.equal(result.attachmentType, 'photo');
    // Ровно один вызов API — sendPhoto; sendMessage быть не должно.
    const methods = calls.map((c) => c.url);
    assert.ok(!methods.some((u) => u.includes('sendMessage')), `sendMessage не должен вызываться: ${methods.join(', ')}`);
    const photoCalls = calls.filter((c) => c.url.includes('sendPhoto'));
    assert.equal(photoCalls.length, 1, `ожидался ровно 1 sendPhoto, получили: ${photoCalls.length}`);
    // Caption обрезан до лимита 1024 (с учётом multipart-обёртки ищем поле caption).
    const m = photoCalls[0].body.match(/name="caption"\r?\n\r?\n([\s\S]*?)\r?\n--/);
    assert.ok(m, 'caption должен быть в multipart-body');
    const caption = m[1];
    assert.ok(caption.length <= 1024, `caption ${caption.length} символов должен укладываться в 1024`);
    assert.ok(caption.endsWith('…'), 'обрезанный caption должен заканчиваться на …');
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.telegramRateLimitMs = savedRate;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
    if (fakePng) await rm(path.dirname(fakePng), { recursive: true, force: true });
  }
});

// ─── publishToDzenSync: без фото → один sendMessage ───

test('publishToDzenSync: без фото, текст влезает в 4096 → один sendMessage', async () => {
  const calls = [];
  const srv = await startServer((req, res) => {
    calls.push(req.url.split('?')[0]);
    if (req.url.includes('sendMessage')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 700, chat: { id: -100999 } } }));
      return;
    }
    res.end(JSON.stringify({ ok: false, description: 'mock unexpected: ' + req.url }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedRate = config.telegramRateLimitMs;
  const savedFeatures = config.features.dzenSync;
  _resetRateLimit('telegram');
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '-100999';
  config.telegramRateLimitMs = 0;
  config.features.dzenSync = true;
  try {
    const json = {
      social: {
        yandex_dzen: { title: 'T', draft: 'Текст статьи', tags: ['ai'] },
      },
    };
    const result = await publishToDzenSync(json, null);
    assert.equal(result.messageId, 700);
    assert.equal(result.method, 'sendMessage');
    assert.equal(result.attachmentType, 'text');
    const methods = calls.filter((u) => u.includes('sendMessage'));
    assert.deepEqual(methods, ['/botsync-bot/sendMessage']);
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.telegramRateLimitMs = savedRate;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
  }
});

// ─── publishToDzenSync: ошибка Telegram пробрасывается ───

test('publishToDzenSync: Telegram вернул !ok → ошибка пробрасывается', async () => {
  const srv = await startServer((req, res) => {
    res.end(JSON.stringify({ ok: false, description: 'chat not found' }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedRate = config.telegramRateLimitMs;
  const savedFeatures = config.features.dzenSync;
  _resetRateLimit('telegram');
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '@bad_channel';
  config.telegramRateLimitMs = 0;
  config.features.dzenSync = true;
  try {
    const json = {
      social: { yandex_dzen: { title: 'T', draft: 'D' } },
    };
    await assert.rejects(
      () => publishToDzenSync(json, null),
      (err) => {
        assert.ok(err.message.includes('chat not found'), `ожидалось 'chat not found', получили: ${err.message}`);
        return true;
      },
    );
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.telegramRateLimitMs = savedRate;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
  }
});

// ─── checkDzenSyncAccess: фича выключена → false без fetch ───

test('checkDzenSyncAccess: фича выключена → false (без HTTP)', async () => {
  const savedFeatures = config.features.dzenSync;
  config.features.dzenSync = false;
  try {
    const result = await checkDzenSyncAccess();
    assert.equal(result, false);
  } finally {
    config.features.dzenSync = savedFeatures;
  }
});

// ─── checkDzenSyncAccess: фича включена, канал доступен → true ───

test('checkDzenSyncAccess: getMe OK + getChat OK → true', async () => {
  const srv = await startServer((req, res) => {
    if (req.url.includes('getMe')) {
      res.end(JSON.stringify({ ok: true, result: { id: 1, username: 'sync_bot' } }));
      return;
    }
    if (req.url.includes('getChat')) {
      res.end(JSON.stringify({ ok: true, result: { id: -100999, title: 'Dzen Sync Channel', type: 'channel' } }));
      return;
    }
    res.end(JSON.stringify({ ok: false, description: 'unexpected: ' + req.url }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedFeatures = config.features.dzenSync;
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '@dzen_sync_channel';
  config.features.dzenSync = true;
  try {
    const result = await checkDzenSyncAccess();
    assert.equal(result, true);
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
  }
});

// ─── checkDzenSyncAccess: getChat упал → false ───

test('checkDzenSyncAccess: getChat вернул !ok → false', async () => {
  const srv = await startServer((req, res) => {
    if (req.url.includes('getMe')) {
      res.end(JSON.stringify({ ok: true, result: { id: 1, username: 'sync_bot' } }));
      return;
    }
    if (req.url.includes('getChat')) {
      res.end(JSON.stringify({ ok: false, description: 'chat not found' }));
      return;
    }
    res.end(JSON.stringify({ ok: false, description: 'unexpected: ' + req.url }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedFeatures = config.features.dzenSync;
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '@bad_channel';
  config.features.dzenSync = true;
  try {
    const result = await checkDzenSyncAccess();
    assert.equal(result, false);
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
  }
});
// ─── Правила @zen_sync_bot из официальной инструкции (dzen.ru/help, 2026-09-04) ───

test('buildDzenMessage: title без финальной пунктуации получает точку (граница заголовка Дзена)', () => {
  const { plain } = buildDzenMessage({
    social: { yandex_dzen: { title: 'Заголовок без точки', draft: 'Текст.' } },
  });
  // Первое предложение Дзен берёт как заголовок — оно должно заканчиваться на '.'
  const firstLine = plain.split('\n')[0];
  assert.ok(firstLine.endsWith('.'), `первая строка должна заканчиваться точкой: "${firstLine}"`);
});

test('buildDzenMessage: title с пунктуацией не дублирует точку', () => {
  const { plain } = buildDzenMessage({
    social: { yandex_dzen: { title: 'GPT-5 вышел!', draft: 'Текст.' } },
  });
  const firstLine = plain.split('\n')[0];
  assert.ok(!firstLine.endsWith('!.'), `не должно быть двойной пунктуации: "${firstLine}"`);
  assert.ok(firstLine.endsWith('!'));
});

test('publishToDzenSync: фото > лимита Дзена (20 МБ) → fallback на текст-онли', async () => {
  const calls = [];
  const srv = await startServer((req, res) => {
    calls.push(req.url.split('?')[0]);
    if (req.url.includes('sendMessage')) {
      res.end(JSON.stringify({ ok: true, result: { message_id: 800, chat: { id: -100999 } } }));
      return;
    }
    res.end(JSON.stringify({ ok: false, description: 'mock unexpected: ' + req.url }));
  });
  const restore = installFetchMock(srv);
  const savedBot = config.telegramBotToken;
  const savedChat = config.telegramDzenSyncChatId;
  const savedRate = config.telegramRateLimitMs;
  const savedFeatures = config.features.dzenSync;
  _resetRateLimit('telegram');
  config.telegramBotToken = 'sync-bot';
  config.telegramDzenSyncChatId = '@dzen_sync_channel';
  config.telegramRateLimitMs = 0;
  config.features.dzenSync = true;
  let heavyPng = null;
  try {
    // 20 МБ — выше лимита Дзена (19 МБ запас в коде). Создаём через truncate,
    // чтобы не заполнять буфер нулями.
    const dir = await mkdtemp(path.join(tmpdir(), 'nca-dzen-heavy-'));
    heavyPng = path.join(dir, 'heavy.png');
    await writeFile(heavyPng, Buffer.alloc(1)); // создать файл
    const { truncate } = await import('node:fs/promises');
    await truncate(heavyPng, 20 * 1024 * 1024);

    const json = { social: { yandex_dzen: { title: 'T', draft: 'D' } } };
    const result = await publishToDzenSync(json, heavyPng);
    assert.equal(result.attachmentType, 'text', 'тяжёлое фото → текстовый пост');
    assert.equal(result.method, 'sendMessage');
    assert.ok(!calls.some((u) => u.includes('sendPhoto')), 'sendPhoto не должен вызываться');
    assert.ok(calls.some((u) => u.includes('sendMessage')), 'sendMessage должен быть вызван');
  } finally {
    config.telegramBotToken = savedBot;
    config.telegramDzenSyncChatId = savedChat;
    config.telegramRateLimitMs = savedRate;
    config.features.dzenSync = savedFeatures;
    restore();
    srv.close();
    if (heavyPng) await rm(path.dirname(heavyPng), { recursive: true, force: true });
  }
});
