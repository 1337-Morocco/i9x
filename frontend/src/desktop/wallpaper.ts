// Wallpaper store — persisted in localStorage with a tiny pub/sub so the
// Settings app can change it and the Desktop re-renders.

export type Wallpaper = { type: 'gradient' | 'image'; value: string; name?: string }

const KEY = 'i9x_wallpaper'

export const PRESETS: Wallpaper[] = [
  {
    name: 'Ubuntu',
    type: 'gradient',
    value:
      'radial-gradient(130% 130% at 100% 100%, #ff5c2b 0%, rgba(255,92,43,0) 46%), linear-gradient(135deg, #5b1747 0%, #7a1e52 28%, #b02a5b 54%, #e04f2f 84%, #f47421 100%)',
  },
  { name: 'Aurora', type: 'gradient', value: 'linear-gradient(135deg, #3a1c71 0%, #5f2c82 40%, #2193b0 100%)' },
  { name: 'Sunset', type: 'gradient', value: 'linear-gradient(135deg, #ff512f 0%, #dd2476 55%, #7b2ff7 100%)' },
  { name: 'Ocean', type: 'gradient', value: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { name: 'Forest', type: 'gradient', value: 'linear-gradient(135deg, #134e5e 0%, #2c7744 60%, #71b280 100%)' },
  { name: 'Grape', type: 'gradient', value: 'linear-gradient(135deg, #41295a 0%, #722f6b 50%, #2f0743 100%)' },
  { name: 'Peach', type: 'gradient', value: 'linear-gradient(135deg, #ee9ca7 0%, #ff8177 50%, #b24592 100%)' },
  { name: 'Graphite', type: 'gradient', value: 'linear-gradient(135deg, #232526 0%, #414345 100%)' },
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
    ? `#141018 center / 100% 100% no-repeat url("${wp.value}")`
    : wp.value
}
