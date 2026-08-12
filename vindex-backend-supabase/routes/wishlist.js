const express = require('express');
const supabase = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// GET /api/wishlist -> [carId, carId, ...]
router.get('/', async (req, res) => {
  const { data, error } = await supabase.from('saved_cars').select('car_id').eq('user_id', req.userId);
  if (error) return res.status(500).json({ error: 'Could not load wishlist.' });
  res.json({ carIds: data.map(r => r.car_id) });
});

// POST /api/wishlist { carId }
router.post('/', async (req, res) => {
  const { carId } = req.body || {};
  if (typeof carId !== 'number') return res.status(400).json({ error: 'carId (number) is required.' });

  const { error } = await supabase
    .from('saved_cars')
    .upsert({ user_id: req.userId, car_id: carId }, { onConflict: 'user_id,car_id', ignoreDuplicates: true });

  if (error) return res.status(500).json({ error: 'Could not save to wishlist.' });
  res.status(201).json({ ok: true });
});

// DELETE /api/wishlist/:carId
router.delete('/:carId', async (req, res) => {
  await supabase.from('saved_cars').delete().eq('user_id', req.userId).eq('car_id', Number(req.params.carId));
  res.json({ ok: true });
});

module.exports = router;
