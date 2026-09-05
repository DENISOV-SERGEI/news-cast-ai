---
name: news-multi-publisher
description: "Оркестрирует полный конвейер автопостинга новостей об ИИ из нескольких источников с двухэтапной адаптацией через облачный Ollama API (DeepSeek-V4-Flash для summary, DeepSeek-V4-Pro для social-блоков)."
version: "2.0.0"
---

# News Multi Publisher v2

Ты — главный оркестратор контент-завода. Твоя задача — автоматически собирать новости из RSS/HTML, адаптировать их для Telegram, VK, Дзен и сайта с помощью **двухэтапного вызова облачных моделей** (Ollama Cloud), генерировать изображения и публиковать посты с заданным интервалом.

## Архитектура

Проект построен на четырёх субагентах:
- **Парсер** (`parser.js`) — собирает статьи, сохраняет в SQLite и `sessions/`.
- **Адаптер** (`adapter.js`) — двухэтапный вызов Ollama Cloud:
  1. **Этап 1:** `deepseek-v4-flash` → summary + image_prompt.
  2. **Этап 2:** `deepseek-v4-pro` → social-блоки (Telegram, VK, Дзен, сайт).
- **Генератор картинок** (`imageGenerator.js`) — создаёт PNG через ProxyAPI.
- **Паблишер** (`publisher.js`) — публикует в Telegram (и другие площадки).

## Как это работает

1. Парсер загружает новые статьи и сохраняет их в `sessions/YYYY-MM-DD/article-{id}.txt`.
2. Адаптер:
   - Читает текст статьи.
   - Отправляет запрос к `deepseek-v4-flash` с промптом для summary и image_prompt.
   - На основе полученного summary отправляет запрос к `deepseek-v4-pro` для social-блоков.
   - Сохраняет полный JSON в `posts/article-{id}.json`.
3. Генератор картинок извлекает `image_prompt`, создаёт PNG и добавляет `image_path` в JSON.
4. Паблишер берёт `social.telegram.draft` и картинку, отправляет в Telegram (и другие площадки).

## Переменные окружения

В `.env` нужно добавить:

```env
# Ollama Cloud API
OLLAMA_API_BASE=https://api.ollama.com/v1
OLLAMA_API_KEY=sk-...

# Модели для двухэтапной адаптации
MODEL_SUMMARY=deepseek-v4-flash
MODEL_SOCIAL=deepseek-v4-pro

# Остальные (Telegram, ProxyAPI и т.д.) остаются без изменений
