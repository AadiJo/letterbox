// How a scenario is written and run. A scenario starts a sim provider and a
// real core process, acts as the UI and as "another device", and checks what
// the core says. Every run writes a transcript of each message to
// artifacts/scenarios/, so a person can read what happened.
//
// Each scenario runs once per dialect, and once more as `gmail` when it runs on labels:
// the core then signs in through the Gmail adapter (crates/gmail) to the fake Gmail
// server, whose accounts are labels mailboxes. The same scenario then checks the Gmail
// adapter's mapping from end to end.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Dialect, SimMailbox, SimProvider, Seed } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import { type GmailFake, startFakeGmail } from '@letterbox/sim-provider/gmail'
import type { Options } from '@letterbox/client'
import { type CoreClient, startCore, type TranscriptEntry } from './client.ts'
import { type Edge, leaks, lifecycle, SIM_KEYCHAIN, storeLeaks } from './invariants.ts'

/** What one run of a scenario talks to: a sim dialect, or the fake Gmail. */
export type Run = Dialect | 'gmail'

export type Scenario = {
  /** The mailbox's dialect. A gmail run's mailbox is a labels mailbox. */
  dialect: Dialect
  /** Finishes oauth sign-ins: the sim provider's, or the fake Gmail's consent page. */
  provider: Pick<SimProvider, 'approveSignIn' | 'denySignIn'>
  /** The fake Gmail in a gmail run, else null. */
  gmail: GmailFake | null
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

type Definition = { name: string; dialects: Run[]; run: (t: Scenario) => Promise<void> }

export const definitions: Definition[] = []

/**
 * Labels scenarios that do not run as gmail, and why. Gmail has no password sign-in.
 */
const NOT_GMAIL = new Set(['a wrong password ends the sign-in with an answer and no account'])

/**
 * Registers a scenario. It runs once per dialect unless `only` narrows it, and as gmail
 * too when it runs on labels, unless NOT_GMAIL names it.
 */
export function scenario(name: string, run: (t: Scenario) => Promise<void>, only?: Run[]) {
  const dialects = only ?? ['labels', 'folders']
  const gmail = dialects.includes('labels') && !dialects.includes('gmail') && !NOT_GMAIL.has(name)
  definitions.push({ name, dialects: gmail ? [...dialects, 'gmail'] : dialects, run })
}

export type Result = { name: string; dialect: Run; passed: boolean; failure: string | null; edges: Edge[] }

/**
 * Where transcripts go. LETTERBOX_ARTIFACTS moves them, so the break test can run
 * scenarios on broken code without writing over the transcripts of the real run.
 */
export const ARTIFACTS = process.env['LETTERBOX_ARTIFACTS'] ?? join(process.cwd(), 'artifacts', 'scenarios')

/** Methods that only read, and so stay out of the transcript. */
const READS = new Set<string | symbol>(['truth', 'calls', 'refreshes', 'handedOut', 'url'])

/** Wraps a mailbox or the fake Gmail so every call a scenario makes on it lands in the transcript under `who`. */
const recorded = <Target extends object>(
  target: Target,
  who: string,
  record: (entry: TranscriptEntry) => void,
): Target =>
  new Proxy(target, {
    get(inner, property, receiver) {
      const value: unknown = Reflect.get(inner, property, receiver)
      if (typeof value !== 'function' || READS.has(property)) return value
      return (...args: unknown[]) => {
        record({ from: 'provider', did: `${who} ${String(property)}`, with: args })
        return Reflect.apply(value, inner, args)
      }
    },
  })

/** What a run talks to, behind one shape. */
type Backend = {
  provider: Scenario['provider']
  gmail: GmailFake | null
  createMailbox(seed: Seed): SimMailbox
  /** The core-sim flags that point it at this backend. */
  args: string[]
  handedOut(): ReadonlySet<string>
  /** The secrets the core must keep out of its store: sessions, or Gmail's tokens. */
  secrets(): ReadonlySet<string>
  close(): Promise<void>
}

/** Starts the sim provider for a dialect run, or the fake Gmail for a gmail run, in `folder`. */
async function startBackend(run: Run, folder: string, record: (entry: TranscriptEntry) => void): Promise<Backend> {
  if (run === 'gmail') {
    const redirects = join(folder, 'redirects')
    mkdirSync(redirects)
    const fake = await startFakeGmail(redirects)
    const gmail = recorded(fake, 'gmail', record)
    return {
      provider: gmail,
      gmail,
      // The scenario's own wrapper records what it does to the mailbox. The seed stays out.
      createMailbox: (seed) => fake.createMailbox(seed),
      args: ['--gmail', fake.url, '--gmail-redirects', redirects],
      handedOut: () => fake.handedOut(),
      secrets: () => fake.secrets(),
      close: () => fake.close(),
    }
  }
  const provider = await startSimProvider(join(folder, 'provider.sock'))
  return {
    provider,
    gmail: null,
    createMailbox: (seed) => provider.createMailbox(run, seed),
    args: ['--sim', provider.socketPath],
    handedOut: () => provider.handedOut(),
    secrets: () => provider.sessions(),
    close: () => provider.close(),
  }
}

/** Runs one scenario against one dialect, or as gmail, and writes its transcript. */
export async function runOne(definition: Definition, dialect: Run): Promise<Result> {
  const folder = mkdtempSync(join(tmpdir(), 'letterbox-'))
  const data = join(folder, 'data')
  const transcript: TranscriptEntry[] = []
  // The store is scanned after every core message, not only at the end: SQLite's checkpoint
  // at close can overwrite a page that once held a secret. Each commit that matters is
  // followed by a message, so the scan sees its write in the WAL.
  const leftInStore = new Set<string>()
  const record = (entry: TranscriptEntry) => {
    transcript.push(entry)
    if (entry.from === 'core') scanStore()
  }
  const backend = await startBackend(dialect, folder, record)
  function scanStore() {
    for (const leak of storeLeaks(data, backend.secrets())) leftInStore.add(leak)
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
    dialect: dialect === 'gmail' ? 'labels' : dialect,
    provider: backend.provider,
    gmail: backend.gmail,
    mailbox: (seed) => {
      passwords.push(seed.password)
      return recorded(backend.createMailbox(seed), seed.address, record)
    },
    startCore: () => {
      record({ from: 'scenario', note: 'core starts' })
      const core = startCore(data, backend.args, record, newId)
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
    await backend.close()
    // Once more before the folder goes, after every core has written its last.
    scanStore()
    rmSync(folder, { recursive: true, force: true })
  }

  // Rules every run keeps, whatever the scenario checked.
  const cycle = lifecycle(transcript)
  const broken = [
    ...cores.flatMap((core) => core.violations()),
    ...leaks(transcript, new Set([...backend.handedOut(), ...passwords])),
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
