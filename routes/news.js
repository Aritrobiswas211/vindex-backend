// routes/news.js
// Proxies automotive news lookups to Google News' public RSS search.
//
// Why this exists: Google News RSS doesn't send CORS headers, so calling it
// directly from the browser fails the same way Overpass does in
// routes/dealers.js. Routing it through our own backend (server-to-server,
// no CORS involved) fixes it — the frontend just calls
// GET /api/news?q=..&limit=.. and gets back { items: [...] }.
//
// No API key needed. Results are cached in memory per query for 15 minutes
// so repeat visits/cars don't refetch on every request.

const express = require('express');
const Parser = require('rss-parser');

const router = express.Router();
const parser = new Parser();

const newsCache = new Map(); // query -> { ts, items }
const NEWS_CACHE_MS = 15 * 60 * 1000;

router.get('/news', async (req, res) => {
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
    res.status(502).json({ items: [], error: 'Could not reach the news source right now.' });
  }
});

module.exports = router;
