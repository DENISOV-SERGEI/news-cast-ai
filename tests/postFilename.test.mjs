// tests/postFilename.test.mjs
// Регрессионные тесты на B8: имена постов должны быть уникальны в multi-source
// даже при одинаковых заголовках в один день. Покрывает slugifyHost + buildPostFilename.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugifyHost, buildPostFilename } from '../src/parser.js';

// === slugifyHost ===

test('slugifyHost: the-decoder.com → the-decoder-com', () => {
  assert.equal(slugifyHost('https://the-decoder.com/2026/08/foo'), 'the-decoder-com');
});

test('slugifyHost: artificialintelligence-news.com → artificialintelligence-news-com', () => {
  assert.equal(slugifyHost('https://artificialintelligence-news.com/feed'), 'artificialintelligence-news-com');
});

test('slugifyHost: убирает www. и приводит к нижнему регистру', () => {
  assert.equal(slugifyHost('HTTPS://WWW.Example.COM/feed'), 'example-com');
  assert.equal(slugifyHost('http://www.Example.COM/feed'), 'example-com');
});

test('slugifyHost: просто домен без протокола', () => {
  assert.equal(slugifyHost('foo.bar.com'), 'foo-bar-com');
});

test('slugifyHost: 5+ разных доменов → уникальные slug' + '', () => {
  const domains = [
    'https://the-decoder.com/feed',
    'https://artificialintelligence-news.com/feed',
    'https://venturebeat.com/category/ai/feed',
    'https://techcrunch.com/category/artificial-intelligence/feed',
    'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    'https://openai.com/blog/rss.xml',
  ];
  const slugs = domains.map((d) => slugifyHost(d));
  // Все непустые
  assert.ok(slugs.every((s) => s && s !== 'unknown'));
  // Все уникальные
  assert.equal(new Set(slugs).size, slugs.length, `коллизии в: ${slugs.join(', ')}`);
});

test('slugifyHost: пустая строка / null / undefined → unknown', () => {
  assert.equal(slugifyHost(''), 'unknown');
  assert.equal(slugifyHost(null), 'unknown');
  assert.equal(slugifyHost(undefined), 'unknown');
  assert.equal(slugifyHost('   '), 'unknown');
});

test('slugifyHost: невалидный URL (но похож на домен) — fallback как есть', () => {
  // Просто строка без протокола и без точек — после транслитерации дефисов/точек
  // остаётся как есть. Главное — нет падения и не возвращается пустая строка.
  const out = slugifyHost('not a url at all');
  assert.ok(out.length > 0);
  assert.notEqual(out, 'unknown');
});

test('slugifyHost: схлопывает подряд идущие дефисы от точек', () => {
  assert.equal(slugifyHost('a..b..c.com'), 'a-b-c-com');
});

// === buildPostFilename: позитивные кейсы ===

test('buildPostFilename: один источник, разные даты → разные имена', () => {
  const a = buildPostFilename({
    title: 'Some news',
    url: 'https://the-decoder.com/2026/08/a',
    published_at: '2026-08-22T10:00:00Z',
  });
  const b = buildPostFilename({
    title: 'Some news',
    url: 'https://the-decoder.com/2026/08/b',
    published_at: '2026-08-23T10:00:00Z',
  });
  assert.notEqual(a, b);
  assert.match(a, /^2026-08-22-news-the-decoder-com-some-news-social-content\.json$/);
  assert.match(b, /^2026-08-23-news-the-decoder-com-some-news-social-content\.json$/);
});

test('buildPostFilename: один источник, одинаковые даты, разные заголовки → разные имена', () => {
  const a = buildPostFilename({
    title: 'First headline',
    url: 'https://example.com/first',
    published_at: '2026-08-22T10:00:00Z',
  });
  const b = buildPostFilename({
    title: 'Second headline',
    url: 'https://example.com/second',
    published_at: '2026-08-22T11:00:00Z',
  });
  assert.notEqual(a, b);
  assert.match(a, /-first-headline-/);
  assert.match(b, /-second-headline-/);
});

// === buildPostFilename: регрессия B8 ===

test('buildPostFilename (B8): два источника, одинаковая дата, одинаковый заголовок → РАЗНЫЕ имена', () => {
  // Сценарий бага: multi-source pipeline, два RSS в один день дают
  // статьи с одинаковым заголовком вроде «OpenAI Releases GPT-5».
  // До фикса buildPostFilename не учитывал хост → оба файла получали
  // одно и то же имя → writeFile затирал первый вторым.
  const sameTitle = 'OpenAI Releases GPT-5';
  const sameDate = '2026-08-22T15:00:00Z';

  const fromDecoder = buildPostFilename({
    title: sameTitle,
    url: 'https://the-decoder.com/2026/08/openai-releases-gpt-5',
    published_at: sameDate,
  });
  const fromAiNews = buildPostFilename({
    title: sameTitle,
    url: 'https://artificialintelligence-news.com/2026/08/openai-gpt-5-launch',
    published_at: sameDate,
  });

  assert.notEqual(
    fromDecoder,
    fromAiNews,
    `B8 регрессия: ожидались разные имена, оба: ${fromDecoder}`,
  );
  assert.match(fromDecoder, /-news-the-decoder-com-openai-releases-gpt-5-social-content\.json$/);
  assert.match(fromAiNews, /-news-artificialintelligence-news-com-openai-releases-gpt-5-social-content\.json$/);
});

test('buildPostFilename: три источника с одинаковым заголовком — все имена уникальны', () => {
  const sameTitle = 'Anthropic launches Claude 4';
  const sameDate = '2026-08-22T15:00:00Z';

  const sources = [
    'https://the-decoder.com/x',
    'https://artificialintelligence-news.com/x',
    'https://venturebeat.com/x',
  ].map((url) => buildPostFilename({
    title: sameTitle,
    url,
    published_at: sameDate,
  }));

  assert.equal(new Set(sources).size, sources.length, `коллизии: ${sources.join(', ')}`);
});

// === buildPostFilename: fallback, когда url пустой ===

test('buildPostFilename: пустой url → hostSlug=unknown', () => {
  const fname = buildPostFilename({
    title: 'Some news',
    url: '',
    published_at: '2026-08-22T15:00:00Z',
  });
  assert.match(fname, /^2026-08-22-news-unknown-some-news-social-content\.json$/);
});

test('buildPostFilename: undefined url → hostSlug=unknown', () => {
  const fname = buildPostFilename({
    title: 'Some news',
    published_at: '2026-08-22T15:00:00Z',
  });
  assert.match(fname, /^2026-08-22-news-unknown-some-news-social-content\.json$/);
});

test('buildPostFilename: meta=null не падает → hostSlug=unknown, slug=untitled', () => {
  const fname = buildPostFilename(null);
  // Берёт сегодняшнюю дату + unknown + untitled
  const today = new Date().toISOString().slice(0, 10);
  assert.match(fname, new RegExp(`^${today}-news-unknown-untitled-social-content\\.json$`));
});
