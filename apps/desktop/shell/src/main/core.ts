// One core process and the page port it talks through. Main stays a byte pipe: each line
// the core writes goes to the port as a string, and each string from the port goes to the
// core's input as one line. No line is parsed, except one that may be an `open-url`.
//
// Main logs one line per start, stop and exit, with the core's PID (log.ts), so a check can
// confirm that no core outlives the app.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { MessagePortMain } from 'electron'
import type { HostFrame } from '@letterbox/client/message-port'
import type { CoreCommand } from './config.ts'
import { log } from './log.ts'

/** How long the core gets to finish its work after its input closes, before main kills it. */
export const STOP_MS = 3000
/** How many lines of the core's stderr an `ended` frame quotes. */
const TAIL = 6

export type CoreSession = {
  /** Connects the page's end of the pipe. Frames from before the page connected go first. */
  connect(port: MessagePortMain): void
  /** Closes the core's input, waits up to STOP_MS for it to finish its work, then kills it by PID. */
  stop(): Promise<void>
}

/**
 * Starts `command` with piped stdio. Its stderr passes through to main's. `openUrl` gets the
 * url of each `open-url` the core sends; the line still goes to the page as well.
 */
export function startCore(command: CoreCommand, openUrl: (url: string) => void): CoreSession {
  const child = spawn(command.program, command.args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const { pid } = child
  const unsent: HostFrame[] = []
  const stderr: string[] = []
  let port: MessagePortMain | undefined
  let stopping = false
  let exited = false
  let toPage = 0
  let fromPage = 0

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
      if (!stopping) post({ ended: endReason(code, signal, stderr) })
      resolve()
    })
  })
  if (pid !== undefined) log(`core ${pid} started: ${command.program}`)

  createInterface({ input: child.stdout }).on('line', (line) => {
    toPage += 1
    post(line)
    const url = line.includes('"open-url"') ? openUrlIn(line) : undefined
    if (url !== undefined) openUrl(url)
  })
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

/** Kills our core by the PID we captured. It may have exited a moment ago, which is what we wanted. */
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

/** What the page shows when its core exits on its own. The page adds its own full stop. */
function endReason(code: number | null, signal: string | null, stderr: string[]) {
  const how = signal === null ? `with code ${code}` : `on ${signal}`
  const said = stderr.length > 0 ? ` (its stderr ended with: ${stderr.join(' / ')})` : ''
  return `the core exited ${how}${said}`
}
