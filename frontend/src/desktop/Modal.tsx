import { useEffect, useRef, useState } from 'react'

export type ModalSpec = {
  kind: 'prompt' | 'confirm' | 'alert'
  title: string
  message?: string
  label?: string
  initial?: string
  placeholder?: string
  okText?: string
  danger?: boolean
}

// An in-app dialog rendered as an overlay inside the current window
// (no native browser prompt/confirm). Enter confirms, Esc cancels.
export default function Modal({
  spec,
  onOk,
  onCancel,
}: {
  spec: ModalSpec
  onOk: (value: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(spec.initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (spec.kind === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [spec.kind])

  const confirm = () => onOk(spec.kind === 'prompt' ? val : 'ok')

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (spec.kind !== 'prompt' || val.trim()) confirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="modal-title">{spec.title}</div>
        {spec.message && <div className="modal-message">{spec.message}</div>}
        {spec.kind === 'prompt' && (
          <>
            {spec.label && <label className="modal-label">{spec.label}</label>}
            <input
              ref={inputRef}
              className="modal-input"
              value={val}
              placeholder={spec.placeholder}
              onChange={(e) => setVal(e.target.value)}
            />
          </>
        )}
        <div className="modal-actions">
          {spec.kind !== 'alert' && (
            <button className="modal-btn ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            className={`modal-btn ${spec.danger ? 'danger' : 'primary'}`}
            disabled={spec.kind === 'prompt' && !val.trim()}
            onClick={confirm}
          >
            {spec.okText || 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
