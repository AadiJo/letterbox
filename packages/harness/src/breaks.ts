// Applies each break from mutations.ts to the source, runs the scenarios that should
// notice it, and puts the files back. The breaks live in mutations.ts and mutations-gmail.ts.
//
// A run that is stopped still puts the files back: SIGINT, SIGTERM, SIGHUP and an uncaught
// error all end at the `exit` handler below. SIGKILL cannot be caught, so before a break
// edits anything it writes the originals to JOURNAL, and the next run puts them back first.

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { CORE_DID_NOT_BUILD } from './client.ts'

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

/** Puts back the files of the applied break and removes the journal. Safe to call when none is applied. */
function putBack() {
  if (applied === null) return
  for (const file of applied.files) writeFileSync(file.path, file.original)
  rmSync(JOURNAL, { force: true })
  applied = null
}

// Whatever ends this process, short of SIGKILL, comes through here: a normal exit, an
// uncaught error or rejection, and the signals below, which exit with the shell's code.
process.on('exit', () => {
  stopChild()
  putBack()
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

/**
 * Called once at the start of a run. Puts back the files a killed run left broken, as its
 * journal records them, and says so loudly. Throws, and touches nothing, when another run is
 * still applying a break here, or when a file changed since the killed run edited it.
 */
function recover() {
  if (!existsSync(JOURNAL)) return
  const journal: Journal = JSON.parse(readFileSync(JOURNAL, 'utf8'))
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
    writeFileSync(file.path, file.original)
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
async function caught(mutation: Mutation): Promise<{ ok: boolean; why: string }> {
  // Every edit is made in memory first, so a break whose text is missing changes nothing.
  const files = new Map<string, Journaled>()
  for (const edit of [mutation, ...(mutation.also ?? [])]) {
    const path = join(ROOT, edit.file)
    const original = readFileSync(path, 'utf8')
    const file = files.get(path) ?? { path, original, broken: original }
    const count = file.broken.split(edit.find).length - 1
    if (count !== 1)
      return { ok: false, why: `its text appears ${count} times in ${edit.file}. Update the entry to match the code.` }
    files.set(path, { ...file, broken: file.broken.replace(edit.find, edit.replace) })
  }
  applied = { pid: process.pid, break: mutation.name, files: [...files.values()] }
  // The journal goes in whole before any edit, so a kill at any point leaves it readable.
  mkdirSync(dirname(JOURNAL), { recursive: true })
  writeFileSync(`${JOURNAL}.partial`, JSON.stringify(applied))
  renameSync(`${JOURNAL}.partial`, JOURNAL)
  try {
    for (const file of applied.files) writeFileSync(file.path, file.broken)
    const run = await runScenarios(mutation.scenarios)
    const summary = run.stdout.trim().split('\n').at(-1) ?? ''
    if (run.status === CORE_DID_NOT_BUILD)
      return { ok: false, why: `the broken code does not compile. Update the entry so it builds.\n${run.stderr}` }
    return run.status === 0 ? { ok: false, why: `the scenarios still pass: ${summary}` } : { ok: true, why: summary }
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

/** Runs every break, or one shard of them (see `shardOf`), and exits non-zero if any went unnoticed. */
export async function runBreaks(all: Mutation[]): Promise<never> {
  recover()
  const mutations = shardOf(all)
  let missed = 0
  for (const mutation of mutations) {
    const result = await caught(mutation)
    if (!result.ok) missed += 1
    console.log(`${result.ok ? 'caught' : 'MISSED'}  ${mutation.name}${result.ok ? '' : `\n        ${result.why}`}`)
  }
  console.log(`\n${mutations.length - missed} of ${mutations.length} breaks were caught.`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(missed === 0 ? 0 : 1)
}
