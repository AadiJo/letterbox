// A fake Gmail: the subset of the Gmail REST API (gmail/v1) and of Google's OAuth
// endpoints that crates/gmail uses, served over HTTP on 127.0.0.1.
//
// It lives in the sim provider because it is one: each account is a sim labels
// mailbox (mailbox.ts), the dialect that models Gmail, and this file only translates.
// A scenario drives the mailbox with the same helpers as any other (`deliver`,
// `setFlags`, `move`, `expireCursors`, `setOffline`, `truth`, `calls`). Calls that
// read or change mail go through the mailbox's own `respond`, so holding bodies and
// applies, refusing the next apply, going offline and the call counts all work as
// they do over the sim socket. The counts read in Gmail terms: one snapshot per
// messages.list page, one changes per history.list, one body per format=full get, one raw
// per format=raw get, one attachment per messages.attachments.get (whose ids are "attachment-<n>", by place),
// and one apply per modify or batchModify that changes labels. `setQuota` adds Gmail's
// usage limits (quota.ts). The mailbox's `expirePageTokens` makes messages.list refuse
// every page token it handed out. messages.send goes through the mailbox's `send` (send.ts),
// and a sent reply joins the thread its `threadId` names. Every other message is its own thread.
//
// Offline: while every account at the fake is offline, the fake stops listening, so a new
// connection is refused as it is when the network is down. A client can then tell that its
// request never arrived, which a send needs (adapter rule 10). With other accounts still
// online, a request for an offline one is dropped after it arrives instead.
//
// Where Gmail's behaviour is not documented, the fake picks the strict reading:
//   - messages.list answers a page token it does not accept with the 400 a live call
//     with a made-up token got (https://github.com/brekkylab/backlot/issues/390). Google
//     documents no answer for an expired one, so it gets the same.
//   - batchModify answers 404 and changes nothing if any id is unknown.
//   - modify and batchModify refuse SENT and DRAFT with 400, the labels the
//     labels guide says cannot be applied by hand.
//   - history.list reports a label change as a record with only `messages`, since
//     the labels log keeps which messages changed, not which labels.

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { MessageRef, PageToken } from '../adapter.ts'
import type { Seed, SimMailbox } from '../contract.ts'
import { createMailboxEntry } from '../mailbox.ts'
import type { MailboxEntry } from '../mailbox.ts'
import { damaged, stall } from './answers.ts'
import { ask, modify, parse, strings } from './modify.ts'
import { MODIFY_SCOPE, READONLY_SCOPE, createOauth } from './oauth.ts'
import { type Quota, createQuotas, unitsOf } from './quota.ts'
import { searchMessageId, send as sendMessage } from './send.ts'
import {
  cursorOf,
  fullOf,
  gmailIdOf,
  historyIdOf,
  labelIdsOf,
  labelsOf,
  messageOfId,
  metadataOf,
  minimalOf,
  named,
  refOfId,
} from './shapes.ts'

/** The fake as a scenario drives it. */
export interface GmailFake {
  /** The API root and token endpoint live under this URL. core-sim's `--gmail` takes it. */
  readonly url: string
  /** Makes an account at the fake. It is a labels mailbox, driven like any other. */
  createMailbox(seed: Seed): SimMailbox
  /** Grants the consent request behind `url` as the owner of `address`, and sends the redirect. */
  approveSignIn(url: string, address: string): void
  /** Declines the consent request behind `url`: the redirect carries error=access_denied. */
  denySignIn(url: string): void
  /** Every access token stops working, as if an hour had passed. The next call gets 401. */
  expireAccessTokens(): void
  /** The user removes the app's access to `address`. Every refresh answers invalid_grant. */
  revokeAccess(address: string): void
  /** How many times the token endpoint refreshed an access token for `address`. */
  refreshes(address: string): number
  /** Limits the units `address` may spend per window, or lifts the limit. See quota.ts. */
  setQuota(address: string, quota: Quota | null): void
  /** How many calls the rate limit refused for `address`. */
  refusals(address: string): number
  /**
   * The next API call's answer stalls, a refusal by the quota included: its status line and half
   * its body go out, then nothing more until the fake closes. Lets a scenario check the client
   * gives up on a call that hangs, and what it makes of an answer it never read whole. With
   * `part`, only a call whose path under `users/me/` holds it counts as the next one.
   * With `trickle`, a space follows every half second, so the answer never goes quiet but
   * never ends either.
   */
  stallNextAnswer(part?: string, trickle?: boolean): void
  /**
   * The next API call whose path under `users/me/` holds `part` is not read for `seconds`: its
   * client gets nothing back meanwhile, as one whose upload is slow does.
   */
  slowNextRequest(part: string, seconds: number): void
  /** Resolves once the answer `stallNextAnswer` named has stalled. Rejects if none has within 5 s. */
  answerStalled(): Promise<void>
  /** Every id, history id, page token and token this fake gave the core. None may reach a UI. */
  handedOut(): ReadonlySet<string>
  /** Resolves once the fake takes connections: at once, unless it is listening again after every account was offline. */
  reachable(): Promise<void>
  /** Every refresh and access token this fake issued. None may reach the core's store. */
  secrets(): ReadonlySet<string>
  close(): Promise<void>
}

