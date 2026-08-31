const express = require('express');
const supabase = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// The site's built-in default (dark) palette. Anything a client doesn't send,
// or a key that isn't recognized, falls back to these — so a partial update,
// or a fresh install with no saved theme yet, never breaks the page.
const THEME_DEFAULTS = {
  bg: '#151a1f',
  bg2: '#101418',
  panel: '#1c232a',
  panel2: '#242d35',
  border: '#dfe6eb',
  text: '#e4e8eb',
  muted: '#8d99a3',
  amber: '#d6a45e',
  amberDim: '#7a6038',
  amberHover: '#e6bb7c',
  teal: '#5fada0',
  red: '#c96a5e',
  headerBg: '#101418',
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// GET /api/settings/theme — public, every page load needs this
router.get('/theme', async (req, res) => {
  const { data, error } = await supabase.from('site_settings').select('value').eq('key', 'theme').maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not load theme.' });
  const saved = (data && data.value && typeof data.value === 'object') ? data.value : {};
  res.json({ theme: { ...THEME_DEFAULTS, ...saved } });
});

// PUT /api/settings/theme — admin only. Body: { bg, bg2, panel, panel2, border, text, muted, amber, amberDim, amberHover, teal, red, headerBg }
router.put('/theme', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const theme = {};
  for (const key of Object.keys(THEME_DEFAULTS)) {
    const val = b[key];
    theme[key] = (typeof val === 'string' && HEX_RE.test(val)) ? val : THEME_DEFAULTS[key];
  }

  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: 'theme', value: theme }, { onConflict: 'key' });

  if (error) return res.status(500).json({ error: 'Could not save theme.' });
  res.json({ theme });
});

// POST /api/settings/theme/reset — admin only, restore the built-in default palette
router.post('/theme/reset', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: 'theme', value: THEME_DEFAULTS }, { onConflict: 'key' });

  if (error) return res.status(500).json({ error: 'Could not reset theme.' });
  res.json({ theme: THEME_DEFAULTS });
});

module.exports = router;
