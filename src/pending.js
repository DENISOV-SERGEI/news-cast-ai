// src/pending.js
// Ручная модерация: self-contained хранилище постов, ожидающих публикации.
//
// Структура pending/<id>/:
//   manifest.json   — { id, created_at, status, source_count, articles: [ ... ] }
//   preview.md      — человекочитаемое превью всех постов (для оператора)
//   article-1.png   — картинки (если сгенерированы)
//
// Manifest.article:
//   {
//     articleId, title, source: {title,url,published_at},
//     json,            — полный content-adaptor/v2 JSON (нужен publisher'у)
//     imageFile,        — относительный путь к PNG внутри pending/<id>/ или null
//     status,           — 'pending' | 'published' | 'failed'
//     publishedAt,      — ISO, когда опубликовано
//     results           — per-step результаты публикации {telegram,vk,site}
//   }
//
// Идемпотентность: --publish-pending можно перезапускать — уже опубликованные
// статьи (status='published') пропускаются, dedup в scheduler сработает по URL/slug.

import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';
import { formatLocal, appendSourceLink, appendSourceLinkMarkdown } from './utils.js';

const PENDING_SCHEMA_VERSION = 1;

/** Генерирует sortable id: YYYYMMDD-HHMMSS-<5 rand>. Дата здесь — локальная, не критично. */
export function generatePendingId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${ts}-${rand}`;
}

export function pendingDirPath(id) {
  return path.join(config.pendingDir, id);
}

/** Создаёт пустой manifest и каталог для нового review-прогона. Возвращает { id, dir } */
export async function createPendingRun(sourceCount = 0) {
  const id = generatePendingId();
  const dir = pendingDirPath(id);
  await mkdir(dir, { recursive: true });
  const manifest = {
    schema_version: PENDING_SCHEMA_VERSION,
    id,
    created_at: new Date().toISOString(),
    status: 'pending',
    source_count: sourceCount,
    articles: [],
  };
  await writeManifest(dir, manifest);
  log('info', `[pending] Создан review-прогон: ${id} (${dir})`);
  return { id, dir, manifest };
}

async function writeManifest(dir, manifest) {
  const file = path.join(dir, 'manifest.json');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

/**
 * Добавляет статью в manifest pending-прогона.
 * Копирует картинку (если есть) внутрь pending/<id>/ — чтобы каталог был self-contained
 * и не зависел от images/, который может быть перезаписан следующим прогоном.
 *
 * @param {string} dir — pending/<id>/
 * @param {object} manifest — мутируется (push статьи)
 * @param {object} article — { articleId, title, source, json, imagePath }
 * @returns {Promise<object>} добавленная статья manifest'а
 */
export async function addPendingArticle(dir, manifest, { articleId, title, source, json, imagePath }) {
  let imageFile = null;
  if (imagePath && existsSync(imagePath)) {
    imageFile = `article-${articleId}.png`;
    await copyFile(imagePath, path.join(dir, imageFile));
  }
  const entry = {
    articleId,
    title: title || source?.title || `(article ${articleId})`,
    source: source || null,
    json,
    imageFile,
    status: 'pending',
    publishedAt: null,
    results: {},
  };
  manifest.articles.push(entry);
  return entry;
}

/** Завершает review-прогон: пишет финальный manifest + превью. Возвращает путь к превью. */
export async function finalizePendingRun(dir, manifest) {
  await writeManifest(dir, manifest);
  const preview = buildPreview(manifest);
  const previewPath = path.join(dir, 'preview.md');
  await writeFile(previewPath, preview, 'utf-8');
  log('info', `[pending] Превью: ${previewPath}`);
  return previewPath;
}

/** Загружает manifest по id. Бросает, если нет. */
export async function readPendingRun(id) {
  const dir = pendingDirPath(id);
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) {
    throw new Error(`Pending-прогон не найден: ${id} (${file})`);
  }
  const manifest = JSON.parse(await readFile(file, 'utf-8'));
  if (!Array.isArray(manifest.articles)) manifest.articles = [];
  manifest.dir = dir;
  return manifest;
}

/**
 * Обновляет одну статью в manifest (статус + результаты) и сохраняет.
 * @param {object} manifest — должен содержать manifest.dir
 */
export async function updatePendingArticle(manifest, articleId, patch) {
  const art = manifest.articles.find((a) => a.articleId === articleId);
  if (!art) return;
  Object.assign(art, patch);
  await writeManifest(manifest.dir, manifest);
}

/** Список всех pending-прогонов (id), отсортированный по убыванию (свежие сверху). */
export async function listPendingRuns() {
  if (!existsSync(config.pendingDir)) return [];
  const entries = await readdir(config.pendingDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Абсолютный путь к картинке статьи внутри pending-прогона. */
export function articleImagePath(manifest, articleId) {
  const art = manifest.articles.find((a) => a.articleId === articleId);
  if (!art || !art.imageFile) return null;
  return path.join(manifest.dir, art.imageFile);
}

// --- Превью ---

function buildPreview(manifest) {
  // Даты показываем в локальном формате (YYYY-MM-DD HH:MM:SS), без Z/миллисекунд.
  const createdLocal = formatLocal(manifest.created_at);
  const lines = [
    `# Pending-прогон ${manifest.id}`,
    ``,
    `- Создан: ${createdLocal || manifest.created_at}`,
    `- Статей: ${manifest.articles.length}`,
    `- Статус прогона: ${manifest.status}`,
    ``,
    `Публикация: \`node src/index.js --publish-pending ${manifest.id}\``,
    ``,
  ];
  for (const a of manifest.articles) {
    lines.push(`---`, ``);
    lines.push(`## Статья ${a.articleId}: ${a.title || '(без заголовка)'}`);
    const publishedLocal = a.publishedAt ? formatLocal(a.publishedAt) : '';
    lines.push(
      `- Статус: **${a.status}**` +
      (publishedLocal ? ` (опубликовано ${publishedLocal})` : ''),
    );
    if (a.source?.url) lines.push(`- Источник: ${a.source.url}`);
    if (a.imageFile) lines.push(`- Картинка: ${a.imageFile}`);
    const tg = a.json?.social?.telegram;
    if (tg) {
      lines.push(``, `### Telegram`);
      if (tg.title) lines.push(`**${tg.title}**`);
      // В превью показываем, как текст уйдёт в Telegram со ссылкой на оригинал
      // (паблишер добавит её автоматически).
      const tgBody = [tg.title, tg.draft, tg.cta].filter(Boolean).join('\n\n');
      const tgLabel = config.sourceLinkLabel;
      lines.push(appendSourceLink(tgBody, a.source?.url, tgLabel) || '_(нет draft)_');
    }
    const vk = a.json?.social?.vk;
    if (vk) {
      lines.push(``, `### VK`);
      if (vk.title) lines.push(`**${vk.title}**`);
      const vkBody = [vk.title, vk.draft, vk.cta].filter(Boolean).join('\n\n');
      const vkLabel = config.sourceLinkLabel;
      lines.push(appendSourceLink(vkBody, a.source?.url, vkLabel) || '_(нет draft)_');
    }
    const zen = a.json?.social?.yandex_dzen;
    if (zen) {
      lines.push(``, `### Yandex Dzen (черновик .md)`);
      if (zen.title) lines.push(`**${zen.title}**`);
      const zenBody = (zen.draft || '').trim();
      const zenLabel = config.sourceLinkLabel;
      lines.push(appendSourceLinkMarkdown(zenBody, a.source?.url, zenLabel) || '_(нет draft)_');
    }
    const blog = a.json?.social?.site_blog;
    if (blog) {
      lines.push(``, `### Site Blog (черновик WP)`);
      if (blog.h1) lines.push(`**${blog.h1}**`);
      const blogBody = (blog.draft || '').trim();
      const blogLabel = config.sourceLinkLabel;
      // Превью показывает plain-текст (HTML-обёртка ссылки не видна в md).
      lines.push(appendSourceLink(blogBody, a.source?.url, blogLabel) || '_(нет draft)_');
    }
    lines.push(``);
  }
  return lines.join('\n');
}