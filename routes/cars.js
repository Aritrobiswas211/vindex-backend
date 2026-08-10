const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function toPublic(row) {
  return {
    id: row.id,
    image: row.image || undefined,
    make: row.make,
    model: row.model,
    price: row.price,
    fuel: row.fuel,
    trans: row.trans,
    body: row.body,
    seats: row.seats,
    mileage: row.mileage,
    unit: row.unit,
    pros: JSON.parse(row.pros || '[]'),
    cons: JSON.parse(row.cons || '[]'),
  };
}

function validateBody(b) {
  const required = ['make', 'model', 'price', 'fuel', 'trans', 'body', 'seats', 'mileage', 'unit'];
  for (const key of required) {
    if (b[key] === undefined || b[key] === null || b[key] === '') {
      return `Missing field: ${key}`;
    }
  }
  return null;
}

// GET /api/cars — public, anyone can browse the catalogue
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM cars ORDER BY id').all();
  res.json({ cars: rows.map(toPublic) });
});

// POST /api/cars — admin only, create a new car
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  const info = db.prepare(`
    INSERT INTO cars (image, make, model, price, fuel, trans, body, seats, mileage, unit, pros, cons)
    VALUES (@image, @make, @model, @price, @fuel, @trans, @body, @seats, @mileage, @unit, @pros, @cons)
  `).run({
    image: b.image || null,
    make: b.make, model: b.model, price: Number(b.price), fuel: b.fuel,
    trans: b.trans, body: b.body, seats: Number(b.seats), mileage: Number(b.mileage),
    unit: b.unit,
    pros: JSON.stringify(b.pros || []),
    cons: JSON.stringify(b.cons || []),
  });

  const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ car: toPublic(row) });
});

// PUT /api/cars/:id — admin only, edit an existing car
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Car not found.' });

  const b = req.body || {};
  const err = validateBody(b);
  if (err) return res.status(400).json({ error: err });

  db.prepare(`
    UPDATE cars SET image=@image, make=@make, model=@model, price=@price, fuel=@fuel,
    trans=@trans, body=@body, seats=@seats, mileage=@mileage, unit=@unit, pros=@pros, cons=@cons
    WHERE id=@id
  `).run({
    id: req.params.id,
    image: b.image || null,
    make: b.make, model: b.model, price: Number(b.price), fuel: b.fuel,
    trans: b.trans, body: b.body, seats: Number(b.seats), mileage: Number(b.mileage),
    unit: b.unit,
    pros: JSON.stringify(b.pros || []),
    cons: JSON.stringify(b.cons || []),
  });

  const row = db.prepare('SELECT * FROM cars WHERE id = ?').get(req.params.id);
  res.json({ car: toPublic(row) });
});

// DELETE /api/cars/:id — admin only
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM cars WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
