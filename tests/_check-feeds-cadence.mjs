import { writeFileSync } from 'node:fs';

const SOURCES = [
  { name: 'techcrunch_ai',      url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'ai_news',           url: 'https://www.artificialintelligence-news.com/feed' },
  { name: 'deepmind',          url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'venturebeat_orch',  url: 'https://venturebeat.com/category/orchestration/feed/' },
  { name: 'openai_news',       url: 'https://openai.com/news/rss.xml' },
  { name: 'habr_ai',           url: 'https://habr.com/ru/rss/hubs/artificial_intelligence/articles/all/' },
  { name: 'ieee_ai',           url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss' },
];

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-cast-ai/1.0)' },
      signal: ctl.signal, redirect: 'follow',
    });
    const text = await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, text };
  } catch (e) { clearTimeout(t); return { ok: false, error: e.message }; }
}

function parseDates(xml) {
  const pubs = [
    ...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g),
    ...xml.matchAll(/<published>([^<]+)<\/published>/g),
  ].map((m) => new Date(m[1]).getTime()).filter((n) => !isNaN(n));
  return pubs.sort((a, b) => b - a);
}

function cadence(pubs) {
  const now = Date.now();
  const last7 = pubs.filter((t) => now - t <= 7 * 86400_000).length;
  const last30 = pubs.filter((t) => now - t <= 30 * 86400_000).length;
  const total = pubs.length;
  const perDay = last30 > 0 ? (last30 / 30) : 0;
  // Если в RSS <=20 items, берём весь массив; если больше — расширим окно до 90 дней,
  // чтобы видеть «реальную» плотность без обрезки.
  const last90 = pubs.filter((t) => now - t <= 90 * 86400_000).length;
  return { total, last7, last30, last90, perDay_30: perDay };
}

const out = {};
for (const s of SOURCES) {
  const r = await get(s.url);
  if (!r.ok) { out[s.name] = { url: s.url, ok: false, status: r.status, error: r.error }; continue; }
  const pubs = parseDates(r.text);
  out[s.name] = { url: s.url, ok: true, status: r.status, ...cadence(pubs) };
}
writeFileSync('tests/_feeds-cadence.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
