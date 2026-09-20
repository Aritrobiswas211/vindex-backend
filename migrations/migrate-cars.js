// One-time migration: copies every row from the old flat `cars` table into
// the new brands -> models -> generations -> trims structure.
//
// Safe to re-run by accident: it refuses to proceed if `trims` already has
// rows, so you can't accidentally duplicate data by running it twice.
//
// Usage: node migrations/migrate-cars.js
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in your .env (same ones
// your backend already uses).

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function getOrCreateBrand(cache, name) {
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const { data: existing } = await supabase.from('brands').select('id').eq('name', name.trim()).maybeSingle();
  if (existing) { cache.set(key, existing.id); return existing.id; }

  const { data, error } = await supabase
    .from('brands')
    .insert({ name: name.trim(), slug: slugify(name) })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  cache.set(key, data.id);
  return data.id;
}

async function createModel(brandId, name, body) {
  const { data, error } = await supabase
    .from('models')
    .insert({ brand_id: brandId, name: name.trim(), slug: slugify(name), body })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create model "${name}": ${error.message}`);
  return data.id;
}

async function createGeneration(modelId, seats) {
  const { data, error } = await supabase
    .from('generations')
    .insert({ model_id: modelId, name: 'Gen 1', seats })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create generation: ${error.message}`);
  return data.id;
}

async function createTrims(generationId, car) {
  const images = Array.isArray(car.images) && car.images.length
    ? car.images
    : (car.image ? [car.image] : []);

  const variants = Array.isArray(car.variants) && car.variants.length ? car.variants : null;

  const rows = variants
    ? variants.map(v => ({
        generation_id: generationId,
        name: v.name,
        price: Number(v.price),
        fuel: car.fuel || [],
        trans: Array.isArray(car.trans) ? car.trans : (car.trans ? [car.trans] : []),
        mileage: car.mileage || {},
        pros: car.pros || [],
        cons: car.cons || [],
        features: Array.isArray(v.features) ? v.features : [],
        images,
      }))
    : [{
        generation_id: generationId,
        name: 'Base',
        price: Number(car.price),
        fuel: car.fuel || [],
        trans: Array.isArray(car.trans) ? car.trans : (car.trans ? [car.trans] : []),
        mileage: car.mileage || {},
        pros: car.pros || [],
        cons: car.cons || [],
        features: [],
        images,
      }];

  const { error } = await supabase.from('trims').insert(rows);
  if (error) throw new Error(`Failed to create trims for car id ${car.id}: ${error.message}`);
  return rows.length;
}

async function main() {
  // Safety check — refuse to run twice.
  const { count: existingTrims } = await supabase.from('trims').select('*', { count: 'exact', head: true });
  if (existingTrims > 0) {
    console.error(`trims table already has ${existingTrims} rows. Refusing to run — this migration is meant to run once on an empty trims table.`);
    console.error('If you genuinely want to re-run, clear the trims/generations/models/brands tables first.');
    process.exit(1);
  }

  const { data: cars, error } = await supabase.from('cars').select('*').order('id');
  if (error) { console.error('Could not read cars table:', error.message); process.exit(1); }

  console.log(`Migrating ${cars.length} cars...`);
  const brandCache = new Map();
  let totalTrims = 0;

  for (const car of cars) {
    try {
      const brandId = await getOrCreateBrand(brandCache, car.make);
      const modelId = await createModel(brandId, car.model, car.body);
      const generationId = await createGeneration(modelId, car.seats);
      const trimCount = await createTrims(generationId, car);
      totalTrims += trimCount;
      console.log(`  OK  ${car.make} ${car.model} -> ${trimCount} trim(s)`);
    } catch (err) {
      console.error(`  FAIL car id ${car.id} (${car.make} ${car.model}): ${err.message}`);
    }
  }

  console.log(`\nDone. ${brandCache.size} brands, ${cars.length} models/generations, ${totalTrims} trims created.`);
  console.log('Verify in Supabase Table Editor, then check the car_listings view returns the same number of rows as your old cars table.');
}

main().catch(err => { console.error('Migration failed:', err); process.exit(1); });
