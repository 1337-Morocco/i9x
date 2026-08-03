import { useEffect, useState, useCallback, useRef } from 'react'
import {
  FiClock, FiHome, FiMonitor, FiFileText, FiDownload, FiMusic, FiImage,
  FiFilm, FiTrash2, FiChevronLeft, FiChevronRight, FiX, FiMinus, FiSquare, FiFile,
  FiFolderPlus, FiFilePlus, FiGrid, FiList, FiSliders, FiArrowUp, FiArrowDown,
} from 'react-icons/fi'
import { FaFolder } from 'react-icons/fa6'
import type { IconType } from 'react-icons'
import { fsapi, joinPath, humanSize, rawUrl, isImage, type Entry } from '../api/fs'
import type { AppApi } from '../desktop/types'
import Modal, { type ModalSpec } from '../desktop/Modal'
import { setWallpaper } from '../desktop/wallpaper'

type Place = { label: string; Icon: IconType; sub: string }

// Map a special folder name to its icon (used in the breadcrumb).
const SPECIAL: Record<string, IconType> = {
  Desktop: FiMonitor, Documents: FiFileText, Downloads: FiDownload,
  Music: FiMusic, Pictures: FiImage, Videos: FiFilm,
}

// GNOME Files–style file manager over the real filesystem.
export default function FileManager({ api }: { api: AppApi }) {
  const [home, setHome] = useState('')
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: Entry } | null>(null)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'mtime' | 'type'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [sortOpen, setSortOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState<string>('')

  // In-app dialogs (replaces native prompt/confirm/alert).
  const [dialog, setDialog] = useState<ModalSpec | null>(null)
  const resolver = useRef<((v: string | null) => void) | null>(null)
  const ask = (spec: ModalSpec) =>
    new Promise<string | null>((res) => {
      resolver.current = res
      setDialog(spec)
    })
  const answer = (v: string | null) => {
    setDialog(null)
    resolver.current?.(v)
    resolver.current = null
  }
  const notify = (title: string, message: string) =>
    ask({ kind: 'alert', title, message, okText: 'OK' })

  const history = useRef<string[]>([])
  const hIndex = useRef(-1)
  const [, force] = useState(0)

  const list = useCallback(async (path: string) => {
    try {
      const res = await fsapi.list(path)
      setCwd(res.path)
      setEntries(res.entries)
      setError('')
      setSelected('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const go = useCallback(
    (path: string, push = true) => {
      if (push) {
        history.current = history.current.slice(0, hIndex.current + 1)
        history.current.push(path)
        hIndex.current = history.current.length - 1
        force((n) => n + 1)
      }
      list(path)
    },
    [list]
  )

  useEffect(() => {
    const start = (api.win.payload as string) || ''
    if (start) {
      setHome(start)
      go(start)
    } else {
      fsapi.home().then((h) => {
        setHome(h.home)
        go(h.home)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const places: Place[] = [
    { label: 'Recent', Icon: FiClock, sub: '' },
    { label: 'Home', Icon: FiHome, sub: '' },
    { label: 'Desktop', Icon: FiMonitor, sub: 'Desktop' },
    { label: 'Documents', Icon: FiFileText, sub: 'Documents' },
    { label: 'Downloads', Icon: FiDownload, sub: 'Downloads' },
    { label: 'Music', Icon: FiMusic, sub: 'Music' },
    { label: 'Pictures', Icon: FiImage, sub: 'Pictures' },
    { label: 'Videos', Icon: FiFilm, sub: 'Videos' },
    { label: 'Trash', Icon: FiTrash2, sub: '.local/share/Trash/files' },
  ]
  const placePath = (p: Place) => (p.sub ? joinPath(home, p.sub) : home)

  // Navigate to a sidebar place; offer to create the folder if it's missing.
  const goPlace = async (p: Place) => {
    const path = placePath(p)
    try {
      await fsapi.list(path)
      go(path)
    } catch {
      const ok = await ask({
        kind: 'confirm',
        title: `Create ${p.label} folder?`,
        message: `The "${p.label}" folder doesn't exist yet.`,
        okText: 'Create',
      })
      if (ok) {
        try { await fsapi.mkdir(path); go(path) } catch (e) { notify('Error', (e as Error).message) }
      }
    }
  }

  const openEntry = (e: Entry) => {
    const full = joinPath(cwd, e.name)
    if (e.type === 'dir') go(full)
    else if (!isImage(e.name)) api.open('editor', { title: e.name, payload: full })
  }

  const back = () => {
    if (hIndex.current > 0) { hIndex.current--; force((n) => n + 1); list(history.current[hIndex.current]) }
  }
  const forward = () => {
    if (hIndex.current < history.current.length - 1) { hIndex.current++; force((n) => n + 1); list(history.current[hIndex.current]) }
  }

  const newFolder = async () => {
    const name = await ask({ kind: 'prompt', title: 'New Folder', label: 'Folder name', placeholder: 'Untitled folder', okText: 'Create' })
    if (!name) return
    try { await fsapi.mkdir(joinPath(cwd, name)); list(cwd) } catch (e) { notify('Could not create folder', (e as Error).message) }
  }
  const newFile = async () => {
    const name = await ask({ kind: 'prompt', title: 'New File', label: 'File name', placeholder: 'untitled.txt', okText: 'Create' })
    if (!name) return
    try { await fsapi.touch(joinPath(cwd, name)); list(cwd) } catch (e) { notify('Could not create file', (e as Error).message) }
  }
  const renameEntry = async (e: Entry) => {
    const next = await ask({ kind: 'prompt', title: `Rename "${e.name}"`, label: 'New name', initial: e.name, okText: 'Rename' })
    if (!next || next === e.name) return
    try { await fsapi.rename(joinPath(cwd, e.name), joinPath(cwd, next)); list(cwd) } catch (err) { notify('Could not rename', (err as Error).message) }
  }
  const deleteEntry = async (e: Entry) => {
    const ok = await ask({ kind: 'confirm', title: `Delete "${e.name}"?`, message: 'This cannot be undone.', okText: 'Delete', danger: true })
    if (!ok) return
    try { await fsapi.remove(joinPath(cwd, e.name)); list(cwd) } catch (err) { notify('Could not delete', (err as Error).message) }
  }

  const ext = (n: string) => (n.includes('.') ? n.split('.').pop()!.toLowerCase() : '')
  const fmtDate = (ms: number) =>
    ms ? new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

  // Set sort: switching key picks a sensible default direction; re-picking the
  // same key flips direction.
  const setSort = (key: typeof sortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'name' || key === 'type' ? 'asc' : 'desc')
    }
    setSortOpen(false)
  }

  // Upload dropped files into the current directory (as the logged-in user).
  const uploadFiles = async (files: File[]) => {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setUploading(`Uploading ${f.name} (${i + 1}/${files.length})…`)
      try {
        await fsapi.upload(joinPath(cwd, f.name), f)
      } catch (err) {
        await notify('Upload failed', `${f.name}: ${(err as Error).message}`)
      }
    }
    setUploading('')
    list(cwd)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) uploadFiles(files)
  }
  const onDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      setDragOver(true)
    }
  }

  const setAsWallpaper = (e: Entry) => {
    setWallpaper({ type: 'image', value: rawUrl(joinPath(cwd, e.name)), name: e.name })
  }

  const shown = entries
    .filter((e) => showHidden || !e.hidden)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1 // folders first
      let c = 0
      if (sortKey === 'name') c = a.name.localeCompare(b.name)
      else if (sortKey === 'size') c = a.size - b.size
      else if (sortKey === 'mtime') c = a.mtime - b.mtime
      else c = ext(a.name).localeCompare(ext(b.name)) || a.name.localeCompare(b.name)
      return sortDir === 'asc' ? c : -c
    })

  const SORTS: { key: typeof sortKey; label: string }[] = [
    { key: 'name', label: 'Name' },
    { key: 'size', label: 'Size' },
    { key: 'mtime', label: 'Modified' },
    { key: 'type', label: 'Type' },
  ]
  const arrow = (key: typeof sortKey) =>
    sortKey === key ? (sortDir === 'asc' ? <FiArrowUp size={14} /> : <FiArrowDown size={14} />) : null

  const underHome = home && (cwd === home || cwd.startsWith(home + '/'))
  const trail = underHome ? cwd.slice(home.length).split('/').filter(Boolean) : cwd.split('/').filter(Boolean)
  const crumbPath = (i: number) =>
    underHome ? joinPath(home, trail.slice(0, i + 1).join('/')) : '/' + trail.slice(0, i + 1).join('/')

  const canBack = hIndex.current > 0
  const canFwd = hIndex.current < history.current.length - 1
  const activePlace = places.find((p) => placePath(p) === cwd)?.label

  // Buttons inside a draggable header must not start a window drag.
  const noDrag = (e: React.MouseEvent) => e.stopPropagation()

  // Keyboard: Ctrl+H toggles hidden files (like GNOME Files).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { e.preventDefault(); setShowHidden((v) => !v) }
  }

  return (
    <div
      className="nautilus"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={() => { if (menu) setMenu(null); if (sortOpen) setSortOpen(false) }}
    >
      {/* Sidebar */}
      <aside className="nt-side">
        <div
          className="nt-side-head"
          onMouseDown={api.startDrag}
          onDoubleClick={api.toggleMax}
        >
          <div className="nt-controls" onMouseDown={noDrag}>
            <button className="ntc close" title="Close" onClick={api.close}><FiX /></button>
            <button className="ntc min" title="Minimize" onClick={api.minimize}><FiMinus /></button>
            <button className="ntc max" title="Maximize" onClick={api.toggleMax}><FiSquare /></button>
          </div>
        </div>
        <div className="nt-side-h">QUICK ACCESS</div>
        <div className="nt-places">
          {places.map((p) => (
            <button
              key={p.label}
              className={`nt-place ${activePlace === p.label ? 'active' : ''}`}
              onClick={() => goPlace(p)}
            >
              <p.Icon className="nt-place-ico" size={17} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Main */}
      <section
        className="nt-main"
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (e.relatedTarget === null) setDragOver(false) }}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="nt-drop">
            <div className="nt-drop-inner">⬆ Drop files to upload to<br /><b>{cwd}</b></div>
          </div>
        )}
        {uploading && <div className="nt-uploading">{uploading}</div>}
        <div className="nt-toolbar" onMouseDown={api.startDrag} onDoubleClick={api.toggleMax}>
          <div className="nt-nav-group" onMouseDown={noDrag}>
            <button className="nt-nav" disabled={!canBack} onClick={back} title="Back"><FiChevronLeft size={20} /></button>
            <button className="nt-nav" disabled={!canFwd} onClick={forward} title="Forward"><FiChevronRight size={20} /></button>
          </div>
          <div className="nt-crumbs" onMouseDown={noDrag}>
            <button className="nt-crumb" onClick={() => go(home)}>
              <FiHome size={19} /> <span>Home</span>
            </button>
            {trail.map((seg, i) => {
              const Seg = SPECIAL[seg] || FaFolder
              return (
                <span key={i} className="nt-crumb-wrap">
                  <FiChevronRight className="nt-chev" size={18} />
                  <button className="nt-crumb" onClick={() => go(crumbPath(i))}>
                    <Seg size={18} /> <span>{seg}</span>
                  </button>
                </span>
              )
            })}
          </div>
          <div className="nt-tools" onMouseDown={noDrag}>
            <div className="nt-seg">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Grid view"><FiGrid size={17} /></button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List view"><FiList size={17} /></button>
            </div>
            <div className="nt-sortwrap">
              <button className={`nt-ic ${sortOpen ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); setSortOpen((o) => !o) }} title="Sort"><FiSliders size={17} /></button>
              {sortOpen && (
                <div className="nt-sortmenu" onClick={(e) => e.stopPropagation()}>
                  <div className="nt-sortmenu-h">Sort by</div>
                  {SORTS.map((s) => (
                    <button key={s.key} className={sortKey === s.key ? 'active' : ''} onClick={() => setSort(s.key)}>
                      <span>{s.label}</span>
                      {arrow(s.key)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="nt-ic" onClick={newFolder} title="New Folder"><FiFolderPlus size={17} /></button>
            <button className="nt-ic" onClick={newFile} title="New File"><FiFilePlus size={17} /></button>
          </div>
        </div>

        {error && <div className="nt-error">⚠ {error}</div>}

        {view === 'grid' ? (
          <div
            className="nt-grid"
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
          >
            {shown.map((e) => {
              const full = joinPath(cwd, e.name)
              const img = e.type === 'file' && isImage(e.name)
              return (
                <div
                  key={e.name}
                  className={`nt-item ${selected === e.name ? 'sel' : ''}`}
                  onClick={(ev) => { ev.stopPropagation(); setSelected(e.name) }}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSelected(e.name); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }) }}
                  title={`${e.name}${e.type === 'file' ? ' · ' + humanSize(e.size) : ''}`}
                >
                  <div className="nt-thumb">
                    {img ? (
                      <img className="nt-img" src={rawUrl(full)} alt="" loading="lazy" />
                    ) : e.type === 'dir' ? (
                      <FaFolder className="nt-folder" size={64} />
                    ) : (
                      <FiFile className="nt-fileico" size={54} />
                    )}
                  </div>
                  <div className="nt-name">{e.name}</div>
                </div>
              )
            })}
            {shown.length === 0 && !error && <div className="nt-empty">This folder is empty</div>}
          </div>
        ) : (
          <div
            className="nt-list"
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
          >
            <div className="nt-list-head">
              <button className="col-name" onClick={() => setSort('name')}>Name {arrow('name')}</button>
              <button className="col-size" onClick={() => setSort('size')}>Size {arrow('size')}</button>
              <button className="col-date" onClick={() => setSort('mtime')}>Modified {arrow('mtime')}</button>
            </div>
            <div className="nt-rows">
              {shown.map((e) => {
                const full = joinPath(cwd, e.name)
                const img = e.type === 'file' && isImage(e.name)
                return (
                  <div
                    key={e.name}
                    className={`nt-row ${selected === e.name ? 'sel' : ''}`}
                    onClick={(ev) => { ev.stopPropagation(); setSelected(e.name) }}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSelected(e.name); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }) }}
                  >
                    <div className="col-name">
                      <span className="nt-rowico">
                        {img ? (
                          <img className="nt-rowimg" src={rawUrl(full)} alt="" loading="lazy" />
                        ) : e.type === 'dir' ? (
                          <FaFolder className="nt-folder" size={22} />
                        ) : (
                          <FiFile className="nt-fileico" size={20} />
                        )}
                      </span>
                      <span className="nt-rowname">{e.name}</span>
                    </div>
                    <div className="col-size">{e.type === 'dir' ? '—' : humanSize(e.size)}</div>
                    <div className="col-date">{fmtDate(e.mtime)}</div>
                  </div>
                )
              })}
              {shown.length === 0 && !error && <div className="nt-empty">This folder is empty</div>}
            </div>
          </div>
        )}
      </section>

      {/* Context menu */}
      {menu && (
        <div className="nt-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.entry ? (
            <>
              <button onClick={() => { openEntry(menu.entry!); setMenu(null) }}>Open</button>
              {menu.entry.type === 'file' && isImage(menu.entry.name) && (
                <button onClick={() => { setAsWallpaper(menu.entry!); setMenu(null) }}>Set as wallpaper</button>
              )}
              <button onClick={() => { renameEntry(menu.entry!); setMenu(null) }}>Rename</button>
              <button className="danger" onClick={() => { deleteEntry(menu.entry!); setMenu(null) }}>Delete</button>
            </>
          ) : (
            <>
              <button onClick={() => { newFolder(); setMenu(null) }}>New Folder</button>
              <button onClick={() => { newFile(); setMenu(null) }}>New File</button>
              <button onClick={() => { list(cwd); setMenu(null) }}>Refresh</button>
            </>
          )}
        </div>
      )}

      {/* In-app dialog */}
      {dialog && <Modal spec={dialog} onOk={(v) => answer(v)} onCancel={() => answer(null)} />}
    </div>
  )
}
