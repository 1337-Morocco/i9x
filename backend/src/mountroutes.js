// Storage editor for deployed apps — mounted at /api/mounts.
//
// Lists, creates, edits and removes an app's volumes, host binds and
// panel-managed config files. Changes are recorded immediately but only reach a
// running container when it is recreated, so every mutating route reports
// whether a restart is still pending and /apply performs it.

const express = require('express');
const fs = require('fs');
const db = require('./db');
const mounts = require('./mounts');
const deploy = require('./deployroutes');

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const router = express.Router();

function appOr400(name, res) {
  if (!NAME_RE.test(name || '')) { res.status(400).json({ error: 'invalid app name' }); return null; }
  const app = db.apps.get(name);
  if (!app) { res.status(400).json({ error: 'no such app' }); return null; }
  return app;
}

router.get('/', (req, res) => {
  const app = appOr400(req.query.app, res);
  if (!app) return;
  res.json({ mounts: db.mounts.all(app.name).map(mounts.summarize) });
});

// Full record including the file body — used by the editor.
router.get('/:id', (req, res) => {
  const m = db.mounts.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such mount' });
  res.json({ ...mounts.summarize(m), content: m.type === 'file' ? m.content : '' });
});

router.post('/', (req, res) => {
  const app = appOr400((req.body && req.body.app) || '', res);
  if (!app) return;
  const { mount, error } = mounts.validate(req.body, { app: app.name, existing: db.mounts.all(app.name) });
  if (error) return res.status(400).json({ error });
  const id = db.mounts.create(mount);
  mounts.materialize(app.name);
  res.json({ ok: true, id, restartRequired: true, mount: mounts.summarize(db.mounts.get(id)) });
});

router.post('/:id', (req, res) => {
  const existing = db.mounts.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'no such mount' });
  const app = appOr400(existing.app, res);
  if (!app) return;
  const { mount, error } = mounts.validate(
    { ...req.body, type: (req.body && req.body.type) || existing.type },
    { app: app.name, existing: db.mounts.all(app.name), id: existing.id },
  );
  if (error) return res.status(400).json({ error });
  // Changing a file mount's path leaves the old file behind — drop it first.
  if (existing.type === 'file' && (mount.type !== 'file' || mount.target !== existing.target)) {
    try { fs.rmSync(mounts.filePath(existing), { force: true }); } catch { /* already gone */ }
  }
  db.mounts.update(existing.id, mount);
  mounts.materialize(app.name);
  // Editing a file's contents alone still needs a restart only if the app reads
  // it at boot, but the bind itself is live — say so honestly.
  const contentOnly = existing.type === 'file' && mount.type === 'file' &&
    existing.target === mount.target && !!existing.ro === !!mount.ro;
  res.json({ ok: true, restartRequired: !contentOnly, mount: mounts.summarize(db.mounts.get(existing.id)) });
});

router.delete('/:id', (req, res) => {
  const m = db.mounts.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such mount' });
  mounts.removeOne(m);
  res.json({ ok: true, restartRequired: true });
});

// Recreate the container so mount changes take effect (no rebuild).
router.post('/apply/:app', async (req, res) => {
  const app = appOr400(req.params.app, res);
  if (!app) return;
  try {
    const args = await deploy.recreateContainer(app.name);
    res.json({ ok: true, command: `docker ${args.join(' ')}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { mountRouter: router };
