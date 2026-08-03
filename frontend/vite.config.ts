import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Shell WebSocket + REST API -> backend.
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/api': { target: 'http://localhost:3001' },
      // VS Code (code-server) embedded under /vscode/. code-server uses
      // relative asset paths, so stripping the prefix keeps everything under
      // /vscode/. We rewrite the Origin so its same-origin ws check passes.
      '/vscode': {
        target: 'http://127.0.0.1:8890',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/vscode/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (r) => r.setHeader('origin', 'http://127.0.0.1:8890'))
          proxy.on('proxyReqWs', (r) => r.setHeader('origin', 'http://127.0.0.1:8890'))
        },
      },
    },
  },
})
