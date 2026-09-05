// src/drafts.js
// Прямого API у Яндекс Дзен нет. Поэтому сохраняем готовый текст как
// Markdown-файл с YAML-front-matter в drafts/dzen-{id}.md — оператор
// копирует его в редактор Дзен вручную.
//
// Формат файла:
//   ---
//   title: ...
//   description: ...
//   tags: [tag1, tag2, ...]
//   source_url: ...
//   saved_at: 2026-08-22T12:00:00.000Z
//   ---
//
//   <draft text>
//
// Поведение:
//   - Создаёт draftsDir при первом запуске.
//   - Перезаписывает существующий файл (одна статья = один файл, не плодим версии).
//   - Бросает ошибку, если в json нет social.yandex_dzen.draft.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';
import { appendSourceLinkMarkdown } from './utils.js';

function yamlEscape(s) {
  if (s == null) return '""';
  // Оборачиваем в кавычки, экранируем обратные слэши и кавычки.
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tagsYaml(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '[]';
  return '[' + tags.map((t) => yamlEscape(t)).join(', ') + ']';
}

function buildMarkdown(json) {
  const zen = json?.social?.yandex_dzen;
  if (!zen || !zen.draft) {
    throw new Error('drafts: в json нет social.yandex_dzen.draft');
  }

  const source = json?.source || {};
  // Ссылка на оригинал добавляется кодом, чтобы модель не сломала URL.
  const draftWithLink = appendSourceLinkMarkdown(
    (zen.draft || '').trim(),
    source.url,
    config.sourceLinkLabel,
  );
  const lines = [
    '---',
    `title: ${yamlEscape(zen.title || source.title || '')}`,
    `description: ${yamlEscape(zen.description || '')}`,
    `tags: ${tagsYaml(zen.tags || [])}`,
    `source_url: ${yamlEscape(source.url || '')}`,
    `saved_at: ${new Date().toISOString()}`,
    '---',
    '',
    draftWithLink,
    '',
  ];
  return lines.join('\n');
}

/**
 * Сохраняет черновик Дзен для одной статьи.
 *
 * @param {object} json — полный JSON по схеме content-adaptor/v2
 * @param {number} articleId
 * @returns {Promise<{ filepath: string, bytes: number }>}
 */
export async function writeZenDraft(json, articleId) {
  const md = buildMarkdown(json);
  await mkdir(config.draftsDir, { recursive: true });
  const filename = `dzen-${articleId}.md`;
  const filepath = path.join(config.draftsDir, filename);
  await writeFile(filepath, md, 'utf-8');
  log('info', `[drafts] Дзен-черновик сохранён: ${filepath} (${md.length} байт)`);
  return { filepath, bytes: Buffer.byteLength(md, 'utf-8') };
}
