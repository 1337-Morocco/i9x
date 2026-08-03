// Unified app deployment — clone a GitHub repo, auto-detect its framework
// (Next.js / Vite / plain Node), build it in Docker and run it. Mounted at
// /api/deploy. One code path, one `apps` table; the framework only changes the
// Dockerfile, the container's internal port, and whether env is needed at
// runtime. Builds run in the background, streaming to a per-app log.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const db = require('./db');
const dps = require('./dockerps');
const github = require('./github');
const mounts = require('./mounts');
const { publicBaseUrl } = require('./nethost');

const BASE = process.env.I9X_APPS || '/var/lib/i9x/apps';
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const BRANCH_RE = /^[a-zA-Z0-9._/-]{1,100}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FRAMEWORKS_ALLOWED = new Set(['auto', 'next', 'vite', 'node']);

const table = db.apps;
const cname = (app) => `${app.framework}app-${app.name}`;   // matches legacy nextapp-/viteapp- names
const image = (app) => `${app.framework}app-${app.name}`;
const dirFor = (n) => path.join(BASE, n);
const buildLogPath = (n, num) => path.join(BASE, `${n}.build.${num}.log`);
const setState = (n, s) => table.setState(n, s);

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });
}
function spawnToLog(cmd, args, ls, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    child.stdout.on('data', (d) => ls.write(d));
    child.stderr.on('data', (d) => ls.write(d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

function normalizeRepo(repo) {
  if (typeof repo !== 'string') return null;
  repo = repo.trim();
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) return `https://github.com/${repo}.git`;
  if (/^https:\/\/[\w.@:/~+-]+$/.test(repo)) return repo;
  return null;
}
function ownerRepo(url) {
  const m = String(url).match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Env vars — stored as a JSON map, written to .env before the build.
// ---------------------------------------------------------------------------

function normalizeEnv(input) {
  if (input == null || input === '') return { env: {} };
  let pairs;
  if (Array.isArray(input)) pairs = input.map((p) => [p && p.key, p && p.value]);
  else if (typeof input === 'object') pairs = Object.entries(input);
  else return { error: 'env must be an object or array of {key, value}' };
  const env = {};
  for (let [k, v] of pairs) {
    k = String(k == null ? '' : k).trim();
    if (!k) continue;
    if (!ENV_KEY_RE.test(k)) return { error: `Invalid env var name “${k}” — letters, digits and underscores, not starting with a digit.` };
    env[k] = v == null ? '' : String(v);
  }
  return { env };
}
const envOf = (m) => { try { return JSON.parse((m && m.env) || '{}'); } catch { return {}; } };
function writeEnvFile(name, env) {
  const f = path.join(dirFor(name), '.env');
  if (!env || !Object.keys(env).length) { try { fs.unlinkSync(f); } catch { /* none */ } return; }
  const body = Object.entries(env)
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
    .join('\n') + '\n';
  fs.writeFileSync(f, body, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

// Decide the framework from a package.json and a file-existence probe. Order
// matters: SSR frameworks that happen to use Vite must be caught before the
// generic Vite (static) rule.
function detectFromPackage(pkg, has) {
  if (!pkg) return { framework: 'node', reason: 'No package.json — treating as a plain container/Node app.', confident: false };
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const s = Object.values(scripts).join(' ');

  if (deps.next || has('next.config.js') || has('next.config.mjs') || has('next.config.ts') || /\bnext\s+(build|start|dev)/.test(s))
    return { framework: 'next', reason: 'Next.js — detected the “next” dependency / config.' };
  if (deps['@sveltejs/kit']) return { framework: 'node', reason: 'SvelteKit — runs a Node server (use adapter-node).' };
  if (deps['@remix-run/serve'] || deps['@remix-run/node']) return { framework: 'node', reason: 'Remix — runs a Node server.' };
  if (deps['@angular/core']) return { framework: 'node', reason: 'Angular — building; served via its Node output if present.' };
  if (deps.vite || has('vite.config.js') || has('vite.config.ts') || has('vite.config.mjs') || /\bvite\s+build\b/.test(s))
    return { framework: 'vite', reason: 'Vite — static single-page app, served from the build output.' };
  if (deps.express || deps.fastify || deps.koa || deps['@hapi/hapi'] || deps.hono)
    return { framework: 'node', reason: 'Node server — detected an HTTP framework.' };
  if (scripts.start) return { framework: 'node', reason: 'Node — has a start script.', confident: false };
  return { framework: 'node', reason: 'Defaulting to Node.', confident: false };
}

function detectFromDir(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  return detectFromPackage(readPkg(dir), has);
}

// Live detection before cloning: fetch package.json from GitHub. Only sees the
// manifest (not the file tree), which is enough for the UI's preview.
async function detectFromGithub(url) {
  const or = ownerRepo(url);
  if (!or) return { framework: 'auto', reason: 'Not a recognised GitHub URL — will detect during build.', confident: false };
  // Connected account: use the API so private repos detect too.
  if (github.isConnected()) {
    try {
      const pkg = await github.getPackageJson(or);
      if (pkg) return detectFromPackage(pkg, () => false);
    } catch { /* fall through to public fetch */ }
  }
  for (const ref of ['HEAD', 'main', 'master']) {
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${or}/${ref}/package.json`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const pkg = JSON.parse(await r.text());
      return detectFromPackage(pkg, () => false);
    } catch { /* try next ref */ }
  }
  return { framework: 'auto', reason: 'Could not read package.json (private repo?) — will detect during build.', confident: false };
}

// ---------------------------------------------------------------------------
// Package-manager + Dockerfile per framework
// ---------------------------------------------------------------------------

function pm(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return { install: 'corepack enable && pnpm install --frozen-lockfile', run: 'pnpm run', start: 'pnpm start' };
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return { install: 'corepack enable && yarn install --frozen-lockfile', run: 'yarn', start: 'yarn start' };
  return { install: 'npm install', run: 'npm run', start: 'npm start' };
}

function nextDockerfile(dir) {
  const p = pm(dir);
  return `FROM node:20-alpine
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY . .
RUN ${p.install}
RUN ${p.run} build
EXPOSE 3000
CMD ${p.start === 'npm start' ? '["npm","start"]' : p.start === 'yarn start' ? '["yarn","start"]' : '["pnpm","start"]'}
`;
}

function viteDockerfile(dir, app) {
  const p = pm(dir);
  const outDir = (app && app.outDir) || 'dist';
  // NODE_ENV is left unset for install — Vite/plugins are devDependencies and
  // would be skipped under production. Production mode is set for the build only.
  return `FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN ${p.install}
RUN NODE_ENV=production ${p.run} build

FROM nginx:alpine
COPY --from=build /app/${outDir} /usr/share/nginx/html
RUN printf 'server {\\n  listen 80;\\n  server_name _;\\n  root /usr/share/nginx/html;\\n  location / { try_files $uri $uri/ /index.html; }\\n  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }\\n}\\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
`;
}

function nodeDockerfile(dir) {
  const p = pm(dir);
  const pkg = readPkg(dir) || {};
  const hasBuild = !!(pkg.scripts && pkg.scripts.build);
  return `FROM node:20-alpine
WORKDIR /app
ENV PORT=3000 HOST=0.0.0.0 HOSTNAME=0.0.0.0
COPY . .
RUN ${p.install}
${hasBuild ? `RUN NODE_ENV=production ${p.run} build\n` : ''}ENV NODE_ENV=production
EXPOSE 3000
CMD ${p.start === 'npm start' ? '["npm","start"]' : p.start === 'yarn start' ? '["yarn","start"]' : '["pnpm","start"]'}
`;
}

const FRAMEWORKS = {
  next: { port: 3000, runtimeEnv: true, respectDockerfile: true, dockerfile: nextDockerfile },
  vite: { port: 80, runtimeEnv: false, respectDockerfile: false, dockerfile: viteDockerfile },
  node: { port: 3000, runtimeEnv: true, respectDockerfile: true, dockerfile: nodeDockerfile },
};

// ---------------------------------------------------------------------------
// Resource limits — CPU and memory caps, so one runaway container can't take
// the whole machine (and the panel with it) down.
// ---------------------------------------------------------------------------

const MEMORY_RE = /^([0-9]+(?:\.[0-9]+)?)([kmg])$/i;
const MEM_UNIT = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

function normalizeLimits(input) {
  const cpusRaw = String((input && input.cpus) != null ? input.cpus : '').trim();
  const memRaw = String((input && input.memory) != null ? input.memory : '').trim().toLowerCase();
  let cpus = '';
  let memory = '';
  if (cpusRaw) {
    const n = Number(cpusRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 256) return { error: 'CPU limit must be a number of cores between 0.1 and 256 (e.g. 1.5)' };
    cpus = String(n);
  }
  if (memRaw) {
    const m = memRaw.match(MEMORY_RE);
    if (!m) return { error: 'Memory limit looks like 512m, 1.5g or 262144k' };
    if (Number(m[1]) * MEM_UNIT[m[2]] < 6 * 1024 * 1024) return { error: 'Docker requires a memory limit of at least 6m' };
    memory = `${m[1]}${m[2]}`;
  }
  return { limits: { cpus, memory } };
}

function limitArgs(app) {
  const args = [];
  if (app.cpus) args.push('--cpus', app.cpus);
  // Pinning swap to the memory limit stops a capped container from simply
  // swapping past its budget and thrashing the host instead.
  if (app.memory) args.push('--memory', app.memory, '--memory-swap', app.memory);
  return args;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Everything needed to (re)create an app's container: image, published port,
// env file, declared storage and resource caps. Used by builds and by the
// storage/limits editors, so the container is identical however it was started.
function containerRunArgs(app) {
  const conf = FRAMEWORKS[app.framework] || FRAMEWORKS.node;
  const envFile = path.join(dirFor(app.name), '.env');
  const args = ['run', '-d', '--name', cname(app), '--restart', 'unless-stopped', '-p', `${app.port}:${conf.port}`];
  if (conf.runtimeEnv && fs.existsSync(envFile)) args.push('--env-file', envFile);
  args.push(...limitArgs(app));
  mounts.materialize(app.name);
  args.push(...mounts.dockerArgs(app.name));
  args.push(image(app));
  return args;
}

// Recreate the container from the current configuration without rebuilding the
// image. Returns the docker args so callers can echo them.
async function recreateContainer(name) {
  const app = table.get(name);
  if (!app) throw new Error('no such app');
  const args = containerRunArgs(app);
  await run('docker', ['rm', '-f', cname(app)]).catch(() => {});
  await run('docker', args);
  setState(name, 'running');
  dps.invalidate();
  return args;
}

async function startBuild(name, url, branch, port, mode, trigger) {
  const dir = dirFor(name);
  const number = db.builds.nextNumber(name);
  const trig = trigger || (mode === 'create' ? 'create' : 'manual');
  const t0 = Date.now();
  const buildId = db.builds.create({ app: name, number, status: 'building', trigger: trig, started: t0 });
  const ls = fs.createWriteStream(buildLogPath(name, number), { flags: 'w' });
  const w = (s) => ls.write(s);
  try {
    w(`▸ Build #${number}\n`);
    w(`  triggered by ${trig} · ${new Date(t0).toISOString()}\n\n`);

    // Authenticate private-repo git over HTTPS via a header (never written to
    // the checked-out remote or the build log).
    const auth = github.gitAuthArgs();
    if (auth.length) w('  using connected GitHub account for authentication\n');
    w('▸ Clone\n');
    if (mode === 'create') {
      w(`$ git clone --depth 1 ${branch ? `-b ${branch} ` : ''}${url}\n`);
      const args = [...auth, 'clone', '--depth', '1'];
      if (branch) args.push('-b', branch);
      args.push(url, dir);
      await spawnToLog('git', args, ls);
    } else {
      w(`$ git -C ${dir} pull --ff-only\n`);
      await spawnToLog('git', ['-C', dir, ...auth, 'pull', '--ff-only'], ls).catch((e) => w(`  (pull skipped: ${e.message})\n`));
    }

    // Finalise the framework now that we have the files.
    let app = table.get(name);
    let fw = app.framework;
    if (!fw || fw === 'auto') {
      const det = detectFromDir(dir);
      fw = det.framework;
      table.setFramework(name, fw);
      w(`  detected framework: ${fw} — ${det.reason}\n`);
      app = table.get(name);
    } else {
      w(`  framework: ${fw}\n`);
    }
    const conf = FRAMEWORKS[fw] || FRAMEWORKS.node;

    const dockerfilePath = path.join(dir, 'Dockerfile');
    if (!(conf.respectDockerfile && fs.existsSync(dockerfilePath))) fs.writeFileSync(dockerfilePath, conf.dockerfile(dir, app));
    fs.writeFileSync(path.join(dir, '.dockerignore'), 'node_modules\n.git\n.next\ndist\nDockerfile\n');

    const env = envOf(app);
    writeEnvFile(name, env);
    const nEnv = Object.keys(env).length;
    if (nEnv) w(`  injected ${nEnv} environment variable${nEnv === 1 ? '' : 's'}\n`);

    w(`\n▸ Build\n`);
    w(`$ docker build -t ${image(app)} .\n`);
    await spawnToLog('docker', ['build', '-t', image(app), dir], ls);

    await run('docker', ['rm', '-f', cname(app)]).catch(() => {});
    app = table.get(name);   // pick up storage/limits edited while the build ran
    const runArgs = containerRunArgs(app);
    const nMounts = db.mounts.all(name).length;
    if (nMounts) w(`  attaching ${nMounts} mount${nMounts === 1 ? '' : 's'}\n`);
    if (app.cpus || app.memory) w(`  limits: ${app.cpus ? `${app.cpus} CPU${app.memory ? ', ' : ''}` : ''}${app.memory || ''}\n`);
    w(`\n▸ Deploy\n`);
    w(`$ docker ${runArgs.join(' ')}\n`);
    await spawnToLog('docker', runArgs, ls);

    setState(name, 'running');
    db.builds.setStatus(buildId, 'running', Date.now());
    w(`\n✓ Deployed successfully in ${((Date.now() - t0) / 1000).toFixed(1)}s — http://localhost:${port}\n`);
  } catch (e) {
    setState(name, 'failed');
    db.builds.setStatus(buildId, 'failed', Date.now());
    w(`\n✗ BUILD FAILED: ${e.message}\n`);
  } finally {
    ls.end();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = express.Router();

// Live framework detection for the deploy form.
router.get('/detect', async (req, res) => {
  const url = normalizeRepo(req.query.repo);
  if (!url) return res.status(400).json({ error: 'Enter an https git URL or owner/repo' });
  res.json(await detectFromGithub(url));
});

// The app list, shared by the UI route and the versioned API.
async function listApps() {
  const rows = table.all();
  const snap = rows.length ? await dps.snapshot() : { names: new Set() };
  const proxied = rows.length ? db.proxySites.all() : [];
  return rows.map((m) => {
    const dstat = !snap ? 'unknown' : snap.names.has(cname(m)) ? 'running' : 'stopped';
    let status = dstat;
    if (m.state === 'building') status = 'building';
    else if (m.state === 'failed' && dstat !== 'running') status = 'failed';
    // A domain can balance across several backends — it belongs to this app
    // if the app's port is any of them, not just the primary.
    const domains = proxied
      .filter((s) => s.targets.some((t) => t.host === `127.0.0.1:${m.port}` || t.host === `localhost:${m.port}`))
      .map((s) => ({ domain: s.domain, https: !!s.https }));
    return {
      name: m.name, repo: m.repo, branch: m.branch, port: m.port, framework: m.framework, created: m.created,
      url: `http://localhost:${m.port}`, status, envCount: Object.keys(envOf(m)).length, domains, outDir: m.outDir,
      autodeploy: !!m.autodeploy, cpus: m.cpus || '', memory: m.memory || '', mountCount: db.mounts.all(m.name).length,
      container: cname(m),
    };
  });
}

router.get('/apps', async (_req, res) => {
  try { res.json({ apps: await listApps() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/apps', async (req, res) => {
  const { name, repo, branch, port, framework, outDir } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'Name: lowercase letters, digits, hyphens (2–31 chars)' });
  const url = normalizeRepo(repo);
  if (!url) return res.status(400).json({ error: 'Repo must be an https git URL or owner/repo' });
  if (branch && !BRANCH_RE.test(branch)) return res.status(400).json({ error: 'invalid branch' });
  const fw = framework || 'auto';
  if (!FRAMEWORKS_ALLOWED.has(fw)) return res.status(400).json({ error: 'invalid framework' });
  const { env, error } = normalizeEnv(req.body && req.body.env);
  if (error) return res.status(400).json({ error });
  const out = String(outDir || 'dist').trim().replace(/^\.?\//, '').replace(/\/+$/, '') || 'dist';
  if (!/^[a-zA-Z0-9._/-]+$/.test(out) || out.split('/').includes('..')) return res.status(400).json({ error: 'Output directory must be a relative path (e.g. dist)' });

  let p;
  if (port !== undefined && port !== null && String(port) !== '') {
    p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return res.status(400).json({ error: 'Port must be 1024–65535' });
    const owner = db.portOwner(p);
    if (owner) return res.status(400).json({ error: `Port ${p} is already used by the ${owner.kind} “${owner.name}”` });
  } else {
    p = db.freePort();
    if (!p) return res.status(400).json({ error: 'No free port available in 8100–8999' });
  }
  if (table.get(name) || fs.existsSync(dirFor(name))) return res.status(400).json({ error: 'An app with that name already exists' });

  try {
    fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
    table.create({ name, repo: url, branch: branch || '', port: p, framework: fw, state: 'building', env: JSON.stringify(env), outDir: out });
    startBuild(name, url, branch, p, 'create', 'create'); // background (creates the build record + log synchronously)
    res.json({ ok: true, building: true, name, port: p });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/buildlog', (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  const b = req.query.build ? db.builds.get(name, Number(req.query.build)) : db.builds.latest(name);
  let text = '';
  if (b) { try { text = fs.readFileSync(buildLogPath(name, b.number), 'utf8'); } catch { /* ignore */ } }
  res.json({ text, state: b ? b.status : (m.state || 'unknown'), build: b || null });
});

// Build history (newest first).
router.get('/builds', (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  res.json({ builds: db.builds.all(name) });
});

router.post('/action', async (req, res) => {
  const { name, action } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  try {
    if (action === 'start') await run('docker', ['start', cname(m)]);
    else if (action === 'stop') await run('docker', ['stop', cname(m)]);
    else if (action === 'restart') await run('docker', ['restart', cname(m)]);
    else if (action === 'rebuild') { setState(name, 'building'); startBuild(name, m.repo, m.branch, m.port, 'rebuild', 'manual'); }
    else if (action === 'remove') {
      await run('docker', ['rm', '-f', cname(m)]).catch(() => {});
      await run('docker', ['rmi', '-f', image(m)]).catch(() => {});
      fs.rmSync(dirFor(name), { recursive: true, force: true });
      for (const b of db.builds.all(name)) fs.rmSync(buildLogPath(name, b.number), { force: true });
      db.builds.removeApp(name);
      mounts.removeApp(name);
      db.tasks.removeForTarget('app', name);
      table.remove(name);
    } else return res.status(400).json({ error: 'invalid action' });
    dps.invalidate();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  try { res.json({ text: await run('docker', ['logs', '--tail', '300', cname(m)]) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/env', (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  res.json({ env: envOf(m) });
});

router.post('/env', (req, res) => {
  const { name, rebuild } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  const { env, error } = normalizeEnv(req.body && req.body.env);
  if (error) return res.status(400).json({ error });
  table.setEnv(name, JSON.stringify(env));
  if (fs.existsSync(dirFor(name))) writeEnvFile(name, env);
  if (rebuild) { setState(name, 'building'); startBuild(name, m.repo, m.branch, m.port, 'rebuild', 'env'); }
  res.json({ ok: true, rebuilding: !!rebuild });
});

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

router.get('/limits', (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  res.json({ cpus: m.cpus || '', memory: m.memory || '' });
});

// Tightening or changing a cap is applied live with `docker update` (no
// downtime). Clearing one can only be done by recreating the container, which
// we do from the stored config — no rebuild needed.
router.post('/limits', async (req, res) => {
  const { name } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  const { limits, error } = normalizeLimits(req.body);
  if (error) return res.status(400).json({ error });

  const clearing = (m.cpus && !limits.cpus) || (m.memory && !limits.memory);
  table.setLimits(name, limits.cpus, limits.memory);
  const app = table.get(name);
  try {
    const live = await dps.snapshot().then((s) => s && s.names.has(cname(app))).catch(() => false);
    if (!live) return res.json({ ok: true, applied: 'next-start', ...limits });
    if (clearing) {
      await recreateContainer(name);
      return res.json({ ok: true, applied: 'recreated', ...limits });
    }
    const args = ['update'];
    if (limits.cpus) args.push('--cpus', limits.cpus);
    if (limits.memory) args.push('--memory', limits.memory, '--memory-swap', limits.memory);
    if (args.length === 1) return res.json({ ok: true, applied: 'none', ...limits });
    args.push(cname(app));
    await run('docker', args);
    dps.invalidate();
    res.json({ ok: true, applied: 'live', ...limits });
  } catch (e) {
    res.status(400).json({ error: e.message, saved: true, ...limits });
  }
});

// ---------------------------------------------------------------------------
// Auto-deploy on push — GitHub webhook
// ---------------------------------------------------------------------------

const webhookUrlFor = (name) => `${publicBaseUrl()}/api/deploy/hook/${name}`;
const webhookInfo = (m) => ({
  autodeploy: !!m.autodeploy,
  url: webhookUrlFor(m.name),
  secret: m.webhookSecret || '',
  contentType: 'application/json',
  events: 'Just the push event',
  githubConnected: github.isConnected(),
});

// Read the current webhook config for an app.
router.get('/webhook', (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  res.json(webhookInfo(m));
});

// Enable/disable auto-deploy. Enabling mints a webhook secret if none exists;
// disabling keeps the secret so re-enabling reuses the same GitHub webhook.
router.post('/webhook', async (req, res) => {
  const { name, enabled, regenerate } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const m = table.get(name);
  if (!m) return res.status(400).json({ error: 'no such app' });
  const on = !!enabled;
  let secret = m.webhookSecret || '';
  if ((on && !secret) || regenerate) secret = crypto.randomBytes(24).toString('hex');
  table.setAutodeploy(name, on, secret);

  // If a GitHub account is connected, create/update (or remove) the webhook
  // automatically so the user never has to touch GitHub's settings.
  let installed = false, installError = null;
  const or = github.isConnected() ? github.ownerRepo(m.repo) : null;
  if (or) {
    try {
      if (on) { await github.ensureWebhook(or, webhookUrlFor(name), secret); installed = true; }
      else await github.removeWebhook(or, webhookUrlFor(name));
    } catch (e) { installError = e.message; }
  }
  res.json({ ...webhookInfo(table.get(name)), installed, installError });
});

// Public push receiver — NO session auth; authenticated by the per-app HMAC
// secret via GitHub's X-Hub-Signature-256. Mounted with a raw body parser so
// the signature is verified over the exact bytes GitHub signed.
const webhookRouter = express.Router();
webhookRouter.post('/:name', (req, res) => {
  const name = req.params.name;
  if (!NAME_RE.test(name || '')) return res.status(404).json({ error: 'not found' });
  const m = table.get(name);
  if (!m || !m.autodeploy || !m.webhookSecret) return res.status(404).json({ error: 'not found' });

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const sig = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', m.webhookSecret).update(raw).digest('hex');
  const ok = sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'bad signature' });

  const event = req.get('X-GitHub-Event') || '';
  if (event === 'ping') return res.json({ ok: true, pong: true });
  if (event !== 'push') return res.json({ ok: true, ignored: `event ${event}` });

  let payload = {};
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad payload' }); }

  const target = m.branch || (payload.repository && payload.repository.default_branch) || 'main';
  if (payload.ref && payload.ref !== `refs/heads/${target}`) {
    return res.json({ ok: true, ignored: `branch ${payload.ref}` });
  }
  if (m.state === 'building') return res.json({ ok: true, note: 'already building' });

  setState(name, 'building');
  startBuild(name, m.repo, m.branch, m.port, 'rebuild', 'push'); // background
  res.json({ ok: true, building: true });
});

function reconcile() {
  for (const a of table.all()) if (a.state === 'building') table.setState(a.name, 'failed');
  db.builds.failStuck(); // any build interrupted by a restart is no longer running
}

// ---------------------------------------------------------------------------
// Shared helpers for the other subsystems (API v1, scheduled tasks, storage)
// ---------------------------------------------------------------------------

// The Docker container backing an app, or null if it doesn't exist.
function containerFor(name) {
  const m = table.get(name);
  return m ? cname(m) : null;
}

// Kick off a rebuild the same way the UI and webhook do.
function rebuild(name, trigger = 'api') {
  const m = table.get(name);
  if (!m) throw new Error('no such app');
  if (m.state === 'building') return { building: true, note: 'already building' };
  setState(name, 'building');
  startBuild(name, m.repo, m.branch, m.port, 'rebuild', trigger);
  return { building: true, build: db.builds.nextNumber(name) - 1 };
}

async function appAction(name, action) {
  const m = table.get(name);
  if (!m) throw new Error('no such app');
  if (action === 'start') await run('docker', ['start', cname(m)]);
  else if (action === 'stop') await run('docker', ['stop', cname(m)]);
  else if (action === 'restart') await run('docker', ['restart', cname(m)]);
  else throw new Error('invalid action');
  dps.invalidate();
  return { ok: true };
}

module.exports = {
  deployRouter: router, deployWebhookRouter: webhookRouter, reconcileApps: reconcile,
  detectFromPackage, detectFromGithub,
  containerFor, rebuild, appAction, recreateContainer, envOf, listApps, normalizeEnv, buildLogPath,
};
