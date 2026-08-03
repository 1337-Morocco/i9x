// Docker cleanup and the disk guard — mounted at /api/maintenance.
//
// i9x builds images on the host, so a busy panel accumulates dangling
// layers and build cache faster than anything else on the box; a full disk is
// the most common way one of these machines dies. This runs a scheduled prune,
// reports what each run reclaimed, and watches free space so the disk can be
// rescued before it fills.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');
const cron = require('./cron');
const dps = require('./dockerps');

const APPS_BASE = process.env.I9X_APPS || '/var/lib/i9x/apps';
const SETTINGS_KEY = 'maintenance';
const ALERT_KEY = 'disk_alert';
const AUTO_CLEAN_COOLDOWN = 60 * 60 * 1000;   // don't thrash the disk on repeat alerts

const DEFAULTS = {
  enabled: true,
  schedule: '0 3 * * *',        // nightly at 03:00
  images: true,                 // dangling images
  buildCache: true,             // docker builder cache
  containers: true,             // exited containers
  networks: true,               // unused networks
  volumes: false,               // OFF by default: volumes hold database data
  buildLogDays: 14,             // trim i9x build logs older than this (0 = keep)
  diskThreshold: 85,            // percent used before the guard fires
  autoCleanOnThreshold: true,
};

function run(cmd, args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });
}

function getSettings() {
  let stored = {};
  try { stored = JSON.parse(db.kv.get(SETTINGS_KEY) || '{}'); } catch { /* corrupt — fall back to defaults */ }
  return { ...DEFAULTS, ...stored };
}

function saveSettings(input) {
  const s = { ...getSettings() };
  for (const k of ['enabled', 'images', 'buildCache', 'containers', 'networks', 'volumes', 'autoCleanOnThreshold'])
    if (input[k] !== undefined) s[k] = !!input[k];
  if (input.schedule !== undefined) {
    const v = cron.validate(String(input.schedule));
    if (!v.ok) return { error: `Schedule: ${v.error}` };
    s.schedule = String(input.schedule).trim();
  }
  if (input.buildLogDays !== undefined) {
    const n = Number(input.buildLogDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) return { error: 'Build log retention must be 0–365 days' };
    s.buildLogDays = n;
  }
  if (input.diskThreshold !== undefined) {
    const n = Number(input.diskThreshold);
    if (!Number.isInteger(n) || n < 50 || n > 99) return { error: 'Disk threshold must be 50–99%' };
    s.diskThreshold = n;
  }
  db.kv.set(SETTINGS_KEY, JSON.stringify(s));
  return { settings: s };
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

// Docker's data root is what actually fills up; it is often a separate mount.
async function dockerRoot() {
  try { return (await run('docker', ['info', '-f', '{{.DockerRootDir}}'], 10000)).trim() || '/var/lib/docker'; }
  catch { return '/var/lib/docker'; }
}

async function diskFor(target) {
  const out = await run('df', ['-Pk', target], 15000);
  const line = out.trim().split('\n').pop().split(/\s+/);
  const total = Number(line[1]) * 1024;
  const used = Number(line[2]) * 1024;
  const avail = Number(line[3]) * 1024;
  return { path: target, filesystem: line[0], total, used, avail, percent: total ? Math.round((used / total) * 100) : 0 };
}

async function diskStatus() {
  const root = await dockerRoot();
  const disks = [];
  const seen = new Set();
  for (const p of ['/', root]) {
    try {
      const d = await diskFor(p);
      if (seen.has(d.filesystem)) continue;   // same volume mounted twice — report once
      seen.add(d.filesystem);
      disks.push(d);
    } catch { /* path may not exist on this host */ }
  }
  const worst = disks.reduce((a, b) => (a && a.percent >= b.percent ? a : b), null);
  return { disks, worst, dockerRoot: root };
}

// `docker system df` per-type totals: images / containers / volumes / build cache.
async function dockerUsage() {
  try {
    const out = await run('docker', ['system', 'df', '--format', '{{json .}}'], 30000);
    const rows = out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return rows.map((r) => ({
      type: r.Type, count: Number(r.TotalCount || 0), active: Number(r.Active || 0),
      size: r.Size || '0B', reclaimable: r.Reclaimable || '0B',
      reclaimableBytes: parseSize(String(r.Reclaimable || '0B').split(' ')[0]),
    }));
  } catch { return []; }
}

// "1.234GB" / "512kB" / "0B" -> bytes
const UNITS = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
function parseSize(s) {
  const m = String(s).trim().match(/^([0-9.]+)\s*([a-zA-Z]+)?$/);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (UNITS[String(m[2] || 'b').toLowerCase()] || 1));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let cleaning = false;

// Delete build logs older than `days`. These are the one i9x-owned thing
// that grows without bound; the build records themselves stay.
function trimBuildLogs(days) {
  if (!days) return { removed: 0, bytes: 0 };
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let bytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(APPS_BASE); } catch { return { removed, bytes }; }
  for (const f of entries) {
    if (!/\.build\.\d+\.log$/.test(f)) continue;
    const p = path.join(APPS_BASE, f);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= cutoff) continue;
      fs.rmSync(p, { force: true });
      removed++; bytes += st.size;
    } catch { /* raced with another cleanup */ }
  }
  return { removed, bytes };
}

