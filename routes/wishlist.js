const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All wishlist routes require a signed-in user
router.use(requireAuth);

// GET /api/wishlist -> [carId, carId, ...]
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT car_id FROM saved_cars WHERE user_id = ?').all(req.userId);
  res.json({ carIds: rows.map(r => r.car_id) });
});

// POST /api/wishlist { carId }
router.post('/', (req, res) => {
  const { carId } = req.body || {};
  if (typeof carId !== 'number') return res.status(400).json({ error: 'carId (number) is required.' });

  db.prepare('INSERT OR IGNORE INTO saved_cars (user_id, car_id) VALUES (?, ?)').run(req.userId, carId);
  res.status(201).json({ ok: true });
});

// DELETE /api/wishlist/:carId
router.delete('/:carId', (req, res) => {
  db.prepare('DELETE FROM saved_cars WHERE user_id = ? AND car_id = ?').run(req.userId, Number(req.params.carId));
  res.json({ ok: true });
});

module.exports = router;
