// One core process and the page port it talks through. Main stays a byte pipe: each line
// the core writes goes to the port as a string, and each string from the port goes to the
// core's input as one line. No line is parsed, except one that may be an `open-url` or a
// `your-turn`, which still go to the page, the updates of main's own subscription, and the
// answers to main's own requests.
//
// Main keeps the dock or taskbar badge itself: at start it subscribes to the conversations
// that are the user's turn and unread, and not yet moved to Let go, under a random id the
// page cannot guess, and those updates go to main only.
//
// Main asks the core for an attachment's bytes itself (`attachment`), so the page never holds
// a file or a path, and tells it when the network may be back (`network-back`, network.ts).
// Its requests carry random ids the page cannot guess, and their chunks and responses go to
// main only. A line with any other id goes to the page as before.
//
// Main logs one line per start, stop and exit, with the core's PID (log.ts), so a check can
// confirm that no core outlives the app.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { MessagePortMain } from 'electron'
import type { HostFrame } from '@letterbox/client/message-port'
import type {
  AttachmentError,
  AttachmentFile,
  BlobId,
  ClientMessage,
  CoreMessage,
  RequestId,
  SubscriptionId,
  YourTurn,
} from '@letterbox/protocol'
import type { CoreCommand } from './config.ts'
import { log } from './log.ts'

/** How long the core gets to finish its work after its input closes, before main kills it. */
export const STOP_MS = 3000
/** How many lines of the core's stderr an `ended` frame quotes. */
const TAIL = 6

/**
 * What main's request for an attachment came to: the core's answer, `ended` when the core
 * exited before it answered, or `unwritable` when the bytes could not be written to the file.
 */
export type Fetched =
  | { ok: true; file: AttachmentFile }
  | { ok: false; error: AttachmentError | 'ended' | 'unwritable' }

export type CoreSession = {
  /** Connects the page's end of the pipe. Frames from before the page connected go first. */
  connect(port: MessagePortMain): void
  /**
   * Asks the core for one attachment and writes its bytes to a new file at `path`, readable by
   * this user only, chunk by chunk as they arrive. Resolves once the core answers. The caller
   * removes the file whatever the answer.
   */
  attachment(blobId: BlobId, path: string): Promise<Fetched>
  /** Tells the core the network may be back. Main logs the core's answer. */
  networkBack(): void
  /** Closes the core's input, waits up to STOP_MS for it to finish its work, then kills it by PID. */
  stop(): Promise<void>
}

/** What main does with what the core says to it, besides passing it to the page. */
export type CoreHooks = {
  /** Gets the url of each `open-url`. */
  openUrl(url: string): void
  /** Gets each `your-turn`. */
  yourTurn(event: YourTurn): void
  /** Gets how many conversations are the user's turn and unread, each time that changes. */
  badge(count: number): void
}

/**
 * Starts `command` with piped stdio. Its stderr passes through to main's. `hooks` hear what
 * main acts on; an `open-url` or a `your-turn` line still goes to the page as well.
 */
