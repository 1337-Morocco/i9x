import { authHeaders } from './auth'

export type Backend = { host: string; weight: number; backup: boolean }

export type LbMethod = 'round_robin' | 'least_conn' | 'ip_hash'

// Passive health checking: a backend that fails `maxFails` times inside
// `failTimeout` seconds is taken out of rotation for that long.
export type LbSettings = { method: LbMethod; maxFails: number; failTimeout: number }

// unit 's' | 'm' — nginx only accepts whole requests per second or per minute.
// burst queues spikes, nodelay serves the queue immediately, conns caps
// simultaneous connections from one IP (0 = off).
export type RateSettings = { enabled: boolean; rate: number; unit: 's' | 'm'; burst: number; nodelay: boolean; conns: number }

export type ProxySite = {
  domain: string
  target: string
  targets: Backend[]
  lb: LbSettings
  rate: RateSettings
  https: boolean
  created: number
  badges?: string[]       // what's switched on, for the card
  maxBodySize?: string
}

// ---------------------------------------------------------------------------
// The full nginx settings document (mirrors DEFAULTS in backend/src/nginxconf.js)
// ---------------------------------------------------------------------------

export type HeaderPair = { name: string; value: string; always?: boolean }
export type BasicAuthUser = { user: string; password?: string; hasPassword?: boolean }
export type LocationMode = 'proxy' | 'static' | 'redirect' | 'text'
export type LocationMatch = 'prefix' | 'exact' | 'regex'

export type LocationRule = {
  path: string
  match: LocationMatch
  mode: LocationMode
  websocket: boolean
  rateLimit: boolean
  basicAuth: boolean
  cache: boolean
  custom: string
  target: string          // proxy: '' = the domain's backend pool
  root: string            // static
  index: string
  tryFiles: boolean
  redirectTo: string      // redirect
  redirectCode: number
  text: string            // text
  status: number
}

export type NginxSettings = {
  tls: {
    forceHttps: boolean
    http2: boolean
    protocols: string[]
    hsts: { enabled: boolean; maxAge: number; subdomains: boolean; preload: boolean }
  }
  request: {
    maxBodySize: string
    connectTimeout: number
    sendTimeout: number
    readTimeout: number
    buffering: boolean
    requestBuffering: boolean
    bufferSize: string
    buffers: string
  }
  websocket: boolean
  headers: {
    hostHeader: string
    forwarded: boolean
    realIpFrom: string[]
    add: HeaderPair[]
    proxySet: HeaderPair[]
    hide: string[]
  }
  security: {
    basicAuth: { enabled: boolean; realm: string; users: BasicAuthUser[] }
    allow: string[]
    deny: string[]
    blockDotfiles: boolean
    headers: {
      frameOptions: string
      contentTypeOptions: boolean
      referrerPolicy: string
      permissionsPolicy: string
      csp: string
    }
  }
  perf: {
    gzip: { enabled: boolean; level: number; minLength: number }
    staticCache: { enabled: boolean; maxAge: string }
    cache: { enabled: boolean; valid: string; valid404: string; size: string; bypassCookie: boolean; methods: string[] }
  }
  logging: { access: boolean; errorLevel: string }
  locations: LocationRule[]
  custom: { server: string; location: string }
}

export type ProxyConfigResponse = {
  domain: string
  settings: NginxSettings
  defaults: NginxSettings
  targets: Backend[]
  lb: LbSettings
  rate: RateSettings
  https: boolean
  hasCert: boolean
  file: string
  generated: string
  current: string
  error: string
}

export const defaultLb = (): LbSettings => ({ method: 'round_robin', maxFails: 3, failTimeout: 10 })
export const defaultRate = (): RateSettings => ({ enabled: false, rate: 60, unit: 'm', burst: 20, nodelay: true, conns: 0 })

export type Precheck = {
  domain: string
  serverIp: string | null
  a: string[]
  aaaa: string[]
  level: 'ok' | 'warn' | 'error'
  code: 'ok' | 'syntax' | 'reserved' | 'badtld' | 'nodns' | 'mismatch'
  message: string
  hint: string
}

export type Cert = { name: string; domains: string[]; expiry: string | null; days: number | null; valid: boolean }

export type ProxyStatus = { nginx: boolean; running: boolean; certbot: boolean; autoRenew: boolean; publicIp: string | null; version?: string | null }

export const emptyLocation = (): LocationRule => ({
  path: '/', match: 'prefix', mode: 'proxy', websocket: true, rateLimit: true, basicAuth: true, cache: true,
  custom: '', target: '', root: '', index: 'index.html', tryFiles: true,
  redirectTo: '', redirectCode: 301, text: '', status: 200,
})

// Errors from the proxy API can carry a fix-it hint and the raw certbot log.
export class ProxyError extends Error {
  hint?: string
  detail?: string
  precheck?: Precheck
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) {
    const e = new ProxyError(d.error || 'request failed')
    e.hint = d.hint; e.detail = d.detail; e.precheck = d.precheck
    throw e
  }
  return d
}

export const proxyapi = {
  status: (): Promise<ProxyStatus> => req('/api/proxy/status'),
  sites: (): Promise<{ sites: ProxySite[] }> => req('/api/proxy/sites'),
  precheck: (domain: string): Promise<Precheck> => req(`/api/proxy/precheck?domain=${encodeURIComponent(domain)}`),
  certs: (): Promise<{ certs: Cert[] }> => req('/api/proxy/certs'),
  // `target` is the single-backend shorthand kept for callers that just point a
  // domain at one app; `targets`/`lb`/`rate` configure the full pool.
  create: (s: { domain: string; target?: string; targets?: Backend[]; lb?: LbSettings; rate?: RateSettings; https: boolean; email: string; force?: boolean }): Promise<{ ok: boolean; https: boolean; message?: string; detail?: string }> =>
    req('/api/proxy/sites', { method: 'POST', body: JSON.stringify(s) }),
  settings: (s: { domain: string; targets: Backend[]; lb: LbSettings; rate: RateSettings }): Promise<{ ok: boolean; https: boolean; message?: string; detail?: string }> =>
    req('/api/proxy/settings', { method: 'POST', body: JSON.stringify(s) }),
  enableHttps: (domain: string, email: string, force?: boolean) =>
    req('/api/proxy/enable-https', { method: 'POST', body: JSON.stringify({ domain, email, force }) }),
  renew: (domain: string) => req('/api/proxy/renew', { method: 'POST', body: JSON.stringify({ domain }) }),
  remove: (domain: string) => req('/api/proxy/remove', { method: 'POST', body: JSON.stringify({ domain }) }),

  // Full nginx configuration for one domain.
  config: (domain: string): Promise<ProxyConfigResponse> =>
    req(`/api/proxy/config?domain=${encodeURIComponent(domain)}`),
  // Render without writing anything — the live preview.
  preview: (body: { domain: string; targets: Backend[]; lb: LbSettings; rate: RateSettings; settings: NginxSettings }): Promise<{ generated: string }> =>
    req('/api/proxy/preview', { method: 'POST', body: JSON.stringify(body) }),
  saveConfig: (body: { domain: string; targets: Backend[]; lb: LbSettings; rate: RateSettings; settings: NginxSettings }): Promise<{ ok: boolean; settings: NginxSettings; generated: string }> =>
    req('/api/proxy/config', { method: 'POST', body: JSON.stringify(body) }),
  resetConfig: (domain: string): Promise<{ ok: boolean; settings: NginxSettings }> =>
    req('/api/proxy/config/reset', { method: 'POST', body: JSON.stringify({ domain }) }),
}
