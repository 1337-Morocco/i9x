// Persistent storage for deployed apps: named Docker volumes, host bind mounts,
// and small config files edited from the panel instead of over SSH.
//
// File mounts are the interesting case — the body lives in the metadata DB (so
// it survives a rebuild and can be edited in the UI) and is materialised to
// /var/lib/i9x/mounts/<app>/ just before the container starts, then bind
// mounted at the target path. Pure helpers only: the routes live in
// mountroutes.js and the docker args are consumed by deployroutes.js.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const BASE = process.env.I9X_MOUNTS || '/var/lib/i9x/mounts';
const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MAX_FILE = 1024 * 1024;   // 1 MiB — these are config files, not assets
const TYPES = new Set(['volume', 'bind', 'file']);

const appDir = (app) => path.join(BASE, app);
// Deterministic host path for a file mount: stable across edits and restarts.
const filePath = (m) => path.join(appDir(m.app), `${m.id}-${path.basename(m.target) || 'file'}`);

function badPath(p) {
  return !p.startsWith('/') || p.includes('\0') || p.split('/').includes('..') || p.length > 255;
}

// Validate and normalise one mount definition coming from the API.
function validate(input, { app, existing = [], id = null } = {}) {
  const type = String((input && input.type) || 'volume');
  if (!TYPES.has(type)) return { error: 'Mount type must be volume, bind or file' };

  const target = String((input && input.target) || '').trim().replace(/\/+$/, '');
  if (badPath(target)) return { error: 'Container path must be absolute, with no “..” segments' };
  if (target === '/') return { error: 'Refusing to mount over the container root' };
  if (existing.some((m) => m.target === target && m.id !== id))
    return { error: `Another mount already uses the container path ${target}` };

  const ro = !!(input && input.ro);
  let source = String((input && input.source) || '').trim();
  let content = '';

  if (type === 'volume') {
    if (!source) source = `${app}-${target.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-')}`.slice(0, 60);
    if (!VOLUME_RE.test(source)) return { error: 'Volume name: letters, digits, dot, dash, underscore' };
  } else if (type === 'bind') {
    if (badPath(source)) return { error: 'Host path must be absolute, with no “..” segments' };
  } else {
    content = String((input && input.content) != null ? input.content : '');
    if (Buffer.byteLength(content) > MAX_FILE) return { error: 'File mounts are limited to 1 MiB' };
    source = '';
  }
  return { mount: { app, type, source, target, content, ro } };
}

// Write file mounts to disk and make sure bind sources exist. Called right
// before a container is (re)created.
function materialize(app) {
  const rows = db.mounts.all(app);
  if (rows.some((m) => m.type === 'file')) fs.mkdirSync(appDir(app), { recursive: true, mode: 0o700 });
  for (const m of rows) {
    if (m.type === 'file') {
      fs.writeFileSync(filePath(m), m.content, { mode: 0o600 });
    } else if (m.type === 'bind' && !fs.existsSync(m.source)) {
      // Docker would create this as a root-owned directory anyway; doing it here
      // keeps the failure mode (bad path) visible in the build log instead.
      fs.mkdirSync(m.source, { recursive: true });
    }
  }
  return rows;
}

// `docker run` arguments for every mount an app declares.
function dockerArgs(app) {
  const args = [];
  for (const m of db.mounts.all(app)) {
    const src = m.type === 'file' ? filePath(m) : m.source;
    args.push('-v', `${src}:${m.target}${m.ro ? ':ro' : ''}`);
  }
  return args;
}

// Presentation shape: never ship a whole file body in the list response.
function summarize(m) {
  return {
    id: m.id, app: m.app, type: m.type, target: m.target, ro: !!m.ro, created: m.created,
    source: m.type === 'file' ? filePath(m) : m.source,
    bytes: m.type === 'file' ? Buffer.byteLength(m.content || '') : null,
  };
}

// Drop an app's mounts and the files backing them (called when the app is deleted).
function removeApp(app) {
  db.mounts.removeApp(app);
  fs.rmSync(appDir(app), { recursive: true, force: true });
}

function removeOne(m) {
  if (m.type === 'file') fs.rmSync(filePath(m), { force: true });
  db.mounts.remove(m.id);
}

module.exports = { validate, materialize, dockerArgs, summarize, removeApp, removeOne, filePath, BASE };
