// Add to your backend (same style as your /api/dealers route).
// Requires: npm install rss-parser
//
// GET /api/news?q=<search terms>&limit=<n>
// -> { items: [{ title, url, source, publishedAt }, ...] }
//
// Uses Google News' public RSS search (no API key). Cache it in memory for
// ~15 min per query so repeat visits/cars don't refetch every time and you
// don't hammer Google News.

const Parser = require('rss-parser');
const parser = new Parser();

const newsCache = new Map(); // q -> { ts, items }
const NEWS_CACHE_MS = 15 * 60 * 1000;

app.get('/api/news', async (req, res) => {
  const q = String(req.query.q || 'automotive industry India').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 6, 20);
  const cacheKey = q.toLowerCase();

  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEWS_CACHE_MS) {
    return res.json({ items: cached.items.slice(0, limit) });
  }

  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const feed = await parser.parseURL(rssUrl);

    const items = (feed.items || []).map(it => ({
      title: it.title,
      url: it.link,
      // Google News titles are usually "Headline - Source"; split it out.
      source: (it.title || '').includes(' - ')
        ? it.title.split(' - ').pop()
        : (it.creator || 'Google News'),
      publishedAt: it.isoDate || it.pubDate || null,
    }));

    newsCache.set(cacheKey, { ts: Date.now(), items });
    res.json({ items: items.slice(0, limit) });
  } catch (err) {
    console.error('[news] fetch failed:', err.message);
    res.status(502).json({ items: [], error: 'news fetch failed' });
  }
});
