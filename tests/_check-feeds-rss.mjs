import { writeFileSync } from 'node:fs';

const ALTS = {
  venturebeat: [
    'https://venturebeat.com/category/orchestration/feed/',
    'https://venturebeat.com/feed/',
    'https://venturebeat.com/category/ai/feed/',
    'https://venturebeat.com/?feed=rss2',
  ],
  openai: [
    'https://openai.com/news/rss.xml',
    'https://openai.com/blog/rss.xml',
    'https://openai.com/news/index.xml',
    'https://openai.com/index.xml',
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
    const head = r.text.slice(0, 1500);
    const isFeed = /<rss|<feed|<channel|<item\b/i.test(head);
    let items = 0, latest = null;
    if (isFeed) {
      const itemsMatches = r.text.match(/<item[\s>]/g);
      items = itemsMatches ? itemsMatches.length : 0;
      const pubDates = [...r.text.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => new Date(m[1]).getTime()).filter((n) => !isNaN(n));
      if (pubDates.length) latest = new Date(Math.max(...pubDates)).toISOString();
    }
    out[k].push({ url: u, ok: true, status: r.status, ct: r.ct, finalUrl: r.finalUrl, isFeed, items, latest });
  }
}
writeFileSync('tests/_feeds-rss-probe.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
