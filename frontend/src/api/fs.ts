// Client for the backend's real-filesystem API (/api/fs).

export type Entry = {
  name: string
  type: 'dir' | 'file'
  link?: boolean
  size: number
  mtime: number
  hidden: boolean
  unreadable?: boolean
}

export type Listing = { path: string; parent: string; entries: Entry[] }

import { authHeaders, getToken } from './auth'

async function req(url: string, opts?: RequestInit) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`)
  return data
}

// Broadcast that the filesystem changed so views (e.g. desktop icons) refresh.
function fireChange() {
  try { window.dispatchEvent(new Event('i9x:fs')) } catch { /* ignore */ }
}
const tap = <T,>(r: T): T => { fireChange(); return r }

export const fsapi = {
  home: (): Promise<{ home: string; sep: string }> => req('/api/fs/home'),

  list: (path: string): Promise<Listing> =>
    req(`/api/fs/list?path=${encodeURIComponent(path)}`),

  read: (path: string): Promise<{ path: string; content: string; mtime: number }> =>
    req(`/api/fs/read?path=${encodeURIComponent(path)}`),

  write: (path: string, content: string) =>
    req('/api/fs/write', { method: 'POST', body: JSON.stringify({ path, content }) }).then(tap),

  mkdir: (path: string) =>
    req('/api/fs/mkdir', { method: 'POST', body: JSON.stringify({ path }) }).then(tap),

  touch: (path: string) =>
    req('/api/fs/touch', { method: 'POST', body: JSON.stringify({ path }) }).then(tap),

  rename: (from: string, to: string) =>
    req('/api/fs/rename', { method: 'POST', body: JSON.stringify({ from, to }) }).then(tap),

  remove: (path: string) =>
    req('/api/fs/delete', { method: 'POST', body: JSON.stringify({ path }) }).then(tap),

  // Upload a browser File to an absolute destination path.
  upload: async (destPath: string, file: File | Blob) => {
    const res = await fetch(`/api/fs/upload?path=${encodeURIComponent(destPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...authHeaders() },
      body: file,
    })
    const d = await res.json()
    if (!res.ok) throw new Error(d.error || 'upload failed')
    return tap(d)
  },
}

// Join a directory path and a child name (POSIX).
export function joinPath(dir: string, name: string): string {
  if (dir === '/') return '/' + name
  return dir.replace(/\/$/, '') + '/' + name
}

// URL to stream a raw file from the backend (for image thumbnails/previews).
// The token goes in the query string since <img> can't send headers.
export function rawUrl(path: string): string {
  const t = getToken()
  return `/api/fs/raw?path=${encodeURIComponent(path)}${t ? `&token=${t}` : ''}`
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']
export function isImage(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  return IMAGE_EXT.includes(ext)
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}
