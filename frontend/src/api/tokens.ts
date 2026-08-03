import { authHeaders } from './auth'

// API tokens for scripts and CI. The plaintext token is returned exactly once,
// by create() — after that only the prefix is ever shown.

export type ApiToken = {
  id: number
  name: string
  scope: 'read' | 'write'
  prefix: string
  created: number
  lastUsed: number | null
  expires: number | null
  expired: boolean
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const tokensapi = {
  list: (): Promise<{ tokens: ApiToken[] }> => req('/api/tokens'),
  create: (name: string, scope: 'read' | 'write', expiresDays?: number): Promise<{ token: string; record: ApiToken }> =>
    req('/api/tokens', { method: 'POST', body: JSON.stringify({ name, scope, expiresDays }) }),
  remove: (id: number) => req(`/api/tokens/${id}`, { method: 'DELETE' }),
}
