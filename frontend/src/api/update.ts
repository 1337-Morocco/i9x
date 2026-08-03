// Client for the update API (/api/update).

import { authHeaders } from './auth'

export type UpdateInfo = {
  current: string
  latest: string | null
  updateAvailable: boolean
  notes?: string | null
  released?: string | null
  size?: number | null
  arch?: string
  supported?: boolean
  canInstall?: boolean
  checkedAt?: string
  cached?: boolean
  error?: string
}

export type UpdateStatus = {
  state: 'idle' | 'checking' | 'downloading' | 'installing' | 'done' | 'error'
  message?: string
  from?: string
  to?: string
  at?: string
  log?: string
}

async function req(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...authHeaders() } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const updateapi = {
  check: (force = false): Promise<UpdateInfo> => req(`/api/update/check${force ? '?force=1' : ''}`),
  status: (): Promise<UpdateStatus> => req('/api/update/status'),
  apply: (): Promise<{ ok: boolean; message: string }> =>
    req('/api/update/apply', { method: 'POST', body: '{}' }),
}
