import { useEffect, useState, useCallback } from 'react'
import {
  FiPlus, FiRefreshCw, FiExternalLink, FiTrash2, FiLock, FiGlobe, FiRotateCw,
  FiCheckCircle, FiAlertTriangle, FiXCircle, FiCopy, FiCheck, FiSliders,
  FiChevronRight, FiChevronDown,
} from 'react-icons/fi'
import {
  proxyapi, ProxyError, defaultLb, defaultRate,
  type ProxySite, type Precheck, type Cert, type ProxyStatus,
  type Backend, type LbMethod, type LbSettings, type RateSettings,
} from '../api/proxy'
import { CardSkeletons } from './Skeleton'
// Named to avoid clashing with the ProxyConfig *type* below (the backend-pool
// shape shared with the add form).
import ProxyConfigDrawer from './ProxyConfig'

// Last known list — reopening the app repaints instantly (see WordPress.tsx).
let cached: ProxySite[] | null = null

// Copy that also works when the page isn't a secure context (plain http on a
// LAN address), where navigator.clipboard is unavailable.
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch { return false }
  }
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="dom-copy"
      title={`Copy ${value}`}
      onClick={async () => { if (await copyText(value)) { setDone(true); setTimeout(() => setDone(false), 1400) } }}
    >
      {done ? <FiCheck size={12} /> : <FiCopy size={12} />} {done ? 'Copied' : value}
    </button>
  )
}

// The DNS verdict for a domain, shown before we ever call certbot.
function PrecheckLine({ p, checking }: { p: Precheck | null; checking: boolean }) {
  if (checking) return <div className="dom-pre checking"><div className="splash-spinner small" /> Checking DNS…</div>
  if (!p) return null
  const Icon = p.level === 'ok' ? FiCheckCircle : p.level === 'warn' ? FiAlertTriangle : FiXCircle
  return (
    <div className={`dom-pre ${p.level}`}>
      <Icon size={15} className="dom-pre-icon" />
      <div className="dom-pre-body">
        <div>{p.message}</div>
        {p.hint && <div className="dom-pre-hint">{p.hint}</div>}
        {p.code === 'nodns' && p.serverIp && (
          <div className="dom-pre-record">
            <span>A</span>
            <b>{p.domain.split('.').length <= 2 ? '@' : p.domain.split('.').slice(0, -2).join('.')}</b>
            <span>→</span>
            <CopyButton value={p.serverIp} />
          </div>
        )}
      </div>
    </div>
  )
}

// Debounced DNS pre-flight for whatever the user is typing.
function usePrecheck(domain: string, enabled: boolean) {
  const [precheck, setPrecheck] = useState<Precheck | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const d = domain.trim().toLowerCase()
    if (!enabled || d.length < 4 || !d.includes('.')) { setPrecheck(null); setChecking(false); return }
    let alive = true
    setChecking(true)
    const t = setTimeout(async () => {
      try { const r = await proxyapi.precheck(d); if (alive) setPrecheck(r) } catch { if (alive) setPrecheck(null) }
      finally { if (alive) setChecking(false) }
    }, 600)
    return () => { alive = false; clearTimeout(t) }
  }, [domain, enabled])
  return { precheck, checking }
}

// ---------------------------------------------------------------------------
// Load balancing + rate limiting
//
// One config object edited by both the add form and the per-domain settings
// dialog, so a domain is created and later reconfigured through the same UI.
// ---------------------------------------------------------------------------

export type ProxyConfig = { targets: Backend[]; lb: LbSettings; rate: RateSettings }

const LB_LABEL: Record<LbMethod, string> = {
  round_robin: 'Round robin',
  least_conn: 'Least connections',
  ip_hash: 'IP hash (sticky sessions)',
}

const LB_BLURB: Record<LbMethod, string> = {
  round_robin: 'Requests go to each backend in turn, in proportion to its weight.',
  least_conn: 'Each request goes to the backend with the fewest open connections — best for slow or uneven requests.',
  ip_hash: 'A visitor always lands on the same backend, so in-memory sessions keep working.',
}

const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number(v) || lo)))

// Plain-English echo of what the limit will actually do, so nobody has to
// reason about nginx's leaky bucket to set it.
function rateSummary(r: RateSettings) {
  if (!r.enabled) return ''
  const per = r.unit === 's' ? 'second' : 'minute'
  const burst = r.burst > 0
    ? ` Bursts of up to ${r.burst} extra requests are ${r.nodelay ? 'served straight away' : 'queued and released at that rate'}.`
    : ' Anything above that rate is rejected immediately.'
  const conns = r.conns > 0 ? ` No more than ${r.conns} simultaneous connection${r.conns === 1 ? '' : 's'} per IP.` : ''
  return `Each visitor IP gets ${r.rate} request${r.rate === 1 ? '' : 's'} per ${per}.${burst}${conns} Rejected requests get HTTP 429.`
}

