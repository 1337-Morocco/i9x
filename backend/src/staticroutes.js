// Static website hosting — serves a folder on the machine via an nginx
// container. Mounted at /api/static (root backend). Site records live in
// SQLite so they survive a reboot; the docroot stays on disk.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');
const dps = require('./dockerps');

const router = express.Router();
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const cname = (name) => `websvc-${name}`;

function docker(args, { long = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: long ? 600000 : 30000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });
}


const STARTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>It works!</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;
background:linear-gradient(135deg,#5b1747,#e04f2f);color:#fff}h1{font-size:3rem;margin:0}p{opacity:.8}</style>
</head><body><div style="text-align:center"><h1>It works! 🎉</h1><p>Your static site is live. Replace this file to get started.</p></div></body></html>
`;

router.get('/sites', async (_req, res) => {
  try {
    const rows = db.staticSites.all();
    const snap = rows.length ? await dps.snapshot() : { names: new Set() };
    const sites = rows.map((m) => ({
      name: m.name, port: m.port, root: m.root, created: m.created,
      url: `http://localhost:${m.port}`,
      status: !snap ? 'unknown' : snap.names.has(cname(m.name)) ? 'running' : 'stopped',
    }));
    res.json({ sites });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/sites', async (req, res) => {
  const { name, port, root, createRoot } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'Name: lowercase letters, digits, hyphens (2–31 chars)' });
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return res.status(400).json({ error: 'Port must be 1024–65535' });
  if (typeof root !== 'string' || !root.startsWith('/')) return res.status(400).json({ error: 'Document root must be an absolute path' });
  if (db.staticSites.get(name)) return res.status(400).json({ error: 'A site with that name already exists' });
  const owner = db.portOwner(p);
  if (owner) return res.status(400).json({ error: `Port ${p} is already used by the ${owner.kind} “${owner.name}”` });

  try {
    if (!fs.existsSync(root)) {
      if (!createRoot) return res.status(400).json({ error: 'Folder does not exist (tick “create folder” to make it)' });
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'index.html'), STARTER);
    } else if (createRoot && !fs.existsSync(path.join(root, 'index.html'))) {
      fs.writeFileSync(path.join(root, 'index.html'), STARTER);
    }

    await docker([
      'run', '-d', '--name', cname(name), '--label', 'i9x.static=1', '--restart', 'unless-stopped',
      '-p', `${p}:80`, '-v', `${root}:/usr/share/nginx/html:ro`, 'nginx:alpine',
    ], { long: true });

    db.staticSites.create({ name, port: p, root });
    res.json({ ok: true, name, url: `http://localhost:${p}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/action', async (req, res) => {
  const { name, action } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  if (!db.staticSites.get(name)) return res.status(400).json({ error: 'no such site' });
  try {
    if (action === 'start') await docker(['start', cname(name)]);
    else if (action === 'stop') await docker(['stop', cname(name)]);
    else if (action === 'restart') await docker(['restart', cname(name)]);
    // Removal keeps the docroot files — only the container and the record go.
    else if (action === 'remove') { await docker(['rm', '-f', cname(name)]).catch(() => {}); db.staticSites.remove(name); }
    else return res.status(400).json({ error: 'invalid action' });
    dps.invalidate();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { staticRouter: router };
