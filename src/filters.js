// src/filters.js
// Пре-адаптационная фильтрация: отбрасываем статьи до того, как они попадут
// в Ollama (экономим токены и держим ленту чистой).
//
// Два независимых фильтра:
//   1) Source blocklist — CSV доменов (например, medium.com,reddit.com).
//      Сравниваем по hostname (lowercase, без www.). Parent-домены тоже ловим:
//      если в списке "medium.com" — отбрасываем и "blog.medium.com".
//   2) Title stopwords — CSV подстрок (lowercase, например weekly roundup,newsletter).
//      Если заголовок содержит ЛЮБУЮ подстроку как substring — отбрасываем.
//
// Фильтры применяются последовательно: сначала source, потом stopword.
// Если статья отброшена по source — stopword на ней уже не проверяется.
// Если оба списка пустые — applyFilters возвращает все статьи и {bySource:0, byStopword:0}.

/**
 * Возвращает true, если домен (или его parent) есть в blocklist.
 * Сравнение по lowercase hostname без префикса www.
 * Невалидный URL — возвращает false (не падаем).
 *
 * @param {string} url — полный URL статьи.
 * @param {string[]} blocklist — список доменов/parent-доменов (lowercase).
 * @returns {boolean}
 */
export function isBlockedSource(url, blocklist) {
  if (!url || !Array.isArray(blocklist) || blocklist.length === 0) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // невалидный URL — не блокируем (нет домена для сравнения)
  }
  if (!host) return false;
  // Срезаем www. — это префикс-«шум», на уникальность не влияет.
  if (host.startsWith('www.')) host = host.slice(4);

  // Проверяем сам домен и все его родительские домены:
  //   blog.medium.com → ["blog.medium.com", "medium.com"]
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (blocklist.includes(candidate)) return true;
  }
  return false;
}

/**
 * Возвращает true, если title (lowercase) содержит хотя бы одну подстроку из stopwords.
 * Регистр заголовка приводим к lowercase, сравнение — substring.
 * Пустой title или пустой stopwords — false (нечего фильтровать).
 *
 * @param {string} title — заголовок статьи.
 * @param {string[]} stopwords — список подстрок (lowercase).
 * @returns {boolean}
 */
export function hasStopwordTitle(title, stopwords) {
  if (!title || !Array.isArray(stopwords) || stopwords.length === 0) return false;
  const lower = String(title).toLowerCase();
  for (const sw of stopwords) {
    if (sw && lower.includes(sw)) return true;
  }
  return false;
}

/**
 * Прогоняет массив статей через оба фильтра.
 * Возвращает { kept, dropped: { bySource, byStopword } }.
 *
 * Порядок: source → stopword. Если статья отброшена по source, stopword на ней
 * не проверяется (не считаем дважды).
 *
 * @param {Array<{title?: string, url?: string}>} articles
 * @param {{sourceBlocklist?: string[], titleStopwords?: string[]}} cfg
 * @returns {{kept: Array, dropped: {bySource: number, byStopword: number}}}
 */
export function applyFilters(articles, cfg = {}) {
  const sourceBlocklist = cfg.sourceBlocklist || [];
  const titleStopwords = cfg.titleStopwords || [];
  const useSource = sourceBlocklist.length > 0;
  const useStopword = titleStopwords.length > 0;

  if (!useSource && !useStopword) {
    return { kept: articles.slice(), dropped: { bySource: 0, byStopword: 0 } };
  }

  const kept = [];
  let bySource = 0;
  let byStopword = 0;
  for (const a of articles) {
    if (useSource && isBlockedSource(a && a.url, sourceBlocklist)) {
      bySource++;
      continue;
    }
    if (useStopword && hasStopwordTitle(a && a.title, titleStopwords)) {
      byStopword++;
      continue;
    }
    kept.push(a);
  }
  return { kept, dropped: { bySource, byStopword } };
}
