// tests/slug.test.mjs
// Расширенное покрытие slugify / slugifyHost / buildPostFilename.
// Фокус на edge-кейсах, не покрытых в dedup.test.mjs / postFilename.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, slugifyHost, buildPostFilename } from '../src/parser.js';

// ===================== slugify =====================

test('slugify: пустой вход → untitled', () => {
  assert.equal(slugify(''), 'untitled');
});

test('slugify: null → untitled', () => {
  assert.equal(slugify(null), 'untitled');
});

test('slugify: undefined → untitled', () => {
  assert.equal(slugify(undefined), 'untitled');
});

test('slugify: чистая кириллица → транслит с дефисами', () => {
  assert.equal(slugify('Привет мир'), 'privet-mir');
});

test('slugify: смешанный регистр → lowercase', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify: emoji и спецсимволы выкидываются', () => {
  assert.equal(slugify('AI 🤖 news!'), 'ai-news');
});

test('slugify: множественные пробелы и дефисы схлопываются', () => {
  assert.equal(slugify('foo---bar  baz'), 'foo-bar-baz');
});

test('slugify: длинный заголовок обрезается до 80 символов без trailing дефиса', () => {
  const long = 'word '.repeat(50); // 250 символов
  const out = slugify(long);
  assert.ok(out.length <= 80, `длина ${out.length}`);
  assert.ok(!out.endsWith('-'), `trailing дефис: ${out}`);
});

test('slugify: уже-slug строка остаётся как есть', () => {
  assert.equal(slugify('already-slug'), 'already-slug');
});

test('slugify: только спецсимволы → untitled', () => {
  assert.equal(slugify('!!!'), 'untitled');
  assert.equal(slugify('@@@###$$$'), 'untitled');
});

test('slugify: HTML-теги не парсятся, только теги-символы выкидываются', () => {
  // ВНИМАНИЕ: slugify — это не HTML-парсер, а простая посимвольная транслитерация.
  // Символы <, >, /, =, " выкидываются; буквы внутри тегов сохраняются.
  // Это задокументированное поведение: на вход ожидается уже очищенный текст
  // (parser.js отдаёт plain-text из cheerio .text()), а не сырой HTML.
  assert.equal(slugify('<b>AI</b>'), 'baib');
  // Буквы внутри тега <a href="x"> сохраняются, пробелы → дефисы,
  // знаки = и " выкидываются.
  assert.equal(slugify('<a href="x">Hello</a> world'), 'a-hrefxhelloa-world');
});

test('slugify: URL-подобные токены превращаются в безопасный slug', () => {
  assert.equal(slugify('OpenAI launches ChatGPT-5'), 'openai-launches-chatgpt-5');
});

test('slugify: цифры сохраняются', () => {
  assert.equal(slugify('GPT-5 review'), 'gpt-5-review');
});

test('slugify: подчёркивания → дефисы', () => {
  assert.equal(slugify('hello_world_test'), 'hello-world-test');
});

test('slugify: обрезка до 80 с защитой от trailing дефиса на границе слова', () => {
  // 79 chars + один дефис-разделитель + большой блок: обрезка должна
  // убрать висящий дефис в конце.
  const text = 'a'.repeat(78) + ' ' + 'b'.repeat(50);
  const out = slugify(text);
  assert.ok(out.length <= 80, `длина ${out.length}`);
  assert.ok(!out.endsWith('-'));
  // Все 'a' должны остаться в начале, 'b' блок обрезан
  assert.ok(out.startsWith('a'.repeat(78) + '-b'));
});

test('slugify: один спецсимвол не даёт пустой результат, если есть буквы', () => {
  assert.equal(slugify('a!b@c'), 'abc');
});

test('slugify: числа без букв — не untitled', () => {
  // Это числа, они валидны
  assert.equal(slugify('2026'), '2026');
});

// ===================== slugifyHost =====================

test('slugifyHost: null → unknown', () => {
  assert.equal(slugifyHost(null), 'unknown');
});

test('slugifyHost: undefined → unknown', () => {
  assert.equal(slugifyHost(undefined), 'unknown');
});

test('slugifyHost: пустая строка → unknown', () => {
  assert.equal(slugifyHost(''), 'unknown');
});

