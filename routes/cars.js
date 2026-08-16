const express = require('express');
const supabase = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notifyAllSubscribers } = require('./push');

const router = express.Router();

function toPublic(row) {
  // Backward compatible: cars saved before the gallery/variants update only
  // have `image` (single string). Fall back to that if `images` is empty.
  const images = Array.isArray(row.images) && row.images.length
    ? row.images
    : (row.image ? [row.image] : []);
  return {
    id: row.id,
    image: images[0] || undefined, // kept for any old code paths that still read car.image
    images,
    make: row.make,
    model: row.model,
    price: row.price,
    variants: Array.isArray(row.variants) ? row.variants : [],
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
  if (b.variants !== undefined) {
    if (!Array.isArray(b.variants)) return 'Variants must be a list.';
    for (const v of b.variants) {
      if (!v || typeof v.name !== 'string' || !v.name.trim() || isNaN(Number(v.price))) {
        return 'Each variant needs a name and a valid price.';
      }
    }
  }
  return null;
}

// If variants are provided, the car's headline "price" is always the cheapest
// variant — so budget filters, sorting, and the quiz keep working unchanged.
function deriveBasePrice(b) {
  if (Array.isArray(b.variants) && b.variants.length) {
    const prices = b.variants.map(v => Number(v.price)).filter(n => !isNaN(n));
    if (prices.length) return Math.min(...prices);
  }
  return Number(b.price);
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
    image: (Array.isArray(b.images) && b.images[0]) || b.image || null,
    images: Array.isArray(b.images) ? b.images : [],
    variants: Array.isArray(b.variants) ? b.variants : [],
    make: b.make, model: b.model, price: deriveBasePrice(b), fuel: b.fuel,
    trans: b.trans, body: b.body, seats: Number(b.seats), mileage: Number(b.mileage),
    unit: b.unit, pros: b.pros || [], cons: b.cons || [],
  }).select().single();

  if (error) return res.status(500).json({ error: 'Could not create car.' });

  // Fire-and-forget: don't make the admin wait on push delivery to get their response.
  notifyAllSubscribers({
    title: 'New car added on VINDEX',
    body: `${data.make} ${data.model} — ₹${data.price}L. Check it out!`,
    url: '/'
  }).catch(err => console.error('Push notify failed:', err));

  res.status(201).json({ car: toPublic(data) });
});

// PUT /api/cars/:id — admin only, edit an existing car
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  const { data, error } = await supabase.from('cars').update({
    image: (Array.isArray(b.images) && b.images[0]) || b.image || null,
    images: Array.isArray(b.images) ? b.images : [],
    variants: Array.isArray(b.variants) ? b.variants : [],
    make: b.make, model: b.model, price: deriveBasePrice(b), fuel: b.fuel,
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
