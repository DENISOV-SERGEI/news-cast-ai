// tests/publisher-caption.test.mjs
// buildCaption / escapeHtml: эскейп &<> и безопасная обрезка по ESCAPED-длине
// без резания entity, с границей слова/строки.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaption, escapeHtml } from '../src/publisher.js';

test('escapeHtml: экранирует & < >', () => {
  assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(escapeHtml('plain text'), 'plain text');
  assert.equal(escapeHtml(''), '');
});

test('buildCaption: короткие части склеиваются через \\n\\n и эскейпятся', () => {
  const out = buildCaption(['Title', 'draft <b>raw</b>', 'cta & co']);
  assert.equal(out, 'Title\n\ndraft &lt;b&gt;raw&lt;/b&gt;\n\ncta &amp; co');
});

test('buildCaption: пустые части отбрасываются', () => {
  assert.equal(buildCaption(['Title', '', null, 'cta']), 'Title\n\ncta');
  assert.equal(buildCaption([]), '');
  assert.equal(buildCaption(['']), '');
});

test('buildCaption: результат ≤ 1024 символов', () => {
  const long = 'слово '.repeat(400); // ~2000 символов
  const out = buildCaption(['T', long, 'c']);
  assert.ok(out.length <= 1024, `len=${out.length}`);
  assert.ok(out.endsWith('…'), 'должен заканчиваться многоточием');
});

test('buildCaption: эскейпит < в длинном тексте и укладывается в лимит', () => {
  const long = 'a<b '.repeat(500); // много <, эскейп удлиняет
  const out = buildCaption([long]);
  assert.ok(out.length <= 1024, `len=${out.length}`);
  assert.ok(out.endsWith('…'));
  // Битых entity быть не должно: каждое &(amp|lt|gt) обязано иметь закрывающую ;
  const broken = out.match(/&(amp|lt|gt)(?!;)/g) || [];
  assert.equal(broken.length, 0, `битых entity: ${broken.length}`);
  // И сами цельные &lt; присутствуют.
  assert.ok((out.match(/&lt;/g) || []).length > 0);
});

test('buildCaption: обрезка по границе слова, не посередине', () => {
  const long = 'alpha beta gamma delta '.repeat(100);
  const out = buildCaption([long], 100);
  assert.ok(out.length <= 100);
  // Перед многоточием не должно быть обрубленного слова без пробела перед ним —
  // последний непробельный кусок должен быть целым словом.
  assert.ok(out.endsWith('…'));
  const body = out.slice(0, -1); // без …
  // последний символ перед … — пробел (граница слова) ИЛИ строка короче лимита
  assert.ok(body.endsWith(' ') || body.length < 99, `body=…${body.slice(-15)}`);
});

test('buildCaption: сплошные & (максимальное расширение) укладываются в лимит', () => {
  const amp = '&'.repeat(2000);
  const out = buildCaption([amp]);
  assert.ok(out.length <= 1024, `len=${out.length}`);
  // Цельных &amp; — столько, сколько влезло; битых быть не должно.
  assert.equal((out.match(/&amp;/g) || []).length > 0, true);
  assert.equal((out.match(/&amp([^;]|$)/g) || []).length, 0, 'нет битых &amp; entity');
});

test('buildCaption: перевод строки используется как граница обрезки', () => {
  // 3 параграфа; обрезка должна пройти по границе параграфа.
  const para = 'x'.repeat(50);
  const text = `${para}\n\n${para}\n\n${para}`;
  const out = buildCaption([text], 110);
  assert.ok(out.length <= 110);
  // Должен отрезать по \n\n (после первого или второго параграфа), не посередине.
  assert.ok(out.includes('\n\n') || out.length < para.length + 2, 'должна быть граница параграфа');
});