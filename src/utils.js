// Утилиты общего назначения.

// Задержка выполнения на ms миллисекунд. Используется в retry / rateLimit / VK
// для экспоненциальных бэкоффов и гейтов минимального интервала между запросами.
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Парсит CSV-строку в массив непустых токенов.
 *
 * Используется для SCHEDULE_CRON (`0 8 * * *,0 15 * * *` → 2 выражения) и
 * в будущем — для любых CSV-конфигов. Логика:
 *   - null / undefined / не-строка → []
 *   - split по запятой
 *   - trim каждого токена
 *   - filter(Boolean) — выкидывает пустые сегменты (`a,,b` → `['a','b']`)
 *   - пустая строка → []
 *
 * @param {unknown} input
 * @returns {string[]}
 */
export function parseScheduleCsv(input) {
  return String(input || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Форматирует ISO-дату в локальный формат `YYYY-MM-DD HH:MM:SS`.
 *
 * Используется в preview.md и в логах для оператора, чтобы время читалось
 * без `Z`/миллисекунд/UTC-маркера.
 *
 * Поведение:
 *   - null / undefined / невалидная строка → пустая строка.
 *   - иначе — локальное время машины (а не UTC).
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * Собирает «подпись со ссылкой на оригинал» для каналов, где текст plain
 * (Telegram caption, VK message). Возвращает исходный текст без изменений,
 * если URL пустой.
 *
 *   appendSourceLink('Текст поста', 'https://example.com/foo', '🔗 Оригинал статьи')
 *   → 'Текст поста\n\n🔗 Оригинал статьи: https://example.com/foo'
 *
 * @param {string} text — исходный текст поста
 * @param {string|null|undefined} url — URL оригинала
 * @param {string} [label] — текст ссылки (по умолчанию «🔗 Оригинал статьи»)
 * @returns {string}
 */
export function appendSourceLink(text, url, label = '🔗 Оригинал статьи') {
  const base = (text || '').toString();
  if (!url) return base;
  // Гарантируем ровно один пустой разделитель абзаца (\n\n) между текстом и ссылкой.
  // Если base уже заканчивается на ≥2 переносов — не добавляем лишних.
  const sep = /\n\n$/.test(base) ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${sep}${label}: ${url}`;
}

/**
 * HTML-обёртка для ссылки на оригинал — для Site Blog (WordPress REST).
 * Безопасно экранирует href и текст.
 *
 *   appendSourceLinkHtml('<p>Текст</p>', 'https://example.com/foo', 'Оригинал')
 *   → '<p>Текст</p>\n<p><a href="https://example.com/foo" target="_blank" rel="noopener noreferrer">Оригинал</a></p>'
 *
 * @param {string} html — существующий HTML-фрагмент
 * @param {string|null|undefined} url
 * @param {string} [label]
 * @returns {string}
 */
export function appendSourceLinkHtml(html, url, label = '🔗 Оригинал статьи') {
  const base = (html || '').toString();
  if (!url) return base;
  const safeUrl = String(url).replace(/"/g, '&quot;');
  const safeLabel = String(label).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${base}\n<p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeLabel}</a></p>`;
}

/**
 * Markdown-обёртка для ссылки на оригинал — для Yandex Dzen (черновик .md).
 *
 *   appendSourceLinkMarkdown('Текст', 'https://example.com/foo', 'Оригинал')
 *   → 'Текст\n\n[Оригинал](https://example.com/foo)'
 *
 * @param {string} md
 * @param {string|null|undefined} url
 * @param {string} [label]
 * @returns {string}
 */
export function appendSourceLinkMarkdown(md, url, label = '🔗 Оригинал статьи') {
  const base = (md || '').toString();
  if (!url) return base;
  const sep = /\n\n$/.test(base) ? '' : base.endsWith('\n') ? '\n' : '\n\n';
  return `${base}${sep}[${label}](${url})`;
}

/**
 * Подбирает тематический emoji по тексту. Используется паблишерами TG/VK,
 * чтобы добавить визуальный маркер к посту.
 *
 * Правила — простые substring-match по русским и английским терминам.
 * Первое совпадение побеждает. Если ничего — fallback 🤖.
 *
 *   pickEmoji('OpenAI запустил GPT-5')        → '🚀'
 *   pickEmoji('Новый закон о приватности')    → '🔒'
 *   pickEmoji('Исследование рака с помощью ИИ') → '🧬'
 *   pickEmoji('Просто текст')                 → '🤖'
 *
 * @param {string} text
 * @returns {string}
 */
export function pickEmoji(text) {
  const t = (text || '').toLowerCase();
  if (!t) return '🤖';
  const rules = [
    { emoji: '🚀', words: ['launch', 'запуск', 'запуст', 'выпуск', 'релиз', 'анонс', 'debut', 'unveil', 'представ', 'выпуст'] },
    { emoji: '🔒', words: ['privacy', 'приват', 'безопасност', 'safety', 'surveillance', 'слежк', 'наблюден', 'encrypt'] },
    { emoji: '🧬', words: ['research', 'исследован', 'study', 'paper', 'био', 'медицин', 'health', 'наук'] },
    { emoji: '🤖', words: ['robot', 'робот', 'humanoid'] },
    { emoji: '🎮', words: ['game', 'игр', 'atari', 'gaming'] },
    { emoji: '💰', words: ['fund', 'invest', 'billion', 'млрд', 'сделк', 'acqui', 'покупк', 'стоит', 'valuation'] },
    { emoji: '⚖️', words: ['law', 'lawsuit', 'суд', 'закон', 'bill', 'регулятор', 'ban', 'запрет'] },
    { emoji: '🧠', words: ['llm', 'gpt', 'claude', 'gemini', 'модел', 'language model'] },
    { emoji: '💻', words: ['open source', 'github', 'код', 'code', 'developer', 'sdk'] },
    { emoji: '🌐', words: ['world', 'глобальн', 'global', 'international', 'международ'] },
  ];
  for (const r of rules) {
    if (r.words.some((w) => t.includes(w))) return r.emoji;
  }
  return '🤖';
}

/**
 * Префиксует заголовок поста тематическим emoji + пробелом.
 * Не трогает null/empty. Уже-эмодзизированный заголовок (начинается с известного
 * префикса emoji) оставляет как есть.
 *
 *   decorateTitle('Запуск GPT-5', '...')        → '🚀 Запуск GPT-5'
 *   decorateTitle('🚀 Запуск GPT-5', '...')     → '🚀 Запуск GPT-5' (без дубля)
 *   decorateTitle('', 'OpenAI выпустил релиз')  → '🚀 OpenAI выпустил релиз'
 *
 * @param {string} title
 * @param {string} [body] — текст/draft, по которому идёт подбор emoji, если title пуст.
 * @returns {string}
 */
export function decorateTitle(title, body = '') {
  const trimmed = (title || '').trim();
  if (trimmed) {
    // Если заголовок уже начинается с emoji (любой non-BMP или диапазон U+1F300-U+1FAFF
    // плюс прочие emoji), не дублируем.
    if (/^[\p{Extended_Pictographic}]/u.test(trimmed)) return trimmed;
    return `${pickEmoji(trimmed)} ${trimmed}`;
  }
  // Заголовок пуст — попробуем body.
  const fallback = (body || '').trim();
  if (!fallback) return '';
  // Берём только первое «предложение» body, чтобы не уйти в длинный текст.
  const head = fallback.split(/[.\n!?]/, 1)[0].trim();
  return `${pickEmoji(head)} ${head}`;
}
