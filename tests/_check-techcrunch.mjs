const res = await fetch('https://www.artificialintelligence-news.com/feed', {
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-cast-ai/1.0)' },
});
const t = await res.text();
const pubs = [...t.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => new Date(m[1]).getTime()).filter((n) => !isNaN(n));
const now = Date.now();
pubs.sort((a, b) => b - a);
console.log(JSON.stringify({
  status: res.status,
  ct: res.headers.get('content-type'),
  total: pubs.length,
  latest: pubs.length ? new Date(pubs[0]).toISOString() : null,
  last7: pubs.filter((x) => now - x <= 7 * 86400_000).length,
  last30: pubs.filter((x) => now - x <= 30 * 86400_000).length,
}, null, 2));
