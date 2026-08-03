const test = require('node:test');
const assert = require('node:assert/strict');
const nginx = require('../src/nginxconf');

// nginxconf renders the vhost for every proxied domain, and `normalize` is the
// validation gate in front of it — anything it lets through ends up in a real
// config file that nginx has to accept. A rejected config rolls the domain
// back, so the cost of a bug here is a domain that silently stops serving.
//
// render(domain, site, opts) takes the site record, not a settings object;
// `cert` is passed explicitly so these tests never touch /etc/letsencrypt.

// These fixtures mirror exactly what proxyroutes builds, because render()
// reads their fields directly and has no defaulting of its own:
//   - `t.host` is the whole "host:port" string (normalizeTarget produces it)
//   - `lb` is an object; a bare string yields `max_fails=undefined` in the
//     generated config
//   - `rate` must be an object; callers guarantee it with
//     `site.rate || parseRate({})`
const RATE_OFF = { enabled: false, rate: 60, unit: 'm', burst: 20, nodelay: true, conns: 0 };
const LB = { method: 'round_robin', maxFails: 3, failTimeout: 10 };

const site = (over = {}) => ({
  settings: {},
  targets: [{ host: '127.0.0.1:3000' }],
  lb: LB,
  rate: RATE_OFF,
  ...over,
});

test('normalize: tolerates an empty object and fills defaults', () => {
  const s = nginx.normalize({});
  assert.equal(typeof s, 'object');
  assert.ok(Array.isArray(s.tls.protocols) && s.tls.protocols.length > 0);
});

test('normalize: rejects an empty TLS protocol selection', () => {
  assert.throws(
    () => nginx.normalize({ tls: { protocols: ['SSLv2'] } }),
    /TLS protocol/i,
    'an unsupported protocol filters to an empty list and must be refused'
  );
});

test('normalize: a location path must start with /', () => {
  assert.throws(() => nginx.normalize({ locations: [{ path: 'api' }] }), /must start with \//);
});

test('normalize: unknown location modes fall back to proxy', () => {
  const s = nginx.normalize({ locations: [{ path: '/api', mode: 'nonsense' }] });
  assert.equal(s.locations[0].mode, 'proxy');
});

test('render: emits a server block naming the domain', () => {
  const out = nginx.render('example.com', site(), { cert: false });
  assert.match(out, /server\s*\{/);
  assert.match(out, /server_name[^;]*example\.com/);
});

test('render: proxies to the configured target', () => {
  const out = nginx.render('example.com', site(), { cert: false });
  assert.match(out, /127\.0\.0\.1:3000/);
});

test('render: upstream carries no literal "undefined"', () => {
  const out = nginx.render('example.com', site(), { cert: false });
  // A malformed lb object silently produced `max_fails=undefined`, which
  // nginx -t rejects — and a rejected config rolls the domain back.
  assert.equal(out.includes('undefined'), false, out.split('\n').find((l) => l.includes('undefined')) || '');
});

test('render: honours the load-balancing method', () => {
  const lc = nginx.render('example.com', site({ lb: { ...LB, method: 'least_conn' } }), { cert: false });
  assert.match(lc, /least_conn;/);
  const ih = nginx.render('example.com', site({ lb: { ...LB, method: 'ip_hash' } }), { cert: false });
  assert.match(ih, /ip_hash;/);
  // nginx rejects keepalive in an ip_hash upstream.
  assert.equal(/keepalive/.test(ih), false);
});

test('render: carries the "managed by i9x" warning header', () => {
  const out = nginx.render('example.com', site(), { cert: false });
  assert.match(out, /Managed by i9x/, 'hand-edit warning must survive, edits here are lost');
});

test('render: without a cert there is no ssl directive', () => {
  const out = nginx.render('example.com', site(), { cert: false });
  assert.equal(/ssl_certificate\b/.test(out), false);
});

test('render: with a cert it owns the TLS block itself', () => {
  const out = nginx.render('example.com', site(), { cert: true });
  assert.match(out, /ssl_certificate/, 'i9x renders TLS; certbot only issues the cert');
  assert.match(out, /listen\s+443/);
});

test('render: forceHttps adds a redirect only when a cert exists', () => {
  const withCert = nginx.render('example.com', site({ settings: { tls: { forceHttps: true } } }), { cert: true });
  assert.match(withCert, /return\s+30[18]/, 'should redirect http -> https');

  const noCert = nginx.render('example.com', site({ settings: { tls: { forceHttps: true } } }), { cert: false });
  assert.equal(/return\s+30[18]/.test(noCert), false, 'redirecting without a cert would strand the domain');
});

test('render: deterministic for identical input', () => {
  const s = site();
  assert.equal(nginx.render('example.com', s, { cert: false }), nginx.render('example.com', s, { cert: false }));
});

test('render: never returns an empty config', () => {
  const out = nginx.render('example.com', site(), { cert: false });
  assert.ok(out.trim().length > 0, 'a blank vhost would take the domain down');
});

test('zoneBase: derives a directive-safe identifier from the domain', () => {
  const base = nginx.zoneBase('sub.example.com');
  assert.equal(/^[A-Za-z0-9_]+$/.test(base), true, 'dots would be invalid in an nginx zone name');
});

test('publicSettings: round-trips without exposing the auth file path', () => {
  const pub = nginx.publicSettings({});
  assert.equal(typeof pub, 'object');
  assert.equal(JSON.stringify(pub).includes(nginx.AUTH_DIR), false);
});

test('ConfError is distinguishable from a generic Error', () => {
  const e = new nginx.ConfError('bad');
  assert.ok(e instanceof Error);
  assert.ok(e instanceof nginx.ConfError);
});
