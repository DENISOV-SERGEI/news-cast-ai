// src/siteArticles.js
// Экспорт полных текстов статей на сайт business_card (страница статей).
//
// Регламент «топ-10 за 14 дней» (задан владельцем 2026-09-05, окно расширено
// с 5 до 14 дней): на сайте остаются только последние 10 свежих статей за
// последние 14 дней (по source.published_at, fallback — mtime файла).
// Остальные УДАЛЯЮТСЯ. Обновление — при каждом прогоне пайплайна
// (scheduler.js вызывает exportSiteArticles после exportSiteNews).
//
// Генерирует:
//   - business_card/articles.html — список статей (заголовок + дата, ссылка на статью);
//   - business_card/articles/<slug>.html — отдельная страница с полным текстом
//     (social.site_blog.draft — расширенный summary, 2000-4000 символов, БЕЗ фото).
//
// Текст — внешние данные (LLM): вставляем только через escapeHtml, без innerHTML.
// Запись атомарная (tmp + rename), как в siteNews.js.

import { readdir, readFile, writeFile, rename, rm, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { slugify, slugifyHost } from './parser.js';

const DEFAULT_MAX_ITEMS = 10;
// Регламент «топ-10 за N дней». С 2026-09-05 окно расширено с 5 до 14 дней
// (по выбору владельца).
const DEFAULT_FRESH_DAYS = 14;

/** Эскейпинг HTML-спецсимволов (данные внешние — LLM). */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** hostname из URL (lowercase, без www.). Пусто на невалидном. */
function hostOf(url) {
  try {
    let h = new URL(url).hostname.toLowerCase();
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  } catch {
    return '';
  }
}

/** YYYY-MM-DD → DD.MM.YYYY (как formatNewsDate в js/app.js). */
function formatDate(ymd) {
  const parts = String(ymd || '').split('-');
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return ymd || '';
}

/** Разбивает текст на абзацы (по \n\n) и оборачивает в <p> с эскейпингом. */
function paragraphsToHtml(text) {
  const parts = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  return parts.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
}

/** Имя файла статьи: <hostSlug>-<slug>.html (стабильно между прогонами). */
export function articleFilename(meta) {
  return `${slugifyHost(meta.url)}-${slugify(meta.title)}.html`;
}

// --- Общие блоки HTML-страниц (по образцу privacy.html) ---

const SOCIAL_NAV_HTML = `      <div class="social-nav" aria-label="Социальные сети">
        <a href="https://dzen.ru/id/62581bb4bde5af0c6e65de83" target="_blank" rel="noopener noreferrer" class="social-nav-link" aria-label="Яндекс Дзен">
          <img src="../assets/Yandex_Zen.png" alt="" aria-hidden="true" class="social-nav-icon">
        </a>
        <a href="https://t.me/+uvg_FV2EXQE0MWMy" target="_blank" rel="noopener noreferrer" class="social-nav-link" aria-label="Telegram">
          <img src="../assets/telegram_logo.png" alt="" aria-hidden="true" class="social-nav-icon">
        </a>
        <a href="https://github.com/DENISOV-SERGEI" target="_blank" rel="noopener noreferrer" class="social-nav-link" aria-label="GitHub">
          <img src="../assets/git_hab.png" alt="" aria-hidden="true" class="social-nav-icon">
        </a>
      </div>`;

const FOOTER_HTML = `  <footer id="contacts" class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-info">
          <p class="footer-name">Сергей Денисов</p>
          <p class="footer-role">Внедрение ИИ-агентов и автоматизации бизнес-процессов на n8n.</p>
        </div>

        <div class="footer-contacts">
          <a href="mailto:zero.0.cod@yandex.ru" class="footer-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="5" width="20" height="14" rx="2"></rect>
              <polyline points="2 7 12 13 22 7"></polyline>
            </svg>
            zero.0.cod@yandex.ru
          </a>

          <a href="https://t.me/PyeBuTT" target="_blank" rel="noopener noreferrer" class="footer-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 3 2 12l7 2 2 7 11-16z"></path>
            </svg>
            Telegram: @PyeBuTT
          </a>

          <a href="https://github.com/DENISOV-SERGEI" target="_blank" rel="noopener noreferrer" class="footer-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path>
            </svg>
            github.com/DENISOV-SERGEI
          </a>
        </div>
      </div>

      <div class="footer-bottom">
        <p><a href="../privacy.html" class="footer-privacy-link"><span class="footer-privacy-text">Политика конфиденциальности в отношении<br>пользовательских данных</span></a></p>
        <p>© 2026 Сергей Денисов. Все права защищены.</p>
      </div>
    </div>
  </footer>`;

/** Полная HTML-страница одной статьи (без фото, текст абзацами). */
function buildArticlePage(a) {
  const title = escapeHtml(a.title);
  const desc = escapeHtml(a.meta_description || a.title);
  const date = formatDate(a.date);
  const source = escapeHtml(a.source);
  const body = paragraphsToHtml(a.text);
  const sourceLink = escapeHtml(a.url);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${desc}">
  <title>${title} — Сергей Денисов</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/styles.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
${SOCIAL_NAV_HTML}
      <a href="../index.html#news" class="btn btn-secondary" style="padding: 10px 18px; font-size: 0.875rem;">← На главную</a>
    </div>
  </header>

  <main>
    <section class="section" style="padding-top: calc(var(--header-height) + 48px);">
      <div class="container article-page" style="max-width: 800px;">
        <h1 class="section-title" style="font-size: 2rem;">${title}</h1>
        <div class="article-meta">${date} · ${source}</div>
        <div class="article-text">
${body}
        </div>
        <p class="article-source"><a href="${sourceLink}" target="_blank" rel="noopener noreferrer">Источник: ${source}</a></p>
      </div>
    </section>
  </main>

${FOOTER_HTML}
</body>
</html>`;
}

/** HTML-страница со списком статей (заголовок + дата, ссылка на статью). */
function buildArticlesList(articles) {
  const items = articles
    .map(
      (a) => `        <li class="article-item">
          <a href="articles/${a.slug}">
            <span class="article-item__date">${formatDate(a.date)}</span>
            <span class="article-item__title">${escapeHtml(a.title)}</span>
          </a>
        </li>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Полные тексты свежих статей об ИИ и автоматизации — Сергей Денисов.">
  <title>Статьи — Сергей Денисов</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/styles.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤖</text></svg>">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner">
      <div class="social-nav" aria-label="Социальные сети">
        <a href="https://dzen.ru/id/62581bb4bde5af0c6e65de83" target="_blank" rel="noopener noreferrer" class="social-nav-link" aria-label="Яндекс Дзен">
          <img src="assets/Yandex_Zen.png" alt="" aria-hidden="true" class="social-nav-icon">
        </a>
        <a href="https://t.me/+uvg_FV2EXQE0MWMy" target="_blank" rel="noopener noreferrer" class="social-nav-link" aria-label="Telegram">
          <img src="assets/telegram_logo.png" alt="" aria-hidden="true" class="social-nav-icon">
        </a>
        <a href="https://github.com/DENISOV-SERGEI" target="_blank" rel="noopener noreferrer" class="social-nav-link" aria-label="GitHub">
          <img src="assets/git_hab.png" alt="" aria-hidden="true" class="social-nav-icon">
        </a>
      </div>
      <a href="index.html#news" class="btn btn-secondary" style="padding: 10px 18px; font-size: 0.875rem;">← На главную</a>
    </div>
  </header>

  <main>
    <section class="section" style="padding-top: calc(var(--header-height) + 48px);">
      <div class="container">
        <h1 class="section-title" style="font-size: 2rem;">Статьи</h1>
        <p class="article-list-note">Последние 10 свежих статей за 14 дней. Полные тексты, без сокращений.</p>
        <ul class="article-list">
${items}
        </ul>
      </div>
    </section>
  </main>

${FOOTER_HTML}
</body>
</html>`;
}

/**
 * Читает posts/*.json и собирает статьи для сайта (топ-maxItems за freshDays).
 * Экспортирована для тестов.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxItems=10]
 * @param {number} [opts.freshDays=5] — отбрасывать статьи старше N дней (0 = без фильтра).
 * @returns {Promise<Array<{slug, title, url, date, source, text, meta_description}>>}
 */
export async function collectSiteArticles(opts = {}) {
  const maxItems =
    Number.isInteger(opts.maxItems) && opts.maxItems > 0 ? opts.maxItems : DEFAULT_MAX_ITEMS;
  const freshDays =
    Number.isInteger(opts.freshDays) && opts.freshDays >= 0 ? opts.freshDays : DEFAULT_FRESH_DAYS;
  const dir = config.postsDir;
  if (!existsSync(dir)) {
    log('warn', `[site-articles] каталог постов не найден: ${dir}`);
    return [];
  }

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const cards = [];
  const seenUrls = new Set(); // в posts/ встречаются копии одной статьи (*-(2).json)
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
    const sb = data?.social?.site_blog || {};
    const text = typeof sb.draft === 'string' ? sb.draft.trim() : '';
    // Статья без полного текста или без url/title бесполезна на сайте.
    if (!url || !title || !text) continue;
    // Дедуп по URL: одна статья = одна страница (берём первую встреченную копию).
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

    cards.push({
      slug: articleFilename({ url, title }),
      title,
      url,
      date: new Date(ts).toISOString().slice(0, 10), // YYYY-MM-DD (UTC)
      source: hostOf(url),
      text,
      meta_description: typeof sb.meta_description === 'string' ? sb.meta_description.trim() : '',
      _ts: ts, // служебное поле для сортировки; из выдачи удаляется
    });
  }

  cards.sort((a, b) => b._ts - a._ts);
  return cards.slice(0, maxItems).map(({ _ts, ...rest }) => rest);
}

/**
 * Экспортирует страницы статей на сайт business_card:
 *   - articles/<slug>.html — по одной странице на статью из топ-maxItems;
 *   - articles.html — список статей.
 * Удаляет старые страницы, которых нет в текущем топе (регламент «остальные удаляются»).
 *
 * @param {object} [opts] — пробрасывается в collectSiteArticles (maxItems, freshDays).
 * @returns {Promise<{skipped?: boolean, filepath: string|null, items: number}>}
 * @throws {Error} если целевая директория не существует.
 */
export async function exportSiteArticles(opts = {}) {
  if (config.features && config.features.siteArticles === false) {
    log('info', '[site-articles] SITE_ARTICLES_DIR=off — экспорт пропущен');
    return { skipped: true, filepath: null, items: 0 };
  }

  const articles = await collectSiteArticles(opts);
  const dir = config.siteArticlesDir;
  const listPath = config.siteArticlesListPath;
  const listDir = path.dirname(listPath);
  if (!existsSync(listDir)) {
    throw new Error(`exportSiteArticles: целевая директория не существует: ${listDir}`);
  }
  await mkdir(dir, { recursive: true });

  // 1) Отдельные страницы статей (атомарно: tmp + rename).
  const slugs = new Set();
  for (const a of articles) {
    slugs.add(a.slug);
    const fp = path.join(dir, a.slug);
    const tmp = `${fp}.tmp`;
    await writeFile(tmp, buildArticlePage(a), 'utf-8');
    await rename(tmp, fp);
  }

  // 2) Удаляем старые страницы, которых нет в текущем топе.
  const existing = (await readdir(dir)).filter((f) => f.endsWith('.html'));
  for (const f of existing) {
    if (!slugs.has(f)) {
      await rm(path.join(dir, f), { force: true });
      log('info', `[site-articles] Удалена устаревшая статья: ${f}`);
    }
  }

  // 3) Список статей (атомарно).
  const tmpList = `${listPath}.tmp`;
  await writeFile(tmpList, buildArticlesList(articles), 'utf-8');
  await rename(tmpList, listPath);

  log('info', `[site-articles] articles.html обновлён: ${listPath} (${articles.length} статей)`);
  return { filepath: listPath, items: articles.length };
}
