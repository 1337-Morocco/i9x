import { authHeaders } from './auth'
import { makeHostingApi, type Detection } from './hosting'

// Unified deployment API: the shared hosting methods plus framework detection.
export const deployapi = {
  ...makeHostingApi('deploy'),
  detect: async (repo: string): Promise<Detection> => {
    const r = await fetch(`/api/deploy/detect?repo=${encodeURIComponent(repo)}`, { headers: { ...authHeaders() } })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'detect failed')
    return d
  },
}
