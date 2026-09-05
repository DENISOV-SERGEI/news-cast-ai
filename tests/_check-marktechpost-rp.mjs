import Parser from 'rss-parser';
const parser = new Parser({ timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
const feed = await parser.parseURL('https://www.marktechpost.com/feed/');
const pubs = feed.items.map((i) => i.isoDate || i.pubDate).filter(Boolean).map((d) => new Date(d).getTime()).filter((n) => !isNaN(n));
pubs.sort((a, b) => b - a);
const now = Date.now();
console.log(JSON.stringify({
  title: feed.title,
  total: pubs.length,
  latest: pubs.length ? new Date(pubs[0]).toISOString() : null,
  last7: pubs.filter((x) => now - x <= 7 * 86400_000).length,
  last30: pubs.filter((x) => now - x <= 30 * 86400_000).length,
  last90: pubs.filter((x) => now - x <= 90 * 86400_000).length,
  perDay_30: (pubs.filter((x) => now - x <= 30 * 86400_000).length / 30).toFixed(2),
}, null, 2));
