// tests/sg-captcha.test.mjs
// Проверяем чистую логику src/sgCaptcha.js БЕЗ запуска Playwright:
// распознавание капчи, извлечение host, живучесть cookie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSgCaptcha, hostOf } from '../src/sgCaptcha.js';

test('looksLikeSgCaptcha: быстрый вариант капчи (meta refresh)', () => {
  const body = '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Ffeed&y=ipc:185.22.65.115:1788586267.213"></meta></head></html>';
  assert.equal(looksLikeSgCaptcha(body), true);
});

test('looksLikeSgCaptcha: полный вариант (Robot Challenge Screen)', () => {
  const body = '<!doctype html><html><head><meta name="ROBOTS" content="NOINDEX, NOFOLLOW"><title>Robot Challenge Screen</title></head></html>';
  assert.equal(looksLikeSgCaptcha(body), true);
});

test('looksLikeSgCaptcha: обычный XML-фид — НЕ капча', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>AI News</title></channel></rss>';
  assert.equal(looksLikeSgCaptcha(xml), false);
});

test('looksLikeSgCaptcha: обычная HTML-страница статьи — НЕ капча', () => {
  const html = '<!DOCTYPE html><html><body><article><h1>Title</h1><p>Content</p></article></body></html>';
  assert.equal(looksLikeSgCaptcha(html), false);
});

test('looksLikeSgCaptcha: не-строка / пустота → false', () => {
  assert.equal(looksLikeSgCaptcha(''), false);
  assert.equal(looksLikeSgCaptcha(null), false);
  assert.equal(looksLikeSgCaptcha(undefined), false);
});

test('looksLikeSgCaptcha: регистронезависимо', () => {
  assert.equal(looksLikeSgCaptcha('SGCAPTCHA'), true);
  assert.equal(looksLikeSgCaptcha('Well-Known/Captcha'), true);
});

test('hostOf: достаёт hostname без www.', () => {
  assert.equal(hostOf('https://www.artificialintelligence-news.com/feed'), 'artificialintelligence-news.com');
  assert.equal(hostOf('https://techcrunch.com/category/ai/'), 'techcrunch.com');
  assert.equal(hostOf('http://example.com/x'), 'example.com');
});

test('hostOf: невалидный URL → null', () => {
  assert.equal(hostOf('not-a-url'), null);
  assert.equal(hostOf(''), null);
  assert.equal(hostOf(null), null);
});
