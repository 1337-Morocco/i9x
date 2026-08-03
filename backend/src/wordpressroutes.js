// Managed WordPress — one-click WordPress stacks (nginx + MariaDB + Redis)
// orchestrated with Docker Compose. Mounted at /api/wordpress (root backend).
//
// Each site lives in its own project directory with a generated
// docker-compose.yml + nginx.conf, run as a Compose project `wp-<name>`; the
// site record itself is kept in SQLite so nothing is lost across reboots. A
// one-shot wp-cli service auto-installs WordPress and the Redis object-cache
// plugin so the site is ready with no manual setup.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');
const dps = require('./dockerps');

const router = express.Router();
const BASE = process.env.I9X_SITES || '/var/lib/i9x/wordpress';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const rand = () => crypto.randomBytes(12).toString('hex');

function run(cmd, args, { long = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: long ? 1200000 : 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

// Detect whether to use `docker compose` (v2) or `docker-compose` (v1).
let COMPOSE = null;
async function composeArgs() {
  if (COMPOSE) return COMPOSE;
  try { await run('docker', ['compose', 'version']); COMPOSE = { cmd: 'docker', pre: ['compose'] }; return COMPOSE; }
  catch { /* try v1 */ }
  await run('docker-compose', ['version']); // throws if missing
  COMPOSE = { cmd: 'docker-compose', pre: [] };
  return COMPOSE;
}
async function compose(project, dir, args, opts) {
  const c = await composeArgs();
  return run(c.cmd, [...c.pre, '-p', project, '-f', path.join(dir, 'docker-compose.yml'), ...args], opts);
}

const proj = (name) => `wp-${name}`;
const dirFor = (name) => path.join(BASE, name);

function nginxConf() {
  return `server {
    listen 80;
    server_name _;
    root /var/www/html;
    index index.php index.html;
    client_max_body_size 64m;

    location / { try_files $uri $uri/ /index.php?$args; }

    location ~ \\.php$ {
        include fastcgi_params;
        fastcgi_pass wordpress:9000;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ { expires 7d; access_log off; }
}
`;
}

function composeYaml({ port, dbPass, dbRoot, title, adminUser, adminPass, adminEmail }) {
  return `services:
  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: "${dbPass}"
      MARIADB_ROOT_PASSWORD: "${dbRoot}"
    volumes:
      - db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]

  wordpress:
    image: wordpress:php8.3-fpm-alpine
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: "${dbPass}"
      WORDPRESS_DB_NAME: wordpress
      WORDPRESS_CONFIG_EXTRA: |
        define('WP_REDIS_HOST', 'redis');
        define('WP_REDIS_PORT', 6379);
        define('WP_CACHE', true);
    volumes:
      - wp:/var/www/html

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    depends_on:
      - wordpress
    ports:
      - "${port}:80"
    volumes:
      - wp:/var/www/html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro

  wpcli:
    image: wordpress:cli-php8.3
    restart: "no"
    user: "33:33"
    profiles: ["setup"]
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - wp:/var/www/html
    entrypoint: ["sh", "-c"]
    command:
      - |
        for i in $$(seq 1 60); do
          if wp core install --url="http://localhost:${port}" --title="${title}" --admin_user="${adminUser}" --admin_password="${adminPass}" --admin_email="${adminEmail}" --skip-email 2>/dev/null; then
            echo "WordPress installed."; break
          fi
          echo "waiting for WordPress files/db ($$i)..."; sleep 5
        done
        # Remove default sample content so the first visit is clean.
        wp post delete 1 2 --force 2>/dev/null || true
        wp comment delete 1 --force 2>/dev/null || true
        # Make a single static Home page the front page — no blog/sample pages.
        HOME_ID=$$(wp post create --post_type=page --post_title='Home' --post_status=publish --porcelain 2>/dev/null)
        wp option update show_on_front page 2>/dev/null || true
        [ -n "$$HOME_ID" ] && wp option update page_on_front $$HOME_ID 2>/dev/null || true
        wp rewrite structure '/%postname%/' --hard 2>/dev/null || true
        wp plugin install redis-cache --activate 2>/dev/null || true
        wp redis enable 2>/dev/null || true
        wp plugin delete akismet hello 2>/dev/null || true
        echo "setup complete."

volumes:
  db:
  wp:
`;
}

// --------- routes ---------

router.get('/sites', async (_req, res) => {
  try {
    const rows = db.wordpress.all();
    // One shared docker snapshot for the whole list, not one probe per site.
    const snap = rows.length ? await dps.snapshot() : { projects: new Set() };
    const sites = rows.map((m) => ({
      name: m.name, title: m.title, port: m.port, adminUser: m.adminUser, created: m.created,
      url: `http://localhost:${m.port}`,
      status: !snap ? 'unknown' : snap.projects.has(proj(m.name)) ? 'running' : 'stopped',
    }));
    res.json({ sites });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/sites', async (req, res) => {
  const { name, title, adminUser, adminPassword, adminEmail, port } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'Name: lowercase letters, digits, hyphens (2–31 chars)' });
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'Title is required' });
  if (!/^[a-zA-Z0-9_.@ -]{2,60}$/.test(adminUser || '')) return res.status(400).json({ error: 'Invalid admin username' });
  if (typeof adminPassword !== 'string' || adminPassword.length < 6) return res.status(400).json({ error: 'Admin password must be ≥ 6 chars' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail || '')) return res.status(400).json({ error: 'Invalid admin email' });
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return res.status(400).json({ error: 'Port must be 1024–65535' });

  const dir = dirFor(name);
  if (db.wordpress.get(name) || fs.existsSync(dir)) return res.status(400).json({ error: 'A site with that name already exists' });
  const owner = db.portOwner(p);
  if (owner) return res.status(400).json({ error: `Port ${p} is already used by the ${owner.kind} “${owner.name}”` });

  try {
    fs.mkdirSync(BASE, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'nginx.conf'), nginxConf());
    fs.writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      composeYaml({ port: p, dbPass: rand(), dbRoot: rand(), title, adminUser, adminPass: adminPassword, adminEmail })
    );
    // Record the site before starting, so a stack that fails half-way is still
    // listed in the UI and can be removed from there.
    db.wordpress.create({ name, title, port: p, adminUser, adminEmail });

    // Start the stack (db/redis/wordpress/nginx — wpcli is a `setup` profile,
    // so it is NOT started here), then run the install/cleanup to completion so
    // the very first visit shows only the Home page (never the install wizard).
    await compose(proj(name), dir, ['up', '-d'], { long: true });
    await compose(proj(name), dir, ['run', '--rm', '-T', 'wpcli'], { long: true });
    res.json({ ok: true, name, url: `http://localhost:${p}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/action', async (req, res) => {
  const { name, action } = req.body || {};
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const dir = dirFor(name);
  if (!db.wordpress.get(name)) return res.status(400).json({ error: 'no such site' });
  try {
    if (action === 'start') await compose(proj(name), dir, ['up', '-d'], { long: true });
    else if (action === 'stop') await compose(proj(name), dir, ['stop']);
    else if (action === 'restart') await compose(proj(name), dir, ['restart']);
    else if (action === 'remove') {
      if (fs.existsSync(dir)) await compose(proj(name), dir, ['down', '-v'], { long: true }).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
      db.wordpress.remove(name);
    } else return res.status(400).json({ error: 'invalid action' });
    dps.invalidate(); // the next list must show the new state immediately
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  const name = req.query.name;
  if (!NAME_RE.test(name || '')) return res.status(400).json({ error: 'invalid name' });
  const dir = dirFor(name);
  if (!db.wordpress.get(name)) return res.status(400).json({ error: 'no such site' });
  try { res.json({ text: await compose(proj(name), dir, ['logs', '--tail', '250', '--no-color']) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { wordpressRouter: router };
