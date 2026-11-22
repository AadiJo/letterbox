// Hooks for a coding agent driving the renderer in a browser. Dev builds only: main.tsx
// loads this file behind `import.meta.env.DEV`. The routes it calls exist only in packages/dev-host.
//
// With `?sign-in=oauth` on the page URL, as `pnpm dev:desktop --core gmail` loads it, the page
// also starts the core's OAuth sign-in once if no account is signed in (startOauth). The
// renderer has no sign-in screen yet, and the real core's store starts empty.

import type { Client } from '@letterbox/client'
import type { Attachment, SignInError, ThreadId } from '@letterbox/protocol'

/** The query parameter that asks for startOauth. packages/dev-host adds it to the page URL. */
const SIGN_IN_PARAM = 'sign-in'

/** What startOauth came to. */
export type OauthStart =
  | { kind: 'already-signed-in' }
  | { kind: 'signed-in' }
  | { kind: 'no-oauth-option' }
  | { kind: 'failed'; error: SignInError }

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
      /** Syncs every account once. */
      sync(): Promise<void>
      /** The id of the conversation with this subject. */
      threadOf(subject: string): Promise<ThreadId>
      /** Marks the conversation with this subject read, and resolves once the core has answered everything before. */
      markRead(subject: string): Promise<void>
      /** What the page's own OAuth sign-in came to, on a page loaded with `?sign-in=oauth`. Undefined on any other. */
      oauth: Promise<OauthStart> | undefined
    }
  }
}

/**
 * Starts the first OAuth option the core lists, if no account is signed in: none at all, or
 * each one needing a sign-in again. The core sends the consent page as `open-url`. In the
 * desktop shell main opens it in the browser with shell.openExternal; this page leaves it
 * alone (core.ts claims nothing), so the page never shows or opens it. Resolves once the core
 * answers, which is after the person finishes or abandons consent.
 */
async function startOauth(client: Client): Promise<OauthStart> {
  const accounts = await client.query({ view: 'accounts' })
  if (accounts.some((account) => account.status.state !== 'needs-sign-in')) return { kind: 'already-signed-in' }
  const options = await client.query({ view: 'sign-in-options' })
  const option = options.find((candidate) => candidate.method === 'oauth')
  if (!option) return { kind: 'no-oauth-option' }
  const signedIn = await client.request({ method: 'sign-in', option: option.id })
  return signedIn.ok ? { kind: 'signed-in' } : { kind: 'failed', error: signedIn.error }
}

/**
 * The URL this document loaded from. Not `location`: it follows history.replaceState, and the
 * hooks load after the page starts, so a URL changed in between would start a sign-in that
 * this page load never asked for.
 */
const loadedFrom = () => new URL(performance.getEntriesByType('navigation')[0]?.name ?? location.href)

/** Puts the hooks on `window.letterboxDev`, and starts the OAuth sign-in if the page loaded with `?sign-in=oauth`. */
export function installDevHooks(client: Client) {
  const oauth =
    loadedFrom().searchParams.get(SIGN_IN_PARAM) === 'oauth'
      ? startOauth(client).then((start) => {
          console.info('[dev] oauth sign-in:', start)
          return start
        })
      : undefined
  window.letterboxDev = {
    oauth,
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
    sync: async () => {
      const synced = await client.request({ method: 'sync-now' })
      if (!synced.ok) throw new Error(`the sync failed: ${synced.error}`)
    },
    threadOf: async (subject) => {
      // oxlint-disable-next-line letterbox/renderer-thread-lists -- a dev hook reads the list once and renders no row
      const list = await client.query({ view: 'threads', filter: { text: subject }, offset: 0, limit: 10 })
      const found = list.threads.find((thread) => thread.subject === subject)
      if (!found) throw new Error(`no conversation is called "${subject}"`)
      return found.id
    },
    markRead: async (subject) => {
      const threadId = await window.letterboxDev?.threadOf(subject)
      if (threadId === undefined) throw new Error('the dev hooks are gone')
      const answer = await client.command({ kind: 'set-flags', threadIds: [threadId], unread: false })
      if (answer.kind !== 'accepted') throw new Error(`marking read was rejected: ${answer.reason}`)
      await window.letterboxDev?.settle()
    },
    attachments: async (subject) => {
      await window.letterboxDev?.sync()
      const threadId = await window.letterboxDev?.threadOf(subject)
      if (threadId === undefined) throw new Error('the dev hooks are gone')
      const open = client.subscribe({ view: 'thread', threadId })
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
