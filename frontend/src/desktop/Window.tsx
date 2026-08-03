import { useRef } from 'react'
import type { ReactNode } from 'react'
import { FiX, FiMinus, FiSquare } from 'react-icons/fi'
import type { WinState } from './types'

type Props = {
  win: WinState
  active: boolean
  onFocus: () => void
  onClose: () => void
  onMinimize: () => void
  onToggleMax: () => void
  onMove: (x: number, y: number) => void
  onResize: (w: number, h: number) => void
  children: ReactNode
}

// A single draggable, resizable window. Renders a generic title bar unless the
// window is chromeless (then the app supplies its own header + controls).
export default function Window(props: Props) {
  const { win, active } = props
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null)

  const startDrag = (e: React.MouseEvent) => {
    if (win.maximized) return
    props.onFocus()
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: win.x, oy: win.y }
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', endDrag)
  }
  const onDragMove = (e: MouseEvent) => {
    const d = dragRef.current
    if (!d) return
    props.onMove(Math.max(0, d.ox + e.clientX - d.startX), Math.max(0, d.oy + e.clientY - d.startY))
  }
  const endDrag = () => {
    dragRef.current = null
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', endDrag)
  }

  const startResize = (e: React.MouseEvent) => {
    e.stopPropagation()
    props.onFocus()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: win.w, oh: win.h }
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', endResize)
  }
  const onResizeMove = (e: MouseEvent) => {
    const r = resizeRef.current
    if (!r) return
    props.onResize(Math.max(360, r.ow + e.clientX - r.startX), Math.max(240, r.oh + e.clientY - r.startY))
  }
  const endResize = () => {
    resizeRef.current = null
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', endResize)
  }

  // Maximized windows leave room for the 72px left dock.
  const style: React.CSSProperties = win.maximized
    ? { left: 72, top: 0, width: 'calc(100% - 72px)', height: '100%', zIndex: win.z }
    : { left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div
      className={`win ${active ? 'active' : ''} ${win.chromeless ? 'chromeless' : ''}`}
      style={{ ...style, display: win.minimized ? 'none' : 'flex' }}
      onMouseDown={props.onFocus}
    >
      {!win.chromeless && (
        <div className="win-bar" onMouseDown={startDrag} onDoubleClick={props.onToggleMax}>
          <div className="win-controls">
            <button className="wc close" title="Close" onClick={props.onClose} onMouseDown={stop}>
              <FiX />
            </button>
            <button className="wc min" title="Minimize" onClick={props.onMinimize} onMouseDown={stop}>
              <FiMinus />
            </button>
            <button className="wc max" title="Maximize" onClick={props.onToggleMax} onMouseDown={stop}>
              <FiSquare />
            </button>
          </div>
          <span className="win-title">{win.title}</span>
        </div>
      )}
      <div className="win-body">{props.children}</div>
      {!win.maximized && <div className="win-resize" onMouseDown={startResize} />}
    </div>
  )
}
