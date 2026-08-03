import { authHeaders } from './auth'

// Docker cleanup + the disk guard.

export type CleanupSettings = {
  enabled: boolean
  schedule: string
  images: boolean
  buildCache: boolean
  containers: boolean
  networks: boolean
  volumes: boolean
  buildLogDays: number
  diskThreshold: number
  autoCleanOnThreshold: boolean
}

export type Disk = {
  path: string
  filesystem: string
  total: number
  used: number
  avail: number
  percent: number
}

export type DockerUsage = {
  type: string
  count: number
  active: number
  size: string
  reclaimable: string
  reclaimableBytes: number
}

export type CleanupRun = {
  id: number
  trigger: 'schedule' | 'manual' | 'threshold' | 'api'
  status: 'running' | 'success' | 'failed'
  started: number
  finished: number | null
  reclaimed: number
  output?: string
}

export type DiskAlert = {
  since: number
  at: number
  lastClean: number
  percent: number
  path: string
  threshold: number
  avail: number
}

export type MaintenanceStatus = {
  settings: CleanupSettings
  disk: { disks: Disk[]; worst: Disk | null; dockerRoot: string }
  docker: DockerUsage[]
  reclaimable: number
  alert: DiskAlert | null
  running: boolean
  nextRun: number | null
  runs: CleanupRun[]
  presets: { label: string; expr: string }[]
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const maintapi = {
  status: (): Promise<MaintenanceStatus> => req('/api/maintenance/status'),
  save: (s: Partial<CleanupSettings>): Promise<{ ok: boolean; settings: CleanupSettings; nextRun: number | null }> =>
    req('/api/maintenance/settings', { method: 'POST', body: JSON.stringify(s) }),
  run: (): Promise<{ id?: number; run?: CleanupRun; busy?: boolean }> =>
    req('/api/maintenance/run', { method: 'POST', body: '{}' }),
  runs: (): Promise<{ runs: CleanupRun[] }> => req('/api/maintenance/runs'),
  run1: (id: number): Promise<{ run: CleanupRun }> => req(`/api/maintenance/runs/${id}`),
}

export function fmtBytes(n: number | null | undefined) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}
