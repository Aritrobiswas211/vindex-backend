const express = require('express');
const supabase = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { notifyAllSubscribers } = require('./push');

const router = express.Router();

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Same public shape the frontend has always received — nothing downstream
// needs to change. Source is now the car_listings view instead of the old
// flat `cars` table.
function toPublic(row) {
  const images = Array.isArray(row.images) && row.images.length ? row.images : [];
  return {
    id: row.id,
    image: images[0] || undefined,
    images,
    make: row.make,
    model: row.model,
    price: row.price,
    variants: Array.isArray(row.variants) ? row.variants : [],
    fuel: Array.isArray(row.fuel) ? row.fuel : [],
    trans: row.trans,
    body: row.body,
    seats: row.seats,
    mileage: (row.mileage && typeof row.mileage === 'object' && !Array.isArray(row.mileage)) ? row.mileage : {},
    pros: Array.isArray(row.pros) ? row.pros : [],
    cons: Array.isArray(row.cons) ? row.cons : [],
  };
}

function validateMileage(mileage, fuels) {
  if (!mileage || typeof mileage !== 'object' || Array.isArray(mileage)) {
    return 'Mileage is required for each fuel type.';
  }
  const missing = fuels.filter(f => {
    const entry = mileage[f];
    return !entry || isNaN(Number(entry.value)) || !entry.unit || !String(entry.unit).trim();
  });
  if (missing.length) return `Missing mileage/unit for: ${missing.join(', ')}`;
  return null;
}

function sanitizeMileage(mileage, fuels) {
  const clean = {};
  fuels.forEach(f => {
    const entry = mileage[f];
    if (entry && !isNaN(Number(entry.value)) && entry.unit) {
      clean[f] = { value: Number(entry.value), unit: String(entry.unit).trim() };
    }
  });
  return clean;
}

function validateBody(b) {
  const required = ['make', 'model', 'price', 'trans', 'body', 'seats'];
  for (const key of required) {
    if (b[key] === undefined || b[key] === null || b[key] === '') return `Missing field: ${key}`;
  }
  if (!Array.isArray(b.fuel) || b.fuel.length === 0) return 'At least one fuel type is required.';
  const mileageErr = validateMileage(b.mileage, b.fuel);
  if (mileageErr) return mileageErr;
  if (b.variants !== undefined) {
    if (!Array.isArray(b.variants)) return 'Variants must be a list.';
    for (const v of b.variants) {
      if (!v || typeof v.name !== 'string' || !v.name.trim() || isNaN(Number(v.price))) {
        return 'Each variant needs a name and a valid price.';
      }
      if (v.features !== undefined && !Array.isArray(v.features)) return 'Variant features must be a list.';
    }
  }
  return null;
}

function deriveBasePrice(b) {
  if (Array.isArray(b.variants) && b.variants.length) {
    const prices = b.variants.map(v => Number(v.price)).filter(n => !isNaN(n));
    if (prices.length) return Math.min(...prices);
  }
  return Number(b.price);
}

async function getOrCreateBrand(name) {
  const cleanName = name.trim();
  const { data: existing } = await supabase.from('brands').select('id').eq('name', cleanName).maybeSingle();
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('brands')
    .insert({ name: cleanName, slug: slugify(cleanName) })
    .select('id')
    .single();
  if (error) throw new Error(`Could not create brand: ${error.message}`);
  return data.id;
}

// Builds the trim rows for a car from its submitted body — either one row
// per variant, or a single "Base" trim if no variants were given.
function buildTrimRows(generationId, b) {
  const images = Array.isArray(b.images) ? b.images : (b.image ? [b.image] : []);
  const trans = Array.isArray(b.trans) ? b.trans : (b.trans ? [b.trans] : []);
  const mileage = sanitizeMileage(b.mileage, b.fuel);
  const variants = Array.isArray(b.variants) && b.variants.length ? b.variants : null;

  if (variants) {
    return variants.map(v => ({
      generation_id: generationId,
      name: v.name.trim(),
      price: Number(v.price),
      fuel: b.fuel,
      trans,
      mileage,
      pros: b.pros || [],
      cons: b.cons || [],
      features: Array.isArray(v.features) ? v.features : [],
      images,
    }));
  }
  return [{
    generation_id: generationId,
    name: 'Base',
    price: Number(b.price),
    fuel: b.fuel,
    trans,
    mileage,
    pros: b.pros || [],
    cons: b.cons || [],
    features: [],
    images,
  }];
}