test('slugifyHost: the-decoder.com → the-decoder-com', () => {
  assert.equal(slugifyHost('the-decoder.com'), 'the-decoder-com');
});

test('slugifyHost: полный URL с www. и trailing slash → чистый хост-slug', () => {
  assert.equal(
    slugifyHost('https://www.artificialintelligence-news.com/'),
    'artificialintelligence-news-com',
  );
});

test('slugifyHost: subdomain → sub-domain-org', () => {
  assert.equal(slugifyHost('sub.domain.org'), 'sub-domain-org');
});

test('slugifyHost: uppercase с path → lowercase + без path', () => {
  assert.equal(slugifyHost('HTTPS://EXAMPLE.COM/PATH'), 'example-com');
  assert.equal(slugifyHost('HTTP://Example.com/feed/rss'), 'example-com');
});

test('slugifyHost: punycode — дефисы схлопываются (известное ограничение)', () => {
  // ВНИМАНИЕ: текущая реализация схлопывает ВСЕ подряд идущие дефисы через /-+/g,
  // поэтому punycode вида xn--80akhbyknj4f теряет один дефис и превращается в
  // xn-80akhbyknj4f. Это сознательное упрощение — для всех известных доменов
  // проекта (the-decoder.com, openai.com и т.п.) результат остаётся читаемым
  // и уникальным. Если в будущем появится IDN-домен с двойными дефисами —
  // нужно будет сохранять их явно (например, через замену только . и _).
  const out = slugifyHost('xn--80akhbyknj4f.com');
  assert.ok(out.length > 0);
  assert.ok(!out.includes('.'));
  // Документируем фактическое поведение
  assert.equal(out, 'xn-80akhbyknj4f-com');
});

test('slugifyHost: глубокий subdomain → вся цепочка через дефисы', () => {
  assert.equal(slugifyHost('a.b.c.d.example.com'), 'a-b-c-d-example-com');
});

test('slugifyHost: trailing дефис после обрезки не остаётся', () => {
  // Подбираем строку, которая после замены точки на дефис и обрезки
  // до 60 символов заканчивается дефисом, — функция должна его снять.
  const longHost = 'a'.repeat(58) + '.com'; // 58 + 4 = 62, после замены: a..a-com → после slice(60) → a..a-c
  const out = slugifyHost(longHost);
  assert.ok(out.length <= 60, `длина ${out.length}`);
  assert.ok(!out.endsWith('-'), `trailing дефис: ${out}`);
});

// ===================== buildPostFilename: edge =====================

test('buildPostFilename: meta без url → unknown в имени', () => {
  const fname = buildPostFilename({
    title: 'Some news',
    published_at: '2026-08-22T00:00:00Z',
  });
  assert.match(fname, /^2026-08-22-news-unknown-some-news-social-content\.json$/);
});

test('buildPostFilename: meta без title → slug=untitled', () => {
  const fname = buildPostFilename({
    url: 'https://example.com/post',
    published_at: '2026-08-22T00:00:00Z',
  });
  assert.match(fname, /^2026-08-22-news-example-com-untitled-social-content\.json$/);
});

test('buildPostFilename: кириллический title → корректный транслит в slug', () => {
  const fname = buildPostFilename({
    title: 'Привет мир',
    url: 'https://example.com/post',
    published_at: '2026-08-22T00:00:00Z',
  });
  assert.equal(fname, '2026-08-22-news-example-com-privet-mir-social-content.json');
});

test('buildPostFilename: meta=null → не падает, формат валиден', () => {
  const fname = buildPostFilename(null);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(fname, new RegExp(`^${today}-news-unknown-untitled-social-content\\.json$`));
});

test('buildPostFilename: невалидная published_at → fallback на сегодня', () => {
  const fname = buildPostFilename({
    title: 'Foo',
    url: 'https://example.com/p',
    published_at: 'not-a-date',
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.match(fname, new RegExp(`^${today}-news-example-com-foo-social-content\\.json$`));
});

test('buildPostFilename: кастомный suffix применяется', () => {
  const fname = buildPostFilename(
    {
      title: 'X',
      url: 'https://example.com/p',
      published_at: '2026-08-22T00:00:00Z',
    },
    'draft',
  );
  assert.equal(fname, '2026-08-22-news-example-com-x-draft.json');
});
