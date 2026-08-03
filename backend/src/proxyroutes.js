// Reverse proxy + domains + auto-HTTPS, using the host's nginx + certbot.
// Mounted at /api/proxy (root backend). Maps a domain to a local target and,
// optionally, obtains a Let's Encrypt certificate via `certbot --nginx`.

const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const db = require('./db');
const nginxconf = require('./nginxconf');

const router = express.Router();
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](-*[a-z0-9])*\.)+[a-z]{2,}$/i;

// Suffixes Let's Encrypt will never issue for — catch them before we burn an
// ACME failed-validation attempt.
const RESERVED_TLDS = new Set(['local', 'localhost', 'test', 'invalid', 'example', 'internal', 'lan', 'home', 'arpa', 'localdomain']);

// Debian/Ubuntu layout if present, else conf.d. The env overrides exist so a
// non-root dev run can point the whole thing at a scratch directory.
const SITES_AV = process.env.I9X_SITES_AVAILABLE || '/etc/nginx/sites-available';
const SITES_EN = process.env.I9X_SITES_ENABLED || '/etc/nginx/sites-enabled';
const useSites = () => fs.existsSync(SITES_AV) && fs.existsSync(SITES_EN);
const confPath = (domain) => (useSites() ? path.join(SITES_AV, `i9x-${domain}`) : path.join('/etc/nginx/conf.d', `i9x-${domain}.conf`));
const linkPath = (domain) => path.join(SITES_EN, `i9x-${domain}`);

function run(cmd, args, { long = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: long ? 180000 : 20000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)
    );
  });
}

// A bare port -> 127.0.0.1:PORT; host:port passes through.
function normalizeTarget(t) {
  t = String(t || '').trim();
  if (/^\d{1,5}$/.test(t)) return `127.0.0.1:${t}`;
  if (/^[a-zA-Z0-9_.-]+:\d{1,5}$/.test(t)) return t;
  return null;
}

// ---------------------------------------------------------------------------
// Load balancing + rate limiting
//
// Both are plain nginx features, so the whole feature is codegen: a pool
// becomes an `upstream` block, a rate limit becomes a `limit_req_zone` plus a
// `limit_req` in the location. Zone and upstream names are derived from the
// domain so two sites never collide — they share nginx's http context.
// ---------------------------------------------------------------------------

const LB_METHODS = new Set(['round_robin', 'least_conn', 'ip_hash']);
const MAX_BACKENDS = 16;

const clamp = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// i9x_app_example_com — a valid nginx identifier, unique per domain.
const zoneBase = (domain) => `i9x_${domain.replace(/[^a-z0-9]+/gi, '_')}`;

// Accepts either the legacy `target` (single string) or `targets` (the pool).
function parseTargets(body) {
  const raw = Array.isArray(body.targets) && body.targets.length ? body.targets : [body.target];
  const out = [];
  for (const t of raw) {
    const host = normalizeTarget(typeof t === 'string' ? t : t && t.host);
    if (!host) throw new Error('Each backend must be a port (e.g. 8100) or host:port');
    out.push({ host, weight: clamp((t && t.weight) ?? 1, 1, 100, 1), backup: !!(t && t.backup) });
  }
  if (!out.length) throw new Error('Add at least one backend');
  if (out.length > MAX_BACKENDS) throw new Error(`At most ${MAX_BACKENDS} backends`);
  const seen = new Set();
  for (const t of out) {
    if (seen.has(t.host)) throw new Error(`${t.host} is listed twice`);
    seen.add(t.host);
  }
  if (out.every((t) => t.backup)) throw new Error('At least one backend must be a primary, not a backup');
  return out;
}

function parseLb(body, targets) {
  const b = body.lb || {};
  const method = LB_METHODS.has(b.method) ? b.method : 'round_robin';
  // nginx refuses `backup` inside an ip_hash upstream.
  if (method === 'ip_hash' && targets.some((t) => t.backup)) throw new Error('IP hash cannot be combined with backup backends');
  return { method, maxFails: clamp(b.maxFails ?? 3, 0, 100, 3), failTimeout: clamp(b.failTimeout ?? 10, 1, 3600, 10) };
}

