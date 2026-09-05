// tests/adapter-eexist.test.mjs
// Регресс на TDZ-баг в src/adapter.js:adaptArticle.
//
// До фикса `usage` объявлялся ПОСЛЕ блока existsSync. Если при втором вызове
// adaptArticle с тем же meta файл уже существовал — функция возвращалась из
// середины блока через `return { ... usage }`, и JS бросал
// `ReferenceError: Cannot access 'usage' before initialization`.
//
// Этот тест повторно вызывает adaptArticle с тем же meta и проверяет:
//   1) второй вызов не падает;
//   2) результат содержит usage (числа токенов), а не undefined;
//   3) на диске создаются posts/<slug>.json и posts/<slug>-(2).json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adaptArticle } from '../src/adapter.js';
import { config } from '../src/config.js';

/**
 * Мок fetchFn для callOllama: на каждый вызов Ollama возвращает валидный JSON.
 * Считает вызовы, чтобы адаптер сделал ровно 2 этапа (summary + social) на статью.
 */
function makeOllamaMock() {
  let calls = 0;
  return {
    calls: () => calls,
    fetchFn: async () => {
      calls++;
      // summary-этап: плоский JSON. social-этап: обёрнут в social.
      const body = calls % 2 === 1
        ? JSON.stringify({
            summary: {
              title: 'Заголовок',
              main_point: 'Главная мысль',
              why_it_matters: 'Почему важно',
              facts_used: ['факт 1'],
            },
            image_prompt: 'a cat',
          })
        : JSON.stringify({
            social: {
              telegram: { title: 'tg', draft: 'draft', cta: 'cta' },
              vk: { title: 'vk', draft: 'draft', cta: 'cta' },
              yandex_dzen: { title: 'dzen', description: 'd', draft: 'draft', tags: ['ai'] },
              site_blog: { h1: 'h1', meta_description: 'm', draft: 'draft', cta: 'cta' },
            },
          });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: body } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

test('adaptArticle: повторный вызов с тем же meta → -(2).json без TDZ-ошибки', async () => {
  // Изолированные каталоги, чтобы не зависеть от реального ./posts и ./sessions.
  const root = mkdtempSync(path.join(tmpdir(), 'adapter-eexist-'));
  const postsDir = path.join(root, 'posts');
  const sessionsDir = path.join(root, 'sessions');
  const day = path.join(sessionsDir, '2026-08-23');
  mkdirSync(day, { recursive: true });
  mkdirSync(postsDir, { recursive: true });

  // Подменяем путь для постов на время теста (config — singleton, env уже не поможет).
  const prevPostsDir = config.postsDir;
  Object.defineProperty(config, 'postsDir', { value: postsDir, writable: true, configurable: true });

  try {
    // Сессионная «статья 1» с фиктивным текстом.
    writeFileSync(path.join(day, 'article-1.txt'),
      '---\ntitle: dup\nurl: https://example.com/dup-test\n---\nТело статьи для теста.');

    const mock = makeOllamaMock();
    const meta = {
      title: 'dup-test article',
      url: 'https://example.com/dup-test',
      published_at: '2026-08-23T15:00:00.000Z',
    };

    // Первый вызов — создаст posts/...dup-test-social-content.json.
    const r1 = await adaptArticle(1, day, meta, { fetchFn: mock.fetchFn });
    assert.ok(r1?.json, 'первый вызов: json есть');
    assert.ok(r1.usage && typeof r1.usage.total_tokens === 'number',
      'первый вызов: usage с числами токенов');

    // Второй вызов с тем же meta — должен положить рядом -(2).json, а НЕ упасть
    // с ReferenceError на TDZ-переменной usage.
    const r2 = await adaptArticle(1, day, meta, { fetchFn: mock.fetchFn });
    assert.ok(r2?.json, 'второй вызов: json есть (не упал на TDZ)');
    assert.ok(r2.usage && typeof r2.usage.total_tokens === 'number',
      'второй вызов: usage тоже материализован (не undefined)');

    const files = readdirSync(postsDir).filter((f) => f.includes('dup-test')).sort();
    assert.deepEqual(files, [
      '2026-08-23-news-example-com-dup-test-article-social-content-(2).json',
      '2026-08-23-news-example-com-dup-test-article-social-content.json',
    ], 'на диске должно быть два файла: -(2) и оригинал');
  } finally {
    Object.defineProperty(config, 'postsDir', { value: prevPostsDir, writable: true, configurable: true });
    rmSync(root, { recursive: true, force: true });
  }
});