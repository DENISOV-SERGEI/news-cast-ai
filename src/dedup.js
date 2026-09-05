// src/dedup.js
// Реестр опубликованных статей — JSON-индекс, который переживает переименования файлов.
//
// Хранилище: database/published.json
//   {
//     "version": 1,
//     "updated_at": "2026-08-22T17:50:00.000Z",
//     "urls":   { "<normalizedUrl>": { "first_seen": "...", "title": "...", "slug": "..." } },
//     "slugs":  { "<slug>":            { "first_seen": "...", "url": "..." } }
//   }
//
// Что считаем дубликатом:
//   1) нормализованный URL (без utm_*, fbclid, gclid, fragment, trailing slash, www.)
//   2) slug заголовка (на случай если URL слегка изменился)
//
// Миграция: при первом запуске просканируем posts/*.json, вытащим
// source.url и source.title из каждого, добавим в индекс. Так старые
// публикации сразу попадут в «уже было».

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { slugify } from './parser.js';

const SCHEMA_VERSION = 1;

const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_eid$/i, /^mc_cid$/i,
  /^_hsenc$/i, /^_hsmi$/i, /^igshid$/i, /^ref(_|$)/i, /^source$/i,
];

/** Нормализует URL для дедупликации: scheme+host всегда в нижнем регистре,
 *  удалён fragment, удалены utm_* и похожие tracking-параметры, убран
 *  префикс www., убран trailing slash у path (кроме корня). */
export function normalizeUrl(raw) {
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { return raw; }
  // scheme/host
  const scheme = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // path: убираем trailing slash (кроме случая когда path === '/')
  let p = u.pathname || '/';
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // query: выкидываем tracking-параметры
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.some((re) => re.test(k))) continue;
    kept.push([k, v]);
  }
  // сортируем оставшиеся параметры, чтобы ?a=1&b=2 === ?b=2&a=1
  kept.sort(([a], [b]) => a.localeCompare(b));
  const qs = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${scheme}//${host}${p}${qs ? `?${qs}` : ''}`;
}

function emptyIndex() {
  return { version: SCHEMA_VERSION, updated_at: new Date().toISOString(), urls: {}, slugs: {} };
}

async function readIndex(file) {
  if (!existsSync(file)) return emptyIndex();
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyIndex();
    if (!parsed.urls) parsed.urls = {};
    if (!parsed.slugs) parsed.slugs = {};
    parsed.version = parsed.version || SCHEMA_VERSION;
    return parsed;
  } catch (e) {
    log('warn', `[dedup] Не удалось прочитать ${file}: ${e.message}. Создаю новый индекс.`);
    return emptyIndex();
  }
}

async function writeIndexAtomic(file, index) {
  await mkdir(path.dirname(file), { recursive: true });
  index.updated_at = new Date().toISOString();
  // атомарная запись: tmp → rename
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

/**
 * Миграция: просканировать posts/*.json и наполнить индекс обратно.
 * Вызывается один раз при первом запуске (когда index пустой).
 */
async function migrateFromPosts(index) {
  if (!existsSync(config.postsDir)) return;
  const files = (await readdir(config.postsDir)).filter((f) => f.endsWith('.json'));
  let added = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(path.join(config.postsDir, f), 'utf-8'));
      const url = data?.source?.url;
      const title = data?.source?.title;
      if (!url && !title) continue;
      const nu = normalizeUrl(url);
      const slug = slugify(title);
      if (nu && !index.urls[nu]) {
        index.urls[nu] = { first_seen: new Date().toISOString(), title, slug };
        added++;
      }
      if (slug && !index.slugs[slug]) {
        index.slugs[slug] = { first_seen: new Date().toISOString(), url: nu };
        added++;
      }
    } catch { /* skip broken file */ }
  }
  if (added > 0) log('info', `[dedup] Миграция: добавлено ${added} записей из posts/*.json`);
}

let cached = null;
async function getIndex() {
  if (cached) return cached;
  const idx = await readIndex(config.dbPath);
  // миграция только если индекс реально пустой
  if (Object.keys(idx.urls).length === 0 && Object.keys(idx.slugs).length === 0) {
    await migrateFromPosts(idx);
    if (Object.keys(idx.urls).length > 0 || Object.keys(idx.slugs).length > 0) {
      await writeIndexAtomic(config.dbPath, idx);
    }
  }
  cached = idx;
  return idx;
}

/**
 * Проверяет, была ли статья уже опубликована.
 * @returns {Promise<{duplicate: boolean, reason?: 'url'|'slug', existingSlug?: string, existingUrl?: string}>}
 */
export async function isAlreadyPublished(article) {
  const index = await getIndex();
  const nu = normalizeUrl(article?.url);
  if (nu && index.urls[nu]) {
    return { duplicate: true, reason: 'url', existingUrl: nu, existingSlug: index.urls[nu].slug };
  }
  const slug = slugify(article?.title);
  if (slug && slug !== 'untitled' && index.slugs[slug]) {
    return { duplicate: true, reason: 'slug', existingSlug: slug, existingUrl: index.slugs[slug].url };
  }
  return { duplicate: false };
}

/** Помечает статью как опубликованную. Идемпотентно (повторный вызов безвреден). */
export async function markPublished(article) {
  const index = await getIndex();
  const nu = normalizeUrl(article?.url);
  const slug = slugify(article?.title);
  if (nu && !index.urls[nu]) {
    index.urls[nu] = { first_seen: new Date().toISOString(), title: article?.title, slug };
  }
  if (slug && slug !== 'untitled' && !index.slugs[slug]) {
    index.slugs[slug] = { first_seen: new Date().toISOString(), url: nu };
  }
  await writeIndexAtomic(config.dbPath, index);
  cached = index;
}

/** Возвращает статистику: сколько записей, когда последний раз обновлялся. */
export async function getStats() {
  const index = await getIndex();
  return {
    urls: Object.keys(index.urls).length,
    slugs: Object.keys(index.slugs).length,
    updated_at: index.updated_at,
  };
}

/** Сбрасывает кеш — полезно для тестов. */
export function _resetCache() {
  cached = null;
}
