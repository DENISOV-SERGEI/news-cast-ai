import { runOnceNow, runScheduled, publishPending, checkAllAccess, installShutdownHandlers } from './scheduler.js';
import { checkTelegramAccess } from './publisher.js';
import { fetchWithTimeout } from './http.js';
import { closeLogger } from './logger.js';
import { log, config } from './config.js';

// Ставим хендлеры сразу при старте, чтобы Ctrl+C работал и в --once, и в --schedule
installShutdownHandlers();

async function checkOllamaAccess() {
  try {
    const response = await fetchWithTimeout(`${config.OLLAMA_API_BASE}/v1/models`, {
      headers: { 'Authorization': `Bearer ${config.OLLAMA_API_KEY}` }
    }, { timeoutMs: 15_000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    log('info', 'Ollama API доступен');
    return true;
  } catch (e) {
    log('error', `Не удалось подключиться к Ollama API: ${e.message}`);
    log('error', 'Проверьте OLLAMA_API_BASE и OLLAMA_API_KEY в .env');
    return false;
  }
}

function parseArgs(argv) {
  const args = { url: null, flags: new Set(), publishPendingId: null, help: false };
  const argvSlice = argv.slice(2);
  for (let i = 0; i < argvSlice.length; i++) {
    const a = argvSlice[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--publish-pending') {
      // --publish-pending <id> — забираем следующий аргумент как id
      const id = argvSlice[i + 1];
      if (!id || id.startsWith('--')) {
        console.error('Не указан id для --publish-pending');
        process.exit(2);
      }
      args.publishPendingId = id;
      i++; // пропускаем id
    } else if (a === '--once' || a === '--schedule' || a === '--dry-run' || a === '--review') {
      args.flags.add(a.slice(2));
    } else if (a.startsWith('--')) {
      console.error(`Неизвестный флаг: ${a}`);
      process.exit(2);
    } else if (!args.url) {
      args.url = a;
    } else {
      console.error(`Лишний аргумент: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Использование:
  node src/index.js <URL_источника> [--once] [--schedule] [--dry-run] [--review]
  node src/index.js --publish-pending <id>

Флаги:
  --once               один прогон (по умолчанию)
  --dry-run            подготовить посты без публикации в Telegram
  --review             сгенерировать посты в pending/<id>/ без публикации
                       (ручная модерация; превью — pending/<id>/preview.md)
  --schedule           long-running режим с node-cron (SCHEDULE_CRON из .env)
  --publish-pending <id>  опубликовать посты из ранее созданного review-прогона

Примеры:
  node src/index.js https://www.artificialintelligence-news.com/feed --dry-run
  node src/index.js https://www.artificialintelligence-news.com/feed --review
  node src/index.js --publish-pending 20260823-125014-abc12
  node src/index.js https://www.artificialintelligence-news.com/feed --schedule
`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  // --publish-pending <id>: публикация ранее сгенерированных постов из pending/<id>/.
  // Отдельный путь — не нужен Ollama (генерации нет), источники тоже не нужны.
  if (args.publishPendingId) {
    log('info', `Запуск news-cast-ai — публикация pending-прогона ${args.publishPendingId}`);
    try {
      installShutdownHandlers();
      const res = await publishPending(args.publishPendingId);
      log('info', `Готово. Опубликовано: ${res.published}, ошибок: ${res.failed}, пропущено: ${res.skipped}`);
      if (res.failed > 0) process.exitCode = 1;
    } catch (e) {
      log('error', `Фатальная ошибка: ${e.message}`);
      if (process.env.DEBUG) console.error(e);
      process.exit(1);
    }
    return;
  }

  // Источники: SOURCES из .env имеет приоритет над URL из CLI.
  // Если оба заданы — предупреждаем и используем SOURCES.
  let sources;
  if (config.sources.length > 0) {
    sources = config.sources;
    if (args.url) {
      log('warn', `Игнорирую URL из CLI (${args.url}) — используется SOURCES из .env (${sources.length} шт.)`);
    }
  } else if (args.url) {
    sources = [args.url];
  } else {
    printHelp();
    process.exit(2);
  }

  const limit = config.articlesPerRun || 3;
  const isReview = args.flags.has('review');

  log('info', 'Запуск news-cast-ai (Telegram pipeline) — v2 (Ollama Cloud)');
  log('info', `Источники (${sources.length}): ${sources.join(', ')}`);
  log('info', `Режим: ${args.flags.has('schedule') ? 'schedule' : 'once'}${args.flags.has('dry-run') ? ' (dry-run)' : isReview ? ' (review)' : ''}`);
  log('info', `Статей за прогон: ${limit}; интервал между постами: ${config.postIntervalMs || 60_000} мс`);
  log('info', `Свежесть: окно ${config.freshWindowDays} дн.${config.features.imageGeneration ? '' : ' | генерация картинок ВЫКЛЮЧЕНА'}`);

  const ollamaOk = await checkOllamaAccess();
  if (!ollamaOk) process.exit(1);

  // Доступ к Telegram проверяем в любом режиме, кроме dry-run/review
  // (там публикации нет — валидность бота не критична).
  const isDryRun = args.flags.has('dry-run');
  if (!isDryRun && !isReview) {
    const tgOk = await checkTelegramAccess();
    if (!tgOk) {
      log('error', 'Не удалось подтвердить доступ к Telegram. Проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID.');
      process.exit(1);
    }
    // VK и сайт — best-effort: логируем, но не блокируем прогон.
    await checkAllAccess();
  }

  try {
    if (args.flags.has('schedule')) {
      runScheduled(sources);
      log('info', 'Long-running режим запущен. Нажмите Ctrl+C для остановки.');
      await new Promise(() => {});
      return;
    }

    // Один прогон. Вся логика (parse → adapt → image → publish) — в scheduler.js.
    const { found, processed, results, interrupted, pendingId } = await runOnceNow(sources, {
      dryRun: isDryRun,
      review: isReview,
      limit,
    });

    if (isDryRun) {
      log('info', `[dry-run] сессия: ${config.sessionsDir}/<YYYY-MM-DD>/`);
    } else if (isReview && pendingId) {
      log('info', `[review] pending-прогон: ${config.pendingDir}/${pendingId}/ (превью: preview.md)`);
      log('info', `[review] публикация: node src/index.js --publish-pending ${pendingId}`);
    }
    for (const r of results) {
      const stepStr = r.steps
        ? Object.entries(r.steps).map(([k, v]) => `${k}=${v}`).join(' | ')
        : '';
      log('info', `  - статья ${r.id}: ${r.ok ? 'OK' : 'FAIL'}${stepStr ? ` [${stepStr}]` : ''}${r.error ? ` (${r.error})` : ''}`);
    }
    log('info', `Готово. Найдено: ${found}, обработано: ${processed}, успешно: ${results.filter((r) => r.ok).length}/${results.length}`);
    if (interrupted) {
      // 130 = 128 + SIGINT (стандарт для «прервано пользователем»)
      try { closeLogger(); } catch { /* noop */ }
      process.exit(130);
    }
  } catch (e) {
    log('error', `Фатальная ошибка: ${e.message}`);
    if (process.env.DEBUG) console.error(e);
    try { closeLogger(); } catch { /* noop */ }
    process.exit(1);
  }
}

main();
