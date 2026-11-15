// How a scenario is written and run. A scenario starts a sim provider and a
// real core process, acts as the UI and as "another device", and checks what
// the core says. Every run writes a transcript of each message to
// artifacts/scenarios/, so a person can read what happened.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Dialect, SimMailbox, SimProvider, Seed } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Options } from '@letterbox/client'
import { type CoreClient, startCore, type TranscriptEntry } from './client.ts'
import { type Edge, leaks, lifecycle, SIM_KEYCHAIN, storeLeaks } from './invariants.ts'

export type Scenario = {
  dialect: Dialect
  provider: SimProvider
  /** Creates a mailbox at the provider. What the scenario does to it is written to the transcript. */
  mailbox(seed: Seed): SimMailbox
  /** Starts the core. Call `stop` on it and call this again to restart over the same store. */
  startCore(): CoreClient
  /** The account ids core-sim's stand-in keychain holds a session for, in order. */
  keychain(): string[]
  /** Locks or unlocks core-sim's stand-in keychain. While locked, every call to it fails, and what it held is kept for the unlock. */
  lockKeychain(locked: boolean): void
  /** Fails the scenario unless `ok` is true. `what` says what should hold. */
  check(ok: boolean, what: string): void
  /** Fails the scenario unless the two values are deeply equal. */
  equal<Value>(actual: Value, expected: Value, what: string): void
  note(text: string): void
}

type Definition = { name: string; dialects: Dialect[]; run: (t: Scenario) => Promise<void> }

export const definitions: Definition[] = []

/** Registers a scenario. It runs once per dialect unless `only` narrows it. */
export function scenario(name: string, run: (t: Scenario) => Promise<void>, only?: Dialect[]) {
  definitions.push({ name, dialects: only ?? ['labels', 'folders'], run })
}

export type Result = { name: string; dialect: Dialect; passed: boolean; failure: string | null; edges: Edge[] }

/**
 * Where transcripts go. LETTERBOX_ARTIFACTS moves them, so the break test can run
 * scenarios on broken code without writing over the transcripts of the real run.
 */
export const ARTIFACTS = process.env['LETTERBOX_ARTIFACTS'] ?? join(process.cwd(), 'artifacts', 'scenarios')

/** Wraps a mailbox so every call a scenario makes on it lands in the transcript. */
const recorded = (mailbox: SimMailbox, record: (entry: TranscriptEntry) => void): SimMailbox =>
  new Proxy(mailbox, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || property === 'truth' || property === 'calls') return value
      return (...args: unknown[]) => {
        record({ from: 'provider', did: `${target.address} ${String(property)}`, with: args })
        return Reflect.apply(value, target, args)
      }
    },
  })

/** Runs one scenario against one dialect and writes its transcript. */
export async function runOne(definition: Definition, dialect: Dialect): Promise<Result> {
  const folder = mkdtempSync(join(tmpdir(), 'letterbox-'))
  const data = join(folder, 'data')
  const transcript: TranscriptEntry[] = []
  const provider = await startSimProvider(join(folder, 'provider.sock'))
  // The store is scanned after every core message, not only at the end: SQLite's checkpoint
  // at close can overwrite a page that once held a session. Each commit that matters is
  // followed by a message, so the scan sees its write in the WAL.
  const leftInStore = new Set<string>()
  const scanStore = () => {
    for (const leak of storeLeaks(data, provider.sessions())) leftInStore.add(leak)
  }
  const record = (entry: TranscriptEntry) => {
    transcript.push(entry)
    if (entry.from === 'core') scanStore()
  }
  const cores: CoreClient[] = []
  const passwords: string[] = []
  let failure: string | null = null

  // One count for the whole run, across core restarts: the core keeps every change id it
  // has seen, so a restarted core must never be sent an id from before. Counting keeps
  // transcripts the same from run to run.
  let ids = 0
  const newId: Options['newId'] = (kind) => `${kind}_${++ids}`

  const t: Scenario = {
    dialect,
    provider,
    mailbox: (seed) => {
      passwords.push(seed.password)
      return recorded(provider.createMailbox(dialect, seed), record)
    },
    startCore: () => {
      record({ from: 'scenario', note: 'core starts' })
      const core = startCore(data, provider.socketPath, record, newId)
      cores.push(core)
      return core
    },
    keychain: () => {
      const path = join(data, SIM_KEYCHAIN)
      const entries: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
      return typeof entries === 'object' && entries !== null ? Object.keys(entries).toSorted() : []
    },
    lockKeychain: (locked) => {
      // A folder where the file should be makes every read and write of it fail.
      const path = join(data, SIM_KEYCHAIN)
      const kept = join(folder, 'keychain-while-locked')
      if (locked) {
        if (existsSync(path)) renameSync(path, kept)
        mkdirSync(path, { recursive: true })
      } else {
        rmSync(path, { recursive: true, force: true })
        if (existsSync(kept)) renameSync(kept, path)
      }
      record({ from: 'scenario', note: `the keychain is ${locked ? 'locked' : 'unlocked'}` })
    },
    check: (ok, what) => {
      record({ from: 'scenario', note: `${ok ? 'ok' : 'FAILED'}: ${what}` })
      if (!ok) throw new Error(what)
    },
    equal: (actual, expected, what) => {
      const ok = isDeepStrictEqual(actual, expected)
      record({ from: 'scenario', note: `${ok ? 'ok' : 'FAILED'}: ${what}` })
      if (!ok) throw new Error(`${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
    },
    note: (text) => record({ from: 'scenario', note: text }),
  }

  try {
    await definition.run(t)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    record({ from: 'scenario', note: `scenario failed: ${failure}` })
  } finally {
    await Promise.all(cores.map((core) => core.stop().catch(() => undefined)))
    await provider.close()
    // Once more before the folder goes, after every core has written its last.
    scanStore()
    rmSync(folder, { recursive: true, force: true })
  }

  // Rules every run keeps, whatever the scenario checked.
  const cycle = lifecycle(transcript)
  const broken = [
    ...cores.flatMap((core) => core.violations()),
    ...leaks(transcript, new Set([...provider.handedOut(), ...passwords])),
    ...[...leftInStore].toSorted(),
    ...cycle.problems,
  ]
  if (broken.length > 0) {
    record({ from: 'scenario', note: `the run broke a protocol rule:\n${broken.join('\n')}` })
    failure = [failure, ...broken].filter((line) => line !== null).join('\n')
  }

  mkdirSync(ARTIFACTS, { recursive: true })
  const lines = transcript.map((entry) => JSON.stringify(entry)).join('\n')
  writeFileSync(join(ARTIFACTS, `${definition.name}.${dialect}.jsonl`), `${lines}\n`)
  return { name: definition.name, dialect, passed: failure === null, failure, edges: cycle.edges }
}
