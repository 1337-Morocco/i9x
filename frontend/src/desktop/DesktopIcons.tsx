import { useEffect, useState, useCallback } from 'react'
import { FaFolder } from 'react-icons/fa6'
import { FiFile } from 'react-icons/fi'
import { fsapi, joinPath, rawUrl, isImage, type Entry } from '../api/fs'
import type { AppApi } from './types'

// Renders the contents of the user's ~/Desktop folder as icons on the
// wallpaper. Refreshes whenever the filesystem changes (via the fs event).
export default function DesktopIcons({ open }: { open: AppApi['open'] }) {
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [sel, setSel] = useState('')

  const load = useCallback(async () => {
    try {
      const h = await fsapi.home()
      const d = joinPath(h.home, 'Desktop')
      const res = await fsapi.list(d)
      setDir(res.path)
      setEntries(res.entries.filter((e) => !e.hidden))
    } catch {
      setEntries([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await fsapi.home()
        await fsapi.mkdir(joinPath(h.home, 'Desktop')) // ensure it exists (idempotent)
      } catch { /* ignore */ }
      if (!cancelled) load()
    })()
    window.addEventListener('i9x:fs', load)
    return () => { cancelled = true; window.removeEventListener('i9x:fs', load) }
  }, [load])

  const openEntry = (e: Entry) => {
    const full = joinPath(dir, e.name)
    if (e.type === 'dir') open('files', { payload: full })
    else if (isImage(e.name)) open('files', { payload: dir })
    else open('editor', { title: e.name, payload: full })
  }

  if (entries.length === 0) return null

  return (
    <div className="desk-icons" onClick={() => setSel('')}>
      {entries.map((e) => {
        const full = joinPath(dir, e.name)
        return (
          <button
            key={e.name}
            className={`desk-icon ${sel === e.name ? 'sel' : ''}`}
            onClick={(ev) => { ev.stopPropagation(); setSel(e.name) }}
            onDoubleClick={() => openEntry(e)}
            title={e.name}
          >
            <span className="desk-ico">
              {e.type === 'dir' ? (
                <FaFolder size={46} className="desk-folder" />
              ) : isImage(e.name) ? (
                <img className="desk-thumb" src={rawUrl(full)} alt="" />
              ) : (
                <FiFile size={40} className="desk-file" />
              )}
            </span>
            <span className="desk-label">{e.name}</span>
          </button>
        )
      })}
    </div>
  )
}