function parseRate(body) {
  const r = body.rate || {};
  const off = { enabled: false, rate: 60, unit: 'm', burst: 20, nodelay: true, conns: 0 };
  if (!r.enabled) return off;
  const unit = r.unit === 's' ? 's' : 'm';
  return {
    enabled: true,
    unit,
    // nginx only understands whole requests per second/minute.
    rate: clamp(r.rate ?? (unit === 's' ? 10 : 60), 1, 1000000, unit === 's' ? 10 : 60),
    burst: clamp(r.burst ?? 0, 0, 100000, 0),
    nodelay: r.nodelay !== false,
    conns: clamp(r.conns ?? 0, 0, 65535, 0),
  };
}

function upstreamBlock(name, targets, lb) {
  const lines = [`upstream ${name} {`];
  if (lb.method === 'least_conn') lines.push('    least_conn;');
  if (lb.method === 'ip_hash') lines.push('    ip_hash;');
  for (const t of targets) {
    const opts = [];
    if (t.weight > 1) opts.push(`weight=${t.weight}`);
    // max_fails=0 disables the passive health check entirely.
    opts.push(`max_fails=${lb.maxFails}`, `fail_timeout=${lb.failTimeout}s`);
    if (t.backup) opts.push('backup');
    lines.push(`    server ${t.host} ${opts.join(' ')};`);
  }
  lines.push('}');
  return lines.join('\n');
}

// The vhost is rendered by nginxconf.js from the domain's full settings
// document. `serverBlock` stays as the entry point (and as the fallback for the
// handful of legacy call sites that only know about targets/lb/rate).
function serverBlock(domain, site) {
  return nginxconf.render(domain, {
    targets: site.targets,
    lb: site.lb || parseLb({}, site.targets),
    rate: site.rate || parseRate({}),
    settings: site.settings || {},
  });
}

// Kept for reference/tests: the minimal block i9x generated before the
// full settings document existed.
function basicServerBlock(domain, site) {
  const base = zoneBase(domain);
  const rate = site.rate || parseRate({});
  const lb = site.lb || parseLb({}, site.targets);
  const head = [];
  if (rate.enabled) {
    head.push(`limit_req_zone $binary_remote_addr zone=${base}_rq:10m rate=${rate.rate}r/${rate.unit};`);
    if (rate.conns > 0) head.push(`limit_conn_zone $binary_remote_addr zone=${base}_cn:10m;`);
  }

  const limits = [];
  if (rate.enabled) {
    limits.push(`        limit_req zone=${base}_rq${rate.burst > 0 ? ` burst=${rate.burst}` : ''}${rate.burst > 0 && rate.nodelay ? ' nodelay' : ''};`);
    limits.push('        limit_req_status 429;');
    if (rate.conns > 0) {
      limits.push(`        limit_conn ${base}_cn ${rate.conns};`);
      limits.push('        limit_conn_status 429;');
    }
  }

  return `# Managed by i9x — regenerated whenever this domain is reconfigured.
${head.length ? `${head.join('\n')}\n\n` : ''}${upstreamBlock(`${base}_up`, site.targets, lb)}

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
${limits.length ? `${limits.join('\n')}\n` : ''}        proxy_pass http://${base}_up;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_next_upstream error timeout http_502 http_503 http_504;
    }
}
`;
}

async function reloadNginx() {
  await run('nginx', ['-t']);
  await run('systemctl', ['reload', 'nginx']).catch(() => run('nginx', ['-s', 'reload']));
}

// Write the vhost and enable it, rolling back to whatever was there before if
// nginx rejects the result — a bad edit must never leave nginx unable to reload
// and take every other domain down with it.
async function writeVhost(domain, site) {
  const file = confPath(domain);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  // The basic-auth file has to exist before nginx tests a config referencing it.
  if (site.settings) {
    try { nginxconf.writeAuthFile(domain, nginxconf.normalize(site.settings)); }
    catch (e) { throw new Error(e.message); }
  }
  fs.writeFileSync(file, serverBlock(domain, site));
  if (useSites()) {
    try { fs.unlinkSync(linkPath(domain)); } catch { /* not linked yet */ }
    fs.symlinkSync(file, linkPath(domain));
  }
  try {
    await reloadNginx();
  } catch (e) {
    if (previous === null) {
      try { fs.unlinkSync(linkPath(domain)); } catch { /* */ }
      try { fs.unlinkSync(file); } catch { /* */ }
    } else {
      fs.writeFileSync(file, previous);
    }
    await reloadNginx().catch(() => {});
    throw new Error(`nginx rejected the configuration: ${explainNginx(e.message)}`);
  }
}

