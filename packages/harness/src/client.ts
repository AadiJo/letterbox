// The core process as a scenario drives it: core-sim behind the shared client from
// @letterbox/client. This file adds only what a test needs. It checks every core
// message against the protocol, records a transcript, hands the client one message per
// turn of the event loop, puts a time limit on every wait, and starts and stops the
// process. It speaks only the protocol, so it would drive a core written in any
// language the same way.

import { spawn, spawnSync } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createClient, type KeepingClient, type Listener, type Options, type Subscription } from '@letterbox/client'
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
export type CoreClient = KeepingClient & {
  /** Resolves once the core has read the end of its input, after `stop` closes it. */
  inputClosed(): Promise<void>
  /** Resolves once a gmail adapter is holding a rate-limit wait (HELD_WAIT in core-sim). */
  waitHeld(): Promise<void>
  /** Resolves with the first `count` gmail rate-limit waits this core began, in seconds, in order. */
  waits(count: number): Promise<number[]>
  /**
   * Moves the core's fixed clock forward by `seconds`. Only the core's idle waits, such as its
   * sync schedule's, see it: each ends once the clock has moved by its length since it began, so
   * zero ends those due at once (see crates/sim-client/src/main.rs). Wait on `idleWaits` or on
   * what the core sends, never on time, for what it starts.
   */
  advanceClock(seconds: number): void
  /**
   * Resolves with the first `count` idle waits this core began, in seconds, in order. The
   * schedule begins its next wait once its pull has ended, so this is how a scenario knows it has.
   */
  idleWaits(count: number): Promise<number[]>
  /** Resolves with how far, in seconds, the scenario had moved the clock as each of the first `count` idle waits began. */
  idleWaitStarts(count: number): Promise<number[]>
  /**
   * Resolves once the sync schedule has noted `count` decisions of kind `what` (`Noted` in
   * crates/core/src/clock.rs): a pull queued, or a network-back hint ignored. A clock
   * move and a hint each reach the schedule apart from the protocol's order, so this, not a
   * round trip, says the schedule has acted on one.
   */
  noted(what: 'pull-queued' | 'hint-ignored', count: number): Promise<void>
  /** The process's exit code once it has exited on its own, else null. */
  exitCode(): number | null
  /** Everything the process wrote to stderr so far. */
  log(): string
  /** Sends anything at all, for scenarios about bad input. */
  sendRaw(value: unknown): void
  /** Closes the core's input and waits for the process to end. Rejects if it has not ended within the usual wait. */
  stop(): Promise<void>
  /** Ends the process at once, as a crash or a power cut would, and waits for it to be gone. */
  kill(): Promise<void>
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

/** The line core-sim writes to stderr once its input closes. crates/host writes it, named for core-sim. */
const INPUT_CLOSED = 'core-sim: input closed, finishing the work in flight'
/** The line core-sim writes to stderr when a gmail rate-limit wait starts to hold. */
const WAIT_HELD = 'core-sim: holding a gmail rate-limit wait until the adapter closes'
/** The line core-sim writes to stderr as each gmail rate-limit wait begins, with its length. */
const WAIT_BEGUN = /core-sim: gmail rate-limit wait of (\d+) ms\n/g
/** The line core-sim writes to stderr before the name of each decision the sync schedule makes. */
const SCHEDULE_NOTED = 'core-sim: schedule noted'
/** The line core-sim writes to stderr as each idle wait begins, with its length and the clock's moves by then. */
const IDLE_BEGUN = /core-sim: idle wait of (\d+) ms, after (\d+) ms of moves\n/g

/** The exit code of a scenario run whose core did not build. The break test tells it apart from a failed scenario. */
export const CORE_DID_NOT_BUILD = 2
/**
 * The exit code of a scenario run whose core build broke for a reason that is not the source:
 * the compiler was killed, as the out-of-memory killer does, or cargo failed some other way. The
 * break test reports it as the machine's failure, not the break's.
 */
export const BUILD_BROKE = 3
/**
 * The exit code of a scenario run whose every failure was a tool's, outside the system the
 * scenarios check (`ToolFailure` in scenario.ts), such as a browser that would not launch. The
 * break test reports it as the machine's failure, not a caught break.
 */
export const TOOL_FAILED = 4

/** How a build of the core ended. `why` says, in a few words, what broke a build that is not the source's fault. */
export type Build = { kind: 'built' } | { kind: 'does-not-compile' } | { kind: 'broke'; why: string }

/**
 * Builds the core program from the current source. Cargo's own output goes to stderr as it
 * would. The result says whether the source failed to compile, or the build broke for another
 * reason, such as the compiler being killed by a signal.
 */
export function buildCore(): Build {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const build = spawnSync('cargo', ['build', '--quiet', '--bin', 'core-sim'], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'pipe'],
    encoding: 'utf8',
  })
  process.stderr.write(build.stderr ?? '')
  if (build.status === 0) return { kind: 'built' }
  if (build.signal) return { kind: 'broke', why: `cargo was killed (${build.signal})` }
  // Cargo names the signal that ended a compiler or linker: "(signal: 9, SIGKILL: kill)".
  const killed = /\(signal: (\d+), (SIG[A-Z]+)/.exec(build.stderr) ?? /terminated with signal (\d+)/.exec(build.stderr)
  if (killed) return { kind: 'broke', why: `the build was killed (signal ${killed.slice(1).join(', ')})` }
  // Rustc's own errors end with this line. Anything else is not the source's fault.
  if (/could not compile `[^`]+` .*due to \d+ previous errors?/.test(build.stderr)) return { kind: 'does-not-compile' }
  const first = build.stderr.split('\n').find((line) => line.startsWith('error')) ?? `cargo exited with ${build.status}`
  return { kind: 'broke', why: `the build failed for another reason: ${first}` }
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

/** Starts a core process over `dataDir`. `providerArgs` say which provider it reaches: `--sim` or `--gmail`. */
/**
 * Starts a core process over `dataDir`. `providerArgs` say which provider it reaches: `--sim` or `--gmail`.
 * `clockSocket` is a path where nothing is yet, for core-sim's `--clock` (see `advanceClock`).
 * `reachable`, when given, resolves once the provider can take connections. Each line to the core
 * waits for it, so the core never reaches for a provider a scenario has just brought back online
 * before it listens again (see `listenWhileReachable` in the fake Gmail).
 */
export function startCore(
  dataDir: string,
  providerArgs: string[],
  clockSocket: string,
  record: (entry: TranscriptEntry) => void,
  newId: Options['newId'],
  reachable?: () => Promise<void>,
): CoreClient {
  const child = spawn(CORE_PROGRAM, ['--data', dataDir, '--clock', clockSocket, ...providerArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  const onStderr: (() => void)[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    for (const check of onStderr.splice(0)) check()
  })

  /** Resolves once `ready` holds for what is on stderr. `what` names it in the timeout. */
  const untilStderr = (ready: () => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`)), WAIT_MS)
      const check = () => {
        if (!ready()) return void onStderr.push(check)
        clearTimeout(timer)
        resolve()
      }
      check()
    })
  const waitsBegun = () => [...stderr.matchAll(WAIT_BEGUN)].map((match) => Number(match[1]) / 1000)
  const idleBegun = () => [...stderr.matchAll(IDLE_BEGUN)].map((match) => Number(match[1]) / 1000)
  const idleStarts = () => [...stderr.matchAll(IDLE_BEGUN)].map((match) => Number(match[2]) / 1000)
  // Connected on the first move. core-sim binds the socket before it reads its input, so it
  // is there by the time the core has answered anything.
  let clock: Socket | undefined

  // Lines to the core, in order. Each waits for `reachable` before it is written.
  let written: Promise<void> = Promise.resolve()
  const write = (act: () => void) => {
    if (!reachable) return act()
    written = written.then(reachable).then(act)
  }
  const sendRaw = (value: unknown) => {
    record({ from: 'ui', message: value })
    const line = `${typeof value === 'string' ? value : JSON.stringify(value)}\n`
    write(() => void child.stdin.write(line))
  }
  let listener: Listener | undefined
  // Held messages serve `take` and `settled`.
  const client = createClient(
    { send: sendRaw, listen: (given) => void (listener = given) },
    { newId, unclaimed: 'keep' },
  )
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
      clock?.destroy()
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
      const done = within(`the response to ${request.method}`, started.done)
      // A scenario that fails before it awaits `done` must fail as itself, not end the whole run
      // with an unhandled rejection when the wait times out later. Awaiting `done` still throws.
      done.catch(() => undefined)
      return { id: started.id, done }
    },
    take: (kind) => within(`a ${kind} message`, client.take(kind)),
    sendRaw,
    violations: () => [...violations],
    inputClosed: () => untilStderr(() => stderr.includes(INPUT_CLOSED), 'the core to read the end of its input'),
    waitHeld: () => untilStderr(() => stderr.includes(WAIT_HELD), 'the gmail adapter to hold a rate-limit wait'),
    waits: async (count) => {
      await untilStderr(() => waitsBegun().length >= count, `${count} gmail rate-limit waits`)
      return waitsBegun().slice(0, count)
    },
    advanceClock: (seconds) => {
      record({ from: 'scenario', note: `the clock moves forward ${seconds} s` })
      write(() => {
        // An error means the core has gone, which the scenario learns from what it waits on.
        clock ??= createConnection(clockSocket).on('error', () => undefined)
        clock.write(`${seconds}\n`)
      })
    },
    idleWaits: async (count) => {
      await untilStderr(() => idleBegun().length >= count, `${count} idle waits`)
      return idleBegun().slice(0, count)
    },
    idleWaitStarts: async (count) => {
      await untilStderr(() => idleStarts().length >= count, `${count} idle waits`)
      return idleStarts().slice(0, count)
    },
    noted: (what, count) => {
      const line = `${SCHEDULE_NOTED} ${what}\n`
      return untilStderr(() => stderr.split(line).length - 1 >= count, `the schedule to note ${what} ${count} times`)
    },
    exitCode: () => child.exitCode,
    log: () => stderr,
    kill: async () => {
      record({ from: 'scenario', note: 'the core is killed' })
      child.kill('SIGKILL')
      await exited
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      write(() => child.stdin.end())
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
