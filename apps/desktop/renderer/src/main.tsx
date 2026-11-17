// The renderer's entry. It runs in Electron and, through packages/dev-host, in a plain browser.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { client } from './core.ts'

// Vite drops this branch, and dev.ts with it, from a production build.
if (import.meta.env.DEV) void import('./dev.ts').then(({ installDevHooks }) => installDevHooks(client))

// For styles that differ by platform, such as room for macOS's traffic lights (styles.css `mac:`).
document.documentElement.dataset.platform = window.letterbox?.platform ?? 'web'

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
