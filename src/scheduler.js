// scheduler.js
// Оркестратор полного цикла: parse → adapt → generateImage → publish.
// Один источник истины для dry-run и боевого прогона.
//
// Поток для одной статьи (runOnceNow):
//   1) adaptArticle (Ollama Cloud, 2 этапа) → posts/article-N.json
//   2) generateImage (ProxyAPI)            → images/article-N.png, обновляет json
//   3) publishPost (Telegram)              — основная публикация
//   4) writeZenDraft                       — markdown в drafts/ (best-effort)
//   5) publishToVK                         — wall.post (best-effort, требует VK_*)
//   6) publishToSite                       — WP REST draft (best-effort, требует SITE_*)
//
// Каждый шаг в собственном try/catch: падение одной площадки не роняет другие.
// Суммарный статус статьи — ok=true, если хотя бы Telegram-публикация успешна
// (или dry-run). Все ошибки отправляются в TELEGRAM_ERROR_CHAT_ID (если задан).

import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import cron from 'node-cron';
import { parseWithStats, parseAllWithStats, persistArticles, NoFreshArticlesError } from './parser.js';
import { adaptArticle } from './adapter.js';
import { generateImage } from './imageGenerator.js';
import { publishPost } from './publisher.js';
import { publishToVK, checkVKAccess } from './publisher.vk.js';
import { publishToSite, checkSiteAccess } from './publisher.site.js';
import { exportSiteNews } from './siteNews.js';
import { exportSiteArticles } from './siteArticles.js';
import { deploySiteFiles } from './deploySite.js';
import { cleanupOldFiles } from './cleanup.js';
import { publishToDzenSync, checkDzenSyncAccess } from './publisher.dzen.js';
import { writeZenDraft } from './drafts.js';
import { isAlreadyPublished, markPublished, getStats } from './dedup.js';
import { reportError, reportInfo, maybeSendDailyReport } from './monitoring.js';
import { retryWithBackoff } from './retry.js';
import {
  createPendingRun, addPendingArticle, finalizePendingRun, readPendingRun,
  updatePendingArticle, articleImagePath,
} from './pending.js';
import { appendRun } from './runs.js';
import { closeLogger } from './logger.js';
import { log, config } from './config.js';
import { parseScheduleCsv } from './utils.js';

function toIsoMaybe(d) {
  if (!d) return new Date().toISOString();
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}

/** Складывает usage-объекты Ollama (prompt/completion/total tokens). null-устойчив. */
function addUsage(acc, u) {
  if (!u) return acc;
  const n = (k) => (typeof u[k] === 'number' ? u[k] : 0);
  const a = acc || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  a.prompt_tokens += n('prompt_tokens');
  a.completion_tokens += n('completion_tokens');
  a.total_tokens += n('total_tokens') || (n('prompt_tokens') + n('completion_tokens'));
  return a;
}

// === Graceful shutdown ===
// В --schedule режиме ловим SIGINT/SIGTERM: ставим флаг, и runOnceNow
// корректно завершает текущую статью (включая markPublished — иначе
// при следующем запуске дедуп её не сработает и статья опубликуется дублем).
let shutdownRequested = false;
let shutdownSignal = null;

export function installShutdownHandlers() {
  const handler = (sig) => {
    if (shutdownRequested) {
      // Повторный Ctrl+C — пользователь требует немедленного выхода
      log('warn', `[shutdown] Повторный ${sig} — аварийный выход`);
      // Сбрасываем буфер write-stream лог-файла (если открыт), чтобы последняя строка
      // попала на диск перед exit. closeLogger синхронный.
      try { closeLogger(); } catch { /* noop */ }
      process.exit(130);
    }
    shutdownRequested = true;
    shutdownSignal = sig;
    log('warn', `[shutdown] Получен ${sig}. Завершаю текущую статью и останавливаюсь…`);
  };
  process.once('SIGINT', () => handler('SIGINT'));
  process.once('SIGTERM', () => handler('SIGTERM'));
}

function isShuttingDown() {
  return shutdownRequested;
}

function resetShutdown() {
  shutdownRequested = false;
  shutdownSignal = null;
}

/**
 * Возвращает «чистый» hostname источника для группировки в pickBySource.
 * Использует `new URL(a.url).hostname`, нормализует в нижний регистр и
 * убирает префикс `www.` — чтобы RSS-вариант и HTML-вариант одного домена
 * считались одним источником. Если URL невалидный — fallback на пустую
 * строку (такие статьи попадут в общую группу 'unknown' и пройдут
 * pickBySource как один источник).
 */
