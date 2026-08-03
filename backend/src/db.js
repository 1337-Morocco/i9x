// Persistent metadata store for i9x services.
//
// Uses node:sqlite (built into Node 24 — no native module, so the SEA binary
// stays self-contained). Everything the UI needs to rebuild its lists after a
// reboot lives here: WordPress sites, static sites, Next.js apps and proxied
// domains. Generated artefacts (docker-compose.yml, nginx.conf, cloned repos,
// build logs) stay on disk because Docker and nginx read them directly.
//
// Existing installs are migrated automatically: the first time the DB is
// created, the old *.json sidecars are imported and left in place as a backup.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// In production the service runs as root and owns /var/lib/i9x. A
// non-root dev run falls back to the user's data dir so it still works.
// Pre-2.0 this all lived under "weblinux". Packaged upgrades are migrated by
// the .deb's postinst; a dev run has no postinst, so fall back to the old path
// when it is the only one that exists.
function legacyPath(p) {
  const old = p.replace(/i9x\.db$/, 'weblinux.db').replace(/(share|lib)\/i9x\//, '$1/weblinux/');
  return old !== p && fs.existsSync(old) && !fs.existsSync(p) ? old : null;
}

function defaultDbPath() {
  if (process.env.I9X_DB) return process.env.I9X_DB;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const p = isRoot
    ? '/var/lib/i9x/i9x.db'
    : path.join(process.env.HOME || '/tmp', '.local', 'share', 'i9x', 'i9x.db');
  return legacyPath(p) || p;
}
const DB_PATH = defaultDbPath();

const WP_BASE = process.env.I9X_SITES || '/var/lib/i9x/wordpress';
const STATIC_BASE = process.env.I9X_STATIC || '/var/lib/i9x/static';
const NEXT_BASE = process.env.I9X_NEXT || '/var/lib/i9x/next';
const PROXY_BASE = process.env.I9X_PROXY || '/var/lib/i9x/proxy';

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
  const fresh = !fs.existsSync(DB_PATH);
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');   // survives an abrupt kill mid-write
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS wordpress_sites (
      name       TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      port       INTEGER NOT NULL,
      admin_user TEXT NOT NULL DEFAULT '',
      admin_email TEXT NOT NULL DEFAULT '',
      created    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS static_sites (
      name    TEXT PRIMARY KEY,
      port    INTEGER NOT NULL,
      root    TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS next_apps (
      name    TEXT PRIMARY KEY,
      repo    TEXT NOT NULL,
      branch  TEXT NOT NULL DEFAULT '',
      port    INTEGER NOT NULL,
      state   TEXT NOT NULL DEFAULT 'unknown',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS apps (
      name      TEXT PRIMARY KEY,
      repo      TEXT NOT NULL,
      branch    TEXT NOT NULL DEFAULT '',
      port      INTEGER NOT NULL,
      framework TEXT NOT NULL DEFAULT 'auto',   -- auto | next | vite | node
      state     TEXT NOT NULL DEFAULT 'unknown',
      env       TEXT NOT NULL DEFAULT '',
      out_dir   TEXT NOT NULL DEFAULT 'dist',
      created   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vite_apps (
      name    TEXT PRIMARY KEY,
      repo    TEXT NOT NULL,
      branch  TEXT NOT NULL DEFAULT '',
      port    INTEGER NOT NULL,
      state   TEXT NOT NULL DEFAULT 'unknown',
      env     TEXT NOT NULL DEFAULT '',
      out_dir TEXT NOT NULL DEFAULT 'dist',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS postgres (
      name    TEXT PRIMARY KEY,
      version TEXT NOT NULL DEFAULT '16',
      db_name TEXT NOT NULL,
      db_user TEXT NOT NULL,
      db_pass TEXT NOT NULL,
      port    INTEGER NOT NULL,
      state   TEXT NOT NULL DEFAULT 'provisioning',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS databases (
      name    TEXT PRIMARY KEY,
      engine  TEXT NOT NULL DEFAULT 'postgres',   -- postgres | mysql | mariadb | redis | valkey | mongodb | clickhouse
      version TEXT NOT NULL DEFAULT '',
      db_name TEXT NOT NULL DEFAULT '',
      db_user TEXT NOT NULL DEFAULT '',
      db_pass TEXT NOT NULL DEFAULT '',
      port    INTEGER NOT NULL,
      state   TEXT NOT NULL DEFAULT 'provisioning',
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT NOT NULL,
      prefix    TEXT NOT NULL,                    -- shown in the UI so a token is recognisable
      hash      TEXT NOT NULL,                    -- sha256 of the secret half; the secret is never stored
      scope     TEXT NOT NULL DEFAULT 'write',    -- read (GET only) | write
      created   INTEGER NOT NULL,
      last_used INTEGER,
      expires   INTEGER                           -- NULL = never
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      target_type TEXT NOT NULL DEFAULT 'app',    -- app | database | container | host
      target      TEXT NOT NULL DEFAULT '',
      command     TEXT NOT NULL,
      schedule    TEXT NOT NULL,                  -- 5-field cron
      enabled     INTEGER NOT NULL DEFAULT 1,
      timeout     INTEGER NOT NULL DEFAULT 300,   -- seconds
      last_run    INTEGER,
      created     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id   INTEGER NOT NULL,
      trigger   TEXT NOT NULL DEFAULT 'schedule', -- schedule | manual | api
      status    TEXT NOT NULL DEFAULT 'running',  -- running | success | failed | timeout
      exit_code INTEGER,
      started   INTEGER NOT NULL,
      finished  INTEGER,
      output    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
    CREATE TABLE IF NOT EXISTS cleanup_runs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger   TEXT NOT NULL DEFAULT 'schedule', -- schedule | manual | threshold | api
      status    TEXT NOT NULL DEFAULT 'running',  -- running | success | failed
      started   INTEGER NOT NULL,
      finished  INTEGER,
      reclaimed INTEGER NOT NULL DEFAULT 0,       -- bytes
      output    TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mounts (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      app     TEXT NOT NULL,
      type    TEXT NOT NULL DEFAULT 'volume',     -- volume | bind | file
      source  TEXT NOT NULL DEFAULT '',           -- volume name, host path, or '' for file mounts
      target  TEXT NOT NULL,                      -- absolute path inside the container
      content TEXT NOT NULL DEFAULT '',           -- file mounts only: the file body, edited from the panel
      ro      INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mounts_app ON mounts(app);
    CREATE TABLE IF NOT EXISTS builds (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      app      TEXT NOT NULL,
      number   INTEGER NOT NULL,
      status   TEXT NOT NULL DEFAULT 'building',   -- building | running | failed
      trigger  TEXT NOT NULL DEFAULT 'manual',     -- create | manual | env | push
      started  INTEGER NOT NULL,
      finished INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_builds_app ON builds(app);
    CREATE TABLE IF NOT EXISTS proxy_sites (
      domain       TEXT PRIMARY KEY,
      target       TEXT NOT NULL,                       -- primary backend (first of the pool)
      targets      TEXT NOT NULL DEFAULT '',            -- JSON [{host, weight, backup}]
      lb_method    TEXT NOT NULL DEFAULT 'round_robin', -- round_robin | least_conn | ip_hash
      max_fails    INTEGER NOT NULL DEFAULT 3,
      fail_timeout INTEGER NOT NULL DEFAULT 10,
      rate         TEXT NOT NULL DEFAULT '',            -- JSON {enabled, rate, unit, burst, nodelay, conns}
      https        INTEGER NOT NULL DEFAULT 0,
      email        TEXT NOT NULL DEFAULT '',
      created      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      email   TEXT PRIMARY KEY,
      name    TEXT NOT NULL DEFAULT '',
      pass    TEXT NOT NULL,          -- scrypt: "<saltHex>:<hashHex>"
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  migrate();
  if (fresh) importJson();
  migrateToUnified();
  migrateToDatabases();
  // Records hold admin emails and site layout — keep them owner-only.
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { fs.chmodSync(f, 0o600); } catch { /* not created yet */ }
  }
  return db;
}

const q = (sql) => open().prepare(sql);

// ---------- lightweight column migrations ----------
// Adds columns to existing tables so upgrading an installed i9x never
// requires a manual SQL step. Each entry is applied only if the column is
// absent, so this is safe to run on every open.
function migrate() {
  const add = (table, col, decl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  add('next_apps', 'env', "TEXT NOT NULL DEFAULT ''");        // JSON map of build+runtime env vars
  add('apps', 'autodeploy', 'INTEGER NOT NULL DEFAULT 0');    // rebuild on GitHub push webhook
  add('apps', 'webhook_secret', "TEXT NOT NULL DEFAULT ''");  // HMAC secret for the push webhook
  add('proxy_sites', 'targets', "TEXT NOT NULL DEFAULT ''");           // JSON [{host, weight, backup}] — the LB pool
  add('proxy_sites', 'lb_method', "TEXT NOT NULL DEFAULT 'round_robin'");
  add('proxy_sites', 'max_fails', 'INTEGER NOT NULL DEFAULT 3');       // passive health check: failures before eviction
  add('proxy_sites', 'fail_timeout', 'INTEGER NOT NULL DEFAULT 10');   // …and how long an evicted backend stays out
  add('proxy_sites', 'rate', "TEXT NOT NULL DEFAULT ''");              // JSON {enabled, rate, unit, burst, nodelay, conns}
  add('proxy_sites', 'settings', "TEXT NOT NULL DEFAULT ''");          // JSON — the full nginx settings document (see nginxconf.js)
  add('apps', 'cpus', "TEXT NOT NULL DEFAULT ''");                     // docker --cpus (e.g. "1.5"); '' = unlimited
  add('apps', 'memory', "TEXT NOT NULL DEFAULT ''");                   // docker --memory (e.g. "512m"); '' = unlimited
}

// One-time fold of the postgres-only table into the multi-engine `databases`
// table. The source table is left in place as a backup; runs once, kv-guarded.
function migrateToDatabases() {
  if (q('SELECT v FROM kv WHERE k = ?').get('migrated_databases')) return;
  db.exec('BEGIN');
  try {
    const ins = q(`INSERT OR IGNORE INTO databases (name, engine, version, db_name, db_user, db_pass, port, state, created)
                   VALUES (?, 'postgres', ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of q('SELECT name, version, db_name, db_user, db_pass, port, state, created FROM postgres').all())
      ins.run(r.name, r.version || '16', r.db_name, r.db_user, r.db_pass, r.port, r.state || 'unknown', r.created);
    q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('migrated_databases', String(Date.now()));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] databases migration failed:', e.message);
  }
}

// One-time fold of the old per-framework tables (next_apps, vite_apps) into the
// unified `apps` table, tagging each with its framework. The source tables are
// left in place as a backup; runs once, guarded by a kv flag.
function migrateToUnified() {
  if (q('SELECT v FROM kv WHERE k = ?').get('migrated_unified_apps')) return;
  db.exec('BEGIN');
  try {
    const ins = q(`INSERT OR IGNORE INTO apps (name, repo, branch, port, framework, state, env, out_dir, created)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of q('SELECT name, repo, branch, port, state, env, created FROM next_apps').all())
      ins.run(r.name, r.repo, r.branch, r.port, 'next', r.state, r.env || '', 'dist', r.created);
    for (const r of q('SELECT name, repo, branch, port, state, env, out_dir, created FROM vite_apps').all())
      ins.run(r.name, r.repo, r.branch, r.port, 'vite', r.state, r.env || '', r.out_dir || 'dist', r.created);
    q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('migrated_unified_apps', String(Date.now()));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] unified-apps migration failed:', e.message);
  }
}

// ---------- one-time migration from the old JSON sidecars ----------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function importJson() {
  let n = 0;
  db.exec('BEGIN');
  try {
    // WordPress: <base>/<name>/site.json
    if (fs.existsSync(WP_BASE)) {
      for (const name of fs.readdirSync(WP_BASE)) {
        const m = readJson(path.join(WP_BASE, name, 'site.json'));
        if (!m || !m.port) continue;
        db.prepare(
          `INSERT OR IGNORE INTO wordpress_sites (name, title, port, admin_user, admin_email, created)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(m.name || name, m.title || name, Number(m.port), m.adminUser || '', m.adminEmail || '', Number(m.created) || Date.now());
        n++;
      }
    }
    // Static / Next / proxy: <base>/<name>.json
    const flat = [
      [STATIC_BASE, (m, name) => db.prepare(
        `INSERT OR IGNORE INTO static_sites (name, port, root, created) VALUES (?, ?, ?, ?)`
      ).run(m.name || name, Number(m.port), m.root || '', Number(m.created) || Date.now())],
      [NEXT_BASE, (m, name) => db.prepare(
        `INSERT OR IGNORE INTO next_apps (name, repo, branch, port, state, created) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(m.name || name, m.repo || '', m.branch || '', Number(m.port), m.state || 'unknown', Number(m.created) || Date.now())],
      [PROXY_BASE, (m, name) => db.prepare(
        `INSERT OR IGNORE INTO proxy_sites (domain, target, https, email, created) VALUES (?, ?, ?, ?, ?)`
      ).run(m.domain || name, m.target || '', m.https ? 1 : 0, m.email || '', Number(m.created) || Date.now())],
    ];
    for (const [base, insert] of flat) {
      if (!fs.existsSync(base)) continue;
      for (const f of fs.readdirSync(base)) {
        if (!f.endsWith('.json') || f.endsWith('.build.log')) continue;
        const m = readJson(path.join(base, f));
        if (!m) continue;
        insert(m, f.replace(/\.json$/, ''));
        n++;
      }
    }
    db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('imported_json_at', String(Date.now()));
    db.exec('COMMIT');
    if (n) console.log(`[db] imported ${n} existing service(s) from JSON into ${DB_PATH}`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[db] JSON import failed (starting empty):', e.message);
  }
}

// ---------- WordPress ----------

const wordpress = {
  all: () => q('SELECT name, title, port, admin_user AS adminUser, admin_email AS adminEmail, created FROM wordpress_sites ORDER BY created').all(),
  get: (name) => q('SELECT name, title, port, admin_user AS adminUser, admin_email AS adminEmail, created FROM wordpress_sites WHERE name = ?').get(name) || null,
  create: (s) => q(
    `INSERT INTO wordpress_sites (name, title, port, admin_user, admin_email, created) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(s.name, s.title, s.port, s.adminUser, s.adminEmail, s.created ?? Date.now()),
  remove: (name) => q('DELETE FROM wordpress_sites WHERE name = ?').run(name),
};

// ---------- Static sites ----------

const staticSites = {
  all: () => q('SELECT name, port, root, created FROM static_sites ORDER BY created').all(),
  get: (name) => q('SELECT name, port, root, created FROM static_sites WHERE name = ?').get(name) || null,
  create: (s) => q('INSERT INTO static_sites (name, port, root, created) VALUES (?, ?, ?, ?)')
    .run(s.name, s.port, s.root, s.created ?? Date.now()),
  remove: (name) => q('DELETE FROM static_sites WHERE name = ?').run(name),
};

// ---------- Next.js apps ----------

const nextApps = {
  all: () => q('SELECT name, repo, branch, port, state, env, created FROM next_apps ORDER BY created').all(),
  get: (name) => q('SELECT name, repo, branch, port, state, env, created FROM next_apps WHERE name = ?').get(name) || null,
  create: (a) => q('INSERT INTO next_apps (name, repo, branch, port, state, env, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.name, a.repo, a.branch || '', a.port, a.state || 'building', a.env || '', a.created ?? Date.now()),
  setState: (name, state) => q('UPDATE next_apps SET state = ? WHERE name = ?').run(state, name),
  setEnv: (name, env) => q('UPDATE next_apps SET env = ? WHERE name = ?').run(env || '', name),
  remove: (name) => q('DELETE FROM next_apps WHERE name = ?').run(name),
};

// ---------- Unified apps (auto-detected: next | vite | node) ----------

const APP_COLS = 'name, repo, branch, port, framework, state, env, out_dir AS outDir, autodeploy, webhook_secret AS webhookSecret, cpus, memory, created';

const apps = {
  all: () => q(`SELECT ${APP_COLS} FROM apps ORDER BY created`).all(),
  get: (name) => q(`SELECT ${APP_COLS} FROM apps WHERE name = ?`).get(name) || null,
  create: (a) => q('INSERT INTO apps (name, repo, branch, port, framework, state, env, out_dir, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.name, a.repo, a.branch || '', a.port, a.framework || 'auto', a.state || 'building', a.env || '', a.outDir || 'dist', a.created ?? Date.now()),
  setState: (name, state) => q('UPDATE apps SET state = ? WHERE name = ?').run(state, name),
  setEnv: (name, env) => q('UPDATE apps SET env = ? WHERE name = ?').run(env || '', name),
  setFramework: (name, framework) => q('UPDATE apps SET framework = ? WHERE name = ?').run(framework, name),
  setAutodeploy: (name, on, secret) => q('UPDATE apps SET autodeploy = ?, webhook_secret = ? WHERE name = ?').run(on ? 1 : 0, secret || '', name),
  setLimits: (name, cpus, memory) => q('UPDATE apps SET cpus = ?, memory = ? WHERE name = ?').run(cpus || '', memory || '', name),
  remove: (name) => q('DELETE FROM apps WHERE name = ?').run(name),
};

// ---------- Vite apps (legacy — superseded by `apps`; kept for migration) ----------

const viteApps = {
  all: () => q('SELECT name, repo, branch, port, state, env, out_dir AS outDir, created FROM vite_apps ORDER BY created').all(),
  get: (name) => q('SELECT name, repo, branch, port, state, env, out_dir AS outDir, created FROM vite_apps WHERE name = ?').get(name) || null,
  create: (a) => q('INSERT INTO vite_apps (name, repo, branch, port, state, env, out_dir, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.name, a.repo, a.branch || '', a.port, a.state || 'building', a.env || '', a.outDir || 'dist', a.created ?? Date.now()),
  setState: (name, state) => q('UPDATE vite_apps SET state = ? WHERE name = ?').run(state, name),
  setEnv: (name, env) => q('UPDATE vite_apps SET env = ? WHERE name = ?').run(env || '', name),
  remove: (name) => q('DELETE FROM vite_apps WHERE name = ?').run(name),
};

// ---------- PostgreSQL databases ----------

const postgres = {
  all: () => q('SELECT name, version, db_name AS dbName, db_user AS dbUser, db_pass AS dbPass, port, state, created FROM postgres ORDER BY created').all(),
  get: (name) => q('SELECT name, version, db_name AS dbName, db_user AS dbUser, db_pass AS dbPass, port, state, created FROM postgres WHERE name = ?').get(name) || null,
  create: (d) => q('INSERT INTO postgres (name, version, db_name, db_user, db_pass, port, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(d.name, d.version || '16', d.dbName, d.dbUser, d.dbPass, d.port, d.state || 'provisioning', d.created ?? Date.now()),
  setState: (name, state) => q('UPDATE postgres SET state = ? WHERE name = ?').run(state, name),
  remove: (name) => q('DELETE FROM postgres WHERE name = ?').run(name),
};

// ---------- Managed databases (multi-engine) ----------
//
// One row per instance, whatever the engine. Everything engine-specific (image,
// ports, env, dump command) lives in dbengines.js — this table only records the
// instance identity and credentials.

const DB_COLS = 'name, engine, version, db_name AS dbName, db_user AS dbUser, db_pass AS dbPass, port, state, created';

const databases = {
  all: () => q(`SELECT ${DB_COLS} FROM databases ORDER BY created`).all(),
  get: (name) => q(`SELECT ${DB_COLS} FROM databases WHERE name = ?`).get(name) || null,
  create: (d) => q('INSERT INTO databases (name, engine, version, db_name, db_user, db_pass, port, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(d.name, d.engine, d.version || '', d.dbName || '', d.dbUser || '', d.dbPass || '', d.port, d.state || 'provisioning', d.created ?? Date.now()),
  setState: (name, state) => q('UPDATE databases SET state = ? WHERE name = ?').run(state, name),
  remove: (name) => q('DELETE FROM databases WHERE name = ?').run(name),
};

// ---------- API tokens ----------
//
// Only the sha256 of the secret half is stored, so a leaked database still
// can't be replayed against the API. `prefix` is the human-recognisable stub.

const apiTokens = {
  all: () => q('SELECT id, name, prefix, scope, created, last_used AS lastUsed, expires FROM api_tokens ORDER BY id DESC').all(),
  get: (id) => q('SELECT id, name, prefix, hash, scope, created, last_used AS lastUsed, expires FROM api_tokens WHERE id = ?').get(Number(id)) || null,
  create: (t) => Number(q('INSERT INTO api_tokens (name, prefix, hash, scope, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .run(t.name, t.prefix, t.hash, t.scope || 'write', t.created ?? Date.now(), t.expires ?? null).lastInsertRowid),
  touch: (id) => q('UPDATE api_tokens SET last_used = ? WHERE id = ?').run(Date.now(), Number(id)),
  remove: (id) => q('DELETE FROM api_tokens WHERE id = ?').run(Number(id)),
};

// ---------- Scheduled tasks ----------

const TASK_COLS = 'id, name, target_type AS targetType, target, command, schedule, enabled, timeout, last_run AS lastRun, created';

const tasks = {
  all: () => q(`SELECT ${TASK_COLS} FROM scheduled_tasks ORDER BY created`).all(),
  get: (id) => q(`SELECT ${TASK_COLS} FROM scheduled_tasks WHERE id = ?`).get(Number(id)) || null,
  byName: (name) => q(`SELECT ${TASK_COLS} FROM scheduled_tasks WHERE name = ?`).get(name) || null,
  enabled: () => q(`SELECT ${TASK_COLS} FROM scheduled_tasks WHERE enabled = 1`).all(),
  create: (t) => Number(q(`INSERT INTO scheduled_tasks (name, target_type, target, command, schedule, enabled, timeout, created)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t.name, t.targetType, t.target || '', t.command, t.schedule, t.enabled === false ? 0 : 1, t.timeout || 300, t.created ?? Date.now()).lastInsertRowid),
  update: (id, t) => q(`UPDATE scheduled_tasks SET name = ?, target_type = ?, target = ?, command = ?, schedule = ?, enabled = ?, timeout = ? WHERE id = ?`)
    .run(t.name, t.targetType, t.target || '', t.command, t.schedule, t.enabled ? 1 : 0, t.timeout || 300, Number(id)),
  setEnabled: (id, on) => q('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(on ? 1 : 0, Number(id)),
  markRun: (id, when) => q('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?').run(when ?? Date.now(), Number(id)),
  remove: (id) => { q('DELETE FROM task_runs WHERE task_id = ?').run(Number(id)); q('DELETE FROM scheduled_tasks WHERE id = ?').run(Number(id)); },
  // Tasks pointing at a service that no longer exists are dropped with it.
  removeForTarget: (targetType, target) => {
    for (const t of q('SELECT id FROM scheduled_tasks WHERE target_type = ? AND target = ?').all(targetType, target)) tasks.remove(t.id);
  },
};

const RUN_COLS = 'id, task_id AS taskId, trigger, status, exit_code AS exitCode, started, finished, output';
const KEEP_RUNS = 50;   // per task — enough for a history view, bounded on disk

const taskRuns = {
  all: (taskId, limit = 20) => q(`SELECT ${RUN_COLS} FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?`).all(Number(taskId), limit),
  get: (id) => q(`SELECT ${RUN_COLS} FROM task_runs WHERE id = ?`).get(Number(id)) || null,
  latest: (taskId) => q(`SELECT ${RUN_COLS} FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1`).get(Number(taskId)) || null,
  create: (r) => Number(q('INSERT INTO task_runs (task_id, trigger, status, started) VALUES (?, ?, ?, ?)')
    .run(Number(r.taskId), r.trigger || 'schedule', 'running', r.started ?? Date.now()).lastInsertRowid),
  finish: (id, status, exitCode, output) => q('UPDATE task_runs SET status = ?, exit_code = ?, finished = ?, output = ? WHERE id = ?')
    .run(status, exitCode == null ? null : Number(exitCode), Date.now(), output || '', Number(id)),
  prune: (taskId) => q(`DELETE FROM task_runs WHERE task_id = ? AND id NOT IN
                        (SELECT id FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ${KEEP_RUNS})`)
    .run(Number(taskId), Number(taskId)),
  failStuck: () => q("UPDATE task_runs SET status = 'failed', finished = ?, output = output || '\n[interrupted by a i9x restart]' WHERE status = 'running'").run(Date.now()),
};

// ---------- Docker cleanup history ----------

const CLEANUP_COLS = 'id, trigger, status, started, finished, reclaimed, output';

const cleanupRuns = {
  all: (limit = 20) => q(`SELECT ${CLEANUP_COLS} FROM cleanup_runs ORDER BY id DESC LIMIT ?`).all(limit),
  get: (id) => q(`SELECT ${CLEANUP_COLS} FROM cleanup_runs WHERE id = ?`).get(Number(id)) || null,
  latest: () => q(`SELECT ${CLEANUP_COLS} FROM cleanup_runs ORDER BY id DESC LIMIT 1`).get() || null,
  create: (r) => Number(q('INSERT INTO cleanup_runs (trigger, status, started) VALUES (?, ?, ?)')
    .run(r.trigger || 'schedule', 'running', r.started ?? Date.now()).lastInsertRowid),
  finish: (id, status, reclaimed, output) => q('UPDATE cleanup_runs SET status = ?, reclaimed = ?, finished = ?, output = ? WHERE id = ?')
    .run(status, Math.round(reclaimed || 0), Date.now(), output || '', Number(id)),
  prune: () => q('DELETE FROM cleanup_runs WHERE id NOT IN (SELECT id FROM cleanup_runs ORDER BY id DESC LIMIT 30)').run(),
  failStuck: () => q("UPDATE cleanup_runs SET status = 'failed', finished = ? WHERE status = 'running'").run(Date.now()),
};

// ---------- app storage (volumes, host binds, panel-edited files) ----------

const MOUNT_COLS = 'id, app, type, source, target, content, ro, created';

const mounts = {
  all: (app) => q(`SELECT ${MOUNT_COLS} FROM mounts WHERE app = ? ORDER BY id`).all(app),
  get: (id) => q(`SELECT ${MOUNT_COLS} FROM mounts WHERE id = ?`).get(Number(id)) || null,
  create: (m) => Number(q('INSERT INTO mounts (app, type, source, target, content, ro, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(m.app, m.type, m.source || '', m.target, m.content || '', m.ro ? 1 : 0, m.created ?? Date.now()).lastInsertRowid),
  update: (id, m) => q('UPDATE mounts SET type = ?, source = ?, target = ?, content = ?, ro = ? WHERE id = ?')
    .run(m.type, m.source || '', m.target, m.content || '', m.ro ? 1 : 0, Number(id)),
  remove: (id) => q('DELETE FROM mounts WHERE id = ?').run(Number(id)),
  removeApp: (app) => q('DELETE FROM mounts WHERE app = ?').run(app),
};

// ---------- Domains / reverse proxy ----------
//
// `target` stays the primary backend (one row, one column) so older installs and
// anything reading a single upstream keep working; `targets` holds the full
// load-balancer pool as JSON and falls back to `target` when it is empty.

const DEFAULT_LB = { method: 'round_robin', maxFails: 3, failTimeout: 10 };
const DEFAULT_RATE = { enabled: false, rate: 60, unit: 'm', burst: 20, nodelay: true, conns: 0 };

const PROXY_COLS = 'domain, target, targets, lb_method, max_fails, fail_timeout, rate, settings, https, email, created';

function parseJson(s, fallback) {
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}

function proxyRow(r) {
  if (!r) return null;
  const targets = parseJson(r.targets, []);
  return {
    domain: r.domain,
    target: r.target,
    targets: Array.isArray(targets) && targets.length ? targets : [{ host: r.target, weight: 1, backup: false }],
    lb: { ...DEFAULT_LB, method: r.lb_method || DEFAULT_LB.method, maxFails: r.max_fails ?? DEFAULT_LB.maxFails, failTimeout: r.fail_timeout ?? DEFAULT_LB.failTimeout },
    rate: { ...DEFAULT_RATE, ...parseJson(r.rate, null) },
    // The full nginx settings document; {} means "everything at its default".
    settings: parseJson(r.settings, {}) || {},
    https: !!r.https,
    email: r.email,
    created: r.created,
  };
}

const proxySites = {
  all: () => q(`SELECT ${PROXY_COLS} FROM proxy_sites ORDER BY created`).all().map(proxyRow),
  get: (domain) => proxyRow(q(`SELECT ${PROXY_COLS} FROM proxy_sites WHERE domain = ?`).get(domain)),
  create: (s) => q(`INSERT INTO proxy_sites (domain, target, targets, lb_method, max_fails, fail_timeout, rate, settings, https, email, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      s.domain, s.target, JSON.stringify(s.targets || []),
      (s.lb || DEFAULT_LB).method, (s.lb || DEFAULT_LB).maxFails, (s.lb || DEFAULT_LB).failTimeout,
      JSON.stringify(s.rate || DEFAULT_RATE), JSON.stringify(s.settings || {}),
      s.https ? 1 : 0, s.email || '', s.created ?? Date.now(),
    ),
  setHttps: (domain, https, email) => q('UPDATE proxy_sites SET https = ?, email = ? WHERE domain = ?')
    .run(https ? 1 : 0, email || '', domain),
  // Load-balancer pool + rate-limit settings, written together after nginx has
  // accepted the regenerated vhost.
  setConfig: (domain, c) => q(`UPDATE proxy_sites
      SET target = ?, targets = ?, lb_method = ?, max_fails = ?, fail_timeout = ?, rate = ? WHERE domain = ?`)
    .run(c.target, JSON.stringify(c.targets || []), c.lb.method, c.lb.maxFails, c.lb.failTimeout, JSON.stringify(c.rate), domain),
  setSettings: (domain, settings) => q('UPDATE proxy_sites SET settings = ? WHERE domain = ?')
    .run(JSON.stringify(settings || {}), domain),
  remove: (domain) => q('DELETE FROM proxy_sites WHERE domain = ?').run(domain),
};

// ---------- build history ----------

const builds = {
  all: (app) => q('SELECT id, app, number, status, trigger, started, finished FROM builds WHERE app = ? ORDER BY number DESC').all(app),
  get: (app, number) => q('SELECT id, app, number, status, trigger, started, finished FROM builds WHERE app = ? AND number = ?').get(app, number) || null,
  latest: (app) => q('SELECT id, app, number, status, trigger, started, finished FROM builds WHERE app = ? ORDER BY number DESC LIMIT 1').get(app) || null,
  nextNumber: (app) => { const r = q('SELECT MAX(number) AS m FROM builds WHERE app = ?').get(app); return (r && r.m ? r.m : 0) + 1; },
  create: (b) => Number(q('INSERT INTO builds (app, number, status, trigger, started) VALUES (?, ?, ?, ?, ?)')
    .run(b.app, b.number, b.status || 'building', b.trigger || 'manual', b.started ?? Date.now()).lastInsertRowid),
  setStatus: (id, status, finished) => q('UPDATE builds SET status = ?, finished = ? WHERE id = ?').run(status, finished ?? null, id),
  failStuck: () => q("UPDATE builds SET status = 'failed', finished = ? WHERE status = 'building'").run(Date.now()),
  removeApp: (app) => q('DELETE FROM builds WHERE app = ?').run(app),
};

// ---------- application users (email + password auth) ----------

const users = {
  count: () => q('SELECT COUNT(*) AS n FROM users').get().n,
  all: () => q('SELECT email, name, created FROM users ORDER BY created').all(),
  get: (email) => q('SELECT email, name, pass, created FROM users WHERE email = ?').get(email) || null,
  create: (u) => q('INSERT INTO users (email, name, pass, created) VALUES (?, ?, ?, ?)')
    .run(u.email, u.name || '', u.pass, u.created ?? Date.now()),
  setPass: (email, pass) => q('UPDATE users SET pass = ? WHERE email = ?').run(pass, email),
  remove: (email) => q('DELETE FROM users WHERE email = ?').run(email),
};

// ---------- key/value store (small settings: GitHub token, flags) ----------

const kv = {
  get: (k) => { const r = q('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; },
  set: (k, v) => q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, String(v)),
  del: (k) => q('DELETE FROM kv WHERE k = ?').run(k),
};

// ---------- cross-service helpers ----------

// Which service (if any) already claims a host port. Now that everything lives
// in one DB we can catch conflicts before Docker fails with a cryptic error.
function portOwner(port) {
  const p = Number(port);
  const hits = [
    ['WordPress site', q('SELECT name FROM wordpress_sites WHERE port = ?').get(p)],
    ['static site', q('SELECT name FROM static_sites WHERE port = ?').get(p)],
    ['app', q('SELECT name FROM apps WHERE port = ?').get(p)],
    ['database', q('SELECT name FROM databases WHERE port = ?').get(p)],
  ];
  for (const [kind, row] of hits) if (row) return { kind, name: row.name };
  return null;
}

// Lowest unclaimed host port in [start, end], skipping ports already owned by
// another i9x service. Lets the Next.js deploy flow pick a port for the
// user instead of making them choose one. Returns null if the range is full.
function freePort(start = 8100, end = 8999) {
  for (let p = start; p <= end; p++) if (!portOwner(p)) return p;
  return null;
}

module.exports = {
  open, wordpress, staticSites, nextApps, viteApps, apps, postgres, databases, builds, proxySites, users,
  apiTokens, tasks, taskRuns, cleanupRuns, mounts, kv, portOwner, freePort, DB_PATH,
};