// nginx -t output is one useful line buried in a stack of paths.
function explainNginx(raw) {
  const line = String(raw || '').split('\n').map((s) => s.trim())
    .filter((s) => /\[emerg\]|\[error\]/i.test(s)).pop();
  return (line || String(raw || '').trim().split('\n').pop() || 'unknown error')
    .replace(/^nginx: /, '').replace(/\s*\(\d+: .*\)$/, '');
}

// ---------------------------------------------------------------------------
// Let's Encrypt pre-flight
//
// HTTP-01 validation only works if the domain resolves to THIS server and port
// 80 is reachable. Checking first turns the most common failure into a clear
// "add this DNS record" instruction instead of a wall of certbot log, and it
// avoids spending ACME's failed-validation budget (5/hostname/hour).
// ---------------------------------------------------------------------------

let ipCache = null;
let ipCachedAt = 0;

async function publicIp() {
  if (ipCache && Date.now() - ipCachedAt < 5 * 60 * 1000) return ipCache;
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const t = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) { ipCache = t; ipCachedAt = Date.now(); return t; }
    } catch { /* try the next provider */ }
  }
  return null;
}

// The record name to create at the DNS provider: "go" for go.example.com,
// "@" for the apex. A rough guess for multi-part suffixes (.co.uk), but it is
// only ever shown as a hint next to the full domain.
function recordName(domain) {
  const labels = domain.split('.');
  return labels.length <= 2 ? '@' : labels.slice(0, -2).join('.');
}

// level: 'ok' (go ahead) | 'warn' (probably fine — proxied DNS) | 'error'
async function precheck(domain) {
  const out = { domain, serverIp: null, a: [], aaaa: [], level: 'ok', code: 'ok', message: '', hint: '' };
  if (!DOMAIN_RE.test(domain || '')) {
    return { ...out, level: 'error', code: 'syntax', message: 'That is not a valid domain name.', hint: 'Use something like app.example.com.' };
  }
  const tld = domain.split('.').pop().toLowerCase();
  if (RESERVED_TLDS.has(tld)) {
    return { ...out, level: 'error', code: 'reserved', message: `“.${tld}” is a reserved suffix — Let’s Encrypt only issues certificates for public domains.`, hint: 'Use a domain you own under a real suffix (.com, .club, .dev …).' };
  }

  const [ip, a, aaaa] = await Promise.all([
    publicIp(),
    dns.resolve4(domain).catch(() => []),
    dns.resolve6(domain).catch(() => []),
  ]);
  out.serverIp = ip; out.a = a; out.aaaa = aaaa;

  if (!a.length && !aaaa.length) {
    // Distinguish "you haven't added the record yet" from "that TLD does not
    // exist" — a registry always has NS records, a made-up suffix never does.
    const tldExists = await dns.resolveNs(tld).then((n) => n.length > 0).catch(() => false);
    if (!tldExists) {
      return {
        ...out, level: 'error', code: 'badtld',
        message: `“.${tld}” is not a real top-level domain, so no certificate can be issued for ${domain}.`,
        hint: 'Check the spelling, or use a domain you actually own.',
      };
    }
    return {
      ...out, level: 'error', code: 'nodns',
      message: `${domain} has no DNS record yet, so Let’s Encrypt cannot reach it.`,
      hint: ip
        ? `At your DNS provider add an A record:  name “${recordName(domain)}”  →  ${ip}  — then wait a minute and try again.`
        : `Add an A record for ${domain} pointing at this server’s public IP.`,
    };
  }
  if (ip && a.length && !a.includes(ip)) {
    return {
      ...out, level: 'warn', code: 'mismatch',
      message: `${domain} points to ${a.join(', ')}, but this server’s public IP is ${ip}.`,
      hint: `That is normal behind Cloudflare or another proxy — HTTPS will still work. Otherwise change the A record “${recordName(domain)}” to ${ip}.`,
    };
  }
  return {
    ...out,
    message: ip && a.includes(ip)
      ? `${domain} points at this server (${ip}). Ready for HTTPS.`
      : `${domain} resolves (${[...a, ...aaaa].join(', ')}). Ready to try HTTPS.`,
  };
}

