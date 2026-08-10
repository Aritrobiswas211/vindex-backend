const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/admin/users — list all users with their wishlist count
router.get('/users', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.is_admin, u.created_at,
           COUNT(s.id) AS wishlist_count
    FROM users u
    LEFT JOIN saved_cars s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all();
  res.json({ users: rows });
});

// DELETE /api/admin/users/:id — remove a user (and their wishlist, via cascade)
router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.userId) {
    return res.status(400).json({ error: "You can't delete your own account from here." });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/stats — a few basic counts for the dashboard
router.get('/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const totalCars = db.prepare('SELECT COUNT(*) AS n FROM cars').get().n;
  const totalWishlisted = db.prepare('SELECT COUNT(*) AS n FROM saved_cars').get().n;
  const topCar = db.prepare(`
    SELECT c.id, c.make, c.model, COUNT(s.id) AS saves
    FROM saved_cars s JOIN cars c ON c.id = s.car_id
    GROUP BY c.id ORDER BY saves DESC LIMIT 1
  `).get();
  res.json({ totalUsers, totalCars, totalWishlisted, topCar: topCar || null });
});

module.exports = router;
