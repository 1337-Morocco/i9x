import { useEffect, useState, useCallback, useRef } from 'react'
import {
  FiPlus, FiRefreshCw, FiExternalLink, FiPlay, FiSquare, FiRotateCw, FiTrash2, FiFileText, FiX,
  FiUploadCloud, FiGlobe, FiLock, FiSliders, FiChevronDown, FiChevronRight, FiGitBranch, FiServer, FiClock,
  FiSettings, FiCheck, FiCopy, FiActivity, FiGithub, FiEye, FiEyeOff, FiHardDrive, FiCpu,
} from 'react-icons/fi'
import { type HostApp, type HostingApi, type HostAction, type Detection, type WebhookConfig, type BuildRecord } from '../api/hosting'
import { mountsapi, type Mount, type MountInput, type MountType } from '../api/mounts'
import { type GitHubApi, type GitHubRepo } from '../api/github'
import { proxyapi, ProxyError } from '../api/proxy'
import { CardSkeletons } from './Skeleton'

// An adapter binds the generic UI to a hosting backend: its API base,
// presentation, extra deploy fields, env semantics and (optionally) framework
// auto-detection for the unified "Deploy" app.
export type AdvancedField = { key: string; label: string; placeholder?: string; hint?: string; onlyFramework?: string }
export type HostAdapter = {
  title: string
  icon: React.ReactNode
  accent: string                 // wp-new colour variant + cache key
  api: HostingApi
  envNote: React.ReactNode       // explains when env vars take effect
  advancedFields: AdvancedField[]
  extraInfo?: (app: HostApp) => { label: string; value: React.ReactNode }[]
  // Unified-mode extras:
  detect?: (repo: string) => Promise<Detection>          // live framework detection
  frameworks?: { id: string; label: string }[]           // override choices
  envNoteFor?: (framework: string) => React.ReactNode     // framework-specific env note
  webhooks?: boolean                                      // enable GitHub auto-deploy on push
  github?: GitHubApi                                      // connect a GitHub account (repo picker, auto-webhooks, private repos)
}

const FRAMEWORK_LABEL: Record<string, string> = { next: 'Next.js', vite: 'Vite', node: 'Node', auto: 'Auto-detect' }
const fwLabel = (id?: string) => (id ? FRAMEWORK_LABEL[id] || id : '')

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 31) || 'app'
const repoLabel = (r: string) => r.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')

function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24; if (d < 30) return `${Math.floor(d)}d ago`
  return `${Math.floor(d / 30)}mo ago`
}

// Per-adapter last-known list so reopening the window repaints instantly.
const caches: Record<string, HostApp[] | null> = {}

export default function AppHosting({ adapter }: { adapter: HostAdapter }) {
  const api = adapter.api
  const [apps, setApps] = useState<HostApp[]>(caches[adapter.accent] ?? [])
  const [loading, setLoading] = useState(caches[adapter.accent] == null)
  const [err, setErr] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [manage, setManage] = useState<string | null>(null)
  const [gh, setGh] = useState<{ connected: boolean; login?: string } | null>(null)
  const [showGh, setShowGh] = useState(false)

  const load = useCallback(async () => {
    try {
      const a = (await api.apps()).apps
      caches[adapter.accent] = a; setApps(a); setErr('')
    } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }, [api, adapter.accent])
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])

  const loadGh = useCallback(async () => {
    if (!adapter.github) return
    try { setGh(await adapter.github.status()) } catch { setGh({ connected: false }) }
  }, [adapter.github])
  useEffect(() => { loadGh() }, [loadGh])

  const running = apps.filter((a) => a.status === 'running').length
  const managed = apps.find((a) => a.name === manage) || null

  return (
    <div className="wp nx">
      <div className="wp-head">
        <div className="wp-title">{adapter.icon} {adapter.title}</div>
        {apps.length > 0 && <span className="nx-count">{running}/{apps.length} running</span>}
        {adapter.github && (
          <button className={`nx-gh-chip ${gh?.connected ? 'on' : ''}`} onClick={() => setShowGh(true)} title="GitHub connection">
            <FiGithub size={13} />
            {gh?.connected ? <>@{gh.login}</> : 'Connect GitHub'}
          </button>
        )}
        <button className="sys-btn" onClick={load} title="Refresh"><FiRefreshCw size={15} /></button>
        <button className={`wp-new ${adapter.accent}`} onClick={() => setShowForm(true)}><FiPlus /> Deploy repo</button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="wp-grid">
        {apps.map((a) => <AppCard key={a.name} app={a} api={api} onManage={() => setManage(a.name)} onChanged={load} />)}
        {loading && apps.length === 0 && <CardSkeletons />}
        {!loading && apps.length === 0 && !err && (
          <div className="wp-empty">
            {adapter.icon}
            <p>No apps deployed yet.</p>
            <button className={`wp-new ${adapter.accent}`} onClick={() => setShowForm(true)}><FiPlus /> Deploy a repo</button>
          </div>
        )}
      </div>

      {showForm && <DeployForm adapter={adapter} githubConnected={!!gh?.connected} onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); load() }} />}
      {managed && <ManageDrawer app={managed} adapter={adapter} onClose={() => setManage(null)} onChanged={load} />}
      {showGh && adapter.github && <GitHubModal api={adapter.github} status={gh} onClose={() => setShowGh(false)} onChanged={loadGh} />}
    </div>
  )
}

