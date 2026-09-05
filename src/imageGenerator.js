// Генерация картинок через ProxyAPI (OpenAI-совместимый endpoint, модель gpt-image-1-mini).
//
// Поведение:
//   - Сначала кэш-лукап по хешу промпта (database/image_cache.json) — попадание
//     переиспользует файл без вызова ProxyAPI.
//   - При промахе: POST {proxyApiBase}/images/generations, до 3 ретраев на 429/5xx.
//   - Принимает ответ с .data[0].b64_json или .data[0].url.
//   - Сохраняет PNG в imagesDir под именем img-<hash16>.png (уникальным для промпта).
//
// Имя по хешу — фикс бага B1: фиксированное article-{index}.png затирало чужие
// картинки при каждом прогоне. Теперь одинаковые промпты → один файл (кэш +
// экономия), разные → разные файлы (без коллизий). index используется только для логов.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { config, log } from './config.js';
import { fetchWithTimeout } from './http.js';
import { cacheKey, lookupImageCache, saveImageToCache } from './imageCache.js';
import { sleep } from './utils.js';

const RETRY_DELAYS_MS = [1500, 4000, 9000];

// Целевой размер картинки: площадь 1024×1024 уменьшаем в 1,5 раза
// (требование владельца 2026-09-04 — «изображение слишком большое»).
// gpt-image-1-mini умеет только 1024x1024 / 1536x1024 / 1024x1536, поэтому
// генерим 1024x1024 и даунскейлим локально: сторона = 1024 / √1,5 ≈ 836.
const SOURCE_API_SIZE = '1024x1024';
export const TARGET_IMAGE_SIZE_PX = Math.round(1024 / Math.sqrt(1.5)); // 836

/** Ключ кэша завязан на целевой размер — старые 1024-переписи не переиспользуем. */
export function imageCacheKey(prompt) {
  return cacheKey(`${String(prompt || '').trim()}\n[size ${TARGET_IMAGE_SIZE_PX}x${TARGET_IMAGE_SIZE_PX}]`);
}

/**
 * Даунскейлит PNG-буфер до TARGET_IMAGE_SIZE_PX × TARGET_IMAGE_SIZE_PX.
 * Картинки меньше целевого размера (например, тестовые 1x1) не трогаем.
 */
async function downscalePng(buf) {
  const img = await Jimp.read(buf);
  if (img.bitmap.width <= TARGET_IMAGE_SIZE_PX && img.bitmap.height <= TARGET_IMAGE_SIZE_PX) {
    return buf;
  }
  img.resize({ w: TARGET_IMAGE_SIZE_PX, h: TARGET_IMAGE_SIZE_PX });
  return img.getBuffer('image/png');
}

async function ensureDir(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function postJson(url, body) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.proxyApiKey}`,
    },
    body: JSON.stringify(body),
  }, { timeoutMs: 60_000 }); // генерация картинки gpt-image-1-mini может занять десятки секунд
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ProxyAPI: невалидный JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const err = json.error?.message || json.message || text.slice(0, 300);
    const e = new Error(`ProxyAPI HTTP ${res.status}: ${err}`);
    e.status = res.status;
    e.retryable = res.status === 429 || res.status >= 500;
    throw e;
  }
  return json;
}

async function fetchToBuffer(url) {
  const res = await fetchWithTimeout(url, {}, { timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Не удалось скачать картинку: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Генерирует изображение (или возвращает закэшированное) и сохраняет под именем,
 * уникальным для промпта: `images/img-<hash16>.png`.
 *
 * Имя по хешу промпта — это фикс бага B1: раньше было фиксированное `article-N.png`,
 * и каждый прогон затирал чужие картинки. Теперь одинаковые промпты → один файл
 * (переиспользование + экономия ProxyAPI), разные → разные файлы (без коллизий).
 *
 * @param {string} prompt — промпт для gpt-image-1-mini (image_prompt из JSON поста).
 * @param {number} index — порядковый номер статьи (только для логов).
 * @returns {Promise<{ filepath: string, bytes: number, filename: string, cached: boolean }>}
 */
export async function generateImage(prompt, index = 1) {
  if (!prompt || !prompt.trim()) {
    throw new Error('Пустой prompt для генерации изображения');
  }

  const key = imageCacheKey(prompt);

  // 1) Кэш-лукап: если для этого промпта уже генерили — переиспользуем файл,
  //    ProxyAPI не дёргаем.
  const hit = await lookupImageCache(key);
  if (hit) {
    log('info', `Картинка [${index}]: кэш-попад (key=${key}), переиспользую ${hit.filepath}`);
    return { filepath: hit.filepath, bytes: hit.bytes, filename: path.basename(hit.filepath), cached: true };
  }

  const url = `${config.proxyApiBase.replace(/\/$/, '')}/images/generations`;
  const body = {
    model: config.proxyImageModel,
    prompt,
    n: 1,
    size: SOURCE_API_SIZE,
  };

  await ensureDir(config.imagesDir);
  const filename = `img-${key}.png`;
  const filepath = path.join(config.imagesDir, filename);

  log('info', `Генерирую картинку [${index}] (model=${config.proxyImageModel}, key=${key}) → ${filename}`);

  let lastErr;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    try {
      const json = await postJson(url, body);
      const item = Array.isArray(json.data) ? json.data[0] : null;
      if (!item) throw new Error('ProxyAPI: ответ без data[0]');

      let buf;
      if (item.b64_json) {
        buf = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        buf = await fetchToBuffer(item.url);
      } else {
        throw new Error('ProxyAPI: data[0] не содержит b64_json или url');
      }

      // Даунскейл до целевого размера (площадь в 1,5 раза меньше 1024²).
      // Сбой ресайза не фатален: публикуем оригинал, чтобы не сорвать пост.
      let outBuf = buf;
      try {
        outBuf = await downscalePng(buf);
      } catch (e) {
        log('warn', `Не удалось даунскейлить картинку (${e.message}) — сохраняю оригинал`);
      }

      await writeFile(filepath, outBuf);
      // Запоминаем в кэше, чтобы следующий прогон с тем же промптом не генерил заново.
      await saveImageToCache(key, prompt, filepath, outBuf.length);
      log('info', `Картинка сохранена: ${filepath} (${outBuf.length} байт)`);
      return { filepath, bytes: outBuf.length, filename, cached: false };
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
      if (attempt < RETRY_DELAYS_MS.length - 1 && retryable) {
        const delay = RETRY_DELAYS_MS[attempt];
        log('warn', `Попытка ${attempt + 1} не удалась: ${e.message}. Повтор через ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
