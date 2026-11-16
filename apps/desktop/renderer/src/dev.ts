// Hooks for a coding agent driving the renderer in a browser. Dev builds only: main.tsx
// loads this file behind `import.meta.env.DEV`. The routes it calls exist only in packages/dev-host.

import type { Client } from '@letterbox/client'

declare global {
  interface Window {
    letterboxDev?: {
      /** Delivers `count` new automated messages at the sim provider, then syncs. Resolves once the core has them. */
      deliver(count: number): Promise<void>
    }
  }
}

/** Puts the hooks on `window.letterboxDev`. */
export function installDevHooks(client: Client) {
  window.letterboxDev = {
    deliver: async (count) => {
      const response = await fetch('/dev/deliver', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count }),
      })
      if (!response.ok) throw new Error(`the dev host refused the delivery: ${await response.text()}`)
      const synced = await client.request({ method: 'sync-now' })
      if (!synced.ok) throw new Error(`the sync after the delivery failed: ${synced.error}`)
    },
  }
}
