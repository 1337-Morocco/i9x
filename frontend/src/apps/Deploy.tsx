import { FiUploadCloud } from 'react-icons/fi'
import AppHosting, { type HostAdapter } from './AppHosting'
import { deployapi } from '../api/deploy'
import { githubapi } from '../api/github'

const envNoteFor = (fw: string) => {
  if (fw === 'next') return <>Injected at build time (so <code>NEXT_PUBLIC_*</code> get inlined) and at runtime for server secrets.</>
  if (fw === 'vite') return <>Injected at build time — Vite inlines <code>VITE_*</code> into the bundle. Static output, no runtime env. Rebuild to apply.</>
  if (fw === 'node') return <>Available to the process at runtime via the environment, and at build time if the app has a build step.</>
  return <>Injected at build time and (for server frameworks) at runtime. The exact behaviour follows the detected framework.</>
}

const adapter: HostAdapter = {
  title: 'Deploy',
  icon: <FiUploadCloud />,
  accent: 'deploy',
  api: deployapi,
  envNote: envNoteFor('auto'),
  envNoteFor,
  webhooks: true,
  github: githubapi,
  detect: deployapi.detect,
  frameworks: [
    { id: 'auto', label: 'Auto-detect' },
    { id: 'next', label: 'Next.js' },
    { id: 'vite', label: 'Vite (static)' },
    { id: 'node', label: 'Node' },
  ],
  advancedFields: [
    { key: 'outDir', label: 'Output directory', placeholder: 'dist', hint: '(Vite build output)', onlyFramework: 'vite' },
  ],
  extraInfo: (app) => (app.framework === 'vite' && app.outDir ? [{ label: 'Output dir', value: app.outDir }] : []),
}

export default function Deploy() {
  return <AppHosting adapter={adapter} />
}
