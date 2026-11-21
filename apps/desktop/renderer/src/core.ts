// This tab's connection to the core, and the hooks React reads it through.
//
// In the desktop shell, the preload hands this page a MessagePort to a core of its own. In a
// plain browser tab the core is at `/core` on the page's own origin, which packages/dev-host
// serves in the dev loop, so the bundle names no backend URL.

import { createClient, type Subscription, type Transport } from '@letterbox/client'
import { messagePortTransport, shellPort, type ShellBridge } from '@letterbox/client/message-port'
import { webSocketTransport } from '@letterbox/client/websocket'
import type { ChangeId, Command, Queries, Query } from '@letterbox/protocol'
import { useState, useSyncExternalStore } from 'react'

type View = keyof Queries
type QueryFor<V extends View> = Extract<Query, { view: V }>

const coreUrl = new URL('/core', location.href)
coreUrl.protocol = coreUrl.protocol === 'https:' ? 'wss:' : 'ws:'

/** Why the connection ended, or null while it is open. */
let lost: string | null = null
const lostWatchers = new Set<() => void>()

declare global {
  interface Window {
    /** Set by the desktop shell's preload. Absent in a plain browser tab. */
    letterbox?: ShellBridge
  }
}

const connection = window.letterbox
  ? messagePortTransport(shellPort(window.letterbox))
  : webSocketTransport(coreUrl.href)
/** The connection, plus a note of why it ended for `useLost`. */
const transport: Transport = {
  send: connection.send,
  listen: (listener) =>
    connection.listen({
      receive: listener.receive,
      end: (error) => {
        listener.end(error)
        lost = error.message
        console.error('lost the core:', error)
        for (const watcher of lostWatchers) watcher()
      },
    }),
}

/** A random id. `crypto.randomUUID` needs a secure context, and the dev page may be served over plain http. */
const randomId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('')

/** Change ids must differ across restarts too, so they are random, not counted. */
const newId = (kind: 'sub' | 'req' | 'change') => `${kind}-${randomId()}`

export const client = createClient(transport, {
  newId,
  // Nothing in this renderer waits for a message no request asked for yet.
  unclaimed: () => {},
})

/**
 * Sends `command` and hands back its change id at once, with the core's answer to come. For a
 * caller that must keep the id even if the answer never arrives, since the core may have
 * stored the change anyway (sending.ts). Passing an earlier `change` again asks about that
 * same change: the core answers a repeated id from what it stored (protocol guarantee 4).
 */
export function command(sent: Command, change?: ChangeId) {
  // The client makes change ids (ClientMessage `command`), so this is where one is branded.
  const id = change ?? (newId('change') as ChangeId)
  return { change: id, answer: client.command(sent, id) }
}

// A failed hello ends the connection, which `useLost` reports.
client.hello().catch(() => {})

/**
 * A live view that opens its core subscription when React first subscribes and closes it
 * when the last subscriber leaves. Making one sends nothing, so it is safe during render.
 */
function lazyView<V extends View>(query: QueryFor<V>) {
  let open: Subscription<V> | undefined
  let watchers = 0
  return {
    key: JSON.stringify(query),
    subscribe: (onChange: () => void) => {
      open ??= client.subscribe(query)
      const subscription = open
      const stop = subscription.watch(onChange)
      watchers += 1
      return () => {
        stop()
        watchers -= 1
        // React unsubscribes and subscribes again at once in Strict Mode. Close only if nobody came back.
        queueMicrotask(() => {
          if (watchers > 0 || open !== subscription) return
          subscription.close()
          open = undefined
        })
      }
    },
    latest: () => open?.latest(),
  }
}

/** The newest data of a live view, or undefined until the core sends it. A new query opens a new view. */
export function useView<V extends View>(query: QueryFor<V>): Queries[V]['result'] | undefined {
  const [view, setView] = useState(() => lazyView(query))
  const next = view.key === JSON.stringify(query) ? view : lazyView(query)
  if (next !== view) setView(next)
  return useSyncExternalStore(next.subscribe, next.latest)
}

/** Why this tab lost the core, or null while it has it. */
export const lostReason = () => lost

/** `lostReason`, for React. */
export function useLost() {
  return useSyncExternalStore((onChange) => {
    lostWatchers.add(onChange)
    return () => void lostWatchers.delete(onChange)
  }, lostReason)
}
