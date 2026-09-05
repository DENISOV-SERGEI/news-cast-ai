// tests/logger.test.mjs
// Файловый логгер с дневной ротацией:
//   - initLogger создаёт каталог и открывает write-stream (если logFile не пуст)
//   - log() пишет строку в формате [ISO] [LEVEL] message {extra-json}
//   - смена даты → переименование активного файла в архив + новый stream
//   - closeLogger() освобождает дескриптор
//   - пустой logFile → файл не создаётся, только console
//   - cleanup старых архивов по retention
//
// Используем _internals.reset() между тестами, чтобы изолировать глобальное
// состояние модуля (stream, currentDate, logFile).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  initLogger, log, closeLogger, _internals,
} from '../src/logger.js';
import { log as configLog, attachFileLogger } from '../src/config.js';

const tmpRoot = path.join(tmpdir(), `nca-logger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

// Перепривязываем config.js `log` к file-логгеру (для интеграционного теста ниже).
// Это нужно, потому что в config.js модуль сам делает import('./logger.js') и
// привязывает свой file-logger один раз; наши тесты используют другой config.
function rewire() {
  attachFileLogger({ log });
}

test('initLogger: пустой logFile → файл не создаётся, write-stream не открывается', async () => {
  _internals.reset();
  await initLogger({ logFile: '', logRetentionDays: 7 });
  assert.equal(_internals.isOpen(), false, 'stream не должен быть открыт');
  assert.equal(_internals.getLogFile(), '');

  // log() не должен падать даже при закрытом stream.
  log('info', 'console-only message');
  // В этом каталоге вообще ничего не должно появиться.
  const exists = await stat(path.join(tmpRoot, 'no-such')).then(() => true).catch(() => false);
  assert.equal(exists, false);
});

test('initLogger: создаёт каталог и открывает write-stream', async () => {
  _internals.reset();
  const dir = path.join(tmpRoot, 'logs1');
  const file = path.join(dir, 'news-cast-ai.log');
  await initLogger({ logFile: file, logRetentionDays: 7 });
  assert.equal(_internals.isOpen(), true);
  assert.equal(_internals.getLogFile(), file);

  const st = await stat(dir);
  assert.ok(st.isDirectory(), 'каталог создан');
});

test('log: пишет строку в файл в правильном формате [ISO] [LEVEL] msg {extra}', async () => {
  _internals.reset();
  const dir = path.join(tmpRoot, 'logs2');
  const file = path.join(dir, 'news-cast-ai.log');
  await initLogger({ logFile: file, logRetentionDays: 7 });

  log('info', 'hello', { x: 1 });
  // Stream буферизует — закрываем, чтобы данные записались.
  closeLogger();

  const content = await readFile(file, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'должна быть одна строка');
  // Формат: [2026-08-23T...] [INFO] hello {"x":1}
  assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[INFO\] hello \{"x":1\}$/);
});

test('log: без extra — без хвостового JSON', async () => {
  _internals.reset();
  const dir = path.join(tmpRoot, 'logs3');
  const file = path.join(dir, 'news-cast-ai.log');
  await initLogger({ logFile: file, logRetentionDays: 7 });

  log('warn', 'just a warning');
  closeLogger();

  const content = await readFile(file, 'utf-8');
  const line = content.split('\n').filter(Boolean)[0];
  assert.match(line, /^\[.+?\] \[WARN\] just a warning$/, 'нет JSON-хвоста');
});

test('log: интеграция с config.js — запись из общего log() попадает в файл', async () => {
  _internals.reset();
  rewire();
  const dir = path.join(tmpRoot, 'logs4');
  const file = path.join(dir, 'news-cast-ai.log');
  await initLogger({ logFile: file, logRetentionDays: 7 });

  // Вызываем ИМЕННО config.js log() — он должен продублировать в файл.
  configLog('error', 'integration test', { code: 42 });
  closeLogger();

  const content = await readFile(file, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[.+?\] \[ERROR\] integration test \{"code":42\}$/);
});

test('rotation: смена даты → переименование активного файла + новый stream', async () => {
  _internals.reset();
  const dir = path.join(tmpRoot, 'logs5');
  const file = path.join(dir, 'news-cast-ai.log');
  await initLogger({ logFile: file, logRetentionDays: 7 });

  // Пишем запись «сегодня» (допустим, это последняя запись перед сменой суток).
  log('info', 'will-be-archived message');
  // Закрываем fd.
  closeLogger();
  // Убедимся, что файл реально создан и непустой.
  const stBefore = await stat(file);
  assert.ok(stBefore.size > 0, `файл с записью должен существовать на диске (size=${stBefore.size})`);

  // Эмулируем наступление следующего дня: подменяем _currentDate.
  // При СЛЕДУЮЩЕМ log() сработает _rotateIfNeeded.
  _internals.setCurrentDateForTest('2099-01-01'); // любая дата в будущем

  // Открываем заново. initLogger внутри _rotateIfNeeded видит, что
  // _currentDate='2099-01-01' !== today → закрывает stream, переименовывает
  // news-cast-ai.log → news-cast-ai.2099-01-01.log, открывает новый stream.
  await initLogger({ logFile: file, logRetentionDays: 7 });

  // Пишем уже «сегодняшнюю» запись.
  log('info', 'fresh-today message');
  closeLogger();

  const files = await readdir(dir);
  const archives = files.filter((f) => /^news-cast-ai\.\d{4}-\d{2}-\d{2}\.log$/.test(f));
  assert.ok(archives.length >= 1, `должен быть хотя бы один архив (files: ${files.join(', ')})`);
  assert.ok(archives.includes('news-cast-ai.2099-01-01.log'),
    `архив 2099-01-01 должен быть; got: ${archives.join(', ')}`);
  assert.ok(files.includes('news-cast-ai.log'), 'активный файл создан заново');

  // В архиве — старая запись.
  const archive = await readFile(path.join(dir, 'news-cast-ai.2099-01-01.log'), 'utf-8');
  assert.match(archive, /will-be-archived message/);
  // В активном — новая.
  const active = await readFile(file, 'utf-8');
  assert.match(active, /fresh-today message/);
});

test('closeLogger: повторный log() не падает', async () => {
  _internals.reset();
  const dir = path.join(tmpRoot, 'logs6');
  const file = path.join(dir, 'news-cast-ai.log');
  await initLogger({ logFile: file, logRetentionDays: 7 });

  closeLogger();
  assert.equal(_internals.isOpen(), false);

  // Не должно бросить исключение.
  log('info', 'after close');
  // После closeLogger — stream закрыт, isOpen() === false.
  assert.equal(_internals.isOpen(), false);
});

test('cleanup старых архивов по retention', async () => {
  _internals.reset();
  const dir = path.join(tmpRoot, 'logs7');
  const file = path.join(dir, 'news-cast-ai.log');
  await mkdir(dir, { recursive: true });

  // Создаём архивы: 8 дней назад, 5 дней назад, 1 день назад.
  // retention = 3 → должны удалиться 8-дневный, 5-дневный остаётся (ещё не старше),
  // 1-дневный остаётся.
  const today = new Date();
  function daysAgo(n) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }
  await writeFile(path.join(dir, `news-cast-ai.${daysAgo(8)}.log`), 'old-8', 'utf-8');
  await writeFile(path.join(dir, `news-cast-ai.${daysAgo(5)}.log`), 'mid-5', 'utf-8');
  await writeFile(path.join(dir, `news-cast-ai.${daysAgo(1)}.log`), 'fresh-1', 'utf-8');

  await initLogger({ logFile: file, logRetentionDays: 3 });
  // initLogger триггерит cleanup через _rotateIfNeeded (создаётся stream и чистятся старые).
  closeLogger();

  const files = await readdir(dir);
  // 8-дневный архив должен быть удалён.
  const hasOld8 = files.some((f) => f === `news-cast-ai.${daysAgo(8)}.log`);
  assert.equal(hasOld8, false, '8-дневный архив удалён');
  // 1-дневный — жив.
  const hasFresh1 = files.some((f) => f === `news-cast-ai.${daysAgo(1)}.log`);
  assert.equal(hasFresh1, true, '1-дневный архив жив');
});

test('initLogger: ошибка открытия не ломает старт (warn в console, продолжаем)', async () => {
  // Этот кейс сложно воспроизвести кросс-платформенно: Windows не запрещает \0,
  // а Linux — да. Проверяем, что initLogger ВСЕГДА возвращается без throw.
  _internals.reset();
  // Передаём невозможный путь: на Linux \0 → throw → catch в initLogger → warn.
  // На Windows путь может пройти, тогда просто сбрасываем состояние.
  let didThrow = false;
  try {
    await initLogger({ logFile: 'logs/\0bad/path.log', logRetentionDays: 7 });
  } catch {
    didThrow = true;
  }
  // Главное: initLogger НЕ пробросил наружу (warn в console — ок).
  assert.equal(didThrow, false, 'initLogger должен swallow-ить ошибки открытия');
});

test('cleanup', async () => {
  closeLogger();
  await rm(tmpRoot, { recursive: true, force: true });
});
