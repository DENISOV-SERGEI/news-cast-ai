// tests/utils-format.test.mjs
// Регресс на хелперы в src/utils.js: formatLocal и три варианта appendSourceLink.
// Покрывает:
//   - formatLocal: валидный ISO → локальный формат; null → '';
//   - appendSourceLink: с/без url, с/без label;
//   - appendSourceLinkHtml: экранирование & < > в label;
//   - appendSourceLinkMarkdown: корректная md-ссылка.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLocal,
  appendSourceLink,
  appendSourceLinkHtml,
  appendSourceLinkMarkdown,
  pickEmoji,
  decorateTitle,
} from '../src/utils.js';

test('formatLocal: ISO → YYYY-MM-DD HH:MM:SS (локальное время)', () => {
  // Проверяем формат, не абсолютное значение — TZ у CI может быть любой.
  const out = formatLocal('2026-08-23T16:45:38.519Z');
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('formatLocal: null → пустая строка', () => {
  assert.equal(formatLocal(null), '');
  assert.equal(formatLocal(undefined), '');
  assert.equal(formatLocal(''), '');
  assert.equal(formatLocal('not a date'), '');
});

test('appendSourceLink: пустой url → текст без изменений', () => {
  assert.equal(appendSourceLink('text', ''), 'text');
  assert.equal(appendSourceLink('text', null), 'text');
});

test('appendSourceLink: добавляет ссылку через два переноса и label', () => {
  const out = appendSourceLink('text', 'https://example.com/foo', '🔗 Оригинал статьи');
  assert.equal(out, 'text\n\n🔗 Оригинал статьи: https://example.com/foo');
});

test('appendSourceLink: гарантирует ровно один пустой разделитель абзаца (\n\n)', () => {
  // base без \n → добавляем \n\n
  assert.equal(appendSourceLink('text', 'https://e.com'), 'text\n\n🔗 Оригинал статьи: https://e.com');
  // base с одним \n на конце → добавляем ещё один (\n\n)
  assert.equal(appendSourceLink('text\n', 'https://e.com'), 'text\n\n🔗 Оригинал статьи: https://e.com');
  // base уже с \n\n — лишних не пишем
  assert.equal(appendSourceLink('text\n\n', 'https://e.com'), 'text\n\n🔗 Оригинал статьи: https://e.com');
});

test('appendSourceLinkHtml: пустой url → html без изменений', () => {
  assert.equal(appendSourceLinkHtml('<p>x</p>', ''), '<p>x</p>');
});

test('appendSourceLinkHtml: добавляет <a target=_blank rel=noopener noreferrer>', () => {
  const out = appendSourceLinkHtml('<p>x</p>', 'https://example.com/foo', '🔗 Оригинал');
  assert.equal(
    out,
    '<p>x</p>\n<p><a href="https://example.com/foo" target="_blank" rel="noopener noreferrer">🔗 Оригинал</a></p>',
  );
});

test('appendSourceLinkHtml: экранирует " в href и < > в label', () => {
  const out = appendSourceLinkHtml('<p>x</p>', 'https://ex.com/?a="b"', '<bad>');
  assert.match(out, /href="https:\/\/ex\.com\/\?a=&quot;b&quot;"/);
  assert.match(out, /&lt;bad&gt;/);
});

test('appendSourceLinkMarkdown: пустой url → md без изменений', () => {
  assert.equal(appendSourceLinkMarkdown('text', ''), 'text');
});

test('appendSourceLinkMarkdown: добавляет [label](url) через два переноса', () => {
  const out = appendSourceLinkMarkdown('text', 'https://example.com/foo', 'Оригинал');
  assert.equal(out, 'text\n\n[Оригинал](https://example.com/foo)');
});

// ===== pickEmoji / decorateTitle =====

test('pickEmoji: launch / запуск → 🚀', () => {
  assert.equal(pickEmoji('OpenAI запустил новый сервис'), '🚀');
  assert.equal(pickEmoji('GPT-5 launch announced'), '🚀');
});

test('pickEmoji: privacy / безопасность → 🔒', () => {
  assert.equal(pickEmoji('Новый закон о приватности'), '🔒');
  assert.equal(pickEmoji('Mass surveillance concerns'), '🔒');
});

test('pickEmoji: games / игр → 🎮', () => {
  assert.equal(pickEmoji('From Atari to EVE Online'), '🎮');
});

test('pickEmoji: research → 🧬', () => {
  assert.equal(pickEmoji('Новое исследование рака'), '🧬');
});

test('pickEmoji: bill / закон → ⚖️', () => {
  assert.equal(pickEmoji('Законопроект о запрете закупок'), '⚖️');
});

test('pickEmoji: пусто или неизвестно → 🤖 fallback', () => {
  assert.equal(pickEmoji(''), '🤖');
  assert.equal(pickEmoji('Какой-то пост без ключевых слов'), '🤖');
});

test('decorateTitle: добавляет emoji в начало, если его там нет', () => {
  // «Запуск» — триггер запуска, побеждает «gpt».
  assert.equal(decorateTitle('Запуск GPT-5', ''), '🚀 Запуск GPT-5');
  // Без явных триггеров, но «gpt» сам по себе подсвечивает «LLM».
  assert.equal(decorateTitle('OpenAI releases GPT-5', ''), '🧠 OpenAI releases GPT-5');
});

test('decorateTitle: не дублирует, если emoji уже есть', () => {
  assert.equal(decorateTitle('🚀 Запуск GPT-5', ''), '🚀 Запуск GPT-5');
  assert.equal(decorateTitle('🤖 Какой-то пост', ''), '🤖 Какой-то пост');
});

test('decorateTitle: пустой title → emoji + первое предложение из body', () => {
  const out = decorateTitle('', 'Новый закон о приватности данных. Подробности внутри.');
  assert.equal(out, '🔒 Новый закон о приватности данных');
});

test('decorateTitle: пустые title и body → пустая строка', () => {
  assert.equal(decorateTitle('', ''), '');
  assert.equal(decorateTitle(null, undefined), '');
});