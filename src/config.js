// Загрузка и валидация переменных окружения.
// Все ключи читаются из process.env; никаких хардкодов и значений по умолчанию для секретов.
//
// ВАЖНО: ANTHROPIC_API_KEY здесь НЕ используется — это ключ самого Claude Code,
// он НЕ должен попадать в наши скрипты. Claude CLI авторизуется самостоятельно.


import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

dotenv.config({ path: resolve(projectRoot, '.env') });

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Не задана обязательная переменная окружения ${name}.\n` +
        `Заполните файл .env в корне проекта (см. .env.example).`,
    );
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function intOpt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Переменная ${name} должна быть положительным целым числом, получено: "${v}"`);
  }
  return n;
}

function boolOpt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return /^(1|true|yes|on|да)$/i.test(v.trim());
}

const logLevels = ['debug', 'info', 'warn', 'error'];

export const config = {
  // Корень проекта: используется для резолва путей артефактов.
  projectRoot,
  // --- Telegram Bot API ---
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),
  telegramApiBase: optional('TELEGRAM_API_BASE', 'https://api.telegram.org'),
  // Опциональный чат для алертов об ошибках (если не задан, алерты не шлются).
  telegramErrorChatId: optional('TELEGRAM_ERROR_CHAT_ID', ''),
  // Минимальный интервал между запросами к Telegram Bot API (мс). Защита от
  // rate-limit/бана при всплеске (публикация + monitoring + retry-волна).
  telegramRateLimitMs: intOpt('TELEGRAM_RATE_LIMIT_MS', 1000),
  // --- Telegram-канал для Синхробота @zen_sync_bot (опционально) ---
  // Отдельный ПУБЛИЧНЫЙ Telegram-канал, куда бот постит расширенную версию
  // поста (social.yandex_dzen, 1500-2500 символов с тегами). Из этого канала
  // официальный @zen_sync_bot забирает контент в Яндекс Дзен. Если не задан —
  // публикация в Дзен через Синхробота пропускается (drafts/dzen-N.md остаётся
  // для ручной публикации). Тот же TELEGRAM_BOT_TOKEN должен быть админом канала.
  // Пример: TELEGRAM_DZEN_SYNC_CHAT_ID=@my_dzen_channel или -100xxxxxxxxxx.
  telegramDzenSyncChatId: optional('TELEGRAM_DZEN_SYNC_CHAT_ID', ''),

  // --- ProxyAPI (генерация изображений) ---
  proxyApiKey: required('PROXY_API_KEY'),
  proxyApiBase: optional('PROXY_API_BASE', 'https://api.proxyapi.ru/openai/v1'),
  proxyImageModel: optional('PROXY_IMAGE_MODEL', 'gpt-image-1-mini'),

  // --- Ollama Cloud API (двухэтапная адаптация) ---
  // Используем заглавные имена, соответствующие переменным в .env
  OLLAMA_API_BASE: required('OLLAMA_API_BASE'),
  OLLAMA_API_KEY: required('OLLAMA_API_KEY'),
  MODEL_SUMMARY: optional('MODEL_SUMMARY', 'deepseek-v4-flash'),
  MODEL_SOCIAL: optional('MODEL_SOCIAL', 'deepseek-v4-pro'),

  // --- VK API (опционально) ---
  // Если токен не задан — публикация в VK просто пропускается.
  vkAccessToken: optional('VK_ACCESS_TOKEN', ''),
  vkGroupId: optional('VK_GROUP_ID', ''),
  vkApiVersion: optional('VK_API_VERSION', '5.199'),
  // Минимальный интервал между запросами к VK API (мс). Защита от error_code=6.
  vkRateLimitMs: intOpt('VK_RATE_LIMIT_MS', 350),
  // User-token (от имени пользователя-админа группы). Нужен ТОЛЬКО для шага
  // photos.getWallUploadServer / photos.saveWallPhoto: групповой токен на этих
  // методах даёт VK error_code=27 ("Group authorization failed"). wall.post
  // по-прежнему идёт через VK_ACCESS_TOKEN (групповой). Если пусто и есть
  // imagePath — паблишер попытается загрузить фото групповым токеном и упадёт
  // с тем же кодом (так и было до фикса).
  vkUserAccessToken: optional('VK_USER_ACCESS_TOKEN', ''),
  // CSV доменов, для которых VK гарантированно не подтянет og:image —
  // для них публикация сразу идёт через docs.save (наш PNG как документ).
  // Нормализация: lower-case, без www. Если пусто — все домены идут по OG-пути
  // (плюс автоматический fallback, если в тексте поста нет ссылки на оригинал).
  // Пример: VK_OG_FALLBACK_DOMAINS=techcrunch.com,deepmind.google
  vkOgFallbackDomains: optional('VK_OG_FALLBACK_DOMAINS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean),

  // --- Сайт (WordPress REST API, опционально) ---
  siteApiUrl: optional('SITE_API_URL', ''),
  siteApiKey: optional('SITE_API_KEY', ''),

  // --- Пути к артефактам пайплайна ---
  sessionsDir: resolve(projectRoot, optional('SESSIONS_DIR', './sessions')),
  postsDir: resolve(projectRoot, optional('POSTS_DIR', './posts')),
  imagesDir: resolve(projectRoot, optional('IMAGES_DIR', './images')),
  draftsDir: resolve(projectRoot, optional('DRAFTS_DIR', './drafts')),
  dbPath: resolve(projectRoot, optional('DB_PATH', './database/published.json')),
  // Кэш картинок image_prompt → файл (database/image_cache.json).
  imageCachePath: resolve(projectRoot, optional('IMAGE_CACHE_PATH', './database/image_cache.json')),
  // История прогонов для отчётов по наблюдаемости (database/runs.json).
  runsPath: resolve(projectRoot, optional('RUNS_PATH', './database/runs.json')),
  // Каталог для ручной модерации (режим --review / --publish-pending).
  pendingDir: resolve(projectRoot, optional('PENDING_DIR', './pending')),
  // Кэш cookie для обхода SiteGround-капчи (см. src/sgCaptcha.js).
  // SG выставляет cookie _I_ после JS-challenge; он живёт ~месяц, поэтому
  // храним его в файле и переиспользуем для обычных fetch-запросов.
  sgCookiesPath: optional('SG_COOKIES_PATH', './database/sg_cookies.json'),
  // Экспорт «Новости» для статического сайта business_card (news.json).
  // Путь резолвится от projectRoot; дефолт — ../business_card/news.json.
  // BUSINESS_CARD_NEWS_PATH=off — экспорт отключён (см. features.businessCardNews).
  businessCardNewsPath: (() => {
    const v = optional('BUSINESS_CARD_NEWS_PATH', '');
    const rel = /^off$/i.test(v) ? '../business_card/news.json' : v || '../business_card/news.json';
    return resolve(projectRoot, rel);
  })(),
  // Страница статей на сайте business_card (полные тексты, топ-10 за 14 дней).
  // siteArticlesDir — каталог с отдельными HTML-страницами статей;
  // siteArticlesListPath — список статей (articles.html).
  // SITE_ARTICLES_DIR=off — экспорт отключён (см. features.siteArticles).
  siteArticlesDir: (() => {
    const v = optional('SITE_ARTICLES_DIR', '');
    const rel = /^off$/i.test(v) ? '../business_card/articles' : v || '../business_card/articles';
    return resolve(projectRoot, rel);
  })(),
  siteArticlesListPath: resolve(projectRoot, optional('SITE_ARTICLES_LIST_PATH', '../business_card/articles.html')),

  // --- Автодеплой сайта business_card на хостинг по SFTP/SSH (опционально) ---
  // После экспорта news.json/articles.html/articles/*.html пайплайн автоматически
  // заливает эти файлы на удалённый хостинг (например Beget). Включается только
  // если заданы DEPLOY_FTP_HOST + DEPLOY_FTP_USER + DEPLOY_FTP_PASS.
  // Транспорт — SFTP/SSH (ssh2-sftp-client, порт 22): шифрование, те же креды,
  // что и у FTP-пользователя. При подключении мы попадаем в корень сайта
  // (например ~/public_html), поэтому DEPLOY_FTP_REMOTE_DIR
  // для SFTP не используется — база берётся из sftp.cwd().
  deployFtpHost: optional('DEPLOY_FTP_HOST', ''),
  deployFtpPort: intOpt('DEPLOY_FTP_PORT', 21),
  deployFtpUser: optional('DEPLOY_FTP_USER', ''),
  deployFtpPass: optional('DEPLOY_FTP_PASS', ''),
  deployFtpSecure: boolOpt('DEPLOY_FTP_SECURE', false),
  deployFtpRemoteDir: optional('DEPLOY_FTP_REMOTE_DIR', '/public_html'),
  // Порт SFTP/SSH (используется deploySite.js вместо FTP-порта).
  deploySftpPort: intOpt('DEPLOY_SFTP_PORT', 22),
  // Публичный URL сайта для HTTP-проверки после деплоя (например
  // https://your-site.ru). Если задан — после заливки файлов пайплайн
  // делает fetch к <url>/news.json и сверяет, что сайт отдаёт свежие данные.
  deploySiteUrl: optional('DEPLOY_SITE_URL', ''),

  // --- Источники ---
  // SOURCES — CSV URL, через запятую. Если задан, имеет приоритет над URL из CLI.
  // Если пуст — берётся URL из аргументов CLI (для обратной совместимости).
  sources: optional('SOURCES', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // CSV доменов, которые нужно пропустить (lowercase, без www.).
  // Сравнение по hostname: если домен или parent-домен в списке — статья отбрасывается
  // ещё до адаптации (экономия Ollama-токенов).
  sourceBlocklist: optional('SOURCE_BLOCKLIST', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // CSV подстрок (lowercase). Если заголовок содержит ЛЮБУЮ подстроку — отбрасываем.
  // Пример: "weekly roundup,newsletter,top 10".
  titleStopwords: optional('TITLE_STOPWORDS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // --- Поведение пайплайна ---
  articlesPerRun: intOpt('ARTICLES_PER_RUN', 3),
  // Свежесть: 1 = только сегодня, 7 = за неделю, 0 = без фильтра.
  // Статьи без published_at пропускаются с warning.
  freshWindowDays: intOpt('FRESH_WINDOW_DAYS', 1),
  // Временный запрет на генерацию новых картинок. Посты публикуются без фото.
  // Включается DISABLE_IMAGE_GENERATION=1 (true/yes/да).
  disableImageGeneration: boolOpt('DISABLE_IMAGE_GENERATION', false),
  // Полностью отключить авто-обход SiteGround-капчи в src/sgCaptcha.js.
  // Включается DISABLE_SG_CAPTCHA_RESOLVER=1. Полезно, если Playwright/Chromium
  // недоступен (например, в Docker без браузеров) — тогда источник с капчей
  // просто пропускается, как раньше.
  disableSgCaptchaResolver: boolOpt('DISABLE_SG_CAPTCHA_RESOLVER', false),
  // Полностью отключить сохранение Yandex Dzen-черновиков (drafts/).
  // Включается DISABLE_DZEN_DRAFTS=1. Удобно, когда в проекте пока
  // не нужен Dzen-канал и не хочется засорять drafts/.
  disableDzenDrafts: boolOpt('DISABLE_DZEN_DRAFTS', false),
  // Интервал между постами внутри одного прогона (мс).
  // Первый пост публикуется сразу, последующие — через этот интервал.
  postIntervalMs: intOpt('POST_INTERVAL_MS', 60_000),
  // node-cron выражение для расписания. По умолчанию — каждые 2 часа.
  scheduleCron: optional('SCHEDULE_CRON', '0 */2 * * *'),

  // Текст ссылки на оригинал статьи, которую паблишеры добавляют в конце
  // публикации во все каналы (Telegram/VK/Yandex Dzen/Site Blog).
  // Пример: SOURCE_LINK_LABEL="🔗 Оригинал статьи"
  // Если пусто — используется «🔗 Оригинал статьи».
  sourceLinkLabel: optional('SOURCE_LINK_LABEL', '🔗 Оригинал статьи'),

  logLevel: (() => {
    const lv = optional('LOG_LEVEL', 'info').toLowerCase();
    if (!logLevels.includes(lv)) {
      throw new Error(`LOG_LEVEL должен быть одним из: ${logLevels.join(', ')}`);
    }
    return lv;
  })(),
  // --- Логирование в файл (опционально) ---
  // Если пусто — логи идут только в console (поведение по умолчанию).
  // Пример: LOG_FILE=./logs/news-cast-ai.log
  logFile: optional('LOG_FILE', ''),
  // Сколько дней хранить архивные файлы (logs/news-cast-ai.YYYY-MM-DD.log).
  logRetentionDays: intOpt('LOG_RETENTION_DAYS', 7),
  // Сколько дней хранить старые файлы в images/, sessions/, posts/ (см. src/cleanup.js).
  // 0 — отключить очистку.
  retentionDays: intOpt('RETENTION_DAYS', 30),
};

// Флаги доступности площадок — удобно проверять, не разбрасывая `if (config.x)` по коду.
config.features = {
  vk: Boolean(config.vkAccessToken && config.vkGroupId),
  site: Boolean(config.siteApiUrl && config.siteApiKey),
  errorChat: Boolean(config.telegramErrorChatId),
  imageGeneration: !config.disableImageGeneration,
  // Dzen Sync через @zen_sync_bot активен, если задан отдельный публичный канал.
  // Использует тот же TELEGRAM_BOT_TOKEN, что и основной Telegram-канал.
  dzenSync: Boolean(config.telegramDzenSyncChatId),
  // Экспорт news.json для business_card включён по умолчанию;
  // отключается значением BUSINESS_CARD_NEWS_PATH=off.
  businessCardNews: !/^off$/i.test(optional('BUSINESS_CARD_NEWS_PATH', '')),
  // Страница статей (полные тексты) для business_card включена по умолчанию;
  // отключается значением SITE_ARTICLES_DIR=off.
  siteArticles: !/^off$/i.test(optional('SITE_ARTICLES_DIR', '')),
  // Автодеплой на хостинг по FTP/SFTP активен, если заданы все DEPLOY_FTP_*.
  deploySite: Boolean(optional('DEPLOY_FTP_HOST', '') && optional('DEPLOY_FTP_USER', '') && optional('DEPLOY_FTP_PASS', '')),
  // Авто-обход SiteGround-капчи включён по умолчанию (если не отключён явно).
  sgResolver: !boolOpt('DISABLE_SG_CAPTCHA_RESOLVER', false),
};

export function log(level, message, extra) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if (order[level] < order[config.logLevel]) return;
  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : '';
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](`[${ts}] [${level.toUpperCase()}] ${message}${tail}`);
  // Дополнительно — дубль в файл через ./logger.js (если initLogger был вызван).
  // Импорт динамический, чтобы не ломать загрузку config.js (logger может упасть).
  try {
    // require не используем — ESM. Берём из глобального кэша через import.meta.resolve нельзя,
    // поэтому держим ссылку в module-scope.
    _fileLogger?.log?.(level, message, extra);
  } catch { /* noop */ }
}

// Ссылка на file-logger (logger.js) — проставляется через attachFileLogger ниже.
// Если не проставлена — лог идёт только в console (как раньше).
let _fileLogger = null;

/**
 * Подключает file-logger к существующему log() — безопасный no-op, если logger не загружен.
 * Вызывается из index.js (или из самого config.js, см. ниже) сразу после загрузки config.
 */
export function attachFileLogger(fileLogger) {
  _fileLogger = fileLogger || null;
}

// В самом конце — инициализируем file-logger, если config.logFile задан.
// Не блокируем старт: динамический import, ошибки — в console.
import('./logger.js')
  .then(async (mod) => {
    await mod.initLogger(config);
    _fileLogger = { log: mod.log };
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(`[logger] init не удался: ${e.message}. Логи только в console.`);
  });
