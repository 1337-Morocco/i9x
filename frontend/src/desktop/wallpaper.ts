// Wallpaper store — persisted in localStorage with a tiny pub/sub so the
// Settings app can change it and the Desktop re-renders.

export type Wallpaper = { type: 'gradient' | 'image'; value: string; name?: string }

const KEY = 'i9x_wallpaper'

// Deep, low-saturation fields. Window chrome sits on top of these, so they stay
// dark and quiet — a busy wallpaper makes every panel above it harder to read.
export const PRESETS: Wallpaper[] = [
  {
    name: 'Midnight',
    type: 'gradient',
    value:
      'radial-gradient(120% 120% at 15% 0%, #1e293b 0%, rgba(30,41,59,0) 55%), linear-gradient(160deg, #0f172a 0%, #020617 100%)',
  },
  {
    name: 'Indigo',
    type: 'gradient',
    value:
      'radial-gradient(120% 110% at 85% 10%, #312e81 0%, rgba(49,46,129,0) 58%), linear-gradient(160deg, #1e1b4b 0%, #020617 100%)',
  },
  {
    name: 'Slate',
    type: 'gradient',
    value: 'linear-gradient(160deg, #334155 0%, #1e293b 45%, #0f172a 100%)',
  },
  {
    name: 'Teal',
    type: 'gradient',
    value:
      'radial-gradient(120% 120% at 10% 100%, #0f766e 0%, rgba(15,118,110,0) 52%), linear-gradient(160deg, #0f172a 0%, #042f2e 100%)',
  },
  {
    name: 'Plum',
    type: 'gradient',
    value:
      'radial-gradient(120% 120% at 90% 100%, #6b21a8 0%, rgba(107,33,168,0) 52%), linear-gradient(160deg, #1e1b4b 0%, #0f172a 100%)',
  },
  {
    name: 'Ember',
    type: 'gradient',
    value:
      'radial-gradient(120% 120% at 100% 100%, #9a3412 0%, rgba(154,52,18,0) 48%), linear-gradient(160deg, #1c1917 0%, #0c0a09 100%)',
  },
  {
    name: 'Daylight',
    type: 'gradient',
    value:
      'radial-gradient(120% 120% at 20% 0%, #e0e7ff 0%, rgba(224,231,255,0) 55%), linear-gradient(160deg, #f1f5f9 0%, #cbd5e1 100%)',
  },
  { name: 'Carbon', type: 'gradient', value: 'linear-gradient(160deg, #262626 0%, #0a0a0a 100%)' },
]

const DEFAULT = PRESETS[0]
const listeners = new Set<() => void>()

export function getWallpaper(): Wallpaper {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return DEFAULT
}

export function setWallpaper(wp: Wallpaper) {
  localStorage.setItem(KEY, JSON.stringify(wp))
  listeners.forEach((l) => l())
}

export function onWallpaperChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Produce the CSS `background` value for a wallpaper.
// Images fill the whole screen (100% 100% = fit to screen, no crop/zoom).
export function wallpaperCss(wp: Wallpaper): string {
  return wp.type === 'image'
    ? `#020617 center / 100% 100% no-repeat url("${wp.value}")`
    : wp.value
}
