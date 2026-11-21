// A TypeScript client for the sim provider: two sign-in options whose adapters
// forward every call over the unix socket to server.ts. The core uses the Rust
// copy in crates/sim-client. The self-check drives the server through this one.
//
// Each sign-in attempt and each adapter has its own socket. An adapter that
// loses its socket answers `offline` and connects again on its next call.

import { createConnection } from 'node:net'
import type { Adapter, AdapterFactory } from './adapter.ts'
import type { SimAdapterFactories } from './contract.ts'
import { encode, isRecord, isReply, lineReader } from './wire.ts'
import type { Call, CallResult, Reply, RequestBody, Session, SignInResult } from './wire.ts'

type SignInAnswer = Awaited<ReturnType<AdapterFactory['connect']>>

const offline: { ok: false; failure: 'offline' } = { ok: false, failure: 'offline' }
const cancelled: { ok: false; failure: 'cancelled' } = { ok: false, failure: 'cancelled' }
const unconfirmed: { ok: true; kind: 'unconfirmed' } = { ok: true, kind: 'unconfirmed' }

/** One open socket to the server. */
type Link = {
  /** Sends one request. `onReply` gets each reply to it, or null if the socket drops before the last one. */
  send(body: RequestBody, onReply: (reply: Reply | null) => void): void
  isOpen(): boolean
  /** Closes the socket. Resolves once it is closed. */
  close(): Promise<void>
}

/** Connects to the server. Resolves null if nothing is listening at `socketPath`. */
const openLink = (socketPath: string): Promise<Link | null> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath)
    const waiting = new Map<number, (reply: Reply | null) => void>()
    let sent = 0
    let open = false
    const link: Link = {
      send: (body, onReply) => {
        if (!open) return onReply(null)
        sent += 1
        waiting.set(sent, onReply)
        socket.write(encode({ id: sent, ...body }))
      },
      isOpen: () => open,
      close: () =>
        new Promise((closed) => {
          if (socket.closed) return closed()
          socket.once('close', () => closed())
          socket.destroy()
        }),
    }
    const read = lineReader((value) => {
      if (!isReply(value)) throw new Error(`sim provider: not a reply: ${JSON.stringify(value)}`)
      const onReply = waiting.get(value.id)
      // Only an oauth sign-in gets more than one reply, and `open-url` is never its last.
      if (value.kind !== 'open-url') waiting.delete(value.id)
      onReply?.(value)
    })
    socket.setEncoding('utf8')
    // A line that is not a reply ends the link like a dropped socket: every call still waiting gets no answer.
    socket.on('data', (chunk: string) => {
      try {
        read(chunk)
      } catch {
        socket.destroy()
      }
    })
    socket.on('connect', () => {
      open = true
      resolve(link)
    })
    // A failed connect or a dropped socket shows up as an error and then a close. Only the close matters.
    socket.on('error', () => {})
    socket.on('close', () => {
      open = false
      resolve(null)
      const dropped = [...waiting.values()]
      waiting.clear()
      for (const onReply of dropped) onReply(null)
    })
  })

/** Sends a request that has exactly one reply. Resolves null if the socket drops first. */
const ask = (link: Link, body: RequestBody): Promise<Reply | null> => new Promise((resolve) => link.send(body, resolve))

/** Reads a session string back into what `connect` put there. A string that is not one is a core bug. */
const readSession = (session: string): Session => {
  const value: unknown = JSON.parse(session)
  if (
    isRecord(value) &&
    typeof value.address === 'string' &&
    (value.dialect === 'labels' || value.dialect === 'folders') &&
    typeof value.modify === 'boolean'
  ) {
    return { address: value.address, dialect: value.dialect, modify: value.modify }
  }
  throw new Error('sim provider: not a session string from this provider')
}

/**
 * Builds the adapter for one signed-in mailbox. `first` is the socket the
 * sign-in used, or null after `resume`, where the first call connects.
 */
