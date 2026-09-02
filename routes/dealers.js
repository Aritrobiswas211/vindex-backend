// routes/dealers.js
// Proxies "nearby car dealer" lookups to OpenStreetMap's Overpass API.
//
// Why this exists: calling Overpass directly from the browser fails with a
// CORS error ("No 'Access-Control-Allow-Origin' header is present") because
// public Overpass mirrors don't reliably send CORS headers to client JS.
// Server-to-server requests aren't subject to CORS at all, so routing the
// call through our own backend fixes it — the frontend just calls
// GET /api/dealers?lat=..&lng=..&make=.. and gets back the same
// { elements: [...] } shape Overpass returns, unmodified.

const express = require('express');
const router = express.Router();

// Same mirror list as before, now tried server-side.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function queryOverpass(query) {
  const body = 'data=' + encodeURIComponent(query);
  let lastErr = null;
  for (const base of OVERPASS_MIRRORS) {
    try {
      const res = await fetchWithTimeout(
        base,
        {
          method: 'POST', // POST avoids URL-length limits some mirrors 406 on with long GET queries
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            // Identifying UA is good etiquette for OSM infra and avoids some
            // mirrors silently rejecting anonymous/browser-like requests.
            'User-Agent': 'VINDEX-CarAdvisor/1.0 (nearby-dealers lookup)'
          },
          body
        },
        15000
      );
      if (!res.ok) throw new Error(`overpass ${base} responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err; // try next mirror
    }
  }
  throw lastErr || new Error('all overpass mirrors failed');
}

router.get('/dealers', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng query params are required' });
  }

  // Covers both car dealerships and the repair/service shops Google Maps
  // also surfaces for a car search — widens results in areas where OSM's
  // Indian POI tagging skews toward one over the other.
  const query = `[out:json][timeout:20];(
    node["shop"="car"](around:30000,${lat},${lng});
    way["shop"="car"](around:30000,${lat},${lng});
    node["shop"="car_repair"](around:30000,${lat},${lng});
    way["shop"="car_repair"](around:30000,${lat},${lng});
  );out center 40;`;

  try {
    const data = await queryOverpass(query);
    res.json(data);
  } catch (err) {
    console.error('[dealers] overpass lookup failed:', err.message);
    res.status(502).json({ error: 'Could not reach OpenStreetMap Overpass API', elements: [] });
  }
});

module.exports = router;