// GET /api/cars — public, reads the normalized tables via car_listings
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('car_listings').select('*').order('id');
  if (error) return res.status(500).json({ error: 'Could not load cars.' });
  res.json({ cars: data.map(toPublic) });
});

// POST /api/cars — admin only, create a new car across brands/models/generations/trims
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  try {
    const brandId = await getOrCreateBrand(b.make);

    const { data: model, error: modelErr } = await supabase
      .from('models')
      .insert({ brand_id: brandId, name: b.model.trim(), slug: slugify(b.model), body: b.body })
      .select('id')
      .single();
    if (modelErr) throw new Error(modelErr.message);

    const { data: generation, error: genErr } = await supabase
      .from('generations')
      .insert({ model_id: model.id, name: 'Gen 1', seats: Number(b.seats) })
      .select('id')
      .single();
    if (genErr) throw new Error(genErr.message);

    const trimRows = buildTrimRows(generation.id, b);
    const { error: trimErr } = await supabase.from('trims').insert(trimRows);
    if (trimErr) throw new Error(trimErr.message);

    const { data: listing, error: listingErr } = await supabase
      .from('car_listings')
      .select('*')
      .eq('id', model.id)
      .single();
    if (listingErr) throw new Error(listingErr.message);

    notifyAllSubscribers({
      title: 'New car added on VINDEX',
      body: `${listing.make} ${listing.model} — ₹${listing.price}L. Check it out!`,
      url: '/'
    }).catch(err => console.error('Push notify failed:', err));

    res.status(201).json({ car: toPublic(listing) });
  } catch (err) {
    console.error('Create car failed:', err.message);
    res.status(500).json({ error: 'Could not create car.' });
  }
});

// PUT /api/cars/:id — admin only. :id is models.id. Replaces the model's
// core fields and *all* of its trims (simplest safe approach — avoids
// having to diff old vs new variant lists).
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  const modelId = Number(req.params.id);

  try {
    const { data: generation, error: genLookupErr } = await supabase
      .from('generations')
      .select('id')
      .eq('model_id', modelId)
      .maybeSingle();
    if (genLookupErr) throw new Error(genLookupErr.message);
    if (!generation) return res.status(404).json({ error: 'Car not found.' });

    const brandId = await getOrCreateBrand(b.make);

    const { error: modelUpdateErr } = await supabase
      .from('models')
      .update({ brand_id: brandId, name: b.model.trim(), slug: slugify(b.model), body: b.body })
      .eq('id', modelId);
    if (modelUpdateErr) throw new Error(modelUpdateErr.message);

    const { error: genUpdateErr } = await supabase
      .from('generations')
      .update({ seats: Number(b.seats) })
      .eq('id', generation.id);
    if (genUpdateErr) throw new Error(genUpdateErr.message);

    // Replace all trims for this generation rather than trying to
    // reconcile which variants changed — simpler and safe since trims
    // have no other tables pointing at them.
    const { error: deleteErr } = await supabase.from('trims').delete().eq('generation_id', generation.id);
    if (deleteErr) throw new Error(deleteErr.message);

    const trimRows = buildTrimRows(generation.id, b);
    const { error: insertErr } = await supabase.from('trims').insert(trimRows);
    if (insertErr) throw new Error(insertErr.message);

    const { data: listing, error: listingErr } = await supabase
      .from('car_listings')
      .select('*')
      .eq('id', modelId)
      .single();
    if (listingErr) throw new Error(listingErr.message);

    res.json({ car: toPublic(listing) });
  } catch (err) {
    console.error('Update car failed:', err.message);
    res.status(500).json({ error: 'Could not update car.' });
  }
});

// DELETE /api/cars/:id — admin only. Deleting the model cascades to its
// generation and trims automatically (ON DELETE CASCADE in the schema).
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  await supabase.from('models').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
