const express = require('express');
const crypto = require('crypto');
const supabase = require('../db');
const { sendMail } = require('../mailer');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const PHONE_RE = /^[0-9+\-\s()]{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STATUSES = ['new', 'contacted', 'closed'];
const BASE = process.env.BACKEND_URL || 'https://vindex-backend-1.onrender.com';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Signed token so nobody can confirm/cancel someone else's booking by guessing ids.
function sign(id, action) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(`${id}:${action}`).digest('hex').slice(0, 32);
}
function validToken(id, action, token) {
  const a = Buffer.from(sign(id, action));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendConfirmationEmail(lead) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set — cannot sign confirmation links.');
  const link = (a) => `${BASE}/api/leads/confirm/${lead.id}/${a}?t=${sign(lead.id, a)}`;
  const when = lead.preferred_date ? esc(lead.preferred_date) : 'a date we will arrange with you';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto">
      <h2>Confirm your test drive</h2>
      <p>Hi ${esc(lead.name)},</p>
      <p>We received your request to test drive the <b>${esc(lead.car_make)} ${esc(lead.car_model)}</b> on <b>${when}</b>.</p>
      <p>Please confirm below:</p>
      <p>
        <a href="${link('confirm')}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Confirm</a>
        &nbsp;
        <a href="${link('cancel')}" style="background:#dc2626;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Cancel</a>
      </p>
      <p style="color:#666;font-size:12px">— VINDEX Cars</p>
    </div>`;
  await sendMail({ to: lead.email, toName: lead.name, subject: 'Confirm your VINDEX test drive', html });
}

// POST /api/leads — public. Body: { carId, make, model, name, phone, email?, preferredDate? }
router.post('/', async (req, res) => {
  const { carId, make, model, name, phone, email, preferredDate } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'Please enter your name.' });
  if (!phone || !PHONE_RE.test(String(phone).trim())) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  if (!make || !model) return res.status(400).json({ error: 'Missing car details.' });
  const cleanEmail = email ? String(email).trim() : '';
  if (cleanEmail && !EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const { data: lead, error } = await supabase.from('test_drive_leads').insert({
    car_id: Number.isFinite(Number(carId)) ? Number(carId) : null,
    car_make: make,
    car_model: model,
    name: name.trim(),
    phone: String(phone).trim(),
    email: cleanEmail || null,
    preferred_date: preferredDate || null,
  }).select().single();

  if (error) return res.status(500).json({ error: 'Could not submit your request. Please try again.' });

  // Fire-and-forget: a mail failure must never fail the booking itself.
  if (lead.email) {
    sendConfirmationEmail(lead).catch(err => console.error('Confirmation email failed:', err.message));
  }

  res.status(201).json({ ok: true, emailSent: !!lead.email });
});

// GET /api/leads/confirm/:id/:action?t=<token> — opened from the email link
router.get('/confirm/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const page = (msg) => res.type('html').send(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
     <body style="font-family:Arial,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
     <div><h2>${msg}</h2><p style="color:#999">VINDEX Cars</p></div></body>`);

  if (!/^\d+$/.test(id) || !['confirm', 'cancel'].includes(action) || !validToken(id, action, req.query.t)) {
    return res.status(400).type('html').send('<h3 style="font-family:Arial">Invalid or expired link.</h3>');
  }

  const confirmation = action === 'confirm' ? 'confirmed' : 'cancelled';
  const { data, error } = await supabase
    .from('test_drive_leads')
    .update({ confirmation })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error || !data) return res.status(404).type('html').send('<h3 style="font-family:Arial">Booking not found.</h3>');
  page(confirmation === 'confirmed' ? 'Test drive confirmed ✅<br><small>We will see you soon!</small>' : 'Test drive cancelled ❌');
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