function BackendRows({ cfg, set }: { cfg: ProxyConfig; set: (c: ProxyConfig) => void }) {
  const { targets } = cfg
  const patch = (i: number, p: Partial<Backend>) =>
    set({ ...cfg, targets: targets.map((t, j) => (j === i ? { ...t, ...p } : t)) })

  return (
    <div className="lb-list">
      {targets.map((t, i) => (
        <div className="lb-row" key={i}>
          <input
            className="lb-host"
            placeholder="8100 or 10.0.0.5:8100"
            value={t.host}
            onChange={(e) => patch(i, { host: e.target.value })}
          />
          <label className="lb-num" title="Share of traffic relative to the other backends">
            weight
            <input type="number" min={1} max={100} value={t.weight} onChange={(e) => patch(i, { weight: num(e.target.value, 1, 100) })} />
          </label>
          <label
            className="lb-backup"
            title={cfg.lb.method === 'ip_hash' ? 'Backups are not available with IP hash' : 'Only takes traffic when every primary backend is down'}
          >
            <input
              type="checkbox"
              disabled={cfg.lb.method === 'ip_hash'}
              checked={t.backup}
              onChange={(e) => patch(i, { backup: e.target.checked })}
            />
            backup
          </label>
          <button
            className="lb-del"
            title="Remove this backend"
            disabled={targets.length === 1}
            onClick={() => set({ ...cfg, targets: targets.filter((_, j) => j !== i) })}
          >
            <FiTrash2 size={13} />
          </button>
        </div>
      ))}
      <button className="lb-add" onClick={() => set({ ...cfg, targets: [...targets, { host: '', weight: 1, backup: false }] })}>
        <FiPlus size={13} /> Add backend
      </button>
      {targets.length > 1 && <div className="lb-note">{LB_BLURB[cfg.lb.method]}</div>}
    </div>
  )
}

// The balancing method, passive health checks and rate limits. Collapsible in
// the add form, always open in the settings dialog.
function AdvancedSettings({ cfg, set }: { cfg: ProxyConfig; set: (c: ProxyConfig) => void }) {
  const { lb, rate } = cfg
  const setLb = (p: Partial<LbSettings>) => set({ ...cfg, lb: { ...lb, ...p } })
  const setRate = (p: Partial<RateSettings>) => set({ ...cfg, rate: { ...rate, ...p } })

  return (
    <>
      <label>Balancing method</label>
      <select
        className="nx-fw-select lb-full"
        value={lb.method}
        onChange={(e) => {
          const method = e.target.value as LbMethod
          // nginx refuses `backup` inside an ip_hash upstream — drop the flags
          // rather than let the save fail on the server.
          set({ ...cfg, lb: { ...lb, method }, targets: method === 'ip_hash' ? cfg.targets.map((t) => ({ ...t, backup: false })) : cfg.targets })
        }}
      >
        {(Object.keys(LB_LABEL) as LbMethod[]).map((m) => <option key={m} value={m}>{LB_LABEL[m]}</option>)}
      </select>
      <div className="lb-note">{LB_BLURB[lb.method]}</div>

      <label>Health checks <span className="wp-hint">(a failing backend is taken out of rotation)</span></label>
      <div className="rl-grid">
        <label className="lb-num wide">
          Failures before eviction
          <input type="number" min={0} max={100} value={lb.maxFails} onChange={(e) => setLb({ maxFails: num(e.target.value, 0, 100) })} />
        </label>
        <label className="lb-num wide">
          Stays out for (seconds)
          <input type="number" min={1} max={3600} value={lb.failTimeout} onChange={(e) => setLb({ failTimeout: num(e.target.value, 1, 3600) })} />
        </label>
      </div>
      {lb.maxFails === 0 && <div className="lb-note">0 disables health checks — every backend keeps receiving traffic even while it is failing.</div>}

      <label className="wp-check">
        <input type="checkbox" checked={rate.enabled} onChange={(e) => setRate({ enabled: e.target.checked })} />
        Rate limit requests per visitor IP
      </label>
      {rate.enabled && (
        <>
          <div className="rl-grid">
            <label className="lb-num wide">
              Requests
              <input type="number" min={1} max={100000} value={rate.rate} onChange={(e) => setRate({ rate: num(e.target.value, 1, 100000) })} />
            </label>
            <label className="lb-num wide">
              Per
              <select className="nx-fw-select" value={rate.unit} onChange={(e) => setRate({ unit: e.target.value as 's' | 'm' })}>
                <option value="s">second</option>
                <option value="m">minute</option>
              </select>
            </label>
            <label className="lb-num wide">
              Burst allowance
              <input type="number" min={0} max={100000} value={rate.burst} onChange={(e) => setRate({ burst: num(e.target.value, 0, 100000) })} />
            </label>
            <label className="lb-num wide">
              Max connections per IP <span className="wp-hint">(0 = off)</span>
              <input type="number" min={0} max={65535} value={rate.conns} onChange={(e) => setRate({ conns: num(e.target.value, 0, 65535) })} />
            </label>
          </div>
          {rate.burst > 0 && (
            <label className="wp-check">
              <input type="checkbox" checked={rate.nodelay} onChange={(e) => setRate({ nodelay: e.target.checked })} />
              Serve the burst immediately <span className="wp-hint">(off: queue it and drip out at the limit)</span>
            </label>
          )}
          <div className="rl-summary">{rateSummary(rate)}</div>
        </>
      )}
    </>
  )
}

