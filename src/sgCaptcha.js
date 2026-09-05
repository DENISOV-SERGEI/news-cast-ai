// src/sgCaptcha.js
// Обход SiteGround-капчи (sgcaptcha) для RSS-источников.
//
// Проблема: SiteGround (хостинг части источников, например
// artificialintelligence-news.com) по IP-репутации отдаёт JS-challenge:
//   - быстрый вариант: HTML с <meta http-equiv="refresh" .../.well-known/sgcaptcha/...>
//     (обычно статус 200/202);
//   - полный вариант: страница «Robot Challenge Screen» (статус 403).
// Обычный HTTP-клиент (undici/fetch, rss-parser) этот JS выполнить не может,
// поэтому источник падает с «Status code 403» или SAX-ошибкой парсинга.
//
// Решение: честный headless-браузер (Playwright Chromium) один раз решает
// challenge за ~10-12 секунд и получает cookie `_I_` (живёт ~месяц).
// Cookie кэшируем в database/sg_cookies.json и переиспользуем для обычных
// fetch-запросов к этому хосту без повторного запуска браузера.
//
// ВАЖНО: playwright импортируется динамически и только при фактическом
// решении капчи — в тестах и в прогонах без капчи он не грузится.

import { config, log } from './config.js';
import { fetchWithTimeout } from './http.js';
import { readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Признаки SiteGround-капчи в теле ответа. */
const CAPTCHA_MARKERS = [
  'sgcaptcha',
  'well-known/captcha',
  'Robot Challenge Screen',
];

/**
 * Единый User-Agent, под которым решаем капчу И ходим за контентом.
 * ВАЖНО: SiteGround привязывает cookie `_I_` к UA, с которым был решён
 * challenge. Если fetch-запросы пойдут с другим UA — сервер снова отдаст
 * капчу (проверено: Chrome/126 решает капчу, Chrome/124 возвращает 202/403).
 * parser.js и другие потребители обязаны использовать эту же константу.
 */
export const SG_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Возвращает true, если тело ответа похоже на SiteGround-капчу.
 * Проверка по телу, а не по статусу: быстрый вариант капчи отдаётся с 200/202,
 * и смотреть только на HTTP-код нельзя.
 */
export function looksLikeSgCaptcha(text) {
  if (!text || typeof text !== 'string') return false;
  const low = text.toLowerCase();
  return CAPTCHA_MARKERS.some((m) => low.includes(m.toLowerCase()));
}

/** hostname из URL (без www.), либо null если URL невалиден. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function cookiesPath() {
  return path.resolve(config.projectRoot, config.sgCookiesPath);
}

// --- Кэш cookie (память + файл) ---
// Структура: { version: 2, hosts: { "<host>": { saved_at, cookies: [{name,value,domain,path,expires}] } } }

let _cache = null; // lazy-load

async function loadCache() {
  if (_cache) return _cache;
  try {
    const raw = await readFile(cookiesPath(), 'utf8');
    _cache = JSON.parse(raw);
  } catch {
    _cache = { version: 2, hosts: {} };
  }
  if (!_cache.hosts) _cache.hosts = {};
  if (!_cache.version) _cache.version = 2;
  return _cache;
}

async function saveCache() {
  if (!_cache) return;
  try {
    await writeFile(cookiesPath(), JSON.stringify(_cache, null, 2), 'utf8');
  } catch (e) {
    log('warn', `[sg] Не удалось сохранить кэш cookie (${cookiesPath()}): ${e.message}`);
  }
}

// --- Работа с cookie для хоста ---
function cookieIsLive(c) {
  return c && c.value && (c.expires === undefined || c.expires === -1 || (c.expires * 1000) > Date.now());
}

/** Возвращает массив живых cookie для хоста, либо null если их нет. */
async function getLiveCookies(host) {
  const cache = await loadCache();
  const entry = cache.hosts?.[host];
  if (!entry?.cookies?.length) return null;
  const live = entry.cookies.filter(cookieIsLive);
  return live.length ? live : null;
}

function cookiesToHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// --- Решение капчи через Playwright ---

/** Ищет исполняемый файл Chromium для Playwright. */
function findChromiumExecutable() {
  // 1) Явная настройка окружения.
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH && fs.existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  // 2) Каталог ms-playwright (Windows): %LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win*\chrome.exe.
  const candidates = [];
  for (const base of [process.env.LOCALAPPDATA, path.join(os.homedir(), 'AppData', 'Local')]) {
    if (base) candidates.push(path.join(base, 'ms-playwright'));
  }
  for (const dir of candidates) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !/^chromium-\d+$/.test(e.name)) continue;
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const exe = path.join(dir, e.name, sub, 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

/**
 * Запускает headless Chromium, переходит на url и дожидается, пока SG-challenge
 * решится. Возвращает массив cookie для хоста (или null при неудаче).
 * Не бросает исключений — все ошибки внутри превращаются в возврат null.
 */
async function solveSgChallenge(url, host) {
  const t0 = Date.now();
  let browser;
  try {
    const { chromium } = await import('playwright'); // ленивый импорт
    const executablePath = findChromiumExecutable();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const context = await browser.newContext({
      userAgent: SG_BROWSER_UA,
    });
    const page = await context.newPage();
    await page.goto(url, { timeout: 40_000, waitUntil: 'networkidle' });
    // Challenge решается JS-движком за ~10-12 с; даём время на редирект.
    await page.waitForTimeout(12_000);
    const finalUrl = page.url();
    if (looksLikeSgCaptcha(finalUrl)) return null;

    const cookieUrl = `https://${host}`; // Playwright cookies() фильтрует по url
    let cookies = await context.cookies(cookieUrl);
    cookies = cookies.filter((c) => c.value && (c.expires === -1 || (c.expires * 1000) > Date.now()));
    if (!cookies.length) return null;
    log('info', `[sg] ${host}: капча решена за ${((Date.now() - t0) / 1000).toFixed(0)}с, cookie: ${cookies.map((c) => c.name).join(',')}`);
    return cookies;
  } catch (e) {
    log('warn', `[sg] ${host}: не удалось решить капчу через Playwright: ${e.message}`);
    return null;
  } finally {
    try { await browser?.close(); } catch { /* noop */ }
  }
}

/** Решает капчу и сохраняет cookie в кэш. Возвращает сохранённые cookie или null. */
async function resolveAndStore(host, url) {
  const cookies = await solveSgChallenge(url, host);
  if (!cookies) return null;
  const cache = await loadCache();
  cache.hosts[host] = {
    saved_at: new Date().toISOString(),
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || host,
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
    })),
  };
  await saveCache();
  return cache.hosts[host].cookies;
}

