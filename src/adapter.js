// src/adapter.js
// Двухэтапный вызов Ollama Cloud: summary (Flash) → social (Pro).
//
// Особенности:
//   - JSON из ответа извлекаем через сбалансированный парсер (ищет парные {...}
//     с учётом строк/escape), а не регуляркой, чтобы не выхватывать обрезанные
//     «хвосты» рассуждений модели.
//   - max_tokens увеличен до 16 384 на социальном этапе (длинные тексты для
//     site_blog + yandex_dzen могут не уместиться в 8k).
//   - Ретраи: единый контракт через retryWithBackoff (./retry.js).
//     tryCallOllama делает ОДНУ попытку и помечает ошибки:
//       retryable=true  → HTTP 429/5xx, сетевые, невалидный JSON, no content;
//       retryable=false → 4xx (кроме 429), API-ошибки (data.error).
//     callOllama оборачивает tryCallOllama в retryWithBackoff (3 повтора,
//     baseMs=2000, factor=2.5 → ~2с, 5с, 12.5с) и отдельно ветвится
//     на finish_reason=length (рекурсия с ×2 maxTokens, потолок 32k).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { buildPostFilename } from './parser.js';
import { fetchWithTimeout } from './http.js';
import { retryWithBackoff } from './retry.js';

const OLLAMA_API_BASE = config.OLLAMA_API_BASE || 'https://ollama.com';
const OLLAMA_API_KEY = config.OLLAMA_API_KEY;
const MODEL_SUMMARY = config.MODEL_SUMMARY || 'deepseek-v4-flash:0731';
const MODEL_SOCIAL = config.MODEL_SOCIAL || 'deepseek-v4-pro:0813';

const SUMMARY_MAX_TOKENS = 8192;
const SOCIAL_MAX_TOKENS = 12_288;

// System-роль: глобальный запрет на рассуждения и обёртки.
// DeepSeek-V3/V4 сильно уважают system-роль и при низкой temperature
// почти не уходят в "let me think step by step".
const NO_REASONING_SYSTEM_PROMPT = [
  'Ты — формальный JSON-генератор.',
  'СТРОГИЕ ПРАВИЛА:',
  '1) Ответ — это ОДИН валидный JSON-объект. Никаких пояснений до или после.',
  '2) Запрещены: markdown (```), префиксы типа "Here is", хвосты типа "Note:", <think>-блоки.',
  '3) Любой текст вне JSON считается ошибкой и приведёт к отказу.',
  '4) Если не уверен в данных — всё равно верни JSON с минимально осмысленными полями.',
].join('\n');

/**
 * Достаёт из произвольного текста валидный JSON-объект.
 * Сначала пробует распарсить весь текст как JSON. Если не вышло — ищет
 * сбалансированные {...} на верхнем уровне (с учётом кавычек и escape-последовательностей)
 * и пробует каждый от самого длинного.
 *
 * Экспортирована для тестов; в проде не вызывается напрямую.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function extractJSON(text) {
  if (!text) return null;
  // 1) Весь текст — валидный JSON (идеал)
  try {
    return JSON.parse(text);
  } catch {
    /* fallthrough */
  }

  // 2) Сбалансированный поиск кандидатов: идём по символам `{`,
  //    для каждого ищем парную `}` с учётом строк/escape.
  //    Сохраняем только пары верхнего уровня (depth=0), чтобы вложенные
  //    объекты не попали в кандидаты.
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          i = j; // прыгаем за найденный блок, чтобы не итерироваться внутри
          break;
        }
      }
    }
  }

  // 3) Пробуем с конца (самый поздний кандидат — обычно это финальный JSON,
  //    а не «кусок рассуждения» в начале).
  for (let k = candidates.length - 1; k >= 0; k--) {
    try {
      return JSON.parse(candidates[k]);
    } catch {
      /* try previous */
    }
  }
  return null;
}

/**
 * Делает ОДНУ попытку вызова Ollama Cloud /v1/chat/completions.
 * Без ретраев внутри — повторы оборачиваются снаружи через retryWithBackoff
 * (см. callOllama). Это позволяет соблюсти «единый контракт ретраев»:
 *  - retryable=true → повторять (5xx, 429, сетевые, невалидный JSON, no content);
 *  - retryable=false → пробрасывать сразу (4xx кроме 429, API-ошибки).
 *
 * Спец-случай: finish_reason=length → возвращает { truncated:true, raw:content }
 * (НЕ ошибка). Вызывающая сторона ловит этот sentinel и рекурсивно вызывает
 * себя с увеличенным maxTokens — это не ретрай, а отдельный ветвящийся путь.
 *
 * Экспортирована для тестов.
 *
 * @param {string} model
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]
 * @param {function} [opts.fetchFn] — заменяемый fetch (для тестов). По умолчанию
 *   fetchWithTimeout из http.js.
 * @returns {Promise<{value:object, usage:object|null} | {truncated:true, raw:string}>}
 */
