// Managed databases — one container per instance, backed by a named volume, for
// every engine in dbengines.js (PostgreSQL, MySQL, MariaDB, Redis, Valkey,
// MongoDB, ClickHouse). Mounted at /api/db, and at /api/postgres for backwards
// compatibility with the older PostgreSQL-only client.
//
// This router is engine-agnostic: it validates input, drives Docker and streams
// logs, and defers every engine-specific decision to the driver map.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const db = require('./db');
const dps = require('./dockerps');
const engines = require('./dbengines');
const { publicHost } = require('./nethost');

const BASE = process.env.I9X_DBS || '/var/lib/i9x/databases';
const LEGACY_BASE = process.env.I9X_POSTGRES || '/var/lib/i9x/postgres';
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const READY_TIMEOUT_MS = 120000;

const table = db.databases;
const cname = engines.cname;
const volume = engines.volume;

// Provisioning logs used to live under the postgres directory — keep reading the
// old path for instances created before the multi-engine rewrite.
function provLog(name) {
  const current = path.join(BASE, `${name}.log`);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(LEGACY_BASE, `${name}.log`);
  return fs.existsSync(legacy) ? legacy : current;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });
}
function spawnToLog(cmd, args, ls) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    child.stdout.on('data', (d) => ls.write(d));
    child.stderr.on('data', (d) => ls.write(d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A URL-safe password with no shell-hostile characters (keeps connection strings
// clean and avoids quoting headaches in CLIs and env files).
function genPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
}

const redact = (s, secret) => (secret ? s.split(secret).join('••••••') : s);

// ---------------------------------------------------------------------------
// Provisioning (background) — create the container, then wait until the engine
// actually answers before calling it running.
// ---------------------------------------------------------------------------

async function provision(name) {
  const d = table.get(name);
  if (!d) return;
  const e = engines.get(d.engine);
  fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
  const ls = fs.createWriteStream(path.join(BASE, `${name}.log`), { flags: 'w' });
  const w = (s) => ls.write(s);
  try {
    await run('docker', ['rm', '-f', cname(d)]).catch(() => {});
    const args = engines.runArgs(d);
    w(`$ docker ${redact(args.join(' '), d.dbPass)}\n`);
    await spawnToLog('docker', args, ls);

    w(`\n▸ Waiting for ${e.label} to accept connections…\n`);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (await engines.isReady(d)) { ready = true; break; }
      await sleep(2000);
      w('.');
    }
    if (!ready) throw new Error(`${e.label} did not become ready within ${READY_TIMEOUT_MS / 1000}s — check the container logs`);

    table.setState(name, 'running');
    w(`\n\n✓ ${e.label} ${d.version} ready on localhost:${d.port}\n`);
    dps.invalidate();
  } catch (err) {
    table.setState(name, 'failed');
    w(`\n✗ PROVISION FAILED: ${err.message}\n`);
  } finally {
    ls.end();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = express.Router();

// Which engines this build can provision, and the shape of each create form.
router.get('/engines', (_req, res) => res.json({ engines: engines.catalog() }));

function summarize(rows, snap) {
  const pub = publicHost();
  return rows.map((d) => {
    const e = engines.get(d.engine);
    const dstat = !snap ? 'unknown' : snap.names.has(cname(d)) ? 'running' : 'stopped';
    let status = dstat;
    if (d.state === 'provisioning') status = 'provisioning';
    else if (d.state === 'failed' && dstat !== 'running') status = 'failed';
    return {
      name: d.name, engine: d.engine, engineLabel: e ? e.label : d.engine, kind: e ? e.kind : 'sql',
      browse: e ? e.browse : null, consoleHint: e ? e.consoleHint || '' : '', canDump: !!(e && e.dump),
      version: d.version, dbName: d.dbName, dbUser: d.dbUser, dbPass: d.dbPass,
      port: d.port, created: d.created, status,
      host: pub, uri: e ? engines.uri(d, pub) : '',
      localHost: 'localhost', localUri: e ? engines.uri(d, 'localhost') : '',
      container: e ? cname(d) : '',
    };
  });
}

router.get('/dbs', async (_req, res) => {
  try {
    const rows = table.all();
    const snap = rows.length ? await dps.snapshot() : { names: new Set() };
    res.json({ dbs: summarize(rows, snap) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/dbs', async (req, res) => {
  const { name, version, dbName, dbUser, port } = req.body || {};
  let { password } = req.body || {};
  // /api/postgres callers (the pre-multi-engine client) send no engine.
  const engineId = String((req.body && req.body.engine) || 'postgres');
  const e = engines.get(engineId);
  if (!e) return res.status(400).json({ error: `Unknown database engine “${engineId}”` });
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'Name: lowercase letters, digits, hyphens (2–31 chars)' });

  const ver = String(version || e.defaultVersion);
  if (!e.versions.includes(ver)) return res.status(400).json({ error: `Unsupported ${e.label} version` });

  let dbn = '', usr = '';
  if (e.fields.dbName) {
    dbn = String(dbName || name).trim().replace(/-/g, '_');
    if (!engines.IDENT_RE.test(dbn)) return res.status(400).json({ error: 'Database name must start with a letter/underscore (letters, digits, underscores)' });
  }
  if (e.fields.dbUser) {
    usr = String(dbUser || e.defaultUser || 'admin').trim();
    if (!engines.IDENT_RE.test(usr)) return res.status(400).json({ error: 'Username must start with a letter/underscore (letters, digits, underscores)' });
  }
  password = password == null ? '' : String(password);
  if (password && (password.length < 6 || password.length > 100)) return res.status(400).json({ error: 'Password must be 6–100 characters' });
  if (!password) password = genPassword();

  let p;
  if (port !== undefined && port !== null && String(port) !== '') {
    p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return res.status(400).json({ error: 'Port must be 1024–65535' });
    const owner = db.portOwner(p);
    if (owner) return res.status(400).json({ error: `Port ${p} is already used by the ${owner.kind} “${owner.name}”` });
  } else {
    p = db.freePort(e.portRange[0], e.portRange[1]) || db.freePort();
    if (!p) return res.status(400).json({ error: 'No free port available' });
  }
  if (table.get(name)) return res.status(400).json({ error: 'A database with that name already exists' });

  try {
    fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
    table.create({ name, engine: engineId, version: ver, dbName: dbn, dbUser: usr, dbPass: password, port: p, state: 'provisioning' });
    fs.writeFileSync(path.join(BASE, `${name}.log`), `Provisioning ${e.label} ${ver}…\n`);
    provision(name); // background
    res.json({ ok: true, provisioning: true, name, engine: engineId, port: p });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Resolve ?name= / body.name to an instance, or answer 400.
function lookup(req, res) {
  const name = (req.query && req.query.name) || (req.body && req.body.name);
  if (!NAME_RE.test(name || '')) { res.status(400).json({ error: 'invalid name' }); return null; }
  const d = table.get(name);
  if (!d) { res.status(400).json({ error: 'no such database' }); return null; }
  if (!engines.get(d.engine)) { res.status(400).json({ error: `unsupported engine ${d.engine}` }); return null; }
  return d;
}

router.get('/log', (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  let text = '';
  try { text = fs.readFileSync(provLog(d.name), 'utf8'); } catch { /* not written yet */ }
  res.json({ text, state: d.state || 'unknown' });
});

router.post('/action', async (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  const { action, deleteData } = req.body || {};
  try {
    if (action === 'start') await run('docker', ['start', cname(d)]);
    else if (action === 'stop') await run('docker', ['stop', cname(d)]);
    else if (action === 'restart') await run('docker', ['restart', cname(d)]);
    else if (action === 'reprovision') { table.setState(d.name, 'provisioning'); provision(d.name); }
    else if (action === 'remove') {
      await run('docker', ['rm', '-f', cname(d)]).catch(() => {});
      if (deleteData) await run('docker', ['volume', 'rm', '-f', volume(d)]).catch(() => {});
      fs.rmSync(provLog(d.name), { force: true });
      db.tasks.removeForTarget('database', d.name);
      table.remove(d.name);
    } else return res.status(400).json({ error: 'invalid action' });
    dps.invalidate();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  try { res.json({ text: await run('docker', ['logs', '--tail', '300', cname(d)]) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/tables', async (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  try { res.json({ tables: await engines.tables(d) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/table', async (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  try {
    const r = await engines.tableData(d, String(req.query.schema || ''), String(req.query.table || ''), limit, offset);
    res.json({ ...r, limit, offset });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Run SQL (SQL engines) or a CLI command (Redis/Valkey/MongoDB). SELECT-shaped
// statements come back as a grid; anything else returns its output as a message.
router.post('/query', async (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  const sql = String((req.body && (req.body.sql ?? req.body.command)) || '').trim();
  if (!sql) return res.status(400).json({ error: 'empty query' });
  try {
    const r = await engines.query(d, sql);
    if (r.text !== undefined) return res.json({ message: r.text });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Stream a logical dump straight to the browser as a download.
router.get('/dump', (req, res) => {
  const d = lookup(req, res);
  if (!d) return;
  let stream;
  try { stream = engines.dumpStream(d); } catch (e) { return res.status(400).json({ error: e.message }); }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${d.name}-${stamp}.${stream.spec.ext}"`);
  let err = '';
  stream.child.stderr.on('data', (c) => (err += c));
  stream.child.stdout.pipe(res);
  stream.child.on('close', (code) => {
    if (code !== 0 && !res.headersSent) res.status(400).json({ error: err.trim() || `dump exited with ${code}` });
    else res.end();
  });
  req.on('close', () => stream.child.kill());
});

// The container name for an instance — used by the scheduled-task runner.
function containerFor(name) {
  const d = table.get(name);
  return d && engines.get(d.engine) ? cname(d) : null;
}

// On restart, anything left mid-provision didn't finish. Re-probe first: a
// container that came up fine while i9x was down is simply running.
async function reconcile() {
  for (const d of table.all()) {
    if (d.state !== 'provisioning') continue;
    if (engines.get(d.engine) && (await engines.isReady(d))) table.setState(d.name, 'running');
    else table.setState(d.name, 'failed');
  }
}

module.exports = { dbRouter: router, reconcileDatabases: reconcile, containerFor };
