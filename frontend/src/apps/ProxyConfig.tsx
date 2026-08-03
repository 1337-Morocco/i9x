import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FiX, FiServer, FiGitMerge, FiLock, FiTag, FiShield, FiZap, FiFilter, FiFileText,
  FiTerminal, FiCode, FiPlus, FiTrash2, FiCheck, FiAlertTriangle, FiRotateCcw, FiCopy,
  FiChevronDown, FiChevronRight, FiEye, FiEyeOff,
} from 'react-icons/fi'
import {
  proxyapi, emptyLocation,
  type ProxySite, type NginxSettings, type Backend, type LbSettings, type RateSettings,
  type LocationRule, type LocationMode, type LocationMatch, type HeaderPair, type ProxyError,
} from '../api/proxy'

// The full nginx reverse-proxy configuration for one domain.
//
// Every field here maps to one nginx directive (named in the hint under it), and
// the Preview section shows the exact vhost that will be written. Saving runs
// `nginx -t` on the server first: a rejected config is rolled back and the error
// is shown here, so nothing you type can take the other domains down.

type SectionId =
  | 'backends' | 'routing' | 'tls' | 'headers' | 'security' | 'performance'
  | 'limits' | 'logging' | 'advanced' | 'preview'

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode; blurb: string }[] = [
  { id: 'backends', label: 'Backends', icon: <FiServer size={14} />, blurb: 'Where traffic goes, and how it is balanced.' },
  { id: 'routing', label: 'Routing', icon: <FiGitMerge size={14} />, blurb: 'Send paths to different places — extra apps, static files, redirects.' },
  { id: 'tls', label: 'HTTPS & TLS', icon: <FiLock size={14} />, blurb: 'Certificate, redirect, protocol versions and HSTS.' },
  { id: 'headers', label: 'Headers', icon: <FiTag size={14} />, blurb: 'What the backend and the browser are told about each request.' },
  { id: 'security', label: 'Security', icon: <FiShield size={14} />, blurb: 'Password protection, IP rules and browser hardening.' },
  { id: 'performance', label: 'Performance', icon: <FiZap size={14} />, blurb: 'Compression, static caching and a full response cache.' },
  { id: 'limits', label: 'Limits', icon: <FiFilter size={14} />, blurb: 'Request size, timeouts, buffering and per-IP rate limits.' },
  { id: 'logging', label: 'Logging', icon: <FiFileText size={14} />, blurb: 'Access and error logs for this domain.' },
  { id: 'advanced', label: 'Advanced', icon: <FiTerminal size={14} />, blurb: 'Raw nginx directives, checked before they are applied.' },
  { id: 'preview', label: 'Config preview', icon: <FiCode size={14} />, blurb: 'The exact vhost i9x will write.' },
]

const num = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(Number(v) || lo)))
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

// ---------------------------------------------------------------------------
// Small field primitives — every setting names the directive it writes.
// ---------------------------------------------------------------------------

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`px-field ${wide ? 'wide' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <span className="px-hint">{hint}</span>}
    </div>
  )
}

function Toggle({ checked, onChange, label, hint, danger }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; danger?: boolean
}) {
  return (
    <label className={`px-toggle ${danger ? 'danger' : ''}`}>
      <button type="button" className={`px-switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)} aria-pressed={checked}><span /></button>
      <span className="px-toggle-body">
        <b>{label}</b>
        {hint && <span className="px-hint">{hint}</span>}
      </span>
    </label>
  )
}

function Group({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="px-group">
      <h4>{title}</h4>
      {hint && <p className="px-group-hint">{hint}</p>}
      {children}
    </section>
  )
}

// A repeated list of free-text values (IPs, header names…).
function StringList({ values, onChange, placeholder, addLabel }: {
  values: string[]; onChange: (v: string[]) => void; placeholder: string; addLabel: string
}) {
  return (
    <div className="px-list">
      {values.map((v, i) => (
        <div className="px-list-row" key={i}>
          <input className="mono" value={v} placeholder={placeholder}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="px-del" title="Remove" onClick={() => onChange(values.filter((_, j) => j !== i))}><FiTrash2 size={13} /></button>
        </div>
      ))}
      <button className="px-add" onClick={() => onChange([...values, ''])}><FiPlus size={13} /> {addLabel}</button>
    </div>
  )
}