export async function tryCallOllama(model, prompt, opts = {}) {
  const maxTokens = opts.maxTokens || SUMMARY_MAX_TOKENS;
  const fetchFn = opts.fetchFn || fetchWithTimeout;

  let response;
  try {
    response = await fetchFn(`${OLLAMA_API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OLLAMA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: NO_REASONING_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    }, { timeoutMs: 120_000 }); // 16k токенов могут генерироваться долго
  } catch (netErr) {
    const e = new Error(`network: ${netErr.message}`);
    e.retryable = true;
    throw e;
  }

  if (!response.ok) {
    let errText = '';
    try { errText = await response.text(); } catch { /* ignore */ }
    const e = new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
    // 429 и 5xx — повторяемые; остальные 4xx — фатальные.
    e.retryable = response.status === 429 || response.status >= 500;
    // На 429 Ollama пока не отдаёт retry_after — оставляем generic retryable=true.
    throw e;
  }

  let data;
  try {
    data = await response.json();
  } catch (parseErr) {
    const e = new Error(`bad JSON в ответе: ${parseErr.message}`);
    e.retryable = true;
    throw e;
  }

  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    // API-ошибка (например, неизвестная модель) — фатально, ретрай не поможет.
    const e = new Error(`API error: ${msg}`);
    throw e;
  }

  const message = data.choices?.[0]?.message || {};
  let content = message.content || '';
  if (!content && message.reasoning) {
    content = message.reasoning;
    log('warn', `[callOllama] ${model}: пустой content, fallback на reasoning`);
  }
  if (!content) {
    const e = new Error('No content');
    e.retryable = true;
    throw e;
  }

  const finishReason = data.choices?.[0]?.finish_reason;
  if (finishReason === 'length') {
    // Модель уперлась в лимит токенов — JSON почти наверняка обрезан.
    // Это НЕ ретрай, а сигнал «увеличь maxTokens». Возвращаем sentinel,
    // а callOllama ловит его и рекурсивно дёргает себя с большим лимитом.
    return { truncated: true, raw: content };
  }

  const parsed = extractJSON(content);
  if (!parsed) {
    const e = new Error('No valid JSON');
    e.retryable = true;
    e.tail = content.slice(-400);
    throw e;
  }
  // Захватываем usage (токены) — для отчёта по стоимости/объёму в O1.
  const usage = data.usage || null;
  return { value: parsed, usage };
}

/**
 * Вызов Ollama Cloud /v1/chat/completions с ретраями через retryWithBackoff.
 *
 * Контракт:
 *   - На 4xx (кроме 429), API-ошибках — пробрасывается сразу (не retryable).
 *   - На 429/5xx, сетевых, невалидном JSON, пустом content — ретрай через
 *     retryWithBackoff (~2с, 5с, 12.5с при retries=3, baseMs=2000, factor=2.5).
 *   - На finish_reason=length — рекурсивный повтор с увеличенным maxTokens
 *     (×2, потолок 32k). Это не ретрай, а ветвящийся путь: сама попытка
 *     вернёт sentinel, и callOllama ловит его вне retryWithBackoff.
 *
 * @param {string} model
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.maxTokens]
 * @param {function} [opts.fetchFn] — заменяемый fetch (для тестов). Пробрасывается в tryCallOllama.
 * @returns {Promise<object>} распарсенный JSON из ответа модели
 */
export async function callOllama(model, prompt, opts = {}) {
  const maxTokens = opts.maxTokens || SUMMARY_MAX_TOKENS;

  const result = await retryWithBackoff(
    () => tryCallOllama(model, prompt, { ...opts, maxTokens }),
    { retries: 3, baseMs: 2000, factor: 2.5, label: `callOllama:${model}` },
  );

  // Sentinel: модель упёрлась в лимит токенов. Рекурсивно дёргаем себя
  // с увеличенным maxTokens (×2, потолок 32_000).
  if (result && result.truncated) {
    const newMax = Math.min(maxTokens * 2, 32_000);
    if (newMax > maxTokens) {
      log('warn', `[callOllama] ${model}: finish_reason=length, повтор с max_tokens=${newMax}`);
      return callOllama(model, prompt, { ...opts, maxTokens: newMax });
    }
    // Дальше увеличивать некуда — JSON в любом случае обрезан, но
    // попробуем всё же вытащить хоть что-то (best effort).
    log('warn', `[callOllama] ${model}: finish_reason=length при max_tokens=${maxTokens}, парсим обрезанный контент`);
    const parsed = extractJSON(result.raw);
    if (parsed) {
      return { value: parsed, usage: null };
    }
  }

  return result;
}

/**
 * Читает текст статьи из файла сессии (метаданные отрезаются по шапке ---).
 */
async function readArticleText(sessionDir, articleId) {
  const filePath = path.join(sessionDir, `article-${articleId}.txt`);
  let content;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Не удалось прочитать файл ${filePath}: ${err.message}`);
  }
  const match = content.match(/---\n[\s\S]*?\n---\n([\s\S]*)/);
  return (match ? match[1] : content).trim();
}

