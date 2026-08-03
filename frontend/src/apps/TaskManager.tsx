import { useEffect, useRef, useState } from 'react'
import { FiCpu, FiHardDrive, FiClock, FiServer } from 'react-icons/fi'
import { sysapi, fmtUptime, type Stats, type Proc } from '../api/sys'
import { humanSize } from '../api/fs'

// A live system monitor for the real machine: CPU, memory, load, and the
// top processes, refreshed on an interval.
export default function TaskManager() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [procs, setProcs] = useState<Proc[]>([])
  const [err, setErr] = useState('')
  const cpuHistory = useRef<number[]>([])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const [s, p] = await Promise.all([sysapi.stats(), sysapi.processes()])
        if (!alive) return
        setStats(s)
        setProcs(p.processes)
        if (s.cpu != null) {
          cpuHistory.current = [...cpuHistory.current, s.cpu].slice(-40)
        }
        setErr('')
      } catch (e) {
        if (alive) setErr((e as Error).message)
      }
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const cpu = stats?.cpu ?? 0
  const mem = stats?.mem
  const memPct = mem ? (mem.used / mem.total) * 100 : 0
  const hist = cpuHistory.current

  // Sparkline path for CPU history.
  const spark = hist.length > 1
    ? hist.map((v, i) => `${(i / (hist.length - 1)) * 100},${40 - (v / 100) * 38}`).join(' ')
    : ''

  return (
    <div className="tm">
      <div className="tm-cards">
        <div className="tm-card">
          <div className="tm-card-h"><FiCpu /> CPU</div>
          <div className="tm-big" style={{ color: cpu > 80 ? '#e0392b' : '#e95420' }}>{cpu.toFixed(0)}<small>%</small></div>
          <svg className="tm-spark" viewBox="0 0 100 40" preserveAspectRatio="none">
            {spark && <polyline points={spark} fill="none" stroke="#e95420" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          </svg>
          <div className="tm-sub">{stats?.cores ?? '–'} core{stats && stats.cores !== 1 ? 's' : ''}</div>
        </div>

        <div className="tm-card">
          <div className="tm-card-h"><FiHardDrive /> Memory</div>
          <div className="tm-big">{mem ? (mem.used / 1e9).toFixed(1) : '–'}<small> / {mem ? (mem.total / 1e9).toFixed(1) : '–'} GB</small></div>
          <div className="tm-bar"><div className="tm-bar-fill" style={{ width: `${memPct}%`, background: memPct > 85 ? '#e0392b' : '#772953' }} /></div>
          <div className="tm-sub">{memPct.toFixed(0)}% used · {mem ? humanSize(mem.free) : '–'} free</div>
        </div>

        <div className="tm-card">
          <div className="tm-card-h"><FiServer /> System</div>
          <div className="tm-rows-mini">
            <div><span>Host</span><b>{stats?.hostname ?? '–'}</b></div>
            <div><span>Load</span><b>{stats ? stats.load.map((l) => l.toFixed(2)).join('  ') : '–'}</b></div>
            <div><span><FiClock size={12} /> Uptime</span><b>{stats ? fmtUptime(stats.uptime) : '–'}</b></div>
          </div>
        </div>
      </div>

      {err && <div className="tm-err">⚠ {err}</div>}

      <div className="tm-proc">
        <div className="tm-proc-head">
          <span className="c-name">Process</span>
          <span className="c-pid">PID</span>
          <span className="c-cpu">CPU%</span>
          <span className="c-mem">MEM%</span>
          <span className="c-rss">Memory</span>
        </div>
        <div className="tm-proc-body">
          {procs.map((p) => (
            <div className="tm-row" key={p.pid} title={p.command}>
              <span className="c-name">{p.name}</span>
              <span className="c-pid">{p.pid}</span>
              <span className="c-cpu">
                <span className="tm-cpu-cell">
                  <span className="tm-cpu-bar" style={{ width: `${Math.min(100, p.cpu)}%` }} />
                  {p.cpu.toFixed(1)}
                </span>
              </span>
              <span className="c-mem">{p.mem.toFixed(1)}</span>
              <span className="c-rss">{humanSize(p.rss)}</span>
            </div>
          ))}
          {procs.length === 0 && !err && <div className="tm-empty">Loading processes…</div>}
        </div>
      </div>
    </div>
  )
}
