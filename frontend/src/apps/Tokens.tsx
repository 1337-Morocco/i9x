import { useCallback, useEffect, useState } from 'react'
import { FiKey, FiPlus, FiTrash2, FiCopy, FiCheck, FiExternalLink, FiAlertTriangle } from 'react-icons/fi'
import { tokensapi, type ApiToken } from '../api/tokens'

// Settings → API tokens. Bearer credentials for CI and scripts; the plaintext
// is shown exactly once, when it is created.

const fmt = (ts: number | null) => (ts ? new Date(ts).toLocaleDateString() : '—')

export default function Tokens() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('write')
  const [expiry, setExpiry] = useState('')
  const [creating, setCreating] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try { setTokens((await tokensapi.list()).tokens); setErr('') } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  const create = async () => {
    setCreating(true); setErr('')
    try {
      const r = await tokensapi.create(name.trim(), scope, expiry ? Number(expiry) : undefined)
      setFresh(r.token); setName(''); setExpiry('')
      await load()
    } catch (e) { setErr((e as Error).message) } finally { setCreating(false) }
  }

  const remove = async (t: ApiToken) => {
    if (!confirm(`Revoke “${t.name}”? Anything using it stops working immediately.`)) return
    try { await tokensapi.remove(t.id); await load() } catch (e) { setErr((e as Error).message) }
  }

  const example = `curl -X POST \\
  -H "Authorization: Bearer ${fresh || 'i9x_…'}" \\
  ${location.origin}/api/v1/apps/YOUR_APP/deploy`

  return (
    <div className="settings-main">
      <h2 className="settings-h">API tokens</h2>
      <p className="settings-desc">
        Bearer tokens for scripts, CI and monitoring. They work on every API route, including
        the documented, stable surface under <code>/api/v1</code>.
        <a className="tok-link" href="/api/openapi.json" target="_blank" rel="noreferrer">OpenAPI spec <FiExternalLink size={11} /></a>
      </p>

      {err && <div className="sys-err">⚠ {err}</div>}

      {fresh && (
        <div className="tok-fresh">
          <div className="tok-fresh-h"><FiAlertTriangle /> Copy this token now — it is never shown again.</div>
          <div className="tok-fresh-v">
            <code>{fresh}</code>
            <button className="pg-icon-btn" title="Copy" onClick={async () => {
              try { await navigator.clipboard.writeText(fresh); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
            }}>{copied ? <FiCheck size={14} /> : <FiCopy size={14} />}</button>
          </div>
          <pre className="tok-example">{example}</pre>
          <button className="pg-ghost" onClick={() => setFresh(null)}>Done</button>
        </div>
      )}

      <div className="tok-new">
        <div>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github-actions" />
        </div>
        <div>
          <label>Scope</label>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'read' | 'write')}>
            <option value="write">Read &amp; write</option>
            <option value="read">Read only</option>
          </select>
        </div>
        <div>
          <label>Expires <span className="pg-hint">(days, blank = never)</span></label>
          <input value={expiry} onChange={(e) => setExpiry(e.target.value.replace(/\D/g, ''))} placeholder="never" />
        </div>
        <button className="pg-primary" disabled={creating || name.trim().length < 2} onClick={create}>
          <FiPlus /> Create token
        </button>
      </div>

      <div className="tok-list">
        {tokens === null && <div className="mt-note">Loading…</div>}
        {tokens && tokens.length === 0 && <div className="mt-note">No tokens yet.</div>}
        {tokens && tokens.map((t) => (
          <div className={`tok-row ${t.expired ? 'expired' : ''}`} key={t.id}>
            <FiKey size={15} />
            <div className="tok-id">
              <b>{t.name}</b>
              <code>{t.prefix}</code>
            </div>
            <span className={`tok-scope ${t.scope}`}>{t.scope === 'read' ? 'read only' : 'read & write'}</span>
            <span className="tok-when">created {fmt(t.created)}</span>
            <span className="tok-when">last used {fmt(t.lastUsed)}</span>
            <span className="tok-when">{t.expires ? (t.expired ? 'expired' : `expires ${fmt(t.expires)}`) : 'no expiry'}</span>
            <button className="pg-icon-btn lg danger" title="Revoke" onClick={() => remove(t)}><FiTrash2 size={15} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