async function cleanup(trigger = 'manual') {
  if (cleaning) return { busy: true, run: db.cleanupRuns.latest() };
  const s = getSettings();
  cleaning = true;
  const id = db.cleanupRuns.create({ trigger });
  const lines = [];
  let reclaimed = 0;
  let failed = false;

  const step = async (label, args) => {
    lines.push(`$ docker ${args.join(' ')}`);
    try {
      const out = await run('docker', args);
      lines.push(out.trim() || '(nothing to remove)');
      const m = out.match(/Total reclaimed space:\s*([0-9.]+\s*[a-zA-Z]+)/i);
      if (m) reclaimed += parseSize(m[1]);
    } catch (e) {
      failed = true;
      lines.push(`✗ ${label} failed: ${e.message}`);
    }
    lines.push('');
  };

  try {
    if (s.containers) await step('container prune', ['container', 'prune', '-f']);
    if (s.images) await step('image prune', ['image', 'prune', '-f']);
    if (s.buildCache) await step('builder prune', ['builder', 'prune', '-f']);
    if (s.networks) await step('network prune', ['network', 'prune', '-f']);
    // Volumes are opt-in: a pruned volume is a deleted database.
    if (s.volumes) await step('volume prune', ['volume', 'prune', '-f']);
    if (s.buildLogDays) {
      const t = trimBuildLogs(s.buildLogDays);
      reclaimed += t.bytes;
      lines.push(`$ trim build logs older than ${s.buildLogDays}d`);
      lines.push(`removed ${t.removed} log file(s), ${fmtBytes(t.bytes)}`, '');
    }
    lines.push(`Total reclaimed: ${fmtBytes(reclaimed)}`);
    db.cleanupRuns.finish(id, failed ? 'failed' : 'success', reclaimed, lines.join('\n'));
  } catch (e) {
    db.cleanupRuns.finish(id, 'failed', reclaimed, `${lines.join('\n')}\n✗ ${e.message}`);
  } finally {
    cleaning = false;
    db.cleanupRuns.prune();
    dps.invalidate();
  }
  return { id, run: db.cleanupRuns.get(id) };
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------------------------------------------------------------------
// Scheduler hooks
// ---------------------------------------------------------------------------

// Once a minute: is the cleanup schedule due?
function tick(now) {
  const s = getSettings();
  if (!s.enabled) return;
  if (!cron.matches(s.schedule, now)) return;
  cleanup('schedule').catch((e) => console.error('[maintenance] cleanup failed:', e.message));
}

// Every few minutes: how full is the disk? Records an alert the UI shows, and
// (optionally) triggers a cleanup once per hour while the disk stays over the
// threshold.
async function checkDisk() {
  const s = getSettings();
  let status;
  try { status = await diskStatus(); } catch { return; }
  const worst = status.worst;
  if (!worst) return;

  let alert = null;
  try { alert = JSON.parse(db.kv.get(ALERT_KEY) || 'null'); } catch { /* ignore */ }

  if (worst.percent < s.diskThreshold) {
    if (alert) db.kv.del(ALERT_KEY);   // recovered
    return;
  }
  const since = alert && alert.since ? alert.since : Date.now();
  const lastClean = alert && alert.lastClean ? alert.lastClean : 0;
  let cleaned = lastClean;
  if (s.autoCleanOnThreshold && Date.now() - lastClean > AUTO_CLEAN_COOLDOWN) {
    cleaned = Date.now();
    cleanup('threshold').catch((e) => console.error('[maintenance] threshold cleanup failed:', e.message));
  }
  db.kv.set(ALERT_KEY, JSON.stringify({
    since, lastClean: cleaned, at: Date.now(),
    percent: worst.percent, path: worst.path, threshold: s.diskThreshold, avail: worst.avail,
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = express.Router();

router.get('/status', async (_req, res) => {
  try {
    const s = getSettings();
    const [disk, usage] = await Promise.all([diskStatus(), dockerUsage()]);
    let alert = null;
    try { alert = JSON.parse(db.kv.get(ALERT_KEY) || 'null'); } catch { /* ignore */ }
    const nextAt = s.enabled ? cron.next(s.schedule) : null;
    res.json({
      settings: s,
      disk,
      docker: usage,
      reclaimable: usage.reduce((n, u) => n + u.reclaimableBytes, 0),
      alert,
      running: cleaning,
      nextRun: nextAt ? nextAt.getTime() : null,
      runs: db.cleanupRuns.all(10).map(({ output, ...r }) => r),
      presets: cron.PRESETS,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/settings', (req, res) => {
  const { settings, error } = saveSettings(req.body || {});
  if (error) return res.status(400).json({ error });
  const nextAt = settings.enabled ? cron.next(settings.schedule) : null;
  res.json({ ok: true, settings, nextRun: nextAt ? nextAt.getTime() : null });
});

router.post('/run', async (req, res) => {
  try { res.json(await cleanup((req.body && req.body.trigger) === 'api' ? 'api' : 'manual')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/runs', (_req, res) => res.json({ runs: db.cleanupRuns.all(20).map(({ output, ...r }) => r) }));

router.get('/runs/:id', (req, res) => {
  const r = db.cleanupRuns.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'no such run' });
  res.json({ run: r });
});

function reconcile() { db.cleanupRuns.failStuck(); }

module.exports = {
  maintenanceRouter: router, tickMaintenance: tick, checkDisk, cleanup,
  reconcileMaintenance: reconcile, getSettings, diskStatus, dockerUsage,
};
