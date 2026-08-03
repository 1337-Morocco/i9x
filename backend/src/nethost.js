// Resolve the machine's public host (for connection URIs and webhook URLs).
//
// Order: an explicit I9X_PUBLIC_HOST override, else the real public IP via
// an echo service, else the first non-internal IPv4, else localhost. Resolved
// once and cached; warmed at startup and read synchronously via publicHost() so
// it never blocks a request (the first read may return localhost until warm).

const os = require('os');

let cached = null;

async function resolvePublicHost() {
  if (process.env.I9X_PUBLIC_HOST) return (cached = process.env.I9X_PUBLIC_HOST);
  if (cached) return cached;
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const ip = (await r.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return (cached = ip);
    } catch { /* try next */ }
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return (cached = ni.address);
  }
  return 'localhost';
}

const publicHost = () => process.env.I9X_PUBLIC_HOST || cached || 'localhost';

// Base URL where GitHub (and other external callers) can reach this backend.
// I9X_PUBLIC_URL lets an operator pin a real domain in front of the proxy.
const publicBaseUrl = () =>
  process.env.I9X_PUBLIC_URL || `http://${publicHost()}:${process.env.PORT || 3001}`;

resolvePublicHost().catch(() => {}); // warm the cache at startup

module.exports = { resolvePublicHost, publicHost, publicBaseUrl };
