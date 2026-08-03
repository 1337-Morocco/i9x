import { useEffect, useRef, useState } from 'react'
import { FiRefreshCw, FiDownload, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi'
import { updateapi, type UpdateInfo, type UpdateStatus } from '../api/update'

const fmtSize = (n?: number | null) => (n ? `${(n / 1024 / 1024).toFixed(1)} MB` : '')

// Settings → Updates. Shows the installed version against whatever the release
// host currently publishes, and installs a newer build in place. The install
// restarts the service under us, so once it starts we poll /status (which is
// backed by a file on disk) and wait for the panel to come back.
export default function Updates() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const polling = useRef<number | null>(null)

  const load = async (force = false) => {
    setBusy(true)
    setErr('')
    try {
      setInfo(await updateapi.check(force))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load()
    return () => { if (polling.current) window.clearInterval(polling.current) }
  }, [])

  // While an update runs the backend goes away mid-install; failed polls are
  // expected, so keep going until the state file says done (or errored).
  const startPolling = () => {
    if (polling.current) window.clearInterval(polling.current)
    polling.current = window.setInterval(async () => {
      try {
        const s = await updateapi.status()
        setStatus(s)
        if (s.state === 'done' || s.state === 'error') {
          window.clearInterval(polling.current!)
          polling.current = null
          if (s.state === 'done') load(true)
        }
      } catch { /* service restarting — keep polling */ }
    }, 2000)
  }

  const install = async () => {
    setErr('')
    setBusy(true)
    try {
      await updateapi.apply()
      setStatus({ state: 'downloading', message: 'starting' })
      startPolling()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const running = status && ['downloading', 'installing'].includes(status.state)

  return (
    <div className="settings-main">
      <h2 className="settings-h">Software updates</h2>
      <p className="settings-desc">
        i9x checks <code>elyosoft.online</code> for a newer release and can install it for you.
      </p>

      <div className="upd-card">
        <div className="upd-row">
          <span className="upd-label">Installed</span>
          <span className="upd-value">{info ? info.current : '…'}</span>
        </div>
        <div className="upd-row">
          <span className="upd-label">Latest</span>
          <span className="upd-value">{info?.latest ?? (info?.error ? 'unknown' : '…')}</span>
        </div>
        {info?.released && (
          <div className="upd-row">
            <span className="upd-label">Released</span>
            <span className="upd-value">{new Date(info.released).toLocaleString()}</span>
          </div>
        )}
        {info?.size ? (
          <div className="upd-row">
            <span className="upd-label">Download</span>
            <span className="upd-value">{fmtSize(info.size)}</span>
          </div>
        ) : null}
      </div>

      {info?.notes && <p className="settings-desc upd-notes">{info.notes}</p>}

      {err && <p className="upd-msg bad"><FiAlertTriangle /> {err}</p>}
      {info?.error && !err && (
        <p className="upd-msg bad"><FiAlertTriangle /> Could not check for updates: {info.error}</p>
      )}
      {info && !info.error && !info.updateAvailable && !running && (
        <p className="upd-msg good"><FiCheckCircle /> i9x is up to date.</p>
      )}
      {info?.updateAvailable && !running && (
        <p className="upd-msg new">Version {info.latest} is available.</p>
      )}
      {info?.updateAvailable && info.supported === false && (
        <p className="upd-msg bad"><FiAlertTriangle /> No build published for this machine ({info.arch}).</p>
      )}

      {running && (
        <p className="upd-msg new">
          {status!.state === 'downloading' ? 'Downloading update…' : 'Installing…'} the panel will
          restart on its own — this page may go blank for a few seconds.
        </p>
      )}
      {status?.state === 'done' && (
        <p className="upd-msg good"><FiCheckCircle /> {status.message || 'Update installed.'} Reload the page to get the new interface.</p>
      )}
      {status?.state === 'error' && (
        <p className="upd-msg bad"><FiAlertTriangle /> {status.message || 'Update failed.'}</p>
      )}

      <div className="upd-actions">
        <button onClick={() => load(true)} disabled={busy || !!running}>
          <FiRefreshCw /> Check again
        </button>
        {info?.updateAvailable && info.canInstall !== false && (
          <button className="primary" onClick={install} disabled={busy || !!running}>
            <FiDownload /> Install {info.latest}
          </button>
        )}
      </div>

      {status?.log && (
        <>
          <h3 className="settings-h3">Update log</h3>
          <pre className="upd-log">{status.log}</pre>
        </>
      )}

      <p className="settings-hint">
        From a shell: <code>sudo i9x-update</code> installs the latest build,
        <code> i9x-update --check</code> only reports.
      </p>
    </div>
  )
}
