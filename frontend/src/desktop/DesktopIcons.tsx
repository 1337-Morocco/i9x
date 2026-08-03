import { useState } from 'react'
import type { AppApi, AppId } from './types'

export type DesktopApp = { id: AppId; title: string; icon: string }

// Renders every service as an icon on the wallpaper. Double-click launches,
// matching the dock and the launchpad — this used to list the contents of
// ~/Desktop instead, which meant the services were only reachable through the
// app menu.
export default function DesktopIcons({
  apps,
  running,
  open,
}: {
  apps: DesktopApp[]
  running: Set<AppId>
  open: AppApi['open']
}) {
  const [sel, setSel] = useState<AppId | ''>('')

  if (apps.length === 0) return null

  return (
    <div className="desk-icons" onClick={() => setSel('')}>
      {apps.map((a) => (
        <button
          key={a.id}
          className={`desk-icon ${sel === a.id ? 'sel' : ''} ${running.has(a.id) ? 'running' : ''}`}
          onClick={(ev) => { ev.stopPropagation(); setSel(a.id) }}
          onDoubleClick={() => open(a.id)}
          title={a.title}
        >
          <span className="desk-ico">
            <img className="desk-appico" src={a.icon} alt="" />
          </span>
          <span className="desk-label">{a.title}</span>
        </button>
      ))}
    </div>
  )
}
