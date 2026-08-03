// Email + password authentication for i9x.
//
// Accounts are application users stored in the metadata DB (passwords hashed
// with scrypt from node:crypto — no native deps). They are NOT Linux users:
// the service runs as root and everything (shell, filesystem) operates with the
// service's identity. The FIRST account is created on first run ("setup"); after
// that, sign-ups are closed and further users must be added by an admin.

const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOME = process.env.I9X_HOME || '/root';

// ---- password hashing (scrypt) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  let actual;
  try { actual = crypto.scryptSync(password, salt, 64); } catch { return false; }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---- sessions: token -> { email, name, home } (in-memory) ----
const sessions = new Map();
function makeSession(u) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { email: u.email, name: u.name || u.email, home: HOME });
  return token;
}
function sessionForToken(token) {
  return token ? sessions.get(token) || null : null;
}
function tokenFromReq(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}
// Accepts either a browser session or an API token (see apitokens.js). Loaded
// lazily to keep the module graph acyclic — apitokens.js pulls in the DB, which
// this module is also part of via db.js.
function apiTokens() { return require('./apitokens'); }

function requireAuth(req, res, next) {
  const raw = tokenFromReq(req);
  const s = sessionForToken(raw);
  if (s) { req.session = s; return next(); }

  const t = apiTokens().verify(raw);
  if (!t) return res.status(401).json({ error: 'not authenticated' });
  if (!apiTokens().allowsMethod(t, req.method))
    return res.status(403).json({ error: 'this API token is read-only' });
  req.session = { email: `token:${t.name}`, name: t.name, home: HOME, apiToken: t };
  next();
}

// For routes a token must never reach — creating other tokens, and anything
// that hands out an interactive shell.
function requireSession(req, res, next) {
  const s = sessionForToken(tokenFromReq(req));
  if (!s) return res.status(401).json({ error: 'sign in with your account to do that' });
  req.session = s;
  next();
}

const publicUser = (u) => ({ email: u.email, name: u.name });

// Whether the app still needs its first account created.
router.get('/status', (_req, res) => {
  let setup = true;
  try { setup = db.users.count() === 0; } catch { /* DB unavailable */ }
  res.json({ setup });
});

// First-run only: create the owner account.
router.post('/register', (req, res) => {
  if (db.users.count() > 0) return res.status(403).json({ error: 'Sign-ups are closed — ask an admin to create your account.' });
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const name = String((req.body && req.body.name) || '').trim();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  db.users.create({ email, name: name || email.split('@')[0], pass: hashPassword(password) });
  const u = db.users.get(email);
  res.json({ token: makeSession(u), ...publicUser(u) });
});

router.post('/login', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const u = db.users.get(email);
  // Verify even when the user is missing to keep timing uniform.
  const ok = u ? verifyPassword(password, u.pass) : verifyPassword(password, 'x:00');
  if (!u || !ok) return res.status(400).json({ error: 'Incorrect email or password' });
  res.json({ token: makeSession(u), ...publicUser(u) });
});

router.post('/logout', (req, res) => {
  const t = tokenFromReq(req);
  if (t) sessions.delete(t);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) =>
  res.json({
    email: req.session.email, name: req.session.name, home: req.session.home,
    viaToken: !!req.session.apiToken,
  })
);

module.exports = { authRouter: router, requireAuth, requireSession, sessionForToken };
