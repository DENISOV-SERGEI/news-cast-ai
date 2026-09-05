const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const paths = [
  'https://www.marktechpost.com/feed/',
  'https://www.marktechpost.com/feed',
  'https://www.marktechpost.com/feed/rss/',
  'https://www.marktechpost.com/feed/atom/',
  'https://www.marktechpost.com/?feed=rss2',
  'https://www.marktechpost.com/?feed=atom',
  'https://www.marktechpost.com/category/artificial-intelligence/feed/',
  'https://marktechpost.com/feed/',
];
const out = [];
for (const u of paths) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' }, redirect: 'follow' });
    const t = await r.text();
    const isFeed = /<rss|<feed|<item\b|<entry\b/i.test(t.slice(0, 1500));
    out.push({ url: u, status: r.status, ct: r.headers.get('content-type'), len: t.length, isFeed });
  } catch (e) { out.push({ url: u, error: e.message }); }
}
console.log(JSON.stringify(out, null, 2));