function HeaderList({ values, onChange, addLabel, always }: {
  values: HeaderPair[]; onChange: (v: HeaderPair[]) => void; addLabel: string; always?: boolean
}) {
  const patch = (i: number, p: Partial<HeaderPair>) => onChange(values.map((h, j) => (j === i ? { ...h, ...p } : h)))
  return (
    <div className="px-list">
      {values.map((h, i) => (
        <div className="px-list-row" key={i}>
          <input className="mono px-hname" value={h.name} placeholder="X-Header" onChange={(e) => patch(i, { name: e.target.value })} />
          <input className="mono" value={h.value} placeholder="value" onChange={(e) => patch(i, { value: e.target.value })} />
          {always && (
            <label className="px-inline-check" title="Send it on error responses too (add_header … always)">
              <input type="checkbox" checked={h.always !== false} onChange={(e) => patch(i, { always: e.target.checked })} /> always
            </label>
          )}
          <button className="px-del" title="Remove" onClick={() => onChange(values.filter((_, j) => j !== i))}><FiTrash2 size={13} /></button>
        </div>
      ))}
      <button className="px-add" onClick={() => onChange([...values, { name: '', value: '', ...(always ? { always: true } : {}) }])}>
        <FiPlus size={13} /> {addLabel}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function ProxyConfig({ site, onClose, onSaved }: {
  site: ProxySite; onClose: () => void; onSaved: () => void
}) {
  const [sec, setSec] = useState<SectionId>('backends')
  const [settings, setSettings] = useState<NginxSettings | null>(null)
  const [targets, setTargets] = useState<Backend[]>(site.targets.map((t) => ({ ...t })))
  const [lb, setLb] = useState<LbSettings>({ ...site.lb })
  const [rate, setRate] = useState<RateSettings>({ ...site.rate })
  const [hasCert, setHasCert] = useState(site.https)
  const [generated, setGenerated] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const original = useRef<string>('')

  useEffect(() => {
    proxyapi.config(site.domain)
      .then((r) => {
        setSettings(r.settings); setTargets(r.targets); setLb(r.lb); setRate(r.rate)
        setHasCert(r.hasCert); setGenerated(r.generated)
        original.current = JSON.stringify({ s: r.settings, t: r.targets, l: r.lb, r: r.rate })
        if (r.error) setErr(r.error)
      })
      .catch((e) => setErr((e as Error).message))
  }, [site.domain])

  // Live preview: re-render on the server whenever the form settles.
  useEffect(() => {
    if (!settings) return
    const now = JSON.stringify({ s: settings, t: targets, l: lb, r: rate })
    setDirty(now !== original.current)
    const id = setTimeout(() => {
      proxyapi.preview({ domain: site.domain, targets, lb, rate, settings })
        .then((r) => { setGenerated(r.generated); setErr('') })
        .catch((e) => setErr((e as Error).message))
    }, 400)
    return () => clearTimeout(id)
  }, [settings, targets, lb, rate, site.domain])

  const patch = useCallback((fn: (s: NginxSettings) => void) => {
    setSettings((prev) => { if (!prev) return prev; const next = clone(prev); fn(next); return next })
    setOk('')
  }, [])

  const save = async () => {
    if (!settings) return
    setSaving(true); setErr(''); setOk('')
    try {
      const r = await proxyapi.saveConfig({ domain: site.domain, targets, lb, rate, settings })
      setSettings(r.settings); setGenerated(r.generated)
      original.current = JSON.stringify({ s: r.settings, t: targets, l: lb, r: rate })
      setDirty(false)
      setOk('Applied — nginx accepted the config and reloaded.')
      onSaved()
    } catch (e) {
      const pe = e as ProxyError
      setErr(pe.message)
    } finally { setSaving(false) }
  }

  const reset = async () => {
    if (!confirm('Reset every nginx setting for this domain back to the defaults? Backends and rate limits are kept.')) return
    setSaving(true); setErr('')
    try {
      const r = await proxyapi.resetConfig(site.domain)
      setSettings(r.settings); setOk('Reset to defaults.'); onSaved()
      original.current = JSON.stringify({ s: r.settings, t: targets, l: lb, r: rate })
      setDirty(false)
    } catch (e) { setErr((e as Error).message) } finally { setSaving(false) }
  }

  const meta = SECTIONS.find((s) => s.id === sec)!

  return (
    <div className="px-overlay" onMouseDown={() => !saving && onClose()}>
      <div className="px-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="px-head">
          <div className="px-head-id">
            <FiServer size={15} />
            <b>{site.domain}</b>
            <span className={`px-scheme ${hasCert ? 'https' : 'http'}`}>{hasCert ? 'https' : 'http'}</span>
          </div>
          <span className="px-head-sub">nginx reverse proxy configuration</span>
          <button className="px-x" onClick={onClose}><FiX size={18} /></button>
        </header>

        <div className="px-body">
          <nav className="px-nav">
            {SECTIONS.map((s) => (
              <button key={s.id} className={sec === s.id ? 'on' : ''} onClick={() => setSec(s.id)}>
                {s.icon} <span>{s.label}</span>
              </button>
            ))}
          </nav>

          <main className="px-main">
            <div className="px-main-h">
              <h3>{meta.label}</h3>
              <p>{meta.blurb}</p>
            </div>

            {!settings ? (
              <div className="px-loading"><div className="splash-spinner" /> Reading the current configuration…</div>
            ) : (
              <div className="px-pane">
                {sec === 'backends' && <BackendsSection targets={targets} setTargets={setTargets} lb={lb} setLb={setLb} />}
                {sec === 'routing' && <RoutingSection s={settings} patch={patch} />}
                {sec === 'tls' && <TlsSection s={settings} patch={patch} hasCert={hasCert} />}
                {sec === 'headers' && <HeadersSection s={settings} patch={patch} />}
                {sec === 'security' && <SecuritySection s={settings} patch={patch} />}
                {sec === 'performance' && <PerformanceSection s={settings} patch={patch} />}
                {sec === 'limits' && <LimitsSection s={settings} patch={patch} rate={rate} setRate={setRate} />}
                {sec === 'logging' && <LoggingSection s={settings} patch={patch} domain={site.domain} />}
                {sec === 'advanced' && <AdvancedSection s={settings} patch={patch} />}
                {sec === 'preview' && <PreviewSection text={generated} />}
              </div>
            )}
          </main>
        </div>

        <footer className="px-foot">
          {err && <div className="px-err"><FiAlertTriangle size={14} /> {err}</div>}
          {!err && ok && <div className="px-ok"><FiCheck size={14} /> {ok}</div>}
          {!err && !ok && dirty && <div className="px-note">Unsaved changes — nginx still runs the previous config.</div>}
          {!err && !ok && !dirty && <div className="px-note">Every change is validated with <code>nginx -t</code> before it is kept.</div>}
          <button className="px-ghost" onClick={reset} disabled={saving} title="Back to i9x defaults"><FiRotateCcw size={13} /> Reset</button>
          <button className="px-ghost" onClick={onClose} disabled={saving}>Close</button>
          <button className="px-apply" onClick={save} disabled={saving || !settings || !!(settings && !dirty)}>
            {saving ? <><div className="splash-spinner small" /> Applying…</> : <>Apply &amp; reload nginx</>}
          </button>
        </footer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const LB_LABEL: Record<string, string> = {
  round_robin: 'Round robin', least_conn: 'Least connections', ip_hash: 'IP hash (sticky)',
}

function BackendsSection({ targets, setTargets, lb, setLb }: {
  targets: Backend[]; setTargets: (t: Backend[]) => void; lb: LbSettings; setLb: (l: LbSettings) => void
}) {
  const patch = (i: number, p: Partial<Backend>) => setTargets(targets.map((t, j) => (j === i ? { ...t, ...p } : t)))
  return (
    <>
      <Group title="Backend pool" hint="A port (8100) or host:port. More than one backend turns this into a load balancer.">
        <div className="px-list">
          {targets.map((t, i) => (
            <div className="px-list-row" key={i}>
              <input className="mono" value={t.host} placeholder="8100 or 10.0.0.5:8100" onChange={(e) => patch(i, { host: e.target.value })} />
              <label className="px-mini" title="Share of traffic relative to the others">w
                <input type="number" min={1} max={100} value={t.weight} onChange={(e) => patch(i, { weight: num(e.target.value, 1, 100) })} />
              </label>
              <label className="px-inline-check" title={lb.method === 'ip_hash' ? 'Not available with IP hash' : 'Only used when every primary is down'}>
                <input type="checkbox" disabled={lb.method === 'ip_hash'} checked={t.backup} onChange={(e) => patch(i, { backup: e.target.checked })} /> backup
              </label>
              <button className="px-del" disabled={targets.length === 1} onClick={() => setTargets(targets.filter((_, j) => j !== i))}><FiTrash2 size={13} /></button>
            </div>
          ))}
          <button className="px-add" onClick={() => setTargets([...targets, { host: '', weight: 1, backup: false }])}><FiPlus size={13} /> Add backend</button>
        </div>
      </Group>

      <Group title="Balancing">
        <Field label="Method" hint="upstream { least_conn | ip_hash }">
          <select value={lb.method} onChange={(e) => {
            const method = e.target.value as LbSettings['method']
            setLb({ ...lb, method })
            if (method === 'ip_hash') setTargets(targets.map((t) => ({ ...t, backup: false })))
          }}>
            {Object.keys(LB_LABEL).map((m) => <option key={m} value={m}>{LB_LABEL[m]}</option>)}
          </select>
        </Field>
        <div className="px-row">
          <Field label="Failures before eviction" hint="server … max_fails">
            <input type="number" min={0} max={100} value={lb.maxFails} onChange={(e) => setLb({ ...lb, maxFails: num(e.target.value, 0, 100) })} />
          </Field>
          <Field label="Stays out for (seconds)" hint="server … fail_timeout">
            <input type="number" min={1} max={3600} value={lb.failTimeout} onChange={(e) => setLb({ ...lb, failTimeout: num(e.target.value, 1, 3600) })} />
          </Field>
        </div>
        {lb.maxFails === 0 && <p className="px-warn">0 disables health checks — a dead backend keeps receiving traffic.</p>}
      </Group>
    </>
  )
}

const MODE_LABEL: Record<LocationMode, string> = {
  proxy: 'Proxy to a backend', static: 'Serve files from disk', redirect: 'Redirect', text: 'Fixed response',
}

function RoutingSection({ s, patch }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void }) {
  const [open, setOpen] = useState<number | null>(0)
  const set = (i: number, p: Partial<LocationRule>) => patch((d) => { d.locations[i] = { ...d.locations[i], ...p } })

  return (
    <>
      <Group title="Path rules" hint="Checked before the catch-all. Everything not matched here goes to the backend pool.">
        {s.locations.length === 0 && <p className="px-empty">No extra rules — every request goes to the backend pool.</p>}
        {s.locations.map((l, i) => (
          <div className={`px-rule ${open === i ? 'open' : ''}`} key={i}>
            <div className="px-rule-h" onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
              <code>{l.match === 'regex' ? '~*' : l.match === 'exact' ? '=' : ''} {l.path}</code>
              <span className="px-rule-mode">{MODE_LABEL[l.mode]}</span>
              <span className="px-rule-to">
                {l.mode === 'proxy' ? (l.target || 'backend pool') : l.mode === 'static' ? l.root : l.mode === 'redirect' ? l.redirectTo : `${l.status}`}
              </span>
              <button className="px-del" onClick={(e) => { e.stopPropagation(); patch((d) => { d.locations.splice(i, 1) }); setOpen(null) }}>
                <FiTrash2 size={13} />
              </button>
            </div>
            {open === i && (
              <div className="px-rule-b">
                <div className="px-row">
                  <Field label="Path" hint="location /api">
                    <input className="mono" value={l.path} onChange={(e) => set(i, { path: e.target.value })} />
                  </Field>
                  <Field label="Match" hint="prefix, exact (=) or regex (~*)">
                    <select value={l.match} onChange={(e) => set(i, { match: e.target.value as LocationMatch })}>
                      <option value="prefix">Starts with</option>
                      <option value="exact">Exactly</option>
                      <option value="regex">Regex</option>
                    </select>
                  </Field>
                  <Field label="Does" hint="what nginx serves for this path">
                    <select value={l.mode} onChange={(e) => set(i, { mode: e.target.value as LocationMode })}>
                      {(Object.keys(MODE_LABEL) as LocationMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                    </select>
                  </Field>
                </div>

                {l.mode === 'proxy' && (
                  <Field label="Backend" hint="proxy_pass — blank uses the domain's pool. Otherwise a port or host:port." wide>
                    <input className="mono" value={l.target} placeholder="blank = backend pool, or 9000" onChange={(e) => set(i, { target: e.target.value })} />
                  </Field>
                )}
                {l.mode === 'static' && (
                  <div className="px-row">
                    <Field label="Directory" hint="root — absolute path on this machine">
                      <input className="mono" value={l.root} placeholder="/var/www/site" onChange={(e) => set(i, { root: e.target.value })} />
                    </Field>
                    <Field label="Index file" hint="index">
                      <input className="mono" value={l.index} onChange={(e) => set(i, { index: e.target.value })} />
                    </Field>
                  </div>
                )}
                {l.mode === 'static' && (
                  <Toggle checked={l.tryFiles} onChange={(v) => set(i, { tryFiles: v })}
                    label="Single-page app fallback" hint="try_files $uri $uri/ /index.html — unknown paths render the index instead of 404" />
                )}
                {l.mode === 'redirect' && (
                  <div className="px-row">
                    <Field label="Redirect to" hint="return — a URL or an absolute path">
                      <input className="mono" value={l.redirectTo} placeholder="https://example.com/new" onChange={(e) => set(i, { redirectTo: e.target.value })} />
                    </Field>
                    <Field label="Status" hint="301 permanent · 302 temporary">
                      <select value={l.redirectCode} onChange={(e) => set(i, { redirectCode: Number(e.target.value) })}>
                        {[301, 302, 307, 308].map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
                {l.mode === 'text' && (
                  <div className="px-row">
                    <Field label="Response body" hint="return — a fixed body, handy for /health">
                      <input value={l.text} placeholder="ok" onChange={(e) => set(i, { text: e.target.value })} />
                    </Field>
                    <Field label="Status code" hint="100–599">
                      <input type="number" min={100} max={599} value={l.status} onChange={(e) => set(i, { status: num(e.target.value, 100, 599) })} />
                    </Field>
                  </div>
                )}

                <div className="px-rule-flags">
                  {l.mode === 'proxy' && <Toggle checked={l.websocket} onChange={(v) => set(i, { websocket: v })} label="WebSockets" hint="Upgrade / Connection headers" />}
                  <Toggle checked={l.rateLimit} onChange={(v) => set(i, { rateLimit: v })} label="Apply rate limit" hint="uses the domain's limit, when enabled" />
                  <Toggle checked={l.basicAuth} onChange={(v) => set(i, { basicAuth: v })} label="Apply password & IP rules" hint="turn off to leave this path public" />
                  {l.mode === 'proxy' && <Toggle checked={l.cache} onChange={(v) => set(i, { cache: v })} label="Cacheable" hint="uses the response cache, when enabled" />}
                </div>

                <Field label="Extra directives for this rule" hint="Raw nginx, inside this location block" wide>
                  <textarea className="mono" rows={3} value={l.custom} spellCheck={false}
                    placeholder="proxy_set_header X-Thing 1;" onChange={(e) => set(i, { custom: e.target.value })} />
                </Field>
              </div>
            )}
          </div>
        ))}
        <button className="px-add" onClick={() => { patch((d) => { d.locations.push({ ...emptyLocation(), path: '/new' }) }); setOpen(s.locations.length) }}>
          <FiPlus size={13} /> Add path rule
        </button>
      </Group>
    </>
  )
}

function TlsSection({ s, patch, hasCert }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void; hasCert: boolean }) {
  return (
    <>
      {!hasCert && (
        <p className="px-warn">
          No certificate for this domain yet — these settings are written but only take effect once HTTPS is enabled
          from the domain card.
        </p>
      )}
      <Group title="Redirect">
        <Toggle checked={s.tls.forceHttps} onChange={(v) => patch((d) => { d.tls.forceHttps = v })}
          label="Force HTTPS" hint="return 301 https://… on port 80. ACME renewal requests are always let through." />
        <Toggle checked={s.tls.http2} onChange={(v) => patch((d) => { d.tls.http2 = v })}
          label="HTTP/2" hint="http2 on — one connection carries many parallel requests" />
      </Group>

      <Group title="Protocols" hint="ssl_protocols — TLS 1.2 and 1.3 is the modern default; older versions are unsafe.">
        <div className="px-chips">
          {['TLSv1.3', 'TLSv1.2', 'TLSv1.1', 'TLSv1'].map((p) => {
            const on = s.tls.protocols.includes(p)
            const old = p === 'TLSv1' || p === 'TLSv1.1'
            return (
              <button key={p} className={`px-chip ${on ? 'on' : ''} ${old && on ? 'risky' : ''}`}
                onClick={() => patch((d) => {
                  d.tls.protocols = on ? d.tls.protocols.filter((x) => x !== p) : [...d.tls.protocols, p]
                })}>
                {on ? <FiCheck size={12} /> : null} {p}
              </button>
            )
          })}
        </div>
        {s.tls.protocols.some((p) => p === 'TLSv1' || p === 'TLSv1.1') && (
          <p className="px-warn">TLS 1.0/1.1 are deprecated and will fail modern security scans.</p>
        )}
      </Group>

      <Group title="HSTS" hint="Strict-Transport-Security — tells browsers to only ever use HTTPS for this domain.">
        <Toggle checked={s.tls.hsts.enabled} onChange={(v) => patch((d) => { d.tls.hsts.enabled = v })}
          label="Send HSTS" hint="Only enable once HTTPS works — browsers remember it for the whole max-age." />
        {s.tls.hsts.enabled && (
          <>
            <div className="px-row">
              <Field label="Max age (seconds)" hint="15768000 = 6 months, 31536000 = 1 year">
                <input type="number" min={300} max={63072000} value={s.tls.hsts.maxAge}
                  onChange={(e) => patch((d) => { d.tls.hsts.maxAge = num(e.target.value, 300, 63072000) })} />
              </Field>
            </div>
            <Toggle checked={s.tls.hsts.subdomains} onChange={(v) => patch((d) => { d.tls.hsts.subdomains = v })}
              label="Include subdomains" hint="Every subdomain must then serve valid HTTPS too" />
            <Toggle checked={s.tls.hsts.preload} onChange={(v) => patch((d) => { d.tls.hsts.preload = v })}
              label="Preload" danger hint="Only if you intend to submit the domain to the browser preload list — hard to undo" />
          </>
        )}
      </Group>
    </>
  )
}

function HeadersSection({ s, patch }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void }) {
  return (
    <>
      <Group title="What the backend sees">
        <Field label="Host header" hint="proxy_set_header Host — $host keeps the visitor's domain; $proxy_host sends the backend's own name">
          <select value={['$host', '$http_host', '$proxy_host'].includes(s.headers.hostHeader) ? s.headers.hostHeader : 'custom'}
            onChange={(e) => patch((d) => { d.headers.hostHeader = e.target.value === 'custom' ? '' : e.target.value })}>
            <option value="$host">$host (recommended)</option>
            <option value="$http_host">$http_host (verbatim, with port)</option>
            <option value="$proxy_host">$proxy_host</option>
            <option value="custom">A fixed hostname…</option>
          </select>
        </Field>
        {!['$host', '$http_host', '$proxy_host'].includes(s.headers.hostHeader) && (
          <Field label="Hostname" wide>
            <input className="mono" value={s.headers.hostHeader} placeholder="internal.example.com"
              onChange={(e) => patch((d) => { d.headers.hostHeader = e.target.value })} />
          </Field>
        )}
        <Toggle checked={s.headers.forwarded} onChange={(v) => patch((d) => { d.headers.forwarded = v })}
          label="Send X-Forwarded-* headers" hint="X-Real-IP, X-Forwarded-For / -Proto / -Host / -Port — most frameworks need these to build correct URLs" />
        <Toggle checked={s.websocket} onChange={(v) => patch((d) => { d.websocket = v })}
          label="WebSocket support" hint="Upgrade / Connection headers, plus the map that only sets them when asked for" />

        <Field label="Extra headers to the backend" hint="proxy_set_header" wide>
          <HeaderList values={s.headers.proxySet} addLabel="Add backend header"
            onChange={(v) => patch((d) => { d.headers.proxySet = v })} />
        </Field>
      </Group>

      <Group title="What the browser sees">
        <Field label="Headers to add to responses" hint="add_header" wide>
          <HeaderList values={s.headers.add} addLabel="Add response header" always
            onChange={(v) => patch((d) => { d.headers.add = v })} />
        </Field>
        <Field label="Headers to strip from the backend" hint="proxy_hide_header — e.g. Server, X-Powered-By" wide>
          <StringList values={s.headers.hide} placeholder="X-Powered-By" addLabel="Hide a header"
            onChange={(v) => patch((d) => { d.headers.hide = v })} />
        </Field>
      </Group>

      <Group title="Trusted proxies" hint="set_real_ip_from — when a CDN sits in front, take the visitor IP from X-Forwarded-For instead of logging the CDN.">
        <StringList values={s.headers.realIpFrom} placeholder="173.245.48.0/20" addLabel="Add trusted range"
          onChange={(v) => patch((d) => { d.headers.realIpFrom = v })} />
      </Group>
    </>
  )
}

function SecuritySection({ s, patch }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void }) {
  const [show, setShow] = useState(false)
  const auth = s.security.basicAuth
  const setUser = (i: number, p: Partial<{ user: string; password: string }>) =>
    patch((d) => { d.security.basicAuth.users[i] = { ...d.security.basicAuth.users[i], ...p } })

  return (
    <>
      <Group title="Password protection" hint="auth_basic — the browser asks for a username and password before anything is served.">
        <Toggle checked={auth.enabled} onChange={(v) => patch((d) => { d.security.basicAuth.enabled = v })}
          label="Require a password" hint="Useful for staging sites. Applies to every rule that has “password & IP rules” on." />
        {auth.enabled && (
          <>
            <Field label="Realm" hint="Shown in the browser's password prompt">
              <input value={auth.realm} onChange={(e) => patch((d) => { d.security.basicAuth.realm = e.target.value })} />
            </Field>
            <div className="px-list">
              {auth.users.map((u, i) => (
                <div className="px-list-row" key={i}>
                  <input className="mono px-hname" value={u.user} placeholder="username" onChange={(e) => setUser(i, { user: e.target.value })} />
                  <input className="mono" type={show ? 'text' : 'password'}
                    value={u.password ?? ''} placeholder={u.hasPassword ? '•••••••• (unchanged)' : 'password'}
                    onChange={(e) => setUser(i, { password: e.target.value })} />
                  <button className="px-del" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}>
                    {show ? <FiEyeOff size={13} /> : <FiEye size={13} />}
                  </button>
                  <button className="px-del" title="Remove" onClick={() => patch((d) => { d.security.basicAuth.users.splice(i, 1) })}><FiTrash2 size={13} /></button>
                </div>
              ))}
              <button className="px-add" onClick={() => patch((d) => { d.security.basicAuth.users.push({ user: '', password: '' }) })}>
                <FiPlus size={13} /> Add user
              </button>
            </div>
            <p className="px-hint">Passwords are hashed on the server and never sent back to this page.</p>
          </>
        )}
      </Group>

      <Group title="IP rules" hint="allow / deny — blocks are applied first; an allow-list denies everyone else.">
        <Field label="Blocked addresses" hint="deny" wide>
          <StringList values={s.security.deny} placeholder="203.0.113.4" addLabel="Block an address"
            onChange={(v) => patch((d) => { d.security.deny = v })} />
        </Field>
        <Field label="Allow-list" hint="allow … + deny all — leave empty to let everyone in" wide>
          <StringList values={s.security.allow} placeholder="10.0.0.0/8" addLabel="Allow an address"
            onChange={(v) => patch((d) => { d.security.allow = v })} />
        </Field>
        {s.security.allow.length > 0 && (
          <p className="px-warn">With an allow-list set, every other address gets 403 — make sure your own IP is on it.</p>
        )}
      </Group>

      <Group title="Hardening">
        <Toggle checked={s.security.blockDotfiles} onChange={(v) => patch((d) => { d.security.blockDotfiles = v })}
          label="Block dotfiles" hint="location ~ /\\. — stops /.git, /.env and friends being served" />
        <div className="px-row">
          <Field label="X-Frame-Options" hint="Who may embed this site in an iframe">
            <select value={s.security.headers.frameOptions} onChange={(e) => patch((d) => { d.security.headers.frameOptions = e.target.value })}>
              <option value="SAMEORIGIN">SAMEORIGIN</option>
              <option value="DENY">DENY</option>
              <option value="">Don’t send</option>
            </select>
          </Field>
          <Field label="Referrer-Policy" hint="How much of the URL is sent when a visitor clicks away">
            <select value={s.security.headers.referrerPolicy} onChange={(e) => patch((d) => { d.security.headers.referrerPolicy = e.target.value })}>
              {['strict-origin-when-cross-origin', 'no-referrer', 'same-origin', 'origin', ''].map((v) => (
                <option key={v} value={v}>{v || 'Don’t send'}</option>
              ))}
            </select>
          </Field>
        </div>
        <Toggle checked={s.security.headers.contentTypeOptions} onChange={(v) => patch((d) => { d.security.headers.contentTypeOptions = v })}
          label="X-Content-Type-Options: nosniff" hint="Stops the browser guessing a file's type" />
        <Field label="Content-Security-Policy" hint="Left empty by default — a wrong CSP breaks the site" wide>
          <input className="mono" value={s.security.headers.csp} placeholder="default-src 'self'"
            onChange={(e) => patch((d) => { d.security.headers.csp = e.target.value })} />
        </Field>
        <Field label="Permissions-Policy" hint="Which browser features the page may use" wide>
          <input className="mono" value={s.security.headers.permissionsPolicy} placeholder="camera=(), geolocation=()"
            onChange={(e) => patch((d) => { d.security.headers.permissionsPolicy = e.target.value })} />
        </Field>
      </Group>
    </>
  )
}

function PerformanceSection({ s, patch }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void }) {
  return (
    <>
      <Group title="Compression" hint="gzip — text responses are compressed before they go out.">
        <Toggle checked={s.perf.gzip.enabled} onChange={(v) => patch((d) => { d.perf.gzip.enabled = v })} label="Compress responses" />
        {s.perf.gzip.enabled && (
          <div className="px-row">
            <Field label="Level" hint="gzip_comp_level — 1 fastest, 9 smallest">
              <input type="number" min={1} max={9} value={s.perf.gzip.level}
                onChange={(e) => patch((d) => { d.perf.gzip.level = num(e.target.value, 1, 9) })} />
            </Field>
            <Field label="Minimum size (bytes)" hint="gzip_min_length — tiny responses aren't worth compressing">
              <input type="number" min={0} max={1000000} value={s.perf.gzip.minLength}
                onChange={(e) => patch((d) => { d.perf.gzip.minLength = num(e.target.value, 0, 1000000) })} />
            </Field>
          </div>
        )}
      </Group>

      <Group title="Static asset caching" hint="expires — tells browsers to keep images, CSS and JS instead of re-fetching them.">
        <Toggle checked={s.perf.staticCache.enabled} onChange={(v) => patch((d) => { d.perf.staticCache.enabled = v })}
          label="Cache static files in the browser" hint="Matches .css .js .png .jpg .svg .woff2 and friends" />
        {s.perf.staticCache.enabled && (
          <Field label="Lifetime" hint="30d, 365d, 1h…">
            <input className="mono" value={s.perf.staticCache.maxAge}
              onChange={(e) => patch((d) => { d.perf.staticCache.maxAge = e.target.value })} />
          </Field>
        )}
      </Group>

      <Group title="Response cache" hint="proxy_cache — nginx keeps backend responses on disk and serves them itself.">
        <Toggle checked={s.perf.cache.enabled} onChange={(v) => patch((d) => { d.perf.cache.enabled = v })}
          label="Cache backend responses" hint="Adds X-Cache-Status so you can see hits and misses" />
        {s.perf.cache.enabled && (
          <>
            <div className="px-row">
              <Field label="Cache 200s for" hint="proxy_cache_valid"><input className="mono" value={s.perf.cache.valid} onChange={(e) => patch((d) => { d.perf.cache.valid = e.target.value })} /></Field>
              <Field label="Cache 404s for" hint="proxy_cache_valid 404"><input className="mono" value={s.perf.cache.valid404} onChange={(e) => patch((d) => { d.perf.cache.valid404 = e.target.value })} /></Field>
              <Field label="Max disk" hint="max_size"><input className="mono" value={s.perf.cache.size} onChange={(e) => patch((d) => { d.perf.cache.size = e.target.value })} /></Field>
            </div>
            <Toggle checked={s.perf.cache.bypassCookie} onChange={(v) => patch((d) => { d.perf.cache.bypassCookie = v })}
              label="Never cache logged-in visitors" hint="Bypasses the cache when a session cookie or Authorization header is present — leave this on" />
            {!s.perf.cache.bypassCookie && <p className="px-warn">With this off, one visitor's personalised page can be served to everyone else.</p>}
          </>
        )}
      </Group>
    </>
  )
}

function LimitsSection({ s, patch, rate, setRate }: {
  s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void; rate: RateSettings; setRate: (r: RateSettings) => void
}) {
  return (
    <>
      <Group title="Request size and time">
        <div className="px-row">
          <Field label="Max upload size" hint="client_max_body_size — bigger uploads get 413">
            <input className="mono" value={s.request.maxBodySize} onChange={(e) => patch((d) => { d.request.maxBodySize = e.target.value })} />
          </Field>
          <Field label="Connect timeout" hint="proxy_connect_timeout (s)">
            <input type="number" min={1} max={3600} value={s.request.connectTimeout} onChange={(e) => patch((d) => { d.request.connectTimeout = num(e.target.value, 1, 3600) })} />
          </Field>
          <Field label="Read timeout" hint="proxy_read_timeout (s) — raise for long jobs or SSE">
            <input type="number" min={1} max={3600} value={s.request.readTimeout} onChange={(e) => patch((d) => { d.request.readTimeout = num(e.target.value, 1, 3600) })} />
          </Field>
          <Field label="Send timeout" hint="proxy_send_timeout (s)">
            <input type="number" min={1} max={3600} value={s.request.sendTimeout} onChange={(e) => patch((d) => { d.request.sendTimeout = num(e.target.value, 1, 3600) })} />
          </Field>
        </div>
      </Group>

      <Group title="Buffering">
        <Toggle checked={s.request.buffering} onChange={(v) => patch((d) => { d.request.buffering = v })}
          label="Buffer responses" hint="proxy_buffering — turn OFF for streaming responses and server-sent events" />
        {s.request.buffering && (
          <div className="px-row">
            <Field label="Buffer size" hint="proxy_buffer_size"><input className="mono" value={s.request.bufferSize} onChange={(e) => patch((d) => { d.request.bufferSize = e.target.value })} /></Field>
            <Field label="Buffers" hint="proxy_buffers — count and size"><input className="mono" value={s.request.buffers} onChange={(e) => patch((d) => { d.request.buffers = e.target.value })} /></Field>
          </div>
        )}
        <Toggle checked={s.request.requestBuffering} onChange={(v) => patch((d) => { d.request.requestBuffering = v })}
          label="Buffer uploads" hint="proxy_request_buffering — turn OFF to stream large uploads straight to the backend" />
      </Group>

      <Group title="Rate limiting" hint="limit_req — a leaky bucket per visitor IP. Rejected requests get 429.">
        <Toggle checked={rate.enabled} onChange={(v) => setRate({ ...rate, enabled: v })} label="Limit requests per IP" />
        {rate.enabled && (
          <>
            <div className="px-row">
              <Field label="Requests"><input type="number" min={1} max={100000} value={rate.rate} onChange={(e) => setRate({ ...rate, rate: num(e.target.value, 1, 100000) })} /></Field>
              <Field label="Per">
                <select value={rate.unit} onChange={(e) => setRate({ ...rate, unit: e.target.value as 's' | 'm' })}>
                  <option value="s">second</option><option value="m">minute</option>
                </select>
              </Field>
              <Field label="Burst" hint="Extra requests allowed in a spike"><input type="number" min={0} max={100000} value={rate.burst} onChange={(e) => setRate({ ...rate, burst: num(e.target.value, 0, 100000) })} /></Field>
              <Field label="Connections per IP" hint="limit_conn — 0 = off"><input type="number" min={0} max={65535} value={rate.conns} onChange={(e) => setRate({ ...rate, conns: num(e.target.value, 0, 65535) })} /></Field>
            </div>
            {rate.burst > 0 && (
              <Toggle checked={rate.nodelay} onChange={(v) => setRate({ ...rate, nodelay: v })}
                label="Serve bursts immediately" hint="Off: the burst is queued and released at the limit rate" />
            )}
            <p className="px-summary">
              Each visitor IP gets {rate.rate} request{rate.rate === 1 ? '' : 's'} per {rate.unit === 's' ? 'second' : 'minute'}
              {rate.burst > 0 ? `, plus a burst of ${rate.burst}` : ''}
              {rate.conns > 0 ? `, and at most ${rate.conns} simultaneous connections` : ''}.
            </p>
          </>
        )}
      </Group>
    </>
  )
}

function LoggingSection({ s, patch, domain }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void; domain: string }) {
  return (
    <Group title="Logs" hint="One pair of files per domain, so tailing one site never means reading everything.">
      <Toggle checked={s.logging.access} onChange={(v) => patch((d) => { d.logging.access = v })}
        label="Write an access log" hint={`/var/log/nginx/i9x-${domain}.access.log`} />
      <Field label="Error log level" hint={`/var/log/nginx/i9x-${domain}.error.log`}>
        <select value={s.logging.errorLevel} onChange={(e) => patch((d) => { d.logging.errorLevel = e.target.value })}>
          {['debug', 'info', 'notice', 'warn', 'error', 'crit'].map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
      <p className="px-hint">Tail them from the Terminal: <code>tail -f /var/log/nginx/i9x-{domain}.access.log</code></p>
    </Group>
  )
}

function AdvancedSection({ s, patch }: { s: NginxSettings; patch: (fn: (s: NginxSettings) => void) => void }) {
  return (
    <>
      <p className="px-warn">
        Anything here is written verbatim. It still goes through <code>nginx -t</code> before it is kept, and a rejected
        config is rolled back — but a valid directive that does the wrong thing is yours to debug.
      </p>
      <Group title="Server block" hint="Directives added inside server { … }, before the location blocks.">
        <textarea className="mono px-code" rows={6} spellCheck={false} value={s.custom.server}
          placeholder={'client_body_timeout 30s;\nlarge_client_header_buffers 4 16k;'}
          onChange={(e) => patch((d) => { d.custom.server = e.target.value })} />
      </Group>
      <Group title="Main location" hint="Directives added inside the catch-all location / { … }.">
        <textarea className="mono px-code" rows={6} spellCheck={false} value={s.custom.location}
          placeholder={'proxy_set_header X-Extra "1";'}
          onChange={(e) => patch((d) => { d.custom.location = e.target.value })} />
      </Group>
    </>
  )
}

function PreviewSection({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="px-preview">
      <div className="px-preview-bar">
        <span>Generated vhost — this is exactly what gets written and tested.</span>
        <button className="px-ghost sm" onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { /* ignore */ }
        }}>{copied ? <><FiCheck size={12} /> Copied</> : <><FiCopy size={12} /> Copy</>}</button>
      </div>
      <pre className="px-code-view">{text || 'Rendering…'}</pre>
    </div>
  )
}