// Turn certbot's output into one actionable sentence, keeping the raw log for
// the "show details" toggle.
function explainCertbot(raw) {
  const t = String(raw || '');
  const detail = t.trim().slice(-4000);
  const say = (reason) => ({ reason, detail });

  if (/does not end with a valid public suffix/i.test(t)) return say('That domain doesn’t end in a real public suffix, so no certificate can be issued for it.');
  if (/NXDOMAIN/i.test(t)) return say('Let’s Encrypt could not resolve the domain — the DNS record is missing or hasn’t propagated yet.');
  if (/DNS problem/i.test(t)) return say('Let’s Encrypt hit a DNS problem resolving the domain.');
  if (/Timeout during connect/i.test(t)) return say('Let’s Encrypt could not reach this server on port 80. Open ports 80 and 443 in the firewall — and in your cloud security group or router if there is one.');
  if (/Connection refused/i.test(t)) return say('Port 80 refused the connection — nginx isn’t reachable from the internet.');
  if (/too many certificates|too many failed authorizations|rateLimited|rate limit/i.test(t)) return say('Let’s Encrypt rate limit reached for this domain. Wait an hour (failed attempts) or a week (5 duplicate certificates) before retrying.');
  if (/Invalid response|unauthorized|Incorrect validation certificate/i.test(t)) return say('The validation file wasn’t served correctly — another site or vhost is answering for this domain on port 80.');
  if (/could not be found|not installed|No module named/i.test(t)) return say('certbot’s nginx plugin is missing. Install it with: sudo apt-get install -y python3-certbot-nginx');
  if (/Permission denied|Either run as root/i.test(t)) return say('certbot needs root — start i9x with sudo, or via: sudo systemctl start i9x');

  const line = t.split('\n').map((s) => s.trim()).filter((s) => s && !/^(Saving debug log|Requesting a certificate)/i.test(s)).pop();
  return say(line || 'certbot failed.');
}

async function obtainCert(domain, email) {
  await run('certbot', ['--nginx', '-d', domain, '--non-interactive', '--agree-tos', '-m', email, '--redirect'], { long: true });
}

// Regenerating a vhost throws away the `listen 443` / `ssl_certificate` lines
// certbot injected, so an HTTPS domain has to have them put back. `certbot
// install` reuses the certificate already on disk — no ACME request, no rate
// limit spent.
async function reinstallCert(domain, email) {
  try {
    await run('certbot', ['install', '--cert-name', domain, '--nginx', '--non-interactive', '--redirect'], { long: true });
  } catch (e) {
    if (!email) throw e;
    // Older certbot builds without a usable `install` path: re-run the full
    // plugin, keeping the existing certificate unless it is near expiry.
    await run('certbot', ['--nginx', '-d', domain, '--non-interactive', '--agree-tos', '-m', email, '--redirect', '--keep-until-expiring'], { long: true });
  }
  await reloadNginx();
}

// `nginx -v` prints to stderr as "nginx version: nginx/1.24.0".
async function nginxVersion() {
  try {
    const out = await run('nginx', ['-v']).catch((e) => e.message);
    const m = String(out).match(/nginx\/(\d+\.\d+\.\d+)/);
    if (m) { nginxconf.setNginxVersion(m[1]); return m[1]; }
  } catch { /* not installed */ }
  return null;
}
nginxVersion();   // warm at startup so the first render picks the right HTTP/2 form

// The settings schema and its defaults, for the configuration UI.
router.get('/defaults', (_req, res) => res.json({ defaults: nginxconf.DEFAULTS }));

router.get('/status', async (_req, res) => {
  const out = { nginx: false, running: false, certbot: false, autoRenew: false, publicIp: null, version: null };
  try { await run('nginx', ['-v']); out.nginx = true; } catch { /* not installed */ }
  out.version = await nginxVersion();
  if (out.version) out.nginx = true;
  try { const s = await run('systemctl', ['is-active', 'nginx']); out.running = s.trim() === 'active'; } catch { /* not running */ }
  try { await run('certbot', ['--version']); out.certbot = true; } catch { /* no certbot */ }
  // Renewal is what keeps certificates alive after 90 days.
  try { const s = await run('systemctl', ['is-enabled', 'certbot.timer']); out.autoRenew = s.trim() === 'enabled'; } catch { /* no timer */ }
  out.publicIp = await publicIp();
  res.json(out);
});

