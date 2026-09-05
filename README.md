# news-cast-ai

Multi-channel автопостинг новостей об ИИ: парсинг RSS/HTML → двухэтапная адаптация через Ollama Cloud (DeepSeek-V4-Flash для summary, DeepSeek-V4-Pro для social-блоков) → генерация картинок через ProxyAPI → параллельная публикация в **Telegram** (основной канал), **VK** (wall.post в группе), **WordPress** (черновик через REST API), **Яндекс Дзен через @zen_sync_bot** (расширенная `yandex_dzen`-версия в отдельный публичный Telegram-канал) и **markdown-черновик для Дзена** (для ручной публикации). Дополнительно экспортирует **секцию новостей и страницы статей на статический сайт business_card** (`news.json`, `articles.html`, `articles/*.html` — регламент «топ-10 за 14 дней»). Поддерживает ручную модерацию через `--review`, graceful shutdown, rate-limit гейты для Telegram/VK, ретраи с экспоненциальной задержкой и наблюдаемость через `database/runs.json` + ежедневный отчёт в `TELEGRAM_ERROR_CHAT_ID`.

## Архитектура

```
[URL источника]                  ┐
        │                        │  config.sources (CSV)
        ▼                        │
[1. parser.js]   RSS/HTML → Article[]   ──► sessions/YYYY-MM-DD/
        │                                article-{1..N}.txt + sources.json
        ▼
[2. dedup.js]    пропуск уже опубликованных (URL/slug)
        │
        ▼
[3. adapter.js]  Ollama Cloud /v1/chat/completions
        │            • Stage 1: MODEL_SUMMARY (Flash) → summary + image_prompt
        │            • Stage 2: MODEL_SOCIAL  (Pro)   → social.{telegram,vk,yandex_dzen,site_blog}
        ▼
[4. imageGenerator.js]   ProxyAPI gpt-image-1-mini (с кэшем по sha256(prompt))
        │                  → images/img-<hash16>.png, обновляет posts/article-N.json
        ▼
[5. publish-параллель]   5 каналов одновременно (best-effort, кроме Telegram):
        ├─► publisher.js          → Telegram sendPhoto (HTML-caption, parse_mode=HTML)
        ├─► publisher.vk.js       → VK wall.post (+ upload фото)
        ├─► publisher.dzen.js     → отдельный Telegram-канал для @zen_sync_bot (Дзен)
        ├─► publisher.site.js     → WP REST POST /posts status=draft
        └─► drafts.js             → drafts/dzen-N.md (для ручного копирования в Дзен)

[6. siteNews.js]          → бизнес-кард: business_card/news.json (топ-10 за 14 дней)
[7. siteArticles.js]      → бизнес-кард: business_card/articles.html + articles/<slug>.html
[8. deploySite.js]        → хостинг: news.json + articles.html + articles/* по SFTP/SSH (если настроен)
[9. runs.js]              → database/runs.json (история, MAX_RUNS=500)
[10. monitoring.js]       → алерты + ежедневный отчёт в TELEGRAM_ERROR_CHAT_ID
```

### Модули

