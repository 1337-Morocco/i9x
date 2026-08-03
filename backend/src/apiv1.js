// The stable, documented REST surface: /api/v1.
//
// The /api/* routes the desktop UI calls are free to change with the UI. This
// one is a contract — it's what a GitHub Action, a Terraform provider or an MCP
// server would target, so paths and payload shapes here stay put. Authenticate
// with an API token:
//
//   curl -X POST -H "Authorization: Bearer i9x_1_…" \
//        https://panel.example.com/api/v1/apps/my-app/deploy
//
// The machine-readable description of everything below is served (without auth)
// from /api/openapi.json.

const express = require('express');
const fs = require('fs');
const { execFile } = require('child_process');
const db = require('./db');
const deploy = require('./deployroutes');
const engines = require('./dbengines');
const dbs = require('./dbroutes');
const tasks = require('./taskroutes');
const maintenance = require('./maintenanceroutes');
const { BUILD_VERSION } = require('./updateroutes');

const router = express.Router();
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { if (!res.headersSent) res.status(400).json({ error: e.message }); }
};

function appOr404(req, res) {
  const name = req.params.name;
  if (!NAME_RE.test(name || '')) { res.status(400).json({ error: 'invalid app name' }); return null; }
  const app = db.apps.get(name);
  if (!app) { res.status(404).json({ error: 'no such app' }); return null; }
  return app;
}

// ---- meta ----------------------------------------------------------------

router.get('/version', (_req, res) => res.json({ name: 'i9x', version: BUILD_VERSION, api: 'v1' }));

router.get('/whoami', (req, res) => res.json({
  identity: req.session.email,
  viaToken: !!req.session.apiToken,
  scope: req.session.apiToken ? req.session.apiToken.scope : 'write',
}));

// ---- applications --------------------------------------------------------

router.get('/apps', wrap(async (_req, res) => res.json({ apps: await deploy.listApps() })));

router.get('/apps/:name', wrap(async (req, res) => {
  if (!appOr404(req, res)) return;
  const app = (await deploy.listApps()).find((a) => a.name === req.params.name);
  res.json({ app });
}));

// The endpoint CI actually calls.
router.post('/apps/:name/deploy', wrap(async (req, res) => {
  const app = appOr404(req, res);
  if (!app) return;
  res.json({ ok: true, ...deploy.rebuild(app.name, 'api') });
}));

const LIFECYCLE = new Set(['start', 'stop', 'restart']);

router.post('/apps/:name/:action', wrap(async (req, res) => {
  if (!LIFECYCLE.has(req.params.action)) return res.status(404).json({ error: 'unknown action' });
  const app = appOr404(req, res);
  if (!app) return;
  res.json(await deploy.appAction(app.name, req.params.action));
}));

router.get('/apps/:name/logs', wrap(async (req, res) => {
  const app = appOr404(req, res);
  if (!app) return;
  const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 300, 1), 5000);
  execFile('docker', ['logs', '--tail', String(tail), deploy.containerFor(app.name)], { maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => (err ? res.status(400).json({ error: (stderr || err.message).trim() }) : res.json({ text: stdout })));
}));

router.get('/apps/:name/env', wrap(async (req, res) => {
  const app = appOr404(req, res);
  if (!app) return;
  res.json({ env: deploy.envOf(app) });
}));

// Merge (default) or replace the environment, optionally rebuilding after.
router.put('/apps/:name/env', wrap(async (req, res) => {
  const app = appOr404(req, res);
  if (!app) return;
  const { env, error } = deploy.normalizeEnv((req.body && req.body.env) || {});
  if (error) return res.status(400).json({ error });
  const merged = req.body && req.body.replace ? env : { ...deploy.envOf(app), ...env };
  db.apps.setEnv(app.name, JSON.stringify(merged));
  const rebuilding = !!(req.body && req.body.rebuild);
  if (rebuilding) deploy.rebuild(app.name, 'api');
  res.json({ ok: true, env: merged, rebuilding });
}));

router.get('/apps/:name/deployments', wrap(async (req, res) => {
  const app = appOr404(req, res);
  if (!app) return;
  res.json({ deployments: db.builds.all(app.name) });
}));

router.get('/apps/:name/deployments/:number', wrap(async (req, res) => {
  const app = appOr404(req, res);
  if (!app) return;
  const build = db.builds.get(app.name, Number(req.params.number));
  if (!build) return res.status(404).json({ error: 'no such deployment' });
  let log = '';
  try { log = fs.readFileSync(deploy.buildLogPath(app.name, build.number), 'utf8'); } catch { /* trimmed by cleanup */ }
  res.json({ deployment: build, log });
}));

// ---- databases -----------------------------------------------------------

router.get('/databases', wrap(async (_req, res) => {
  const rows = db.databases.all().map((d) => {
    const e = engines.get(d.engine);
    return {
      name: d.name, engine: d.engine, version: d.version, port: d.port, state: d.state, created: d.created,
      dbName: d.dbName, dbUser: d.dbUser, container: e ? engines.cname(d) : null,
      uri: e ? engines.uri(d, 'localhost') : null,
    };
  });
  res.json({ databases: rows, engines: engines.catalog().map((e) => e.id) });
}));

router.post('/databases/:name/:action', wrap(async (req, res) => {
  if (!LIFECYCLE.has(req.params.action)) return res.status(404).json({ error: 'unknown action' });
  const d = db.databases.get(req.params.name);
  if (!d) return res.status(404).json({ error: 'no such database' });
  execFile('docker', [req.params.action, engines.cname(d)], (err, _o, stderr) =>
    (err ? res.status(400).json({ error: (stderr || err.message).trim() }) : res.json({ ok: true })));
}));

// ---- scheduled tasks -----------------------------------------------------

router.get('/tasks', wrap(async (_req, res) => res.json({ tasks: db.tasks.all().map(tasks.summarizeTask) })));

router.post('/tasks/:id/run', wrap(async (req, res) => {
  const t = db.tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such task' });
  res.json({ ok: true, ...(await tasks.runTask(t.id, 'api')) });
}));

router.get('/tasks/:id/runs', wrap(async (req, res) => {
  const t = db.tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such task' });
  res.json({ runs: db.taskRuns.all(t.id, 20) });
}));

// ---- host / maintenance --------------------------------------------------

// Disk headroom, Docker's reclaimable space and the cleanup schedule — enough
// for an external monitor to alert on without scraping the UI.
router.get('/system', wrap(async (_req, res) => {
  const [disk, docker] = await Promise.all([maintenance.diskStatus(), maintenance.dockerUsage()]);
  const last = db.cleanupRuns.latest();
  res.json({
    version: BUILD_VERSION,
    disk,
    docker,
    reclaimable: docker.reduce((n, u) => n + u.reclaimableBytes, 0),
    cleanup: { settings: maintenance.getSettings(), last: last ? { ...last, output: undefined } : null },
  });
}));

router.post('/maintenance/cleanup', wrap(async (_req, res) => res.json(await maintenance.cleanup('api'))));

module.exports = { apiV1Router: router };
