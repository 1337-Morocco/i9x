// API tokens — long-lived bearer credentials for scripts and CI.
//
// A token looks like `i9x_<id>_<secret>`; only sha256(secret) is stored, so the
// plaintext exists exactly once, in the response that created it. Tokens are
// accepted anywhere a session is (see requireAuth in authroutes.js), which is
// what makes `curl -H "Authorization: Bearer …" .../api/v1/apps/x/deploy` work
// from a GitHub Action.

const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const SCOPES = new Set(['read', 'write']);
// `wl_` is the pre-2.0 prefix, still accepted so tokens already living in
// someone's CI secrets survive the rename. New tokens are always minted `i9x_`.
const TOKEN_RE = /^(?:i9x|wl)_([0-9]+)_([A-Za-z0-9_-]{20,})$/;
const TOUCH_INTERVAL = 60 * 1000;   // don't write last_used on every request

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const lastTouched = new Map();

// Create a token and return the one-time plaintext.
function mint({ name, scope, expiresDays }) {
  const secret = crypto.randomBytes(32).toString('base64url');
  const id = db.apiTokens.create({
    name,
    prefix: secret.slice(0, 6),   // enough to recognise a token in a list, useless on its own
    hash: sha256(secret),
    scope,
    expires: expiresDays ? Date.now() + expiresDays * 86400000 : null,
  });
  return { id, token: `i9x_${id}_${secret}` };
}

const display = (t) => `i9x_${t.id}_${t.prefix}…`;

// Verify a bearer value. Returns the token record, or null.
function verify(raw) {
  const m = TOKEN_RE.exec(String(raw || ''));
  if (!m) return null;
  const rec = db.apiTokens.get(m[1]);
  if (!rec) return null;
  const expected = Buffer.from(rec.hash, 'hex');
  const actual = Buffer.from(sha256(m[2]), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (rec.expires && Date.now() > rec.expires) return null;
  const now = Date.now();
  if (now - (lastTouched.get(rec.id) || 0) > TOUCH_INTERVAL) {
    lastTouched.set(rec.id, now);
    db.apiTokens.touch(rec.id);
  }
  return rec;
}

// A read-scoped token may only perform safe requests.
const allowsMethod = (rec, method) => rec.scope === 'write' || method === 'GET' || method === 'HEAD';

// ---------------------------------------------------------------------------
// Routes (session-only — a token can never mint another token)
// ---------------------------------------------------------------------------

const router = express.Router();

const publicToken = (t) => ({
  id: t.id, name: t.name, scope: t.scope, created: t.created,
  lastUsed: t.lastUsed || null, expires: t.expires || null,
  prefix: display(t),
  expired: !!(t.expires && Date.now() > t.expires),
});

// db.apiTokens.all() omits the hash but keeps prefix, which publicToken needs.
router.get('/', (_req, res) => res.json({ tokens: db.apiTokens.all().map(publicToken) }));

router.post('/', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Name must be 2–60 characters' });
  const scope = String((req.body && req.body.scope) || 'write');
  if (!SCOPES.has(scope)) return res.status(400).json({ error: 'Scope must be read or write' });
  let expiresDays = null;
  if (req.body && req.body.expiresDays) {
    expiresDays = Number(req.body.expiresDays);
    if (!Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650)
      return res.status(400).json({ error: 'Expiry must be 1–3650 days' });
  }
  const { id, token } = mint({ name, scope, expiresDays });
  // `token` is returned once and never again.
  res.json({ ok: true, token, record: publicToken(db.apiTokens.get(id)) });
});

router.delete('/:id', (req, res) => {
  const t = db.apiTokens.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such token' });
  db.apiTokens.remove(t.id);
  res.json({ ok: true });
});

module.exports = { tokenRouter: router, verify, allowsMethod };
