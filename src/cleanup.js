// src/cleanup.js
// Очистка старых артефактов пайплайна по RETENTION_DAYS (default 30).
//
// Чистит:
//   - sessions/  — исходники статей (включая поддиректории YYYY-MM-DD);
//   - posts/     — JSON-адаптации;
//   - images/    — PNG-картинки (кэш по промпту).
//
// Безопасность для images/: imageCache.lookupImageCache проверяет existsSync
// и при отсутствии файла возвращает промах — битая запись в image_cache.json
// безвредна, картинка просто сгенерируется заново при том же промпте.
//
// Best-effort: вызывается из scheduler в try/catch — ошибка не роняет прогон.

import { readdir, stat, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { config, log } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Удаляет файлы старше config.retentionDays в images/, sessions/, posts/.
 * Возвращает { skipped, deletedFiles }.
 * Если retentionDays <= 0 — очистка отключена ({ skipped: true }).
 */
export async function cleanupOldFiles() {
  if (!config.retentionDays || config.retentionDays <= 0) {
    return { skipped: true, deletedFiles: 0 };
  }

  const cutoff = Date.now() - config.retentionDays * DAY_MS;
  let deletedFiles = 0;

  for (const dir of [config.imagesDir, config.sessionsDir, config.postsDir]) {
    deletedFiles += await cleanupDir(dir, cutoff);
  }

  if (deletedFiles > 0) {
    log('info', `[cleanup] Удалено старых файлов (старше ${config.retentionDays} дн.): ${deletedFiles}`);
  }
  return { skipped: false, deletedFiles };
}

/**
 * Рекурсивно обходит директорию и удаляет файлы с mtime старше cutoff.
 * Пустые поддиректории (например, старые даты в sessions/) удаляются.
 */
async function cleanupDir(dir, cutoff) {
  let deleted = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // директории нет — нечего чистить
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        deleted += await cleanupDir(full, cutoff);
        // Удаляем поддиректорию, если она опустела.
        try {
          const remaining = await readdir(full);
          if (remaining.length === 0) await rmdir(full);
        } catch {
          /* не критично */
        }
      } else {
        const st = await stat(full);
        if (st.mtimeMs < cutoff) {
          await unlink(full);
          deleted++;
        }
      }
    } catch {
      /* файл мог исчезнуть между листингом и удалением — не критично */
    }
  }
  return deleted;
}
