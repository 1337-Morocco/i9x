// Update checks + one-click upgrade. Mounted at /api/update.
//
// How an installed copy learns a new version exists: the release host publishes
// a manifest (version.json) next to the .deb, rewritten by every build. We poll
// it, compare with the version baked into this binary at build time, and if it
// is newer we hand the actual install over to /usr/bin/i9x-update — which
// downloads, verifies the SHA-256 and runs dpkg. Because that upgrade restarts
// i9x.service (and therefore kills this process), it is spawned detached
// and reports progress through a state file both sides agree on.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const router = express.Router();

// Baked in by esbuild (--define:__I9X_VERSION__) when the .deb is built.
// A plain `node src/server.js` dev run has no define, hence the typeof guard.
const BUILD_VERSION = typeof __I9X_VERSION__ !== 'undefined' ? __I9X_VERSION__ : 'dev';

const MANIFEST_URL = process.env.I9X_UPDATE_URL
  || 'https://github.com/1337-Morocco/i9x/releases/latest/download/version.json';
const UPDATER = '/usr/bin/i9x-update';
const STATE_FILE = '/var/lib/i9x/update-state.json';
const LOG_FILE = '/var/log/i9x-update.log';
const CHECK_TTL_MS = 6 * 60 * 60 * 1000; // don't hammer the release host

const ARCH = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;

let cache = null; // { at, result }

// Debian version ordering, roughly: compare dotted numeric parts, then any
// trailing suffix as a string. Enough for the x.y.z scheme we publish.
function isNewer(latest, current) {
  if (!latest || !current || current === 'dev') return false;
  const parts = (v) => String(v).split(/[.+~-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] === undefined ? 0 : a[i];
    const y = b[i] === undefined ? 0 : b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    return String(x) > String(y);
  }
  return false;
}

// What dpkg thinks is installed — the truth after an upgrade, even if this
// process is still the old binary because the service has not restarted yet.
const installedVersion = () =>
  new Promise((resolve) => {
    execFile('dpkg-query', ['-W', "-f=${Version}", 'i9x'], (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    );
  });

async function fetchManifest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(MANIFEST_URL, { signal: ctrl.signal, headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`update server returned HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function check() {
  const current = (await installedVersion()) || BUILD_VERSION;
  const m = await fetchManifest();
  const build = (m.builds || {})[ARCH] || null;
  return {
    current,
    latest: m.version || null,
    updateAvailable: Boolean(build) && isNewer(m.version, current),
    notes: m.notes || null,
    released: m.released || null,
    size: build ? build.size : null,
    arch: ARCH,
    supported: Boolean(build),
    canInstall: fs.existsSync(UPDATER),
    checkedAt: new Date().toISOString(),
  };
}

router.get('/check', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && cache && Date.now() - cache.at < CHECK_TTL_MS) {
    return res.json({ ...cache.result, cached: true });
  }
  try {
    const result = await check();
    cache = { at: Date.now(), result };
    res.json(result);
  } catch (e) {
    // A failed check must never look like "you are up to date".
    res.json({
      current: (await installedVersion()) || BUILD_VERSION,
      latest: null,
      updateAvailable: false,
      arch: ARCH,
      error: e.name === 'AbortError' ? 'update server timed out' : e.message,
      checkedAt: new Date().toISOString(),
    });
  }
});

// Progress of an upgrade in flight. The updater writes STATE_FILE at each step;
// this survives the service restart that happens mid-install.
router.get('/status', (_req, res) => {
  let state = { state: 'idle' };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* never updated on this machine */ }
  let log = '';
  try {
    const buf = fs.readFileSync(LOG_FILE, 'utf8');
    log = buf.slice(-8000);
  } catch { /* no log yet */ }
  res.json({ ...state, log });
});

router.post('/apply', async (req, res) => {
  if (!fs.existsSync(UPDATER)) {
    return res.status(400).json({ error: 'i9x-update is not installed — reinstall from the installer script.' });
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return res.status(400).json({ error: 'updates must be installed as root (run: sudo i9x-update)' });
  }
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* none */ }
  if (['downloading', 'installing'].includes(state.state)) {
    return res.status(409).json({ error: `an update is already ${state.state}`, ...state });
  }

  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ state: 'downloading', message: 'starting', at: new Date().toISOString() }));
  } catch { /* best effort */ }

  // Detached: dpkg restarts i9x.service, which kills us mid-install.
  const args = ['--url', MANIFEST_URL];
  if (req.body && req.body.force) args.push('--force');
  const child = spawn(UPDATER, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  child.unref();
  cache = null; // whatever we cached is about to be wrong

  res.json({ ok: true, started: true, message: 'Update started. The panel restarts on the new version in a moment.' });
});

module.exports = { updateRouter: router, BUILD_VERSION };
