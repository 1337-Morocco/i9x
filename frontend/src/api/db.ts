import { authHeaders } from './auth'

// Managed databases, any engine. The backend is engine-agnostic (see
// dbengines.js) and tells us per instance whether it has a table browser
// ('sql'), a CLI console ('console'), or neither.

export type DbBrowse = 'sql' | 'console' | null

export type Db = {
  name: string
  engine: string
  engineLabel: string
  kind: 'sql' | 'kv' | 'document'
  browse: DbBrowse
  consoleHint: string
  canDump: boolean
  version: string
  dbName: string
  dbUser: string
  dbPass: string
  port: number
  created: number
  status: 'running' | 'stopped' | 'provisioning' | 'failed' | 'unknown'
  host: string
  uri: string
  localHost: string
  localUri: string
  container: string
}

export type DbEngine = {
  id: string
  label: string
  kind: 'sql' | 'kv' | 'document'
  versions: string[]
  defaultVersion: string
  fields: { dbName: boolean; dbUser: boolean; password: boolean }
  defaultUser: string
  browse: DbBrowse
  consoleHint: string
  canDump: boolean
  defaultPort: number
}

export type DbTable = { schema: string; name: string; rows: number }
export type DbColumn = { name: string; type: string }
export type DbRow = Record<string, unknown>

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const dbapi = {
  engines: (): Promise<{ engines: DbEngine[] }> => req('/api/db/engines'),
  dbs: (): Promise<{ dbs: Db[] }> => req('/api/db/dbs'),
  create: (d: { name: string; engine: string; version: string; dbName?: string; dbUser?: string; password?: string; port?: number }) =>
    req('/api/db/dbs', { method: 'POST', body: JSON.stringify(d) }),
  action: (name: string, action: 'start' | 'stop' | 'restart' | 'reprovision' | 'remove', deleteData?: boolean) =>
    req('/api/db/action', { method: 'POST', body: JSON.stringify({ name, action, deleteData }) }),
  log: (name: string): Promise<{ text: string; state: string }> =>
    req(`/api/db/log?name=${encodeURIComponent(name)}`),
  logs: (name: string): Promise<{ text: string }> =>
    req(`/api/db/logs?name=${encodeURIComponent(name)}`),
  tables: (name: string): Promise<{ tables: DbTable[] }> =>
    req(`/api/db/tables?name=${encodeURIComponent(name)}`),
  table: (name: string, schema: string, tbl: string, limit = 100, offset = 0): Promise<{ columns: DbColumn[]; rows: DbRow[]; total: number | null; limit: number; offset: number }> =>
    req(`/api/db/table?name=${encodeURIComponent(name)}&schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(tbl)}&limit=${limit}&offset=${offset}`),
  query: (name: string, sql: string): Promise<{ rows?: DbRow[]; columns?: string[]; message?: string }> =>
    req('/api/db/query', { method: 'POST', body: JSON.stringify({ name, sql }) }),
  // Dumps stream as a file download, so this hands back a URL rather than JSON.
  dumpUrl: (name: string) => `/api/db/dump?name=${encodeURIComponent(name)}`,
}

// Download a dump with the auth header attached (a plain <a href> can't set one).
export async function downloadDump(name: string) {
  const r = await fetch(dbapi.dumpUrl(name), { headers: authHeaders() })
  if (!r.ok) {
    let msg = 'dump failed'
    try { msg = (await r.json()).error || msg } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const blob = await r.blob()
  const cd = r.headers.get('Content-Disposition') || ''
  const match = cd.match(/filename="([^"]+)"/)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = match ? match[1] : `${name}-dump`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