// certbot's raw output, hidden behind a toggle.
function Detail({ text }: { text?: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="dom-detail">
      <button onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} certbot output</button>
      {open && <pre className="logs-pre">{text}</pre>}
    </div>
  )
}

export default function Domains() {
  const [sites, setSites] = useState<ProxySite[]>(cached ?? [])
  const [loading, setLoading] = useState(cached === null)
  const [certs, setCerts] = useState<Record<string, Cert>>({})
  const [status, setStatus] = useState<ProxyStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [httpsFor, setHttpsFor] = useState<ProxySite | null>(null)
  const [settingsFor, setSettingsFor] = useState<ProxySite | null>(null)

  const load = useCallback(async () => {
    try {
      const s = (await proxyapi.sites()).sites
      cached = s; setSites(s); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [])

  const loadCerts = useCallback(async () => {
    try {
      const byDomain: Record<string, Cert> = {}
      for (const c of (await proxyapi.certs()).certs) for (const d of c.domains) byDomain[d] = c
      setCerts(byDomain)
    } catch { /* certbot missing or not root — cards just omit expiry */ }
  }, [])

  useEffect(() => {
    proxyapi.status().then(setStatus).catch(() => {})
    load(); loadCerts()
    const t = setInterval(load, 6000)
    return () => clearInterval(t)
  }, [load, loadCerts])

  const remove = async (domain: string) => {
    if (!confirm(`Remove the reverse-proxy config for ${domain}?`)) return
    setBusy(domain)
    try { await proxyapi.remove(domain); await load(); await loadCerts() }
    catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  const renew = async (domain: string) => {
    setBusy(domain); setErr('')
    try { await proxyapi.renew(domain); await loadCerts() }
    catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  return (
    <div className="wp">
      <div className="wp-head">
        <div className="wp-title"><FiGlobe /> Domains &amp; Reverse Proxy</div>
        <button className="sys-btn" onClick={() => { load(); loadCerts() }} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className="wp-new dom" onClick={() => setShowForm(true)}><FiPlus /> Add domain</button>
      </div>

      {status && (!status.nginx || !status.certbot) && (
        <div className="dom-warn">
          {!status.nginx && <>nginx isn’t installed. </>}
          {!status.certbot && <>certbot (HTTPS) isn’t installed. </>}
          Install with: <code>sudo apt-get install -y nginx certbot python3-certbot-nginx</code>
        </div>
      )}
      {status && status.certbot && !status.autoRenew && (
        <div className="dom-warn">
          Certificate auto-renewal is off — certificates expire after 90 days. Enable it with:{' '}
          <code>sudo systemctl enable --now certbot.timer</code>
        </div>
      )}
      {status?.publicIp && (
        <div className="dom-ip">This server’s public IP: <CopyButton value={status.publicIp} /> — point your domain’s A record here.</div>
      )}
      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="wp-grid">
        {sites.map((s) => {
          const cert = certs[s.domain]
          return (
            <div className="wp-card" key={s.domain}>
              <div className="wp-card-h">
                <div className="wp-card-title">{s.domain}</div>
                <span className={`wp-status ${s.https ? 'running' : 'stopped'}`}>{s.https ? 'https' : 'http'}</span>
              </div>
              <div className="wp-card-url">
                <a href={`${s.https ? 'https' : 'http'}://${s.domain}`} target="_blank" rel="noreferrer">
                  {s.https ? 'https' : 'http'}://{s.domain} <FiExternalLink size={12} />
                </a>
              </div>
              <CardTargets s={s} />
              {s.https && cert && (
                <div className={`dom-cert ${cert.days !== null && cert.days < 21 ? 'soon' : ''}`}>
                  {cert.valid
                    ? <>Certificate valid — {cert.days} day{cert.days === 1 ? '' : 's'} left{cert.days !== null && cert.days > 30 ? ' (auto-renews at 30)' : ''}</>
                    : <>Certificate expired — renew it now</>}
                </div>
              )}
              <div className="wp-card-actions">
                <button disabled={busy === s.domain} onClick={() => setSettingsFor(s)} title="nginx configuration"><FiSliders size={14} /></button>
                {!s.https && (
                  <button disabled={busy === s.domain} onClick={() => setHttpsFor(s)} title="Enable HTTPS"><FiLock size={14} /></button>
                )}
                {s.https && (
                  <button disabled={busy === s.domain} onClick={() => renew(s.domain)} title="Renew certificate now"><FiRotateCw size={14} /></button>
                )}
                <button className="danger" disabled={busy === s.domain} onClick={() => remove(s.domain)} title="Remove"><FiTrash2 size={14} /></button>
              </div>
            </div>
          )
        })}
        {loading && sites.length === 0 && <CardSkeletons />}
        {!loading && sites.length === 0 && !err && (
          <div className="wp-empty">
            <FiGlobe size={40} />
            <p>No domains configured.</p>
            <button className="wp-new dom" onClick={() => setShowForm(true)}><FiPlus /> Point a domain at an app</button>
          </div>
        )}
      </div>

      {showForm && <AddForm onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); load(); loadCerts() }} />}
      {httpsFor && (
        <HttpsDialog
          site={httpsFor}
          onClose={() => setHttpsFor(null)}
          onDone={() => { setHttpsFor(null); load(); loadCerts() }}
        />
      )}
      {settingsFor && (
        <ProxyConfigDrawer
          site={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSaved={() => { load(); loadCerts() }}
        />
      )}
    </div>
  )
}

// What a domain currently does with traffic: one backend, or a pool plus
// whatever limits are in front of it.
function CardTargets({ s }: { s: ProxySite }) {
  const n = s.targets.length
  const chips = n > 1 || s.rate.enabled
  return (
    <>
      <div className="wp-card-meta">
        {n === 1
          ? <>→ proxies to <b>{s.targets[0].host}</b></>
          : <>→ balances across <b>{n} backends</b> · {LB_LABEL[s.lb.method].toLowerCase()}</>}
      </div>
      {chips && (
        <div className="dom-chips">
          {n > 1 && s.targets.map((t) => (
            <span className={`dom-chip${t.backup ? ' backup' : ''}`} key={t.host}>
              {t.host}{t.weight > 1 ? ` ×${t.weight}` : ''}{t.backup ? ' backup' : ''}
            </span>
          ))}
          {s.rate.enabled && (
            <span className="dom-chip rate" title={rateSummary(s.rate)}>
              {s.rate.rate}/{s.rate.unit === 's' ? 'sec' : 'min'}{s.rate.burst > 0 ? ` +${s.rate.burst}` : ''} per IP
            </span>
          )}
          {s.rate.enabled && s.rate.conns > 0 && <span className="dom-chip rate">{s.rate.conns} conns/IP</span>}
        </div>
      )}
      {/* What else is switched on for this domain — force-https, cache, rules… */}
      {!!s.badges?.length && (
        <div className="dom-chips">
          {s.badges.map((b) => <span className="dom-chip cfg" key={b}>{b}</span>)}
        </div>
      )}
    </>
  )
}

// Enable HTTPS on an existing domain: shows the DNS verdict first, then runs
// certbot and explains any failure instead of dumping the log.
function HttpsDialog({ site, onClose, onDone }: { site: ProxySite; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [hint, setHint] = useState('')
  const [detail, setDetail] = useState('')
  const { precheck, checking } = usePrecheck(site.domain, true)
  const blocked = precheck?.level === 'error'

  const go = async (force: boolean) => {
    setErr(''); setHint(''); setDetail(''); setBusy(true)
    try { await proxyapi.enableHttps(site.domain, email.trim(), force); onDone() }
    catch (e) {
      const pe = e as ProxyError
      setErr(pe.message); setHint(pe.hint || pe.precheck?.hint || ''); setDetail(pe.detail || '')
      setBusy(false)
    }
  }

  return (
    <div className="wp-form-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="wp-form" onMouseDown={(e) => e.stopPropagation()}>
        {busy ? (
          <div className="wp-creating">
            <div className="splash-spinner" />
            <b>Requesting a certificate…</b>
            <p>Let’s Encrypt is verifying {site.domain} over port 80. This usually takes a few seconds.</p>
          </div>
        ) : (
          <>
            <div className="wp-form-h"><FiLock /> Enable HTTPS for {site.domain}</div>
            <PrecheckLine p={precheck} checking={checking} />
            <label>Email <span className="wp-hint">(expiry notices from Let’s Encrypt)</span></label>
            <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            {err && <div className="sys-err">⚠ {err}{hint && <div className="dom-pre-hint">{hint}</div>}</div>}
            <Detail text={detail} />
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={onClose}>Cancel</button>
              {blocked
                ? <button className="modal-btn" disabled={!email.trim()} onClick={() => go(true)}>Try anyway</button>
                : <button className="wp-new dom" disabled={!email.trim() || checking} onClick={() => go(false)}>Get certificate</button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function AddForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [domain, setDomain] = useState('')
  const [cfg, setCfg] = useState<ProxyConfig>(() => ({ targets: [{ host: '', weight: 1, backup: false }], lb: defaultLb(), rate: defaultRate() }))
  const [advanced, setAdvanced] = useState(false)
  const [https, setHttps] = useState(true)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [hint, setHint] = useState('')
  const [note, setNote] = useState('')
  const [detail, setDetail] = useState('')
  const { precheck, checking } = usePrecheck(domain, https)
  const blocked = https && precheck?.level === 'error'
  const hasTargets = cfg.targets.every((t) => t.host.trim())

  // wantHttps is passed explicitly: "Add HTTP only" must not depend on a
  // setHttps() that hasn't been applied yet when submit runs.
  const submit = async (force: boolean, wantHttps = https) => {
    setErr(''); setHint(''); setNote(''); setDetail(''); setBusy(true)
    try {
      const r = await proxyapi.create({
        domain: domain.trim().toLowerCase(),
        targets: cfg.targets.map((t) => ({ ...t, host: t.host.trim() })),
        lb: cfg.lb,
        rate: cfg.rate,
        https: wantHttps,
        email: wantHttps ? email.trim() : '',
        force,
      })
      // Partial success: the HTTP proxy is live but the certificate failed.
      if (r.message) { setNote(r.message); setDetail(r.detail || ''); setBusy(false) }
      else onDone()
    } catch (e) {
      const pe = e as ProxyError
      setErr(pe.message); setHint(pe.hint || ''); setDetail(pe.detail || '')
      setBusy(false)
    }
  }

  return (
    <div className="wp-form-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="wp-form" onMouseDown={(e) => e.stopPropagation()}>
        {busy ? (
          <div className="wp-creating">
            <div className="splash-spinner" />
            <b>Configuring nginx…</b>
            <p>Writing the vhost{https ? ' and requesting a certificate' : ''}. This can take a moment.</p>
          </div>
        ) : (
          <>
            <div className="wp-form-h"><FiGlobe /> Add a domain</div>
            <label>Domain</label>
            <input placeholder="app.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
            <label>Proxy to <span className="wp-hint">(port, or host:port — add more than one to load balance)</span></label>
            <BackendRows cfg={cfg} set={setCfg} />
            <button className="dom-adv" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />} Load balancing &amp; rate limiting
              {!advanced && cfg.rate.enabled && <span className="dom-chip rate">on</span>}
            </button>
            {advanced && <div className="dom-adv-body"><AdvancedSettings cfg={cfg} set={setCfg} /></div>}
            <label className="wp-check">
              <input type="checkbox" checked={https} onChange={(e) => setHttps(e.target.checked)} />
              Get a free HTTPS certificate (Let’s Encrypt)
            </label>
            {https && (
              <>
                <PrecheckLine p={precheck} checking={checking} />
                <label>Email <span className="wp-hint">(for the certificate)</span></label>
                <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </>
            )}
            {note && <div className="sys-err">⚠ Proxy is live over HTTP, but the certificate failed: {note}</div>}
            {err && <div className="sys-err">⚠ {err}{hint && <div className="dom-pre-hint">{hint}</div>}</div>}
            <Detail text={detail} />
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={note ? onDone : onClose}>{note ? 'Done' : 'Cancel'}</button>
              {!note && (blocked
                ? <>
                    <button className="modal-btn" disabled={!domain.trim() || !hasTargets} onClick={() => submit(false, false)}>Add HTTP only</button>
                    <button className="modal-btn" disabled={!domain.trim() || !hasTargets || !email.trim()} onClick={() => submit(true)}>Try anyway</button>
                  </>
                : <button className="wp-new dom" disabled={!domain.trim() || !hasTargets || (https && (!email.trim() || checking))} onClick={() => submit(false)}>Add domain</button>)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
