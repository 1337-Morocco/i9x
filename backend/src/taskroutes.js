// Scheduled tasks — cron jobs that run inside a deployed app's container (or a
// database container, any container, or on the host), with a recorded history of
// every execution. Mounted at /api/tasks.
//
// This is what a framework's scheduler needs: `php artisan schedule:run`,
// `python manage.py clearsessions`, `rails runner …` — the command belongs
// inside the app container, not on the host, and its output has to be
// inspectable after the fact.

const express = require('express');
const { spawn } = require('child_process');
const db = require('./db');
const cron = require('./cron');
const deploy = require('./deployroutes');
const dbs = require('./dbroutes');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{1,48}$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const TARGET_TYPES = new Set(['app', 'database', 'container', 'host']);
const MAX_OUTPUT = 64 * 1024;      // per run, stored in the DB
const MAX_TIMEOUT = 3600;          // seconds

// Tasks currently executing, so a slow job never overlaps itself.
const running = new Map();   // taskId -> runId

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Where does this task run? Returns the argv to spawn, or throws with a reason
// the UI can show (e.g. the app was deleted, or its container isn't up).
function commandFor(task) {
  if (task.targetType === 'host') return ['bash', '-lc', task.command];
  let container;
  if (task.targetType === 'app') container = deploy.containerFor(task.target);
  else if (task.targetType === 'database') container = dbs.containerFor(task.target);
  else container = CONTAINER_RE.test(task.target) ? task.target : null;
  if (!container) throw new Error(`no container for ${task.targetType} “${task.target}”`);
  return ['docker', 'exec', container, 'sh', '-lc', task.command];
}

function runTask(taskId, trigger = 'schedule') {
  const task = db.tasks.get(taskId);
  if (!task) return Promise.reject(new Error('no such task'));
  if (running.has(task.id)) return Promise.resolve({ skipped: 'already running', runId: running.get(task.id) });

  const runId = db.taskRuns.create({ taskId: task.id, trigger });
  running.set(task.id, runId);
  db.tasks.markRun(task.id);

  return new Promise((resolve) => {
    let argv;
    try { argv = commandFor(task); }
    catch (e) {
      running.delete(task.id);
      db.taskRuns.finish(runId, 'failed', null, `✗ ${e.message}\n`);
      return resolve({ runId, status: 'failed' });
    }

    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1));
    let out = '';
    let truncated = false;
    const append = (chunk) => {
      if (out.length >= MAX_OUTPUT) { truncated = true; return; }
      out += chunk.toString();
      if (out.length > MAX_OUTPUT) { out = out.slice(0, MAX_OUTPUT); truncated = true; }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.min(task.timeout || 300, MAX_TIMEOUT) * 1000);

    const settle = (status, code) => {
      clearTimeout(timer);
      running.delete(task.id);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const footer = `\n— ${status} in ${secs}s${code == null ? '' : ` (exit ${code})`}${truncated ? ' · output truncated' : ''}\n`;
      db.taskRuns.finish(runId, status, code, out + footer);
      db.taskRuns.prune(task.id);
      resolve({ runId, status });
    };
    child.on('error', (e) => { out += `\n✗ ${e.message}\n`; settle('failed', null); });
    child.on('close', (code) => settle(timedOut ? 'timeout' : code === 0 ? 'success' : 'failed', code));
  });
}