| Модуль | Что делает | Что порождает |
|---|---|---|
| `src/config.js` | Загрузка `.env` через `dotenv`, валидация required/optional, флаги `features.{vk,site,errorChat,imageGeneration}`, функция `log()` | объект `config` |
| `src/index.js` | CLI: парсинг аргументов, проверка доступа к Ollama/Telegram, вызов `runOnceNow` / `runScheduled` / `publishPending` | — |
| `src/parser.js` | RSS (`rss-parser`) + HTML (`cheerio`), листинг → ссылки → полный текст; фильтр свежести (`FRESH_WINDOW_DAYS`); `slugify` / `buildPostFilename` для имён файлов | `sessions/YYYY-MM-DD/article-N.txt` + `sources.json` |
| `src/adapter.js` | Двухэтапный вызов Ollama Cloud с ретраями (3 попытки), парсинг ответа через `extractJSON` (сбалансированный поиск `{...}` с учётом строк/escape), защита от `finish_reason=length` удвоением `max_tokens` | `posts/YYYY-MM-DD-news-<host>-<slug>-social-content.json` |
| `src/imageGenerator.js` | `fetchWithTimeout` → ProxyAPI `/images/generations`, 3 ретрая на 429/5xx/ETIMEDOUT, кэш-лукап до запроса | `images/img-<hash16>.png` + обновление `image_path` в посте |
| `src/imageCache.js` | Индекс `database/image_cache.json`: `sha256(prompt) → filepath/bytes`, атомарная запись через `tmp → rename` | индекс кэша |
| `src/publisher.js` | Telegram `sendPhoto` (multipart, `parse_mode=HTML`); `buildCaption` с бинарным поиском границы по **escaped**-длине ≤ 1024; `rateLimit('telegram')`; `escapeHtml` для `& < >` | сообщение в Telegram-канале |
| `src/publisher.vk.js` | `photos.getWallUploadServer` → upload → `photos.saveWallPhoto` → `wall.post` с `attachments=photo{owner}_{id}_{hash}`; `rateLimit('vk')` | пост в группе VK |
| `src/publisher.dzen.js` | Telegram sendPhoto/sendMessage в `TELEGRAM_DZEN_SYNC_CHAT_ID` (публичный канал для `@zen_sync_bot`); формирует расширенный `social.yandex_dzen` (1500-2500 символов + теги); ветка короткий текст / длинный текст (2 сообщения) | пост в Telegram-канале, откуда `@zen_sync_bot` забирает в Дзен |
| `src/publisher.site.js` | WP REST `POST /posts` со `status: 'draft'`; Basic Auth (`user:pass`) или Bearer (JWT-сайт) | черновик записи на сайте |
| `src/drafts.js` | Markdown-черновик с YAML-front-matter (`title`/`description`/`tags`/`source_url`/`saved_at`) | `drafts/dzen-N.md` |
| `src/dedup.js` | Индекс `database/published.json`: `urls: { normalizedUrl → { title, slug } }` + `slugs: { slug → { url } }`; миграция из `posts/*.json` при первом запуске; атомарная запись | реестр публикаций |
| `src/scheduler.js` | Оркестратор: `runOnceNow` (parse → dedup → limit → adapt → image → parallel publish → dedup-mark), `runScheduled` (node-cron), `publishPending` (идемпотентный перезапуск); `installShutdownHandlers` (SIGINT/SIGTERM); `safeStep` (обёртка `retryWithBackoff` + `reportError`); финальный `appendRun` | вызовы остальных модулей + записи в `runs.json` |
| `src/siteNews.js` | Экспорт секции новостей для сайта business_card: сбор `posts/*.json`, фильтр «топ-10 за 14 дней» (по `source.published_at`, fallback mtime), дедуп по URL, атомарная запись (`tmp` → `rename`); карточка с `article_url` (страница статьи на самом сайте) и `dzen_url` | `business_card/news.json` |
| `src/siteArticles.js` | Экспорт страниц статей для сайта business_card: полные тексты (`social.site_blog.draft`) абзацами, `slug` = `slugifyHost(url) + '-' + slugify(title)`, эскейпинг HTML, удаление устаревших страниц (регламент «топ-10 за 14 дней»); `articleFilename` переиспользуется в siteNews.js | `business_card/articles.html` + `business_card/articles/<slug>.html` |
| `src/deploySite.js` | Автодеплой сгенерированных файлов (news.json, articles.html, articles/*) на хостинг по **SFTP/SSH** (ssh2-sftp-client, порт 22). Включается только при заданных `DEPLOY_FTP_HOST`/`USER`/`PASS`; заливает файлы, сверяет размеры, удаляет устаревшие статьи на сервере; обёрнут в `retryWithBackoff` (2 повтора); после заливки — HTTP-проверка сайта (`DEPLOY_SITE_URL`). Best-effort — ошибка не роняет прогон | файлы на удалённом хостинге (например Beget) |
| `src/cleanup.js` | Очистка старых артефактов (images/, sessions/, posts/) по `RETENTION_DAYS` (default 30); удаляет пустые поддиректории дат. Best-effort | удалённые файлы |
| `src/pending.js` | Self-contained каталог review-прогона: `manifest.json` (status: pending/published/failed/skipped), `preview.md`, скопированные картинки; `generatePendingId` = `YYYYMMDD-HHMMSS-<5rand>`; `readPendingRun` / `updatePendingArticle` / `listPendingRuns` | `pending/<id>/manifest.json` + `preview.md` + `article-N.png` |
| `src/runs.js` | История прогонов `database/runs.json` (последние 500), агрегация `summarizeRuns`, пометка `markDailyReportSent` | `database/runs.json` |
| `src/monitoring.js` | `reportError` / `reportInfo` → `sendMessage` в `TELEGRAM_ERROR_CHAT_ID` (HTML, `disable_web_page_preview`); `maybeSendDailyReport` (раз в 24ч, триггерится после scheduled-прогона) | сообщения в error-чате |
| `src/http.js` | `fetchWithTimeout(url, opts, { timeoutMs })` через `AbortController`; `TimeoutError` с `code='ETIMEDOUT'` и `retryable=true` | обёртка над `fetch` |
| `src/retry.js` | `retryWithBackoff(fn, { retries, baseMs, factor, maxMs, jitterMs, retryOn(err) })` — повторяет только если `err.retryable === true`; уважает `err.retryAfter` (429) | — |
| `src/rateLimit.js` | Per-name гейт минимального интервала (`'telegram'`, `'vk'`); слот резервируется синхронно до `await` | — |

## Структура проекта

```
news_cast_ai/
├── src/
│   ├── config.js           # загрузка .env + валидация + features
│   ├── index.js            # CLI
│   ├── parser.js           # RSS/HTML → Article[] + persistArticles
│   ├── adapter.js          # Ollama Cloud 2-stage (summary → social)
│   ├── imageGenerator.js   # ProxyAPI gpt-image-1-mini (с кэшем)
│   ├── imageCache.js       # sha256(prompt) → файл
│   ├── publisher.js        # Telegram sendPhoto
│   ├── publisher.vk.js     # VK wall.post
│   ├── publisher.site.js   # WordPress REST draft
│   ├── drafts.js           # Яндекс Дзен → markdown
│   ├── dedup.js            # реестр published.json
│   ├── scheduler.js        # оркестратор runOnceNow / runScheduled / publishPending
│   ├── siteNews.js         # экспорт news.json для сайта business_card
│   ├── siteArticles.js     # экспорт articles.html + articles/*.html для business_card
│   ├── deploySite.js       # автодеплой файлов сайта на хостинг по SFTP/SSH
│   ├── cleanup.js          # очистка старых артефактов (RETENTION_DAYS)
│   ├── pending.js          # ручная модерация (--review)
│   ├── runs.js             # история прогонов runs.json
│   ├── monitoring.js       # алерты + ежедневный отчёт
│   ├── http.js             # fetchWithTimeout
│   ├── retry.js            # retryWithBackoff
│   └── rateLimit.js        # per-name гейт
├── sessions/               # исходники статей (генерируется)
├── posts/                  # JSON-адаптации (генерируется)
├── images/                 # PNG-картинки img-<hash16>.png (генерируется)
├── drafts/                 # markdown-черновики Дзен dzen-N.md (генерируется)
├── pending/                # review-прогоны (генерируется)
├── database/
│   ├── published.json      # реестр публикаций
│   ├── image_cache.json    # sha256(prompt) → файл
│   └── runs.json           # история прогонов (≤ 500)
├── .env                    # реальные ключи (в .gitignore)
├── .env.example            # шаблон
├── package.json
└── README.md
```

## Требования

- **Node.js ≥ 18** (используются встроенные `fetch`, `FormData`, `Blob`, `AbortController`).
- **Telegram-бот** с правом публиковать сообщения в канале/группе.
- Аккаунт **Ollama Cloud** с валидным API-ключом (двухэтапная адаптация).
- Аккаунт **ProxyAPI** с положительным балансом (генерация картинок).
- Опционально: **VK** (access token сообщества + group_id) и **WordPress-сайт** (REST API + application password) — если переменные не заданы, соответствующие каналы просто пропускаются.

## Установка

```bash
cd news_cast_ai
npm install
cp .env.example .env
# отредактируйте .env и подставьте реальные значения
```

`.env` уже добавлен в `.gitignore`. Перед `git add .` проверьте `git status`.

## Как получить токены

### Telegram Bot API

1. Откройте [@BotFather](https://t.me/BotFather), выполните `/newbot`, сохраните токен → `TELEGRAM_BOT_TOKEN`.
2. Добавьте бота в канал/группу и назначьте администратором.
3. Узнайте `TELEGRAM_CHAT_ID`:
   - напишите в канал любое сообщение от имени бота;
   - откройте `https://api.telegram.org/bot<TOKEN>/getUpdates`;
   - в JSON найдите `channel_post.chat.id` (для канала обычно `-100…`).
4. Опционально: создайте отдельный чат/канал для алертов и укажите его ID в `TELEGRAM_ERROR_CHAT_ID`.

### Ollama Cloud

1. Зарегистрируйтесь на [ollama.com](https://ollama.com) и создайте API-ключ.
2. Укажите `OLLAMA_API_BASE` (по умолчанию `https://ollama.com`) и `OLLAMA_API_KEY`.
3. Модели `MODEL_SUMMARY` и `MODEL_SOCIAL` должны быть доступны в вашем аккаунте (дефолты: `deepseek-v4-flash` и `deepseek-v4-pro`).

### ProxyAPI

1. Зарегистрируйтесь на [proxyapi.ru](https://proxyapi.ru) и пополните баланс.
2. В личном кабинете скопируйте ключ (`sk-…`) → `PROXY_API_KEY`.
3. Опционально: смените `PROXY_API_BASE` и/или `PROXY_IMAGE_MODEL` (по умолчанию `gpt-image-1-mini`).

### VK (опционально)

1. Создайте сообщество, получите `access_token` с правами на `wall` + `photos` → `VK_ACCESS_TOKEN`.
2. Укажите `VK_GROUP_ID` (положительный ID группы).
3. При необходимости поднимите `VK_API_VERSION` (по умолчанию `5.199`).

### WordPress-сайт (опционально)

1. `SITE_API_URL` — база WP REST API (например `https://example.com/wp-json/wp/v2`).
2. `SITE_API_KEY` — application password в формате `username:application-password` (Basic Auth) или JWT-токен (Bearer).

### Яндекс Дзен через @zen_sync_bot (опционально)

Прямого API автопостинга в Яндекс Дзен нет. Самый надёжный способ — официальный Telegram-бот **@zen_sync_bot** (Синхробот): он сам забирает посты из привязанного публичного Telegram-канала и публикует их в Дзен. Этот канал — **отдельный от основного Telegram-канала**, потому что Дзен требует развёрнутый текст (`social.yandex_dzen`, 1500-2500 символов с тегами), а не короткий `social.telegram`.

1. Создайте **публичный** Telegram-канал (например `@my_dzen_channel`). Он должен быть публичным — Синхробот не работает с приватными.
2. Добавьте вашего бота (тот же `TELEGRAM_BOT_TOKEN`, что и для основного канала) **администратором** этого канала.
3. Добавьте `@zen_sync_bot` в канал и выдайте ему права на публикацию.
4. Следуйте инструкциям `@zen_sync_bot` для привязки канала к вашему Дзен-аккаунту.
5. Укажите `TELEGRAM_DZEN_SYNC_CHAT_ID=@my_dzen_channel` (или числовой ID вида `-100xxxxxxxxxx`) в `.env`.

Что попадает в канал: расширенный `social.yandex_dzen` (title + description + draft + хештеги) — **не** короткий `social.telegram`. Если текст влезает в 1024 символа — отправляется одним `sendPhoto` с подписью. Если больше — `sendPhoto` с короткой подписью и отдельный `sendMessage` с полным текстом (Синхробот склеивает их в Дзене). Если не задано — `drafts/dzen-N.md` остаётся для ручной публикации в редакторе Дзена.

## Запуск

```bash
# один прогон
node src/index.js https://www.artificialintelligence-news.com/feed

# dry-run (без публикации)
node src/index.js https://www.artificialintelligence-news.com/feed --dry-run

# long-running по cron
node src/index.js https://www.artificialintelligence-news.com/feed --schedule

# ручная модерация: генерация в pending/<id>/ без публикации
node src/index.js https://www.artificialintelligence-news.com/feed --review

# публикация ранее отложенного review-прогона
node src/index.js --publish-pending 20260823-125014-abc12
```

Поведение по умолчанию: **3 свежих статьи** (`ARTICLES_PER_RUN`) → `sessions/дата/article-*.txt` + `sources.json` → 2 вызова Ollama на статью (summary + social) → `posts/*.json` → 1 вызов ProxyAPI (с кэшем) → параллельная публикация в Telegram (основной канал) + VK (если настроен) + Telegram-канал для @zen_sync_bot (если задан `TELEGRAM_DZEN_SYNC_CHAT_ID`) + WordPress (если настроен) + `drafts/dzen-N.md` → экспорт на бизнес-кард (`news.json`, `articles.html`, `articles/*.html`; выключить — `BUSINESS_CARD_NEWS_PATH=off` / `SITE_ARTICLES_DIR=off`). **Первый** пост публикуется сразу, **каждый следующий** — через `POST_INTERVAL_MS` (по умолчанию 60 000 мс = 1 минута).

## Артефакты прогона

После `--once` (или внутри `--schedule`) создаются:

```
news_cast_ai/
├── sessions/
│   └── YYYY-MM-DD/
│       ├── article-1.txt        # чистый текст + метаданные в шапке (---…---)
│       ├── article-2.txt
│       ├── article-3.txt
│       └── sources.json         # индекс: [{index, title, url, published_at, file}]
├── posts/
│   ├── 2026-08-23-news-<host>-<slug>-social-content.json
│   └── …                        # полная схема content-adaptor/v2 (см. ниже)
├── images/
│   └── img-<hash16>.png         # кэшируются по sha256(prompt)
├── drafts/
│   ├── dzen-1.md                # YAML-front-matter + draft для Дзен
│   ├── dzen-2.md
│   └── dzen-3.md
├── database/
│   ├── published.json           # реестр дедупликации
│   ├── image_cache.json         # sha256(prompt) → filepath
│   └── runs.json                # история прогонов (≤ 500)
└── pending/                     # только в --review
    └── <id>/
        ├── manifest.json
        ├── preview.md
        ├── article-1.png
        ├── article-2.png
        └── article-3.png
```

Плюс экспорт для сайта business_card (папка `../business_card/`):

```
../business_card/
├── news.json            # последние 10 новостей за 14 дней
├── articles.html        # список статей
└── articles/            # страницы статей <slug>.html
    └── <slug>.html      # полные тексты (site_blog.draft), остальное — удаляется
```

### Формат `posts/*.json` (content-adaptor/v2)

```json
{
  "schema_version": "content-adaptor/v2",
  "source": { "title": "...", "url": "...", "published_at": "..." },
  "summary": { "title": "...", "main_point": "...", "why_it_matters": "...", "facts_used": [] },
  "image_prompt": "English prompt for image generation, no text, no logos",
  "image_path": "C:/.../images/img-<hash16>.png",
  "social": {
    "telegram":    { "title": "...", "draft": "≤ 950 символов", "cta": "..." },
    "vk":          { "title": "...", "draft": "... + 3-5 хэштегов", "cta": "..." },
    "yandex_dzen": { "title": "...", "description": "...", "draft": "1500-2500 символов", "tags": [] },
    "site_blog":   { "h1": "...", "meta_description": "...", "draft": "2000-4000 символов, SEO", "cta": "..." }
  }
}
```

### Формат `sessions/article-N.txt`

```
---
title: ...
url: ...
published_at: ...
---

<чистый текст статьи>
```

## Конфигурация (`.env`)

| Переменная | Обязательная | Дефолт | Назначение |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | да | — | Токен Telegram-бота |
| `TELEGRAM_CHAT_ID` | да | — | ID канала/чата для публикации (`-100…` для канала, положительный для личного чата) |
| `TELEGRAM_API_BASE` | нет | `https://api.telegram.org` | Базовый URL Bot API |
| `TELEGRAM_ERROR_CHAT_ID` | нет | `''` | Чат для алертов об ошибках; пусто — алерты подавляются |
| `TELEGRAM_RATE_LIMIT_MS` | нет | `1000` | Минимальный интервал между запросами к Telegram (мс) |
| `TELEGRAM_DZEN_SYNC_CHAT_ID` | нет | `''` | Публичный Telegram-канал для @zen_sync_bot (Дзен); пусто — синхронизация с Дзен через Telegram отключена, остаётся `drafts/dzen-N.md` для ручной публикации |
| `PROXY_API_KEY` | да | — | Ключ ProxyAPI для генерации картинок |
| `PROXY_API_BASE` | нет | `https://api.proxyapi.ru/openai/v1` | Базовый URL OpenAI-совместимого API |
| `PROXY_IMAGE_MODEL` | нет | `gpt-image-1-mini` | Модель для картинок |
| `OLLAMA_API_BASE` | да | — | Базовый URL Ollama Cloud API |
| `OLLAMA_API_KEY` | да | — | API-ключ Ollama Cloud |
| `MODEL_SUMMARY` | нет | `deepseek-v4-flash` | Модель для этапа 1 (summary + image_prompt) |
| `MODEL_SOCIAL` | нет | `deepseek-v4-pro` | Модель для этапа 2 (social-блоки) |
| `VK_ACCESS_TOKEN` | нет | `''` | Токен сообщества VK; пусто — публикация в VK пропускается |
| `VK_GROUP_ID` | нет | `''` | ID группы VK (положительный) |
| `VK_API_VERSION` | нет | `5.199` | Версия VK API |
| `VK_RATE_LIMIT_MS` | нет | `350` | Минимальный интервал между запросами к VK (мс) |
| `SITE_API_URL` | нет | `''` | WP REST API base; пусто — публикация на сайт пропускается |
| `SITE_API_KEY` | нет | `''` | Application password (`user:pass`) или JWT Bearer |
| `SESSIONS_DIR` | нет | `./sessions` | Папка для sessions/дата/ |
| `POSTS_DIR` | нет | `./posts` | Папка для JSON-постов |
| `IMAGES_DIR` | нет | `./images` | Папка для PNG-картинок |
| `DRAFTS_DIR` | нет | `./drafts` | Папка для Дзен-черновиков |
| `DB_PATH` | нет | `./database/published.json` | Путь к реестру публикаций |
| `IMAGE_CACHE_PATH` | нет | `./database/image_cache.json` | Кэш `sha256(prompt) → файл` |
| `RUNS_PATH` | нет | `./database/runs.json` | История прогонов |
| `PENDING_DIR` | нет | `./pending` | Каталог review-прогонов |
| `BUSINESS_CARD_NEWS_PATH` | нет | `../business_card/news.json` | Путь к `news.json` сайта business_card; `off` — экспорт секции новостей отключён |
| `SITE_ARTICLES_DIR` | нет | `../business_card/articles` | Каталог страниц статей сайта business_card; `off` — экспорт статей отключён |
| `SITE_ARTICLES_LIST_PATH` | нет | `../business_card/articles.html` | Путь к списку статей `articles.html` |
| `DEPLOY_FTP_HOST` | нет | `''` | Хост хостинга (SFTP/SSH); вместе с `USER`/`PASS` включает автодеплой |
| `DEPLOY_FTP_PORT` | нет | `21` | Порт FTP (не используется для SFTP) |
| `DEPLOY_SFTP_PORT` | нет | `22` | Порт SFTP/SSH для автодеплоя |
| `DEPLOY_FTP_USER` | нет | `''` | Логин (FTP/SSH) |
| `DEPLOY_FTP_PASS` | нет | `''` | Пароль (FTP/SSH) |
| `DEPLOY_FTP_SECURE` | нет | `0` | Не используется для SFTP (оставлен для обратной совместимости) |
| `DEPLOY_FTP_REMOTE_DIR` | нет | `/public_html` | Не используется для SFTP (база берётся из `sftp.cwd()`) |
| `DEPLOY_SITE_URL` | нет | `''` | Публичный URL сайта для HTTP-проверки после деплоя (fetch к `<url>/news.json`) |
| `RETENTION_DAYS` | нет | `30` | Сколько дней хранить старые файлы в images/, sessions/, posts/ (0 — не чистить) |
| `SOURCES` | нет | `''` | CSV URL источников (через запятую); приоритет над URL из CLI |
| `ARTICLES_PER_RUN` | нет | `3` | Сколько статей обрабатывать за прогон |
| `FRESH_WINDOW_DAYS` | нет | `1` | Окно свежести: 1 = только сегодня, 7 = за неделю, 0 = без фильтра |
| `DISABLE_IMAGE_GENERATION` | нет | `0` | `1/true/yes/да` — публиковать без фото |
| `POST_INTERVAL_MS` | нет | `60000` | Интервал между постами внутри прогона (мс) |
| `SCHEDULE_CRON` | нет | `0 */2 * * *` | node-cron выражение для `--schedule` |
| `LOG_LEVEL` | нет | `info` | `debug` \| `info` \| `warn` \| `error` |

`ANTHROPIC_API_KEY` **не используется** — это ключ самого Claude Code, он не должен попадать в эти скрипты.

## Команды CLI

```bash
# Один прогон (по умолчанию)
node src/index.js <URL>
node src/index.js <URL> --once

# Dry-run: подготовить посты без публикации
node src/index.js <URL> --dry-run

# Long-running по cron SCHEDULE_CRON из .env
node src/index.js <URL> --schedule

# Ручная модерация: артефакты в pending/<id>/, без публикации
node src/index.js <URL> --review

# Публикация ранее сгенерированного review-прогона
node src/index.js --publish-pending <id>

# Справка
node src/index.js --help
```

Источники: `SOURCES` (CSV) из `.env` имеет приоритет над URL из CLI. Если заданы оба — URL из CLI игнорируется с предупреждением в логе.

## Мониторинг

- **`TELEGRAM_ERROR_CHAT_ID`** — чат (обычно личный, положительный ID), куда `monitoring.js` шлёт алерты об ошибках (HTML, `disable_web_page_preview`). Не задан → алерты подавляются.
- **Ежедневный отчёт** — раз в 24 часа после scheduled-прогона `monitoring.js` агрегирует записи из `database/runs.json` (`summarizeRuns`) и шлёт сводку: число прогонов по режимам, `found/processed/ok/fail/interrupted`, `stale/no_date`, токены Ollama (`prompt/completion/total`).
- **`database/runs.json`** — история последних 500 прогонов. Каждая запись: `started_at`, `finished_at`, `duration_ms`, `mode` (`once`/`dry-run`/`review`/`publish-pending`), `sources`, `found`, `fresh_count`, `no_date_count`, `stale_count`, `dedup_skipped`, `processed`, `ok`, `fail`, `interrupted`, `pending_id`, `tokens`.
- **Дедуп** — `database/published.json` хранит `urls: { normalizedUrl → { title, slug } }` и `slugs: { slug → { url } }`. При первом запуске мигрирует из `posts/*.json` (если индекс пуст).

## Ручная модерация

Режим `--review` отделяет генерацию от публикации. Полезно, когда тексты нужно сначала посмотреть глазами.

```bash
# 1) Сгенерировать посты в pending/<id>/
node src/index.js <URL> --review
# → создаётся pending/<id>/manifest.json + preview.md + article-N.png

# 2) Открыть preview.md, вычитываешь тексты

# 3) Опубликовать (идемпотентно — уже опубликованные статьи пропускаются)
node src/index.js --publish-pending <id>
```

`pending/<id>/` self-contained: содержит **копии картинок** (не зависит от `images/`, который может перезаписаться следующим прогоном), `manifest.json` со статусом каждой статьи (`pending`/`published`/`failed`/`skipped`) и `preview.md` с человекочитаемыми текстами Telegram/VK. Идемпотентность `markPublished` (в `dedup.js`) позволяет безопасно перезапускать `--publish-pending` — дубликаты не появятся.

## Graceful shutdown

В режиме `--schedule` (и `--once`) перехватываются `SIGINT` и `SIGTERM` (`installShutdownHandlers` в `scheduler.js`):

- **Первый сигнал** → `shutdownRequested = true`. Цикл `runOnceNow` **корректно завершает текущую статью** (включая `markPublished` в `dedup` — иначе при следующем запуске дедуп не сработал бы и статья опубликовалась дублем), затем прерывается.
- **Второй сигнал** (если оператор не дождался) → `process.exit(130)` аварийно.

Код выхода при штатном прерывании: `130` (стандарт для «прервано пользователем»: `128 + SIGINT`).

## Безопасность

- Все секреты хранятся в `.env`, который **уже добавлен в `.gitignore`**. Перед `git add .` проверяйте `git status`.
- **`ANTHROPIC_API_KEY` не используется** и не должен попадать в скрипты. Claude CLI авторизуется самостоятельно.
- Все внешние HTTP-вызовы идут через `fetchWithTimeout` с явными `timeoutMs` (15 с для проверок, 30 с для Telegram, 60 с для ProxyAPI / VK upload, 120 с для Ollama). Зависший API не подвешивает прогон.
- Telegram `sendPhoto` **не ретраится на сетевых таймаутах** — мы не знаем, дошёл ли запрос, и повтор рискует дублем. Только HTTP 429/5xx → retry.

## Устранение неполадок

| Симптом | Решение |
|---|---|
| `Ollama API недоступен` / `HTTP 401` | Проверьте `OLLAMA_API_BASE` и `OLLAMA_API_KEY`. Для 401 — перевыпустите ключ в личном кабинете Ollama Cloud. |
| `Ollama HTTP 429` или `finish_reason=length` | Адаптер ретраит 429 автоматически (3 попытки). `finish_reason=length` — удваивает `max_tokens` и повторяет один раз. Если не помогло — попробуйте другую модель в `MODEL_SUMMARY` / `MODEL_SOCIAL`. |
| `ProxyAPI HTTP 401` | Неверный `PROXY_API_KEY`. |
| `ProxyAPI HTTP 429` | Ретраится автоматически (до 3 попыток с задержкой 1.5/4/9 с). |
| `ProxyAPI: data[0] не содержит b64_json или url` | Проверьте, что `PROXY_IMAGE_MODEL` поддерживается провайдером. |
| `Telegram sendPhoto: chat not found` | Проверьте `TELEGRAM_CHAT_ID` (канал обычно начинается с `-100`). Бот должен быть администратором канала. |
| `Telegram sendPhoto: bot was blocked` | Канал/пользователь заблокировал бота — пересоздайте канал или разблокируйте. |
| `Telegram sendPhoto: message is too long` | Caption обрезается автоматически в `buildCaption` (бинарный поиск по escaped-длине). Если ошибка повторяется — проверьте `social.telegram.draft` (лимит 1024 с учётом заголовка и CTA). |
| `VK error_code=6 "Too many requests"` | Увеличьте `VK_RATE_LIMIT_MS` (по умолчанию 350). |
| `Telegram Dzen sendPhoto: chat not found` | Проверьте `TELEGRAM_DZEN_SYNC_CHAT_ID` (публичный канал, бот — админ). Канал должен быть публичным, иначе @zen_sync_bot не подхватит. |
| `Telegram Dzen sendPhoto: bot was blocked by user` | Бот не админ канала — добавьте его как администратора и проверьте, что @zen_sync_bot тоже в канале. |
| `database/image_cache.json повреждён` | `imageCache.js` ловит JSON-ошибку и пересоздаёт пустой индекс (с warning). Файлы картинок на диске не трогаются — кэш восстановится постепенно. |
| `database/published.json повреждён` | `dedup.js` делает то же самое: при невалидном JSON создаёт пустой индекс и при первом запуске мигрирует данные из `posts/*.json`. |
| `runOnceNow: нет свежих статей` | Нормальное завершение прогона: в источнике нет статей в окне `FRESH_WINDOW_DAYS`. Увеличьте окно (например, `FRESH_WINDOW_DAYS=7`) или проверьте, что в фиде есть `published_at`. |
| Pending-прогон прерван по Ctrl+C | Это нормально. `manifest.json` обновляется атомарно после каждой статьи — повторный `node src/index.js --publish-pending <id>` продолжит с места останова. |
| `--publish-pending <id>` ругается, что прогон не найден | Проверьте, что каталог `pending/<id>/` существует и содержит `manifest.json`. Ид: `YYYYMMDD-HHMMSS-<5rand>`. |

## Лицензия

Только для личного использования.
