# i9x — a server control panel that looks like a desktop

> i9x turns any Linux server into a browser desktop you actually administer
> from: draggable windows over a real bash PTY, a file manager and editor,
> Docker app deploys straight from Git, managed Postgres, MySQL, Redis, Mongo
> and ClickHouse, full nginx vhost editing with TLS, cron jobs, disk guard and
> scoped API tokens. One .deb, one binary, no agent.

A browser **desktop environment** (React) driving the **real host machine**:
draggable windows, a top bar, and a dock, with three real apps.

- 🖳 **Terminal** — a real `bash` PTY. `ls`, `vim`, `top`, colors, tab-completion.
- 📁 **Files** — a real file manager: browse the machine, open/create/rename/delete.
- 📝 **Text Editor** — opens real files, edits, saves to disk (Ctrl+S).

## Architecture

```
Browser (React desktop)
  ├─ Terminal ──WebSocket /ws──▶  bash PTY  (script -qfc bash)
  └─ Files / Editor ──REST /api/fs──▶  real filesystem (fs/promises)
                              Backend: Express + ws
```

- **frontend/** — Vite + React 19. `desktop/` is the window manager; `apps/` are
  the Files/Editor apps; `Terminal.tsx` is the xterm client. Dev server proxies
  `/ws` + `/api` to :3001.
- **backend/** — Express + `ws`.
  - `server.js` — spawns a real bash PTY per WebSocket via the `script` util
    (no native modules / no compiler needed).
  - `fsroutes.js` — REST filesystem API (`/api/fs/list|read|write|mkdir|touch|rename|delete`).
  - `db.js` — SQLite metadata store via built-in `node:sqlite` (no native module,
    so the packaged binary stays self-contained).
  - `deployroutes.js` + `mounts.js` — build and run app containers (env, storage,
    resource caps all funnel through one `containerRunArgs`).
  - `dbengines.js` + `dbroutes.js` — the database driver map and its
    engine-agnostic routes.
  - `apitokens.js`, `apiv1.js`, `openapi.js` — tokens, the versioned API, its spec.
  - `cron.js`, `scheduler.js`, `taskroutes.js`, `maintenanceroutes.js` — everything
    that happens on a timer.

## Platform features

- **Databases** — managed PostgreSQL, MySQL, MariaDB, Redis, Valkey, MongoDB and
  ClickHouse. One container + one named volume per instance, held in
  "provisioning" until the engine actually answers. SQL engines get a table
  browser and query editor; Redis/Valkey/MongoDB get a console. Logical dumps
  download straight from the card. Adding an engine is one entry in
  `backend/src/dbengines.js` — image, ports, env, readiness probe, dump command.
- **API tokens + `/api/v1`** — bearer tokens (`i9x_<id>_<secret>`, stored hashed)
  with `read`/`write` scopes, accepted anywhere a session is. `/api/v1` is the
  stable surface for CI; `GET /api/openapi.json` describes it.

  ```bash
  curl -X POST -H "Authorization: Bearer i9x_1_…" \
    https://panel.example.com/api/v1/apps/my-app/deploy
  ```

  Tokens can't open a shell (`/ws` needs a session) and can't mint more tokens.
- **Scheduled tasks** — cron jobs run inside an app or database container, any
  container, or on the host, with a timeout and a stored run history. The cron
  parser is `backend/src/cron.js`; one in-process ticker (`scheduler.js`) drives
  everything periodic.
- **Cleanup & disk guard** — scheduled `docker prune` (containers, dangling
  images, build cache, networks; volumes strictly opt-in) plus build-log
  trimming, each run reporting what it reclaimed. Disk usage is checked every
  5 minutes and can auto-clean above a threshold.
- **Storage** — per-app Docker volumes, host binds, and config *files* edited in
  the panel: the body lives in the DB, is materialised under
  `/var/lib/i9x/mounts/<app>/` and bind-mounted into the container, so it
  survives rebuilds.
- **Resource limits** — CPU and memory caps per app, applied live with
  `docker update` (clearing a cap recreates the container from its stored config,
  no rebuild).
- **Full nginx configuration** — every reverse-proxy setting for a domain is
  edited in the panel and rendered to a vhost by `backend/src/nginxconf.js`:
  backends and balancing, path rules (proxy / static files / redirect / fixed
  response), HTTPS redirect + HSTS + protocols + HTTP/2, request size, timeouts
  and buffering, forwarded and custom headers, trusted proxies, basic auth,
  IP allow/deny, security headers, gzip, static and response caching, per-IP rate
  limits, per-domain logs, and raw nginx snippets. The panel shows the exact
  generated config, and `nginx -t` runs before anything is kept — a rejected
  config is rolled back to the previous file, so a bad edit can't take the other
  domains down. i9x also owns the TLS block itself now (certbot only issues
  the certificate), so regenerating a vhost never loses HTTPS.

## Where state lives

| What | Where |
|---|---|
| Service records (apps, databases, sites, proxied domains, tasks, mounts, tokens) | `/var/lib/i9x/i9x.db` (SQLite, WAL) |
| Generated configs — `docker-compose.yml`, `nginx.conf`, cloned repos, build logs | `/var/lib/i9x/{wordpress,static,next,apps}/` |
| Database provisioning logs | `/var/lib/i9x/databases/<name>.log` |
| Panel-edited config files mounted into apps | `/var/lib/i9x/mounts/<app>/` |
| nginx vhosts for proxied domains | `/etc/nginx/sites-available/i9x-<domain>` |
| Site content and databases | Docker named volumes / the docroot you chose |

Everything survives a reboot: containers run with `--restart unless-stopped` and
the records are re-read from the DB. Running non-root (dev) the DB falls back to
`~/.local/share/i9x/i9x.db`; override with `I9X_DB`.

Upgrading from a pre-SQLite install needs no action — the old `*.json` sidecars
are imported the first time the DB is created, and left on disk as a backup.
Removing the package does **not** delete `/var/lib/i9x`.

## Run it

```bash
# terminal 1 — backend (real shell, bound to localhost only)
cd backend && npm start

# terminal 2 — frontend
cd frontend && npm run dev
```

Open http://localhost:5173  (over VS Code remote, use the forwarded port).

## ⚠️ Security

The backend gives **full shell access to this machine** as whoever runs it.
It binds to `127.0.0.1` only. **Do not expose it to a network** without adding
authentication (login + per-session authorization) first.

## Roadmap / next steps

- Scheduled database backups to S3 (the dump commands already exist per engine)
- Deploy notifications (Discord/Telegram/email) on build failure, container exit,
  cert expiry, disk alerts
- Health-gated, zero-downtime deploys + rollback to a previous image
- Proper window-resize (swap the `script` PTY for `node-pty` — needs
  `sudo apt install build-essential`; unlocks clean SIGWINCH/resize)
- Multiple tabs / sessions, reconnect handling
- Optional sandboxing (run the shell in a container/namespace per user)
