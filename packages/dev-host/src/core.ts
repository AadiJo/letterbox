// core-sim as the dev host runs it: built from the current source, started over the dev
// store with a fixed clock, and signed in to the seed's mailbox once before any tab connects.

import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createClient, type Transport } from '@letterbox/client'
import type { CoreMessage } from '@letterbox/protocol'
import { type Child, exited, startChild } from './children.ts'

/** Where the dev host keeps one run's files, all under the worktree's `.letterbox/`. */
export type Paths = {
  root: string
  /** The core's store and its stand-in keychain. */
  data: string
  /** The sim provider's socket: a path, or a named pipe on Windows (localSocket in @letterbox/sim-provider/socket). */
  socket: string
  /** cargo's and every core's stderr. */
  coreLog: string
}

/** A core program cargo built in debug, by its name: core-sim or letterbox-core, with `.exe` on Windows. */
export const coreProgram = (paths: Paths, program: 'core-sim' | 'letterbox-core') =>
  join(paths.root, 'target/debug', process.platform === 'win32' ? `${program}.exe` : program)

/** How long a core gets to finish its work after its input closes, before it is killed. */
const STOP_MS = 3000

/** Builds a core program in debug: core-sim, or the app's letterbox-core. Rejects with cargo's output if it does not build. */
export async function buildCore(paths: Paths, program: 'core-sim' | 'letterbox-core' = 'core-sim') {
  const cargo = startChild('cargo', ['build', '--quiet', '--bin', program], paths.root)
  let output = ''
  cargo.stdout.on('data', (chunk: Buffer) => void (output += chunk.toString()))
  cargo.stderr.on('data', (chunk: Buffer) => void (output += chunk.toString()))
  await exited(cargo)
  if (cargo.exitCode !== 0) throw new Error(`${program} did not build:\n${output}`)
}

export type CoreProcess = {
  /** Sends one line, a JSON protocol message, to the core's input. */
  send(line: string): void
  /** Calls `receive` with each line the core writes, in order. */
  onLine(receive: (line: string) => void): void
  exited: Promise<void>
  /** Closes the core's input, waits for it to finish, and kills it if it takes longer than STOP_MS. */
  stop(): Promise<void>
}

/**
 * Starts core-sim over the dev store at the seed's fixed time, with any `flags` of core-sim's
 * own, such as `--hold-waits`. Its stderr goes to the core log.
 */
export function startCore(paths: Paths, now: string, flags: readonly string[] = []): CoreProcess {
  const program = coreProgram(paths, 'core-sim')
  const args = ['--data', paths.data, '--sim', paths.socket, '--now', now, ...flags]
  const child: Child = startChild(program, args, paths.root)
  child.stderr.pipe(createWriteStream(paths.coreLog, { flags: 'a' }))
  const lines = createInterface({ input: child.stdout })
  const done = exited(child)
  return {
    send: (line) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`)
    },
    onLine: (receive) => void lines.on('line', receive),
    exited: done,
    stop: async () => {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS)
      await done
      clearTimeout(timer)
    },
  }
}

/** The shared client's transport over one core process's stdio. `log` is where its stderr went. */
const stdioTransport = (core: CoreProcess, log: string): Transport => ({
  send: (message) => core.send(JSON.stringify(message)),
  listen: (listener) => {
    core.onLine((line) => {
      // core-sim writes one protocol message per line. The scenarios check its shapes.
      const message: CoreMessage = JSON.parse(line)
      listener.receive(message)
    })
    void core.exited.then(() => listener.end(new Error(`core-sim exited during sign-in. See ${log}.`)))
  },
})

/** Starts a core, signs it in to `address` by password, syncs once, and stops it. The store then holds the mailbox. */
export async function signIn(paths: Paths, now: string, address: string, password: string) {
  const core = startCore(paths, now)
  let ids = 0
  const client = createClient(stdioTransport(core, paths.coreLog), {
    newId: (kind) => `dev-${kind}-${++ids}`,
    unclaimed: () => {},
  })
  try {
    await client.hello()
    const options = await client.query({ view: 'sign-in-options' })
    const option = options.find((candidate) => candidate.method === 'password')
    if (!option) throw new Error('core-sim lists no password sign-in option')
    const signedIn = await client.request({
      method: 'sign-in',
      option: option.id,
      password: { username: address, password },
    })
    if (!signedIn.ok) throw new Error(`sign-in to the sim failed: ${signedIn.error}`)
    const synced = await client.request({ method: 'sync-now' })
    if (!synced.ok) throw new Error(`the first sync failed: ${synced.error}`)
  } finally {
    await core.stop()
  }
}