export function startCore(command: CoreCommand, hooks: CoreHooks): CoreSession {
  // windowsHide: the core is a console program, and Windows would open a console window for it.
  const child = spawn(command.program, command.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const { pid } = child
  const unsent: HostFrame[] = []
  const stderr: string[] = []
  let port: MessagePortMain | undefined
  let stopping = false
  let exited = false
  let toPage = 0
  let fromPage = 0
  /**
   * Main's own attachment requests by id: the file each one writes, how to finish it, and
   * whether a write failed. A failed one stays until its response, so its later chunks are
   * still main's and never reach the page.
   */
  const fetching = new Map<string, { fd: number; done: (fetched: Fetched) => void; failed: boolean }>()
  /** Main's own `network-back` requests the core has not answered yet. */
  const hinting = new Set<string>()

  /** Ends main's request `id` with `fetched`: closes its file and resolves its promise. */
  const finish = (id: string, fetched: Fetched) => {
    const request = fetching.get(id)
    if (!request) return
    fetching.delete(id)
    closeSync(request.fd)
    request.done(request.failed ? { ok: false, error: 'unwritable' } : fetched)
  }

  /** Takes a line that answers one of main's own requests, and says whether it did. */
  const ownLine = (line: string): boolean => {
    // serde writes `kind` first and `id` next, so only these lines can be main's.
    if (!line.startsWith('{"kind":"chunk","id":"shell-') && !line.startsWith('{"kind":"response","id":"shell-'))
      return false
    // The core writes only protocol messages, which the scenarios check against the schema.
    const message: CoreMessage = JSON.parse(line)
    if (message.kind === 'response' && hinting.delete(message.id)) {
      log('the core heard that the network may be back')
      return true
    }
    const request = (message.kind === 'chunk' || message.kind === 'response') && fetching.get(message.id)
    if (!request) return false
    if (message.kind === 'chunk') write(request, message.data)
    else if (message.kind === 'response' && message.method === 'attachment')
      finish(message.id, message.ok ? { ok: true, file: message.result } : { ok: false, error: message.error })
    return true
  }

  const post = (frame: HostFrame) => (port ? port.postMessage(frame) : unsent.push(frame))

  // 'close' comes after the last stdout line, so the page reads every line before the end.
  const closed = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      log(`core could not start: ${error.message}`)
      stderr.push(`could not start ${command.program}: ${error.message}`)
    })
    child.on('close', (code, signal) => {
      log(`core ${pid ?? '-'} exited (${signal ?? `code ${code}`}); ${toPage} lines to the page, ${fromPage} from it`)
      exited = true
      for (const id of fetching.keys()) finish(id, { ok: false, error: 'ended' })
      if (!stopping) post({ ended: endReason(code, signal, stderr) })
      resolve()
    })
  })
  if (pid !== undefined) log(`core ${pid} started: ${command.program}`)

  // serde writes `kind` first and `sub` next, so only a line with this start can be the badge's.
  const badgeLine = `{"kind":"update","sub":"shell-badge-`
  const badge = `shell-badge-${randomUUID()}` as SubscriptionId
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (ownLine(line)) return
    if (line.startsWith(badgeLine)) {
      const total = badgeIn(line, badge)
      if (total !== undefined) return hooks.badge(total)
    }
    toPage += 1
    post(line)
    const url = line.includes('"open-url"') ? openUrlIn(line) : undefined
    if (url !== undefined) hooks.openUrl(url)
    const yourTurn = line.startsWith('{"kind":"your-turn"') ? yourTurnIn(line) : undefined
    if (yourTurn !== undefined) hooks.yourTurn(yourTurn)
  })
  // One row is enough: the badge reads only the total. Conversations old enough to have
  // moved to Let go are left out, as People leaves them out.
  const subscribe: ClientMessage = {
    kind: 'subscribe',
    sub: badge,
    query: { view: 'threads', filter: { turn: 'mine', unread: true, retired: false }, offset: 0, limit: 1 },
  }
  child.stdin.write(`${JSON.stringify(subscribe)}\n`)
  createInterface({ input: child.stderr }).on('line', (line) => {
    process.stderr.write(`${line}\n`)
    stderr.push(line)
    if (stderr.length > TAIL) stderr.shift()
  })
  // A write after the core died fails here. Its exit is what the page hears about.
  child.stdin.on('error', () => {})

  return {
    connect: (given) => {
      port = given
      given.on('message', (event) => {
        if (typeof event.data !== 'string' || !child.stdin.writable) return
        fromPage += 1
        child.stdin.write(`${event.data}\n`)
      })
      given.start()
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a MessagePort has no origin to name; only window.postMessage takes one
      for (const frame of unsent.splice(0)) given.postMessage(frame)
    },
    attachment: (blobId, path) => {
      if (exited || !child.stdin.writable) return Promise.resolve({ ok: false, error: 'ended' })
      const id = `shell-${randomUUID()}` as RequestId
      // 'wx' refuses a file that is already there, and 0o600 keeps it this user's, never executable.
      const fd = openSync(path, 'wx', 0o600)
      const asked = new Promise<Fetched>((done) => fetching.set(id, { fd, done, failed: false }))
      const request: ClientMessage = { kind: 'request', id, request: { method: 'attachment', blobId } }
      child.stdin.write(`${JSON.stringify(request)}\n`)
      return asked
    },
    networkBack: () => {
      if (exited || !child.stdin.writable) return
      const id = `shell-${randomUUID()}` as RequestId
      hinting.add(id)
      const request: ClientMessage = { kind: 'request', id, request: { method: 'network-back' } }
      child.stdin.write(`${JSON.stringify(request)}\n`)
    },
    stop: async () => {
      const gone = exited
      stopping = true
      child.stdin.end()
      let killed = false
      const timer = setTimeout(() => {
        killed = true
        if (pid !== undefined) kill(pid)
      }, STOP_MS)
      await closed
      clearTimeout(timer)
      port?.close()
      const how = gone ? 'had already exited' : killed ? `killed after ${STOP_MS} ms` : 'finished its work'
      log(`core ${pid ?? '-'} stopped: ${how}`)
    },
  }
}

/** Writes one chunk of main's request to its file. A full disk fails the request, not main. */
function write(request: { fd: number; failed: boolean }, data: string) {
  if (request.failed) return
  try {
    writeSync(request.fd, Buffer.from(data, 'base64'))
  } catch (error) {
    log(`could not write an attachment: ${String(error)}`)
    request.failed = true
  }
}

/**
 * Kills our core by the PID we captured. It may have exited a moment ago, which is what we
 * wanted. On Windows, which has no signals, Node ends it with exit code 1.
 */
function kill(pid: number) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** The url of an `open-url` message, or undefined if `line` is another message. */
function openUrlIn(line: string): string | undefined {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (typeof message !== 'object' || message === null || !('kind' in message) || message.kind !== 'open-url') return
  return 'url' in message && typeof message.url === 'string' ? message.url : undefined
}

/** The core writes only protocol messages, which the scenarios check against the schema. */
const read = (line: string): CoreMessage => JSON.parse(line)

/** How many conversations an update of main's badge subscription `sub` counts, or undefined for another line. */
function badgeIn(line: string, sub: SubscriptionId): number | undefined {
  const message = read(line)
  return message.kind === 'update' && message.sub === sub && message.view === 'threads' ? message.data.total : undefined
}

/** The event of a `your-turn` line, or undefined for another line. */
function yourTurnIn(line: string): YourTurn | undefined {
  const message = read(line)
  return message.kind === 'your-turn' ? message : undefined
}

/** What the page shows when its core exits on its own. The page adds its own full stop. */
function endReason(code: number | null, signal: string | null, stderr: string[]) {
  const how = signal === null ? `with code ${code}` : `on ${signal}`
  const said = stderr.length > 0 ? ` (its stderr ended with: ${stderr.join(' / ')})` : ''
  return `the core exited ${how}${said}`
}
