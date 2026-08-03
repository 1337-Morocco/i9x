import { useEffect, useState, useCallback, useRef } from 'react'
import {
  FiPlus, FiRefreshCw, FiPlay, FiSquare, FiRotateCw, FiTrash2, FiDatabase,
  FiCopy, FiCheck, FiEye, FiEyeOff, FiFileText, FiGrid, FiColumns, FiTable,
  FiChevronLeft, FiChevronRight, FiPlayCircle, FiX, FiDownloadCloud, FiTerminal,
} from 'react-icons/fi'
import { dbapi, downloadDump, type Db, type DbEngine, type DbTable, type DbColumn, type DbRow } from '../api/db'
import { CardSkeletons } from './Skeleton'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 31) || 'db'
const ident = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^([0-9])/, '_$1').slice(0, 63)

// Repaint instantly when the app is reopened (same trick as the other panels).
let cached: Db[] | null = null
let enginesCache: DbEngine[] | null = null

function Copy({ text, title, className = 'pg-icon-btn' }: { text: string; title?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={className}
      title={title || 'Copy'}
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200) } catch { /* ignore */ } }}
    >
      {done ? <FiCheck size={14} /> : <FiCopy size={14} />}
    </button>
  )
}

export default function Databases() {
  const [dbs, setDbs] = useState<Db[]>(cached ?? [])
  const [engines, setEngines] = useState<DbEngine[]>(enginesCache ?? [])
  const [loading, setLoading] = useState(cached === null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [logsFor, setLogsFor] = useState<Db | null>(null)
  const [browseFor, setBrowseFor] = useState<Db | null>(null)

  const load = useCallback(async () => {
    try {
      const d = (await dbapi.dbs()).dbs
      cached = d; setDbs(d); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])
  useEffect(() => {
    if (enginesCache) return
    dbapi.engines().then((r) => { enginesCache = r.engines; setEngines(r.engines) }).catch(() => { /* form falls back to postgres */ })
  }, [])

  const act = async (name: string, action: 'start' | 'stop' | 'restart' | 'remove') => {
    let deleteData = false
    if (action === 'remove') {
      if (!confirm(`Remove database "${name}"? The container will be deleted.`)) return
      deleteData = confirm('Also DELETE the stored data volume?\n\nOK = wipe all data permanently.\nCancel = keep the data volume.')
    }
    setBusy(name)
    try { await dbapi.action(name, action, deleteData); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  return (
    <div className="pg">
      <div className="pg-head">
        <div className="pg-head-title"><FiDatabase /> Databases</div>
        {dbs.length > 0 && <span className="nx-count">{dbs.filter((d) => d.status === 'running').length}/{dbs.length} running</span>}
        <button className="pg-ghost-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className="pg-primary" onClick={() => setShowForm(true)}><FiPlus /> New database</button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="pg-grid">
        {dbs.map((d) => (
          <DbCard key={d.name} db={d} busy={busy === d.name} onErr={setErr}
            onAct={(a) => act(d.name, a)} onLogs={() => setLogsFor(d)} onBrowse={() => setBrowseFor(d)} />
        ))}
        {loading && dbs.length === 0 && <CardSkeletons />}
        {!loading && dbs.length === 0 && !err && (
          <div className="pg-empty">
            <div className="pg-empty-icon"><FiDatabase size={30} /></div>
            <b>No databases yet</b>
            <p>Run PostgreSQL, MySQL, MariaDB, Redis, Valkey, MongoDB or ClickHouse in one click.</p>
            <button className="pg-primary" onClick={() => setShowForm(true)}><FiPlus /> Create a database</button>
          </div>
        )}
      </div>

      {showForm && <CreateForm engines={engines} existing={dbs} onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load() }} />}
      {logsFor && <LogsModal db={logsFor} onClose={() => setLogsFor(null)} />}
      {browseFor && <Browser db={browseFor} onClose={() => setBrowseFor(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function DbCard({ db, busy, onAct, onLogs, onBrowse, onErr }: {
  db: Db; busy: boolean
  onAct: (a: 'start' | 'stop' | 'restart' | 'remove') => void
  onLogs: () => void; onBrowse: () => void; onErr: (e: string) => void
}) {
  const [show, setShow] = useState(false)
  const [mode, setMode] = useState<'public' | 'local'>('public')
  const [dumping, setDumping] = useState(false)
  const running = db.status === 'running'
  const host = mode === 'public' ? db.host : db.localHost
  const uri = mode === 'public' ? db.uri : db.localUri
  // Key/value engines have no database or user to show.
  const rows: [string, string, boolean?][] = [
    ['Host', host], ['Port', String(db.port)],
    ...(db.dbName ? [['Database', db.dbName] as [string, string]] : []),
    ...(db.dbUser ? [['User', db.dbUser] as [string, string]] : []),
    ['Password', db.dbPass, true],
  ]

  const dump = async () => {
    setDumping(true)
    try { await downloadDump(db.name) } catch (e) { onErr((e as Error).message) } finally { setDumping(false) }
  }

  return (
    <div className="pgcard">
      <div className="pgcard-top">
        <div className="pgcard-id">
          <span className="pgcard-dot" data-status={db.status} />
          <span className="pgcard-name">{db.name}</span>
          <span className={`pgcard-ver eng-${db.engine}`}>{db.engineLabel} {db.version}</span>
        </div>
        <span className={`pgcard-status ${db.status}`}>{db.status}</span>
      </div>

      <div className="pgcard-conn-head">
        <span>Connection URI</span>
        <div className="pgcard-seg">
          <button className={mode === 'public' ? 'on' : ''} onClick={() => setMode('public')}>Public</button>
          <button className={mode === 'local' ? 'on' : ''} onClick={() => setMode('local')}>Local</button>
        </div>
      </div>
      <div className="pgcard-uri">
        <code title={uri}>{uri}</code>
        <Copy text={uri} title={`Copy ${mode} connection URI`} />
      </div>

      <div className="pgcard-fields">
        {rows.map(([label, value, secret]) => (
          <div className="pgcard-row" key={label}>
            <span className="pgcard-k">{label}</span>
            <span className="pgcard-v">{secret && !show ? '••••••••••' : value}</span>
            {secret && (
              <button className="pg-icon-btn" title={show ? 'Hide' : 'Reveal'} onClick={() => setShow((v) => !v)}>
                {show ? <FiEyeOff size={14} /> : <FiEye size={14} />}
              </button>
            )}
            <Copy text={value} title={`Copy ${label.toLowerCase()}`} />
          </div>
        ))}
      </div>

      <div className="pgcard-actions">
        {db.browse && (
          <button className="pgcard-browse" disabled={!running} onClick={onBrowse}
            title={running ? (db.browse === 'sql' ? 'Browse tables & run SQL' : 'Open a console') : 'Start the database first'}>
            {db.browse === 'sql' ? <><FiGrid size={15} /> Browse data</> : <><FiTerminal size={15} /> Console</>}
          </button>
        )}
        <span className="pgcard-spacer" />
        {db.canDump && (
          <button className="pg-icon-btn lg" disabled={!running || dumping} onClick={dump} title="Download a dump">
            {dumping ? <div className="splash-spinner small" /> : <FiDownloadCloud size={15} />}
          </button>
        )}
        <button className="pg-icon-btn lg" onClick={onLogs} title="Logs"><FiFileText size={15} /></button>
        {running
          ? <>
              <button className="pg-icon-btn lg" disabled={busy} onClick={() => onAct('restart')} title="Restart"><FiRotateCw size={15} /></button>
              <button className="pg-icon-btn lg" disabled={busy} onClick={() => onAct('stop')} title="Stop"><FiSquare size={15} /></button>
            </>
          : <button className="pg-icon-btn lg" disabled={busy || db.status === 'provisioning'} onClick={() => onAct('start')} title="Start"><FiPlay size={15} /></button>}
        <button className="pg-icon-btn lg danger" disabled={busy} onClick={() => onAct('remove')} title="Remove"><FiTrash2 size={15} /></button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create form — the fields follow whichever engine is selected
// ---------------------------------------------------------------------------

const FALLBACK_ENGINE: DbEngine = {
  id: 'postgres', label: 'PostgreSQL', kind: 'sql', versions: ['16'], defaultVersion: '16',
  fields: { dbName: true, dbUser: true, password: true }, defaultUser: 'postgres',
  browse: 'sql', consoleHint: '', canDump: true, defaultPort: 5432,
}

function CreateForm({ engines, existing, onClose, onCreated }: {
  engines: DbEngine[]; existing: Db[]; onClose: () => void; onCreated: () => void
}) {
  const list = engines.length ? engines : [FALLBACK_ENGINE]
  const [engineId, setEngineId] = useState(list[0].id)
  const engine = list.find((e) => e.id === engineId) || list[0]
  const [name, setName] = useState('my-db')
  const [version, setVersion] = useState(engine.defaultVersion)
  const [dbName, setDbName] = useState('')
  const [dbUser, setDbUser] = useState(engine.defaultUser)
  const [password, setPassword] = useState('')
  const [port, setPort] = useState('')
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')
  const taken = existing.some((d) => d.name === name)

  // Switching engine resets the version/user to that engine's defaults.
  const pickEngine = (id: string) => {
    const e = list.find((x) => x.id === id) || list[0]
    setEngineId(id); setVersion(e.defaultVersion); setDbUser(e.defaultUser)
  }

  const submit = async () => {
    setErr(''); setCreating(true)
    try {
      await dbapi.create({
        name, engine: engineId, version,
        dbName: engine.fields.dbName ? (dbName.trim() || name.replace(/-/g, '_')) : undefined,
        dbUser: engine.fields.dbUser ? (dbUser.trim() || engine.defaultUser) : undefined,
        password,
        port: port ? Number(port) : undefined,
      })
      onCreated()
    } catch (e) { setErr((e as Error).message); setCreating(false) }
  }

  return (
    <div className="pg-overlay" onMouseDown={() => !creating && onClose()}>
      <div className="pg-modal sm" onMouseDown={(e) => e.stopPropagation()}>
        {creating ? (
          <div className="pg-creating">
            <div className="splash-spinner" />
            <b>Provisioning {engine.label}…</b>
            <p>Pulling the image and waiting for the server to accept connections.</p>
          </div>
        ) : (
          <>
            <div className="pg-modal-h"><FiDatabase /> New database</div>
            <div className="pg-modal-body">
              <label>Engine</label>
              <div className="db-engines">
                {list.map((e) => (
                  <button key={e.id} className={`db-engine ${e.id === engineId ? 'on' : ''} eng-${e.id}`} onClick={() => pickEngine(e.id)}>
                    <b>{e.label}</b>
                    <span>{e.kind === 'sql' ? 'SQL' : e.kind === 'kv' ? 'key/value' : 'document'}</span>
                  </button>
                ))}
              </div>

              <div className="pg-form-row">
                <div><label>Name</label><input value={name} onChange={(e) => setName(slug(e.target.value))} /></div>
                <div><label>Version</label>
                  <select value={version} onChange={(e) => setVersion(e.target.value)}>
                    {engine.versions.map((v) => <option key={v} value={v}>{engine.label} {v}</option>)}
                  </select>
                </div>
              </div>

              {(engine.fields.dbName || engine.fields.dbUser) && (
                <div className="pg-form-row">
                  {engine.fields.dbName && (
                    <div><label>Database name</label>
                      <input placeholder={name.replace(/-/g, '_')} value={dbName} onChange={(e) => setDbName(ident(e.target.value))} /></div>
                  )}
                  {engine.fields.dbUser && (
                    <div><label>Username</label>
                      <input value={dbUser} onChange={(e) => setDbUser(ident(e.target.value))} /></div>
                  )}
                </div>
              )}

              <div className="pg-form-row">
                <div><label>Password <span className="pg-hint">(blank = auto)</span></label>
                  <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="auto-generated" /></div>
                <div><label>Host port <span className="pg-hint">(blank = auto)</span></label>
                  <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder={`${engine.defaultPort}…`} /></div>
              </div>

              <p className="pg-note">Data lives in a persistent Docker volume and survives restarts.</p>
              {taken && <div className="sys-err">⚠ A database named “{name}” already exists.</div>}
              {err && <div className="sys-err">⚠ {err}</div>}
            </div>
            <div className="pg-modal-foot">
              <button className="pg-ghost" onClick={onClose}>Cancel</button>
              <button className="pg-primary" disabled={!name || taken} onClick={submit}>Create database</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logs modal
// ---------------------------------------------------------------------------

function LogsModal({ db, onClose }: { db: Db; onClose: () => void }) {
  const [text, setText] = useState('Loading…')
  const load = useCallback(async () => {
    try {
      const provisioning = db.status === 'provisioning' || db.status === 'failed'
      const r = provisioning ? await dbapi.log(db.name) : await dbapi.logs(db.name)
      setText(r.text || '(no output)')
    } catch (e) { setText((e as Error).message) }
  }, [db])
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [load])

  return (
    <div className="pg-overlay" onMouseDown={onClose}>
      <div className="pg-modal md" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pg-modal-h"><FiFileText /> {db.name} — logs<button className="pg-modal-x" onClick={onClose}><FiX size={17} /></button></div>
        <pre className="pg-logs">{text}</pre>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Browser — table grid for SQL engines, console for the others
// ---------------------------------------------------------------------------

const PAGE = 100

function Browser({ db, onClose }: { db: Db; onClose: () => void }) {
  const sql = db.browse === 'sql'
  const [tab, setTab] = useState<'data' | 'sql'>(sql ? 'data' : 'sql')
  const [tables, setTables] = useState<DbTable[] | null>(sql ? null : [])
  const [sel, setSel] = useState<DbTable | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!sql) return
    ;(async () => {
      try {
        const t = (await dbapi.tables(db.name)).tables
        setTables(t)
        if (t.length) setSel((s) => s || t[0])
      } catch (e) { setErr((e as Error).message) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db.name, sql])

  return (
    <div className="pg-overlay" onMouseDown={onClose}>
      <div className="pg-modal lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pg-modal-h">
          <FiDatabase /> {db.name}
          <span className="pgb-engine">{db.engineLabel}</span>
          {sql && (
            <div className="pgb-tabs">
              <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}><FiTable size={13} /> Data</button>
              <button className={tab === 'sql' ? 'on' : ''} onClick={() => setTab('sql')}><FiPlayCircle size={13} /> SQL</button>
            </div>
          )}
          <button className="pg-modal-x" onClick={onClose}><FiX size={17} /></button>
        </div>

        {err && <div className="sys-err">⚠ {err}</div>}

        <div className="pgb-body">
          {sql && (
            <aside className="pgb-side">
              <div className="pgb-side-h"><FiColumns size={12} /> Tables {tables && <span>({tables.length})</span>}</div>
              <div className="pgb-side-list">
                {tables === null && <div className="pgb-side-empty">Loading…</div>}
                {tables && tables.length === 0 && <div className="pgb-side-empty">No tables</div>}
                {tables && tables.map((t) => (
                  <button key={`${t.schema}.${t.name}`}
                    className={sel && sel.schema === t.schema && sel.name === t.name ? 'on' : ''}
                    onClick={() => { setSel(t); setTab('data') }}>
                    <FiTable size={13} />
                    <span className="pgb-tname">{t.schema === 'public' ? t.name : `${t.schema}.${t.name}`}</span>
                    <span className="pgb-trows">{t.rows}</span>
                  </button>
                ))}
              </div>
            </aside>
          )}
          <main className="pgb-main">
            {tab === 'data' && sql ? <DataView db={db} table={sel} /> : <QueryView db={db} />}
          </main>
        </div>
      </div>
    </div>
  )
}

function DataView({ db, table }: { db: Db; table: DbTable | null }) {
  const [cols, setCols] = useState<DbColumn[]>([])
  const [rows, setRows] = useState<DbRow[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { setOffset(0) }, [table])
  useEffect(() => {
    if (!table) return
    setLoading(true); setErr('')
    dbapi.table(db.name, table.schema, table.name, PAGE, offset)
      .then((r) => { setCols(r.columns); setRows(r.rows); setTotal(r.total) })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false))
  }, [db.name, table, offset])

  if (!table) return <div className="pgb-blank">Select a table on the left.</div>
  const from = total === 0 ? 0 : offset + 1
  const to = offset + rows.length
  return (
    <div className="pgb-data">
      <div className="pgb-data-bar">
        <b>{table.schema === 'public' ? table.name : `${table.schema}.${table.name}`}</b>
        <span className="pgb-count">{total != null ? `≈ ${total} rows` : ''}</span>
        <span className="pgb-spacer" />
        <button className="pg-icon-btn" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}><FiChevronLeft size={15} /></button>
        <span className="pgb-range">{from}–{to}</span>
        <button className="pg-icon-btn" disabled={loading || rows.length < PAGE} onClick={() => setOffset(offset + PAGE)}><FiChevronRight size={15} /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      <ResultGrid columns={cols.map((c) => c.name)} colTypes={cols} rows={rows} loading={loading} />
    </div>
  )
}

// SQL for SQL engines; the engine's own CLI for Redis/Valkey/MongoDB.
function QueryView({ db }: { db: Db }) {
  const sqlMode = db.browse === 'sql'
  const [text, setText] = useState(
    sqlMode ? 'SELECT 1;' : db.engine === 'mongodb' ? 'db.getCollectionNames()' : 'INFO keyspace'
  )
  const [cols, setCols] = useState<string[]>([])
  const [rows, setRows] = useState<DbRow[]>([])
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [running, setRunning] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  const run = async () => {
    setRunning(true); setErr(''); setMsg('')
    try {
      const r = await dbapi.query(db.name, text)
      if (r.message !== undefined) { setMsg(r.message); setCols([]); setRows([]) }
      else { setCols(r.columns || []); setRows(r.rows || []); setMsg(`${(r.rows || []).length} row(s)`) }
    } catch (e) { setErr((e as Error).message); setCols([]); setRows([]) }
    finally { setRunning(false) }
  }
  const onKey = (e: React.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run() } }

  return (
    <div className="pgb-sql">
      <div className="pgb-sql-editor">
        <textarea ref={ta} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} spellCheck={false}
          placeholder={sqlMode ? 'SELECT …' : db.consoleHint} />
        <div className="pgb-sql-bar">
          <span className="pg-hint">{sqlMode ? '⌘/Ctrl + Enter to run' : db.consoleHint || '⌘/Ctrl + Enter to run'}</span>
          <button className="pg-primary sm" disabled={running || !text.trim()} onClick={run}><FiPlayCircle size={14} /> Run</button>
        </div>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      {!err && msg && !rows.length && <pre className="pgb-msg out">{msg}</pre>}
      {rows.length > 0 && (
        <>
          <div className="pgb-msg subtle">{msg}</div>
          <ResultGrid columns={cols} rows={rows} loading={false} />
        </>
      )}
    </div>
  )
}

function ResultGrid({ columns, rows, loading, colTypes }: { columns: string[]; rows: DbRow[]; loading: boolean; colTypes?: DbColumn[] }) {
  if (loading) return <div className="pgb-blank">Loading…</div>
  if (!columns.length) return <div className="pgb-blank">No columns.</div>
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return <span className="pgb-null">NULL</span>
    if (typeof v === 'object') return <span className="pgb-json">{JSON.stringify(v)}</span>
    return String(v)
  }
  return (
    <div className="pgb-grid-wrap">
      <table className="pgb-grid">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={c}>{c}{colTypes && colTypes[i] && <span className="pgb-type">{colTypes[i].type}</span>}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? <tr><td className="pgb-empty-row" colSpan={columns.length}>No rows.</td></tr>
            : rows.map((r, i) => (
              <tr key={i}>{columns.map((c) => <td key={c} title={r[c] == null ? '' : String(r[c])}>{cell(r[c])}</td>)}</tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}
