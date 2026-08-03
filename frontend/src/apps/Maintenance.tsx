import { useCallback, useEffect, useState } from 'react'
import {
  FiHardDrive, FiRefreshCw, FiTrash2, FiAlertTriangle, FiCheckCircle, FiClock, FiX, FiPlay,
} from 'react-icons/fi'
import { maintapi, fmtBytes, type MaintenanceStatus, type CleanupRun, type CleanupSettings } from '../api/maintenance'

// Disk guard + Docker cleanup. i9x builds images on the host, so build
// cache and dangling layers are what actually fill these machines up — this
// panel shows how close the disk is to the edge and reclaims the space.

let cached: MaintenanceStatus | null = null

const TRIGGER_LABEL: Record<string, string> = {
  schedule: 'scheduled', manual: 'manual', threshold: 'disk guard', api: 'API',
}

export default function Maintenance() {
  const [st, setSt] = useState<MaintenanceStatus | null>(cached)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [viewRun, setViewRun] = useState<CleanupRun | null>(null)

  const load = useCallback(async () => {
    try { const s = await maintapi.status(); cached = s; setSt(s); setErr('') }
    catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [load])

  const save = async (patch: Partial<CleanupSettings>) => {
    if (!st) return
    setSt({ ...st, settings: { ...st.settings, ...patch } })   // optimistic
    setSaving(true); setErr('')
    try { await maintapi.save(patch); await load() } catch (e) { setErr((e as Error).message); await load() } finally { setSaving(false) }
  }

  const runNow = async () => {
    setBusy(true); setErr('')
    try {
      const r = await maintapi.run()
      await load()
      if (r.run) setViewRun((await maintapi.run1(r.run.id)).run)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const s = st?.settings
  const worst = st?.disk.worst || null

  return (
    <div className="mt">
      <div className="pg-head">
        <div className="pg-head-title"><FiHardDrive /> Cleanup &amp; disk</div>
        <button className="pg-ghost-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className="pg-primary" disabled={busy || st?.running} onClick={runNow}>
          {busy || st?.running ? <div className="splash-spinner small" /> : <FiTrash2 />} Clean up now
        </button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}

      {st?.alert && (
        <div className="mt-alert">
          <FiAlertTriangle />
          <div>
            <b>Disk {st.alert.percent}% full on {st.alert.path}</b>
            <span>
              Over the {st.alert.threshold}% threshold since {new Date(st.alert.since).toLocaleString()} — {fmtBytes(st.alert.avail)} free.
              {st.alert.lastClean ? ` Auto-cleanup last ran ${new Date(st.alert.lastClean).toLocaleTimeString()}.` : ''}
            </span>
          </div>
        </div>
      )}

      <div className="mt-grid">
        {/* Disks */}
        <section className="mt-card">
          <h3>Disk</h3>
          {!st && <div className="mt-skel" />}
          {st?.disk.disks.map((d) => {
            const over = s ? d.percent >= s.diskThreshold : false
            return (
              <div className="mt-disk" key={d.path}>
                <div className="mt-disk-h">
                  <b>{d.path}</b><span className="mt-mono">{d.filesystem}</span>
                  <span className={`mt-pct ${over ? 'over' : ''}`}>{d.percent}%</span>
                </div>
                <div className="mt-bar"><span className={over ? 'over' : ''} style={{ width: `${d.percent}%` }} /></div>
                <div className="mt-disk-f">{fmtBytes(d.used)} used · {fmtBytes(d.avail)} free of {fmtBytes(d.total)}</div>
              </div>
            )
          })}
          {st && <div className="mt-note">Docker stores its data in <code>{st.disk.dockerRoot}</code>.</div>}
        </section>

        {/* Docker usage */}
        <section className="mt-card">
          <h3>Docker usage {st && <span className="mt-reclaim">{fmtBytes(st.reclaimable)} reclaimable</span>}</h3>
          {!st && <div className="mt-skel" />}
          {st && st.docker.length === 0 && <div className="mt-note">Docker isn’t reporting usage on this host.</div>}
          {st && st.docker.length > 0 && (
            <table className="mt-table">
              <thead><tr><th>Type</th><th>Items</th><th>Size</th><th>Reclaimable</th></tr></thead>
              <tbody>
                {st.docker.map((u) => (
                  <tr key={u.type}>
                    <td>{u.type}</td>
                    <td>{u.active}/{u.count} active</td>
                    <td>{u.size}</td>
                    <td className={u.reclaimableBytes > 0 ? 'mt-em' : ''}>{u.reclaimable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Schedule + what to prune */}
        <section className="mt-card">
          <h3>Scheduled cleanup</h3>
          {s && (
            <>
              <label className="mt-check">
                <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
                <span>Run on a schedule</span>
              </label>
              <div className="mt-row">
                <input className="mono" value={s.schedule} disabled={!s.enabled}
                  onChange={(e) => setSt({ ...st!, settings: { ...s, schedule: e.target.value } })}
                  onBlur={(e) => save({ schedule: e.target.value })} />
                <span className="pg-hint">
                  {st?.nextRun ? `next ${new Date(st.nextRun).toLocaleString()}` : 'paused'}
                </span>
              </div>
              <div className="mt-presets">
                {st?.presets.slice(3).map((p) => (
                  <button key={p.expr} className={s.schedule === p.expr ? 'on' : ''} disabled={!s.enabled} onClick={() => save({ schedule: p.expr })}>{p.label}</button>
                ))}
              </div>

              <h4>What to prune</h4>
              {([
                ['containers', 'Exited containers'],
                ['images', 'Dangling images'],
                ['buildCache', 'Build cache'],
                ['networks', 'Unused networks'],
              ] as [keyof CleanupSettings, string][]).map(([k, label]) => (
                <label className="mt-check" key={k}>
                  <input type="checkbox" checked={!!s[k]} onChange={(e) => save({ [k]: e.target.checked } as Partial<CleanupSettings>)} />
                  <span>{label}</span>
                </label>
              ))}
              <label className="mt-check danger">
                <input type="checkbox" checked={s.volumes} onChange={(e) => {
                  if (e.target.checked && !confirm('Pruning unused volumes deletes the data in them — including a stopped database’s volume. Enable anyway?')) return
                  save({ volumes: e.target.checked })
                }} />
                <span>Unused volumes <em>— deletes data, off by default</em></span>
              </label>

              <div className="mt-row">
                <label className="mt-inline">Trim build logs older than</label>
                <input type="number" min={0} max={365} value={s.buildLogDays}
                  onChange={(e) => setSt({ ...st!, settings: { ...s, buildLogDays: Number(e.target.value) } })}
                  onBlur={(e) => save({ buildLogDays: Number(e.target.value) })} />
                <span className="pg-hint">days (0 = keep all)</span>
              </div>
            </>
          )}
        </section>

        {/* Disk guard */}
        <section className="mt-card">
          <h3>Disk guard</h3>
          {s && (
            <>
              <div className="mt-row">
                <label className="mt-inline">Alert above</label>
                <input type="number" min={50} max={99} value={s.diskThreshold}
                  onChange={(e) => setSt({ ...st!, settings: { ...s, diskThreshold: Number(e.target.value) } })}
                  onBlur={(e) => save({ diskThreshold: Number(e.target.value) })} />
                <span className="pg-hint">% used</span>
              </div>
              <label className="mt-check">
                <input type="checkbox" checked={s.autoCleanOnThreshold} onChange={(e) => save({ autoCleanOnThreshold: e.target.checked })} />
                <span>Clean up automatically when over the threshold <em>(at most once an hour)</em></span>
              </label>
              <div className="mt-note">
                Checked every 5 minutes against {worst ? <>the fullest volume (<b>{worst.path}</b>, now {worst.percent}%)</> : 'every mounted volume'}.
              </div>
              {saving && <div className="mt-note">Saving…</div>}
            </>
          )}
        </section>

        {/* History */}
        <section className="mt-card wide">
          <h3>Recent cleanups</h3>
          {st && st.runs.length === 0 && <div className="mt-note">No cleanup has run yet.</div>}
          {st && st.runs.length > 0 && (
            <table className="mt-table">
              <thead><tr><th>When</th><th>Trigger</th><th>Status</th><th>Reclaimed</th><th /></tr></thead>
              <tbody>
                {st.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.started).toLocaleString()}</td>
                    <td>{TRIGGER_LABEL[r.trigger] || r.trigger}</td>
                    <td>
                      <span className={`tk-badge ${r.status === 'success' ? 'success' : r.status === 'running' ? 'running' : 'failed'}`}>
                        {r.status === 'success' ? <FiCheckCircle size={10} /> : r.status === 'running' ? <FiClock size={10} /> : <FiAlertTriangle size={10} />} {r.status}
                      </span>
                    </td>
                    <td className={r.reclaimed ? 'mt-em' : ''}>{fmtBytes(r.reclaimed)}</td>
                    <td><button className="pg-icon-btn" title="Output"
                      onClick={async () => setViewRun((await maintapi.run1(r.id)).run)}><FiPlay size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {viewRun && (
        <div className="pg-overlay" onMouseDown={() => setViewRun(null)}>
          <div className="pg-modal md" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pg-modal-h">
              <FiTrash2 /> Cleanup — {fmtBytes(viewRun.reclaimed)} reclaimed
              <button className="pg-modal-x" onClick={() => setViewRun(null)}><FiX size={17} /></button>
            </div>
            <pre className="pg-logs">{viewRun.output || '(no output)'}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
