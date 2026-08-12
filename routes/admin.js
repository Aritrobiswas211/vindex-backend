const express = require('express');
const supabase = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// GET /api/admin/users — list all users with their wishlist count
router.get('/users', async (req, res) => {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, name, email, is_admin, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Could not load users.' });

  const { data: saves } = await supabase.from('saved_cars').select('user_id');
  const counts = {};
  (saves || []).forEach(s => { counts[s.user_id] = (counts[s.user_id] || 0) + 1; });

  res.json({ users: users.map(u => ({ ...u, wishlist_count: counts[u.id] || 0 })) });
});

// DELETE /api/admin/users/:id — remove a user (and their wishlist, via cascade)
router.delete('/users/:id', async (req, res) => {
  if (Number(req.params.id) === req.userId) {
    return res.status(400).json({ error: "You can't delete your own account from here." });
  }
  await supabase.from('users').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/stats — a few basic counts for the dashboard
router.get('/stats', async (req, res) => {
  const { count: totalUsers } = await supabase.from('users').select('*', { count: 'exact', head: true });
  const { count: totalCars } = await supabase.from('cars').select('*', { count: 'exact', head: true });
  const { data: saves } = await supabase.from('saved_cars').select('car_id');
  const totalWishlisted = (saves || []).length;

  let topCar = null;
  if (saves && saves.length) {
    const counts = {};
    saves.forEach(s => { counts[s.car_id] = (counts[s.car_id] || 0) + 1; });
    const topId = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const { data: car } = await supabase.from('cars').select('id, make, model').eq('id', topId).maybeSingle();
    if (car) topCar = { ...car, saves: counts[topId] };
  }

  res.json({ totalUsers, totalCars, totalWishlisted, topCar });
});

module.exports = router;
