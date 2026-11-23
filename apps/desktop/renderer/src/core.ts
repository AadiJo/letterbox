// This tab's connection to the core, and the hooks React reads it through.
//
// In the desktop shell, the preload hands this page a MessagePort to a core of its own. In a
// plain browser tab the core is at `/core` on the page's own origin, which packages/dev-host
// serves in the dev loop, so the bundle names no backend URL.

import { createClient, type Subscription, type Transport } from '@letterbox/client'
import { messagePortTransport, shellPort, type ShellBridge } from '@letterbox/client/message-port'
import { webSocketTransport } from '@letterbox/client/websocket'
import type { ChangeId, ChangeResult, Command, Queries, Query, Request, RequestId, Requests } from '@letterbox/protocol'
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

/** Where each request this page started with `requestBytes` takes its `chunk` messages, by request id. */
const chunkTakers = new Map<RequestId, (data: string) => void>()
/** Who waits for each change's `settled` (`commandSettled`), by change id. */
const settledTakers = new Map<ChangeId, (result: ChangeResult) => void>()

export const client = createClient(transport, {
  newId,
  // Nothing in this renderer waits for a message no request asked for yet. A chunk goes to
  // the request it belongs to, if this page is collecting its bytes.
  unclaimed: (message) => {
    if (message.kind === 'chunk') chunkTakers.get(message.id)?.(message.data)
    if (message.kind === 'settled') settledTakers.get(message.change)?.(message.result)
  },
})

type Method = keyof Requests

/**
 * Sends `request` and collects the base64 `chunk` messages that come before its response, as
 * the core answers `image` (and `attachment`). Resolves with the response and the chunks in
 * order. The transport hands messages over after `send` returns, so the taker is in place before
 * the first chunk can arrive.
 */
export async function requestBytes<M extends Method>(request: Extract<Request, { method: M }>) {
  const { id, done } = client.begin(request)
  const chunks: string[] = []
  chunkTakers.set(id, (data) => chunks.push(data))
  try {
    return { response: await done, chunks }
  } finally {
    chunkTakers.delete(id)
  }
}

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

/**
 * Sends `sent` as `command` does, and also waits for the core's last word on it: the answer, and
 * a promise of its `settled` result, which never resolves for a refused command or once the
 * connection ends. The wait is in place before the command goes, so no `settled` comes unheard.
 */
export function commandSettled(sent: Command) {
  const change = newId('change') as ChangeId
  const settled = new Promise<ChangeResult>((resolve) => settledTakers.set(change, resolve)).finally(() =>
    settledTakers.delete(change),
  )
  const answer = client.command(sent, change)
  return { change, answer, settled }
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