// Check a domain's DNS before we touch nginx or certbot. Used live by the form.
router.get('/precheck', async (req, res) => {
  try { res.json(await precheck(String(req.query.domain || '').trim().toLowerCase())); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Parse `certbot certificates` into { name, domains, expiry, days, valid }.
function parseCertificates(out) {
  const certs = [];
  let cur = null;
  for (const line of String(out).split('\n')) {
    const name = line.match(/^\s*Certificate Name:\s*(.+?)\s*$/);
    if (name) { cur = { name: name[1], domains: [], expiry: null, days: null, valid: false }; certs.push(cur); continue; }
    if (!cur) continue;
    const dom = line.match(/^\s*Domains:\s*(.+?)\s*$/);
    if (dom) { cur.domains = dom[1].split(/\s+/); continue; }
    const exp = line.match(/^\s*Expiry Date:\s*([\d-]+ [\d:]+[^\s(]*)\s*\(([A-Z]+)([^)]*)\)/i);
    if (exp) {
      cur.expiry = exp[1];
      cur.valid = exp[2].toUpperCase() === 'VALID';
      const days = exp[3].match(/(\d+)\s*day/i);
      cur.days = days
        ? Number(days[1])
        : Math.max(0, Math.round((new Date(exp[1].replace(' ', 'T')) - Date.now()) / 86400000));
    }
  }
  return certs;
}

// Issued certificates and how long they have left.
router.get('/certs', async (_req, res) => {
  try {
    res.json({ certs: parseCertificates(await run('certbot', ['certificates'])) });
  } catch (e) {
    res.status(400).json({ error: explainCertbot(e.message).reason, certs: [] });
  }
});

// Force a renewal now (certbot.timer normally handles this at 30 days left).
router.post('/renew', async (req, res) => {
  const { domain } = req.body || {};
  if (!DOMAIN_RE.test(domain || '')) return res.status(400).json({ error: 'invalid domain' });
  if (!db.proxySites.get(domain)) return res.status(400).json({ error: 'no such domain' });
  try {
    const out = await run('certbot', ['renew', '--cert-name', domain, '--non-interactive'], { long: true });
    await reloadNginx().catch(() => {});
    res.json({ ok: true, output: out.trim().slice(-2000) });
  } catch (e) {
    const { reason, detail } = explainCertbot(e.message);
    res.status(400).json({ error: reason, detail });
  }
});

// A short summary of the non-default settings, so a card can show what is on
// without shipping the whole document.
function settingsBadges(m) {
  let s;
  try { s = nginxconf.normalize(m.settings); } catch { return []; }
  const out = [];
  if (m.https && s.tls.forceHttps) out.push('force https');
  if (s.tls.hsts.enabled) out.push('hsts');
  if (s.security.basicAuth.enabled && s.security.basicAuth.users.length) out.push('password');
  if (s.security.allow.length) out.push('ip allow-list');
  if (s.perf.cache.enabled) out.push('cache');
  if (s.locations.length) out.push(`${s.locations.length} rule${s.locations.length === 1 ? '' : 's'}`);
  if (s.custom.server || s.custom.location) out.push('custom');
  if (!s.websocket) out.push('no websockets');
  return out;
}

const publicSite = (m) => ({
  domain: m.domain, target: m.target, targets: m.targets, lb: m.lb, rate: m.rate, https: m.https, created: m.created,
  badges: settingsBadges(m), maxBodySize: (() => { try { return nginxconf.normalize(m.settings).request.maxBodySize; } catch { return ''; } })(),
});

// ---------------------------------------------------------------------------
// Full nginx settings — read, preview, apply
// ---------------------------------------------------------------------------

// The browser never receives password hashes, so a saved user comes back as
// { user, hasPassword } and must keep its stored hash unless a new password was
// typed. Same for anything else that is write-only.
function mergeSecrets(incoming, stored) {
  const next = JSON.parse(JSON.stringify(incoming || {}));
  const oldUsers = ((stored && stored.security && stored.security.basicAuth && stored.security.basicAuth.users) || []);
  const auth = next.security && next.security.basicAuth;
  if (auth && Array.isArray(auth.users)) {
    auth.users = auth.users.map((u) => {
      if (u && (u.password || u.hash)) return u;
      const prev = oldUsers.find((o) => o.user === (u && u.user));
      return prev ? { user: prev.user, hash: prev.hash } : u;
    });
  }
  return next;
}

// Everything the settings UI needs: the current document, the config it renders
// to, and what is actually on disk right now.
router.get('/config', (req, res) => {
  const domain = String(req.query.domain || '').trim().toLowerCase();
  const site = db.proxySites.get(domain);
  if (!site) return res.status(400).json({ error: 'no such domain' });
  let generated = '';
  let error = '';
  try { generated = serverBlock(domain, site); }
  catch (e) { error = e.message; }
  let current = '';
  try { current = fs.readFileSync(confPath(domain), 'utf8'); } catch { /* never written */ }
  res.json({
    domain,
    settings: nginxconf.publicSettings(site.settings),
    defaults: nginxconf.DEFAULTS,
    targets: site.targets,
    lb: site.lb,
    rate: site.rate,
    https: site.https,
    hasCert: nginxconf.hasCert(domain),
    file: confPath(domain),
    generated,
    current,
    error,
  });
});

// Render a settings document without touching the disk — powers the live
// preview pane while the user is still editing.
router.post('/preview', (req, res) => {
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  const site = db.proxySites.get(domain);
  if (!site) return res.status(400).json({ error: 'no such domain' });
  try {
    const targets = req.body.targets ? parseTargets(req.body) : site.targets;
    const lb = req.body.lb ? parseLb(req.body, targets) : site.lb;
    const rate = req.body.rate ? parseRate(req.body) : site.rate;
    const settings = mergeSecrets(req.body.settings, site.settings);
    res.json({ generated: nginxconf.render(domain, { targets, lb, rate, settings }, { cert: site.https || nginxconf.hasCert(domain) }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Save and apply the whole configuration. nginx validates the result before it
// is kept; a rejected config is rolled back by writeVhost and reported verbatim.
router.post('/config', async (req, res) => {
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  const site = db.proxySites.get(domain);
  if (!site) return res.status(400).json({ error: 'no such domain' });

  let targets, lb, rate, settings;
  try {
    targets = req.body.targets ? parseTargets(req.body) : site.targets;
    lb = req.body.lb ? parseLb(req.body, targets) : site.lb;
    rate = req.body.rate ? parseRate(req.body) : site.rate;
    settings = nginxconf.normalize(mergeSecrets(req.body.settings, site.settings));
  } catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    await writeVhost(domain, { targets, lb, rate, settings });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  db.proxySites.setConfig(domain, { target: targets[0].host, targets, lb, rate });
  db.proxySites.setSettings(domain, settings);
  res.json({
    ok: true,
    https: site.https,
    settings: nginxconf.publicSettings(settings),
    generated: serverBlock(domain, { targets, lb, rate, settings }),
  });
});

// Reset a domain to the shipped defaults.
router.post('/config/reset', async (req, res) => {
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  const site = db.proxySites.get(domain);
  if (!site) return res.status(400).json({ error: 'no such domain' });
  try {
    const settings = nginxconf.normalize({});
    await writeVhost(domain, { targets: site.targets, lb: site.lb, rate: site.rate, settings });
    db.proxySites.setSettings(domain, settings);
    res.json({ ok: true, settings: nginxconf.publicSettings(settings) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/sites', (_req, res) => {
  try {
    res.json({ sites: db.proxySites.all().map(publicSite) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/sites', async (req, res) => {
  const { https, email, force } = req.body || {};
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Enter a valid domain (e.g. app.example.com)' });

  let targets, lb, rate, settings;
  try {
    targets = parseTargets(req.body || {});
    lb = parseLb(req.body || {}, targets);
    rate = parseRate(req.body || {});
    settings = nginxconf.normalize((req.body && req.body.settings) || {});
  } catch (e) { return res.status(400).json({ error: e.message }); }

  if (https && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return res.status(400).json({ error: 'A valid email is required for HTTPS certificates' });
  if (db.proxySites.get(domain)) return res.status(400).json({ error: 'That domain is already configured' });

  // Check DNS *before* writing any config, so a bad domain leaves nothing
  // behind and doesn't spend an ACME validation attempt.
  if (https) {
    const pre = await precheck(domain);
    if (pre.level === 'error' && !force) return res.status(400).json({ error: pre.message, hint: pre.hint, precheck: pre });
  }

  try {
    // Write the HTTP server block and enable it.
    await writeVhost(domain, { targets, lb, rate, settings });

    // Then obtain a certificate. If that fails, the HTTP proxy stays live and
    // HTTPS can be retried from the card once DNS/firewall are sorted.
    let gotHttps = false;
    let message = '';
    let detail = '';
    if (https) {
      try {
        await obtainCert(domain, email);
        gotHttps = true;
        // certbot edits the vhost while installing; regenerate so the TLS block
        // is ours (HSTS, protocols and the redirect all come from settings).
        await writeVhost(domain, { targets, lb, rate, settings });
      } catch (e) {
        const x = explainCertbot(e.message);
        message = x.reason;
        detail = x.detail;
      }
    }

    db.proxySites.create({ domain, target: targets[0].host, targets, lb, rate, settings, https: gotHttps, email: email || '' });
    res.json({ ok: true, https: gotHttps, message, detail });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Change the backend pool, the balancing method, or the rate limits of an
// existing domain. The vhost is regenerated from scratch, which is also why an
// HTTPS domain needs its certificate re-installed afterwards.
router.post('/settings', async (req, res) => {
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  const site = db.proxySites.get(domain);
  if (!site) return res.status(400).json({ error: 'no such domain' });

  let targets, lb, rate;
  try {
    targets = parseTargets(req.body || {});
    lb = parseLb(req.body || {}, targets);
    rate = parseRate(req.body || {});
  } catch (e) { return res.status(400).json({ error: e.message }); }

  // Keep whatever else the domain is configured with — this route only edits
  // the backend pool and its limits.
  try {
    await writeVhost(domain, { targets, lb, rate, settings: site.settings });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // The TLS block is generated from the certificate on disk, so regenerating no
  // longer drops HTTPS. Only a missing certificate can, which is worth saying.
  let message = '';
  let detail = '';
  let stillHttps = site.https;
  if (site.https && !nginxconf.hasCert(domain)) {
    try {
      await reinstallCert(domain, site.email);
    } catch (e) {
      const x = explainCertbot(e.message);
      message = x.reason;
      detail = x.detail;
      stillHttps = false;
      db.proxySites.setHttps(domain, false, site.email);
    }
  }

  db.proxySites.setConfig(domain, { target: targets[0].host, targets, lb, rate });
  res.json({ ok: true, https: stillHttps, message, detail });
});

router.post('/enable-https', async (req, res) => {
  const { domain, force } = req.body || {};
  const m = db.proxySites.get(domain);
  if (!m) return res.status(400).json({ error: 'no such domain' });
  const email = m.email || (req.body && req.body.email) || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });

  const pre = await precheck(domain);
  if (pre.level === 'error' && !force) return res.status(400).json({ error: pre.message, hint: pre.hint, precheck: pre });

  try {
    await obtainCert(domain, email);
    db.proxySites.setHttps(domain, true, email);
    // Take the vhost back over from certbot so the TLS block follows the
    // domain's settings (redirect, HSTS, protocols, HTTP/2).
    await writeVhost(domain, { targets: m.targets, lb: m.lb, rate: m.rate, settings: m.settings });
    res.json({ ok: true });
  } catch (e) {
    const { reason, detail } = explainCertbot(e.message);
    res.status(400).json({ error: reason, detail });
  }
});

router.post('/remove', async (req, res) => {
  const { domain } = req.body || {};
  if (!db.proxySites.get(domain)) return res.status(400).json({ error: 'no such domain' });
  try {
    try { fs.unlinkSync(linkPath(domain)); } catch { /* */ }
    try { fs.unlinkSync(confPath(domain)); } catch { /* */ }
    nginxconf.removeAuthFile(domain);
    db.proxySites.remove(domain);
    await reloadNginx().catch(() => {});
    await run('certbot', ['delete', '--cert-name', domain, '--non-interactive']).catch(() => {}); // best effort
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { proxyRouter: router, parseCertificates, explainCertbot, precheck, serverBlock, parseTargets, parseLb, parseRate };
