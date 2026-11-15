// How a scenario is written and run. A scenario starts a sim provider and a
// real core process, acts as the UI and as "another device", and checks what
// the core says. Every run writes a transcript of each message to
// artifacts/scenarios/, so a person can read what happened.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Dialect, SimMailbox, SimProvider, Seed } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Options } from '@letterbox/client'
import { type CoreClient, startCore, type TranscriptEntry } from './client.ts'
import { type Edge, leaks, lifecycle } from './invariants.ts'

export type Scenario = {
  dialect: Dialect
  provider: SimProvider
  /** Creates a mailbox at the provider. What the scenario does to it is written to the transcript. */
  mailbox(seed: Seed): SimMailbox
  /** Starts the core. Call `stop` on it and call this again to restart over the same store. */
  startCore(): CoreClient
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
  const transcript: TranscriptEntry[] = []
  const record = (entry: TranscriptEntry) => void transcript.push(entry)
  const provider = await startSimProvider(join(folder, 'provider.sock'))
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
      const core = startCore(join(folder, 'data'), provider.socketPath, record, newId)
      cores.push(core)
      return core
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
    rmSync(folder, { recursive: true, force: true })
  }

  // Rules every run keeps, whatever the scenario checked.
  const cycle = lifecycle(transcript)
  const broken = [
    ...cores.flatMap((core) => core.violations()),
    ...leaks(transcript, new Set([...provider.handedOut(), ...passwords])),
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
