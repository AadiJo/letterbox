// Every process the dev host starts goes through `startChild`, which keeps its PID until it
// exits. `stopChildren` stops each one still running, by that PID and nothing else.
// Each start and stop is logged, so a check can confirm that nothing outlived the host.

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'

export type Child = ChildProcessByStdio<Writable, Readable, Readable>

const running = new Map<number, Child>()
let logFile: string | undefined

/** Where start and stop lines go: one `started <pid> <program>` or `exited <pid>` per line. */
export const logChildrenTo = (path: string) => {
  logFile = path
}

const log = (line: string) => {
  if (logFile) appendFileSync(logFile, `${line}\n`)
}

/** Signals one of our children. It may have exited a moment ago, which is what we wanted. */
const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone.
  }
}

/** Starts `program` with piped stdio, attached to this process, and tracks it until it exits. */
export function startChild(program: string, args: string[], cwd: string): Child {
  const child = spawn(program, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const { pid } = child
  if (pid === undefined) {
    // Node also emits the reason as an 'error' event. The throw below reports it instead.
    child.on('error', () => {})
    throw new Error(`could not start ${program}. Check that it is installed and on PATH.`)
  }
  running.set(pid, child)
  log(`started ${pid} ${program}`)
  child.on('exit', () => {
    running.delete(pid)
    log(`exited ${pid}`)
  })
  return child
}

/** Resolves once `child` has exited, at once if it already has. */
export const exited = (child: Child) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
  })

/** Sends SIGTERM to every child still running and waits for each to exit. SIGKILL after `graceMs`. */
export async function stopChildren(graceMs = 3000) {
  await Promise.all(
    [...running.entries()].map(async ([pid, child]) => {
      signal(pid, 'SIGTERM')
      const timer = setTimeout(() => signal(pid, 'SIGKILL'), graceMs)
      await exited(child)
      clearTimeout(timer)
    }),
  )
}

/** For a last-chance exit handler, which cannot wait: SIGKILL to every child still running. */
export function killChildrenNow() {
  for (const pid of running.keys()) signal(pid, 'SIGKILL')
}
