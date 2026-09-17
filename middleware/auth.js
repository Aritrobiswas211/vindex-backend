const jwt = require('jsonwebtoken');
const supabase = require('../db');

// The 'dev-secret-change-me' fallback is fine for local development, but if
// this ever ran in production without a real JWT_SECRET set, it would
// silently sign every session token with a public, guessable string —
// anyone could forge a valid login. Failing loudly at boot beats failing
// quietly at runtime.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Refusing to start in production with a fallback secret — set JWT_SECRET in your Render environment variables.'
  );
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

// Must be used AFTER requireAuth (needs req.userId already set).
async function requireAdmin(req, res, next) {
  const { data, error } = await supabase
    .from('users')
    .select('is_admin')
    .eq('id', req.userId)
    .maybeSingle();

  if (error || !data || !data.is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
