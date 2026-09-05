// src/imageCache.js
// Кэш сгенерированных картинок: image_prompt → файл.
//
// Зачем:
//   1) Фикс бага B1 — imageGenerator раньше писал в фиксированное images/article-N.png
//      и каждый прогон затирал картинки предыдущего. posts/*.json от старого прогона
//      ссылались на чужой/несуществующий файл (3 из 6 постов в реестре — битые).
//      Теперь имя файла = хеш промпта → одинаковые промпты переиспользуют файл,
//      разные — никогда не коллизируют и не перезатирают друг друга.
//   2) Экономия на ProxyAPI: при повторных прогонах с тем же image_prompt
//      (часто — пере-ран с теми же статьями) не дёргаем генерацию повторно.
//
// Хранилище: database/image_cache.json
//   {
//     "version": 1, "updated_at": "...",
//     "entries": {
//       "<hash16>": { "prompt_preview": "...", "filepath": "...", "created_at": "...", "bytes": N }
//     }
//   }
//
// Идемпотентен и устойчив к потере файла: если JSON битый — пересоздаём пустой.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, log } from './config.js';

const SCHEMA_VERSION = 1;
let cached = null;

function emptyIndex() {
  return { version: SCHEMA_VERSION, updated_at: new Date().toISOString(), entries: {} };
}

/** Ключ кэша: 16 символов sha256 от нормализованного (trim) промпта. */
export function cacheKey(prompt) {
  const normalized = String(prompt || '').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function readIndex() {
  if (cached) return cached;
  const file = config.imageCachePath;
  if (!existsSync(file)) {
    cached = emptyIndex();
    return cached;
  }
  try {
    let parsed = JSON.parse(await readFile(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) parsed = emptyIndex();
    else parsed.version = parsed.version || SCHEMA_VERSION;
    cached = parsed;
    return cached;
  } catch (e) {
    log('warn', `[imageCache] Не удалось прочитать ${file}: ${e.message}. Создаю новый кэш.`);
    cached = emptyIndex();
    return cached;
  }
}

async function writeIndexAtomic(index) {
  const file = config.imageCachePath;
  await mkdir(path.dirname(file), { recursive: true });
  index.updated_at = new Date().toISOString();
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await rename(tmp, file);
}

/**
 * Ищет закэшированную картинку по ключу промпта.
 * Возвращает { filepath, bytes } ТОЛЬКО если файл существует на диске
 * (битая ссылка = промах, чтобы не вернуть путь на удалённый файл).
 */
export async function lookupImageCache(key) {
  const index = await readIndex();
  const entry = index.entries[key];
  if (!entry || !entry.filepath) return null;
  if (!existsSync(entry.filepath)) {
    // Файл удалили вручную — запись протухла, не используем.
    return null;
  }
  return { filepath: entry.filepath, bytes: entry.bytes || 0 };
}

/**
 * Сохраняет (или обновляет) запись в кэше. Идемпотентна.
 */
export async function saveImageToCache(key, prompt, filepath, bytes) {
  const index = await readIndex();
  index.entries[key] = {
    prompt_preview: String(prompt || '').slice(0, 200),
    filepath,
    created_at: new Date().toISOString(),
    bytes: bytes || 0,
  };
  await writeIndexAtomic(index);
}

/** Статистика кэша — для метрик/логов. */
export async function getCacheStats() {
  const index = await readIndex();
  return {
    entries: Object.keys(index.entries || {}).length,
    updated_at: index.updated_at,
  };
}

/** Сброс in-memory кеша индекса — для тестов. */
export function _resetImageCache() {
  cached = null;
}