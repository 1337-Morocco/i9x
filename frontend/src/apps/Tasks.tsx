import { useCallback, useEffect, useState } from 'react'
import {
  FiClock, FiPlus, FiRefreshCw, FiPlay, FiTrash2, FiEdit2, FiX, FiCheck,
  FiTerminal, FiServer, FiDatabase, FiBox, FiAlertTriangle,
} from 'react-icons/fi'
import { tasksapi, type Task, type TaskRun, type TaskInput, type CronPreset, type TaskTargetType } from '../api/tasks'
import { CardSkeletons } from './Skeleton'

// Scheduled tasks: cron jobs that run inside a deployed app's container (where
// `php artisan schedule:run` or `manage.py` actually belongs), in a database
// container, in any container, or on the host — each with its run history.

let cached: Task[] | null = null

const TARGET_ICON: Record<TaskTargetType, React.ReactNode> = {
  app: <FiBox size={12} />, database: <FiDatabase size={12} />,
  container: <FiServer size={12} />, host: <FiTerminal size={12} />,
}

function when(ts: number | null | undefined) {
  if (!ts) return '—'
  const diff = ts - Date.now()
  const abs = Math.abs(diff)
  const m = Math.round(abs / 60000)
  const unit = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  if (m < 1) return diff >= 0 ? 'in <1m' : 'just now'
  return diff >= 0 ? `in ${unit}` : `${unit} ago`
}

