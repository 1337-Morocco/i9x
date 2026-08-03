# Architecture

i9x is a browser desktop environment driving a real Linux host. A React frontend
renders windows; an Express backend does the actual work as the service user.

```
Browser (React desktop)
  ├─ Terminal ──WebSocket /ws──▶  bash PTY  (script -qfc bash)
  └─ Apps ──────REST /api/*─────▶ filesystem, Docker, nginx, systemd
```

## Layout

| Path | What lives there |
|---|---|
| `frontend/src/desktop/` | window manager — windows, dock, launchpad, theme, wallpaper |
| `frontend/src/apps/` | one component per service (Files, Databases, Domains, …) |
| `frontend/src/api/` | one typed client per backend route group |
| `backend/src/*routes.js` | HTTP surface |
| `backend/src/` (rest) | services and libraries the routes call |
| `packaging/` | `.deb` build, systemd unit, install/update scripts |

## Backend modules

- **`server.js`** — wires the Express app and the WebSocket server. Spawns a
  real bash PTY per socket via the `script` utility rather than `node-pty`, so
  the build needs no native modules or compiler.
- **`db.js`** — SQLite via the built-in `node:sqlite`. Also chosen to avoid a
  native module, which keeps the packaged binary self-contained.
- **`nginxconf.js`** — renders a vhost from stored settings. Every generated
  config is validated with `nginx -t` before it is kept; a rejected config is
  rolled back to the previous file so a bad edit cannot take other domains down.
- **`dbengines.js`** — the database driver map. Adding an engine is one entry:
  image, ports, env, readiness probe, dump command.
- **`deployroutes.js` + `mounts.js`** — build and run app containers. Env,
  storage and resource caps all funnel through one `containerRunArgs`.
- **`cron.js` + `scheduler.js`** — a dependency-free 5-field cron parser and the
  single in-process ticker that drives everything periodic.
- **`apitokens.js` + `apiv1.js` + `openapi.js`** — hashed bearer tokens, the
  stable `/api/v1` surface, and its generated spec.

## Where state lives

| What | Where |
|---|---|
| Service records (apps, databases, sites, domains, tasks, mounts, tokens) | `/var/lib/i9x/i9x.db` (SQLite, WAL) |
| Generated configs, cloned repos, build logs | `/var/lib/i9x/{wordpress,static,next,apps}/` |
| Database provisioning logs | `/var/lib/i9x/databases/<name>.log` |
| Panel-edited files mounted into apps | `/var/lib/i9x/mounts/<app>/` |
| nginx vhosts | `/etc/nginx/sites-available/i9x-<domain>` |
| Site content and databases | Docker named volumes |

Everything survives a reboot: containers run with `--restart unless-stopped` and
records are re-read from the database on start. Running non-root in development
the database falls back to `~/.local/share/i9x/i9x.db`; override with `I9X_DB`.

## Design constraints

Two constraints explain most of the unusual choices:

1. **No native modules.** i9x ships as a single Node SEA binary. Anything
   requiring a compiler at install time is out — hence `script` instead of
   `node-pty` and `node:sqlite` instead of `better-sqlite3`.
2. **Runs offline.** Servers routinely have no outbound internet, so there are
   no CDN fonts, no runtime package downloads, and no phone-home.

## Security model

The backend has full shell access to the machine as whoever runs it. It binds to
`127.0.0.1` by default; `packaging/get.sh` optionally fronts it with nginx over
TLS. API tokens are scoped `read`/`write`, stored hashed, and deliberately
cannot open a shell (`/ws` requires a session) or mint further tokens.

See [`SECURITY.md`](../SECURITY.md) for reporting a vulnerability.
