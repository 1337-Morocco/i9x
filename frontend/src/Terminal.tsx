import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ITheme } from '@xterm/xterm'
import { FiX, FiMinus, FiSquare, FiSettings, FiMinusCircle, FiPlusCircle } from 'react-icons/fi'
import '@xterm/xterm/css/xterm.css'
import type { AppApi } from './desktop/types'
import { getToken } from './api/auth'

type Th = { glass: boolean; bg: string; fg: string; cursor: string; ansi: string[] }

// Color themes. `bg` is applied to the container (so it can be translucent for
// the glass effect); xterm draws only text over a transparent canvas.
const THEMES: Record<string, Th> = {
  Ubuntu: {
    glass: true, bg: 'rgba(48,10,36,0.70)', fg: '#eeeeec', cursor: '#e95420',
    ansi: ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'],
  },
  Dracula: {
    glass: true, bg: 'rgba(40,42,54,0.72)', fg: '#f8f8f2', cursor: '#ff79c6',
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  },
  Nord: {
    glass: true, bg: 'rgba(46,52,64,0.72)', fg: '#d8dee9', cursor: '#88c0d0',
    ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  },
  'Solarized Dark': {
    glass: true, bg: 'rgba(0,43,54,0.74)', fg: '#93a1a1', cursor: '#b58900',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  },
  'One Dark': {
    glass: true, bg: 'rgba(40,44,52,0.72)', fg: '#abb2bf', cursor: '#61afef',
    ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  },
  Light: {
    glass: false, bg: '#fdf6e3', fg: '#3d3846', cursor: '#e95420',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#073642', '#586e75', '#cb4b16', '#657b83', '#839496', '#94a1a1', '#6c71c4', '#586e75', '#002b36'],
  },
}

function xtermTheme(t: Th): ITheme {
  const [k, r, g, y, b, m, c, w, K, R, G, Y, B, M, C, W] = t.ansi
  return {
    background: 'rgba(0,0,0,0)',
    foreground: t.fg,
    cursor: t.cursor,
    cursorAccent: t.bg,
    selectionBackground: 'rgba(255,255,255,0.25)',
    black: k, red: r, green: g, yellow: y, blue: b, magenta: m, cyan: c, white: w,
    brightBlack: K, brightRed: R, brightGreen: G, brightYellow: Y, brightBlue: B, brightMagenta: M, brightCyan: C, brightWhite: W,
  }
}

// A real terminal onto the host, in a glassy themed window with a settings menu.
export default function I9xTerminal({ api }: { api: AppApi }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const [themeName, setThemeName] = useState('Ubuntu')
  const [fontSize, setFontSize] = useState(14)
  const [settings, setSettings] = useState(false)
  const theme = THEMES[themeName]

  // Create the terminal once and stream to the backend PTY.
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      allowTransparency: true,
      fontFamily: "'Ubuntu Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize,
      theme: xtermTheme(THEMES[themeName]),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${getToken() ?? ''}`)
    ws.binaryType = 'arraybuffer'

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send('\x00CTRL' + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
    }
    ws.onopen = () => { term.focus(); sendResize() }
    ws.onmessage = (ev) => term.write(new Uint8Array(ev.data as ArrayBuffer))
    ws.onclose = () => term.write('\r\n\x1b[31m[disconnected]\x1b[0m\r\n')

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    const onResize = () => { try { fit.fit() } catch { /* not measurable yet */ } sendResize() }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    if (hostRef.current) ro.observe(hostRef.current)

    return () => {
      dataDisposable.dispose()
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      ws.close()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live-apply theme / font changes to the existing terminal.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme)
  }, [theme])
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize
      try { fitRef.current?.fit() } catch { /* ignore */ }
    }
  }, [fontSize])

  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div className={`term-app ${theme.glass ? 'glass' : ''}`} onClick={() => settings && setSettings(false)}>
      <div className="term-head" onMouseDown={api.startDrag} onDoubleClick={api.toggleMax}>
        <div className="term-ctrls" onMouseDown={stop}>
          <button className="tmc close" title="Close" onClick={api.close}><FiX /></button>
          <button className="tmc min" title="Minimize" onClick={api.minimize}><FiMinus /></button>
          <button className="tmc max" title="Maximize" onClick={api.toggleMax}><FiSquare /></button>
        </div>
        <div className="term-title">bash — {api.win.title === 'Terminal' ? 'Terminal' : api.win.title}</div>
        <div className="term-tools" onMouseDown={stop}>
          <button className="term-ic" title="Smaller text" onClick={() => setFontSize((s) => Math.max(9, s - 1))}><FiMinusCircle /></button>
          <span className="term-fs">{fontSize}</span>
          <button className="term-ic" title="Larger text" onClick={() => setFontSize((s) => Math.min(28, s + 1))}><FiPlusCircle /></button>
          <button className={`term-ic ${settings ? 'on' : ''}`} title="Settings" onClick={(e) => { e.stopPropagation(); setSettings((v) => !v) }}><FiSettings /></button>
          {settings && (
            <div className="term-menu" onClick={(e) => e.stopPropagation()}>
              <div className="term-menu-h">Theme</div>
              {Object.keys(THEMES).map((name) => (
                <button
                  key={name}
                  className={themeName === name ? 'active' : ''}
                  onClick={() => setThemeName(name)}
                >
                  <span className="tsw" style={{ background: THEMES[name].bg, borderColor: THEMES[name].cursor }} />
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        className={`term-host ${theme.glass ? 'glass' : ''}`}
        ref={hostRef}
        style={{ background: theme.bg }}
      />
    </div>
  )
}
