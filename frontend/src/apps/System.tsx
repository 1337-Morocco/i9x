import { useEffect, useRef, useState, useCallback } from 'react'
import { FiRefreshCw, FiPlay, FiSquare, FiRotateCw, FiSearch } from 'react-icons/fi'
import { sysapi, type Service, type Iface, type Conn } from '../api/sys'
import { humanSize } from '../api/fs'

type Tab = 'services' | 'network' | 'logs'

export default function System() {
  const [tab, setTab] = useState<Tab>('services')
  return (
    <div className="sys">
      <div className="sys-tabs">
        <button className={tab === 'services' ? 'on' : ''} onClick={() => setTab('services')}>Services</button>
        <button className={tab === 'network' ? 'on' : ''} onClick={() => setTab('network')}>Network</button>
        <button className={tab === 'logs' ? 'on' : ''} onClick={() => setTab('logs')}>Logs</button>
      </div>
      <div className="sys-body">
        {tab === 'services' && <Services />}
        {tab === 'network' && <Network />}
        {tab === 'logs' && <Logs />}
      </div>
    </div>
  )
}

// ---------------- Services ----------------
function Services() {
  const [services, setServices] = useState<Service[]>([])
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { setServices((await sysapi.services()).services); setErr('') }
    catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (unit: string, action: string) => {
    setBusy(unit)
    try { await sysapi.serviceAction(unit, action); await load() }
    catch (e) { setErr((e as Error).message) }
    finally { setBusy('') }
  }

  const shown = services.filter((s) => s.unit.toLowerCase().includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="svc">
      <div className="sys-toolbar">
        <div className="sys-search"><FiSearch size={15} /><input placeholder="Filter services…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="sys-count">{shown.length} units</span>
        <button className="sys-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      <div className="svc-list">
        {shown.map((s) => {
          const on = s.active === 'active'
          return (
            <div className="svc-row" key={s.unit}>
              <span className={`svc-dot ${s.sub === 'running' ? 'run' : s.active === 'failed' ? 'fail' : 'idle'}`} />
              <div className="svc-info">
                <div className="svc-name">{s.unit}</div>
                <div className="svc-desc">{s.description || s.sub}</div>
              </div>
              <span className={`svc-state ${on ? 'on' : ''}`}>{s.active}</span>
              <div className="svc-actions">
                {on
                  ? <>
                      <button disabled={busy === s.unit} onClick={() => act(s.unit, 'restart')} title="Restart"><FiRotateCw size={14} /></button>
                      <button disabled={busy === s.unit} onClick={() => act(s.unit, 'stop')} title="Stop"><FiSquare size={14} /></button>
                    </>
                  : <button disabled={busy === s.unit} onClick={() => act(s.unit, 'start')} title="Start"><FiPlay size={14} /></button>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------- Network ----------------
function Network() {
  const [ifaces, setIfaces] = useState<Iface[]>([])
  const [conns, setConns] = useState<Conn[]>([])
  const [rates, setRates] = useState<Record<string, { rx: number; tx: number }>>({})
  const prev = useRef<{ t: number; by: Record<string, { rx: number; tx: number }> } | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const d = await sysapi.net()
        if (!alive) return
        setIfaces(d.interfaces)
        setConns(d.connections)
        const now = Date.now()
        if (prev.current) {
          const dt = (now - prev.current.t) / 1000
          const r: Record<string, { rx: number; tx: number }> = {}
          for (const i of d.interfaces) {
            const p = prev.current.by[i.name]
            if (p && dt > 0) r[i.name] = { rx: Math.max(0, (i.rx - p.rx) / dt), tx: Math.max(0, (i.tx - p.tx) / dt) }
          }
          setRates(r)
        }
        prev.current = { t: now, by: Object.fromEntries(d.interfaces.map((i) => [i.name, { rx: i.rx, tx: i.tx }])) }
      } catch { /* ignore */ }
    }
    poll(); const t = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  return (
    <div className="net">
      <div className="net-ifaces">
        {ifaces.map((i) => (
          <div className="net-card" key={i.name}>
            <div className="net-card-h">
              <b>{i.name}</b>
              <span className={`net-state ${i.state === 'UP' ? 'up' : ''}`}>{i.state}</span>
            </div>
            <div className="net-addrs">{i.addrs.map((a) => a.local).join(', ') || '—'}</div>
            <div className="net-rates">
              <span>↓ {humanSize(rates[i.name]?.rx ?? 0)}/s</span>
              <span>↑ {humanSize(rates[i.name]?.tx ?? 0)}/s</span>
            </div>
            <div className="net-totals">{humanSize(i.rx)} in · {humanSize(i.tx)} out</div>
          </div>
        ))}
      </div>
      <div className="net-conns">
        <div className="net-conn-head"><span className="c1">Proto</span><span className="c2">Local</span><span className="c3">Peer</span><span className="c4">State</span><span className="c5">Process</span></div>
        <div className="net-conn-body">
          {conns.map((c, i) => (
            <div className="net-conn-row" key={i}>
              <span className="c1">{c.proto}</span><span className="c2">{c.local}</span><span className="c3">{c.peer}</span><span className="c4">{c.state}</span><span className="c5">{c.proc}</span>
            </div>
          ))}
          {conns.length === 0 && <div className="sys-empty">No active connections</div>}
        </div>
      </div>
    </div>
  )
}

// ---------------- Logs ----------------
function Logs() {
  const [source, setSource] = useState('journal')
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(true)
  const [err, setErr] = useState('')
  const preRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async (src: string) => {
    try {
      const d = await sysapi.log(src, 400)
      setText(d.text || '(empty)')
      setErr('')
    } catch (e) { setErr((e as Error).message) }
  }, [])

  useEffect(() => {
    load(source)
    if (!auto) return
    const t = setInterval(() => load(source), 2000)
    return () => clearInterval(t)
  }, [source, auto, load])

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text])

  return (
    <div className="logs">
      <div className="sys-toolbar">
        <select value={source} onChange={(e) => setSource(e.target.value)} className="sys-select">
          <option value="journal">System journal</option>
          <option value="kernel">Kernel (dmesg)</option>
          <option value="syslog">/var/log/syslog</option>
          <option value="auth">/var/log/auth.log</option>
        </select>
        <label className="sys-auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Live</label>
        <button className="sys-btn" onClick={() => load(source)} title="Refresh"><FiRefreshCw size={15} /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      <pre className="logs-pre" ref={preRef}>{text}</pre>
    </div>
  )
}
