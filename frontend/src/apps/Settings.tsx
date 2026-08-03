import { useState } from 'react'
import { FiImage, FiCheck, FiSun, FiMoon } from 'react-icons/fi'
import { PRESETS, getWallpaper, setWallpaper, wallpaperCss, type Wallpaper } from '../desktop/wallpaper'
import { getTheme, setTheme, type Theme } from '../desktop/theme'
import { rawUrl } from '../api/fs'
import Updates from './Updates'
import Tokens from './Tokens'

export type SettingsPane = 'appearance' | 'updates' | 'tokens'

// Settings app: appearance (theme + wallpaper), software updates and API tokens.
export default function Settings({ pane: initialPane }: { pane?: SettingsPane } = {}) {
  const [pane, setPane] = useState<SettingsPane>(initialPane || 'appearance')
  const [current, setCurrent] = useState<Wallpaper>(getWallpaper())
  const [theme, setThemeState] = useState<Theme>(getTheme())
  const [imgPath, setImgPath] = useState('')

  const pickTheme = (t: Theme) => { setTheme(t); setThemeState(t) }

  const apply = (wp: Wallpaper) => {
    setWallpaper(wp)
    setCurrent(wp)
  }

  const applyImage = () => {
    const p = imgPath.trim()
    if (!p.startsWith('/')) return
    apply({ type: 'image', value: rawUrl(p), name: p.split('/').pop() })
  }

  const isActive = (wp: Wallpaper) => current.type === wp.type && current.value === wp.value

  return (
    <div className="settings">
      <div className="settings-side">
        <div className={`settings-nav ${pane === 'appearance' ? 'active' : ''}`} onClick={() => setPane('appearance')}>
          🖼 Appearance
        </div>
        <div className={`settings-nav ${pane === 'updates' ? 'active' : ''}`} onClick={() => setPane('updates')}>
          ⬆ Updates
        </div>
        <div className={`settings-nav ${pane === 'tokens' ? 'active' : ''}`} onClick={() => setPane('tokens')}>
          🔑 API tokens
        </div>
      </div>
      {pane === 'updates' ? <Updates /> : pane === 'tokens' ? <Tokens /> : (
      <div className="settings-main">
        <h2 className="settings-h">Theme</h2>
        <p className="settings-desc">Choose light or dark for the whole desktop.</p>
        <div className="theme-toggle">
          <button className={theme === 'light' ? 'on' : ''} onClick={() => pickTheme('light')}>
            <FiSun /> Light
          </button>
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => pickTheme('dark')}>
            <FiMoon /> Dark
          </button>
        </div>

        <h2 className="settings-h" style={{ marginTop: 28 }}>Wallpaper</h2>
        <p className="settings-desc">Choose a background for your desktop.</p>

        <div className="wp-grid">
          {PRESETS.map((wp) => (
            <button
              key={wp.name}
              className={`wp-swatch ${isActive(wp) ? 'active' : ''}`}
              style={{ background: wallpaperCss(wp) }}
              onClick={() => apply(wp)}
              title={wp.name}
            >
              {isActive(wp) && <span className="wp-swatch-check"><FiCheck /></span>}
              <span className="wp-name">{wp.name}</span>
            </button>
          ))}
        </div>

        <h3 className="settings-h3"><FiImage /> Custom image</h3>
        <p className="settings-desc">Use any image file on the machine as your wallpaper.</p>
        <div className="wp-custom">
          <input
            placeholder="/home/user/Pictures/photo.jpg"
            value={imgPath}
            onChange={(e) => setImgPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyImage()}
          />
          <button onClick={applyImage} disabled={!imgPath.trim().startsWith('/')}>Apply</button>
        </div>
        <p className="settings-hint">Tip: right-click an image in Files → “Set as wallpaper”.</p>
      </div>
      )}
    </div>
  )
}
