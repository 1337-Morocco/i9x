import { authHeaders } from './auth'

// Shared types + client for the app-hosting features (Next.js, Vite). Both hit
// the same REST shape under different bases (/api/next, /api/vite).

export type HostAppDomain = { domain: string; https: boolean }

export type HostApp = {
  name: string
  repo: string
  branch: string
  port: number
  created: number
  url: string
  status: 'running' | 'stopped' | 'unknown' | 'building' | 'failed'
  envCount: number
  domains: HostAppDomain[]
  outDir?: string
  framework?: string
  autodeploy?: boolean
  cpus?: string        // '' = unlimited
  memory?: string      // '' = unlimited
  mountCount?: number
  container?: string
}

export type Limits = { cpus: string; memory: string }
// How a limits change reached the container: live `docker update`, a container
// recreate (needed when clearing a cap), or only at the next start.
export type LimitsApplied = 'live' | 'recreated' | 'next-start' | 'none'

export type Detection = { framework: string; reason: string; confident?: boolean }

export type BuildRecord = {
  id: number
  app: string
  number: number
  status: 'building' | 'running' | 'failed'
  trigger: string
  started: number
  finished: number | null
}

export type WebhookConfig = {
  autodeploy: boolean; url: string; secret: string; contentType: string; events: string
  githubConnected?: boolean; installed?: boolean; installError?: string | null
}

export type HostAction = 'start' | 'stop' | 'restart' | 'rebuild' | 'remove'

export type HostingApi = {
  apps: () => Promise<{ apps: HostApp[] }>
  create: (payload: Record<string, unknown>) => Promise<{ ok: boolean; building: boolean; name: string; port: number }>
  buildlog: (name: string, build?: number) => Promise<{ text: string; state: string; build?: BuildRecord | null }>
  builds: (name: string) => Promise<{ builds: BuildRecord[] }>
  action: (name: string, action: HostAction) => Promise<{ ok: boolean }>
  logs: (name: string) => Promise<{ text: string }>
  getEnv: (name: string) => Promise<{ env: Record<string, string> }>
  setEnv: (name: string, env: Record<string, string>, rebuild?: boolean) => Promise<{ ok: boolean; rebuilding: boolean }>
  getWebhook: (name: string) => Promise<WebhookConfig>
  setWebhook: (name: string, enabled: boolean, regenerate?: boolean) => Promise<WebhookConfig>
  getLimits: (name: string) => Promise<Limits>
  setLimits: (name: string, limits: Limits) => Promise<Limits & { ok: boolean; applied: LimitsApplied }>
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

// base is the URL segment: 'next' or 'vite'.
export function makeHostingApi(base: string): HostingApi {
  const root = `/api/${base}`
  return {
    apps: () => req(`${root}/apps`),
    create: (payload) => req(`${root}/apps`, { method: 'POST', body: JSON.stringify(payload) }),
    buildlog: (name, build) => req(`${root}/buildlog?name=${encodeURIComponent(name)}${build ? `&build=${build}` : ''}`),
    builds: (name) => req(`${root}/builds?name=${encodeURIComponent(name)}`),
    action: (name, action) => req(`${root}/action`, { method: 'POST', body: JSON.stringify({ name, action }) }),
    logs: (name) => req(`${root}/logs?name=${encodeURIComponent(name)}`),
    getEnv: (name) => req(`${root}/env?name=${encodeURIComponent(name)}`),
    setEnv: (name, env, rebuild) => req(`${root}/env`, { method: 'POST', body: JSON.stringify({ name, env, rebuild }) }),
    getWebhook: (name) => req(`${root}/webhook?name=${encodeURIComponent(name)}`),
    setWebhook: (name, enabled, regenerate) => req(`${root}/webhook`, { method: 'POST', body: JSON.stringify({ name, enabled, regenerate }) }),
    getLimits: (name) => req(`${root}/limits?name=${encodeURIComponent(name)}`),
    setLimits: (name, limits) => req(`${root}/limits`, { method: 'POST', body: JSON.stringify({ name, ...limits }) }),
  }
}
