const express = require('express');
const router = express.Router();

// YouTube Data API v3 free quota (10,000 units/day, ~100 searches/day since
// each search costs 100 units) — get a key at console.cloud.google.com,
// enable "YouTube Data API v3", no billing/card required for this quota.
// Without a key set, /media/videos just returns an empty list and the
// frontend's existing "Search on YouTube" fallback link handles the rest.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Simple in-memory caches (per query) so repeated visits to the same car,
// or the homepage's periodic refresh, don't burn YouTube's search quota or
// hammer Google News unnecessarily. Fine for a single-instance Render
// deploy; resets on redeploy, which is harmless here.
const newsCache = new Map();
const videoCache = new Map();
const NEWS_TTL_MS = 15 * 60 * 1000;      // 15 minutes
const VIDEO_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — search results barely change that fast

function getCached(cache, key, ttl) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  return null;
}
function setCached(cache, key, data) {
  cache.set(key, { data, at: Date.now() });
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Google News RSS has no JSON API, so we parse the handful of tags we need
// out of the XML with regex rather than adding an XML-parsing dependency —
// its structure is simple and consistent enough for this to be reliable.
function parseGoogleNewsRss(xml) {
  const items = xml.split('<item>').slice(1); // first chunk is header, not an item
  return items.map(chunk => {
    const titleMatch = chunk.match(/<title>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))<\/title>/s);
    const linkMatch = chunk.match(/<link>(.*?)<\/link>/s);
    const pubDateMatch = chunk.match(/<pubDate>(.*?)<\/pubDate>/s);
    const sourceMatch = chunk.match(/<source[^>]*>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))<\/source>/s);
    const title = decodeEntities((titleMatch && (titleMatch[1] || titleMatch[2])) || '').trim();
    const link = (linkMatch && linkMatch[1] || '').trim();
    const pubDate = (pubDateMatch && pubDateMatch[1] || '').trim();
    const source = decodeEntities((sourceMatch && (sourceMatch[1] || sourceMatch[2])) || '').trim();
    return { title, link, pubDate, source };
  }).filter(a => a.title && a.link);
}

// GET /api/media/news?query=...
router.get('/news', async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing query.' });

  const cacheKey = query.toLowerCase();
  const cached = getCached(newsCache, cacheKey, NEWS_TTL_MS);
  if (cached) return res.json({ articles: cached });

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'VINDEX-CarAdvisor/1.0' } });
    if (!resp.ok) throw new Error(`Google News RSS responded ${resp.status}`);
    const xml = await resp.text();
    const articles = parseGoogleNewsRss(xml).slice(0, 8);
    setCached(newsCache, cacheKey, articles);
    res.json({ articles });
  } catch (err) {
    console.error('[media/news] failed:', err.message);
    res.status(502).json({ error: 'Could not load news right now.' });
  }
});

// GET /api/media/videos?make=...&model=...
router.get('/videos', async (req, res) => {
  const make = String(req.query.make || '').trim();
  const model = String(req.query.model || '').trim();
  if (!make || !model) return res.status(400).json({ error: 'Missing make/model.' });

  if (!YOUTUBE_API_KEY) {
    return res.json({ videos: [] }); // not configured — frontend falls back to a search link
  }

  const query = `${make} ${model} review`;
  const cacheKey = query.toLowerCase();
  const cached = getCached(videoCache, cacheKey, VIDEO_TTL_MS);
  if (cached) return res.json({ videos: cached });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[media/videos] YouTube API error:', resp.status, errText);
      return res.json({ videos: [] }); // fail soft — frontend already handles empty gracefully
    }
    const data = await resp.json();
    const videos = (data.items || []).map(item => ({
      videoId: item.id?.videoId,
      title: decodeEntities(item.snippet?.title),
      channelTitle: decodeEntities(item.snippet?.channelTitle),
      thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
    })).filter(v => v.videoId && v.thumbnail);
    setCached(videoCache, cacheKey, videos);
    res.json({ videos });
  } catch (err) {
    console.error('[media/videos] failed:', err.message);
    res.json({ videos: [] });
  }
});

module.exports = router;
