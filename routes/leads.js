const express = require('express');
const supabase = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PHONE_RE = /^[0-9+\-\s()]{7,15}$/;
const VALID_STATUSES = ['new', 'contacted', 'closed'];

// POST /api/leads — public. Body: { carId, make, model, name, phone, preferredDate? }
router.post('/', async (req, res) => {
  const { carId, make, model, name, phone, preferredDate } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!phone || !PHONE_RE.test(String(phone).trim())) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (!make || !model) return res.status(400).json({ error: 'Missing car details.' });

  const { error } = await supabase.from('test_drive_leads').insert({
    car_id: Number.isFinite(Number(carId)) ? Number(carId) : null,
    car_make: make,
    car_model: model,
    name: name.trim(),
    phone: String(phone).trim(),
    preferred_date: preferredDate || null,
  });

  if (error) return res.status(500).json({ error: 'Could not submit your request. Please try again.' });
  res.status(201).json({ ok: true });
});

// Admin-only endpoints below, kept in this same file (rather than editing
// admin.js) so this feature doesn't risk clobbering anything already there.

// GET /api/leads/admin — list all leads, newest first
router.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('test_drive_leads')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Could not load leads.' });
  res.json({ leads: data });
});

// PATCH /api/leads/admin/:id — update status. Body: { status }
router.patch('/admin/:id', requireAuth, requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const { data, error } = await supabase
    .from('test_drive_leads')
    .update({ status })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Could not update lead.' });
  if (!data) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ lead: data });
});

// DELETE /api/leads/admin/:id
router.delete('/admin/:id', requireAuth, requireAdmin, async (req, res) => {
  await supabase.from('test_drive_leads').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
