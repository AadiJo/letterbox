// Applies each break from mutations.ts to the source, runs the scenarios that should
// notice it, and puts the files back. The breaks live in mutations.ts and mutations-gmail.ts.
//
// A run that is stopped still puts the files back: SIGINT, SIGTERM, SIGHUP and an uncaught
// error all end at the `exit` handler below. SIGKILL cannot be caught, so before a break
// edits anything it writes the originals to JOURNAL, and the next run puts them back first.
// The journal is on disk before the first edit and goes only once the originals are, so even
// a machine that stops leaves either no journal and clean files, or a whole journal.
//
// One break run at a time per checkout: a run holds LOCK from start to exit, since a second run
// would put back files under the first one's break, or build over its core. A break whose core
// build broke for a reason that is not its own source, such as the compiler being killed by the
// out-of-memory killer, is an ERROR: the machine failed, not the break's entry. So is one whose
// scenarios failed only on a tool outside the system, such as a browser that would not launch
// (`ToolFailure` in scenario.ts): no check ran, so nothing was caught.

import { type ChildProcess, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { BUILD_BROKE, CORE_DID_NOT_BUILD, TOOL_FAILED } from './client.ts'

export type Edit = {
  file: string
  /** Text that must appear exactly once in the file. */
  find: string
  replace: string
}

export type Mutation = Edit & {
  /** What goes wrong, in a user's or a reviewer's words. */
  name: string
  /** Runs only the scenarios whose name contains this. */
  scenarios: string
  /** More edits, for a break that needs more than one place changed. Applied in order after the first. */
  also?: Edit[]
}

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'letterbox-mutations-'))

/**
 * The break that is in the source now, written before its first edit and removed once the
 * files are back. It stays only when a run was killed with SIGKILL (or the machine stopped),
 * and the next run in this checkout puts the files back from it. target/ is ignored by git.
 */
const JOURNAL = join(ROOT, 'target', 'break-journal.json')

/** One file a break edited: its text before the break and with it. */
type Journaled = { path: string; original: string; broken: string }
type Journal = { pid: number; break: string; files: Journaled[] }

/** Held from the start of a run to its exit, so only one break run at a time works in this checkout. */
const LOCK = join(ROOT, 'target', 'break.lock')

/** What LOCK holds: the run's pid, this boot's id, and when the run began. */
type Lock = { pid: number; boot: string | null; startedAt: string }

/** True once this process holds LOCK. The `exit` handler removes it then, and only then. */
let locked = false

/** The break applied now, or null. The `exit` handler puts its files back. */
let applied: Journal | null = null
/** The scenario run of the applied break, while it runs. It leads its own process group. */
let child: ChildProcess | null = null

/** Kills the scenario run's whole process group: run.ts, the cores it started and any cargo build. */
function stopChild() {
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // The group is already gone.
    }
  }
  child = null
}

/**
 * Writes `text` to `path` and waits until it is on disk. A plain write sits in memory for up to
 * 30 s first, so a machine that stops meanwhile can keep a later write and lose this one: a
 * renamed journal comes back empty, or a source file keeps its break while its journal is gone.
 */
function writeToDisk(path: string, text: string) {
  const fd = openSync(path, 'w')
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Waits until the folder `path` is on disk as it is now, as a rename into it leaves it. */
function syncFolder(path: string) {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Puts back the files of the applied break and removes the journal. Safe to call when none is applied. */
function putBack() {
  if (applied === null) return
  for (const file of applied.files) writeToDisk(file.path, file.original)
  rmSync(JOURNAL, { force: true })
  applied = null
}

// Whatever ends this process, short of SIGKILL, comes through here: a normal exit, an
// uncaught error or rejection, and the signals below, which exit with the shell's code.
process.on('exit', () => {
  stopChild()
  putBack()
  if (locked) rmSync(LOCK, { force: true })
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (applied !== null) console.log(`\n${signal}: putting back the files of "${applied.break}" before stopping.`)
    process.exit(128 + constants.signals[signal])
  })
}

/** True when `pid` is a running process. */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as another user.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** This boot's id on Linux, or null elsewhere. A lock from before a restart never counts as held, even by a reused pid. */
function bootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return null
  }
}

