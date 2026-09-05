// src/publisher.site.js
// Публикация черновика записи на WordPress-сайте через WP REST API.
//
// Эндпоинт: POST {SITE_API_URL}/wp-json/wp/v2/posts
//   — SITE_API_URL может быть как полным (https://example.com/wp-json/wp/v2),
//     так и базой сайта (https://example.com) — тогда /wp-json/wp/v2 допишем.
//
// Авторизация: WordPress ожидает application password в формате "user:pass"
// (Basic Auth). Если в SITE_API_KEY нет ":" — шлём его как Bearer (для JWT-сайтов).
//
// status: "draft" — нам не нужно публиковать сразу, оператор сам проверит и опубликует.

import { config, log } from './config.js';
import { fetchWithTimeout } from './http.js';
import { appendSourceLinkHtml } from './utils.js';

function buildBase() {
  const raw = (config.siteApiUrl || '').replace(/\/$/, '');
  if (!raw) throw new Error('publishToSite: SITE_API_URL не задан');
  if (/\/wp-json\/(wp\/v2|wp\/v2\/posts)/.test(raw)) return raw.replace(/\/posts$/, '');
  return `${raw}/wp-json/wp/v2`;
}

function buildAuthHeader() {
  const key = config.siteApiKey || '';
  if (key.includes(':')) {
    // Application password: username:application-password → Basic base64
    return `Basic ${Buffer.from(key, 'utf-8').toString('base64')}`;
  }
  return `Bearer ${key}`;
}

function paragraphsToHtml(text) {
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>').trim()}</p>`)
    .join('\n');
}

async function wpFetch(pathname, init = {}) {
  const url = `${buildBase()}${pathname}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: buildAuthHeader(),
    ...(init.headers || {}),
  };
  const res = await fetchWithTimeout(url, { ...init, headers }, { timeoutMs: 30_000 });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`WP ${pathname}: невалидный JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = json.message || (typeof json === 'string' ? json : JSON.stringify(json).slice(0, 300));
    const e = new Error(`WP ${pathname}: HTTP ${res.status} ${msg}`);
    // 429/5xx — transient, повторяем (draft может задвоиться, но оператор всё равно
    // ревьюит; 4xx кроме 429 — фатально).
    e.retryable = res.status === 429 || res.status >= 500;
    throw e;
  }
  return json;
}

/**
 * Публикует черновик записи на сайт.
 *
 * @param {object} json — полный JSON по схеме content-adaptor/v2
 * @returns {Promise<{ postId: number, link: string, status: string }>}
 */
export async function publishToSite(json) {
  if (!config.features.site) {
    throw new Error('publishToSite: SITE_API_URL / SITE_API_KEY не заданы в .env');
  }
  const blog = json?.social?.site_blog;
  if (!blog || !blog.draft) {
    throw new Error('publishToSite: в json нет social.site_blog.draft');
  }

  const html = [
    paragraphsToHtml(blog.draft),
    blog.cta ? `<p><strong>${blog.cta}</strong></p>` : '',
  ].filter(Boolean).join('\n');
  // Ссылка на оригинал добавляется кодом, чтобы модель не сломала URL.
  const htmlWithLink = appendSourceLinkHtml(html, json?.source?.url, config.sourceLinkLabel);

  const body = {
    title: blog.h1 || json?.source?.title || '(без заголовка)',
    content: htmlWithLink,
    excerpt: blog.meta_description || '',
    status: 'draft', // критично: только черновик
  };

  log('info', `[site] Создаю черновик: "${body.title.slice(0, 80)}"`);
  const created = await wpFetch('/posts', { method: 'POST', body: JSON.stringify(body) });
  log('info', `[site] Черновик создан: id=${created.id} status=${created.status} link=${created.link}`);
  return { postId: created.id, link: created.link, status: created.status };
}

/** Проверяет, что API доступен (GET /users/me с тем же токеном). */
export async function checkSiteAccess() {
  if (!config.features.site) {
    log('warn', '[site] SITE_API_URL / SITE_API_KEY не заданы — публикация на сайт пропущена');
    return false;
  }
  try {
    const me = await wpFetch('/users/me');
    log('info', `[site] API доступен, пользователь: ${me.name || me.slug || me.id}`);
    return true;
  } catch (e) {
    log('error', `[site] Не удалось подтвердить доступ: ${e.message}`);
    return false;
  }
}
