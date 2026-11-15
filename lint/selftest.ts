// Checks every letterbox lint rule against its fixtures. Run it with `pnpm lint:selftest`.
//
// It runs the real oxlint binary with the real .oxlintrc.json over lint/fixtures, so a
// fixture takes the same path as real code: same config, same overrides, same plugin.
//
// Each rule has a folder lint/fixtures/<rule>/ with at least one bad file and one good
// file. A bad file says what it expects on its first line:
//
//   // expect: letterbox/no-provider-names x3
//
// Separate several expectations with commas. A file without that line is a good file. It
// must produce no diagnostic at all, from any rule, built-in ones included.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import plugin from './index.ts'

const ROOT = join(import.meta.dirname, '..')
const FIXTURES = 'lint/fixtures'
const LINTABLE = /\.[cm]?[jt]sx?$/

/** How many diagnostics each rule produced, or should produce, in one file. */
type Counts = Map<string, number>

/** The fields this script reads from oxlint's JSON reporter. */
type OxlintReport = {
  diagnostics: {
    /** For example "letterbox(no-provider-names)". Absent on an unused disable directive. */
    code?: string
    message: string
    filename: string
    labels?: { span: { line: number } }[]
  }[]
  number_of_files: number
}

/** Prints why the self-test cannot give a verdict, then stops. */
const abort = (reason: string): never => {
  console.error(`lint self-test could not run: ${reason}`)
  process.exit(1)
}

/** Every lintable file under lint/fixtures, as a path from the repo root. */
const fixtureFiles = (): string[] =>
  readdirSync(join(ROOT, FIXTURES), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && LINTABLE.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .toSorted()

/** Reads the `// expect:` line of a fixture. A file without one expects nothing. */
const expectedCounts = (file: string): Counts => {
  const counts: Counts = new Map()
  const [firstLine = ''] = readFileSync(join(ROOT, file), 'utf8').split('\n', 1)
  const [, list] = /^\/\/ expect: (.+)$/.exec(firstLine.trimEnd()) ?? []
  for (const part of list?.split(',') ?? []) {
    const [, rule, count] = /^(\S+) x(\d+)$/.exec(part.trim()) ?? []
    if (rule === undefined) abort(`${file} expects "${part.trim()}". Write it as "<plugin>/<rule> x<count>".`)
    else counts.set(rule, Number(count))
  }
  return counts
}

/** Lints the fixtures the way `pnpm lint` lints the repo, and returns oxlint's JSON report. */
const runOxlint = (): OxlintReport => {
  const run = spawnSync(join(ROOT, 'node_modules/.bin/oxlint'), ['--format', 'json', FIXTURES], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  try {
    const report: OxlintReport = JSON.parse(run.stdout)
    if (Array.isArray(report.diagnostics)) return report
  } catch {
    // Not JSON: oxlint printed a config or plugin error instead. Fall through and show it.
  }
  return abort(`oxlint gave no JSON report.\n${run.error?.message ?? ''}${run.stdout ?? ''}${run.stderr ?? ''}`)
}

/** Groups oxlint's diagnostics by file and rule, and remembers the lines for the diff. */
const reportedByFile = (report: OxlintReport) => {
  const counts = new Map<string, Counts>()
  const lines = new Map<string, number[]>()
  for (const { code, message, filename, labels } of report.diagnostics) {
    const rule = code?.replace(/^(.+)\((.+)\)$/, '$1/$2') ?? `(no rule) ${message}`
    const fileCounts = counts.get(filename) ?? new Map<string, number>()
    counts.set(filename, fileCounts.set(rule, (fileCounts.get(rule) ?? 0) + 1))
    const key = `${filename} ${rule}`
    lines.set(key, [...(lines.get(key) ?? []), ...(labels ?? []).slice(0, 1).map((label) => label.span.line)])
  }
  return { counts, lines }
}

const files = fixtureFiles()
const expected = new Map(files.map((file) => [file, expectedCounts(file)]))
const report = runOxlint()
const reported = reportedByFile(report)
const failures: string[] = []

// 1. Every fixture reports exactly the rules and counts it declares.
for (const file of new Set([...files, ...reported.counts.keys()])) {
  const want: Counts = expected.get(file) ?? new Map()
  const got: Counts = reported.counts.get(file) ?? new Map()
  const diff = [...new Set([...want.keys(), ...got.keys()])]
    .filter((rule) => (want.get(rule) ?? 0) !== (got.get(rule) ?? 0))
    .toSorted()
    .map((rule) => {
      const at = reported.lines.get(`${file} ${rule}`) ?? []
      const where = at.length > 0 ? ` on line ${at.join(', ')}` : ''
      return `       ${rule}: expected ${want.get(rule) ?? 0}, got ${got.get(rule) ?? 0}${where}`
    })
  if (diff.length > 0) failures.push(`FAIL ${file}\n${diff.join('\n')}`)
  else console.log(`ok   ${file}  ${[...want].map(([rule, count]) => `${rule} x${count}`).join(', ') || 'clean'}`)
}

// 2. oxlint saw every fixture. A skipped file reports nothing and would pass as a good file.
if (report.number_of_files !== files.length) {
  failures.push(`FAIL oxlint linted ${report.number_of_files} files, but ${FIXTURES} has ${files.length}.`)
}

// 3. Every rule has a bad and a good fixture, and every fixture folder belongs to a rule.
const ruleNames = Object.keys(plugin.rules)
for (const name of ruleNames) {
  const id = `${plugin.meta.name}/${name}`
  const folder = `${FIXTURES}/${name}/`
  const own = files.filter((file) => file.startsWith(folder))
  if (!own.some((file) => (expected.get(file)?.get(id) ?? 0) > 0)) {
    failures.push(`FAIL ${id} has no bad fixture. Add a file to ${folder} that starts with "// expect: ${id} x1".`)
  }
  if (!own.some((file) => expected.get(file)?.size === 0)) {
    failures.push(`FAIL ${id} has no good fixture. Add a file to ${folder} that the rule accepts.`)
  }
}
for (const entry of readdirSync(join(ROOT, FIXTURES), { withFileTypes: true })) {
  if (entry.isDirectory() && !ruleNames.includes(entry.name)) {
    failures.push(`FAIL ${FIXTURES}/${entry.name}/ has fixtures, but lint/index.ts has no rule named "${entry.name}".`)
  }
}

for (const failure of failures) console.error(failure)
console.log(`\n${ruleNames.length} rules, ${files.length} fixture files, ${failures.length} failures`)
process.exitCode = failures.length > 0 ? 1 : 0