/** The lock another run left, or null when it cannot be read. */
function readLock(): Lock | null {
  try {
    const value: unknown = JSON.parse(readFileSync(LOCK, 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const { pid, boot, startedAt } = value as Record<string, unknown>
    if (typeof pid !== 'number' || typeof startedAt !== 'string') return null
    return { pid, boot: typeof boot === 'string' ? boot : null, startedAt }
  } catch {
    return null
  }
}

/**
 * Called first in a run. Takes LOCK, created only if it is not there, so of two runs started at
 * once exactly one gets it. While a live run holds it, this run says who and exits 1. A lock left
 * by a run that is gone, from a kill or a restart, is taken over, loudly.
 */
function lock() {
  mkdirSync(dirname(LOCK), { recursive: true })
  const mine: Lock = { pid: process.pid, boot: bootId(), startedAt: new Date().toISOString() }
  const path = relative(ROOT, LOCK)
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      writeFileSync(LOCK, JSON.stringify(mine), { flag: 'wx' })
      locked = true
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    const holder = readLock()
    if (holder && holder.boot === mine.boot && alive(holder.pid)) {
      console.log(`\n!!! Another break run (pid ${holder.pid}, started ${holder.startedAt}) holds ${path}.`)
      console.log(
        "!!! Only one break run at a time works in a checkout, since a second would undo the first one's breaks.",
      )
      console.log('!!! No break ran. Wait for that run to end, then start again.\n')
      process.exit(1)
    }
    const left = holder
      ? `a break run (pid ${holder.pid}, started ${holder.startedAt}) that is no longer running`
      : 'a break run, and cannot be read'
    console.log(`\n!!! ${path} was left by ${left}. Taking it over.\n`)
    rmSync(LOCK, { force: true })
  }
  console.log(`\n!!! Another break run took ${path} over first. No break ran.\n`)
  process.exit(1)
}

/** True when `value` has a journal's shape. */
const isJournal = (value: unknown): value is Journal => {
  if (typeof value !== 'object' || value === null) return false
  const { pid, break: name, files } = value as Record<string, unknown>
  return (
    typeof pid === 'number' &&
    typeof name === 'string' &&
    Array.isArray(files) &&
    files.every(
      (file: unknown) =>
        typeof file === 'object' &&
        file !== null &&
        ['path', 'original', 'broken'].every((key) => typeof (file as Record<string, unknown>)[key] === 'string'),
    )
  )
}

/** The journal a run left, null when there is none, or 'unreadable' when it is empty, cut off or not a journal. */
function readJournal(): Journal | null | 'unreadable' {
  if (!existsSync(JOURNAL)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(JOURNAL, 'utf8'))
    return isJournal(value) ? value : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/**
 * Called once at the start of a run. Puts back the files a killed run left broken, as its
 * journal records them, and says so loudly. Throws, and touches nothing, when another run is
 * still applying a break here, or when a file changed since the killed run edited it.
 *
 * A journal it cannot read stops the run before it touches anything. Which break it held, and
 * so which file may still be broken, is lost. A run on top of a break left in the source would
 * read that break as the original, and report on broken code. A person has to look.
 */
function recover() {
  const journal = readJournal()
  if (journal === null) return
  if (journal === 'unreadable') {
    const path = relative(ROOT, JOURNAL)
    console.log(`\n!!! ${path} is here, but it is empty or cut off, so it cannot be read.`)
    console.log(
      '!!! A break run stopped part way. Its break may still be in the source, and this run cannot tell which.',
    )
    console.log(
      `!!! No break ran and no file was changed. Check \`git status\`, put back any break left in the source, then delete ${path}.\n`,
    )
    process.exit(1)
  }
  if (journal.pid !== process.pid && alive(journal.pid))
    throw new Error(`Another break run (pid ${journal.pid}) is applying a break in this checkout. Wait for it to end.`)
  const changed = journal.files.filter((file) => {
    const now = existsSync(file.path) ? readFileSync(file.path, 'utf8') : null
    return now !== file.original && now !== file.broken
  })
  if (changed.length > 0)
    throw new Error(
      `A break run that was killed left ${relative(ROOT, JOURNAL)}, but ${changed.map((file) => relative(ROOT, file.path)).join(', ')} changed since it was broken. The journal holds each file's original text. Put the files right by hand, then delete the journal.`,
    )
  console.log(`\n!!! A break run (pid ${journal.pid}) was killed while "${journal.break}" was applied.`)
  for (const file of journal.files) {
    if (readFileSync(file.path, 'utf8') === file.original) continue
    writeToDisk(file.path, file.original)
    console.log(`!!! Put back ${relative(ROOT, file.path)}.`)
  }
  rmSync(JOURNAL)
  console.log('!!! The source is as it was before that break.\n')
}

/** Runs the scenarios whose name contains `filter` on the source as it is, and resolves with how the run ended. */
function runScenarios(filter: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // One failed run proves the break was caught, so `--bail` skips the rest.
  const run = spawn(process.execPath, ['packages/harness/src/run.ts', '--bail', filter], {
    cwd: ROOT,
    // Its own process group, so `stopChild` stops the cores and cargo it starts too.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Transcripts of broken code go to a throwaway folder, never over the real run's.
      LETTERBOX_ARTIFACTS: SCRATCH,
      // CI turns incremental builds off so its Cargo cache stays small. Every break rebuilds
      // the core with one small edit, and incremental builds make that about 2 s faster each time.
      CARGO_INCREMENTAL: '1',
    },
  })
  child = run
  let stdout = ''
  let stderr = ''
  run.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  run.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  // A broken core can hang a run. After two minutes it counts as failed.
  const timer = setTimeout(stopChild, 120_000)
  return new Promise((resolve) => {
    run.on('close', (status) => {
      clearTimeout(timer)
      child = null
      resolve({ status, stdout, stderr })
    })
  })
}

/** Applies one mutation, runs its scenarios, restores the files. `ok` is true when the scenarios failed, as they should. */
/**
 * How one break went: caught, missed (its scenarios still pass, or its entry no longer fits the
 * code), or error (its core build broke for a reason that is not its source, or a tool its
 * scenarios use, such as the browser, failed before a check could run).
 */
type Outcome = { outcome: 'caught' | 'missed' | 'error'; why: string }

/** Applies one mutation, runs its scenarios, restores the files, and says how it went. */
async function caught(mutation: Mutation): Promise<Outcome> {
  // Every edit is made in memory first, so a break whose text is missing changes nothing.
  const files = new Map<string, Journaled>()
  for (const edit of [mutation, ...(mutation.also ?? [])]) {
    const path = join(ROOT, edit.file)
    const original = readFileSync(path, 'utf8')
    const file = files.get(path) ?? { path, original, broken: original }
    const count = file.broken.split(edit.find).length - 1
    if (count !== 1)
      return {
        outcome: 'missed',
        why: `its text appears ${count} times in ${edit.file}. Update the entry to match the code.`,
      }
    files.set(path, { ...file, broken: file.broken.replace(edit.find, edit.replace) })
  }
  applied = { pid: process.pid, break: mutation.name, files: [...files.values()] }
  // The journal is whole and on disk before any edit, so a stop at any point, of this process
  // or of the machine, leaves no journal and clean files, or a journal the next run can read.
  mkdirSync(dirname(JOURNAL), { recursive: true })
  writeToDisk(`${JOURNAL}.partial`, JSON.stringify(applied))
  renameSync(`${JOURNAL}.partial`, JOURNAL)
  syncFolder(dirname(JOURNAL))
  try {
    for (const file of applied.files) writeFileSync(file.path, file.broken)
    const run = await runScenarios(mutation.scenarios)
    const summary = run.stdout.trim().split('\n').at(-1) ?? ''
    if (run.status === CORE_DID_NOT_BUILD)
      return {
        outcome: 'missed',
        why: `the broken code does not compile. Update the entry so it builds.\n${run.stderr}`,
      }
    if (run.status === BUILD_BROKE) return { outcome: 'error', why: summary }
    // A tool the scenario needs, such as the browser, failed before any check could run.
    if (run.status === TOOL_FAILED) return { outcome: 'error', why: summary }
    if (run.status === 0) return { outcome: 'missed', why: `the scenarios still pass: ${summary}` }
    return { outcome: 'caught', why: summary }
  } finally {
    putBack()
  }
}

/**
 * Reads `--shard k/n` from the command line: run only every n-th break, starting at the k-th.
 * CI runs the n shards as parallel jobs. With no flag, every break runs.
 */
function shardOf<Item>(items: Item[]): Item[] {
  const { values } = parseArgs({ options: { shard: { type: 'string' } } })
  if (values.shard === undefined) return items
  const match = /^(\d+)\/(\d+)$/.exec(values.shard)
  const k = Number(match?.[1])
  const n = Number(match?.[2])
  if (!match || n < 1 || k < 1 || k > n) throw new Error(`--shard takes k/n with 1 <= k <= n, not "${values.shard}"`)
  // Every n-th break, so the slow breaks that sit together in a file spread across the shards.
  const chosen = items.filter((_, index) => index % n === k - 1)
  console.log(`Shard ${k} of ${n}: ${chosen.length} of the ${items.length} breaks.\n`)
  return chosen
}

/** What each outcome prints before the break's name. */
const LABELS = { caught: 'caught', missed: 'MISSED', error: 'ERROR ' } satisfies Record<Outcome['outcome'], string>

/**
 * Runs every break, or one shard of them (see `shardOf`), and exits non-zero if any went
 * unnoticed or could not be tried.
 */
export async function runBreaks(all: Mutation[]): Promise<never> {
  lock()
  recover()
  const mutations = shardOf(all)
  const count = { caught: 0, missed: 0, error: 0 }
  for (const mutation of mutations) {
    const result = await caught(mutation)
    count[result.outcome] += 1
    const why = result.outcome === 'caught' ? '' : `\n        ${result.why}`
    console.log(`${LABELS[result.outcome]}  ${mutation.name}${why}`)
  }
  console.log(`\n${count.caught} of ${mutations.length} breaks were caught.`)
  if (count.error > 0)
    console.log(
      `${count.error} could not be tried, because this machine failed, not the break: the core build broke, or a tool the scenarios need, such as the browser, did not start. Free memory or install what is missing, then run them again.`,
    )
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(count.missed + count.error === 0 ? 0 : 1)
}
