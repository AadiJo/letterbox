// Applies each break from mutations.ts to the source, runs the scenarios that should
// notice it, and puts the files back. The breaks live in mutations.ts and mutations-gmail.ts.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** Applies one mutation, runs its scenarios, restores the files. True when the scenarios failed, as they should. */
function caught(mutation: Mutation): { ok: boolean; why: string } {
  // Each file's text before the first edit to it, to put back afterwards.
  const originals = new Map<string, string>()
  const restore = () => {
    for (const [path, text] of originals) writeFileSync(path, text)
  }
  for (const edit of [mutation, ...(mutation.also ?? [])]) {
    const path = join(ROOT, edit.file)
    const text = readFileSync(path, 'utf8')
    if (!originals.has(path)) originals.set(path, text)
    const count = text.split(edit.find).length - 1
    if (count !== 1) {
      restore()
      return {
        ok: false,
        why: `its text appears ${count} times in ${edit.file}. Update the entry to match the code.`,
      }
    }
    writeFileSync(path, text.replace(edit.find, edit.replace))
  }
  try {
    // One failed run proves the break was caught, so `--bail` skips the rest.
    const run = spawnSync(process.execPath, ['packages/harness/src/run.ts', '--bail', mutation.scenarios], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        // Transcripts of broken code go to a throwaway folder, never over the real run's.
        LETTERBOX_ARTIFACTS: SCRATCH,
        // CI turns incremental builds off so its Cargo cache stays small. Every break rebuilds
        // the core with one small edit, and incremental builds make that about 2 s faster each time.
        CARGO_INCREMENTAL: '1',
      },
    })
    const summary = run.stdout.trim().split('\n').at(-1) ?? ''
    if (run.status === CORE_DID_NOT_BUILD)
      return { ok: false, why: `the broken code does not compile. Update the entry so it builds.\n${run.stderr}` }
    return run.status === 0 ? { ok: false, why: `the scenarios still pass: ${summary}` } : { ok: true, why: summary }
  } finally {
    restore()
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
export function runBreaks(all: Mutation[]): never {
  const mutations = shardOf(all)
  let missed = 0
  for (const mutation of mutations) {
    const result = caught(mutation)
    if (!result.ok) missed += 1
    console.log(`${result.ok ? 'caught' : 'MISSED'}  ${mutation.name}${result.ok ? '' : `\n        ${result.why}`}`)
  }
  console.log(`\n${mutations.length - missed} of ${mutations.length} breaks were caught.`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(missed === 0 ? 0 : 1)
}
