// Auth token management + client for /api/auth.

// Carry over the pre-2.0 `weblinux_token` key once, so the rename doesn't log
// every open browser out.
let token: string | null = localStorage.getItem('i9x_token')
if (!token) {
  const legacy = localStorage.getItem('weblinux_token')
  if (legacy) {
    localStorage.setItem('i9x_token', legacy)
    localStorage.removeItem('weblinux_token')
    token = legacy
  }
}

export function getToken(): string | null {
  return token
}
export function setToken(t: string | null) {
  token = t
  if (t) localStorage.setItem('i9x_token', t)
  else localStorage.removeItem('i9x_token')
}
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function post(url: string, body: unknown) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'Request failed')
  return d
}

export type AuthUser = { token: string; email: string; name: string }

export const authapi = {
  status: (): Promise<{ setup: boolean }> => fetch('/api/auth/status').then((r) => r.json()),
  me: async (): Promise<{ email: string; name: string }> => {
    const r = await fetch('/api/auth/me', { headers: authHeaders() })
    if (!r.ok) throw new Error('unauthenticated')
    return r.json()
  },
  login: (email: string, password: string): Promise<AuthUser> =>
    post('/api/auth/login', { email, password }),
  register: (email: string, password: string, name: string): Promise<AuthUser> =>
    post('/api/auth/register', { email, password, name }),
  logout: () => fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }),
}
