// src/logger.js
// Опциональное логирование в файл с дневной ротацией.
//
// Зачем: при long-running режиме (`--schedule`) процесс висит часами/днями
// и обычные console-логи теряются между перезапусками. Этот модуль пишет
// те же строки, что и console-`log()` из config.js, в файл с суффиксом
// даты в архивах (logs/news-cast-ai.YYYY-MM-DD.log) и активным файлом
// (logs/news-cast-ai.log) на текущий день.
//
// API:
//   initLogger(config)  — открывает write-stream, если config.logFile задан.
//   log(level, message, extra) — обёртка: пишет в файл (если есть) + console
//     через console[...]; НЕ нарушает существующую сигнатуру log() в config.js.
//   closeLogger()       — синхронно закрывает stream (для graceful shutdown).
//
// Без сторонних зависимостей: только node:fs, node:path.

import { appendFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { mkdir, rename, stat, readdir, unlink } from 'node:fs/promises';
import { dirname, join, basename, extname } from 'node:path';

// --- Внутреннее состояние модуля ---
let _logFile = '';             // абсолютный/относительный путь к активному файлу
let _currentDate = '';         // YYYY-MM-DD, на которую открыт stream
let _retentionDays = 7;        // сколько архивов хранить
let _fd = null;                // sync fd для appendFileSync-эмуляции (для fsync)

/**
 * Преобразует дату в строку YYYY-MM-DD (UTC-календарный день).
 * Для ротации важна смена суток — берём UTC, чтобы не зависеть от TZ сервера.
 */
function _todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Синхронно открывает файл на append. Использует низкоуровневый openSync,
 * чтобы можно было сделать fsync перед close (гарантия записи на диск).
 */
function _openSync(file) {
  try { _closeFd(); } catch { /* noop */ }
  _fd = openSync(file, 'a');
}

/** Закрывает активный fd, если открыт, с fsync. */
function _closeFd() {
  if (_fd !== null) {
    try { fsyncSync(_fd); } catch { /* noop */ }
    try { closeSync(_fd); } catch { /* noop */ }
    _fd = null;
  }
}

/**
 * Ротация: если дата сменилась — переименовать активный файл в архив
 * с датой открытия, обновить _currentDate, открыть новый fd.
 * Потом — почистить старые архивы старше _retentionDays.
 */
async function _rotateIfNeeded() {
  if (!_logFile) return;
  const today = _todayIso();
  if (_currentDate && _currentDate === today) return; // дата не менялась

  // Закрыть текущий fd
  _closeFd();

  // Если есть непустой активный файл — переименовать в архив с датой открытия
  if (_currentDate) {
    try {
      const st = await stat(_logFile);
      if (st.size > 0) {
        const dir = dirname(_logFile);
        const ext = extname(_logFile);
        const base = basename(_logFile, ext);
        const archive = join(dir, `${base}.${_currentDate}${ext}`);
        await rename(_logFile, archive).catch(() => {
          // Если не получилось (например, файл уже не существует) — продолжаем.
        });
      }
    } catch {
      // Файла нет — первый запуск, нечего архивировать.
    }
  }

  // Открыть новый fd на сегодня
  _currentDate = today;
  try {
    _openSync(_logFile);
  } catch (e) {
     
    console.warn(`[logger] Не удалось открыть ${_logFile}: ${e.message}. Лог-файл отключён.`);
    _logFile = '';
  }

  // Cleanup старых архивов (best-effort).
  if (_logFile) {
    await _cleanupOldArchives().catch(() => { /* noop */ });
  }
}

/**
 * Удаляет архивы старше retentionDays: ищем файлы вида
 * <base>.YYYY-MM-DD<ext>, парсим дату, удаляем если старше.
 */
async function _cleanupOldArchives() {
  if (!_logFile || _retentionDays <= 0) return;
  const dir = dirname(_logFile);
  const ext = extname(_logFile);
  const base = basename(_logFile, ext); // напр. news-cast-ai
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const cutoffMs = Date.now() - _retentionDays * 24 * 60 * 60 * 1000;
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{4}-\\d{2}-\\d{2})${reExt(ext)}$`);
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const fileMs = Date.parse(m[1] + 'T00:00:00Z');
    if (Number.isFinite(fileMs) && fileMs < cutoffMs) {
      await unlink(join(dir, f)).catch(() => { /* noop */ });
    }
  }
}

// Экранирование расширения для регэкспа (на случай нестандартных символов)
function reExt(e) { return e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Инициализация логгера. Открывает файл, если config.logFile задан.
 * При ошибке — пишет warn в console, но НЕ бросает (старт не должен ломаться).
 *
 * @param {object} config
 * @param {string} [config.logFile] — путь к активному файлу (например, "logs/news-cast-ai.log").
 * @param {number} [config.logRetentionDays=7]
 */
export async function initLogger(config) {
  const file = (config && config.logFile) ? String(config.logFile).trim() : '';
  if (!file) {
    // Файловое логирование отключено — только console (поведение по умолчанию).
    _logFile = '';
    _closeFd();
    return;
  }
  _logFile = file;
  _retentionDays = (config && Number.isInteger(config.logRetentionDays) && config.logRetentionDays > 0)
    ? config.logRetentionDays
    : 7;
  try {
    await mkdir(dirname(_logFile), { recursive: true });
    await _rotateIfNeeded();
  } catch (e) {
     
    console.warn(`[logger] Не удалось открыть ${_logFile}: ${e.message}. Лог-файл отключён.`);
    _logFile = '';
    _closeFd();
  }
}

/**
 * Пишет запись в файл (если открыт) + дублирует в console.
 * Использует appendFileSync (НЕ write-stream) — это синхронно и сразу
 * сбрасывает на диск, что упрощает graceful shutdown и тесты.
 * Для логов это приемлемо: объём строк низкий.
 *
 * Формат: [ISO] [LEVEL] message {extra-json}
 *
 * @param {string} level
 * @param {string} message
 * @param {object} [extra]
 */
export function log(level, message, extra) {
  if (!_logFile) return;

  // Проверим ротацию синхронно-просто: сравним дату сейчас с _currentDate.
  // Если различаются — триггерим асинхронную ротацию, но запись всё равно
  // попадёт в текущий fd (или будет пропущена, если _fd уже закрыт в ротации).
  const today = _todayIso();
  if (_currentDate && _currentDate !== today) {
    // fire-and-forget: асинхронная ротация переименует старый файл.
    _rotateIfNeeded().catch(() => { /* noop */ });
  }

  if (_fd === null) return; // файл отключён или ещё не открыт

  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${ts}] [${String(level).toUpperCase()}] ${message}${tail}\n`;
  try {
    appendFileSync(_logFile, line, { fd: _fd });
  } catch {
    // noop — лог-файл не должен ломать основной процесс
  }
}

/**
 * Синхронно закрывает fd. Вызывать перед process.exit() на graceful shutdown.
 */
export function closeLogger() {
  _closeFd();
}

// Экспорт для тестов (не часть публичного API).
export const _internals = {
  reset() {
    _closeFd();
    _logFile = '';
    _currentDate = '';
    _retentionDays = 7;
  },
  setCurrentDateForTest(d) { _currentDate = d; },
  getCurrentDate() { return _currentDate; },
  getLogFile() { return _logFile; },
  isOpen() { return _fd !== null; },
};