// --- Публичный fetch с авт-решением капчи ---

/**
 * fetchWithTimeout с поддержкой SiteGround-капчи.
 *
 * Поведение:
 *   1. Сначала пробуем с кэшированными cookie (если есть для этого хоста).
 *   2. Если пришёл ответ-капча и resolver включён — решаем через Playwright,
 *      сохраняем cookie и повторяем запрос.
 *   3. Если повтор всё равно капча — бросаем ошибку (не зацикливаемся).
 *
 * Возвращает строку тела ответа (для парсинга). Статус/headers наружу не
 * отдают — все проверки внутри. Обычные HTTP-ошибки бросаются как раньше.
 *
 * @param {string} url
 * @param {object} [opts] — fetch-опции (method, headers, body, …).
 * @param {object} [httpOpts] — опции fetchWithTimeout (timeoutMs, …).
 * @returns {Promise<string>}
 */
export async function fetchWithSg(url, opts = {}, httpOpts = {}) {
  const host = hostOf(url);

  const attempt = async (cookies) => {
    const headers = { ...(opts.headers || {}) };
    const cookieStr = cookies ? cookiesToHeader(cookies) : '';
    if (cookieStr) headers.Cookie = cookieStr;
    const res = await fetchWithTimeout(url, { ...opts, headers }, httpOpts);
    const text = await res.text();
    return { res, text };
  };

  const firstCookies = host ? await getLiveCookies(host) : null;
  // Отладка: что у нас в кэше и какой ответ приходит с первым cookie.
  log('debug', `[sg:debug] ${host}: firstCookies=${firstCookies ? firstCookies.map(c => c.name).join(',') : 'НЕТ'}`);
  let { res, text } = await attempt(firstCookies);
  log('debug', `[sg:debug] ${host}: первый ответ status=${res.status} isCaptcha=${looksLikeSgCaptcha(text)}`);

  // Быстрый путь: нормальный ответ без капчи.
  if (!looksLikeSgCaptcha(text)) {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return text;
  }

  // Пришли с капчей. Если resolver отключён — отдаём ошибку как раньше.
  if (!config.features.sgResolver) {
    throw new Error(`HTTP ${res.status} (SiteGround-captcha, resolver отключён)`);
  }

  log('warn', `[sg] ${host}: получена капча (HTTP ${res.status}) — решаю через Playwright`);
  const cookies = await resolveAndStore(host, url);
  if (!cookies) throw new Error(`SG-captcha для ${host}: не удалось получить cookie`);

  // Повторная попытка с полученным cookie.
  ({ res, text } = await attempt(cookies));
  if (looksLikeSgCaptcha(text)) {
    throw new Error(`SG-captcha для ${host}: капча вернулась после решения (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return text;
}
