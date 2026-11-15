// The core process as a scenario drives it: core-sim behind the shared client from
// @letterbox/client. This file adds only what a test needs. It checks every core
// message against the protocol, records a transcript, hands the client one message per
// turn of the event loop, puts a time limit on every wait, and starts and stops the
// process. It speaks only the protocol, so it would drive a core written in any
// language the same way.

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { type Client, createClient, type Listener, type Subscription } from '@letterbox/client'
import type { CoreMessage } from '@letterbox/protocol'
import { coreMessageProblem } from '@letterbox/protocol/parse'

export type { Subscription }

/** One line of a scenario's transcript. */
export type TranscriptEntry =
  | { from: 'ui'; message: unknown }
  | { from: 'core'; message: CoreMessage }
  | { from: 'provider'; did: string; with: unknown[] }
  | { from: 'scenario'; note: string }

/** The shared client, where every wait fails after WAIT_MS, plus what only a test does to a core. */
export type CoreClient = Client & {
  /** Resolves once the core has read the end of its input, after `stop` closes it. */
  inputClosed(): Promise<void>
  /** Sends anything at all, for scenarios about bad input. */
  sendRaw(value: unknown): void
  /** Closes the core's input and waits for the process to end. Rejects if it has not ended within the usual wait. */
  stop(): Promise<void>
  /** Every message the core sent that broke the protocol's shapes. A scenario fails if there is one. */
  violations(): string[]
}

/** The core program the scenarios run: crates/sim-client/src/main.rs, built by `buildCore`. */
const CORE_PROGRAM = fileURLToPath(new URL('../../../target/debug/core-sim', import.meta.url))

/**
 * How long any wait in a scenario may take. A UI waits as long as the core takes, so the
 * limit lives here and not in @letterbox/client: a scenario must fail, not hang.
 */
const WAIT_MS = 5000

/** The line core-sim writes to stderr once its input closes. crates/sim-client/src/main.rs writes it. */
const INPUT_CLOSED = 'core-sim: input closed, finishing the work in flight'

/** The exit code of a scenario run whose core did not build. The break test tells it apart from a failed scenario. */
export const CORE_DID_NOT_BUILD = 2

/** Builds the core program from the current source. Returns false, after cargo has printed why, if it does not build. */
export function buildCore(): boolean {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  return spawnSync('cargo', ['build', '--quiet', '--bin', 'core-sim'], { cwd: root, stdio: 'inherit' }).status === 0
}

/** Rejects with a timeout unless `promise` settles within WAIT_MS. `what` names what was awaited. */
const within = <T>(what: string, promise: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`)), WAIT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/** Starts a core process over `dataDir` that reaches the sim provider at `socketPath`. */
export function startCore(dataDir: string, socketPath: string, record: (entry: TranscriptEntry) => void): CoreClient {
  const child = spawn(CORE_PROGRAM, ['--data', dataDir, '--sim', socketPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  const onStderr: (() => void)[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    for (const check of onStderr.splice(0)) check()
  })

  const sendRaw = (value: unknown) => {
    record({ from: 'ui', message: value })
    child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`)
  }
  let listener: Listener | undefined
  const client = createClient({ send: sendRaw, listen: (given) => void (listener = given) })
  const violations: string[] = []

  /** Handles one line from the core: checks it against the protocol, hands it to the client, and records it. */
  const handle = (line: string) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      value = undefined
    }
    const problem = value === undefined ? 'it is not JSON' : coreMessageProblem(value)
    if (problem !== null) {
      const violation = `the core sent a message outside the protocol (${problem}): ${line}`
      violations.push(violation)
      record({ from: 'scenario', note: violation })
      return listener?.end(new Error(violation))
    }
    // coreMessageProblem accepted every field, so this value is a CoreMessage.
    const message = value as CoreMessage
    // An update the client dropped is not recorded. Whether one arrives after its
    // subscription closed depends on timing between the two processes.
    if (listener?.receive(message)) record({ from: 'core', message })
  }

  // Lines are handled one per turn of the event loop. The scenario code that was
  // waiting for a line then runs before the next line is recorded, however the
  // lines happened to arrive. That keeps a transcript the same from run to run.
  const arrived: string[] = []
  let draining = false
  const drain = () => {
    const line = arrived.shift()
    if (line === undefined) return void (draining = false)
    handle(line)
    setImmediate(drain)
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    arrived.push(line)
    if (draining) return
    draining = true
    setImmediate(drain)
  })
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      const finish = () => {
        if (draining) return void setImmediate(finish)
        listener?.end(new Error(`the core exited with code ${code}. stderr:\n${stderr}`))
        resolve()
      }
      finish()
    })
  })

  return {
    hello: () => within('a welcome message', client.hello()),
    subscribe: (query) => {
      const subscription = client.subscribe(query)
      return { ...subscription, next: () => within(`an update to ${query.view}`, subscription.next()) }
    },
    query: (query) => within(`an update to ${query.view}`, client.query(query)),
    command: (command, change) => within(`an answer to ${command.kind}`, client.command(command, change)),
    settled: (change) => within(`settled for ${change}`, client.settled(change)),
    request: (request) => within(`the response to ${request.method}`, client.request(request)),
    begin: (request) => {
      const started = client.begin(request)
      return { id: started.id, done: within(`the response to ${request.method}`, started.done) }
    },
    take: (kind) => within(`a ${kind} message`, client.take(kind)),
    sendRaw,
    violations: () => [...violations],
    inputClosed: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out after ${WAIT_MS} ms waiting for the core to read the end of its input`)),
          WAIT_MS,
        )
        const check = () => {
          if (!stderr.includes(INPUT_CLOSED)) return void onStderr.push(check)
          clearTimeout(timer)
          resolve()
        }
        check()
      }),
    stop: async () => {
      child.stdin.end()
      // A core that never exits would hang the whole run. It gets as long as any answer does.
      let killed = false
      const timer = setTimeout(() => {
        killed = true
        child.kill()
      }, WAIT_MS)
      await exited
      clearTimeout(timer)
      if (killed) throw new Error(`the core did not exit within ${WAIT_MS} ms of its input closing`)
    },
  }
}
