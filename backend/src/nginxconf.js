// nginx vhost generator.
//
// Every reverse-proxy setting i9x exposes lives in one JSON document per
// domain (see DEFAULTS below); this module validates it and renders the whole
// vhost — upstream pool, HTTP and TLS server blocks, location blocks, headers,
// security, caching, compression, logging and any raw snippets the user added.
//
// Two rules keep this safe:
//   1. Every value that reaches the config is validated here. Anything free-form
//      is either matched against a strict pattern or escaped, so a setting can
//      never break out of its directive.
//   2. The two deliberate exceptions — the custom server/location snippets — are
//      caught by `nginx -t` before the config is kept; proxyroutes.js rolls back
//      to the previous file if the test fails.
//
// TLS blocks are generated here rather than left to `certbot --nginx`, so
// regenerating a vhost never loses HTTPS and settings like HSTS, the protocol
// list or the HTTP→HTTPS redirect are ours to control.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LE_LIVE = '/etc/letsencrypt/live';
const AUTH_DIR = process.env.I9X_NGINX_DIR || '/etc/nginx/i9x';

// HTTP/2 moved from a `listen … http2` flag to its own `http2 on;` directive in
// nginx 1.25.1; emitting the wrong one is a hard config error. proxyroutes
// probes the running nginx once and tells us which form to write.
let NGINX_VERSION = null;
function setNginxVersion(v) { NGINX_VERSION = String(v || '') || null; }
function http2AsDirective() {
  if (!NGINX_VERSION) return false;               // unknown ⇒ use the older, universally accepted form
  const [maj, min, pat] = NGINX_VERSION.split('.').map((n) => parseInt(n, 10) || 0);
  return maj > 1 || (maj === 1 && (min > 25 || (min === 25 && pat >= 1)));
}

// ---------------------------------------------------------------------------
// Defaults — also the documentation of what a site can be configured with.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  tls: {
    forceHttps: true,             // redirect http:// to https:// (only once a cert exists)
    http2: true,
    protocols: ['TLSv1.2', 'TLSv1.3'],
    hsts: { enabled: false, maxAge: 15768000, subdomains: false, preload: false },
  },
  request: {
    maxBodySize: '10m',           // client_max_body_size — uploads bigger than this get 413
    connectTimeout: 60,
    sendTimeout: 60,
    readTimeout: 300,
    buffering: true,              // proxy_buffering
    requestBuffering: true,       // proxy_request_buffering — off = stream uploads through
    bufferSize: '8k',
    buffers: '8 16k',
  },
  websocket: true,                // Upgrade/Connection headers so WS/SSE work
  headers: {
    hostHeader: '$host',          // or $proxy_host / a literal name
    forwarded: true,              // X-Real-IP / X-Forwarded-For / -Proto / -Host
    realIpFrom: [],               // trusted proxies (Cloudflare, a load balancer)
    add: [],                      // [{ name, value, always }] -> add_header
    proxySet: [],                 // [{ name, value }] -> proxy_set_header
    hide: [],                     // proxy_hide_header (e.g. X-Powered-By)
  },
  security: {
    basicAuth: { enabled: false, realm: 'Restricted', users: [] },  // users: [{ user, hash }]
    allow: [],                    // IP/CIDR allow list (deny all others when non-empty)
    deny: [],                     // explicit blocks, applied first
    blockDotfiles: true,          // .git, .env, .htaccess …
    headers: {
      frameOptions: 'SAMEORIGIN', // '' = don't send
      contentTypeOptions: true,   // X-Content-Type-Options: nosniff
      referrerPolicy: 'strict-origin-when-cross-origin',
      permissionsPolicy: '',
      csp: '',
    },
  },
  perf: {
    gzip: { enabled: true, level: 5, minLength: 256 },
    staticCache: { enabled: false, maxAge: '30d' },   // Cache-Control for asset extensions
    cache: { enabled: false, valid: '10m', valid404: '1m', size: '256m', bypassCookie: true, methods: ['GET', 'HEAD'] },
  },
  logging: { access: true, errorLevel: 'error' },
  locations: [],                  // extra location blocks; '/' is always generated
  custom: { server: '', location: '' },
};

