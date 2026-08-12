const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// SQLite file lives in /data — one file, no separate database server needed.
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'vindex.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_cars (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    car_id      INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, car_id)
  );

  CREATE TABLE IF NOT EXISTS cars (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    image    TEXT,
    make     TEXT NOT NULL,
    model    TEXT NOT NULL,
    price    REAL NOT NULL,
    fuel     TEXT NOT NULL,
    trans    TEXT NOT NULL,
    body     TEXT NOT NULL,
    seats    INTEGER NOT NULL,
    mileage  REAL NOT NULL,
    unit     TEXT NOT NULL,
    pros     TEXT NOT NULL DEFAULT '[]',
    cons     TEXT NOT NULL DEFAULT '[]'
  );
`);

// Safe migration: adds is_admin to users (defaults to 0 / not-admin).
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!cols.includes('is_admin')) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;`);
      console.log('Migration: added is_admin column to users table.');
    } catch (err) {
      console.error('Migration FAILED to add is_admin column:', err.message);
    }
  }
}

// Safe migration: adds google_id to the users table if it doesn't already
// exist yet (needed for "Sign in with Google"). Note: SQLite does not allow
// ALTER TABLE ... ADD COLUMN with a UNIQUE constraint directly, so we add a
// plain column and enforce uniqueness with a separate partial index instead
// (the WHERE clause means multiple existing NULLs don't clash).
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!cols.includes('google_id')) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT;`);
      console.log('Migration: added google_id column to users table.');
    } catch (err) {
      console.error('Migration FAILED to add google_id column:', err.message);
    }
  }
}
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;`);
} catch (err) {
  console.error('Migration FAILED to create google_id unique index:', err.message);
}

// If ADMIN_EMAIL is set in the environment, make sure that account (once it
// exists) is always promoted to admin on every server start.
if (process.env.ADMIN_EMAIL) {
  try {
    db.prepare(`UPDATE users SET is_admin = 1 WHERE email = ?`)
      .run(process.env.ADMIN_EMAIL.toLowerCase());
  } catch (err) {
    console.error('Could not promote ADMIN_EMAIL to admin:', err.message);
  }
}

// Normalizes the cars.fuel column to always store a JSON array (e.g.
// '["Petrol","CNG"]') so a vehicle can have more than one fuel option.
// Older rows may still have a plain string like "Petrol" — wrap those.
{
  const rows = db.prepare(`SELECT id, fuel FROM cars`).all();
  const fix = db.prepare(`UPDATE cars SET fuel = ? WHERE id = ?`);
  const fixMany = db.transaction((list) => {
    for (const r of list) {
      let needsFix = true;
      try {
        const parsed = JSON.parse(r.fuel);
        if (Array.isArray(parsed)) needsFix = false;
      } catch (err) { /* not JSON — needs fixing */ }
      if (needsFix) fix.run(JSON.stringify([r.fuel]), r.id);
    }
  });
  fixMany(rows);
}

// One-time seed of the cars table from the original built-in catalogue, so
// the admin panel has something to manage on first run. Safe to leave this
// in permanently — it only runs when the table is completely empty.
{
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM cars`).get();
  if (count === 0) {
    const seedPath = path.join(__dirname, 'cars-seed.json');
    if (fs.existsSync(seedPath)) {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      const insert = db.prepare(`
        INSERT INTO cars (image, make, model, price, fuel, trans, body, seats, mileage, unit, pros, cons)
        VALUES (@image, @make, @model, @price, @fuel, @trans, @body, @seats, @mileage, @unit, @pros, @cons)
      `);
      const insertMany = db.transaction((rows) => {
        for (const c of rows) {
          insert.run({
            image: c.image || null,
            make: c.make, model: c.model, price: c.price,
            fuel: JSON.stringify(Array.isArray(c.fuel) ? c.fuel : [c.fuel]),
            trans: c.trans, body: c.body, seats: c.seats, mileage: c.mileage,
            unit: c.unit,
            pros: JSON.stringify(c.pros || []),
            cons: JSON.stringify(c.cons || []),
          });
        }
      });
      insertMany(seed);
      console.log(`Seeded cars table with ${seed.length} cars.`);
    }
  }
}

module.exports = db;