/** Промпт для этапа 1 (summary) */
function buildSummaryPrompt(articleText, meta) {
  return `Сгенерируй JSON по схеме ниже на основе статьи.

СХЕМА:
{
  "summary": {
    "title": "краткий заголовок на русском (≤ 80 символов)",
    "main_point": "главная мысль в 1-2 предложениях на русском",
    "why_it_matters": "почему это важно — 1 предложение на русском",
    "facts_used": ["факт 1", "факт 2", "факт 3"]
  },
  "image_prompt": "detailed English prompt for image generation, no text on image, no logos"
}

ВХОДНЫЕ ДАННЫЕ:
Заголовок исходника: ${meta.title}
Текст статьи:
${articleText.slice(0, 6000)}

Верни ровно один валидный JSON-объект.`;
}

/** Промпт для этапа 2 (social-блоки) */
function buildSocialPrompt(meta, summary) {
  return `Сгенерируй JSON для четырёх площадок на основе source + summary.

СХЕМА (ровно одно поле "social"):
- social.telegram:       { title, draft, cta }   — draft ≤ 950 символов (лимит Telegram 1024)
- social.vk:             { title, draft, cta }   — draft заканчивается 3-5 хэштегами
- social.yandex_dzen:    { title, description, draft, tags }
    title ≤ 80 символов (заголовок Дзена = первое предложение поста, лимит 140)
    description ≤ 60 символов (1 короткое предложение-лид)
    draft 700-850 символов, СТРОГО НЕ БОЛЬШЕ 850 — ПОЛНЫЙ смысл статьи, структурированный:
      - 3-4 подзаголовка как ОТДЕЛЬНЫЕ строки (без HTML-тегов и markdown-символов)
      - короткие абзацы по 2-3 предложения
      - если текст длиннее 850 — сократи, сохранив смысл и структуру
- social.site_blog:      { h1, meta_description, draft, cta }   — draft 2000-4000 символов, SEO-friendly

Тон: экспертный, без кликбейта и хайпа. Язык: русский.

ВХОДНЫЕ ДАННЫЕ:
source: ${JSON.stringify(meta)}
summary: ${JSON.stringify(summary)}

Верни ровно один валидный JSON-объект.`;
}

/**
 * Обрезает draft Дзена до лимита по границе предложения (не на пол фразы).
 * Страховка от превышения лимита caption 1024 моделью: даже если LLM выдала
 * draft длиннее лимита, обрезка не оставит обрыв посреди предложения/абзаца.
 *
 * @param {string} draft
 * @param {number} limit
 * @returns {string}
 */
function trimDraftToLimit(draft, limit) {
  if (draft.length <= limit) return draft;
  const cut = draft.slice(0, limit);
  // 1) Граница предложения — последний знак конца предложения перед лимитом.
  const lastSentence = Math.max(
    cut.lastIndexOf('.'),
    cut.lastIndexOf('!'),
    cut.lastIndexOf('?'),
    cut.lastIndexOf('…'),
  );
  if (lastSentence > limit * 0.5) return cut.slice(0, lastSentence + 1).trimEnd();
  // 2) Граница абзаца.
  const lastNl = cut.lastIndexOf('\n');
  if (lastNl > limit * 0.5) return cut.slice(0, lastNl).trimEnd();
  return cut.trimEnd();
}

/**
 * Адаптирует одну статью: этап 1 (summary) + этап 2 (social) → posts/<filename>.json
 *
 * Имя файла — YYYY-MM-DD-news-<slug>-social-content.json
 * (формируется в parser.js → buildPostFilename).
 *
 * @param {number} articleId
 * @param {string} sessionDir
 * @param {{title:string,url:string,published_at:string}} meta
 * @param {object} [opts]
 * @param {function} [opts.fetchFn] — заменяемый fetch (для тестов).
 *   Пробрасывается в оба вызова Ollama (summary + social).
 * @returns {Promise<{json: object, postPath: string, postFilename: string}>}
 *          Возвращаем и сам json, и абсолютный путь — чтобы scheduler мог
 *          обновить image_path в том же файле.
 */
