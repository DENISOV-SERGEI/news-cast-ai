import { writeFileSync } from 'node:fs';
import * as cheerio from 'cheerio';

const FEEDS = [
  'https://venturebeat.com/category/orchestration',
  'https://habr.com/ru/hubs/artificial_intelligence/articles/',
  'https://openai.com/ru-RU/news/',
  'https://www.marktechpost.com/',
  'https://spectrum.ieee.org/topic/artificial-intelligence/',
];

async function tryUrl(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    const ct = res.headers.get('content-type') || '';
    const text = res.headers.get('content-type')?.includes('xml') || url.endsWith('.xml') || url.endsWith('/rss') || url.includes('/feed')
      ? await res.text()
      : await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, ct, text, finalUrl: res.url || url };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message };
  }
}

const out = [];
for (const url of FEEDS) {
  const r = await tryUrl(url);
  if (!r.ok) { out.push({ url, ok: false, error: r.error || `HTTP ${r.status}` }); continue; }
  const isXml = /xml|rss|atom/i.test(r.ct) || /<rss|<feed|<channel/i.test(r.text.slice(0, 500));
  out.push({ url, ok: true, status: r.status, ct: r.ct, finalUrl: r.finalUrl, isXml, len: r.text.length });
}
writeFileSync('tests/_feeds-probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
