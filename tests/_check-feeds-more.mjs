import { writeFileSync } from 'node:fs';

const ALTS = {
  habr: [
    'https://habr.com/ru/rss/all/hubs/',
    'https://habr.com/ru/rss/hubs/artificial_intelligence/',
    'https://habr.com/ru/rss/all/',
    'https://habr.com/ru/feed/',
  ],
  marktechpost: [
    'https://www.marktechpost.com/feed/',
    'https://www.marktechpost.com/feed',
    'https://www.marktechpost.com/?feed=rss2',
    'https://www.marktechpost.com/rss.xml',
  ],
  ieee: [
    'https://spectrum.ieee.org/topic/artificial-intelligence/rss',
    'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss',
    'https://spectrum.ieee.org/rss/topic/artificial-intelligence/',
    'https://spectrum.ieee.org/topic/artificial-intelligence/feed/',
    'https://spectrum.ieee.org/feed/',
    'https://spectrum.ieee.org/rss/',
  ],
};

async function tryUrl(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-cast-ai/1.0)' },
      signal: ctl.signal, redirect: 'follow',
    });
    const text = await res.text();
    clearTimeout(t);
    return { ok: res.ok, status: res.status, ct: res.headers.get('content-type') || '', text, finalUrl: res.url || url };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.message };
  }
}

const out = {};
for (const [k, urls] of Object.entries(ALTS)) {
  out[k] = [];
  for (const u of urls) {
    const r = await tryUrl(u);
    if (!r.ok) { out[k].push({ url: u, ok: false, status: r.status, error: r.error }); continue; }
    const head = r.text.slice(0, 2000);
    const isFeed = /<rss|<feed|<channel|<item\b|<entry\b/i.test(head);
    let items = 0, latest = null;
    if (isFeed) {
      const m1 = r.text.match(/<item[\s>]/g); const m2 = r.text.match(/<entry[\s>]/g);
      items = (m1 ? m1.length : 0) + (m2 ? m2.length : 0);
      const pubs = [
        ...r.text.matchAll(/<pubDate>([^<]+)<\/pubDate>/g),
        ...r.text.matchAll(/<published>([^<]+)<\/published>/g),
        ...r.text.matchAll(/<updated>([^<]+)<\/updated>/g),
      ].map((m) => new Date(m[1]).getTime()).filter((n) => !isNaN(n));
      if (pubs.length) latest = new Date(Math.max(...pubs)).toISOString();
    }
    out[k].push({ url: u, ok: true, status: r.status, ct: r.ct, finalUrl: r.finalUrl, isFeed, items, latest });
  }
}
writeFileSync('tests/_feeds-rss-probe2.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