export async function adaptArticle(articleId, sessionDir, meta, opts = {}) {
  log('info', `[adapter] Адаптация статьи ${articleId}: ${meta.title}`);

  const articleText = await readArticleText(sessionDir, articleId);
  if (!articleText) {
    throw new Error(`Текст статьи ${articleId} пуст или не найден`);
  }

  // Этап 1: summary
  log('info', `[adapter] Этап 1 (summary) — ${MODEL_SUMMARY}`);
  const stage1 = await callOllama(MODEL_SUMMARY, buildSummaryPrompt(articleText, meta), opts);
  const s1 = stage1.value;
  if (!s1?.summary || !s1?.image_prompt) {
    throw new Error('Stage 1: модель не вернула summary или image_prompt');
  }
  log('info', `[adapter] Summary: "${s1.summary.title}"`);

  // Этап 2: social
  log('info', `[adapter] Этап 2 (social) — ${MODEL_SOCIAL}`);
  const stage2 = await callOllama(MODEL_SOCIAL, buildSocialPrompt(meta, s1.summary), {
    ...opts,
    maxTokens: SOCIAL_MAX_TOKENS,
  });
  const s2 = stage2.value;
  if (!s2?.social) {
    log('error', `Stage 2 result: ${JSON.stringify(s2).slice(0, 800)}`);
    throw new Error('Stage 2: модель не вернула social');
  }

  // Пост-обработка Дзен-текста: модель может превысить лимит caption (1024).
  // Обрезаем draft до безопасного объёма по границе предложения, чтобы
  // title+description+draft гарантированно укладывались в caption.
  const DZEN_DRAFT_LIMIT = 850;
  if (s2.social?.yandex_dzen?.draft) {
    s2.social.yandex_dzen.draft = trimDraftToLimit(s2.social.yandex_dzen.draft, DZEN_DRAFT_LIMIT);
  }

  const json = {
    schema_version: 'content-adaptor/v2',
    source: meta,
    summary: s1.summary,
    image_prompt: s1.image_prompt,
    image_path: null,
    social: s2.social,
  };

  await fs.mkdir(config.postsDir, { recursive: true });
  const filename = buildPostFilename(meta);
  const postPath = path.join(config.postsDir, filename);

  // Суммарный usage (токены) по двум этапам — для отчёта по стоимости.
  // Считаем заранее, до ветки existsSync: иначе на коллизии имён вернёмся из
  // середины блока и обратимся к usage до его объявления (TDZ → ReferenceError).
  const usage = sumUsage(stage1.usage, stage2.usage);
  if (usage) log('info', `[adapter] Токены: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);

  // Теоретически коллизий быть не должно (buildPostFilename включает hostSlug,
  // см. B8), но защитимся от EEXIST: на повторе дописываем -(2), -(3), ...
  // Сначала — быстрый existsSync + warning, чтобы было видно в логе, если
  // кто-то вызывает адаптер с одинаковым meta повторно.
  if (fsSync.existsSync(postPath)) {
    log('warn', `[adapter] Файл ${postPath} уже существует — будет добавлен суффикс -(N). Это индикатор коллизии имён (см. B8).`);
    let written = false;
    for (let n = 2; n < 1000 && !written; n++) {
      const next = postPath.replace(/(\.json)$/, `-(${n})$1`);
      try {
        // Используем wx-флаг: падает с EEXIST, если файл уже есть —
        // атомарная гонка невозможна.
        const fh = await fs.open(next, 'wx');
        try {
          await fh.writeFile(JSON.stringify(json, null, 2), 'utf-8');
        } finally {
          await fh.close();
        }
        log('info', `[adapter] JSON сохранён: ${next}`);
        return { json, postPath: next, postFilename: path.basename(next), usage };
      } catch (e) {
        if (e && e.code === 'EEXIST') continue;
        throw e;
      }
    }
    throw new Error(`[adapter] Не удалось подобрать свободное имя файла для ${postPath}`);
  }

  await fs.writeFile(postPath, JSON.stringify(json, null, 2), 'utf-8');
  log('info', `[adapter] JSON сохранён: ${postPath}`);

  return { json, postPath, postFilename: filename, usage };
}

/** Складывает usage двух вызовов; возвращает null, если обоих нет. */
function sumUsage(u1, u2) {
  if (!u1 && !u2) return null;
  const pick = (u, k) => (u && typeof u[k] === 'number') ? u[k] : 0;
  const prompt_tokens = pick(u1, 'prompt_tokens') + pick(u2, 'prompt_tokens');
  const completion_tokens = pick(u1, 'completion_tokens') + pick(u2, 'completion_tokens');
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: pick(u1, 'total_tokens') + pick(u2, 'total_tokens') || (prompt_tokens + completion_tokens),
  };
}