const fmtTime = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : '—')

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>(cached ?? [])
  const [presets, setPresets] = useState<CronPreset[]>([])
  const [targets, setTargets] = useState<{ app: string[]; database: string[] }>({ app: [], database: [] })
  const [loading, setLoading] = useState(cached === null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const [historyFor, setHistoryFor] = useState<Task | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await tasksapi.list()
      cached = r.tasks; setTasks(r.tasks); setPresets(r.presets); setTargets(r.targets); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

  const runNow = async (t: Task) => {
    setBusy(t.id)
    try { await tasksapi.run(t.id); await load(); setHistoryFor(t) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const toggle = async (t: Task) => {
    setBusy(t.id)
    try { await tasksapi.toggle(t.id); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const remove = async (t: Task) => {
    if (!confirm(`Delete the task “${t.name}”? Its run history goes too.`)) return
    setBusy(t.id)
    try { await tasksapi.remove(t.id); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <div className="tk">
      <div className="pg-head">
        <div className="pg-head-title"><FiClock /> Scheduled tasks</div>
        {tasks.length > 0 && <span className="nx-count">{tasks.filter((t) => t.enabled).length}/{tasks.length} active</span>}
        <button className="pg-ghost-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className="pg-primary" onClick={() => setEditing('new')}><FiPlus /> New task</button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="tk-list">
        {loading && tasks.length === 0 && <CardSkeletons />}
        {!loading && tasks.length === 0 && !err && (
          <div className="pg-empty">
            <div className="pg-empty-icon"><FiClock size={30} /></div>
            <b>No scheduled tasks</b>
            <p>Run a command on a cron schedule inside an app or database container — migrations, queue workers, cleanups.</p>
            <button className="pg-primary" onClick={() => setEditing('new')}><FiPlus /> Create a task</button>
          </div>
        )}
        {tasks.map((t) => (
          <div className={`tk-row ${t.enabled ? '' : 'off'}`} key={t.id}>
            <button className={`tk-toggle ${t.enabled ? 'on' : ''}`} title={t.enabled ? 'Disable' : 'Enable'}
              disabled={busy === t.id} onClick={() => toggle(t)}><span /></button>

            <div className="tk-main">
              <div className="tk-name">
                {t.name}
                {t.running && <span className="tk-badge running">running</span>}
                {t.lastStatus && !t.running && <span className={`tk-badge ${t.lastStatus}`}>{t.lastStatus}</span>}
                {!t.scheduleValid && <span className="tk-badge failed"><FiAlertTriangle size={10} /> bad cron</span>}
              </div>
              <code className="tk-cmd" title={t.command}>{t.command}</code>
              <div className="tk-meta">
                <span className="tk-chip">{TARGET_ICON[t.targetType]} {t.targetType === 'host' ? 'host' : t.target}</span>
                <span className="tk-chip mono">{t.schedule}</span>
                <span className="tk-chip">timeout {t.timeout}s</span>
              </div>
            </div>

            <div className="tk-times">
              <div><span>Last</span> <b title={fmtTime(t.lastRun)}>{when(t.lastRun)}</b></div>
              <div><span>Next</span> <b title={fmtTime(t.nextRun)}>{t.enabled ? when(t.nextRun) : 'paused'}</b></div>
            </div>

            <div className="tk-actions">
              <button className="pg-icon-btn lg" title="Run now" disabled={busy === t.id || t.running} onClick={() => runNow(t)}><FiPlay size={15} /></button>
              <button className="pg-icon-btn lg" title="History" onClick={() => setHistoryFor(t)}><FiClock size={15} /></button>
              <button className="pg-icon-btn lg" title="Edit" onClick={() => setEditing(t)}><FiEdit2 size={15} /></button>
              <button className="pg-icon-btn lg danger" title="Delete" disabled={busy === t.id} onClick={() => remove(t)}><FiTrash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <TaskForm
          task={editing === 'new' ? null : editing}
          presets={presets}
          targets={targets}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
      {historyFor && <History task={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

const BLANK: TaskInput = { name: '', targetType: 'app', target: '', command: '', schedule: '0 3 * * *', timeout: 300 }

function TaskForm({ task, presets, targets, onClose, onSaved }: {
  task: Task | null
  presets: CronPreset[]
  targets: { app: string[]; database: string[] }
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<TaskInput>(task
    ? { name: task.name, targetType: task.targetType, target: task.target, command: task.command, schedule: task.schedule, timeout: task.timeout, enabled: task.enabled }
    : { ...BLANK, target: targets.app[0] || '' })
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<TaskInput>) => setF((v) => ({ ...v, ...patch }))

  const options = f.targetType === 'app' ? targets.app : f.targetType === 'database' ? targets.database : []

  const save = async () => {
    setSaving(true); setErr('')
    try {
      if (task) await tasksapi.update(task.id, f)
      else await tasksapi.create(f)
      onSaved()
    } catch (e) { setErr((e as Error).message); setSaving(false) }
  }

  return (
    <div className="pg-overlay" onMouseDown={() => !saving && onClose()}>
      <div className="pg-modal sm" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pg-modal-h"><FiClock /> {task ? 'Edit task' : 'New scheduled task'}
          <button className="pg-modal-x" onClick={onClose}><FiX size={17} /></button>
        </div>
        <div className="pg-modal-body">
          <label>Name</label>
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Nightly cleanup" autoFocus />

          <label>Runs in</label>
          <div className="tk-seg">
            {(['app', 'database', 'container', 'host'] as TaskTargetType[]).map((k) => (
              <button key={k} className={f.targetType === k ? 'on' : ''}
                onClick={() => set({ targetType: k, target: k === 'app' ? targets.app[0] || '' : k === 'database' ? targets.database[0] || '' : '' })}>
                {TARGET_ICON[k]} {k === 'host' ? 'Host shell' : k === 'container' ? 'Container' : k}
              </button>
            ))}
          </div>

          {f.targetType === 'app' || f.targetType === 'database' ? (
            options.length ? (
              <select value={f.target} onChange={(e) => set({ target: e.target.value })}>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : <div className="tk-note">No {f.targetType === 'app' ? 'apps' : 'databases'} yet — deploy one first, or pick another target.</div>
          ) : f.targetType === 'container' ? (
            <input value={f.target} onChange={(e) => set({ target: e.target.value })} placeholder="container name" />
          ) : (
            <div className="tk-note">Runs as the i9x service user, with a login shell.</div>
          )}

          <label>Command</label>
          <textarea className="tk-cmd-input" rows={3} spellCheck={false} value={f.command}
            onChange={(e) => set({ command: e.target.value })}
            placeholder={f.targetType === 'host' ? 'systemctl restart nginx' : 'php artisan schedule:run'} />

          <label>Schedule <span className="pg-hint">(cron: minute hour day month weekday)</span></label>
          <input className="mono" value={f.schedule} onChange={(e) => set({ schedule: e.target.value })} placeholder="0 3 * * *" />
          <div className="tk-presets">
            {presets.map((p) => (
              <button key={p.expr} className={f.schedule === p.expr ? 'on' : ''} onClick={() => set({ schedule: p.expr })}>{p.label}</button>
            ))}
          </div>

          <label>Timeout <span className="pg-hint">seconds — the command is killed after this</span></label>
          <input type="number" min={5} max={3600} value={f.timeout}
            onChange={(e) => set({ timeout: Number(e.target.value) || 300 })} />

          {err && <div className="sys-err">⚠ {err}</div>}
        </div>
        <div className="pg-modal-foot">
          <button className="pg-ghost" onClick={onClose}>Cancel</button>
          <button className="pg-primary" disabled={saving || !f.name.trim() || !f.command.trim()} onClick={save}>
            <FiCheck size={14} /> {task ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function History({ task, onClose }: { task: Task; onClose: () => void }) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null)
  const [sel, setSel] = useState<TaskRun | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try { setRuns((await tasksapi.runs(task.id)).runs) } catch (e) { setErr((e as Error).message) }
  }, [task.id])
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [load])

  // The list omits output; fetch the selected run in full.
  useEffect(() => {
    if (!runs || !runs.length) return
    const want = sel ? runs.find((r) => r.id === sel.id) || runs[0] : runs[0]
    if (sel && sel.output !== undefined && sel.id === want.id && want.status === sel.status) return
    tasksapi.run1(want.id).then((r) => setSel(r.run)).catch(() => { /* keep the previous view */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs])

  return (
    <div className="pg-overlay" onMouseDown={onClose}>
      <div className="pg-modal md" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pg-modal-h"><FiClock /> {task.name} — run history
          <button className="pg-modal-x" onClick={onClose}><FiX size={17} /></button>
        </div>
        {err && <div className="sys-err">⚠ {err}</div>}
        <div className="tk-hist">
          <div className="tk-hist-list">
            {runs === null && <div className="pgb-side-empty">Loading…</div>}
            {runs && runs.length === 0 && <div className="pgb-side-empty">Never run yet.</div>}
            {runs && runs.map((r) => (
              <button key={r.id} className={sel && sel.id === r.id ? 'on' : ''}
                onClick={() => tasksapi.run1(r.id).then((x) => setSel(x.run))}>
                <span className={`tk-badge ${r.status}`}>{r.status}</span>
                <span className="tk-hist-when">{new Date(r.started).toLocaleString()}</span>
                <span className="tk-hist-trig">{r.trigger}</span>
              </button>
            ))}
          </div>
          <pre className="pg-logs tk-hist-out">{sel ? (sel.output || '(no output)') : 'Select a run.'}</pre>
        </div>
      </div>
    </div>
  )
}
