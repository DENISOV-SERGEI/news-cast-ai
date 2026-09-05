// Получение, парсинг и сохранение исходных статей.
//
// Поддерживает:
//   - RSS/Atom (через rss-parser)
//   - HTML-страницы (через cheerio) — собирает заголовки + ссылки и ходит за полным текстом.
//
// Возвращает массив Article:
//   { title, url, publishedAt: Date|null, sourceText: string, lead: string }
//
// Дополнительно экспортирует persistArticles(articles) — раскладывает
//   sessions/YYYY-MM-DD/article-{1..N}.txt
//   sessions/YYYY-MM-DD/sources.json
//
// Формат .txt:
//   ---
//   title: ...
//   url: ...
//   published_at: ...
//   ---
//   <чистый текст статьи>

import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import { fetchWithSg, SG_BROWSER_UA } from './sgCaptcha.js';
import { applyFilters } from './filters.js';

// Единый UA из sgCaptcha.js: SiteGround-капча привязывает cookie `_I_` к UA,
// под которым решён challenge, поэтому все fetch-запросы обязаны использовать
// тот же UA, что и headless-браузер при решении капчи.
const USER_AGENT = SG_BROWSER_UA;
const FETCH_TIMEOUT_MS = 15_000;
const ARTICLE_CONCURRENCY = 3;

const rss = new Parser({
  headers: { 'User-Agent': USER_AGENT },
  timeout: FETCH_TIMEOUT_MS,
});

function looksLikeFeed(url) {
  return /\.(rss|xml|atom)(\?|$)/i.test(url) || /\/feed\/?(\?|$)/i.test(url);
}

function parseDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchHtml(url) {
  // Идём через sgCaptcha-обёртку: если хост на SiteGround, она сама пройдёт
  // JS-challenge (один раз, потом — с кэшированным cookie) и вернёт текст.
  return await fetchWithSg(
    url,
    { headers: { 'User-Agent': USER_AGENT } },
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
}

// --- RSS / Atom ---
async function parseFeed(url) {
  // Благодаря fetchWithSg фиды с SiteGround-капчей тоже доходят (см. выше).
  // rss-parser получает готовую XML-строку (свой HTTP он использует только
  // в parseURL, который мы заменяем на нашу обёртку).
  const xml = await fetchWithSg(
    url,
    { headers: { 'User-Agent': USER_AGENT } },
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  const feed = await rss.parseString(xml);
  return (feed.items || []).map((item) => {
    const link = item.link || item.guid || '';
    const title = (item.title || '').trim() || '(без заголовка)';
    const publishedAt = parseDateSafe(item.isoDate || item.pubDate || item.published);
    const lead = (item.contentSnippet || item.summary || '').replace(/\s+/g, ' ').trim();
    return {
      title,
      url: link,
      publishedAt,
      sourceText: lead,
      lead,
    };
  });
}

// Селекторы, внутри которых ищем ссылки на статьи.
// ВАЖНО: более специфичные идут первыми. Общий `article a[href]` намеренно в самом
// конце — он подхватывает всё подряд (включая ссылки на теги, автора, обёртки
// картинок) и без фильтра на длину текста засоряет `seen` ещё до того, как
// отработают точечные селекторы типа `.item-title a[href]`.
const ARTICLE_LINK_SELECTORS = [
  '.item-title a[href]',                  // zerocoder
  'article.type-post .item-title a[href]',
  '.entry-title a[href]',
  '.post-title a[href]',
  'h2 a[href]',
  'h3 a[href]',
  // Общий fallback — все ссылки внутри <article>. Применяется последним и
  // отсекается через минимальную длину заголовка (≥ 20 символов).
  'article a[href]',
];

// Служебные «slug»-сегменты, которые НЕ являются статьями.
const NON_ARTICLE_SLUGS = new Set([
  'avtory', 'author', 'authors',
  'kontakty', 'contact', 'contacts',
  'o-nas', 'about',
  'politika-konfidencialnosti', 'privacy-policy',
  'usloviya-ispolzovaniya', 'terms-of-use', 'terms',
  'poisk', 'search',
  'login', 'register', 'signup',
  'wp-admin', 'wp-login.php',
  'feed', 'rss', 'sitemap', 'sitemap.xml',
]);

/**
 * Эвристика: ссылка выглядит как ссылка на статью (НЕ на служебные страницы).
 * Должна вести на тот же хост, что и листинг, не содержать wp-/служебных путей,
 * иметь слаг формата «буквы/цифры/дефисы» и не попадать в NON_ARTICLE_SLUGS.
 */
function looksLikeArticleUrl(absUrl, listingUrl) {
  if (absUrl === listingUrl) return false;
  let u;
  try { u = new URL(absUrl); } catch { return false; }
  if (u.hash) return false;

  // Тот же хост, что у листинга (иначе это внешняя ссылка из шапки/футера).
  try {
    const listingOrigin = new URL(listingUrl).origin;
    if (u.origin !== listingOrigin) return false;
  } catch {
    return false;
  }

  if (/\/(tag|author|category|wp-content|wp-json|feed|page)\//i.test(u.pathname)) return false;
  if (u.pathname === '/' || u.pathname === '') return false;

  const segments = u.pathname.split('/').filter(Boolean);
  // Должен быть хотя бы один сегмент-слаг (буквы/дефисы/цифры, длина ≥ 3).
  const slug = segments[segments.length - 1] || '';
  if (!/^[a-z0-9][a-z0-9-]{2,}$/i.test(slug)) return false;
  if (NON_ARTICLE_SLUGS.has(slug.toLowerCase())) return false;
  return true;
}

// --- Фильтр свежести ---
// Возвращает:
//   'fresh'      — published_at есть и попадает в окно
//   'no_date'    — published_at нет (обрабатывается отдельно)
//   'stale'      — published_at старше окна, отбрасываем
//
// Экспортируется, чтобы тесты могли проверить чистую классификацию
// без подъёма HTTP-моков.
export function classifyFreshness(publishedAt, windowDays) {
  if (!publishedAt) return 'no_date';
  const ageMs = Date.now() - publishedAt.getTime();
  if (ageMs < 0) return 'fresh'; // будущая дата — ок
  if (!windowDays || windowDays <= 0) return 'fresh'; // фильтр выключен
  const limit = windowDays * 24 * 60 * 60 * 1000;
  return ageMs <= limit ? 'fresh' : 'stale';
}

/**
 * Специальная ошибка — нет свежих статей. scheduler.js ловит её
 * и завершает прогон штатно (не как фатальную).
 */
export class NoFreshArticlesError extends Error {
  constructor(total) {
    super(`Нет свежих статей (всего в источнике: ${total})`);
    this.name = 'NoFreshArticlesError';
    this.code = 'NO_FRESH_ARTICLES';
  }
}

/**
 * Возвращает true, если элемент <a> лежит внутри навигационного блока
 * (header/footer/nav), — такие ссылки пропускаем, чтобы не ловить меню.
 */
function isInNavBlock($, el) {
  return $(el).closest('header, footer, nav, .site-header, .site-footer, .menu, .navbar').length > 0;
}

/**
 * Универсальный fallback для сайтов, где у карточек нет типовых классов:
 * группируем все внутренние ссылки по href и оставляем те, что встречаются
 * 2+ раз (как правило — thumbnail + заголовок одной и той же карточки).
 * Возвращает { title, url, publishedAt } для уникальных href'ов.
 */
function extractArticleLinksByPairs($, listingUrl, baseHost) {
  const groups = new Map(); // href -> { count, text, time }

  $('a[href]').each((_, el) => {
    if (isInNavBlock($, el)) return; // навигация — пропускаем без мутации DOM
    const $a = $(el);
    const href = $a.attr('href');
    if (!href) return;
    let abs;
    try {
      abs = new URL(href, baseHost || listingUrl).toString();
    } catch {
      return;
    }
    if (!looksLikeArticleUrl(abs, listingUrl)) return;

    const text = $a.text().replace(/\s+/g, ' ').trim();
    const $time = $a.closest('article, li, div').find('time[datetime]').first();
    const time = $time.attr('datetime') || null;

    const cur = groups.get(abs) || { count: 0, text: '', time: null };
    cur.count += 1;
    if (text.length > cur.text.length) cur.text = text;
    if (!cur.time && time) cur.time = time;
    groups.set(abs, cur);
  });

  const out = [];
  for (const [abs, info] of groups.entries()) {
    out.push({
      title: info.text,
      url: abs,
      publishedAt: parseDateSafe(info.time),
      sourceText: '',
      lead: '',
      _pairCount: info.count,
    });
  }
  return out;
}

// --- HTML: листинг -> ссылки на статьи ---
function extractArticleLinksFromListing($, listingUrl) {
  const baseHost = (() => {
    try { return new URL(listingUrl).origin; } catch { return ''; }
  })();
  const seen = new Set();
  const out = [];

  // 1) Стандартный путь — ищем ссылки внутри типовых контейнеров карточек.
  for (const sel of ARTICLE_LINK_SELECTORS) {
    const isGeneric = sel === 'article a[href]'; // самый широкий селектор — последний
    $(sel).each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href');
      if (!href) return;
      let abs;
      try {
        abs = new URL(href, baseHost || listingUrl).toString();
      } catch {
        return;
      }
      if (!looksLikeArticleUrl(abs, listingUrl)) return;
      if (seen.has(abs)) return;

      const $parent = $a.closest('article, li, div');
      const $time = $parent.find('time[datetime]').first();
      const publishedAt = parseDateSafe($time.attr('datetime'));

      const title = $a.text().replace(/\s+/g, ' ').trim();
      if (!title) return;

      // Для самого общего селектора требуем «длинный» заголовок (≥ 20 символов) —
      // это отсекает короткие ссылки на теги, автора, соцсети, пункты меню.
      if (isGeneric && title.length < 20) return;

      seen.add(abs);
      out.push({ title, url: abs, publishedAt, sourceText: '', lead: '' });
    });
  }

  // 2) Fallback: парный сбор, если стандартные селекторы дали мало (или ничего).
  //    Берём «парные» ссылки (встречаются 2+ раз) + добиваем одиночными до 10.
  if (out.length < 3) {
    const pairs = extractArticleLinksByPairs($, listingUrl, baseHost);
    const paired = pairs.filter((p) => p._pairCount >= 2 && !seen.has(p.url));
    const singles = pairs.filter((p) => p._pairCount === 1 && !seen.has(p.url));

    for (const p of paired) {
      seen.add(p.url);
      out.push({ title: p.title, url: p.url, publishedAt: p.publishedAt, sourceText: '', lead: '' });
    }
    for (const p of singles) {
      if (out.length >= 10) break;
      seen.add(p.url);
      out.push({ title: p.title, url: p.url, publishedAt: p.publishedAt, sourceText: '', lead: '' });
    }
  }

  return out;
}

// --- HTML: полный текст одной статьи ---
function extractArticleBody($, _url) {
  const candidates = ['article', 'main article', 'main', '.post-content', '.entry-content', '#content'];
  let bestText = '';
  for (const sel of candidates) {
    const $node = $(sel).first();
    if (!$node.length) continue;
    const text = $node.text().replace(/\s+/g, ' ').trim();
    if (text.length > bestText.length) bestText = text;
  }
  const paragraphs = $('article p, main p, .post-content p')
    .map((_, p) => $(p).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter((t) => t.length > 30)
    .slice(0, 3)
    .join('\n\n');
  if (paragraphs && paragraphs.length > bestText.length) bestText = paragraphs;
  return bestText;
}

async function parseHtmlListing(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  return extractArticleLinksFromListing($, url);
}

async function fetchArticleBody(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const text = extractArticleBody($, url);
    return text;
  } catch (e) {
    log('warn', `Не удалось получить текст статьи ${url}: ${e.message}`);
    return '';
  }
}

// Ограничиваем параллельность
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Главная функция модуля ---
/**
 * Внутренняя часть: загрузка и нормализация карточек источника
 * (без фильтра свежести). Возвращает валидные статьи и общее число
 * карточек до фильтра.
 */
async function _loadArticles(url) {
  log('info', `Получаю источник: ${url}`);
  let listing;
  if (looksLikeFeed(url)) {
    listing = await parseFeed(url);
  } else {
    listing = await parseHtmlListing(url);
  }
  log('info', `Найдено карточек: ${listing.length}`);

  const withBodies = await mapWithLimit(listing, ARTICLE_CONCURRENCY, async (item) => {
    if (item.sourceText && item.sourceText.length > 200) {
      return { ...item, sourceText: item.sourceText };
    }
    const body = await fetchArticleBody(item.url);
    return {
      ...item,
      sourceText: body || item.lead || item.title,
    };
  });

  const valid = withBodies.filter((a) => (a.title && a.url) || a.sourceText);
  log('info', `После фильтрации: ${valid.length}`);
  return valid;
}

/**
 * Применяет фильтр свежести к массиву статей и возвращает
 * { articles, stats: { fresh, stale, noDate } }.
 *
 * Правила:
 *   - 'no_date' отбрасывается ВСЕГДА (B6: риск дубликатов, см. отчёт).
 *   - 'stale'  отбрасывается, только если windowDays > 0.
 *   - 'fresh'  проходит.
 */
function _applyFreshnessFilter(articles, windowDays) {
  const stats = { fresh: 0, stale: 0, noDate: 0 };
  const kept = [];
  for (const a of articles) {
    const k = classifyFreshness(a.publishedAt, windowDays);
    if (k === 'no_date') {
      stats.noDate++;
    } else if (k === 'stale') {
      stats.stale++;
    } else {
      stats.fresh++;
      kept.push(a);
    }
  }
  log('info', `Свежесть (окно ${windowDays} дн.): свежих=${stats.fresh}, устаревших=${stats.stale}, без даты=${stats.noDate}`);
  if (stats.noDate > 0) {
    log('warn', `Отброшено ${stats.noDate} статей без published_at (риск дубликатов для новостного канала)`);
  }
  return { articles: kept, stats };
}

/**
 * Парсит один источник и возвращает только свежие статьи (Article[]).
 * Статьи без published_at и устаревшие — отбрасываются (B6).
 * Бросает NoFreshArticlesError, если после фильтра свежести ничего не осталось.
 */
export async function fetchAndParse(url) {
  const valid = await _loadArticles(url);
  const { articles: fresh } = _applyFreshnessFilter(valid, config.freshWindowDays);
  if (fresh.length === 0) {
    throw new NoFreshArticlesError(valid.length);
  }
  return fresh;
}

/**
 * То же, что fetchAndParse, но возвращает ещё и счётчики фильтра свежести
 * и пре-адаптационных фильтров (source blocklist / title stopwords).
 * Используется scheduler.js для прокидывания метрик в runs.json (B5).
 *
 * Пре-адаптационные фильтры применяются ДО классификации свежести:
 * это гарантирует, что мусорный домен не «проскочит» даже как no_date.
 *
 * @param {string} url
 * @returns {Promise<{ articles: Article[], stats: { fresh: number, stale: number, noDate: number, sourceBlocked: number, stopwordFiltered: number }, total: number }>}
 */
export async function parseWithStats(url) {
  const valid = await _loadArticles(url);
  // Пре-адаптационная фильтрация: до того, как статьи попадут в Ollama.
  const filtered = applyFilters(valid, {
    sourceBlocklist: config.sourceBlocklist,
    titleStopwords: config.titleStopwords,
  });
  if (filtered.dropped.bySource > 0 || filtered.dropped.byStopword > 0) {
    log('info', `Фильтры: source=${filtered.dropped.bySource} stopword=${filtered.dropped.byStopword} из ${valid.length}`);
  }
  const { articles, stats } = _applyFreshnessFilter(filtered.kept, config.freshWindowDays);
  if (articles.length === 0) {
    throw new NoFreshArticlesError(valid.length);
  }
  return {
    articles,
    stats: {
      ...stats,
      sourceBlocked: filtered.dropped.bySource,
      stopwordFiltered: filtered.dropped.byStopword,
    },
    total: valid.length,
  };
}

/**
 * Параллельно обходит несколько источников, объединяет результаты,
 * сортирует по publishedAt desc. Ошибки одного источника не валят остальные.
 *
 * @param {string[]} sources
 * @returns {Promise<Article[]>}
 */
export async function fetchAndParseAll(sources) {
  const { articles } = await parseAllWithStats(sources);
  return articles;
}

/**
 * Многопоточный вариант со счётчиками. Суммирует fresh/stale/noDate по всем
 * источникам (B5), плюс счётчики пре-адаптационных фильтров.
 *
 * Пре-адаптационные фильтры (source blocklist / title stopwords) применяются
 * ПОСЛЕ объединения и дедупа по URL, но ДО финальной сортировки — так фильтр
 * работает поверх уже уникальных карточек.
 */
export async function parseAllWithStats(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('parseAllWithStats: пустой массив источников');
  }
  if (sources.length === 1) return parseWithStats(sources[0]);

  log('info', `Получаю ${sources.length} источников параллельно`);
  const results = await Promise.allSettled(sources.map((url) => parseWithStats(url)));

  const merged = [];
  const bySource = [];
  const stats = { fresh: 0, stale: 0, noDate: 0, sourceBlocked: 0, stopwordFiltered: 0 };
  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      log('info', `  [${i + 1}/${sources.length}] ${sources[i]}: ${v.articles.length} свежих`);
      bySource.push({ url: sources[i], count: v.articles.length });
      stats.fresh += v.stats.fresh;
      stats.stale += v.stats.stale;
      stats.noDate += v.stats.noDate;
      stats.sourceBlocked += v.stats.sourceBlocked || 0;
      stats.stopwordFiltered += v.stats.stopwordFiltered || 0;
      total += v.total;
      for (const a of v.articles) merged.push(a);
    } else if (r.reason instanceof NoFreshArticlesError) {
      // Источник дал 0 свежих — это не фатально для multi-source,
      // но логируем как warn для прозрачности.
      log('info', `  [${i + 1}/${sources.length}] ${sources[i]}: 0 свежих (${r.reason.message})`);
      bySource.push({ url: sources[i], count: 0 });
    } else {
      log('warn', `  [${i + 1}/${sources.length}] ${sources[i]}: ОШИБКА — ${r.reason?.message || r.reason}`);
      bySource.push({ url: sources[i], count: 0, error: r.reason?.message || String(r.reason) });
    }
  }

  if (merged.length === 0) {
    // Ни один источник не дал свежих статей — бросаем, чтобы scheduler
    // корректно завершил прогон (как и для одного источника).
    throw new NoFreshArticlesError(0);
  }

  // Дедуп по URL на этапе объединения (если один и тот же URL в двух RSS).
  const seenUrls = new Set();
  const unique = [];
  for (const a of merged) {
    const nu = a.url ? a.url.toLowerCase().replace(/[?#].*$/, '') : a.url;
    if (nu && seenUrls.has(nu)) continue;
    if (nu) seenUrls.add(nu);
    unique.push(a);
  }

  // Пре-адаптационная фильтрация — ПОСЛЕ merge+dedup, ДО сортировки.
  // Если в одном источнике уже отфильтровали stopword'ом (в parseWithStats),
  // здесь догоним оставшиеся после merge (например, если тот же URL был в двух RSS).
  // Суммируем: предыдущие счётчики + новые из applyFilters.
  const filtered = applyFilters(unique, {
    sourceBlocklist: config.sourceBlocklist,
    titleStopwords: config.titleStopwords,
  });
  const totalDropped = filtered.dropped.bySource + filtered.dropped.byStopword;
  if (totalDropped > 0) {
    log('info', `Фильтры: source=${filtered.dropped.bySource} stopword=${filtered.dropped.byStopword} из ${unique.length}`);
  }
  stats.sourceBlocked += filtered.dropped.bySource;
  stats.stopwordFiltered += filtered.dropped.byStopword;
  const finalArticles = filtered.kept;

  // Сортируем по publishedAt desc — самые свежие сверху.
  finalArticles.sort((a, b) => {
    const ta = a.publishedAt ? a.publishedAt.getTime() : 0;
    const tb = b.publishedAt ? b.publishedAt.getTime() : 0;
    return tb - ta;
  });

  log('info', `После объединения: ${merged.length} → ${unique.length} уникальных (источников: ${bySource.filter((s) => !s.error).length}/${sources.length})`);
  return { articles: finalArticles, stats, total };
}

// --- Сохранение артефактов в sessions/дата/ ---
function todayDirName() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Карта транслитерации для slug. Кириллица → латиница, всё прочее выбрасываем.
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Превращает произвольную строку (заголовок) в URL-safe slug:
 *   - кириллица → латиница (через TRANSLIT)
 *   - всё прочее → ASCII-эквивалент, остальное выбрасываем
 *   - пробелы и подчёркивания → дефис
 *   - схлопываем повторяющиеся дефисы, режем по краям
 *   - ограничиваем 80 символами (читаемо + совместимость с ФС)
 */
export function slugify(input) {
  if (!input) return 'untitled';
  const lower = String(input).toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (TRANSLIT[ch] !== undefined) {
      out += TRANSLIT[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else if (/\s/.test(ch) || ch === '_' || ch === '-') {
      out += '-';
    }
    // остальное (emoji, спецсимволы) — выбрасываем
  }
  out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) return 'untitled';
  return out.slice(0, 80).replace(/-+$/g, '') || 'untitled';
}

/**
 * Транслитерирует домен источника в slug для имени файла.
 * Используется, чтобы в multi-source пайплайне две RSS с одинаковым
 * заголовком в один день не перезатирали друг друга (B8).
 *
 *   the-decoder.com             → the-decoder-com
 *   artificialintelligence-news.com → artificialintelligence-news-com
 *   WWW.Example.COM/feed       → example-com
 *   "" / null                  → 'unknown'
 *
 * Точки внутри домена заменяются на дефисы, дефисы схлопываются.
 * @param {string|null|undefined} urlOrHost
 * @returns {string}
 */
export function slugifyHost(urlOrHost) {
  if (!urlOrHost) return 'unknown';
  let host = String(urlOrHost).trim().toLowerCase();
  if (!host) return 'unknown';

  // Если это URL — вытаскиваем host через URL-парсер (тоже обрезает www.).
  // Если URL невалидный — пробуем как есть (может быть просто "example.com").
  try {
    const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`;
    host = new URL(withScheme).hostname || host;
  } catch {
    /* fallback: используем строку как есть */
  }

  // Убираем www. — это префикс-«шум», на уникальность не влияет.
  host = host.replace(/^www\./, '');

  // Точки → дефисы, схлопываем повторы, режем по краям.
  let out = host.replace(/\./g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  // Ограничиваем, чтобы имя файла не разрасталось.
  out = out.slice(0, 60).replace(/-+$/g, '');

  return out || 'unknown';
}

/**
 * Возвращает дату YYYY-MM-DD из meta.published_at (если валидная),
 * иначе — сегодняшнюю.
 */
function isoDate(meta) {
  const raw = meta && meta.published_at;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }
  return todayDirName();
}

/**
 * Собирает имя файла поста по правилу:
 *   YYYY-MM-DD-news-<hostSlug>-<slug>-social-content.json
 *
 * hostSlug берётся из meta.url (хоста источника) — это защищает от коллизий,
 * когда два разных RSS в один день публикуют статьи с одинаковым заголовком (B8).
 *
 * Если host определить нельзя (старая схема meta без url) — hostSlug = 'unknown',
 * чтобы коллизии были видны в логе, но имя оставалось валидным.
 *
 * @param {{title?: string, url?: string, published_at?: string}} meta
 * @param {string} [suffix='social-content'] — сегмент перед .json (на будущее).
 */
export function buildPostFilename(meta, suffix = 'social-content') {
  const date = isoDate(meta);
  const slug = slugify(meta && meta.title);
  const hostSlug = slugifyHost(meta && meta.url);
  return `${date}-news-${hostSlug}-${slug}-${suffix}.json`;
}

function buildArticleTxt(article) {
  const lines = [
    '---',
    `title: ${article.title || ''}`,
    `url: ${article.url || ''}`,
    `published_at: ${article.publishedAt ? article.publishedAt.toISOString() : ''}`,
    '---',
    '',
    (article.sourceText || article.lead || article.title || '').trim(),
  ];
  return lines.join('\n');
}

/**
 * Сохраняет articles в sessions/YYYY-MM-DD/:
 *   article-1.txt, article-2.txt, article-3.txt, sources.json
 * Возвращает абсолютный путь к каталогу.
 */
export async function persistArticles(articles) {
  const dateDir = todayDirName();
  const fullDir = path.join(config.sessionsDir, dateDir);
  await mkdir(fullDir, { recursive: true });

  for (let i = 0; i < articles.length; i++) {
    const filepath = path.join(fullDir, `article-${i + 1}.txt`);
    await writeFile(filepath, buildArticleTxt(articles[i]), 'utf8');
  }

  const sources = articles.map((a, i) => ({
    index: i + 1,
    title: a.title || null,
    url: a.url || null,
    published_at: a.publishedAt ? a.publishedAt.toISOString() : null,
    file: path.join(dateDir, `article-${i + 1}.txt`),
  }));
  await writeFile(path.join(fullDir, 'sources.json'), JSON.stringify(sources, null, 2), 'utf8');

  log('info', `Сохранено ${articles.length} статей в ${fullDir}`);
  return fullDir;
}
