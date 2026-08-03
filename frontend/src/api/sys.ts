// Client for the system-monitor API (/api/sys).

export type Stats = {
  hostname: string
  platform: string
  release: string
  uptime: number
  cores: number
  cpuModel: string
  cpu: number | null
  load: number[]
  mem: { total: number; free: number; used: number }
}

export type Proc = {
  pid: number
  cpu: number
  mem: number
  rss: number
  name: string
  command: string
}

import { authHeaders } from './auth'

export type Service = { unit: string; load: string; active: string; sub: string; description: string }
export type Iface = { name: string; state: string; addrs: { local: string; family: string }[]; rx: number; tx: number }
export type Conn = { proto: string; state: string; local: string; peer: string; proc: string }

async function get(url: string) {
  const r = await fetch(url, { headers: authHeaders() })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const sysapi = {
  stats: (): Promise<Stats> => fetch('/api/sys/stats', { headers: authHeaders() }).then((r) => r.json()),
  processes: (): Promise<{ processes: Proc[] }> =>
    fetch('/api/sys/processes', { headers: authHeaders() }).then((r) => r.json()),

  services: (): Promise<{ services: Service[] }> => get('/api/sys/services'),
  serviceAction: (unit: string, action: string) =>
    fetch('/api/sys/service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ unit, action }),
    }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d }),

  net: (): Promise<{ interfaces: Iface[]; connections: Conn[] }> => get('/api/sys/net'),
  log: (source: string, lines = 300): Promise<{ text: string }> =>
    get(`/api/sys/log?source=${encodeURIComponent(source)}&lines=${lines}`),
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
