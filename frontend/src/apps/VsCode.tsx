import { useState } from 'react'

// Embeds VS Code (code-server) served under /vscode/ via the dev proxy.
export default function VsCode() {
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  return (
    <div className="vscode-app">
      {loading && !failed && (
        <div className="vscode-loading">
          <div className="splash-spinner" />
          <div>Starting VS Code…</div>
        </div>
      )}
      {failed && (
        <div className="vscode-error">
          <b>Couldn’t reach VS Code.</b>
          <p>Make sure code-server is running:</p>
          <code>env -u VSCODE_IPC_HOOK_CLI ~/.local/bin/code-server --auth none --bind-addr 127.0.0.1:8890</code>
        </div>
      )}
      <iframe
        className="vscode-frame"
        src="/vscode/"
        title="VS Code"
        onLoad={() => setLoading(false)}
        onError={() => { setFailed(true); setLoading(false) }}
      />
    </div>
  )
}