const createAdapter = (socketPath: string, session: Session, first: Link | null): Adapter => {
  let connecting: Promise<Link | null> = Promise.resolve(first)
  let closed = false

  /** The open socket, connecting again if there is none. Null when the server cannot be reached. */
  const reach = async (): Promise<Link | null> => {
    const tried = connecting
    const link = await tried
    if (closed) return null
    if (link?.isOpen()) return link
    // That socket never opened or has dropped. Open a new one, unless a call running beside this one already did.
    if (connecting === tried) connecting = openLink(socketPath)
    return connecting
  }

  /** Forwards one call. Null means it did not reach the server. */
  const forward = async (call: Call): Promise<CallResult | null> => {
    const link = await reach()
    if (link === null) return null
    const reply = await ask(link, { op: 'call', address: session.address, call })
    return reply?.kind === 'result' ? reply.result : null
  }

  return {
    capabilities: { modify: session.modify, send: session.modify, multipleMailboxes: session.dialect === 'labels' },
    snapshot: async (page) => {
      const result = await forward({ method: 'snapshot', arg: page })
      return result?.method === 'snapshot' ? result.outcome : offline
    },
    changes: async (cursor) => {
      const result = await forward({ method: 'changes', arg: cursor })
      return result?.method === 'changes' ? result.outcome : offline
    },
    body: async (ref) => {
      const result = await forward({ method: 'body', arg: ref })
      return result?.method === 'body' ? result.outcome : offline
    },
    attachment: async (arg) => {
      const result = await forward({ method: 'attachment', arg })
      return result?.method === 'attachment' ? result.outcome : offline
    },
    apply: async (mutation) => {
      const result = await forward({ method: 'apply', arg: mutation })
      return result?.method === 'apply' ? result.outcome : offline
    },
    // No socket means the server surely did not get it. A socket that drops after the request
    // went out means it may have (adapter rule 10).
    send: async (message) => {
      const link = await reach()
      if (link === null) return offline
      const reply = await ask(link, { op: 'call', address: session.address, call: { method: 'send', arg: message } })
      return reply?.kind === 'result' && reply.result.method === 'send' ? reply.result.outcome : unconfirmed
    },
    find: async (messageId) => {
      const result = await forward({ method: 'find', arg: messageId })
      return result?.method === 'find' ? result.outcome : offline
    },
    // Each call goes to the server once, so there is no wait between tries to end.
    stopWaiting: () => {},
    close: async () => {
      closed = true
      const link = await connecting
      await link?.close()
    },
  }
}

/** The two sign-in options for the provider listening at `socketPath`: password first, then oauth. */
export const simAdapterFactories: SimAdapterFactories = (socketPath) => {
  const resume = (session: string): Adapter => createAdapter(socketPath, readSession(session), null)

  /** Ends a sign-in attempt. A success hands the attempt's socket to the new adapter. A failure closes it. */
  const conclude = async (link: Link, result: SignInResult): Promise<SignInAnswer> => {
    if (!result.ok) {
      await link.close()
      return result
    }
    return {
      ok: true,
      address: result.session.address,
      providerLabel: result.session.dialect === 'labels' ? 'Sim labels' : 'Sim folders',
      adapter: createAdapter(socketPath, result.session, link),
      session: JSON.stringify(result.session),
    }
  }

  const byPassword: AdapterFactory = {
    option: { id: 'sim-password', label: 'Sim password', method: 'password' },
    connect: async ({ password, signal }) => {
      if (signal.aborted) return cancelled
      if (!password) return { ok: false, failure: 'wrong-password' }
      const link = await openLink(socketPath)
      if (link === null) return offline
      const reply = await ask(link, { op: 'sign-in-password', address: password.username, password: password.password })
      if (signal.aborted) return conclude(link, cancelled)
      return conclude(link, reply?.kind === 'signed-in' ? reply.result : offline)
    },
    resume,
  }

  const byOauth: AdapterFactory = {
    option: { id: 'sim-oauth', label: 'Sim oauth', method: 'oauth' },
    connect: async ({ openUrl, signal }) => {
      if (signal.aborted) return cancelled
      const link = await openLink(socketPath)
      if (link === null) return offline
      const abort = new AbortController()
      const result = await new Promise<SignInResult>((resolve) => {
        if (signal.aborted) return resolve(cancelled)
        signal.addEventListener('abort', () => resolve(cancelled), { signal: abort.signal })
        link.send({ op: 'sign-in-oauth' }, (reply) => {
          if (reply === null) resolve(offline)
          else if (reply.kind === 'open-url') openUrl(reply.url)
          else if (reply.kind === 'signed-in') resolve(reply.result)
        })
      })
      // Stop listening to the caller's signal. Closing the socket on a failure makes the server forget the attempt.
      abort.abort()
      return conclude(link, result)
    },
    resume,
  }

  return [byPassword, byOauth]
}