// GitHub account connection via a Personal Access Token.
function GitHubModal({ api, status, onClose, onChanged }: {
  api: GitHubApi; status: { connected: boolean; login?: string } | null; onClose: () => void; onChanged: () => void
}) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const connected = !!status?.connected

  const connect = async () => {
    setBusy(true); setErr('')
    try { await api.connect(token.trim()); await onChanged(); onClose() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const disconnect = async () => {
    if (!confirm('Disconnect GitHub? Private repos will stop building and auto-webhooks won’t update.')) return
    setBusy(true); setErr('')
    try { await api.disconnect(); await onChanged(); onClose() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="wp-form-overlay" onMouseDown={onClose}>
      <div className="wp-form" onMouseDown={(e) => e.stopPropagation()}>
        <div className="wp-form-h"><FiGithub /> GitHub connection</div>
        {connected ? (
          <>
            <p className="nx-step-sub">Connected as <b>@{status?.login}</b>. i9x can deploy your private repos, pick from a repo list, and install push webhooks automatically.</p>
            {err && <div className="sys-err">⚠ {err}</div>}
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={onClose}>Close</button>
              <button className="nx-del-btn" disabled={busy} onClick={disconnect}><FiTrash2 size={13} /> Disconnect</button>
            </div>
          </>
        ) : (
          <>
            <p className="nx-step-sub">Paste a <b>fine-grained personal access token</b> with access to your repos.</p>
            <ol className="nx-gh-steps">
              <li>GitHub → <b>Settings → Developer settings → Personal access tokens → Fine-grained tokens</b></li>
              <li>Repository access: the repos you’ll deploy</li>
              <li>Permissions: <code>Contents: Read</code> and <code>Webhooks: Read and write</code></li>
            </ol>
            <label>Access token</label>
            <input type="password" placeholder="github_pat_… or ghp_…" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
            {err && <div className="sys-err">⚠ {err}</div>}
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={onClose}>Cancel</button>
              <button className="wp-new deploy" disabled={busy || !token.trim()} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function AppCard({ app: a, api, onManage, onChanged }: { app: HostApp; api: HostingApi; onManage: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const primary = a.domains[0]
  const href = primary ? `${primary.https ? 'https' : 'http'}://${primary.domain}` : a.url
  const hostLabel = primary ? primary.domain : a.url.replace(/^https?:\/\//, '')

  const act = async (action: 'start' | 'stop') => {
    setBusy(true)
    try { await api.action(a.name, action); await onChanged() } finally { setBusy(false) }
  }

  return (
    <div className="wp-card nx-card">
      <div className="nx-card-top">
        <span className={`nx-dot ${a.status}`} title={a.status} />
        <div className="wp-card-title">{a.name}</div>
        <span className={`wp-status ${a.status}`}>{a.status === 'building' ? 'building…' : a.status}</span>
      </div>

      <a className="nx-card-link" href={href} target="_blank" rel="noreferrer" title={primary?.https ? 'Secured with HTTPS' : undefined}>
        {primary ? (primary.https ? <FiLock size={12} /> : <FiGlobe size={12} />) : <FiServer size={12} />}
        <span className="nx-card-host">{hostLabel}</span>
        <FiExternalLink size={11} className="nx-card-ext" />
      </a>

      <div className="nx-chips">
        {a.framework && a.framework !== 'auto' && <span className={`nx-chip nx-fw nx-fw-${a.framework}`}>{fwLabel(a.framework)}</span>}
        <span className="nx-chip" title="Repository"><FiGithub size={11} /> {repoLabel(a.repo)}</span>
        {a.branch && <span className="nx-chip"><FiGitBranch size={11} /> {a.branch}</span>}
        {a.envCount > 0 && <span className="nx-chip"><FiSliders size={11} /> {a.envCount} env</span>}
        {a.domains.length > 0 && <span className="nx-chip"><FiGlobe size={11} /> {a.domains.length}</span>}
      </div>

      <div className="nx-card-foot">
        {a.status === 'running'
          ? <button className="nx-mini" disabled={busy} onClick={() => act('stop')} title="Stop"><FiSquare size={13} /> Stop</button>
          : <button className="nx-mini" disabled={busy || a.status === 'building'} onClick={() => act('start')} title="Start"><FiPlay size={13} /> Start</button>}
        <button className="nx-manage" onClick={onManage}><FiSettings size={13} /> Manage</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Management drawer — Overview / Environment / Domains / Logs
// ---------------------------------------------------------------------------

type Tab = 'overview' | 'builds' | 'env' | 'storage' | 'resources' | 'domains' | 'logs'

function ManageDrawer({ app, adapter, onClose, onChanged }: { app: HostApp; adapter: HostAdapter; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')

  const act = async (action: HostAction) => {
    if (action === 'remove' && !confirm(`Delete “${app.name}” — container, image and cloned files? This cannot be undone.`)) return
    setBusy(action); setErr('')
    try {
      await adapter.api.action(app.name, action)
      await onChanged()
      if (action === 'remove') onClose()
      else if (action === 'rebuild') setTab('logs')
    } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  const tabs: [Tab, string, React.ReactNode][] = [
    ['overview', 'Overview', <FiActivity size={14} />],
    ['builds', 'Builds', <FiClock size={14} />],
    ['env', 'Environment', <FiSliders size={14} />],
    ['storage', 'Storage', <FiHardDrive size={14} />],
    ['resources', 'Resources', <FiCpu size={14} />],
    ['domains', 'Domains', <FiGlobe size={14} />],
    ['logs', 'Logs', <FiFileText size={14} />],
  ]

  return (
    <div className="nx-drawer-overlay" onMouseDown={onClose}>
      <div className="nx-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="nx-drawer-h">
          <span className={`nx-dot ${app.status}`} />
          <div className="nx-drawer-title">{app.name}</div>
          <span className={`wp-status ${app.status}`}>{app.status === 'building' ? 'building…' : app.status}</span>
          <button className="nx-drawer-x" onClick={onClose}><FiX size={18} /></button>
        </div>

        <div className="nx-tabs">
          {tabs.map(([id, label, icon]) => (
            <button key={id} className={`nx-tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {icon} {label}
              {id === 'domains' && app.domains.length > 0 && <span className="nx-tab-badge">{app.domains.length}</span>}
              {id === 'env' && app.envCount > 0 && <span className="nx-tab-badge">{app.envCount}</span>}
              {id === 'storage' && !!app.mountCount && <span className="nx-tab-badge">{app.mountCount}</span>}
            </button>
          ))}
        </div>

        {err && <div className="sys-err nx-drawer-err">⚠ {err}</div>}

        <div className="nx-drawer-body">
          {tab === 'overview' && <OverviewTab app={app} adapter={adapter} busy={busy} act={act} />}
          {tab === 'builds' && <BuildsTab app={app} api={adapter.api} />}
          {tab === 'env' && <EnvTab app={app} adapter={adapter} onSaved={onChanged} />}
          {tab === 'storage' && <StorageTab app={app} accent={adapter.accent} onChanged={onChanged} />}
          {tab === 'resources' && <ResourcesTab app={app} adapter={adapter} onChanged={onChanged} />}
          {tab === 'domains' && <DomainsTab app={app} adapter={adapter} onChanged={onChanged} />}
          {tab === 'logs' && <LogsTab app={app} api={adapter.api} />}
        </div>
      </div>
    </div>
  )
}

function OverviewTab({ app, adapter, busy, act }: { app: HostApp; adapter: HostAdapter; busy: string; act: (a: HostAction) => void }) {
  const [copied, setCopied] = useState('')
  const copy = (t: string) => { navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(''), 1200) }
  const extra = adapter.extraInfo ? adapter.extraInfo(app) : []

  return (
    <div className="nx-pane">
      {app.status === 'building' && <BuildLog name={app.name} api={adapter.api} />}

      <div className="nx-actions-bar">
        {app.status === 'running'
          ? <>
              <button disabled={!!busy} onClick={() => act('stop')}><FiSquare size={14} /> Stop</button>
              <button disabled={!!busy} onClick={() => act('restart')}><FiRotateCw size={14} /> Restart</button>
            </>
          : <button disabled={!!busy || app.status === 'building'} onClick={() => act('start')}><FiPlay size={14} /> Start</button>}
        <button disabled={!!busy} onClick={() => act('rebuild')} title="Pull latest & rebuild">
          {busy === 'rebuild' ? <div className="splash-spinner small" /> : <FiUploadCloud size={14} />} Rebuild
        </button>
        <a className="nx-abtn" href={app.domains[0] ? `${app.domains[0].https ? 'https' : 'http'}://${app.domains[0].domain}` : app.url} target="_blank" rel="noreferrer"><FiExternalLink size={14} /> Open</a>
      </div>

      <div className="nx-info">
        {app.framework && app.framework !== 'auto' && <InfoRow icon={<FiActivity size={13} />} label="Framework" value={fwLabel(app.framework)} />}
        <InfoRow icon={<FiGithub size={13} />} label="Repository" value={<a href={app.repo.replace(/\.git$/, '')} target="_blank" rel="noreferrer">{repoLabel(app.repo)} <FiExternalLink size={10} /></a>} />
        <InfoRow icon={<FiGitBranch size={13} />} label="Branch" value={app.branch || 'default'} />
        <InfoRow icon={<FiServer size={13} />} label="Local port" value={<button className="nx-copy" onClick={() => copy(String(app.port))}>{app.port} {copied === String(app.port) ? <FiCheck size={11} /> : <FiCopy size={11} />}</button>} />
        {extra.map((e) => <InfoRow key={e.label} icon={<FiFileText size={13} />} label={e.label} value={e.value} />)}
        <InfoRow icon={<FiSliders size={13} />} label="Env vars" value={`${app.envCount}`} />
        <InfoRow icon={<FiClock size={13} />} label="Created" value={ago(app.created)} />
      </div>

      {adapter.webhooks && <AutoDeploySection app={app} api={adapter.api} />}

      <div className="nx-danger">
        <div className="nx-danger-t">Danger zone</div>
        <div className="nx-danger-row">
          <div><b>Delete this app</b><div className="wp-hint">Removes the container, image and cloned repo.</div></div>
          <button className="nx-del-btn" disabled={!!busy} onClick={() => act('remove')}><FiTrash2 size={13} /> Delete</button>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return <div className="nx-info-row"><span className="nx-info-l">{icon} {label}</span><span className="nx-info-v">{value}</span></div>
}

// Auto-deploy on push: toggle a GitHub webhook and show the URL + secret to
// paste into the repo's Settings → Webhooks.
function AutoDeploySection({ app, api }: { app: HostApp; api: HostingApi }) {
  const [cfg, setCfg] = useState<WebhookConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [copied, setCopied] = useState('')
  const copy = (t: string) => { navigator.clipboard?.writeText(t); setCopied(t); setTimeout(() => setCopied(''), 1200) }

  useEffect(() => { api.getWebhook(app.name).then(setCfg).catch((e) => setErr((e as Error).message)) }, [app.name, api])

  const toggle = async () => {
    setBusy(true); setErr('')
    try { setCfg(await api.setWebhook(app.name, !(cfg && cfg.autodeploy))) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const regen = async () => {
    if (!confirm('Generate a new secret? You must update the webhook in GitHub with the new value.')) return
    setBusy(true); setErr('')
    try { setCfg(await api.setWebhook(app.name, true, true)); setShowSecret(true) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const on = !!(cfg && cfg.autodeploy)
  const connected = !!cfg?.githubConnected
  const autoInstalled = connected && on && !cfg?.installError
  const unreachable = !!cfg && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(cfg.url)
  return (
    <div className="nx-hook">
      <div className="nx-hook-head">
        <div>
          <b><FiGithub size={13} /> Auto-deploy on push</b>
          <div className="wp-hint">Rebuild automatically when you push to {app.branch ? <code>{app.branch}</code> : 'the default branch'}.</div>
        </div>
        <button className={`nx-switch ${on ? 'on' : ''}`} disabled={busy || !cfg} onClick={toggle} title={on ? 'Disable' : 'Enable'}><span /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      {on && cfg && (
        <div className="nx-hook-cfg">
          {autoInstalled && <div className="nx-hook-ok"><FiCheck size={13} /> Webhook installed on GitHub automatically — no further setup needed.</div>}
          {connected && cfg.installError && <div className="sys-warn">⚠ Couldn’t install the webhook automatically: {cfg.installError}. Add it manually below.</div>}

          {(!autoInstalled) && (
            <>
              {!connected && <div className="wp-hint nx-hook-tip">💡 Connect GitHub (top-right) to install this webhook automatically.</div>}
              <p className="wp-hint">In GitHub: repo → <b>Settings → Webhooks → Add webhook</b>, then paste:</p>
              <label>Payload URL</label>
              <div className="nx-hook-row"><code>{cfg.url}</code><button className="nx-copy" onClick={() => copy(cfg.url)}>{copied === cfg.url ? <FiCheck size={12} /> : <FiCopy size={12} />}</button></div>
              <label>Secret</label>
              <div className="nx-hook-row">
                <code>{showSecret ? cfg.secret : '•'.repeat(24)}</code>
                <button className="nx-copy" onClick={() => setShowSecret((v) => !v)} title={showSecret ? 'Hide' : 'Reveal'}>{showSecret ? <FiEyeOff size={12} /> : <FiEye size={12} />}</button>
                <button className="nx-copy" onClick={() => copy(cfg.secret)}>{copied === cfg.secret ? <FiCheck size={12} /> : <FiCopy size={12} />}</button>
              </div>
              <div className="nx-hook-meta">Content type <code>application/json</code> · Events: <b>Just the push event</b></div>
            </>
          )}
          {unreachable
            ? <div className="sys-warn">⚠ This URL is localhost — GitHub can’t reach it. Expose this path through your reverse proxy, or set <code>I9X_PUBLIC_URL</code> to a public address.</div>
            : <div className="wp-hint">The webhook URL must be reachable from the internet (through your reverse proxy / open port).</div>}
          <button className="nx-hook-regen" disabled={busy} onClick={regen}><FiRefreshCw size={12} /> Regenerate secret</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live build console — colorized, step-tracked, "alive" like Vercel
// ---------------------------------------------------------------------------

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

function fmtDur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function lineClass(line: string): string {
  const t = line.trimStart()
  if (/^▸\s/.test(t)) return 'nx-l-step'
  if (/^\$\s/.test(t)) return 'nx-l-cmd'
  if (/^✓/.test(t)) return 'nx-l-ok'
  if (/^✗/.test(t) || /\bFAILED\b/.test(t) || /\bERR!\b/.test(t) || /^error\b/i.test(t)) return 'nx-l-err'
  if (/\bwarn(ing)?\b/i.test(t)) return 'nx-l-warn'
  if (/^#\d+\s/.test(t) || /^\s*=>\s/.test(line)) return 'nx-l-dim'   // BuildKit progress lines
  return ''
}

function deriveSteps(text: string, status: string) {
  const started = text.includes('▸ Deploy') ? 2 : text.includes('▸ Build') ? 1 : text.includes('▸ Clone') ? 0 : -1
  const ready = status === 'running'
  const failed = status === 'failed'
  return ['Clone', 'Build', 'Deploy'].map((name, i) => {
    let st: 'done' | 'active' | 'failed' | 'pending'
    if (ready) st = 'done'
    else if (failed) st = i < started ? 'done' : i === started ? 'failed' : 'pending'
    else st = i < started ? 'done' : i === started ? 'active' : 'pending'
    return { name, st }
  })
}

function BuildConsole({ text, status, startedAt, finishedAt }: {
  text: string; status: string; startedAt?: number; finishedAt?: number | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const building = status === 'building'
  const atBottom = useRef(true)

  useEffect(() => { if (!building) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [building])
  useEffect(() => { if (ref.current && atBottom.current) ref.current.scrollTop = ref.current.scrollHeight }, [text])
  const onScroll = () => { const el = ref.current; if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }

  const elapsed = startedAt ? (finishedAt || (building ? now : startedAt)) - startedAt : 0
  const lines = stripAnsi(text || '').replace(/\n$/, '').split('\n')
  const steps = deriveSteps(text, status)

  return (
    <div className={`nx-console ${status}`}>
      <div className="nx-console-h">
        <span className={`nx-console-badge ${status}`}>
          {building ? <><span className="nx-live-dot" /> Building</> : status === 'running' ? <><FiCheck size={12} /> Ready</> : <><FiX size={12} /> Failed</>}
        </span>
        <div className="nx-steps">
          {steps.map((s) => (
            <div key={s.name} className={`nx-step ${s.st}`}>
              <span className="nx-step-ic">
                {s.st === 'done' ? <FiCheck size={11} /> : s.st === 'failed' ? <FiX size={11} /> : s.st === 'active' ? <span className="nx-step-spin" /> : <span className="nx-step-dot" />}
              </span>
              {s.name}
            </div>
          ))}
        </div>
        {startedAt ? <span className="nx-console-time"><FiClock size={11} /> {fmtDur(elapsed)}</span> : null}
      </div>
      <div className="nx-console-body" ref={ref} onScroll={onScroll}>
        {lines.map((ln, i) => (
          <div key={i} className={`nx-line ${lineClass(ln)}`}>
            <span className="nx-ln">{i + 1}</span>
            <span className="nx-lc">{ln || ' '}</span>
          </div>
        ))}
        {building && (
          <div className="nx-line">
            <span className="nx-ln">{lines.length + 1}</span>
            <span className="nx-lc"><span className="nx-caret" /></span>
          </div>
        )}
      </div>
    </div>
  )
}

// Live console for an app currently building (polls the latest build).
function BuildLog({ name, api }: { name: string; api: HostingApi }) {
  const [text, setText] = useState('Starting…')
  const [status, setStatus] = useState('building')
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const d = await api.buildlog(name)
        if (!alive) return
        setText(d.text || '…'); setStatus(d.state || 'building')
        if (d.build) setStartedAt(d.build.started)
      } catch { /* */ }
    }
    tick(); const t = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(t) }
  }, [name, api])
  return <BuildConsole text={text} status={status} startedAt={startedAt} />
}

// Build history: a list of past builds + the selected build's console.
const TRIGGER_LABEL: Record<string, string> = { create: 'initial', manual: 'manual', env: 'env change', push: 'git push' }

function BuildsTab({ app, api }: { app: HostApp; api: HostingApi }) {
  const [builds, setBuilds] = useState<BuildRecord[] | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const b = (await api.builds(app.name)).builds
        if (!alive) return
        setBuilds(b); setErr('')
        setSel((cur) => (cur == null && b.length ? b[0].number : cur))
      } catch (e) { if (alive) setErr((e as Error).message) }
    }
    load(); const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [app.name, api])

  const selected = builds?.find((b) => b.number === sel) || null
  return (
    <div className="nx-pane nx-builds">
      {err && <div className="sys-err">⚠ {err}</div>}
      {builds && builds.length === 0 && <div className="wp-hint">No builds recorded yet.</div>}
      {builds && builds.length > 0 && (
        <>
          <div className="nx-builds-list">
            {builds.map((b) => (
              <button key={b.id} className={`nx-build-item ${sel === b.number ? 'on' : ''}`} onClick={() => setSel(b.number)}>
                <span className={`nx-bi-dot ${b.status}`} />
                <span className="nx-bi-num">#{b.number}</span>
                <span className={`nx-bi-status ${b.status}`}>{b.status === 'running' ? 'ready' : b.status === 'building' ? 'building' : 'failed'}</span>
                <span className="nx-bi-trig">{TRIGGER_LABEL[b.trigger] || b.trigger}</span>
                <span className="nx-bi-ago">{ago(b.started)}</span>
                <span className="nx-bi-dur">{b.finished ? fmtDur(b.finished - b.started) : ''}</span>
              </button>
            ))}
          </div>
          {selected && <BuildView key={selected.number} app={app} api={api} record={selected} />}
        </>
      )}
    </div>
  )
}

function BuildView({ app, api, record }: { app: HostApp; api: HostingApi; record: BuildRecord }) {
  const [text, setText] = useState('Loading…')
  const [status, setStatus] = useState<string>(record.status)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try { const d = await api.buildlog(app.name, record.number); if (!alive) return; setText(d.text || '(no output)'); setStatus(d.state || record.status) }
      catch (e) { if (alive) setText((e as Error).message) }
    }
    load()
    if (record.status === 'building') { const t = setInterval(load, 1500); return () => { alive = false; clearInterval(t) } }
    return () => { alive = false }
  }, [app.name, api, record.number, record.status])
  return <BuildConsole text={text} status={status} startedAt={record.started} finishedAt={record.finished} />
}

function EnvTab({ app, adapter, onSaved }: { app: HostApp; adapter: HostAdapter; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([{ key: '', value: '' }])
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const { env } = await adapter.api.getEnv(app.name)
        const r = Object.entries(env).map(([key, value]) => ({ key, value }))
        setRows(r.length ? r : [{ key: '', value: '' }])
      } catch (e) { setErr((e as Error).message) } finally { setLoaded(true) }
    })()
  }, [app.name, adapter.api])

  const save = async (rebuild: boolean) => {
    setErr(''); setMsg(''); setBusy(true)
    try {
      await adapter.api.setEnv(app.name, rowsToEnv(rows), rebuild)
      setMsg(rebuild ? 'Saved — rebuilding to apply.' : 'Saved. Rebuild to apply build-time variables.')
      onSaved()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const note = adapter.envNoteFor ? adapter.envNoteFor(app.framework || 'auto') : adapter.envNote
  return (
    <div className="nx-pane">
      <p className="nx-pane-sub">{note}</p>
      {!loaded ? <div className="wp-hint">Loading…</div> : <EnvEditor rows={rows} setRows={setRows} />}
      {err && <div className="sys-err">⚠ {err}</div>}
      {msg && <div className="nx-ok sm">{msg}</div>}
      <div className="wp-form-actions">
        <button className="modal-btn ghost" disabled={busy || !loaded} onClick={() => save(false)}>Save</button>
        <button className={`wp-new ${adapter.accent}`} disabled={busy || !loaded} onClick={() => save(true)}>{busy ? 'Saving…' : 'Save & rebuild'}</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Storage — named volumes, host binds and config files edited right here
// ---------------------------------------------------------------------------

const BLANK_MOUNT: MountInput = { type: 'volume', source: '', target: '', content: '', ro: false }

function StorageTab({ app, accent, onChanged }: { app: HostApp; accent: string; onChanged: () => void }) {
  const [mounts, setMounts] = useState<Mount[] | null>(null)
  const [editing, setEditing] = useState<{ id: number | null; draft: MountInput } | null>(null)
  const [err, setErr] = useState('')
  const [pending, setPending] = useState(false)   // changes not yet in the container
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try { setMounts((await mountsapi.list(app.name)).mounts); setErr('') } catch (e) { setErr((e as Error).message) }
  }, [app.name])
  useEffect(() => { load() }, [load])

  const edit = async (m: Mount) => {
    try {
      const full = m.type === 'file' ? await mountsapi.get(m.id) : m
      setEditing({ id: m.id, draft: { type: m.type, source: m.type === 'file' ? '' : m.source, target: m.target, content: full.content || '', ro: m.ro } })
    } catch (e) { setErr((e as Error).message) }
  }

  const save = async () => {
    if (!editing) return
    setBusy(true); setErr('')
    try {
      const r = editing.id == null
        ? await mountsapi.create({ ...editing.draft, app: app.name })
        : await mountsapi.update(editing.id, editing.draft)
      if (r.restartRequired) setPending(true)
      setEditing(null); await load(); onChanged()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const remove = async (m: Mount) => {
    const extra = m.type === 'volume' ? '\n\nThe Docker volume itself is kept — remove it from the Docker app if you want the data gone.' : ''
    if (!confirm(`Remove the mount at ${m.target}?${extra}`)) return
    setBusy(true)
    try { await mountsapi.remove(m.id); setPending(true); await load(); onChanged() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const apply = async () => {
    setBusy(true); setErr(''); setMsg('')
    try { await mountsapi.apply(app.name); setPending(false); setMsg('Container recreated with the current storage.'); onChanged() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="nx-pane">
      <p className="nx-pane-sub">
        Anything written outside these paths is lost when the app is rebuilt. Mount a <b>volume</b> for data the
        app writes, a <b>host path</b> to share a directory with the machine, or a <b>file</b> you edit here and
        i9x mounts into the container.
      </p>

      {err && <div className="sys-err">⚠ {err}</div>}
      {msg && <div className="nx-ok sm">{msg}</div>}
      {pending && (
        <div className="st-pending">
          <span>Storage changed — the running container still has the old mounts.</span>
          <button className={`wp-new ${accent}`} disabled={busy} onClick={apply}>Recreate container</button>
        </div>
      )}

      <div className="st-list">
        {mounts === null && <div className="wp-hint">Loading…</div>}
        {mounts && mounts.length === 0 && <div className="wp-hint">No mounts yet.</div>}
        {mounts && mounts.map((m) => (
          <div className="st-row" key={m.id}>
            <span className={`st-type ${m.type}`}>{m.type}</span>
            <div className="st-paths">
              <code className="st-target">{m.target}</code>
              <span className="st-source" title={m.source}>
                {m.type === 'file' ? `${m.bytes ?? 0} bytes · stored in i9x` : m.source}
              </span>
            </div>
            {m.ro && <span className="st-ro">read-only</span>}
            <button className="pg-icon-btn lg" title="Edit" onClick={() => edit(m)}><FiSettings size={14} /></button>
            <button className="pg-icon-btn lg danger" title="Remove" disabled={busy} onClick={() => remove(m)}><FiTrash2 size={14} /></button>
          </div>
        ))}
      </div>

      <div className="wp-form-actions">
        <button className="modal-btn ghost" onClick={() => setEditing({ id: null, draft: { ...BLANK_MOUNT } })}>
          <FiPlus size={13} /> Add mount
        </button>
      </div>

      {editing && (
        <div className="pg-overlay" onMouseDown={() => !busy && setEditing(null)}>
          <div className="pg-modal sm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="pg-modal-h">
              <FiHardDrive /> {editing.id == null ? 'Add mount' : 'Edit mount'}
              <button className="pg-modal-x" onClick={() => setEditing(null)}><FiX size={17} /></button>
            </div>
            <div className="pg-modal-body">
              <label>Kind</label>
              <div className="tk-seg">
                {(['volume', 'bind', 'file'] as MountType[]).map((k) => (
                  <button key={k} className={editing.draft.type === k ? 'on' : ''}
                    onClick={() => setEditing({ ...editing, draft: { ...editing.draft, type: k } })}>
                    {k === 'volume' ? 'Docker volume' : k === 'bind' ? 'Host path' : 'File'}
                  </button>
                ))}
              </div>

              <label>Container path</label>
              <input className="mono" value={editing.draft.target} placeholder="/app/storage"
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, target: e.target.value } })} />

              {editing.draft.type === 'volume' && (
                <>
                  <label>Volume name <span className="pg-hint">(blank = derived from the path)</span></label>
                  <input className="mono" value={editing.draft.source} placeholder={`${app.name}-storage`}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, source: e.target.value } })} />
                </>
              )}
              {editing.draft.type === 'bind' && (
                <>
                  <label>Host path</label>
                  <input className="mono" value={editing.draft.source} placeholder="/srv/uploads"
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, source: e.target.value } })} />
                  <p className="wp-hint">Created if it doesn’t exist.</p>
                </>
              )}
              {editing.draft.type === 'file' && (
                <>
                  <label>File contents</label>
                  <textarea className="st-file" rows={10} spellCheck={false} value={editing.draft.content}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, content: e.target.value } })} />
                  <p className="wp-hint">Stored with the app’s record, so it survives rebuilds and can be edited here.</p>
                </>
              )}

              <label className="mt-check">
                <input type="checkbox" checked={!!editing.draft.ro}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, ro: e.target.checked } })} />
                <span>Read-only inside the container</span>
              </label>
            </div>
            <div className="pg-modal-foot">
              <button className="pg-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="pg-primary" disabled={busy || !editing.draft.target.trim()} onClick={save}>
                {editing.id == null ? 'Add mount' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resources — CPU and memory caps
// ---------------------------------------------------------------------------

const APPLIED_NOTE: Record<string, string> = {
  live: 'Applied to the running container immediately.',
  recreated: 'Container recreated to drop the limit.',
  'next-start': 'Saved — applies the next time the container starts.',
  none: 'Saved.',
}

const PRESETS: { label: string; cpus: string; memory: string }[] = [
  { label: 'Small · 0.5 CPU / 256m', cpus: '0.5', memory: '256m' },
  { label: 'Medium · 1 CPU / 512m', cpus: '1', memory: '512m' },
  { label: 'Large · 2 CPU / 2g', cpus: '2', memory: '2g' },
]

function ResourcesTab({ app, adapter, onChanged }: { app: HostApp; adapter: HostAdapter; onChanged: () => void }) {
  const [cpus, setCpus] = useState(app.cpus || '')
  const [memory, setMemory] = useState(app.memory || '')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    adapter.api.getLimits(app.name)
      .then((l) => { setCpus(l.cpus); setMemory(l.memory) })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoaded(true))
  }, [app.name, adapter.api])

  const save = async () => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await adapter.api.setLimits(app.name, { cpus: cpus.trim(), memory: memory.trim().toLowerCase() })
      setMsg(APPLIED_NOTE[r.applied] || 'Saved.')
      onChanged()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const capped = !!(cpus || memory)
  return (
    <div className="nx-pane">
      <p className="nx-pane-sub">
        Cap what this container may use, so a runaway process can’t take the machine — and the panel — down with it.
        Leave a field empty for no limit.
      </p>

      <div className="rs-grid">
        <div className="rs-field">
          <label>CPU cores</label>
          <input className="mono" value={cpus} disabled={!loaded} placeholder="unlimited"
            onChange={(e) => setCpus(e.target.value.replace(/[^0-9.]/g, ''))} />
          <span className="wp-hint">Fractions allowed — <code>1.5</code> means one and a half cores.</span>
        </div>
        <div className="rs-field">
          <label>Memory</label>
          <input className="mono" value={memory} disabled={!loaded} placeholder="unlimited"
            onChange={(e) => setMemory(e.target.value)} />
          <span className="wp-hint">e.g. <code>512m</code>, <code>1.5g</code>. Swap is pinned to the same value.</span>
        </div>
      </div>

      <div className="rs-presets">
        {PRESETS.map((p) => (
          <button key={p.label} className={cpus === p.cpus && memory === p.memory ? 'on' : ''}
            onClick={() => { setCpus(p.cpus); setMemory(p.memory) }}>{p.label}</button>
        ))}
        <button className={!capped ? 'on' : ''} onClick={() => { setCpus(''); setMemory('') }}>No limit</button>
      </div>

      <p className="wp-hint">
        Raising or changing a cap is applied live with <code>docker update</code>. Removing one recreates the
        container from its current configuration (no rebuild, brief downtime).
      </p>

      {err && <div className="sys-err">⚠ {err}</div>}
      {msg && <div className="nx-ok sm">{msg}</div>}
      <div className="wp-form-actions">
        <button className={`wp-new ${adapter.accent}`} disabled={busy || !loaded} onClick={save}>
          {busy ? 'Applying…' : 'Apply limits'}
        </button>
      </div>
    </div>
  )
}

function DomainsTab({ app, adapter, onChanged }: { app: HostApp; adapter: HostAdapter; onChanged: () => void }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const enable = async (domain: string) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setErr('Enter an email below first (for the certificate).'); return }
    setBusy(domain); setErr('')
    try { await proxyapi.enableHttps(domain, email.trim()); await onChanged() }
    catch (e) { const pe = e as ProxyError; setErr(pe.hint ? `${pe.message} — ${pe.hint}` : pe.message) }
    finally { setBusy('') }
  }
  const renew = async (domain: string) => { setBusy(domain); setErr(''); try { await proxyapi.renew(domain); await onChanged() } catch (e) { setErr((e as Error).message) } finally { setBusy('') } }
  const remove = async (domain: string) => {
    if (!confirm(`Unlink ${domain}? Its nginx config and certificate are removed.`)) return
    setBusy(domain); setErr('')
    try { await proxyapi.remove(domain); await onChanged() } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  return (
    <div className="nx-pane">
      {app.domains.length > 0 ? (
        <div className="nx-domain-list">
          {app.domains.map((d) => (
            <div key={d.domain} className="nx-domain-item">
              {d.https ? <FiLock size={13} /> : <FiGlobe size={13} />}
              <a href={`${d.https ? 'https' : 'http'}://${d.domain}`} target="_blank" rel="noreferrer" className="nx-domain-name">{d.domain}</a>
              <span className={d.https ? 'nx-tag-ok' : 'nx-tag-warn'}>{d.https ? 'HTTPS' : 'HTTP only'}</span>
              <div className="nx-domain-acts">
                {d.https
                  ? <button disabled={busy === d.domain} onClick={() => renew(d.domain)} title="Renew certificate"><FiRefreshCw size={12} /></button>
                  : <button className="nx-secure" disabled={busy === d.domain} onClick={() => enable(d.domain)} title="Install SSL"><FiLock size={12} /> Secure</button>}
                <button className="danger" disabled={busy === d.domain} onClick={() => remove(d.domain)} title="Unlink"><FiTrash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      ) : <p className="nx-pane-sub">No domains linked yet. Point one at this app to serve it over your own URL with HTTPS.</p>}

      {err && <div className="sys-err">⚠ {err}</div>}

      <div className="nx-add-domain">
        <div className="nx-add-domain-h"><FiPlus size={13} /> Link a new domain</div>
        <DomainForm app={{ name: app.name, port: app.port }} accent={adapter.accent} onDone={onChanged} sharedEmail={email} setSharedEmail={setEmail} inline />
      </div>
    </div>
  )
}

function LogsTab({ app, api }: { app: HostApp; api: HostingApi }) {
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(true)
  const [err, setErr] = useState('')
  const ref = useRef<HTMLPreElement>(null)

  const load = useCallback(async () => {
    try { setText((await api.logs(app.name)).text || '(no output)'); setErr('') }
    catch (e) { setErr((e as Error).message) }
  }, [app.name, api])

  useEffect(() => { load(); if (!auto) return; const t = setInterval(load, 2000); return () => clearInterval(t) }, [load, auto])
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [text])

  return (
    <div className="nx-pane">
      <div className="nx-logs-bar">
        <span className="wp-hint">Runtime logs · last 300 lines</span>
        <label className="nx-auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh</label>
        <button className="sys-btn" onClick={load} title="Refresh now"><FiRefreshCw size={14} /></button>
      </div>
      {err && <div className="sys-err">⚠ {err}</div>}
      <pre className="logs-pre nx-runtime" ref={ref}>{text || 'Loading…'}</pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Env editor
// ---------------------------------------------------------------------------

type Row = { key: string; value: string }

function EnvEditor({ rows, setRows }: { rows: Row[]; setRows: (r: Row[]) => void }) {
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const add = () => setRows([...rows, { key: '', value: '' }])
  const del = (i: number) => setRows(rows.filter((_, j) => j !== i))

  const onPaste = (i: number, e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text')
    if (!/\n|=/.test(text)) return
    e.preventDefault()
    const parsed = parseDotenv(text)
    if (!parsed.length) return
    const next = rows.filter((r) => r.key || r.value)
    next.splice(i, rows[i]?.key || rows[i]?.value ? 0 : 1, ...parsed)
    setRows(next.length ? next : parsed)
  }

  return (
    <div className="nx-env">
      {rows.map((r, i) => (
        <div className="nx-env-row" key={i}>
          <input className="nx-env-key" placeholder="KEY" value={r.key} spellCheck={false}
            onChange={(e) => set(i, { key: e.target.value })} onPaste={(e) => onPaste(i, e)} />
          <input className="nx-env-val" placeholder="value" value={r.value} spellCheck={false}
            onChange={(e) => set(i, { value: e.target.value })} />
          <button className="nx-env-del" onClick={() => del(i)} title="Remove" tabIndex={-1}><FiX size={13} /></button>
        </div>
      ))}
      <button className="nx-env-add" onClick={add}><FiPlus size={12} /> Add variable</button>
      <div className="wp-hint nx-env-hint">Tip: paste a full <code>.env</code> to fill these at once.</div>
    </div>
  )
}

function parseDotenv(text: string): Row[] {
  const out: Row[] = []
  for (let line of text.split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out.push({ key, value })
  }
  return out
}

const rowsToEnv = (rows: Row[]): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const r of rows) { const k = r.key.trim(); if (k) env[k] = r.value }
  return env
}

// ---------------------------------------------------------------------------
// Deploy wizard: repo + env → build → link domain → SSL
// ---------------------------------------------------------------------------

function DeployForm({ adapter, githubConnected, onClose, onDone }: { adapter: HostAdapter; githubConnected: boolean; onClose: () => void; onDone: () => void }) {
  const [repo, setRepo] = useState('')
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [branch, setBranch] = useState('')
  const [port, setPort] = useState('')
  const [extra, setExtra] = useState<Record<string, string>>({})
  const [advanced, setAdvanced] = useState(false)
  const [framework, setFramework] = useState('auto')
  const [overridden, setOverridden] = useState(false)
  const [detection, setDetection] = useState<Detection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [rows, setRows] = useState<Row[]>([{ key: '', value: '' }])
  const [phase, setPhase] = useState<'form' | 'building' | 'domain'>('form')
  const [log, setLog] = useState('')
  const [state, setState] = useState<'building' | 'running' | 'failed'>('building')
  const [buildStart, setBuildStart] = useState(0)
  const [deployedPort, setDeployedPort] = useState<number>(0)
  const [err, setErr] = useState('')

  // When GitHub is connected, load the repo list to power the picker.
  useEffect(() => {
    if (!githubConnected || !adapter.github) return
    let alive = true
    adapter.github.repos().then((r) => { if (alive) setRepos(r.repos) }).catch(() => {})
    return () => { alive = false }
  }, [githubConnected, adapter.github])

  const onRepo = (v: string) => {
    setRepo(v)
    const match = repos.find((r) => r.fullName === v)
    if (match && !branch) setBranch(match.defaultBranch)
    if (!nameEdited) {
      const repoName = v.replace(/\.git$/, '').split('/').filter(Boolean).pop() || ''
      if (repoName) setName(slug(repoName))
    }
  }

  // Live framework detection as the repo is typed (unified mode only).
  useEffect(() => {
    if (!adapter.detect) return
    const r = repo.trim()
    if (!/^([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+|https:\/\/\S+)$/.test(r)) { setDetection(null); return }
    let alive = true
    setDetecting(true)
    const t = setTimeout(async () => {
      try {
        const d = await adapter.detect!(r)
        if (!alive) return
        setDetection(d)
        if (!overridden && d.framework !== 'auto') setFramework(d.framework)
      } catch { if (alive) setDetection(null) } finally { if (alive) setDetecting(false) }
    }, 600)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo])

  const submit = async () => {
    setErr('')
    try {
      const payload: Record<string, unknown> = { name, repo: repo.trim(), branch: branch.trim(), env: rowsToEnv(rows) }
      if (port.trim()) payload.port = Number(port)
      if (adapter.frameworks) payload.framework = framework
      for (const f of adapter.advancedFields) {
        if (f.onlyFramework && f.onlyFramework !== framework) continue
        if (extra[f.key]?.trim()) payload[f.key] = extra[f.key].trim()
      }
      const r = await adapter.api.create(payload)
      setDeployedPort(r.port)
      setBuildStart(Date.now())
      setPhase('building')
    } catch (e) { setErr((e as Error).message) }
  }

  useEffect(() => {
    if (phase !== 'building') return
    let alive = true
    const tick = async () => {
      try {
        const d = await adapter.api.buildlog(name)
        if (!alive) return
        setLog(d.text)
        if (d.state === 'running' || d.state === 'failed') {
          setState(d.state)
          clearInterval(t)
          if (d.state === 'running') setTimeout(() => alive && setPhase('domain'), 900)
        }
      } catch { /* ignore */ }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => { alive = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const wide = phase === 'building' || phase === 'domain'
  return (
    <div className="wp-form-overlay" onMouseDown={() => phase === 'form' && onClose()}>
      <div className={`wp-form ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        {phase === 'building' && (
          <>
            <div className="wp-form-h">{adapter.icon} {name}</div>
            <BuildConsole text={log || 'Starting…'} status={state} startedAt={buildStart || undefined} />
            <div className="wp-form-actions">
              {state === 'failed' && <button className="modal-btn ghost" onClick={onDone}>Close</button>}
            </div>
          </>
        )}

        {phase === 'domain' && (
          <>
            <div className="wp-form-h">✓ {name} is live on port {deployedPort}</div>
            <p className="nx-step-sub">Point a domain at it and get HTTPS — or skip and do it later from Manage → Domains.</p>
            <DomainForm app={{ name, port: deployedPort }} accent={adapter.accent} onDone={onDone}
              footer={<button className="modal-btn ghost" onClick={onDone}>Skip for now</button>} />
          </>
        )}

        {phase === 'form' && (
          <>
            <div className="wp-form-h">{adapter.icon} Deploy — {adapter.title}</div>
            <label>GitHub repository <span className="wp-hint">{githubConnected ? '(pick from your repos, or type owner/repo)' : '(URL or owner/repo)'}</span></label>
            <input placeholder="owner/repo  or  https://github.com/…" value={repo} onChange={(e) => onRepo(e.target.value)} list={repos.length ? 'nx-repo-list' : undefined} autoFocus />
            {repos.length > 0 && (
              <datalist id="nx-repo-list">
                {repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.private ? '🔒 ' : ''}{r.fullName}</option>)}
              </datalist>
            )}

            <label>App name</label>
            <input value={name} onChange={(e) => { setName(slug(e.target.value)); setNameEdited(true) }} />

            {adapter.frameworks && (
              <>
                <label>Framework</label>
                <div className="nx-detect">
                  <select className="nx-fw-select" value={framework} onChange={(e) => { setFramework(e.target.value); setOverridden(true) }}>
                    {adapter.frameworks.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                  <span className="nx-detect-msg">
                    {detecting ? <><div className="splash-spinner small" /> detecting…</>
                      : detection ? <>{detection.framework !== 'auto' && !overridden ? <><FiCheck size={12} /> Detected</> : detection.framework !== 'auto' ? 'Auto-detects to' : ''} {detection.reason}</>
                      : overridden ? 'Manual override' : 'Paste a repo to auto-detect'}
                  </span>
                </div>
              </>
            )}

            <label>Environment variables <span className="wp-hint">(optional)</span></label>
            <EnvEditor rows={rows} setRows={setRows} />
            <div className="wp-hint nx-env-note">{adapter.envNoteFor ? adapter.envNoteFor(framework) : adapter.envNote}</div>

            <button className="nx-adv-toggle" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <FiChevronDown size={13} /> : <FiChevronRight size={13} />} Advanced
            </button>
            {advanced && (
              <div className="nx-adv">
                <div className="wp-row">
                  <div>
                    <label>Branch <span className="wp-hint">(optional)</span></label>
                    <input placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
                  </div>
                  <div>
                    <label>Port <span className="wp-hint">(auto)</span></label>
                    <input placeholder="auto" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
                  </div>
                </div>
                {adapter.advancedFields.filter((f) => !f.onlyFramework || f.onlyFramework === framework).map((f) => (
                  <div key={f.key}>
                    <label>{f.label} {f.hint && <span className="wp-hint">{f.hint}</span>}</label>
                    <input placeholder={f.placeholder} value={extra[f.key] || ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />
                  </div>
                ))}
              </div>
            )}

            {err && <div className="sys-err">⚠ {err}</div>}
            <div className="wp-form-actions">
              <button className="modal-btn ghost" onClick={onClose}>Cancel</button>
              <button className={`wp-new ${adapter.accent}`} disabled={!repo.trim() || !name} onClick={submit}>Deploy</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Domain + SSL form (drives the shared /api/proxy backend)
// ---------------------------------------------------------------------------

function DomainForm({ app, accent, onDone, footer, inline, sharedEmail, setSharedEmail }: {
  app: { name: string; port: number }; accent: string; onDone: () => void; footer?: React.ReactNode; inline?: boolean
  sharedEmail?: string; setSharedEmail?: (v: string) => void
}) {
  const [domain, setDomain] = useState('')
  const [localEmail, setLocalEmail] = useState('')
  const email = sharedEmail ?? localEmail
  const setEmail = setSharedEmail ?? setLocalEmail
  const [pre, setPre] = useState<{ level: string; message: string; hint: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [hint, setHint] = useState('')
  const [done, setDone] = useState<{ https: boolean; message?: string } | null>(null)

  useEffect(() => {
    const d = domain.trim().toLowerCase()
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) { setPre(null); return }
    let alive = true
    const t = setTimeout(async () => {
      try { const p = await proxyapi.precheck(d); if (alive) setPre(p) } catch { /* ignore */ }
    }, 600)
    return () => { alive = false; clearTimeout(t) }
  }, [domain])

  const submit = async (force = false) => {
    setErr(''); setHint(''); setBusy(true)
    try {
      const r = await proxyapi.create({ domain: domain.trim().toLowerCase(), target: String(app.port), https: true, email: email.trim(), force })
      if (inline) { setDomain(''); setPre(null); onDone() }
      else setDone({ https: r.https, message: r.message })
    } catch (e) {
      const pe = e as ProxyError
      setErr(pe.message)
      if (pe.hint) setHint(pe.hint)
    } finally { setBusy(false) }
  }

  if (done) {
    return (
      <div className="nx-done">
        {done.https
          ? <div className="nx-ok"><FiLock /> https://{domain} is live and secured.</div>
          : <div className="sys-warn">Domain linked over HTTP, but SSL isn’t installed yet{done.message ? `: ${done.message}` : '.'} Retry it from Manage → Domains once DNS/firewall are sorted.</div>}
        <div className="wp-form-actions"><button className={`wp-new ${accent}`} onClick={onDone}>Done</button></div>
      </div>
    )
  }

  const preClass = pre ? (pre.level === 'ok' ? 'nx-pre-ok' : pre.level === 'warn' ? 'nx-pre-warn' : 'nx-pre-err') : ''
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
  return (
    <>
      <label>Domain</label>
      <input placeholder="app.example.com" value={domain} spellCheck={false} onChange={(e) => setDomain(e.target.value)} autoFocus={!inline} />
      {pre && <div className={`nx-pre ${preClass}`}>{pre.message}{pre.hint ? ` — ${pre.hint}` : ''}</div>}
      <label>Email <span className="wp-hint">(for Let’s Encrypt renewal notices)</span></label>
      <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      {err && <div className="sys-err">⚠ {err}{hint ? <><br /><span className="wp-hint">{hint}</span></> : null}</div>}
      <div className="wp-form-actions">
        {footer}
        {err && pre?.level === 'error'
          ? <button className={`wp-new ${accent}`} disabled={busy} onClick={() => submit(true)}>Try anyway</button>
          : <button className={`wp-new ${accent}`} disabled={busy || !domain.trim() || !emailOk} onClick={() => submit(false)}>
              {busy ? <><div className="splash-spinner small" /> Installing SSL…</> : <><FiLock size={13} /> Link &amp; secure</>}
            </button>}
      </div>
    </>
  )
}
