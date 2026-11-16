// This tab's connection to the core, and the hooks React reads it through.
//
// The core is at `/core` on the page's own origin. In the dev loop packages/dev-host serves
// that route, so the bundle names no backend URL.

import { createClient, type Subscription, type Transport } from '@letterbox/client'
import { webSocketTransport } from '@letterbox/client/websocket'
import type { Queries, Query } from '@letterbox/protocol'
import { useState, useSyncExternalStore } from 'react'

type View = keyof Queries
type QueryFor<V extends View> = Extract<Query, { view: V }>

const coreUrl = new URL('/core', location.href)
coreUrl.protocol = coreUrl.protocol === 'https:' ? 'wss:' : 'ws:'

/** Why the connection ended, or null while it is open. */
let lost: string | null = null
const lostWatchers = new Set<() => void>()

const socket = webSocketTransport(coreUrl.href)
/** The WebSocket transport, plus a note of why it ended for `useLost`. */
const transport: Transport = {
  send: socket.send,
  listen: (listener) =>
    socket.listen({
      receive: listener.receive,
      end: (error) => {
        listener.end(error)
        lost = error.message
        for (const watcher of lostWatchers) watcher()
      },
    }),
}

/** A random id. `crypto.randomUUID` needs a secure context, and the dev page may be served over plain http. */
const randomId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('')

export const client = createClient(transport, {
  // Change ids must differ across restarts too, so they are random, not counted.
  newId: (kind) => `${kind}-${randomId()}`,
  // Nothing in this renderer waits for a message no request asked for yet.
  unclaimed: () => {},
})

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
export function useLost() {
  return useSyncExternalStore(
    (onChange) => {
      lostWatchers.add(onChange)
      return () => void lostWatchers.delete(onChange)
    },
    () => lost,
  )
}
