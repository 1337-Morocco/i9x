// Theme store (light / dark) — persisted in localStorage with pub/sub.
// Defaults to dark.

export type Theme = 'light' | 'dark'
const KEY = 'i9x_theme'
const listeners = new Set<() => void>()

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' ? 'light' : 'dark'
}
export function setTheme(t: Theme) {
  localStorage.setItem(KEY, t)
  listeners.forEach((l) => l())
}
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
