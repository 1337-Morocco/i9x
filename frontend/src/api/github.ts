import { authHeaders } from './auth'

export type GitHubRepo = {
  fullName: string
  name: string
  private: boolean
  defaultBranch: string
  cloneUrl: string
  pushedAt: string
}

export type GitHubStatus = { connected: boolean; login?: string }

async function req(url: string, opts?: RequestInit) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(opts?.headers || {}) } })
  const d = await r.json()
  if (!r.ok) throw new Error(d.error || 'request failed')
  return d
}

export const githubapi = {
  status: (): Promise<GitHubStatus> => req('/api/github/status'),
  connect: (token: string): Promise<GitHubStatus> => req('/api/github/connect', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnect: (): Promise<GitHubStatus> => req('/api/github/disconnect', { method: 'POST' }),
  repos: (): Promise<{ repos: GitHubRepo[] }> => req('/api/github/repos'),
}

export type GitHubApi = typeof githubapi