// Called once a minute by the scheduler.
function tick(now) {
  for (const t of db.tasks.enabled()) {
    if (!cron.matches(t.schedule, now)) continue;
    runTask(t.id, 'schedule').catch((e) => console.error(`[tasks] ${t.name}: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const router = express.Router();

function normalize(input, id = null) {
  const body = input || {};   // Express 5 leaves req.body undefined when nothing was sent
  const name = String(body.name || '').trim();
  if (!NAME_RE.test(name)) return { error: 'Name: 2–49 characters (letters, digits, spaces, dashes, underscores)' };
  const clash = db.tasks.byName(name);
  if (clash && clash.id !== id) return { error: 'A task with that name already exists' };

  const targetType = String(body.targetType || 'app');
  if (!TARGET_TYPES.has(targetType)) return { error: 'Target must be app, database, container or host' };

  const target = String(body.target || '').trim();
  if (targetType === 'app' && !db.apps.get(target)) return { error: 'Pick a deployed app' };
  if (targetType === 'database' && !db.databases.get(target)) return { error: 'Pick a managed database' };
  if (targetType === 'container' && !CONTAINER_RE.test(target)) return { error: 'Enter a container name' };

  const command = String(body.command || '').trim();
  if (!command) return { error: 'Enter a command to run' };
  if (command.length > 4000) return { error: 'Command is too long' };

  const schedule = String(body.schedule || '').trim();
  const v = cron.validate(schedule);
  if (!v.ok) return { error: `Schedule: ${v.error}` };

  let timeout = Number(body.timeout || 300);
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > MAX_TIMEOUT) return { error: `Timeout must be 5–${MAX_TIMEOUT} seconds` };

  return { task: { name, targetType, target: targetType === 'host' ? '' : target, command, schedule, timeout, enabled: body.enabled !== false } };
}

function summarize(t) {
  const last = db.taskRuns.latest(t.id);
  const nextAt = t.enabled ? cron.next(t.schedule) : null;
  return {
    ...t,
    enabled: !!t.enabled,
    running: running.has(t.id),
    nextRun: nextAt ? nextAt.getTime() : null,
    lastStatus: last ? last.status : null,
    lastRunId: last ? last.id : null,
    scheduleValid: cron.validate(t.schedule).ok,
  };
}

router.get('/', (_req, res) => {
  res.json({
    tasks: db.tasks.all().map(summarize),
    presets: cron.PRESETS,
    targets: {
      app: db.apps.all().map((a) => a.name),
      database: db.databases.all().map((d) => d.name),
    },
  });
});

router.post('/', (req, res) => {
  const { task, error } = normalize(req.body);
  if (error) return res.status(400).json({ error });
  const id = db.tasks.create(task);
  res.json({ ok: true, task: summarize(db.tasks.get(id)) });
});

router.post('/:id', (req, res) => {
  const existing = db.tasks.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'no such task' });
  const { task, error } = normalize(req.body, existing.id);
  if (error) return res.status(400).json({ error });
  db.tasks.update(existing.id, task);
  res.json({ ok: true, task: summarize(db.tasks.get(existing.id)) });
});

router.post('/:id/toggle', (req, res) => {
  const t = db.tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such task' });
  db.tasks.setEnabled(t.id, !t.enabled);
  res.json({ ok: true, task: summarize(db.tasks.get(t.id)) });
});

// Fire now, regardless of schedule. Returns as soon as the run is recorded so
// the UI can poll the history for output.
router.post('/:id/run', async (req, res) => {
  const t = db.tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such task' });
  try {
    const r = await runTask(t.id, 'manual');
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  const t = db.tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such task' });
  db.tasks.remove(t.id);
  res.json({ ok: true });
});

// Run history, newest first. Output is omitted here and fetched per run.
router.get('/:id/runs', (req, res) => {
  const t = db.tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'no such task' });
  const runs = db.taskRuns.all(t.id, 20).map(({ output, ...r }) => ({ ...r, bytes: (output || '').length }));
  res.json({ runs });
});

router.get('/runs/:runId', (req, res) => {
  const r = db.taskRuns.get(req.params.runId);
  if (!r) return res.status(404).json({ error: 'no such run' });
  res.json({ run: r });
});

// A run that was in flight when i9x restarted can never finish.
function reconcile() { db.taskRuns.failStuck(); }

module.exports = { taskRouter: router, tickTasks: tick, runTask, reconcileTasks: reconcile, summarizeTask: summarize };
