import { useEffect, useState, useCallback } from 'react'
import { fsapi } from '../api/fs'
import type { AppApi } from '../desktop/types'

// A real text editor: opens a file from disk, edits it, saves back.
// Ctrl+S saves. The title bar shows a dot while there are unsaved changes.
export default function TextEditor({ api }: { api: AppApi }) {
  const path = api.win.payload as string | undefined
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(!!path)

  useEffect(() => {
    if (!path) {
      setStatus('New file — use the file manager to open something, or save to a path.')
      return
    }
    fsapi
      .read(path)
      .then((r) => {
        setContent(r.content)
        setLoading(false)
        setStatus(`Opened ${path}`)
      })
      .catch((e) => {
        setStatus('⚠ ' + (e as Error).message)
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = useCallback(async () => {
    if (!path) {
      setStatus('⚠ No path — open a file from the file manager first.')
      return
    }
    try {
      await fsapi.write(path, content)
      setDirty(false)
      api.setTitle(path.split('/').pop() || 'editor')
      setStatus(`Saved ✓ ${new Date().toLocaleTimeString()}`)
    } catch (e) {
      setStatus('⚠ ' + (e as Error).message)
    }
  }, [path, content, api])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      save()
    }
  }

  const onChange = (v: string) => {
    setContent(v)
    if (!dirty) {
      setDirty(true)
      api.setTitle('● ' + (path?.split('/').pop() || 'untitled'))
    }
  }

  return (
    <div className="ed">
      <div className="ed-toolbar">
        <button onClick={save} disabled={!path}>💾 Save</button>
        <span className="ed-path">{path || 'untitled'}</span>
        {dirty && <span className="ed-dirty">● unsaved</span>}
      </div>
      {loading ? (
        <div className="ed-loading">Loading…</div>
      ) : (
        <textarea
          className="ed-area"
          value={content}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Text file contents…"
        />
      )}
      <div className="ed-status">{status}</div>
    </div>
  )
}
