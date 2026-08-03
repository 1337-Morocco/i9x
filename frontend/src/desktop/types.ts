// Window-manager types shared across the desktop.

export type AppId = 'files' | 'editor' | 'terminal' | 'taskmanager' | 'settings' | 'vscode' | 'system' | 'docker' | 'wordpress' | 'websites' | 'deploy' | 'databases' | 'domains' | 'tasks' | 'maintenance'

export type WinState = {
  id: number
  app: AppId
  title: string
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized: boolean
  maximized: boolean
  // Chromeless windows draw no generic title bar — the app renders its own
  // header (used by Files to match the GNOME split-header look).
  chromeless?: boolean
  // App-specific launch payload (e.g. a file path for the editor).
  payload?: unknown
}

// Handed to every app so it can drive the window manager.
export type AppApi = {
  win: WinState
  setTitle: (title: string) => void
  close: () => void
  minimize: () => void
  toggleMax: () => void
  // Begin dragging the window from a custom header (chromeless apps).
  startDrag: (e: React.MouseEvent) => void
  open: (app: AppId, opts?: { title?: string; payload?: unknown }) => void
}
