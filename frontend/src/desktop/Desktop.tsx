import { useState, useEffect, useCallback, useRef } from 'react'
import { FiLogOut, FiGrid, FiX } from 'react-icons/fi'
import Window from './Window'
import type { AppId, WinState, AppApi } from './types'
import FileManager from '../apps/FileManager'
import TextEditor from '../apps/TextEditor'
import TaskManager from '../apps/TaskManager'
import Settings, { type SettingsPane } from '../apps/Settings'
import System from '../apps/System'
import Docker from '../apps/Docker'
import WordPress from '../apps/WordPress'
import Websites from '../apps/Websites'
import Deploy from '../apps/Deploy'
import Databases from '../apps/Databases'
import Tasks from '../apps/Tasks'
import Maintenance from '../apps/Maintenance'
import Domains from '../apps/Domains'
import VsCode from '../apps/VsCode'
import I9xTerminal from '../Terminal'
import DesktopIcons from './DesktopIcons'
import { getWallpaper, onWallpaperChange, wallpaperCss } from './wallpaper'
import { getTheme, onThemeChange } from './theme'
import { updateapi } from '../api/update'

// Icons are Papirus SVGs served from /public/icons.
const APP_META: Record<AppId, { title: string; icon: string; w: number; h: number; chromeless?: boolean }> = {
  files: { title: 'Files', icon: '/icons/files.svg', w: 900, h: 580, chromeless: true },
  editor: { title: 'Text Editor', icon: '/icons/editor.svg', w: 660, h: 460 },
  terminal: { title: 'Terminal', icon: '/icons/terminal.svg', w: 720, h: 440, chromeless: true },
  taskmanager: { title: 'Task Manager', icon: '/icons/taskmanager.svg', w: 720, h: 560 },
  settings: { title: 'Settings', icon: '/icons/settings.svg', w: 720, h: 520 },
  vscode: { title: 'VS Code', icon: '/icons/vscode.svg', w: 1040, h: 700 },
  system: { title: 'System', icon: '/icons/system.svg', w: 820, h: 600 },
  docker: { title: 'Docker', icon: '/icons/docker.svg', w: 860, h: 620 },
  wordpress: { title: 'WordPress', icon: '/icons/wordpress.svg', w: 860, h: 620 },
  websites: { title: 'Static Websites', icon: '/icons/websites.svg', w: 820, h: 600 },
  deploy: { title: 'Deploy', icon: '/icons/deploy.svg', w: 880, h: 640 },
  databases: { title: 'Databases', icon: '/icons/databases.svg', w: 900, h: 640 },
  // Wide enough for the nginx configuration panel's nav + form + preview.
  domains: { title: 'Domains & Proxy', icon: '/icons/domains.svg', w: 1020, h: 700 },
  tasks: { title: 'Scheduled Tasks', icon: '/icons/tasks.svg', w: 900, h: 620 },
  maintenance: { title: 'Cleanup & Disk', icon: '/icons/maintenance.svg', w: 940, h: 660 },
}
// Pinned shortcuts kept in the dock. Everything else lives in the app menu.
// Text Editor is launched by opening a file — not shown in either.
const DOCK_APPS: AppId[] = ['files', 'terminal', 'deploy']
// Services surfaced through the app-launcher menu.
const MENU_APPS: AppId[] = ['vscode', 'websites', 'wordpress', 'databases', 'domains', 'tasks', 'maintenance', 'docker', 'system', 'taskmanager', 'settings']
// Every service, laid out on the wallpaper. Same set as the dock plus the menu,
// so nothing is reachable only by digging through the launcher. Text Editor is
// excluded — it has no meaning without a file to open.
const DESKTOP_APPS: AppId[] = [...DOCK_APPS, ...MENU_APPS]

let nextId = 1
let zCounter = 10 // monotonically increasing stacking order

