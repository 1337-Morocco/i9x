import { authHeaders } from './auth'

// Per-app storage: named volumes, host binds and config files edited here.

export type MountType = 'volume' | 'bind' | 'file'

export type Mount = {
  id: number
  app: string
  type: MountType
  source: string     // volume name, host path, or the materialised file path
  target: string     // path inside the container
  ro: boolean
  bytes: number | null
  created: number
  content?: string   // only on the single-mount fetch
}

export type MountInput = {
  app?: string
  type: MountType
  source?: string
  target: string
  content?: string
  ro?: boolean
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const mountsapi = {
  list: (app: string): Promise<{ mounts: Mount[] }> => req(`/api/mounts?app=${encodeURIComponent(app)}`),
  get: (id: number): Promise<Mount> => req(`/api/mounts/${id}`),
  create: (m: MountInput): Promise<{ ok: boolean; id: number; restartRequired: boolean; mount: Mount }> =>
    req('/api/mounts', { method: 'POST', body: JSON.stringify(m) }),
  update: (id: number, m: MountInput): Promise<{ ok: boolean; restartRequired: boolean; mount: Mount }> =>
    req(`/api/mounts/${id}`, { method: 'POST', body: JSON.stringify(m) }),
  remove: (id: number): Promise<{ ok: boolean; restartRequired: boolean }> =>
    req(`/api/mounts/${id}`, { method: 'DELETE' }),
  // Recreate the container so mount changes take effect (no rebuild).
  apply: (app: string): Promise<{ ok: boolean; command: string }> =>
    req(`/api/mounts/apply/${encodeURIComponent(app)}`, { method: 'POST' }),
}