const GZIP_TYPES = 'text/plain text/css text/xml application/json application/javascript application/xml+rss application/atom+xml image/svg+xml';
const STATIC_EXT = 'css|js|mjs|png|jpg|jpeg|gif|ico|svg|webp|avif|woff|woff2|ttf|otf|eot|mp4|webm';
const ERROR_LEVELS = new Set(['debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg']);
const PROTOCOLS = new Set(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']);
const FRAME_OPTIONS = new Set(['', 'SAMEORIGIN', 'DENY']);
const LOCATION_MODES = new Set(['proxy', 'static', 'redirect', 'text']);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

class ConfError extends Error {}
const fail = (msg) => { throw new ConfError(msg); };

// A value that will sit inside a directive unquoted-ish. Reject the characters
// that could terminate it or open a new block.
function clean(v, what, { max = 512, allowEmpty = true } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (!s) { if (allowEmpty) return ''; fail(`${what} cannot be empty`); }
  if (s.length > max) fail(`${what} is too long (max ${max} characters)`);
  if (/[;{}\r\n\\]/.test(s)) fail(`${what} may not contain ; { } or newlines`);
  return s;
}

// Header values are emitted double-quoted, so only quotes and newlines matter.
function headerValue(v, what) {
  const s = String(v == null ? '' : v).trim();
  if (s.length > 1024) fail(`${what} is too long`);
  if (/[\r\n]/.test(s)) fail(`${what} may not contain newlines`);
  return s.replace(/"/g, '\\"');
}

const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const bool = (v, dflt) => (v === undefined || v === null ? dflt : !!v);

// nginx sizes: 10m, 512k, 1g, or a bare byte count.
function size(v, what, dflt) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  if (!/^\d+(\.\d+)?[kmg]?$/.test(s)) fail(`${what} must look like 10m, 512k or 1g`);
  return s;
}

// nginx times: 30s, 10m, 30d, or bare seconds.
function duration(v, what, dflt) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  if (!/^\d+[smhdwMy]?$/i.test(s)) fail(`${what} must look like 30s, 10m or 30d`);
  return s;
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const IP_RE = /^[0-9a-fA-F.:]{2,45}(\/\d{1,3})?$/;
const PATH_RE = /^\/[^\s;{}"'\\]*$/;
const FS_PATH_RE = /^\/[A-Za-z0-9._\-/]{0,255}$/;
const VAR_HOST_RE = /^(\$host|\$http_host|\$proxy_host|[A-Za-z0-9.-]{1,253})$/;
const USER_RE = /^[A-Za-z0-9._-]{1,32}$/;

// ---------------------------------------------------------------------------
// Normalisation — takes whatever the API was sent and returns a settings object
// that is safe to render. Throws ConfError with a human message on bad input.
// ---------------------------------------------------------------------------

function normalize(input) {
  const i = input && typeof input === 'object' ? input : {};
  const d = DEFAULTS;

  const tlsIn = i.tls || {};
  const hstsIn = tlsIn.hsts || {};
  const protocols = Array.isArray(tlsIn.protocols) && tlsIn.protocols.length
    ? tlsIn.protocols.filter((p) => PROTOCOLS.has(p))
    : d.tls.protocols;
  if (!protocols.length) fail('Select at least one TLS protocol');

  const reqIn = i.request || {};
  const hdrIn = i.headers || {};
  const secIn = i.security || {};
  const secHdrIn = secIn.headers || {};
  const authIn = secIn.basicAuth || {};
  const perfIn = i.perf || {};
  const gzipIn = perfIn.gzip || {};
  const staticIn = perfIn.staticCache || {};
  const cacheIn = perfIn.cache || {};
  const logIn = i.logging || {};
  const customIn = i.custom || {};

  const frameOptions = String(secHdrIn.frameOptions ?? d.security.headers.frameOptions).toUpperCase();
  if (!FRAME_OPTIONS.has(frameOptions === '' ? '' : frameOptions)) fail('X-Frame-Options must be SAMEORIGIN, DENY, or empty');

  const out = {
    tls: {
      forceHttps: bool(tlsIn.forceHttps, d.tls.forceHttps),
      http2: bool(tlsIn.http2, d.tls.http2),
      protocols,
      hsts: {
        enabled: bool(hstsIn.enabled, false),
        maxAge: int(hstsIn.maxAge, 300, 63072000, d.tls.hsts.maxAge),
        subdomains: bool(hstsIn.subdomains, false),
        preload: bool(hstsIn.preload, false),
      },
    },
    request: {
      maxBodySize: size(reqIn.maxBodySize, 'Maximum request body', d.request.maxBodySize),
      connectTimeout: int(reqIn.connectTimeout, 1, 3600, d.request.connectTimeout),
      sendTimeout: int(reqIn.sendTimeout, 1, 3600, d.request.sendTimeout),
      readTimeout: int(reqIn.readTimeout, 1, 3600, d.request.readTimeout),
      buffering: bool(reqIn.buffering, d.request.buffering),
      requestBuffering: bool(reqIn.requestBuffering, d.request.requestBuffering),
      bufferSize: size(reqIn.bufferSize, 'Proxy buffer size', d.request.bufferSize),
      buffers: /^\d{1,3} \d+[kmg]?$/.test(String(reqIn.buffers || '').trim())
        ? String(reqIn.buffers).trim()
        : d.request.buffers,
    },
    websocket: bool(i.websocket, d.websocket),
    headers: {
      hostHeader: (() => {
        const h = clean(hdrIn.hostHeader ?? d.headers.hostHeader, 'Host header', { max: 253 }) || d.headers.hostHeader;
        if (!VAR_HOST_RE.test(h)) fail('Host header must be $host, $http_host, $proxy_host or a hostname');
        return h;
      })(),
      forwarded: bool(hdrIn.forwarded, d.headers.forwarded),
      realIpFrom: list(hdrIn.realIpFrom, 20).map((v) => {
        const s = clean(v, 'Trusted proxy', { max: 45 });
        if (s && !IP_RE.test(s)) fail(`“${s}” is not an IP address or CIDR range`);
        return s;
      }).filter(Boolean),
      add: pairs(hdrIn.add, 'Response header', 30, true),
      proxySet: pairs(hdrIn.proxySet, 'Backend header', 30, false),
      hide: list(hdrIn.hide, 20).map((v) => {
        const s = clean(v, 'Hidden header', { max: 64 });
        if (s && !HEADER_NAME_RE.test(s)) fail(`“${s}” is not a valid header name`);
        return s;
      }).filter(Boolean),
    },
    security: {
      basicAuth: {
        enabled: bool(authIn.enabled, false),
        realm: clean(authIn.realm || 'Restricted', 'Basic-auth realm', { max: 64 }) || 'Restricted',
        users: list(authIn.users, 50).map((u) => {
          const user = clean(u && u.user, 'Username', { max: 32 });
          if (!user) return null;
          if (!USER_RE.test(user)) fail(`Username “${user}”: letters, digits, dot, dash, underscore only`);
          // A hash is kept as-is; a plaintext password is hashed here and never
          // stored. normalize() runs again on every render, so an already
          // hashed value has to survive a second pass unchanged.
          const hash = u.password ? hashPassword(String(u.password)) : validHash(u.hash);
          if (!hash) fail(`Set a password for “${user}”`);
          return { user, hash };
        }).filter(Boolean),
      },
      allow: ipList(secIn.allow, 'Allowed address'),
      deny: ipList(secIn.deny, 'Blocked address'),
      blockDotfiles: bool(secIn.blockDotfiles, d.security.blockDotfiles),
      headers: {
        frameOptions,
        contentTypeOptions: bool(secHdrIn.contentTypeOptions, d.security.headers.contentTypeOptions),
        referrerPolicy: clean(secHdrIn.referrerPolicy ?? d.security.headers.referrerPolicy, 'Referrer-Policy', { max: 64 }),
        permissionsPolicy: headerValue(secHdrIn.permissionsPolicy ?? '', 'Permissions-Policy'),
        csp: headerValue(secHdrIn.csp ?? '', 'Content-Security-Policy'),
      },
    },
    perf: {
      gzip: {
        enabled: bool(gzipIn.enabled, d.perf.gzip.enabled),
        level: int(gzipIn.level, 1, 9, d.perf.gzip.level),
        minLength: int(gzipIn.minLength, 0, 1000000, d.perf.gzip.minLength),
      },
      staticCache: {
        enabled: bool(staticIn.enabled, false),
        maxAge: duration(staticIn.maxAge, 'Static cache lifetime', d.perf.staticCache.maxAge),
      },
      cache: {
        enabled: bool(cacheIn.enabled, false),
        valid: duration(cacheIn.valid, 'Cache lifetime', d.perf.cache.valid),
        valid404: duration(cacheIn.valid404, 'Not-found cache lifetime', d.perf.cache.valid404),
        size: size(cacheIn.size, 'Cache size', d.perf.cache.size),
        bypassCookie: bool(cacheIn.bypassCookie, true),
        methods: (Array.isArray(cacheIn.methods) ? cacheIn.methods : d.perf.cache.methods)
          .filter((m) => ['GET', 'HEAD', 'POST'].includes(String(m).toUpperCase()))
          .map((m) => String(m).toUpperCase()),
      },
    },
    logging: {
      access: bool(logIn.access, true),
      errorLevel: ERROR_LEVELS.has(String(logIn.errorLevel)) ? String(logIn.errorLevel) : 'error',
    },
    locations: list(i.locations, 30).map((l, n) => normalizeLocation(l, n)),
    custom: {
      server: snippet(customIn.server, 'Server-level nginx directives'),
      location: snippet(customIn.location, 'Location-level nginx directives'),
    },
  };

  if (!out.perf.cache.methods.length) out.perf.cache.methods = ['GET', 'HEAD'];

  const paths = new Set(['/']);
  for (const l of out.locations) {
    if (paths.has(l.path)) fail(`Two rules both match ${l.path}`);
    paths.add(l.path);
  }
  return out;
}

function normalizeLocation(l, n) {
  const where = `Rule ${n + 1}`;
  const mode = LOCATION_MODES.has(l && l.mode) ? l.mode : 'proxy';
  const p = clean(l && l.path, `${where} path`, { max: 200, allowEmpty: false });
  if (!PATH_RE.test(p)) fail(`${where}: the path must start with / (e.g. /api)`);

  const out = {
    path: p, mode,
    match: l && l.match === 'exact' ? 'exact' : l && l.match === 'regex' ? 'regex' : 'prefix',
    websocket: bool(l && l.websocket, true),
    rateLimit: bool(l && l.rateLimit, true),
    basicAuth: bool(l && l.basicAuth, true),
    cache: bool(l && l.cache, true),
    custom: snippet(l && l.custom, `${where} custom directives`),
    target: '', root: '', index: '', tryFiles: true, redirectTo: '', redirectCode: 301, text: '', status: 200,
  };

  if (out.match === 'regex') {
    // A regex location is written as `location ~* <path>` — keep it printable
    // and free of block characters; nginx -t catches anything malformed.
    if (/[;{}\s]/.test(p)) fail(`${where}: a pattern may not contain spaces, ; or { }`);
  }

  if (mode === 'proxy') {
    const t = clean(l && l.target, `${where} backend`, { max: 253 });
    // Empty target = the domain's main backend pool.
    if (t) {
      const m = /^(?:(https?):\/\/)?([A-Za-z0-9_.-]+)(?::(\d{1,5}))?$/.exec(t) || /^(\d{1,5})$/.test(t);
      if (!m) fail(`${where}: the backend must be a port, host:port or http://host:port`);
      out.target = /^\d{1,5}$/.test(t) ? `127.0.0.1:${t}` : t;
    }
  } else if (mode === 'static') {
    const root = clean(l && l.root, `${where} directory`, { max: 255, allowEmpty: false });
    if (!FS_PATH_RE.test(root)) fail(`${where}: the directory must be an absolute path`);
    out.root = root;
    out.index = clean((l && l.index) || 'index.html', `${where} index file`, { max: 128 }) || 'index.html';
    out.tryFiles = bool(l && l.tryFiles, true);
  } else if (mode === 'redirect') {
    const to = clean(l && l.redirectTo, `${where} redirect target`, { max: 512, allowEmpty: false });
    if (!/^(https?:\/\/[^\s"']+|\/[^\s"']*)$/.test(to)) fail(`${where}: redirect to a URL or an absolute path`);
    out.redirectTo = to;
    out.redirectCode = [301, 302, 307, 308].includes(Number(l && l.redirectCode)) ? Number(l.redirectCode) : 301;
  } else {
    out.text = headerValue((l && l.text) || '', `${where} response body`);
    out.status = int(l && l.status, 100, 599, 200);
  }
  return out;
}

function list(v, max) {
  if (!Array.isArray(v)) return [];
  if (v.length > max) fail(`Too many entries (max ${max})`);
  return v;
}

function pairs(v, what, max, allowAlways) {
  return list(v, max).map((h) => {
    const name = clean(h && h.name, `${what} name`, { max: 64 });
    if (!name) return null;
    if (!HEADER_NAME_RE.test(name)) fail(`“${name}” is not a valid header name`);
    const entry = { name, value: headerValue(h && h.value, `${what} value`) };
    if (allowAlways) entry.always = bool(h && h.always, true);
    return entry;
  }).filter(Boolean);
}

function ipList(v, what) {
  return list(v, 100).map((a) => {
    const s = clean(a, what, { max: 45 });
    if (s && !IP_RE.test(s)) fail(`“${s}” is not an IP address or CIDR range`);
    return s;
  }).filter(Boolean);
}

// Raw nginx directives. Only the obvious escapes are blocked — everything else
// is left to `nginx -t`, which runs before the config is kept.
function snippet(v, what) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.length > 8000) fail(`${what}: too long (max 8000 characters)`);
  if (/\0/.test(s)) fail(`${what}: contains a null byte`);
  return s;
}

// nginx understands "{SHA}base64(sha1(password))" natively, so basic-auth works
// without htpasswd being installed. The plaintext is never stored.
function hashPassword(password) {
  if (password.length < 4) fail('Basic-auth passwords must be at least 4 characters');
  return `{SHA}${crypto.createHash('sha1').update(password).digest('base64')}`;
}

// The formats nginx accepts in an htpasswd file: our own {SHA}…, plus apr1/crypt
// hashes if one was imported. Anything else could smuggle characters into the
// file, so it is rejected outright.
const SHA_RE = /^\{SHA\}[A-Za-z0-9+/]{27}=$/;
const CRYPT_RE = /^\$[0-9a-z]{1,6}\$[A-Za-z0-9./$]{4,120}$/;
function validHash(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!SHA_RE.test(s) && !CRYPT_RE.test(s)) fail('That password hash is not in a format nginx accepts');
  return s;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const zoneBase = (domain) => `i9x_${domain.replace(/[^a-z0-9]+/gi, '_')}`;
const certDir = (domain) => path.join(LE_LIVE, domain);
const hasCert = (domain) => fs.existsSync(path.join(certDir(domain), 'fullchain.pem'));
const authFile = (domain) => path.join(AUTH_DIR, `${domain}.htpasswd`);

const ind = (n, lines) => lines.filter(Boolean).map((l) => ' '.repeat(n) + l);

// The proxy_* directives shared by every proxying location.
function proxyCommon(s, base, { websocket }) {
  const h = s.headers;
  const out = [
    'proxy_http_version 1.1;',
    `proxy_set_header Host ${h.hostHeader};`,
  ];
  if (h.forwarded) {
    out.push(
      'proxy_set_header X-Real-IP $remote_addr;',
      'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      'proxy_set_header X-Forwarded-Proto $scheme;',
      'proxy_set_header X-Forwarded-Host $host;',
      'proxy_set_header X-Forwarded-Port $server_port;',
    );
  }
  if (websocket && s.websocket) {
    out.push('proxy_set_header Upgrade $http_upgrade;', `proxy_set_header Connection $${base}_upgrade;`);
  }
  for (const p of h.proxySet) out.push(`proxy_set_header ${p.name} "${p.value}";`);
  for (const n of h.hide) out.push(`proxy_hide_header ${n};`);
  out.push(
    `proxy_connect_timeout ${s.request.connectTimeout}s;`,
    `proxy_send_timeout ${s.request.sendTimeout}s;`,
    `proxy_read_timeout ${s.request.readTimeout}s;`,
    `proxy_buffering ${s.request.buffering ? 'on' : 'off'};`,
    `proxy_request_buffering ${s.request.requestBuffering ? 'on' : 'off'};`,
  );
  if (s.request.buffering) {
    out.push(`proxy_buffer_size ${s.request.bufferSize};`, `proxy_buffers ${s.request.buffers};`);
  }
  out.push('proxy_next_upstream error timeout http_502 http_503 http_504;');
  return out;
}

function limitLines(base, rate, apply) {
  if (!rate.enabled || !apply) return [];
  const out = [`limit_req zone=${base}_rq${rate.burst > 0 ? ` burst=${rate.burst}` : ''}${rate.burst > 0 && rate.nodelay ? ' nodelay' : ''};`, 'limit_req_status 429;'];
  if (rate.conns > 0) out.push(`limit_conn ${base}_cn ${rate.conns};`, 'limit_conn_status 429;');
  return out;
}

function accessLines(sec, apply) {
  if (!apply) return [];
  const out = [];
  for (const ip of sec.deny) out.push(`deny ${ip};`);
  if (sec.allow.length) {
    for (const ip of sec.allow) out.push(`allow ${ip};`);
    out.push('deny all;');
  }
  return out;
}

function authLines(domain, sec, apply) {
  if (!apply || !sec.basicAuth.enabled || !sec.basicAuth.users.length) return [];
  return [`auth_basic "${sec.basicAuth.realm}";`, `auth_basic_user_file ${authFile(domain)};`];
}

function cacheLines(base, cache, apply) {
  if (!cache.enabled || !apply) return [];
  const out = [
    `proxy_cache ${base}_cache;`,
    `proxy_cache_valid 200 301 302 ${cache.valid};`,
    `proxy_cache_valid 404 ${cache.valid404};`,
    `proxy_cache_methods ${cache.methods.join(' ')};`,
    'proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;',
    'proxy_cache_lock on;',
    'add_header X-Cache-Status $upstream_cache_status always;',
  ];
  // A logged-in visitor must never be served another visitor's cached page.
  if (cache.bypassCookie) {
    out.push(
      'proxy_cache_bypass $http_authorization $cookie_session $cookie_sessionid $cookie_PHPSESSID;',
      'proxy_no_cache $http_authorization $cookie_session $cookie_sessionid $cookie_PHPSESSID;',
    );
  }
  return out;
}

// One location block.
function locationBlock(domain, s, base, loc, { poolName }) {
  const prefix = loc.match === 'exact' ? '= ' : loc.match === 'regex' ? '~* ' : '';
  const body = [];

  body.push(...accessLines(s.security, loc.basicAuth));
  body.push(...authLines(domain, s.security, loc.basicAuth));
  body.push(...limitLines(base, s.rate, loc.rateLimit));

  if (loc.mode === 'proxy') {
    body.push(...cacheLines(base, s.perf.cache, loc.cache));
    body.push(`proxy_pass http://${loc.target ? loc.target : poolName};`);
    body.push(...proxyCommon(s, base, { websocket: loc.websocket }));
  } else if (loc.mode === 'static') {
    body.push(`root ${loc.root};`);
    body.push(`index ${loc.index};`);
    if (loc.tryFiles) body.push(`try_files $uri $uri/ /${loc.index};`);
  } else if (loc.mode === 'redirect') {
    body.push(`return ${loc.redirectCode} ${loc.redirectTo};`);
  } else {
    body.push('default_type text/plain;');
    body.push(`return ${loc.status} "${loc.text}";`);
  }
  if (loc.custom) body.push(...loc.custom.split('\n').map((l) => l.trim()).filter(Boolean));

  return [`location ${prefix}${loc.path} {`, ...ind(4, body), '}'];
}

// The main `location /` — the domain's primary behaviour.
function rootLocation(domain, s, base, poolName) {
  const body = [
    ...accessLines(s.security, true),
    ...authLines(domain, s.security, true),
    ...limitLines(base, s.rate, true),
    ...cacheLines(base, s.perf.cache, true),
    `proxy_pass http://${poolName};`,
    ...proxyCommon(s, base, { websocket: true }),
  ];
  if (s.custom.location) body.push(...s.custom.location.split('\n').map((l) => l.trim()).filter(Boolean));
  return ['location / {', ...ind(4, body), '}'];
}

function upstreamBlock(name, targets, lb) {
  const lines = [`upstream ${name} {`];
  if (lb.method === 'least_conn') lines.push('    least_conn;');
  if (lb.method === 'ip_hash') lines.push('    ip_hash;');
  for (const t of targets) {
    const opts = [];
    if (t.weight > 1) opts.push(`weight=${t.weight}`);
    opts.push(`max_fails=${lb.maxFails}`, `fail_timeout=${lb.failTimeout}s`);
    if (t.backup) opts.push('backup');
    lines.push(`    server ${t.host} ${opts.join(' ')};`);
  }
  // Keeping connections to the backend open removes a TCP handshake per request.
  if (lb.method !== 'ip_hash') lines.push('    keepalive 32;');
  lines.push('}');
  return lines;
}

// Everything that has to sit in the http context, above the server blocks.
function httpContext(domain, s, base) {
  const out = [];
  if (s.websocket) {
    // Connection: upgrade only when the client asked for it, else close.
    out.push(`map $http_upgrade $${base}_upgrade {`, '    default upgrade;', "    ''      close;", '}', '');
  }
  if (s.rate.enabled) {
    out.push(`limit_req_zone $binary_remote_addr zone=${base}_rq:10m rate=${s.rate.rate}r/${s.rate.unit};`);
    if (s.rate.conns > 0) out.push(`limit_conn_zone $binary_remote_addr zone=${base}_cn:10m;`);
    out.push('');
  }
  if (s.perf.cache.enabled) {
    out.push(`proxy_cache_path /var/cache/nginx/${base} levels=1:2 keys_zone=${base}_cache:10m max_size=${s.perf.cache.size} inactive=60m use_temp_path=off;`, '');
  }
  for (const ip of s.headers.realIpFrom) out.push(`set_real_ip_from ${ip};`);
  if (s.headers.realIpFrom.length) out.push('real_ip_header X-Forwarded-For;', 'real_ip_recursive on;', '');
  return out;
}

// Directives shared by the HTTP and HTTPS server blocks.
function serverCommon(domain, s, base, poolName) {
  const out = [];
  out.push(`client_max_body_size ${s.request.maxBodySize};`);
  out.push(`error_log /var/log/nginx/i9x-${domain}.error.log ${s.logging.errorLevel};`);
  out.push(s.logging.access ? `access_log /var/log/nginx/i9x-${domain}.access.log;` : 'access_log off;');

  if (s.perf.gzip.enabled) {
    out.push('', 'gzip on;', 'gzip_vary on;', 'gzip_proxied any;',
      `gzip_comp_level ${s.perf.gzip.level};`, `gzip_min_length ${s.perf.gzip.minLength};`,
      `gzip_types ${GZIP_TYPES};`);
  }

  const sh = s.security.headers;
  const secHeaders = [];
  if (sh.frameOptions) secHeaders.push(`add_header X-Frame-Options "${sh.frameOptions}" always;`);
  if (sh.contentTypeOptions) secHeaders.push('add_header X-Content-Type-Options "nosniff" always;');
  if (sh.referrerPolicy) secHeaders.push(`add_header Referrer-Policy "${sh.referrerPolicy}" always;`);
  if (sh.permissionsPolicy) secHeaders.push(`add_header Permissions-Policy "${sh.permissionsPolicy}" always;`);
  if (sh.csp) secHeaders.push(`add_header Content-Security-Policy "${sh.csp}" always;`);
  for (const h of s.headers.add) secHeaders.push(`add_header ${h.name} "${h.value}"${h.always ? ' always' : ''};`);
  if (secHeaders.length) out.push('', ...secHeaders);

  if (s.custom.server) out.push('', ...s.custom.server.split('\n').map((l) => l.trim()).filter(Boolean));

  if (s.security.blockDotfiles) {
    out.push('', '# Never serve dotfiles (.git, .env, .htaccess…)',
      'location ~ /\\. { deny all; access_log off; log_not_found off; }');
  }
  if (s.perf.staticCache.enabled) {
    out.push('', `location ~* \\.(${STATIC_EXT})$ {`,
      ...ind(4, [
        `proxy_pass http://${poolName};`,
        ...proxyCommon(s, base, { websocket: false }),
        `expires ${s.perf.staticCache.maxAge};`,
        'add_header Cache-Control "public, immutable" always;',
        'access_log off;',
      ]), '}');
  }

  // Custom rules first: nginx matches the longest prefix, but exact and regex
  // locations win, and putting them above `location /` keeps the file readable.
  for (const loc of s.locations) out.push('', ...locationBlock(domain, s, base, loc, { poolName }));
  out.push('', ...rootLocation(domain, s, base, poolName));
  return out;
}

// The full vhost for a domain.
//
// site: { targets, lb, rate, settings }  — `rate` stays top-level because it is
// shared with the pre-settings API shape.
function render(domain, site, { cert = null } = {}) {
  const base = zoneBase(domain);
  const poolName = `${base}_up`;
  const s = { ...normalize(site.settings), rate: site.rate };
  const secure = cert === null ? hasCert(domain) : !!cert;
  const redirect = secure && s.tls.forceHttps;

  const lines = [
    '# Managed by i9x — regenerated whenever this domain is reconfigured.',
    '# Edits made here by hand are lost on the next save; use the panel instead.',
    '',
    ...httpContext(domain, s, base),
    ...upstreamBlock(poolName, site.targets, site.lb),
    '',
  ];

  // ---- port 80 ----
  lines.push('server {', '    listen 80;', '    listen [::]:80;', `    server_name ${domain};`, '');
  // ACME HTTP-01 must never be redirected away, or renewals break.
  lines.push('    location /.well-known/acme-challenge/ { root /var/www/html; allow all; }', '');
  if (redirect) {
    lines.push('    return 301 https://$host$request_uri;', '}');
  } else {
    lines.push(...ind(4, serverCommon(domain, s, base, poolName)), '}');
  }

  // ---- port 443 ----
  if (secure) {
    const dir = certDir(domain);
    const h2Listen = s.tls.http2 && !http2AsDirective() ? ' http2' : '';
    lines.push('', 'server {',
      `    listen 443 ssl${h2Listen};`,
      `    listen [::]:443 ssl${h2Listen};`,
      ...(s.tls.http2 && http2AsDirective() ? ['    http2 on;'] : []),
      `    server_name ${domain};`, '',
      `    ssl_certificate ${path.join(dir, 'fullchain.pem')};`,
      `    ssl_certificate_key ${path.join(dir, 'privkey.pem')};`,
      `    ssl_protocols ${s.tls.protocols.join(' ')};`,
      '    ssl_prefer_server_ciphers off;',
      '    ssl_session_cache shared:SSL:10m;',
      '    ssl_session_timeout 1d;',
      '    ssl_session_tickets off;',
    );
    if (fs.existsSync(path.join(dir, 'chain.pem'))) {
      lines.push('    ssl_stapling on;', '    ssl_stapling_verify on;', `    ssl_trusted_certificate ${path.join(dir, 'chain.pem')};`);
    }
    if (s.tls.hsts.enabled) {
      const parts = [`max-age=${s.tls.hsts.maxAge}`];
      if (s.tls.hsts.subdomains) parts.push('includeSubDomains');
      if (s.tls.hsts.preload) parts.push('preload');
      lines.push(`    add_header Strict-Transport-Security "${parts.join('; ')}" always;`);
    }
    lines.push('', ...ind(4, serverCommon(domain, s, base, poolName)), '}');
  }

  return `${lines.join('\n')}\n`;
}

// Write (or remove) the basic-auth file backing a domain's settings.
function writeAuthFile(domain, settings) {
  const file = authFile(domain);
  const auth = settings.security.basicAuth;
  if (!auth.enabled || !auth.users.length) {
    try { fs.rmSync(file, { force: true }); } catch { /* nothing to remove */ }
    return null;
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, `${auth.users.map((u) => `${u.user}:${u.hash}`).join('\n')}\n`, { mode: 0o640 });
  return file;
}

function removeAuthFile(domain) {
  try { fs.rmSync(authFile(domain), { force: true }); } catch { /* already gone */ }
}

// Passwords are never returned to the browser — only whether one is set.
function publicSettings(settings) {
  const s = normalize(settings);
  return {
    ...s,
    security: {
      ...s.security,
      basicAuth: { ...s.security.basicAuth, users: s.security.basicAuth.users.map((u) => ({ user: u.user, hasPassword: true })) },
    },
  };
}

module.exports = {
  DEFAULTS, ConfError, normalize, render, publicSettings, setNginxVersion,
  writeAuthFile, removeAuthFile, hasCert, certDir, authFile, zoneBase, AUTH_DIR,
};