const STATUS_NAMES: Record<number, [string, string]> = {
  400: ['INVALID_ARGUMENT', 'badRequest'],
  401: ['UNAUTHENTICATED', 'authError'],
  403: ['PERMISSION_DENIED', 'insufficientPermissions'],
  404: ['NOT_FOUND', 'notFound'],
  409: ['ABORTED', 'aborted'],
}

/** What messages.list answered a live call with a page token it did not issue. See the header. */
const INVALID_PAGE_TOKEN = {
  error: {
    code: 400,
    message: 'Invalid pageToken',
    errors: [{ message: 'Invalid pageToken', domain: 'global', reason: 'invalidArgument' }],
    status: 'INVALID_ARGUMENT',
  },
}

/** Writes a JSON answer, or an empty one for 204. */
const send = (response: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) return void response.writeHead(status).end()
  response.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8' }).end(JSON.stringify(body))
}

/** An error in the shape every Gmail endpoint uses. https://developers.google.com/gmail/api/guides/handle-errors */
const fail = (response: ServerResponse, code: number, message: string): void => {
  const [status, reason] = STATUS_NAMES[code] ?? ['UNKNOWN', 'backendError']
  send(response, code, { error: { code, message, status, errors: [{ message, domain: 'global', reason }] } })
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => (text += chunk))
    request.on('end', () => resolve(text))
  })

/**
 * Where a fake's port comes from. The fake closes its port while every account is offline and
 * must get the same one back, since the core holds its URL. A port the OS hands out, for a
 * listen on port 0 or an outgoing connection, comes from 32768 up on Linux and 49152 up on
 * macOS and Windows, so nothing takes a port from this range while it is closed. Only another
 * fake could, and `taken` keeps the fakes in one process apart.
 */
const PORTS = { first: 20000, count: 12768 }
const taken = new Set<number>()

/** Listens on a port from PORTS that no fake in this process holds, trying others while the one picked is in use. */
const listenOnFreePort = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const port = PORTS.first + Math.floor(Math.random() * PORTS.count)
      if (taken.has(port)) return attempt(left)
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE' && left > 0) return attempt(left - 1)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        taken.add(port)
        resolve(port)
      }
      server.once('error', onError).once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }
    attempt(100)
  })

