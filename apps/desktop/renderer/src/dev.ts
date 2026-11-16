// Hooks for a coding agent driving the renderer in a browser. Dev builds only: main.tsx
// loads this file behind `import.meta.env.DEV`. The routes it calls exist only in packages/dev-host.

import type { Client } from '@letterbox/client'

declare global {
  interface Window {
    letterboxDev?: {
      /** Delivers `count` new automated messages at the sim provider, then syncs. Resolves once the core has them. */
      deliver(count: number): Promise<void>
      /** Signs this tab's core in to a sim mailbox by password. For a host that starts with an empty store. */
      signIn(address: string, password: string): Promise<void>
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
    signIn: async (address, password) => {
      const options = await client.query({ view: 'sign-in-options' })
      const option = options.find((candidate) => candidate.method === 'password')
      if (!option) throw new Error('the core lists no password sign-in option')
      const signedIn = await client.request({
        method: 'sign-in',
        option: option.id,
        password: { username: address, password },
      })
      if (!signedIn.ok) throw new Error(`sign-in failed: ${signedIn.error}`)
    },
  }
}
