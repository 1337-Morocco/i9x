import { useEffect, useState, useCallback } from 'react'
import {
  FiPlus, FiRefreshCw, FiExternalLink, FiPlay, FiSquare, FiRotateCw, FiTrash2, FiLayout,
} from 'react-icons/fi'
import { staticapi, type StaticSite } from '../api/staticsites'
import { CardSkeletons } from './Skeleton'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 31) || 'site'

// Last known list — reopening the app repaints instantly (see WordPress.tsx).
let cached: StaticSite[] | null = null

export default function Websites() {
  const [sites, setSites] = useState<StaticSite[]>(cached ?? [])
  const [loading, setLoading] = useState(cached === null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = (await staticapi.sites()).sites
      cached = s; setSites(s); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const act = async (name: string, action: 'start' | 'stop' | 'restart' | 'remove') => {
    if (action === 'remove' && !confirm(`Remove site "${name}"? (Your files are kept, only the server is removed.)`)) return
    setBusy(name)
    try { await staticapi.action(name, action); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  return (
    <div className="wp">
      <div className="wp-head">
        <div className="wp-title"><FiLayout /> Static Websites</div>
        <button className="sys-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className="wp-new stat" onClick={() => setShowForm(true)}><FiPlus /> New website</button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="wp-grid">
        {sites.map((s) => (
          <div className="wp-card" key={s.name}>
            <div className="wp-card-h">
              <div className="wp-card-title">{s.name}</div>
              <span className={`wp-status ${s.status}`}>{s.status}</span>
            </div>
            <div className="wp-card-url"><a href={s.url} target="_blank" rel="noreferrer">{s.url} <FiExternalLink size={12} /></a></div>
            <div className="wp-card-meta">📁 {s.root}</div>
            <div className="wp-card-actions">
              {s.status === 'running'
                ? <>
                    <button disabled={busy === s.name} onClick={() => act(s.name, 'restart')} title="Restart"><FiRotateCw size={14} /></button>
                    <button disabled={busy === s.name} onClick={() => act(s.name, 'stop')} title="Stop"><FiSquare size={14} /></button>
                  </>
                : <button disabled={busy === s.name} onClick={() => act(s.name, 'start')} title="Start"><FiPlay size={14} /></button>}
              <button className="danger" disabled={busy === s.name} onClick={() => act(s.name, 'remove')} title="Remove"><FiTrash2 size={14} /></button>
            </div>
          </div>
        ))}
        {loading && sites.length === 0 && <CardSkeletons />}
        {!loading && sites.length === 0 && !err && (
          <div className="wp-empty">
            <FiLayout size={40} />
            <p>No websites yet.</p>
            <button className="wp-new stat" onClick={() => setShowForm(true)}><FiPlus /> Host a static website</button>
          </div>
        )}
      </div>

      {showForm && <CreateForm onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load() }} suggestPort={8090 + sites.length} />}
    </div>
  )
}

function CreateForm({ onClose, onCreated, suggestPort }: { onClose: () => void; onCreated: () => void; suggestPort: number }) {
  const [name, setName] = useState('my-website')
  const [root, setRoot] = useState('')
  const [port, setPort] = useState(String(suggestPort))
  const [createRoot, setCreateRoot] = useState(true)
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    setErr(''); setCreating(true)
    try { await staticapi.create({ name, root: root.trim(), port: Number(port), createRoot }); onCreated() }
    catch (e) { setErr((e as Error).message); setCreating(false) }
  }

  return (
    <div className="wp-form-overlay" onMouseDown={() => !creating && onClose()}>
      <div className="wp-form" onMouseDown={(e) => e.stopPropagation()}>
        {creating ? (
          <div className="wp-creating"><div className="splash-spinner" /><b>Starting your website…</b><p>Pulling nginx and starting the server.</p></div>
        ) : (
          <>
            <div className="wp-form-h"><FiLayout /> Host a static website</div>
            <div className="wp-row">
              <div>
                <label>Site name</label>
                <input value={name} onChange={(e) => setName(slug(e.target.value))} />
              </div>
              <div>
                <label>Port</label>
                <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
            <label>Folder to serve <span className="wp-hint">(document root)</span></label>
            <input placeholder="/home/user/mysite" value={root} onChange={(e) => setRoot(e.target.value)} />
            <label className="wp-check">
              <input type="checkbox" checked={createRoot} onChange={(e) => setCreateRoot(e.target.checked)} />
              Create the folder with a starter page if it doesn’t exist
            </label>
            {err && <div className="sys-err">⚠ {err}</div>}
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={onClose}>Cancel</button>
              <button className="wp-new stat" disabled={!root.trim().startsWith('/')} onClick={submit}>Create website</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