/** Starts the fake on 127.0.0.1 at a free port (see PORTS). `redirects` is the folder core-sim's loopback sockets go in. */
export const startFakeGmail = (redirects: string): Promise<GmailFake> => {
  const mailboxes = new Map<string, MailboxEntry>()
  const handedOut = new Set<string>()
  const remember = (value: string): string => (handedOut.add(value), value)
  const oauth = createOauth(redirects, remember)
  const sockets = new Set<Socket>()
  const quotas = createQuotas()
  // The thread of each sent reply, by account and ref.
  const threads = new Map<string, string>()
  const threadOf = (entry: MailboxEntry, ref: MessageRef): string =>
    threads.get(`${entry.control.address}\n${ref}`) ?? gmailIdOf(ref)

  /** Answers one API call for the account `address`. */
  const api = async (
    entry: MailboxEntry,
    method: string,
    path: string,
    query: URLSearchParams,
    response: ServerResponse,
    body: string,
  ) => {
    const { store } = entry
    const history = () => remember(historyIdOf(entry.cursor()))
    const message = /^messages\/([^/]+)$/.exec(path)?.[1]
    const modified = /^messages\/([^/]+)\/modify$/.exec(path)?.[1]

    if (method === 'GET' && path === 'profile') {
      const total = store.messages.size
      return send(response, 200, {
        emailAddress: entry.control.address,
        messagesTotal: total,
        threadsTotal: total,
        historyId: history(),
      })
    }
    if (method === 'GET' && path === 'labels') {
      const labels = labelsOf(store)
      for (const label of labels) remember(label.id)
      return send(response, 200, { labels })
    }
    const q = query.get('q')
    if (method === 'GET' && path === 'messages' && q !== null) {
      const found = await searchMessageId(entry, q)
      if (found === null) return fail(response, 400, `The fake searches by rfc822msgid: only, not ${q}`)
      if ('status' in found) return fail(response, found.status, found.message)
      const messages = found.map(
        (ref) => (remember(gmailIdOf(ref)), { id: gmailIdOf(ref), threadId: threadOf(entry, ref) }),
      )
      return send(response, 200, { ...(messages.length > 0 ? { messages } : {}), resultSizeEstimate: messages.length })
    }
    if (method === 'POST' && path === 'messages/send') {
      const hasThread = (id: string) =>
        [...store.messages.values()].some((stored) => threadOf(entry, stored.ref) === id)
      const sent = await sendMessage(entry, parse(body), hasThread)
      if (sent === 'dropped') return void response.socket?.destroy()
      if ('status' in sent) return fail(response, sent.status, sent.message)
      if (sent.threadId !== null) threads.set(`${entry.control.address}\n${sent.ref}`, sent.threadId)
      const id = remember(gmailIdOf(sent.ref))
      const answer = { id, threadId: threadOf(entry, sent.ref), labelIds: ['SENT'] }
      if (sent.damage === null) return send(response, 200, answer)
      return damaged(response, JSON.stringify(answer), sent.damage)
    }
    if (method === 'GET' && path === 'messages') {
      const result = await ask(entry, { method: 'snapshot', arg: query.get('pageToken') as PageToken | null })
      if (result.method !== 'snapshot') return fail(response, 503, 'Backend error')
      // A page held until the mailbox went offline gets no answer, like any call to it then.
      if (!result.outcome.ok && result.outcome.failure === 'offline') return void response.socket?.destroy()
      // Else the mailbox could not read the token, or it expired.
      if (!result.outcome.ok) return send(response, 400, INVALID_PAGE_TOKEN)
      const page = result.outcome
      // messages.list leaves out spam and trash unless asked.
      const listed = page.messages.filter((item) => {
        if (query.get('includeSpamTrash') === 'true') return true
        const stored = [...store.messages.values()].find((candidate) => candidate.ref === item.ref)
        return !stored || !labelIdsOf(store, stored).some((id) => id === 'TRASH' || id === 'SPAM')
      })
      const messages = listed.map((item) => (remember(gmailIdOf(item.ref)), named(item.ref)))
      return send(response, 200, {
        ...(messages.length > 0 ? { messages } : {}),
        ...(page.next === null ? {} : { nextPageToken: remember(page.next) }),
        resultSizeEstimate: messages.length,
      })
    }
    const attached = /^messages\/([^/]+)\/attachments\/attachment-(\d+)$/.exec(path)
    if (method === 'GET' && attached !== null) {
      const ref = refOfId(attached[1] ?? '')
      if (ref === null) return fail(response, 404, 'Requested entity was not found.')
      const arg = { ref, index: Number(attached[2]) - 1 }
      const result = await ask(entry, { method: 'attachment', arg })
      if (result.method !== 'attachment') return fail(response, 503, 'Backend error')
      if (!result.outcome.ok && result.outcome.failure === 'offline') return void response.socket?.destroy()
      if (!result.outcome.ok) return fail(response, 503, 'Backend error')
      if (result.outcome.kind === 'gone') return fail(response, 404, 'Requested entity was not found.')
      const content = Buffer.from(result.outcome.base64, 'base64')
      return send(response, 200, { size: content.length, data: content.toString('base64url') })
    }
    if (method === 'GET' && message !== undefined) {
      const format = query.get('format') ?? 'full'
      const ref = refOfId(message)
      if (format === 'raw' && ref !== null) {
        // Through the mailbox, so it is counted as the sim's `raw` call.
        const result = await ask(entry, { method: 'raw', arg: ref })
        if (result.method !== 'raw' || !result.outcome.ok) return fail(response, 503, 'Backend error')
        if (result.outcome.kind === 'gone') return fail(response, 404, 'Requested entity was not found.')
        const raw = Buffer.from(result.outcome.base64, 'base64').toString('base64url')
        return send(response, 200, { id: message, threadId: threadOf(entry, ref), raw })
      }
      if (format === 'full' && ref !== null) {
        // Through the mailbox, so a body call is counted and can be held, even for a message deleted since.
        const result = await ask(entry, { method: 'body', arg: ref })
        if (result.method !== 'body' || !result.outcome.ok) return fail(response, 503, 'Backend error')
        const stored = messageOfId(store, message)
        if (result.outcome.kind === 'gone' || !stored) return fail(response, 404, 'Requested entity was not found.')
        const full = fullOf(store, stored, history(), result.outcome.body)
        return send(response, 200, { ...full, threadId: threadOf(entry, stored.ref) })
      }
      const stored = messageOfId(store, message)
      if (!stored) return fail(response, 404, 'Requested entity was not found.')
      const threadId = threadOf(entry, stored.ref)
      if (format === 'minimal') return send(response, 200, { ...minimalOf(store, stored, history()), threadId })
      const metadata = metadataOf(store, stored, history(), query.getAll('metadataHeaders'))
      return send(response, 200, { ...metadata, threadId })
    }
    if (method === 'GET' && path === 'history') {
      const cursor = cursorOf(query.get('startHistoryId') ?? '')
      if (cursor === null) return fail(response, 400, 'Invalid startHistoryId')
      const result = await ask(entry, { method: 'changes', arg: cursor })
      if (result.method !== 'changes' || !result.outcome.ok) return fail(response, 503, 'Backend error')
      if (result.outcome.kind === 'cursor-expired') return fail(response, 404, 'Requested entity was not found.')
      const { added, updated, removed, cursor: next } = result.outcome
      const historyId = remember(historyIdOf(next))
      const records = [
        ...added.map((item) => {
          const stored = [...store.messages.values()].find((candidate) => candidate.ref === item.ref)
          const labelIds = stored ? labelIdsOf(store, stored) : []
          return {
            id: historyId,
            messages: [named(item.ref)],
            messagesAdded: [{ message: { ...named(item.ref), labelIds } }],
          }
        }),
        ...updated.map((item) => ({ id: historyId, messages: [named(item.ref)] })),
        ...removed.map((ref) => ({
          id: historyId,
          messages: [named(ref)],
          messagesDeleted: [{ message: named(ref) }],
        })),
      ]
      return send(response, 200, { ...(records.length > 0 ? { history: records } : {}), historyId })
    }
    if (method === 'POST' && modified !== undefined) {
      const stored = messageOfId(store, modified)
      if (!stored) return fail(response, 404, 'Requested entity was not found.')
      const done = await modify(entry, [stored.ref], parse(body))
      if ('status' in done) return fail(response, done.status, done.message)
      // A damaged answer to a modify is a connection that drops before any of it: the change is made.
      if (done.damage !== null) return void response.socket?.destroy()
      return send(response, 200, minimalOf(store, stored, history()))
    }
    if (method === 'POST' && path === 'messages/batchModify') {
      const parsed = parse(body)
      const ids = strings(parsed, 'ids')
      if (ids.length === 0 || ids.length > 1000) return fail(response, 400, 'ids must hold 1 to 1000 ids')
      const found = ids.map((id) => messageOfId(store, id))
      if (found.some((stored) => stored === undefined)) return fail(response, 404, 'Requested entity was not found.')
      const done = await modify(
        entry,
        found.flatMap((stored) => (stored ? [stored.ref] : [])),
        parsed,
      )
      if ('status' in done) return fail(response, done.status, done.message)
      if (done.damage !== null) return void response.socket?.destroy()
      return send(response, 204)
    }
    return fail(response, 404, `No such endpoint: ${method} ${path}`)
  }

  // Sockets with a request in flight. Going offline drops only the idle ones.
  const busy = new WeakSet<Socket>()
  let port: number | null = null
  // Listening again resolves the host first, so it finishes on a later tick.
  let listening: Promise<void> = Promise.resolve()
  /** Stops listening while every account is offline, and listens again on the same port once one is back. */
  // Set by `stallNextAnswer`, and cleared by the API call whose answer it stalls. True stalls
  // any call, a string only a call whose path holds it.
  let stallNext: boolean | string = false
  let trickleNext = false
  // Set by `slowNextRequest`, and cleared by the call it slows.
  let slowNext: { part: string; seconds: number } | null = null
  // Told when that call's answer stalls.
  let onStalled: (() => void)[] = []
  let stalls = 0
  const listenWhileReachable = () => {
    const down = mailboxes.size > 0 && [...mailboxes.values()].every((entry) => entry.isOffline())
    if (down && server.listening) {
      server.close()
      for (const socket of sockets) if (!busy.has(socket)) socket.destroy()
    } else if (!down && !server.listening && port !== null && closing === null) {
      const again = port
      listening = new Promise((resolve) => server.listen(again, '127.0.0.1', resolve))
    }
  }

  const server = createServer((request, response) => {
    // Every answer closes its connection, so a client never sends a call on one the fake
    // dropped as it went offline, which could not tell whether the call arrived. Going offline
    // then always fails a new call at connect. The fake closes first, so the client keeps no
    // port waiting after each call.
    response.setHeader('Connection', 'close')
    busy.add(request.socket)
    response.on('close', () => busy.delete(request.socket))
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const slowed = slowNext !== null && url.pathname.includes(slowNext.part) ? slowNext : null
    if (slowed) slowNext = null
    const read = () => readBody(request)
    const reading = slowed ? new Promise<void>((done) => setTimeout(done, slowed.seconds * 1000)).then(read) : read()
    void reading.then(async (body) => {
      if (request.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(body)
        const address = oauth.accountOf(form)
        // A provider that cannot be reached gives no answer at all.
        if (address !== null && mailboxes.get(address)?.isOffline()) return void request.socket.destroy()
        const answer = oauth.token(form)
        return send(response, answer.status, answer.body)
      }
      const path = /^\/gmail\/v1\/users\/me\/(.+)$/.exec(url.pathname)?.[1]
      if (path === undefined) return fail(response, 404, `No such endpoint: ${url.pathname}`)
      const address = oauth.addressOf(request.headers.authorization)
      const entry = address === null ? undefined : mailboxes.get(address)
      if (entry?.isOffline()) return void request.socket.destroy()
      if (!entry) return fail(response, 401, 'Request had invalid authentication credentials.')
      const method = request.method ?? 'GET'
      // Before the quota, so an answer it refuses stalls too.
      if (stallNext === true || (stallNext !== false && path.includes(stallNext))) {
        stallNext = false
        stall(response, trickleNext, () => {
          stalls += 1
          for (const told of onStalled.splice(0)) told()
        })
      }
      const refused = quotas.charge(entry.control.address, unitsOf(method, path, url.searchParams))
      if (refused) {
        const wait = refused.retryAfter === undefined ? {} : { 'Retry-After': String(refused.retryAfter) }
        response.writeHead(refused.status, { 'Content-Type': 'application/json; charset=UTF-8', ...wait })
        return void response.end(JSON.stringify(refused.body))
      }
      await api(entry, method, path, url.searchParams, response, body)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  let closing: Promise<void> | null = null
  const fake = (url: string): GmailFake => ({
    url,
    createMailbox: (seed) => {
      if (mailboxes.has(seed.address)) throw new Error(`fake gmail: ${seed.address} already has a mailbox`)
      const entry = createMailboxEntry('labels', seed)
      mailboxes.set(seed.address, entry)
      const setOffline = (offline: boolean) => {
        entry.control.setOffline(offline)
        listenWhileReachable()
      }
      // A new account is online, so a fake that every account had left listens again.
      listenWhileReachable()
      return { ...entry.control, setOffline }
    },
    approveSignIn: (consent, address) => {
      const entry = mailboxes.get(address)
      if (!entry) throw new Error(`fake gmail: cannot approve a sign-in as unknown ${address}`)
      oauth.approve(consent, address, entry.session.modify ? MODIFY_SCOPE : READONLY_SCOPE)
    },
    denySignIn: (consent) => oauth.deny(consent),
    expireAccessTokens: () => oauth.expireAccessTokens(),
    revokeAccess: (address) => oauth.revoke(address),
    refreshes: (address) => oauth.refreshes(address),
    setQuota: (address, quota) => quotas.set(address, quota),
    refusals: (address) => quotas.refusals(address),
    stallNextAnswer: (part, trickle = false) => {
      stallNext = part ?? true
      trickleNext = trickle
    },
    slowNextRequest: (part, seconds) => {
      slowNext = { part, seconds }
    },
    answerStalled: () =>
      new Promise<void>((resolve, reject) => {
        // At once when the last stall asked for has already happened.
        if (stalls > 0 && stallNext === false) return resolve()
        // A call that never comes must fail the scenario, not hang it.
        const timer = setTimeout(() => reject(new Error('fake gmail: no answer stalled within 5 s')), 5000)
        onStalled.push(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
    handedOut: () => handedOut,
    reachable: () => listening,
    secrets: () => oauth.secrets(),
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          if (port !== null) taken.delete(port)
          resolve()
        })
      })
      return closing
    },
  })

  return listenOnFreePort(server).then((listened) => {
    port = listened
    return fake(`http://127.0.0.1:${listened}`)
  })
}
