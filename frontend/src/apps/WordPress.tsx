import { useEffect, useState, useCallback } from 'react'
import {
  FiPlus, FiRefreshCw, FiExternalLink, FiPlay, FiSquare, FiRotateCw, FiTrash2, FiFileText, FiX, FiGlobe,
} from 'react-icons/fi'
import { wpapi, type Site } from '../api/wordpress'
import { CardSkeletons } from './Skeleton'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 31) || 'site'
const genPass = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!'

// Last known list, kept for the lifetime of the page: reopening the app paints
// the previous sites instantly while the refresh happens in the background.
let cached: Site[] | null = null

export default function WordPress() {
  const [sites, setSites] = useState<Site[]>(cached ?? [])
  const [loading, setLoading] = useState(cached === null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const s = (await wpapi.sites()).sites
      cached = s; setSites(s); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const act = async (name: string, action: 'start' | 'stop' | 'restart' | 'remove') => {
    if (action === 'remove' && !confirm(`Delete site "${name}" and all its data? This cannot be undone.`)) return
    setBusy(name)
    try { await wpapi.action(name, action); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }
  const showLogs = async (name: string) => {
    try { setLogs({ name, text: (await wpapi.logs(name)).text || '(no output)' }) } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div className="wp">
      <div className="wp-head">
        <div className="wp-title"><FiGlobe /> Managed WordPress</div>
        <button className="sys-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className="wp-new" onClick={() => setShowForm(true)}><FiPlus /> New site</button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="wp-grid">
        {sites.map((s) => (
          <div className="wp-card" key={s.name}>
            <div className="wp-card-h">
              <div className="wp-card-title">{s.title}</div>
              <span className={`wp-status ${s.status}`}>{s.status}</span>
            </div>
            <div className="wp-card-url">
              <a href={s.url} target="_blank" rel="noreferrer">{s.url} <FiExternalLink size={12} /></a>
            </div>
            <div className="wp-card-meta">admin: <b>{s.adminUser}</b> · <a href={`${s.url}/wp-admin`} target="_blank" rel="noreferrer">wp-admin</a></div>
            <div className="wp-card-actions">
              {s.status === 'running'
                ? <>
                    <button disabled={busy === s.name} onClick={() => act(s.name, 'restart')} title="Restart"><FiRotateCw size={14} /></button>
                    <button disabled={busy === s.name} onClick={() => act(s.name, 'stop')} title="Stop"><FiSquare size={14} /></button>
                  </>
                : <button disabled={busy === s.name} onClick={() => act(s.name, 'start')} title="Start"><FiPlay size={14} /></button>}
              <button onClick={() => showLogs(s.name)} title="Logs"><FiFileText size={14} /></button>
              <button className="danger" disabled={busy === s.name} onClick={() => act(s.name, 'remove')} title="Delete"><FiTrash2 size={14} /></button>
            </div>
          </div>
        ))}
        {loading && sites.length === 0 && <CardSkeletons />}
        {!loading && sites.length === 0 && !err && (
          <div className="wp-empty">
            <FiGlobe size={40} />
            <p>No sites yet.</p>
            <button className="wp-new" onClick={() => setShowForm(true)}><FiPlus /> Create your first WordPress site</button>
          </div>
        )}
      </div>

      {showForm && <CreateForm onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load() }} suggestPort={8081 + sites.length} />}

      {logs && (
        <div className="dk-logs">
          <div className="dk-logs-h">Logs — {logs.name}<button onClick={() => setLogs(null)}><FiX /></button></div>
          <pre className="logs-pre">{logs.text}</pre>
        </div>
      )}
    </div>
  )
}

function CreateForm({ onClose, onCreated, suggestPort }: { onClose: () => void; onCreated: () => void; suggestPort: number }) {
  const [title, setTitle] = useState('My WordPress Site')
  const [name, setName] = useState(slug('My WordPress Site'))
  const [nameEdited, setNameEdited] = useState(false)
  const [adminUser, setAdminUser] = useState('admin')
  const [adminPassword, setAdminPassword] = useState(genPass())
  const [adminEmail, setAdminEmail] = useState('')
  const [port, setPort] = useState(String(suggestPort))
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')

  const onTitle = (v: string) => { setTitle(v); if (!nameEdited) setName(slug(v)) }

  const submit = async () => {
    setErr(''); setCreating(true)
    try {
      await wpapi.create({ name, title, adminUser, adminPassword, adminEmail, port: Number(port) })
      onCreated()
    } catch (e) { setErr((e as Error).message); setCreating(false) }
  }

  return (
    <div className="wp-form-overlay" onMouseDown={() => !creating && onClose()}>
      <div className="wp-form" onMouseDown={(e) => e.stopPropagation()}>
        {creating ? (
          <div className="wp-creating">
            <div className="splash-spinner" />
            <b>Creating your site…</b>
            <p>Pulling images (nginx, MariaDB, Redis, WordPress) and installing. First run can take a few minutes.</p>
          </div>
        ) : (
          <>
            <div className="wp-form-h"><FiGlobe /> New WordPress site</div>
            <label>Site title</label>
            <input value={title} onChange={(e) => onTitle(e.target.value)} />
            <label>Site ID <span className="wp-hint">(folder & project name)</span></label>
            <input value={name} onChange={(e) => { setName(slug(e.target.value)); setNameEdited(true) }} />
            <div className="wp-row">
              <div>
                <label>Admin username</label>
                <input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} />
              </div>
              <div>
                <label>Port</label>
                <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
            <label>Admin password</label>
            <div className="wp-pass">
              <input value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
              <button type="button" onClick={() => setAdminPassword(genPass())}>Generate</button>
            </div>
            <label>Admin email</label>
            <input type="email" placeholder="you@example.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            {err && <div className="sys-err">⚠ {err}</div>}
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={onClose}>Cancel</button>
              <button className="wp-new" onClick={submit}>Create site</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
