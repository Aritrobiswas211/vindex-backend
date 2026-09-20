// routes/test-drive.js
// Public endpoint — a visitor doesn't need an account to request a test
// drive. If they happen to be signed in, the JWT is used (when present) to
// link the request to their account; a missing/invalid token just means it
// gets saved as a guest request instead of rejected.

const express = require('express');
const jwt = require('jsonwebtoken');
const supabase = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

function getOptionalUserId(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    return payload.userId || null;
  } catch (err) {
    return null; // expired/invalid token — book as guest rather than failing
  }
}

function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

// POST /api/test-drive — body: { carId, name, phone, email?, preferredDate?, city?, notes? }
router.post('/test-drive', async (req, res) => {
  const { carId, name, phone, email, preferredDate, city, notes } = req.body || {};
  const carIdNum = Number(carId);

  if (!carIdNum) return res.status(400).json({ error: 'carId is required.' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter a valid phone number.' });

  // Confirm the car actually exists so bad/stale ids don't silently insert junk rows.
  const { data: car, error: carErr } = await supabase
    .from('car_listings')
    .select('id, make, model')
    .eq('id', carIdNum)
    .maybeSingle();
  if (carErr) return res.status(500).json({ error: 'Could not verify this car right now.' });
  if (!car) return res.status(404).json({ error: 'Car not found.' });

  const userId = getOptionalUserId(req);

  const { error } = await supabase.from('test_drive_requests').insert({
    car_id: carIdNum,
    user_id: userId,
    name: String(name).trim().slice(0, 120),
    phone: String(phone).trim().slice(0, 20),
    email: email ? String(email).trim().slice(0, 200) : null,
    preferred_date: preferredDate || null,
    city: city ? String(city).trim().slice(0, 120) : null,
    notes: notes ? String(notes).trim().slice(0, 500) : null,
  });

  if (error) {
    console.error('[test-drive] insert failed:', error.message);
    return res.status(500).json({ error: 'Could not submit your test drive request. Please try again.' });
  }

  res.status(201).json({ ok: true, car: { make: car.make, model: car.model } });
});

module.exports = router;
