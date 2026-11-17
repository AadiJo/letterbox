// Hooks for a coding agent driving the renderer in a browser. Dev builds only: main.tsx
// loads this file behind `import.meta.env.DEV`. The routes it calls exist only in packages/dev-host.

import type { Client } from '@letterbox/client'
import type { Attachment } from '@letterbox/protocol'

declare global {
  interface Window {
    letterboxDev?: {
      /** Delivers `count` new automated messages at the sim provider, then syncs. Resolves once the core has them. */
      deliver(count: number): Promise<void>
      /** Signs this tab's core in to a sim mailbox by password. For a host that starts with an empty store. */
      signIn(address: string, password: string): Promise<void>
      /** Resolves once the core has answered everything this tab sent before it. */
      settle(): Promise<void>
      /** Syncs, then gives the files of the conversation with this subject once its bodies have loaded. */
      attachments(subject: string): Promise<Attachment[]>
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
    // The core answers in the order it reads, so a query's answer comes after every earlier one.
    settle: async () => void (await client.query({ view: 'accounts' })),
    attachments: async (subject) => {
      const synced = await client.request({ method: 'sync-now' })
      if (!synced.ok) throw new Error(`the sync before reading the files failed: ${synced.error}`)
      // oxlint-disable-next-line letterbox/renderer-thread-lists -- a dev hook reads the list once and renders no row
      const list = await client.query({ view: 'threads', filter: { text: subject }, offset: 0, limit: 10 })
      const found = list.threads.find((thread) => thread.subject === subject)
      if (!found) throw new Error(`no conversation is called "${subject}"`)
      const open = client.subscribe({ view: 'thread', threadId: found.id })
      try {
        let detail = open.latest() ?? (await open.next())
        while (detail?.messages.some((message) => message.body.state === 'loading'))
          // oxlint-disable-next-line no-await-in-loop -- each update is the one after the last
          detail = await open.next()
        return detail?.messages.flatMap((message) => message.attachments) ?? []
      } finally {
        open.close()
      }
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
