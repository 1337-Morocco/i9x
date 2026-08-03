import { useEffect, useState, useCallback } from 'react'
import { FiRefreshCw, FiPlay, FiSquare, FiRotateCw, FiTrash2, FiDownload, FiFileText, FiX } from 'react-icons/fi'
import { dockerapi, type Container, type Image } from '../api/docker'

type Tab = 'containers' | 'images' | 'build'

export default function Docker() {
  const [status, setStatus] = useState<{ installed: boolean; running: boolean; version?: string; error?: string } | null>(null)
  const [tab, setTab] = useState<Tab>('containers')

  useEffect(() => { dockerapi.status().then(setStatus).catch(() => setStatus({ installed: false, running: false })) }, [])

  if (!status) return <div className="dk"><div className="dk-msg">Checking Docker…</div></div>
  if (!status.installed || !status.running) {
    return (
      <div className="dk">
        <div className="dk-msg">
          <b>{status.installed ? 'Docker is installed but not running.' : 'Docker is not installed.'}</b>
          <p>Set it up on the machine, then reopen this app:</p>
          <code>sudo apt-get install -y docker.io && sudo systemctl enable --now docker</code>
          {status.error && <div className="dk-err">{status.error}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="dk">
      <div className="sys-tabs">
        <button className={tab === 'containers' ? 'on' : ''} onClick={() => setTab('containers')}>Containers</button>
        <button className={tab === 'images' ? 'on' : ''} onClick={() => setTab('images')}>Images</button>
        <button className={tab === 'build' ? 'on' : ''} onClick={() => setTab('build')}>Build</button>
        <span className="dk-ver">Docker {status.version}</span>
      </div>
      <div className="sys-body">
        {tab === 'containers' && <Containers />}
        {tab === 'images' && <Images />}
        {tab === 'build' && <Build />}
      </div>
    </div>
  )
}

function Containers() {
  const [rows, setRows] = useState<Container[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null)

  const load = useCallback(async () => {
    try { setRows((await dockerapi.containers()).containers); setErr('') } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])

  const act = async (id: string, action: string) => {
    setBusy(id)
    try { await dockerapi.container(id, action); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }
  const showLogs = async (c: Container) => {
    try { const d = await dockerapi.logs(c.ID); setLogs({ name: c.Names, text: d.text || '(no output)' }) } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div className="dk-pane">
      <div className="sys-toolbar">
        <span className="sys-count">{rows.length} containers</span>
        <button className="sys-btn" onClick={load}><FiRefreshCw size={15} /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      <div className="dk-list">
        {rows.map((c) => {
          const on = c.State === 'running'
          return (
            <div className="dk-row" key={c.ID}>
              <span className={`svc-dot ${on ? 'run' : 'idle'}`} />
              <div className="dk-info">
                <div className="dk-name">{c.Names} <span className="dk-sub">{c.Image}</span></div>
                <div className="dk-status">{c.Status}{c.Ports ? ` · ${c.Ports}` : ''}</div>
              </div>
              <div className="svc-actions">
                <button onClick={() => showLogs(c)} title="Logs"><FiFileText size={14} /></button>
                {on
                  ? <>
                      <button disabled={busy === c.ID} onClick={() => act(c.ID, 'restart')} title="Restart"><FiRotateCw size={14} /></button>
                      <button disabled={busy === c.ID} onClick={() => act(c.ID, 'stop')} title="Stop"><FiSquare size={14} /></button>
                    </>
                  : <button disabled={busy === c.ID} onClick={() => act(c.ID, 'start')} title="Start"><FiPlay size={14} /></button>}
                <button disabled={busy === c.ID} onClick={() => act(c.ID, 'remove')} title="Remove"><FiTrash2 size={14} /></button>
              </div>
            </div>
          )
        })}
        {rows.length === 0 && !err && <div className="sys-empty">No containers</div>}
      </div>
      {logs && (
        <div className="dk-logs">
          <div className="dk-logs-h">Logs — {logs.name}<button onClick={() => setLogs(null)}><FiX /></button></div>
          <pre className="logs-pre">{logs.text}</pre>
        </div>
      )}
    </div>
  )
}

function Images() {
  const [rows, setRows] = useState<Image[]>([])
  const [err, setErr] = useState('')
  const [pullImg, setPullImg] = useState('')
  const [busy, setBusy] = useState('')
  const [runFor, setRunFor] = useState<Image | null>(null)
  const [runName, setRunName] = useState('')
  const [runPorts, setRunPorts] = useState('')

  const load = useCallback(async () => {
    try { setRows((await dockerapi.images()).images); setErr('') } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  const pull = async () => {
    if (!pullImg.trim()) return
    setBusy('pull')
    try { await dockerapi.pull(pullImg.trim()); setPullImg(''); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }
  const remove = async (id: string) => {
    setBusy(id)
    try { await dockerapi.removeImage(id); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }
  const doRun = async () => {
    if (!runFor) return
    setBusy('run')
    try {
      await dockerapi.run(`${runFor.Repository}:${runFor.Tag}`, runName.trim(), runPorts.trim())
      setRunFor(null); setRunName(''); setRunPorts('')
    } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  return (
    <div className="dk-pane">
      <div className="sys-toolbar">
        <div className="sys-search">
          <FiDownload size={15} />
          <input placeholder="Pull image, e.g. nginx:latest" value={pullImg} onChange={(e) => setPullImg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pull()} />
        </div>
        <button className="dk-primary" disabled={busy === 'pull' || !pullImg.trim()} onClick={pull}>{busy === 'pull' ? 'Pulling…' : 'Pull'}</button>
        <button className="sys-btn" onClick={load}><FiRefreshCw size={15} /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      <div className="dk-list">
        {rows.map((im) => (
          <div className="dk-row" key={im.ID + im.Tag}>
            <div className="dk-info">
              <div className="dk-name">{im.Repository}:{im.Tag}</div>
              <div className="dk-status">{im.Size} · {im.CreatedSince}</div>
            </div>
            <div className="svc-actions">
              <button onClick={() => { setRunFor(im); setRunName(''); setRunPorts('') }} title="Run"><FiPlay size={14} /></button>
              <button disabled={busy === im.ID} onClick={() => remove(im.ID)} title="Remove"><FiTrash2 size={14} /></button>
            </div>
          </div>
        ))}
        {rows.length === 0 && !err && <div className="sys-empty">No images — pull one above</div>}
      </div>
      {runFor && (
        <div className="dk-run">
          <div className="dk-run-h">Run {runFor.Repository}:{runFor.Tag}</div>
          <div className="dk-run-fields">
            <input placeholder="Container name (optional)" value={runName} onChange={(e) => setRunName(e.target.value)} />
            <input placeholder="Ports e.g. 8080:80" value={runPorts} onChange={(e) => setRunPorts(e.target.value)} />
          </div>
          <div className="dk-run-actions">
            <button className="modal-btn ghost" onClick={() => setRunFor(null)}>Cancel</button>
            <button className="dk-primary" disabled={busy === 'run'} onClick={doRun}>{busy === 'run' ? 'Starting…' : 'Run'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function Build() {
  const [path, setPath] = useState('')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')

  const build = async () => {
    setBusy(true); setErr(''); setOut('')
    try { const d = await dockerapi.build(path.trim(), tag.trim()); setOut(d.output || 'Build complete.') }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="dk-pane dk-build">
      <div className="dk-build-form">
        <label>Build context (folder with a Dockerfile)</label>
        <input placeholder="/home/user/myapp" value={path} onChange={(e) => setPath(e.target.value)} />
        <label>Image tag</label>
        <input placeholder="myapp:latest" value={tag} onChange={(e) => setTag(e.target.value)} />
        <button className="dk-primary" disabled={busy || !path.startsWith('/') || !tag.trim()} onClick={build}>
          {busy ? 'Building…' : 'Build image'}
        </button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      {out && <pre className="logs-pre">{out}</pre>}
    </div>
  )
}
