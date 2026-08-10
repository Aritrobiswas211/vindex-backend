const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, isAdmin: !!row.is_admin };
}

// POST /api/auth/signup
router.post('/signup', (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  const passwordHash = bcrypt.hashSync(password, 10);

  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name.trim(), email.toLowerCase(), passwordHash);

  const user = db.prepare('SELECT id, name, email, is_admin FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user.id);

  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const token = signToken(row.id);
  res.json({ token, user: publicUser(row) });
});

// POST /api/auth/google  — body: { credential }  (the ID token from Google's Sign In button)
router.post('/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google sign-in is not configured on the server yet.' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in. Please try again.' });
  }

  const email = (payload.email || '').toLowerCase();
  const name = payload.name || email.split('@')[0];
  const googleId = payload.sub;
  if (!email) return res.status(400).json({ error: 'Google account has no email to sign in with.' });

  // Look up by google_id first, then by email (lets an existing password
  // account "link" itself the first time it signs in with Google).
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId);
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
    }
  }
  if (!user) {
    // New account — password_hash is required by the schema but unused for
    // Google accounts, so fill it with an unguessable random value.
    const randomPasswordHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
    const info = db
      .prepare('INSERT INTO users (name, email, password_hash, google_id) VALUES (?, ?, ?, ?)')
      .run(name, email, randomPasswordHash, googleId);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = signToken(user.id);
  res.json({ token, user: publicUser(user) });
});

// GET /api/auth/me  (used to restore session on page load)
router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, name, email, is_admin FROM users WHERE id = ?').get(req.userId);
  if (!row) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(row) });
});

module.exports = router;