export default function Desktop({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [wins, setWins] = useState<WinState[]>([])
  const [launching, setLaunching] = useState<AppId | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [wallpaper, setWp] = useState(getWallpaper())
  const [theme, setThemeState] = useState(getTheme())
  const [newVersion, setNewVersion] = useState<string | null>(null)
  const bootstrapped = useRef(false)

  useEffect(() => onWallpaperChange(() => setWp(getWallpaper())), [])
  useEffect(() => onThemeChange(() => setThemeState(getTheme())), [])
  // Tell the user a new release exists without making them go looking for it.
  // The backend caches the answer, so this costs nothing on repeat logins; the
  // dismissal is remembered per version so we only nag once per release.
  useEffect(() => {
    updateapi
      .check()
      .then((info) => {
        if (info.updateAvailable && info.latest && localStorage.getItem('i9x.updateSeen') !== info.latest) {
          setNewVersion(info.latest)
        }
      })
      .catch(() => { /* offline or unreachable — stay quiet */ })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const focus = useCallback((id: number) => {
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, z: ++zCounter, minimized: false } : w)))
  }, [])

  // Create the window immediately.
  const spawn = useCallback((app: AppId, opts?: { title?: string; payload?: unknown }) => {
    const meta = APP_META[app]
    const id = nextId++
    setWins((ws) => {
      const offset = (ws.length % 6) * 30
      return [
        ...ws,
        {
          id, app,
          title: opts?.title || meta.title,
          x: 120 + offset,
          y: 40 + offset,
          w: meta.w,
          h: meta.h,
          z: ++zCounter,
          minimized: false,
          maximized: false,
          chromeless: meta.chromeless,
          payload: opts?.payload,
        },
      ]
    })
  }, [])

  // Public open: flash the dock spinner, then spawn the window. Kept short —
  // apps now render loading placeholders, so the window is useful immediately.
  const open = useCallback((app: AppId, opts?: { title?: string; payload?: unknown }) => {
    setLaunching(app)
    window.setTimeout(() => {
      spawn(app, opts)
      setLaunching(null)
    }, 320)
  }, [spawn])

  const close = (id: number) => setWins((ws) => ws.filter((w) => w.id !== id))
  const update = (id: number, patch: Partial<WinState>) =>
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)))

  // Drag handler shared with chromeless apps that render their own header.
  const startDrag = (w: WinState, e: React.MouseEvent) => {
    if (w.maximized) return
    focus(w.id)
    const sx = e.clientX
    const sy = e.clientY
    const ox = w.x
    const oy = w.y
    const move = (ev: MouseEvent) =>
      update(w.id, { x: Math.max(0, ox + ev.clientX - sx), y: Math.max(0, oy + ev.clientY - sy) })
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    open('files')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeId = wins.reduce(
    (top, w) => (!w.minimized && w.z > (wins.find((x) => x.id === top)?.z ?? -1) ? w.id : top),
    -1
  )

  const renderApp = (w: WinState) => {
    const app: AppApi = {
      win: w,
      setTitle: (t) => update(w.id, { title: t }),
      close: () => close(w.id),
      minimize: () => update(w.id, { minimized: true }),
      toggleMax: () => update(w.id, { maximized: !w.maximized }),
      startDrag: (e) => startDrag(w, e),
      open,
    }
    switch (w.app) {
      case 'files':
        return <FileManager api={app} />
      case 'editor':
        return <TextEditor api={app} />
      case 'terminal':
        return <I9xTerminal api={app} />
      case 'taskmanager':
        return <TaskManager />
      case 'settings':
        return <Settings pane={(w.payload as { pane?: SettingsPane } | undefined)?.pane} />
      case 'vscode':
        return <VsCode />
      case 'system':
        return <System />
      case 'docker':
        return <Docker />
      case 'wordpress':
        return <WordPress />
      case 'websites':
        return <Websites />
      case 'deploy':
        return <Deploy />
      case 'databases':
        return <Databases />
      case 'domains':
        return <Domains />
      case 'tasks':
        return <Tasks />
      case 'maintenance':
        return <Maintenance />
    }
  }

  // Clicking a dock icon focuses an existing window of that app, else launches.
  const dockClick = (app: AppId) => {
    const existing = wins.filter((w) => w.app === app)
    if (existing.length === 0) return open(app)
    const active = existing.find((w) => w.id === activeId)
    if (active) update(active.id, { minimized: true })
    else focus(existing.sort((a, b) => b.z - a.z)[0].id)
  }

  return (
    <div className={`desktop ${theme}`} style={{ background: wallpaperCss(wallpaper) }}>
      {/* Top-right user pill */}
      <div className="userpill">
        <span className="userpill-name">{username}</span>
        <button className="userpill-out" title="Log out" onClick={onLogout}><FiLogOut size={15} /></button>
      </div>

      {/* New release available — click through to Settings → Updates */}
      {newVersion && (
        <div className="update-toast">
          <span className="update-toast-dot" />
          <span>i9x <b>{newVersion}</b> is available</span>
          <button
            className="update-toast-go"
            onClick={() => { open('settings', { payload: { pane: 'updates' } }); setNewVersion(null) }}
          >
            Update
          </button>
          <button
            className="update-toast-x"
            title="Dismiss"
            onClick={() => { localStorage.setItem('i9x.updateSeen', newVersion); setNewVersion(null) }}
          >
            <FiX size={14} />
          </button>
        </div>
      )}

      {/* Service icons */}
      <DesktopIcons
        apps={DESKTOP_APPS.map((a) => ({ id: a, title: APP_META[a].title, icon: APP_META[a].icon }))}
        running={new Set(wins.map((w) => w.app))}
        open={open}
      />

      {/* Windows */}
      {wins.map((w) => (
        <Window
          key={w.id}
          win={w}
          active={w.id === activeId}
          onFocus={() => focus(w.id)}
          onClose={() => close(w.id)}
          onMinimize={() => update(w.id, { minimized: true })}
          onToggleMax={() => update(w.id, { maximized: !w.maximized })}
          onMove={(x, y) => update(w.id, { x, y })}
          onResize={(width, h) => update(w.id, { w: width, h })}
        >
          {renderApp(w)}
        </Window>
      ))}

      {/* Full-screen app launcher (Launchpad-style) */}
      {menuOpen && (
        <div className="launchpad" role="dialog" aria-label="Applications" onClick={() => setMenuOpen(false)}>
          <button className="launchpad-close" title="Close" onClick={() => setMenuOpen(false)}>
            <FiX size={20} />
          </button>
          <div className="launchpad-grid" onClick={(e) => e.stopPropagation()}>
            {MENU_APPS.map((a) => {
              const running = wins.some((w) => w.app === a)
              return (
                <button
                  key={a}
                  className={`launchpad-app ${running ? 'running' : ''}`}
                  onClick={() => { dockClick(a); setMenuOpen(false) }}
                >
                  <img src={APP_META[a].icon} alt="" />
                  <span>{APP_META[a].title}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Left dock */}
      <div className="ldock">
        <button
          className={`ldock-menu ${menuOpen ? 'open' : ''}`}
          title="Applications"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <FiGrid size={22} />
        </button>
        <div className="ldock-sep" />
        {DOCK_APPS.map((a) => {
          const running = wins.some((w) => w.app === a)
          return (
            <button
              key={a}
              className={`ldock-app ${running ? 'running' : ''}`}
              title={APP_META[a].title}
              onClick={() => dockClick(a)}
            >
              <img src={APP_META[a].icon} alt={APP_META[a].title} />
              {launching === a && <span className="ldock-spin" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
