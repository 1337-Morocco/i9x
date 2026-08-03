// i9x backend — a web terminal onto the REAL machine.
//
// Each WebSocket connection spawns a real bash session running on this host.
// We use `script -qfc bash /dev/null` to get a genuine pseudo-terminal (PTY)
// without any native modules: `script` (util-linux) allocates the PTY, so
// interactive programs (vim, top, colors, tab-completion) all work.
//
// SECURITY: anyone who can open this page gets a full shell as the user
// running this server. It binds to 127.0.0.1 only. Do NOT expose it to a
// network without adding authentication first.

const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { fsRouter } = require('./fsroutes');
const { sysRouter } = require('./sysroutes');
const { dockerRouter } = require('./dockerroutes');
const { wordpressRouter } = require('./wordpressroutes');
const { staticRouter } = require('./staticroutes');
const { deployRouter, deployWebhookRouter, reconcileApps } = require('./deployroutes');
const { dbRouter, reconcileDatabases } = require('./dbroutes');
const { mountRouter } = require('./mountroutes');
const { taskRouter, reconcileTasks } = require('./taskroutes');
const { maintenanceRouter, reconcileMaintenance } = require('./maintenanceroutes');
const { tokenRouter } = require('./apitokens');
const { apiV1Router } = require('./apiv1');
const openapi = require('./openapi');
const scheduler = require('./scheduler');
const { githubRouter } = require('./githubroutes');
const { proxyRouter } = require('./proxyroutes');
const { authRouter, requireAuth, requireSession, sessionForToken } = require('./authroutes');
const { updateRouter, BUILD_VERSION } = require('./updateroutes');
const { publicBaseUrl } = require('./nethost');
const db = require('./db');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default
const SHELL = process.env.SHELL_CMD || 'bash';

const app = express();
// GitHub push webhooks are public (authenticated by a per-app HMAC secret, not
// the session) and must be verified over the raw request bytes — so mount them
// with a raw body parser BEFORE the global JSON parser and the auth guard. This
// lives at /api/deploy/hook (distinct from the authed /api/deploy/webhook config
// routes) so the raw parser never intercepts the JSON config requests.
app.use('/api/deploy/hook', express.raw({ type: '*/*', limit: '8mb' }), deployWebhookRouter);
app.use(express.json({ limit: '8mb' }));
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, name: 'i9x', version: BUILD_VERSION, mode: 'real-pty', shell: SHELL })
);
app.use('/api/auth', authRouter);
app.use('/api/fs', requireAuth, fsRouter);
app.use('/api/sys', requireAuth, sysRouter);
app.use('/api/docker', requireAuth, dockerRouter);
app.use('/api/wordpress', requireAuth, wordpressRouter);
app.use('/api/static', requireAuth, staticRouter);
app.use('/api/deploy', requireAuth, deployRouter);
app.use('/api/mounts', requireAuth, mountRouter);
app.use('/api/db', requireAuth, dbRouter);
app.use('/api/postgres', requireAuth, dbRouter);   // legacy path — same router, defaults to the postgres engine
app.use('/api/tasks', requireAuth, taskRouter);
app.use('/api/maintenance', requireAuth, maintenanceRouter);
app.use('/api/github', requireAuth, githubRouter);
app.use('/api/proxy', requireAuth, proxyRouter);
app.use('/api/update', requireAuth, updateRouter);
// Minting credentials requires a real sign-in — an API token can never create
// another API token.
app.use('/api/tokens', requireSession, tokenRouter);
// The documented, stable automation surface (see openapi.js).
app.use('/api/v1', requireAuth, apiV1Router);
app.get('/api/openapi.json', (req, res) => {
  // Prefer the origin the caller actually reached us on, so the document works
  // behind the reverse proxy without any extra configuration.
  const host = req.get('host');
  res.json(openapi.document(host ? `${req.protocol}://${host}` : publicBaseUrl()));
});

// Serve the built frontend and fall back to index.html for client-side routes
// (anything that isn't an /api path). Look in the configured location, the
// packaged install path, then the source tree — so both `systemctl` and a bare
// `i9x` invocation find the UI.
const publicDir = [
  process.env.I9X_PUBLIC,
  '/usr/lib/i9x/public',
  path.join(__dirname, '..', 'public'),
].filter(Boolean).find((d) => fs.existsSync(d));
if (publicDir) {
  app.use(express.static(publicDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Require a valid auth token (passed as ?token=... on the ws URL).
  let token = null;
  try {
    token = new URL(req.url, 'http://localhost').searchParams.get('token');
  } catch {
    /* ignore */
  }
  const session = sessionForToken(token);
  if (!session) {
    ws.send(Buffer.from('\r\n\x1b[31m[authentication required]\x1b[0m\r\n'));
    ws.close();
    return;
  }

  // Spawn a real login shell inside a PTY, running as the SERVICE user (root).
  // Auth is app-level (email/password), decoupled from Linux users, so every
  // session gets a shell with the service's identity and full access.
  const home = process.env.HOME || '/root';
  const child = spawn('script', ['-qfc', SHELL, '/dev/null'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      TERM: 'xterm-256color',
      COLUMNS: '80',
      LINES: '24',
    },
  });

  // PTY output -> browser (raw bytes as binary frames)
  child.stdout.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d));
  child.stderr.on('data', (d) => ws.readyState === ws.OPEN && ws.send(d));

  child.on('exit', (code) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(Buffer.from(`\r\n\x1b[33m[session ended (${code})]\x1b[0m\r\n`));
      ws.close();
    }
  });

  // Browser input -> PTY.
  // Text frames carry keystrokes; JSON control frames carry resize events.
  ws.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const str = raw.toString();
      if (str.startsWith('\x00CTRL')) {
        // Control message: {"type":"resize","cols":..,"rows":..}
        try {
          const msg = JSON.parse(str.slice(5));
          if (msg.type === 'resize') {
            // Best-effort: `script` doesn't expose TIOCSWINSZ, so we nudge
            // the child via a stty on the controlling terminal env. Programs
            // that read COLUMNS/LINES or SIGWINCH from a real PTY (node-pty)
            // would resize cleanly; here we simply ignore if unsupported.
          }
          return;
        } catch {
          // fall through and treat as normal input
        }
      }
      child.stdin.write(raw);
    } else {
      child.stdin.write(raw);
    }
  });

  ws.on('close', () => child.kill());
});

// Open (and, on first run, create + migrate) the metadata database. Failing
// here isn't fatal — the terminal and file manager work without it — but the
// service managers would be broken, so it is worth a loud warning.
try {
  db.open();
  reconcileApps();
  reconcileTasks();
  reconcileMaintenance();
  reconcileDatabases().catch((e) => console.error(`[db] reconcile failed: ${e.message}`));
  scheduler.start();   // scheduled tasks, Docker cleanup, disk guard
  console.log(`Metadata database: ${db.DB_PATH}`);
} catch (e) {
  console.error(`WARNING: could not open ${db.DB_PATH}: ${e.message}`);
}

server.listen(PORT, HOST, () => {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  console.log(`i9x on http://${HOST}:${PORT}  ws:/ws`);
  console.log('Auth: email + password (app accounts). Shell & filesystem run as the service user.');
  if (root) {
    console.log('Mode: ROOT — full host access. Keep this bound to localhost / behind TLS + a hardened proxy.');
  } else {
    console.log('Mode: UNPRIVILEGED — running as a normal user; host access limited to that user.');
  }
});
