import { authHeaders } from './auth'

export type StaticSite = {
  name: string
  port: number
  root: string
  created: number
  url: string
  status: 'running' | 'stopped' | 'unknown'
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const staticapi = {
  sites: (): Promise<{ sites: StaticSite[] }> => req('/api/static/sites'),
  create: (site: { name: string; port: number; root: string; createRoot: boolean }) =>
    req('/api/static/sites', { method: 'POST', body: JSON.stringify(site) }),
  action: (name: string, action: 'start' | 'stop' | 'restart' | 'remove') =>
    req('/api/static/action', { method: 'POST', body: JSON.stringify({ name, action }) }),
}
