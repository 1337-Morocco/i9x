import { authHeaders } from './auth'

export type Container = {
  ID: string; Image: string; Names: string; Status: string; State: string; Ports: string; CreatedAt: string
}
export type Image = { Repository: string; Tag: string; ID: string; Size: string; CreatedSince: string }

async function get(url: string) {
  const r = await fetch(url, { headers: authHeaders() })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}
async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const dockerapi = {
  status: (): Promise<{ installed: boolean; running: boolean; version?: string; error?: string }> => get('/api/docker/status'),
  containers: (): Promise<{ containers: Container[] }> => get('/api/docker/containers'),
  images: (): Promise<{ images: Image[] }> => get('/api/docker/images'),
  container: (id: string, action: string) => post('/api/docker/container', { id, action }),
  removeImage: (id: string) => post('/api/docker/image/remove', { id }),
  pull: (image: string) => post('/api/docker/pull', { image }),
  run: (image: string, name: string, ports: string) => post('/api/docker/run', { image, name, ports }),
  logs: (id: string): Promise<{ text: string }> => get(`/api/docker/logs?id=${encodeURIComponent(id)}&lines=400`),
  build: (path: string, tag: string) => post('/api/docker/build', { path, tag }),
}
