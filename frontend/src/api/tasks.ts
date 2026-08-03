import { authHeaders } from './auth'

// Scheduled tasks: cron jobs executed inside an app/database container, any
// container, or on the host, with a recorded run history.

export type TaskTargetType = 'app' | 'database' | 'container' | 'host'

export type Task = {
  id: number
  name: string
  targetType: TaskTargetType
  target: string
  command: string
  schedule: string
  enabled: boolean
  timeout: number
  running: boolean
  lastRun: number | null
  nextRun: number | null
  lastStatus: 'success' | 'failed' | 'timeout' | 'running' | null
  lastRunId: number | null
  scheduleValid: boolean
  created: number
}

export type TaskRun = {
  id: number
  taskId: number
  trigger: 'schedule' | 'manual' | 'api'
  status: 'running' | 'success' | 'failed' | 'timeout'
  exitCode: number | null
  started: number
  finished: number | null
  output?: string
  bytes?: number
}

export type CronPreset = { label: string; expr: string }

export type TaskInput = {
  name: string
  targetType: TaskTargetType
  target: string
  command: string
  schedule: string
  timeout: number
  enabled?: boolean
}

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const tasksapi = {
  list: (): Promise<{ tasks: Task[]; presets: CronPreset[]; targets: { app: string[]; database: string[] } }> =>
    req('/api/tasks'),
  create: (t: TaskInput): Promise<{ ok: boolean; task: Task }> =>
    req('/api/tasks', { method: 'POST', body: JSON.stringify(t) }),
  update: (id: number, t: TaskInput): Promise<{ ok: boolean; task: Task }> =>
    req(`/api/tasks/${id}`, { method: 'POST', body: JSON.stringify(t) }),
  toggle: (id: number): Promise<{ ok: boolean; task: Task }> =>
    req(`/api/tasks/${id}/toggle`, { method: 'POST' }),
  run: (id: number): Promise<{ ok: boolean; runId?: number; status?: string; skipped?: string }> =>
    req(`/api/tasks/${id}/run`, { method: 'POST' }),
  remove: (id: number) => req(`/api/tasks/${id}`, { method: 'DELETE' }),
  runs: (id: number): Promise<{ runs: TaskRun[] }> => req(`/api/tasks/${id}/runs`),
  run1: (runId: number): Promise<{ run: TaskRun }> => req(`/api/tasks/runs/${runId}`),
}
