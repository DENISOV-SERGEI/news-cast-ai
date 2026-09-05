// src/rateLimit.js
// Простой per-name гейт минимального интервала между вызовами.
//
// Зачем: Telegram/VK банят бота при всплеске запросов (Telegram — ~30 сообщений
// в секунду, VK — error_code=6 "Too many requests"). Даже при пост-интервале 60с
// всплеск возможен: публикация + monitoring-алерт + retry-волна. Гейт держит
// min интервал между запросами к одному API.
//
// Использование:
//   await rateLimit('telegram', config.telegramRateLimitMs); // перед API-вызовом
//
// Состояние in-process (Map по имени гейта). Для одного long-running процесса
// этого достаточно; между запусками процесса гейт не нужен — пост-интервал
// и так разносит запуски во времени.

import { sleep } from './utils.js';

const gates = new Map();

/**
 * Блокирует вызывающего, пока не истечёт min интервал с прошлого вызова этого name.
 * Не имеет «токенов» — это просто сериализатор: параллельные await выстроятся
 * в очередь (т.к. JS однопоточный, обновление gates.last атомарно между await).
 *
 * @param {string} name — имя гейта (напр. 'telegram', 'vk').
 * @param {number} minIntervalMs — минимальный интервал между вызовами (0 — без гейта).
 */
export async function rateLimit(name, minIntervalMs = 0) {
  if (!minIntervalMs || minIntervalMs <= 0) return;
  let g = gates.get(name);
  if (!g) {
    g = { last: 0, min: minIntervalMs };
    gates.set(name, g);
  }
  if (minIntervalMs > g.min) g.min = minIntervalMs;

  const now = Date.now();
  // Резервируем слот СИНХРОННО, до любого await: тогда несколько параллельных
  // вызовов в одном тике событийного цикла выстроятся в очередь (каждый следующий
  // видит уже сдвинутое g.last). Если бы писали g.last после sleep, все параллельные
  // вызовы читали бы старое значение и не разносились по интервалу.
  const slot = Math.max(g.last + g.min, now);
  g.last = slot;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

/** Сброс гейта(ов) — для тестов. Без аргументов — сбрасывает все. */
export function _resetRateLimit(name) {
  if (name) gates.delete(name);
  else gates.clear();
}