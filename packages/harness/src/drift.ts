// Transcripts must be byte-identical from run to run. run.ts runs each scenario twice, side by
// side, and compares the two transcripts with `drift`. A scenario whose transcripts are known
// to differ is named in DRIFT_ALLOWED, which may only shrink, as the file-size baseline does:
// a name in it must be a scenario, and no name may be added compared with the list at git
// revision DRIFT_BASE (CI sets it to a pull request's base), or at HEAD when that is unset.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** The scenarios whose transcripts may differ from run to run, one name per line. */
export const DRIFT_ALLOWED = 'packages/harness/drift-allowed.txt'

/** The names in an allow-list's text. Blank lines and lines that start with `#` are skipped. */
const namesIn = (text: string) =>
  new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  )

/** Runs git in the repository. A git hook's GIT_ variables are dropped, so git finds this checkout. */
const git = (args: string[]) =>
  spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  })

/** The allow-list at the accepted revision, or null when it did not exist there. Throws if DRIFT_BASE is missing. */
function accepted(): Set<string> | null {
  const given = process.env['DRIFT_BASE'] || undefined
  const base = given ?? 'HEAD'
  if (git(['cat-file', '-e', `${base}^{commit}`]).status !== 0) {
    if (given === undefined) return null
    throw new Error(`DRIFT_BASE is ${given}, which this checkout does not have. Fetch it first.`)
  }
  const shown = git(['show', `${base}:${DRIFT_ALLOWED}`])
  return shown.status === 0 ? namesIn(shown.stdout) : null
}

/**
 * Reads DRIFT_ALLOWED and returns its names. Throws when a name is not one of `scenarios`, or
 * was added since the accepted revision: the list only shrinks, so new drift fails.
 */
export function allowedDrift(scenarios: ReadonlySet<string>): Set<string> {
  const allowed = namesIn(readFileSync(join(ROOT, DRIFT_ALLOWED), 'utf8'))
  const unknown = [...allowed].filter((name) => !scenarios.has(name))
  if (unknown.length > 0)
    throw new Error(
      `${DRIFT_ALLOWED} names scenarios that do not exist: ${unknown.map((name) => `"${name}"`).join(', ')}. Delete those lines.`,
    )
  const before = accepted()
  const added = before === null ? [] : [...allowed].filter((name) => !before.has(name))
  if (added.length > 0)
    throw new Error(
      `${DRIFT_ALLOWED} gained ${added.map((name) => `"${name}"`).join(', ')}. The list only shrinks: make the scenario's transcript the same from run to run instead (hold a provider call so the order is fixed).`,
    )
  return allowed
}

/** Up to WIDE characters of `line` around character `at`, with … where it was cut. */
const WIDE = 160
const around = (line: string, at: number) => {
  const start = Math.max(0, Math.min(at - 60, line.length - WIDE))
  const end = start + WIDE
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}

/** Where two strings first differ, or the shorter one's length. */
const firstDifference = (a: string, b: string) => {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1
  return at
}

/** One line of a diff: `sign`, then `ours` around where it first differs from `theirs`. */
const pair = (ours: string, theirs: string, sign: string) => `${sign} ${around(ours, firstDifference(ours, theirs))}`

/** How many differing lines a diff shows from each copy. */
const SHOWN = 4

/** The first SHOWN of `lines`, each as a `pair` with the line at its place in `partner`. */
const show = (lines: string[], partner: string[], sign: string) => [
  ...lines.slice(0, SHOWN).map((line, index) => pair(line, partner[index] ?? '', sign)),
  ...(lines.length > SHOWN ? [`${sign} … and ${lines.length - SHOWN} more lines`] : []),
]

/**
 * Compares two transcripts of the same run. Returns null when they are the same, else a short
 * diff, `-` for the first copy and `+` for the second, each line cut to the part around where it
 * first differs from its partner. When both copies have as many lines, which is usual (a `rev`
 * moved, or two lines swapped), it shows each line that differs. Otherwise it shows the lines
 * between the common start and the common end.
 */
export function drift(first: string, second: string): string | null {
  if (first === second) return null
  const a = first.split('\n')
  const b = second.split('\n')
  if (a.length === b.length) {
    const differing = a.flatMap((line, index) => (line === b[index] ? [] : [index]))
    return [
      `${differing.length} of ${a.length} lines differ:`,
      ...differing
        .slice(0, SHOWN)
        .flatMap((index) => [
          `line ${index + 1}:`,
          pair(a[index] ?? '', b[index] ?? '', '-'),
          pair(b[index] ?? '', a[index] ?? '', '+'),
        ]),
      ...(differing.length > SHOWN ? [`… and ${differing.length - SHOWN} more lines`] : []),
    ].join('\n')
  }
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail += 1
  const removed = a.slice(head, a.length - tail)
  const added = b.slice(head, b.length - tail)
  return [
    `from line ${head + 1}, the first copy has ${removed.length} lines where the second has ${added.length}:`,
    ...show(removed, added, '-'),
    ...show(added, removed, '+'),
  ].join('\n')
}