function sourceKeyOf(article) {
  if (!article || !article.url) return 'unknown';
  try {
    let host = new URL(article.url).hostname || '';
    host = host.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Выбирает по 1 свежей статье на источник: группирует `articles` по
 * hostname (lowercase, без www.), внутри группы сортирует по `publishedAt desc`,
 * затем для каждой группы берёт первую статью, у которой `dedupFn(a) === { duplicate: false }`.
 *
 * Если все статьи источника — дубликаты, источник выпадает.
 * Статьи без `publishedAt` идут в конец своей группы (через `Date.parse ?? 0`).
 *
 * @param {Array<{url?: string, publishedAt?: Date|string|null}>} articles
 * @param {(a:any)=>Promise<{duplicate:boolean, [k:string]:any}>} dedupFn — асинхронная проверка дубля.
 *   Контракт: возвращает объект с полем `duplicate`; нас интересует только `=== false`.
 * @returns {Promise<{picked: Array, byGroups: Map<string, Array>, droppedDup: number, droppedEmpty: number}>}
 *   - picked       — выбранные статьи (порядок: убывание свежести самой свежей статьи источника).
 *   - byGroups     — все группы (для отладки/тестов).
 *   - droppedDup   — сколько статей было отброшено как дубликаты.
 *   - droppedEmpty — сколько групп полностью «пустые» (все статьи — дубликаты).
 */
export async function pickBySource(articles, dedupFn) {
  const byGroups = new Map();
  for (const a of articles || []) {
    const key = sourceKeyOf(a);
    if (!byGroups.has(key)) byGroups.set(key, []);
    byGroups.get(key).push(a);
  }

  // Внутри каждой группы сортируем по publishedAt desc. Без даты — в конец.
  for (const list of byGroups.values()) {
    list.sort((x, y) => {
      const tx = x && x.publishedAt ? Date.parse(x.publishedAt) || 0 : 0;
      const ty = y && y.publishedAt ? Date.parse(y.publishedAt) || 0 : 0;
      return ty - tx;
    });
  }

  const picked = [];
  let droppedDup = 0;
  let droppedEmpty = 0;

  // Порядок обхода: источники с самой свежей статьёй — первыми.
  const groupOrder = Array.from(byGroups.entries())
    .map(([key, list]) => {
      const head = list[0];
      const headTs = head && head.publishedAt ? Date.parse(head.publishedAt) || 0 : 0;
      return { key, list, headTs };
    })
    .sort((a, b) => b.headTs - a.headTs);

  for (const { list } of groupOrder) {
    let found = null;
    for (const a of list) {
       
      const dup = await dedupFn(a);
      if (dup && dup.duplicate) {
        droppedDup++;
        continue;
      }
      found = a;
      break;
    }
    if (found) picked.push(found);
    else droppedEmpty++;
  }

  return { picked, byGroups, droppedDup, droppedEmpty };
}

/**
 * Запускает шаг, ловит ошибку, логирует + отправляет в monitoring, возвращает result.
 *
 * @param {string} name — метка шага (для логов/алертов).
 * @param {function} fn — async-функция без аргументов.
 * @param {object} [opts]
 * @param {boolean} [opts.retry=true] — оборачивать ли fn в retryWithBackoff.
 *   Выключать для шагов, которые ретраят самостоятельно (generateImage),
 *   иначе получим 3×3 = до 9 попыток.
 */
async function safeStep(name, fn, opts = {}) {
  const useRetry = opts.retry !== false;
  try {
    const result = useRetry
      ? await retryWithBackoff(fn, { retries: 3, baseMs: 1000, factor: 2, label: name })
      : await fn();
    return { ok: true, result };
  } catch (err) {
    log('error', `[${name}] ${err.message}`);
    reportError(err, { step: name });
    return { ok: false, error: err.message };
  }
}

/**
 * Один полный прогон пайплайна.
 *
 * @param {string|string[]} input — URL (один источник) или массив URL (несколько).
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — пропустить публикацию и задержки.
 * @param {boolean} [opts.review=false] — ручная модерация: генерация без публикации,
 *   артефакты складываются в pending/<id>/ (self-contained manifest + картинки),
 *   публикация позже через --publish-pending <id>. dedup НЕ отмечается.
 * @param {boolean} [opts.skipDedup=false] — отключить дедупликацию (для отладки/теста).
 * @param {boolean} [opts.skipFresh=false] — отключить фильтр свежести (если уже отключен в config — неважно).
 * @param {number} [opts.limit] — сколько статей брать (по умолчанию config.articlesPerRun).
 * @returns {Promise<{found: number, fresh: number, dedupSkipped: number, processed: number, results: Array, interrupted: boolean, pendingId?: string}>}
 */
export async function runOnceNow(input, opts = {}) {
  const startedAtMs = Date.now();
  const dryRun = !!opts.dryRun;
  const review = !!opts.review;
  const skipPublish = dryRun || review; // ни dry-run, ни review никуда не публикуют
  const limit = opts.limit || config.articlesPerRun || 3;
  const mode = dryRun ? 'dry-run' : review ? 'review' : 'once';

  // Аккумулятор токенов Ollama по статьям прогона (для отчёта наблюдаемости O1).
  let runTokens = null;
  // Результат автодеплоя (последний в прогоне) — для отчёта наблюдаемости.
  let deploySummary = null;
  /** Записывает прогон в историю runs.json. times/mode/sources/tokens/deploy подставляются. */
  const recordRun = (fields) => appendRun({
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAtMs,
    mode,
    sources: sources.length,
    tokens: runTokens,
    deploy: deploySummary,
    ...fields,
  });

  // 1) Парсинг. Если передали массив — fetchAndParseAll, иначе один источник.
  //    Используем *WithStats-варианты, чтобы получить честные счётчики
  //    фильтра свежести (B5): fresh / no_date / stale,
  //    плюс пре-адаптационных фильтров: source_blocked / stopword_filtered.
  const sources = Array.isArray(input) ? input : [input];
  let all;
  let freshStats = { fresh: 0, stale: 0, noDate: 0, sourceBlocked: 0, stopwordFiltered: 0 };
  let totalCards = 0;
  try {
    if (sources.length > 1) {
      const r = await parseAllWithStats(sources);
      all = r.articles;
      freshStats = r.stats;
      totalCards = r.total;
    } else {
      const r = await parseWithStats(sources[0]);
      all = r.articles;
      freshStats = r.stats;
      totalCards = r.total;
    }
  } catch (e) {
    if (e instanceof NoFreshArticlesError) {
      log('info', `runOnceNow: ${e.message} — прогон завершён без действий`);
      await recordRun({
        found: 0,
        fresh_count: freshStats.fresh || 0,
        no_date_count: freshStats.noDate || 0,
        stale_count: freshStats.stale || 0,
        source_blocked: freshStats.sourceBlocked || 0,
        stopword_filtered: freshStats.stopwordFiltered || 0,
        dedup_skipped: 0,
        processed: 0,
        ok: 0,
        fail: 0,
        interrupted: isShuttingDown(),
      });
      return {
        found: 0, fresh: 0, dedupSkipped: 0, processed: 0,
        results: [], interrupted: isShuttingDown(),
        noDate: freshStats.noDate || 0, stale: freshStats.stale || 0,
        sourceBlocked: freshStats.sourceBlocked || 0,
        stopwordFiltered: freshStats.stopwordFiltered || 0,
      };
    }
    throw e;
  }

  // 2) Дедупликация: пропускаем уже опубликованные
  let articles = all;
  let dedupSkipped = 0;
  if (!opts.skipDedup) {
    const stats = await getStats();
    log('info', `Реестр публикаций: ${stats.urls} URL, ${stats.slugs} slug (обновлён ${stats.updated_at})`);
    const filtered = [];
    for (const a of articles) {
      const dup = await isAlreadyPublished(a);
      if (dup.duplicate) {
        dedupSkipped++;
        log('info', `[dedup] Пропускаю (уже публиковалось по ${dup.reason}): "${a.title}" — ${dup.existingUrl || dup.existingSlug}`);
      } else {
        filtered.push(a);
      }
    }
    articles = filtered;
  }

  // 2.5) pickBySource: «по 1 свежей статье на источник». Гарантирует,
  // что один жирный источник (например, TechCrunch с 20 свежими) не забьёт
  // всю выборку — каждый источник представлен максимум одной статьёй.
  // Если у нескольких источников несколько свежих статей — внутри источника
  // берём самую свежую, остальные идут следующими кандидатами, если первая
  // — дубль. dedupFn использует уже подгруженный выше реестр публикаций.
  let pickDroppedDup = 0;
  let pickDroppedEmpty = 0;
  if (!opts.skipDedup) {
    const pickResult = await pickBySource(articles, isAlreadyPublished);
    pickDroppedDup = pickResult.droppedDup;
    pickDroppedEmpty = pickResult.droppedEmpty;
    log('info', `pickBySource: выбрано ${pickResult.picked.length}/${pickResult.byGroups.size} источников (dropped_dup=${pickDroppedDup}, dropped_empty=${pickDroppedEmpty})`);
    articles = pickResult.picked;
  } else {
    // В --skipDedup режиме pickBySource не нужен — берём все.
    // Оставляем на случай ручной отладки/теста.
  }

  if (articles.length === 0) {
    log('info', `runOnceNow: нет новых статей для публикации (dedupSkipped=${dedupSkipped}, pickDroppedDup=${pickDroppedDup})`);
    await recordRun({
      found: totalCards,
      fresh_count: freshStats.fresh,
      no_date_count: freshStats.noDate,
      stale_count: freshStats.stale,
      source_blocked: freshStats.sourceBlocked,
      stopword_filtered: freshStats.stopwordFiltered,
      dedup_skipped: dedupSkipped,
      dropped_dup_pick: pickDroppedDup,
      processed: 0,
      ok: 0,
      fail: 0,
      interrupted: isShuttingDown(),
    });
    return {
      found: totalCards, fresh: freshStats.fresh, dedupSkipped, processed: 0,
      results: [], interrupted: isShuttingDown(),
      noDate: freshStats.noDate, stale: freshStats.stale,
      sourceBlocked: freshStats.sourceBlocked,
      stopwordFiltered: freshStats.stopwordFiltered,
    };
  }

  // 3) Применяем лимит. В новой pickBySource-логике число статей = число
  // уникальных источников (≤ ARTICLES_PER_RUN), так что slice на практике
  // сработает только если limit < количества источников. И наоборот: если
  // limit > количества — берём сколько есть.
  articles = articles.slice(0, limit);
  const sessionDir = await persistArticles(articles);

  // В режиме --review создаём pending-прогон и складываем туда артефакты.
  let pendingRun = null;
  if (review) {
    pendingRun = await createPendingRun(articles.length);
  }

  const results = [];
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const articleId = i + 1;
    const meta = {
      title: article.title,
      url: article.url,
      published_at: toIsoMaybe(article.publishedAt),
    };

    log('info', `[runOnceNow] ${dryRun ? '[dry-run] ' : review ? '[review] ' : ''}Статья ${articleId}: ${meta.title}`);
    const perStep = { dedup: 'ok' };

    try {
      // 1) Адаптация → {json, postPath, postFilename, usage}
      const { json, postPath, usage } = await adaptArticle(articleId, sessionDir, meta);
      runTokens = addUsage(runTokens, usage);

      // 2) Картинка. В dry-run/review/боевом — одинаково. Если DISABLE_IMAGE_GENERATION
      //    в .env — пропускаем шаг целиком (пост пойдёт без фото, image_path=null).
      let imagePath = null;
      if (json.image_prompt) {
        if (!config.features.imageGeneration) {
          log('info', `[image] Статья ${articleId}: генерация картинок отключена (DISABLE_IMAGE_GENERATION)`);
          perStep.image = 'disabled';
        } else {
          const img = await safeStep('generateImage', () => generateImage(json.image_prompt, articleId), { retry: false });
          if (img.ok) {
            imagePath = img.result?.filepath || null;
            json.image_path = imagePath;
            // Перезаписываем тот же файл, что создал адаптер — имя фиксировано.
            await writeFile(postPath, JSON.stringify(json, null, 2), 'utf-8');
          } else {
            perStep.image = img.error;
          }
        }
      }

      // В режиме --review складываем сгенерированный пост в pending/<id>/ (self-contained).
      // Публикацию при этом не делаем — оператор запустит --publish-pending <id>.
      if (review) {
        await addPendingArticle(pendingRun.dir, pendingRun.manifest, {
          articleId, title: meta.title, source: meta, json, imagePath,
        });
        perStep.telegram = 'pending';
        perStep.vk = 'pending';
        perStep.dzenSync = 'pending';
        perStep.site = 'pending';
        perStep.pending = 'added';
        results.push({ id: articleId, ok: true, steps: perStep, error: null });
        // В review нет публикаций — задержка и shutdown-логика не нужны.
        continue;
      }

      // 3) Telegram (основная публикация, статус влияет на общий ok)
      if (skipPublish) {
        log('info', `[${dryRun ? 'dry-run' : 'review'}] Статья ${articleId}: Telegram-публикация пропущена`);
        perStep.telegram = `skipped (${dryRun ? 'dry-run' : 'review'})`;
      } else if (json.social?.telegram?.draft) {
        const tg = await safeStep('publishTelegram', () => publishPost({ json, imagePath }));
        perStep.telegram = tg.ok ? `message_id=${tg.result?.messageId}` : `error: ${tg.error}`;
        perStep.telegramOk = tg.ok;
      } else {
        log('warn', `Статья ${articleId}: нет social.telegram.draft — публикация в Telegram пропущена`);
        perStep.telegram = 'no draft';
      }

      // 4) Дзен — файл (всегда, даже в dry-run — это просто файл).
      // Гейт DISABLE_DZEN_DRAFTS для проектов, где Dzen-канал не нужен.
      if (config.disableDzenDrafts) {
        perStep.zen = 'skipped (DISABLE_DZEN_DRAFTS)';
      } else {
        const zen = await safeStep('writeZenDraft', () => writeZenDraft(json, articleId));
        perStep.zen = zen.ok ? `file=${path.basename(zen.result?.filepath || '')}` : `error: ${zen.error}`;
      }

      // 5) VK (пропускаем в dry-run/review и если не настроен)
      if (skipPublish) {
        perStep.vk = `skipped (${dryRun ? 'dry-run' : 'review'})`;
      } else if (!config.features.vk) {
        perStep.vk = 'skipped (no VK_ACCESS_TOKEN)';
      } else {
        const vk = await safeStep('publishVK', () => publishToVK(json, imagePath));
        perStep.vk = vk.ok ? `post_id=${vk.result?.postId}` : `error: ${vk.error}`;
      }

      // 5.5) Dzen Sync (через @zen_sync_bot). Публичный Telegram-канал,
      // в котором сидит @zen_sync_bot — он сам забирает посты в Яндекс Дзен.
      // Контент — расширенная версия social.yandex_dzen (1500-2500 символов,
      // теги, description), а не короткий social.telegram. Если не настроен —
      // пропускаем без ошибки (drafts/dzen-N.md остаётся для ручной публикации).
      if (skipPublish) {
        perStep.dzenSync = `skipped (${dryRun ? 'dry-run' : 'review'})`;
      } else if (!config.features.dzenSync) {
        perStep.dzenSync = 'skipped (no TELEGRAM_DZEN_SYNC_CHAT_ID)';
      } else if (!json.social?.yandex_dzen?.draft) {
        perStep.dzenSync = 'no social.yandex_dzen.draft';
      } else {
        const dzenSync = await safeStep('publishDzenSync', () => publishToDzenSync(json, imagePath));
        perStep.dzenSync = dzenSync.ok
          ? `message_id=${dzenSync.result?.messageId} (${dzenSync.result?.method})`
          : `error: ${dzenSync.error}`;
      }

      // 6) Сайт (аналогично)
      if (skipPublish) {
        perStep.site = `skipped (${dryRun ? 'dry-run' : 'review'})`;
      } else if (!config.features.site) {
        perStep.site = 'skipped (no SITE_API_*)';
      } else {
        const site = await safeStep('publishSite', () => publishToSite(json));
        perStep.site = site.ok ? `post_id=${site.result?.postId}` : `error: ${site.error}`;
      }

      // 6.5) Экспорт агрегата «Новости» для сайта business_card (news.json).
      // НЕ канал публикации: в per-channel дедуп не входит, на статус статьи не
      // влияет. Ошибка — только warn (своя обёртка, а не safeStep, у которого
      // уровень лога error).
      if (dryRun) {
        perStep.siteNews = 'skipped (dry-run)';
        perStep.siteArticles = 'skipped (dry-run)';
      } else {
        try {
          const newsRes = await exportSiteNews();
          perStep.siteNews = newsRes.skipped ? 'skipped (off)' : `items=${newsRes.items}`;
        } catch (e) {
          log('warn', `[site-news] Экспорт не удался: ${e.message}`);
          perStep.siteNews = `error: ${e.message}`;
        }
        // Страница статей (полные тексты, топ-10 за 14 дней). Best-effort, как siteNews.
        try {
          const artRes = await exportSiteArticles();
          perStep.siteArticles = artRes.skipped ? 'skipped (off)' : `items=${artRes.items}`;
        } catch (e) {
          log('warn', `[site-articles] Экспорт не удался: ${e.message}`);
          perStep.siteArticles = `error: ${e.message}`;
        }
        // 6.6) Автодеплой на хостинг. Best-effort: если FTP не настроен — skip.
        // Должен идти ПОСЛЕ экспорта: заливает только что сгенерированные файлы.
        try {
          const depRes = await deploySiteFiles();
          deploySummary = depRes;
          perStep.deploySite = depRes.skipped
            ? 'skipped (no DEPLOY_FTP_*)'
            : depRes.error
              ? `error: ${depRes.error}`
              : `${depRes.uploadedFiles} файлов, удалено ${depRes.deletedFiles}`;
          if (depRes.error) {
            reportError(new Error(depRes.error), { where: 'deploySite' });
          }
        } catch (e) {
          log('warn', `[deploy-site] Автодеплой не удался: ${e.message}`);
          perStep.deploySite = `error: ${e.message}`;
          reportError(e, { where: 'deploySite' });
        }

        // 6.7) Очистка старых артефактов (images/, sessions/, posts/) по RETENTION_DAYS.
        // Best-effort: ошибка не роняет прогон.
        try {
          const clRes = await cleanupOldFiles();
          perStep.cleanup = clRes.skipped ? 'skipped (off)' : `deleted=${clRes.deletedFiles}`;
        } catch (e) {
          log('warn', `[cleanup] Очистка не удалась: ${e.message}`);
          perStep.cleanup = `error: ${e.message}`;
        }
      }

      // dry-run: ok без публикации; боевой: ок, если Telegram опубликован.
      // review сюда не доходит (continue выше).
      const ok = dryRun ? true : Boolean(perStep.telegramOk);

      // 7) Отметка в реестре публикаций — только если Telegram-публикация
      //    реально прошла (или dry-run, чтобы не накапливать ложные записи
      //    при тестах). review НЕ отмечает — публикация произойдёт позже
      //    из --publish-pending, там и markPublished. markPublished идемпотентен.
      if (ok && !opts.skipDedup) {
        try {
          await markPublished(article);
          perStep.dedup = 'marked';
        } catch (e) {
          log('warn', `[dedup] Не удалось отметить публикацию: ${e.message}`);
        }
      }

      results.push({ id: articleId, ok, steps: perStep, error: ok ? null : 'Telegram не опубликован' });

      // Graceful shutdown: после публикации + markPublished проверяем флаг.
      // Если был SIGINT/SIGTERM — корректно завершаем цикл, не начиная новых статей.
      // Уже опубликованные остаются в БД (markPublished выполнен), дедуп сработает.
      if (isShuttingDown() && i < articles.length - 1) {
        log('warn', `[shutdown] Прерываю цикл после статьи ${articleId} (${shutdownSignal || 'SIGTERM'}).`);
        break;
      }

      // Задержка только в боевом режиме (не dry-run, не review) и не после последней статьи.
      if (!skipPublish && i < articles.length - 1) {
        const delay = config.postIntervalMs || 60_000;
        log('info', `Ожидание ${delay} мс перед следующей статьёй...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err) {
      // Сюда падают только фатальные ошибки (parse/adapter, не отдельные площадки).
      log('error', `Фатальная ошибка на статье ${articleId}: ${err.message}`);
      reportError(err, { articleId, where: 'runOnceNow.outer' });
      results.push({ id: articleId, ok: false, steps: perStep, error: err.message });
    }
  }

  // Финализация review-прогона: пишем финальный manifest + человекочитаемое превью.
  let pendingId = undefined;
  if (review && pendingRun) {
    pendingRun.manifest.status = isShuttingDown() ? 'interrupted' : 'ready';
    const previewPath = await finalizePendingRun(pendingRun.dir, pendingRun.manifest);
    pendingId = pendingRun.id;
    log('info', `[review] Готово. Превью: ${previewPath}`);
    log('info', `[review] Публикация: node src/index.js --publish-pending ${pendingId}`);
  }

  const okCount = results.filter((r) => r.ok).length;
  const summary = `runOnceNow: в источнике ${totalCards}, после свежести ${freshStats.fresh} (stale=${freshStats.stale}, no_date=${freshStats.noDate}), фильтры source=${freshStats.sourceBlocked}, stopword=${freshStats.stopwordFiltered}, дедуп пропустил ${dedupSkipped} (pickBySource: dropped_dup=${pickDroppedDup}, dropped_empty=${pickDroppedEmpty}), обработано ${articles.length}, успешно ${okCount}/${results.length}` +
    (review && pendingId ? ` (pending=${pendingId})` : '') +
    (isShuttingDown() ? ` (прервано по ${shutdownSignal || 'SIGTERM'})` : '');
  log('info', summary);
  if (!skipPublish) reportInfo(summary, { run: 'once', interrupted: isShuttingDown() });

  await recordRun({
    found: totalCards,
    fresh_count: freshStats.fresh,
    no_date_count: freshStats.noDate,
    stale_count: freshStats.stale,
    source_blocked: freshStats.sourceBlocked,
    stopword_filtered: freshStats.stopwordFiltered,
    dedup_skipped: dedupSkipped,
    dropped_dup_pick: pickDroppedDup,
    processed: articles.length,
    ok: okCount,
    fail: results.length - okCount,
    interrupted: isShuttingDown(),
    pending_id: pendingId || null,
  });

  return {
    found: totalCards,
    fresh: freshStats.fresh,
    dedupSkipped,
    processed: articles.length,
    results,
    interrupted: isShuttingDown(),
    pendingId,
    noDate: freshStats.noDate,
    stale: freshStats.stale,
    sourceBlocked: freshStats.sourceBlocked,
    stopwordFiltered: freshStats.stopwordFiltered,
  };
}

/**
 * Публикует ранее сгенерированные (в режиме --review) посты из pending/<id>/.
 *
 * Идемпотентна: уже опубликованные статьи (status='published') пропускаются;
 * статьи, попавшие в dedup-реестр другим путём, помечаются 'skipped'.
 * Manifest обновляется построчно (атомарно), так что прерывание по Ctrl+C
 * не теряет прогресс — повторный запуск добьёт оставшиеся.
 *
 * @param {string} id — pending-прогон id (каталог pending/<id>/).
 * @returns {Promise<{id: string, published: number, failed: number, skipped: number, results: Array}>}
 */
export async function publishPending(id) {
  const startedAtMs = Date.now();
  const manifest = await readPendingRun(id);
  log('info', `[publish-pending] Прогон ${id}: ${manifest.articles.length} статей`);

  // Доступ к Telegram проверяем здесь же (боевая публикация).
  const { checkTelegramAccess } = await import('./publisher.js');
  const tgOk = await checkTelegramAccess();
  if (!tgOk) throw new Error('publishPending: нет доступа к Telegram, публикация невозможна');
  await checkAllAccess();

  resetShutdown();
  let published = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  for (let idx = 0; idx < manifest.articles.length; idx++) {
    const art = manifest.articles[idx];
    if (art.status === 'published') { skipped++; continue; }
    if (isShuttingDown()) { log('warn', `[publish-pending] Прервано на статье ${art.articleId}`); break; }

    const json = art.json;
    const imagePath = articleImagePath(manifest, art.articleId);
    const perStep = { ...(art.results || {}) }; // копируем уже-успешные каналы с прошлого запуска

    // dedup: вдруг уже опубликовали другим путём — не дубльим.
    try {
      const dup = await isAlreadyPublished(art.source || {});
      if (dup.duplicate) {
        log('info', `[publish-pending] Статья ${art.articleId} уже опубликована (${dup.reason}) — пропускаю`);
        skipped++;
        await updatePendingArticle(manifest, art.articleId, { status: 'skipped', results: { dedup: dup.reason } });
        results.push({ id: art.articleId, ok: true, skipped: true });
        continue;
      }
    } catch (e) {
      log('warn', `[publish-pending] dedup-проверка не удалась (${e.message}), публикую как есть`);
    }

    // ----- Per-channel дедуп -----
    // Если канал уже был успешен в прошлом запуске (results содержит message_id= / post_id=
    // ИЛИ явно сохранён tgMessageId/vkPostId), публикацию НЕ повторяем.
    // Это убирает дубли при повторных --publish-pending после частичных сбоев.
    const alreadyTg = !!(art.tgMessageId || /message_id=\d+/.test(perStep.telegram || ''));
    const alreadyVk = !!(art.vkPostId || /post_id=\d+/.test(perStep.vk || ''));
    const alreadySite = !!(art.sitePostId || /post_id=\d+/.test(perStep.site || ''));
    const alreadyZen = !!(art.zenFile || /^file=[\w.-]+$/.test(perStep.zen || ''));
    const alreadyDzenSync = !!(art.dzenSyncMessageId || /message_id=\d+/.test(perStep.dzenSync || ''));

    let telegramOk = alreadyTg;
    let vkOk = alreadyVk;
    let siteOk = alreadySite;
    let dzenSyncOk = alreadyDzenSync;
    let anyChannelOk = alreadyTg || alreadyVk || alreadySite || alreadyZen || alreadyDzenSync;
    if (alreadyTg) log('info', `[publish-pending] Статья ${art.articleId}: Telegram уже опубликован (${perStep.telegram})`);
    if (alreadyVk) log('info', `[publish-pending] Статья ${art.articleId}: VK уже опубликован (${perStep.vk})`);
    if (alreadySite) log('info', `[publish-pending] Статья ${art.articleId}: Site уже опубликован (${perStep.site})`);
    if (alreadyZen) log('info', `[publish-pending] Статья ${art.articleId}: Zen уже сохранён (${perStep.zen})`);
    if (alreadyDzenSync) log('info', `[publish-pending] Статья ${art.articleId}: Dzen-sync уже опубликован (${perStep.dzenSync})`);

    // Telegram
    if (!alreadyTg) {
      if (!json?.social?.telegram?.draft) {
        perStep.telegram = perStep.telegram || 'no draft';
      } else {
        const tg = await safeStep('publishTelegram', () => publishPost({ json, imagePath }));
        if (tg.ok) {
          const id = tg.result?.messageId;
          perStep.telegram = `message_id=${id}`;
          art.tgMessageId = id;
          telegramOk = true;
        } else {
          perStep.telegram = `error: ${tg.error}`;
        }
      }
    }

    // VK
    if (!alreadyVk) {
      if (!config.features.vk) {
        perStep.vk = perStep.vk || 'skipped (no VK)';
      } else {
        const vk = await safeStep('publishVK', () => publishToVK(json, imagePath));
        if (vk.ok) {
          const id = vk.result?.postId;
          perStep.vk = `post_id=${id}`;
          art.vkPostId = id;
          vkOk = true;
        } else {
          perStep.vk = `error: ${vk.error}`;
        }
      }
    }

    // Dzen Sync (через @zen_sync_bot)
    if (!alreadyDzenSync) {
      if (!config.features.dzenSync) {
        perStep.dzenSync = perStep.dzenSync || 'skipped (no TELEGRAM_DZEN_SYNC_CHAT_ID)';
      } else if (!json?.social?.yandex_dzen?.draft) {
        perStep.dzenSync = perStep.dzenSync || 'no social.yandex_dzen.draft';
      } else {
        const dzenSync = await safeStep('publishDzenSync', () => publishToDzenSync(json, imagePath));
        if (dzenSync.ok) {
          const id = dzenSync.result?.messageId;
          perStep.dzenSync = `message_id=${id} (${dzenSync.result?.method})`;
          art.dzenSyncMessageId = id;
          dzenSyncOk = true;
        } else {
          perStep.dzenSync = `error: ${dzenSync.error}`;
        }
      }
    }

    // Сайт
    if (!alreadySite) {
      if (!config.features.site) {
        perStep.site = perStep.site || 'skipped (no SITE)';
      } else {
        const site = await safeStep('publishSite', () => publishToSite(json));
        if (site.ok) {
          const id = site.result?.postId;
          perStep.site = `post_id=${id}`;
          art.sitePostId = id;
          siteOk = true;
        } else {
          perStep.site = `error: ${site.error}`;
        }
      }
    }

    // Экспорт агрегата «Новости» для сайта business_card (news.json).
    // Best-effort, не канал публикации — dedup-ветки и статус не затрагиваются.
    try {
      const newsRes = await exportSiteNews();
      perStep.siteNews = newsRes.skipped ? 'skipped (off)' : `items=${newsRes.items}`;
    } catch (e) {
      log('warn', `[site-news] Экспорт не удался: ${e.message}`);
      perStep.siteNews = `error: ${e.message}`;
    }
    // Страница статей (полные тексты, топ-10 за 5 дней). Best-effort, как siteNews.
    try {
      const artRes = await exportSiteArticles();
      perStep.siteArticles = artRes.skipped ? 'skipped (off)' : `items=${artRes.items}`;
    } catch (e) {
      log('warn', `[site-articles] Экспорт не удался: ${e.message}`);
      perStep.siteArticles = `error: ${e.message}`;
    }
    // Автодеплой на хостинг. Best-effort, как siteNews/siteArticles.
    try {
      const depRes = await deploySiteFiles();
      perStep.deploySite = depRes.skipped
        ? 'skipped (no DEPLOY_FTP_*)'
        : depRes.error
          ? `error: ${depRes.error}`
          : `${depRes.uploadedFiles} файлов, удалено ${depRes.deletedFiles}`;
      if (depRes.error) {
        reportError(new Error(depRes.error), { where: 'deploySite' });
      }
    } catch (e) {
      log('warn', `[deploy-site] Автодеплой не удался: ${e.message}`);
      perStep.deploySite = `error: ${e.message}`;
      reportError(e, { where: 'deploySite' });
    }

    // Zen — отдельной ветки per-channel тут не делаем (он файл, без побочек;
    // идемпотентность writeZenDraft обеспечивается перезаписью одного и того же файла).

    // Статус статьи: published, если хотя бы один канал успешен.
    anyChannelOk = anyChannelOk || telegramOk || vkOk || siteOk || dzenSyncOk;
    if (anyChannelOk) {
      // markPublished вызываем только ОДИН раз — при первом успехе любого канала.
      // Проверяем по уже-сохранённому флагу в результатах.
      if (!perStep.dedup) {
        try { await markPublished(art.source || {}); perStep.dedup = 'marked'; } catch (e) { log('warn', `[dedup] ${e.message}`); }
      }
      published++;
      await updatePendingArticle(manifest, art.articleId, {
        status: 'published',
        publishedAt: art.publishedAt || new Date().toISOString(),
        results: perStep,
        tgMessageId: art.tgMessageId,
        vkPostId: art.vkPostId,
        sitePostId: art.sitePostId,
        zenFile: art.zenFile,
        dzenSyncMessageId: art.dzenSyncMessageId,
      });
    } else {
      failed++;
      await updatePendingArticle(manifest, art.articleId, { status: 'failed', results: perStep });
    }
    results.push({ id: art.articleId, ok: anyChannelOk, steps: perStep });

    // Задержка между публикациями (боевой режим).
    if (idx < manifest.articles.length - 1) {
      const delay = config.postIntervalMs || 60_000;
      log('info', `Ожидание ${delay} мс перед следующей статьёй...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  const summary = `[publish-pending] ${id}: опубликовано ${published}, ошибок ${failed}, пропущено ${skipped}`;
  log('info', summary);
  reportInfo(summary, { run: 'publish-pending', id });

  await appendRun({
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAtMs,
    mode: 'publish-pending',
    sources: 0,
    found: manifest.articles.length,
    dedup_skipped: skipped,
    processed: published + failed,
    ok: published,
    fail: failed,
    interrupted: isShuttingDown(),
    pending_id: id,
    tokens: null, // публикация не генерирует — токенов нет
  });

  return { id, published, failed, skipped, results };
}

export function runScheduled(sources) {
  installShutdownHandlers(); // SIGINT/SIGTERM — корректно завершить текущий прогон
  const list = Array.isArray(sources) ? sources : [sources];
  // CSV-парсинг SCHEDULE_CRON. Поддерживает один крон (legacy) и несколько
  // через запятую. Каждое выражение — отдельный запуск runOnceNow.
  // Пример: SCHEDULE_CRON="0 8 * * *,0 15 * * *" → два запуска в сутки.
  const cronExpressions = parseScheduleCsv(config.scheduleCron || '0 */2 * * *');
  if (cronExpressions.length === 0) {
    // На пустой ввод — fallback на дефолт, чтобы бот не зависал без расписания.
    cronExpressions.push('0 */2 * * *');
  }
  const handler = async () => {
    log('info', 'Запуск по расписанию');
    resetShutdown();
    try {
      await runOnceNow(list);
    } catch (e) {
      log('error', `Ошибка в расписании: ${e.message}`);
      reportError(e, { where: 'runScheduled' });
    }
    // После scheduled-прогона — проверить, не пора ли отправить ежедневный отчёт.
    // Триггер «по факту прогона» (а не отдельным кроном) — отчёт приходит вместе
    // с регулярной активностью, пока бот жив.
    try {
      await maybeSendDailyReport();
    } catch (e) {
      log('warn', `[runScheduled] ежедневный отчёт не отправлен: ${e.message}`);
    }
  };
  for (const expr of cronExpressions) {
    cron.schedule(expr, handler);
  }
  if (cronExpressions.length > 1) {
    log('info', `Зарегистрировано расписание: ${cronExpressions.join(', ')}`);
  }
  log('info', `Расписание активно: "${cronExpressions.join(', ')}" (Ctrl+C для корректного завершения)`);
}

// Проверки доступа — используются из index.js перед боевым прогоном.
export async function checkAllAccess() {
  const checks = [];
  if (config.features.vk) checks.push(checkVKAccess());
  if (config.features.site) checks.push(checkSiteAccess());
  if (config.features.dzenSync) checks.push(checkDzenSyncAccess());
  return Promise.all(checks);
}
