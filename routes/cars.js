const express = require('express');
const supabase = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function toPublic(row) {
  return {
    id: row.id,
    image: row.image || undefined,
    make: row.make,
    model: row.model,
    price: row.price,
    fuel: Array.isArray(row.fuel) ? row.fuel : [],
    trans: row.trans,
    body: row.body,
    seats: row.seats,
    mileage: row.mileage,
    unit: row.unit,
    pros: Array.isArray(row.pros) ? row.pros : [],
    cons: Array.isArray(row.cons) ? row.cons : [],
  };
}

function validateBody(b) {
  const required = ['make', 'model', 'price', 'trans', 'body', 'seats', 'mileage', 'unit'];
  for (const key of required) {
    if (b[key] === undefined || b[key] === null || b[key] === '') {
      return `Missing field: ${key}`;
    }
  }
  if (!Array.isArray(b.fuel) || b.fuel.length === 0) {
    return 'At least one fuel type is required.';
  }
  return null;
}

// GET /api/cars — public, anyone can browse the catalogue
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('cars').select('*').order('id');
  if (error) return res.status(500).json({ error: 'Could not load cars.' });
  res.json({ cars: data.map(toPublic) });
});

// POST /api/cars — admin only, create a new car
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  const { data, error } = await supabase.from('cars').insert({
    image: b.image || null,
    make: b.make, model: b.model, price: Number(b.price), fuel: b.fuel,
    trans: b.trans, body: b.body, seats: Number(b.seats), mileage: Number(b.mileage),
    unit: b.unit, pros: b.pros || [], cons: b.cons || [],
  }).select().single();

  if (error) return res.status(500).json({ error: 'Could not create car.' });
  res.status(201).json({ car: toPublic(data) });
});

// PUT /api/cars/:id — admin only, edit an existing car
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  const { data, error } = await supabase.from('cars').update({
    image: b.image || null,
    make: b.make, model: b.model, price: Number(b.price), fuel: b.fuel,
    trans: b.trans, body: b.body, seats: Number(b.seats), mileage: Number(b.mileage),
    unit: b.unit, pros: b.pros || [], cons: b.cons || [],
  }).eq('id', req.params.id).select().maybeSingle();

  if (error) return res.status(500).json({ error: 'Could not update car.' });
  if (!data) return res.status(404).json({ error: 'Car not found.' });
  res.json({ car: toPublic(data) });
});

// DELETE /api/cars/:id — admin only
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  await supabase.from('cars').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
