// src/siteNews.js
// Экспорт агрегата «свежие новости» для статического сайта business_card.
//
// ВАЖНО: это НЕ канал публикации (как Telegram/VK/Dzen/Site). Модуль формирует
// единый JSON-файл news.json с заголовками последних постов, который
// клиентская часть сайта («Новости AI») подгружает и рендерит. В per-channel
// дедуп publishPending он не входит — это экспорт агрегата, а не публикация.
//
// Источник данных: posts/*.json (схема content-adaptor/v2).
// Поля одного item:
//   title       — summary.title, fallback source.title;
//   url         — source.url (ссылка на оригинал статьи);
//   article_url — ссылка на страницу статьи на самом сайте (articles/<slug>.html,
//                 полный текст — расширенный summary). Клик по названию ведёт сюда;
//   dzen_url    — опционально, ссылка на пост в Дзене (из dzen_links.json);
//   date        — «YYYY-MM-DD» из source.published_at (fallback — mtime файла);
//   source      — hostname из source.url (lowercase, без www.).
//
// Запись атомарная: сначала во временный файл, затем rename — сайт никогда не
// читает недописанный JSON. Если целевая директория не существует — кидаем
// понятную ошибку: вызов идёт best-effort шагом из scheduler.js, прогон не
// падает, но оператор видит причину в логе.

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { articleFilename } from './siteArticles.js';

const DEFAULT_MAX_ITEMS = 10;
// Регламент «топ-10 за N дней»: в выдачу попадают только статьи не старше
// этого числа дней (по published_at, fallback — mtime файла). 0 = без фильтра.
// С 2026-09-05 окно расширено с 5 до 14 дней (по выбору владельца).
const DEFAULT_FRESH_DAYS = 14;
/** Читает database/dzen_links.json → Map(match → dzen_url). Нет файла/битый JSON → пустая Map. */
function loadDzenLinks() {
  try {
    // Резолвим при чтении, а не при загрузке модуля: тесты переопределяют
    // config.postsDir на tmp-директорию, путь должен следовать за конфигом.
    const file = path.resolve(config.postsDir, '..', 'database', 'dzen_links.json');
    // Файл маленький и пишется вручную — читаем синхронно: карта нужна
    // синхронно при сборке карточек в collectSiteNewsItems.
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const links = Array.isArray(raw?.links) ? raw.links : [];
    return new Map(
      links
        .filter((l) => l && typeof l.match === 'string' && typeof l.dzen_url === 'string')
        .map((l) => [l.match.trim(), l.dzen_url.trim()]),
    );
  } catch {
    return new Map();
  }
}



/** Выдёргивает hostname из URL (lowercase, без префикса www.). Пусто на невалидном. */
function hostOf(url) {
  try {
    let h = new URL(url).hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  } catch {
    return '';
  }
}

/**
 * Читает все posts/*.json и собирает «свежесть-отсортированные» карточки новостей.
 * Экспортирована для тестов.
 *
 * @param {object} [opts]
 * @param {number} [opts.freshDays=5] — отбрасывать статьи старше N дней (0 = без фильтра).
 * @returns {Promise<Array<{title: string, url: string, date: string, source: string}>>}
 */
export async function collectSiteNewsItems(opts = {}) {
  const freshDays =
    Number.isInteger(opts.freshDays) && opts.freshDays >= 0 ? opts.freshDays : DEFAULT_FRESH_DAYS;
  const dir = config.postsDir;
  if (!existsSync(dir)) {
    log('warn', `[site-news] каталог постов не найден: ${dir}`);
    return [];
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const dzenLinks = loadDzenLinks();
  const cards = [];
  const seenUrls = new Set(); // в posts/ встречаются копии одной статьи (*-(2).json)
  // Регламент «топ-10 за N дней»: статьи старше freshDays не попадают в выдачу.
  const freshCutoff = freshDays > 0 ? Date.now() - freshDays * 24 * 3600 * 1000 : 0;
  for (const f of files) {
    const fp = path.join(dir, f);
    let data;
    try {
      data = JSON.parse(await readFile(fp, 'utf-8'));
    } catch {
      continue; // битый JSON — пропускаем, не валим экспорт
    }
    const src = data?.source || {};
    const url = typeof src.url === 'string' ? src.url.trim() : '';
    const title = String(data?.summary?.title || src.title || '').trim();
    // Карточки без url или без title бесполезны на сайте — отбрасываем.
    if (!url || !title) continue;
    // Дедуп по URL: одна статья = одна карточка (берём первую встреченную копию).
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Свежесть: приоритет source.published_at, иначе mtime файла.
    let ts = NaN;
    if (src.published_at) ts = Date.parse(src.published_at);
    if (Number.isNaN(ts)) {
      try {
        ts = (await stat(fp)).mtimeMs;
      } catch {
        ts = 0;
      }
    }
    if (freshCutoff && ts < freshCutoff) continue;

    // Если для этой новости есть ссылка на пост в Дзене (database/dzen_links.json
    // матчится по url источника или по заголовку) — прикрепляем как dzen_url.
    const dzenUrl = dzenLinks.get(url) || dzenLinks.get(title) || null;
    cards.push({
      title,
      url,
      // Ссылка на страницу статьи на самом сайте (полный текст, расширенный
      // summary). Имя файла совпадает с тем, что генерирует siteArticles.js.
      article_url: `articles/${articleFilename({ url, title })}`,
      date: new Date(ts).toISOString().slice(0, 10), // YYYY-MM-DD (UTC)
      source: hostOf(url),
      ...(dzenUrl ? { dzen_url: dzenUrl } : {}),
      _ts: ts, // служебное поле для сортировки; из выдачи удаляется
    });
  }

  // Свежие первыми.
  cards.sort((a, b) => b._ts - a._ts);
  return cards.map(({ _ts, ...rest }) => rest);
}

/**
 * Экспортирует топ-maxItems самых свежих новостей в news.json.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxItems=10]
 * @param {number} [opts.freshDays=5] — отбрасывать статьи старше N дней (0 = без фильтра).
 * @returns {Promise<{skipped?: boolean, filepath: string|null, items: number}>}
 * @throws {Error} если целевая директория не существует.
 */
export async function exportSiteNews(opts = {}) {
  const maxItems =
    Number.isInteger(opts.maxItems) && opts.maxItems > 0 ? opts.maxItems : DEFAULT_MAX_ITEMS;
  const freshDays =
    Number.isInteger(opts.freshDays) && opts.freshDays >= 0 ? opts.freshDays : DEFAULT_FRESH_DAYS;

  if (config.features && config.features.businessCardNews === false) {
    log('info', '[site-news] BUSINESS_CARD_NEWS_PATH=off — экспорт пропущен');
    return { skipped: true, filepath: null, items: 0 };
  }

  const outPath = config.businessCardNewsPath;
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) {
    throw new Error(`exportSiteNews: целевая директория не существует: ${outDir}`);
  }

  const all = await collectSiteNewsItems({ freshDays });
  const items = all.slice(0, maxItems);
  const payload = {
    updated_at: new Date().toISOString(),
    items,
  };

  // JSON.stringify не эскейпит unicode — русские заголовки лягут как есть.
  // Отступы в 2 пробела: файл читаем человеком при отладке.
  const tmp = `${outPath}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await rename(tmp, outPath);

  log('info', `[site-news] news.json обновлён: ${outPath} (${items.length}/${all.length} новостей)`);
  return { filepath: outPath, items: items.length };
}
