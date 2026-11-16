// The sim provider's server. It runs inside the test process, owns every
// mailbox's ground truth, and answers adapters over a unix socket: the core's in
// crates/sim-client, and the self-check's in client.ts.

import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import type { SendDamage, SimProvider, StartSimProvider } from './contract.ts'
import { createMailboxEntry } from './mailbox.ts'
import type { MailboxEntry } from './mailbox.ts'
import { encode, failedCall, isRequest, lineReader } from './wire.ts'
import type { CallResult, Reply, Request, SignInResult } from './wire.ts'

/** Writes one reply, unless the client has already gone. */
const send = (socket: Socket, reply: Reply): void => {
  if (!socket.destroyed) socket.write(encode(reply))
}

/** Fields whose string values are opaque to the core: refs, cursors and page tokens. */
const OPAQUE = new Set(['ref', 'refs', 'parent', 'cursor', 'next', 'mailboxes', 'removed', 'from', 'to'])

/**
 * Adds every opaque string in an adapter result to `into`. `from` and `to` count only as
 * plain strings, as in a `moved` pair. In message facts they are address objects, which a UI may show.
 */
const collectOpaque = (value: unknown, into: Set<string>, opaque = false): void => {
  if (typeof value === 'string') {
    if (opaque) into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectOpaque(item, into, opaque)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) collectOpaque(item, into, OPAQUE.has(key))
  }
}

/** The answer to a sign-in as `entry`. An offline mailbox cannot be signed in to. */
const signInTo = (entry: MailboxEntry): SignInResult =>
  entry.isOffline() ? { ok: false, failure: 'offline' } : { ok: true, session: entry.session }

/** Starts the provider on a new socket at `socketPath`. Rejects if the socket cannot be made. */
export const startSimProvider: StartSimProvider = (socketPath) => {
  const mailboxes = new Map<string, MailboxEntry>()
  const sockets = new Set<Socket>()
  // Pending oauth attempts by url. An attempt ends when it is approved, denied, or its socket closes.
  const attempts = new Map<string, { socket: Socket; id: number }>()
  let issued = 0
  const handedOut = new Set<string>()
  const sessions = new Set<string>()
  let closing: Promise<void> | null = null

  /** Sends a sign-in result and remembers the session string the client will make from it. */
  const sendSignedIn = (socket: Socket, id: number, result: SignInResult): void => {
    // Both clients turn the session into its string this same way, so the leak check knows it.
    if (result.ok) {
      handedOut.add(JSON.stringify(result.session))
      sessions.add(JSON.stringify(result.session))
    }
    send(socket, { id, kind: 'signed-in', result })
  }

  /** Answers one request from a client. */
  const handle = (socket: Socket, request: Request): void => {
    switch (request.op) {
      case 'sign-in-password': {
        const entry = mailboxes.get(request.address)
        // Offline is checked before the password: a provider that cannot be reached cannot judge one.
        const result: SignInResult =
          entry && (entry.isOffline() || entry.password === request.password)
            ? signInTo(entry)
            : { ok: false, failure: 'wrong-password' }
        return sendSignedIn(socket, request.id, result)
      }
      case 'sign-in-oauth': {
        issued += 1
        const url = `sim://sign-in/${issued}`
        attempts.set(url, { socket, id: request.id })
        return send(socket, { id: request.id, kind: 'open-url', url })
      }
      case 'call': {
        const entry = mailboxes.get(request.address)
        const reply = (result: CallResult, damage?: SendDamage) => {
          collectOpaque(result.outcome, handedOut)
          const line = encode({ id: request.id, kind: 'result', result })
          if (damage === undefined) return send(socket, { id: request.id, kind: 'result', result })
          if (damage === 'disconnect') return void socket.destroy()
          // Half the line, then the end of the stream, which flushes what was written first.
          if (damage === 'truncated') return void socket.end(line.slice(0, Math.floor(line.length / 2)))
          socket.write('this is not json\n')
        }
        if (entry) entry.respond(request.call, reply)
        else reply(failedCall(request.call, 'needs-sign-in'))
        return
      }
    }
  }

  /**
   * Ends the oauth attempt behind `url`. An attempt that was cancelled or already
   * finished is left alone. A url this provider never handed out is a scenario bug.
   */
  const finish = (url: string, result: SignInResult): void => {
    const attempt = attempts.get(url)
    if (attempt) {
      attempts.delete(url)
      return sendSignedIn(attempt.socket, attempt.id, result)
    }
    const number = Number(/^sim:\/\/sign-in\/(\d+)$/.exec(url)?.[1])
    if (!(number >= 1 && number <= issued)) throw new Error(`sim provider: no sign-in attempt at ${url}`)
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    const read = lineReader((value) => {
      if (!isRequest(value)) throw new Error(`sim provider: not a request: ${JSON.stringify(value)}`)
      handle(socket, value)
    })
    socket.on('data', (chunk: string) => read(chunk))
    // A client that vanishes shows up as an error and then a close. Only the close matters.
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      for (const [url, attempt] of attempts) if (attempt.socket === socket) attempts.delete(url)
    })
  })

  const provider: SimProvider = {
    socketPath,
    createMailbox: (dialect, seed) => {
      if (mailboxes.has(seed.address)) throw new Error(`sim provider: ${seed.address} already has a mailbox`)
      const entry = createMailboxEntry(dialect, seed)
      mailboxes.set(seed.address, entry)
      return entry.control
    },
    approveSignIn: (url, address) => {
      const entry = mailboxes.get(address)
      if (!entry) throw new Error(`sim provider: cannot approve a sign-in as unknown ${address}`)
      finish(url, signInTo(entry))
    },
    denySignIn: (url) => finish(url, { ok: false, failure: 'denied' }),
    handedOut: () => handedOut,
    sessions: () => sessions,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          rmSync(socketPath, { force: true })
          resolve()
        })
      })
      return closing
    },
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve(provider)
    })
  })
}
