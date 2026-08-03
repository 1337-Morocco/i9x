import { authHeaders } from './auth'

export type Site = {
  name: string
  title: string
  port: number
  adminUser: string
  created: number
  url: string
  status: 'running' | 'stopped' | 'unknown'
}

export type NewSite = {
  name: string
  title: string
  adminUser: string
  adminPassword: string
  adminEmail: string
  port: number
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const wpapi = {
  sites: (): Promise<{ sites: Site[] }> => req('/api/wordpress/sites'),
  create: (site: NewSite) => req('/api/wordpress/sites', { method: 'POST', body: JSON.stringify(site) }),
  action: (name: string, action: 'start' | 'stop' | 'restart' | 'remove') =>
    req('/api/wordpress/action', { method: 'POST', body: JSON.stringify({ name, action }) }),
  logs: (name: string): Promise<{ text: string }> => req(`/api/wordpress/logs?name=${encodeURIComponent(name)}`),
}
