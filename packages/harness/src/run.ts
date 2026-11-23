// Runs every scenario against every dialect, twice, side by side, and checks that the two
// transcripts of each run are the same (see drift.ts).
//
//   node packages/harness/src/run.ts                   all scenarios
//   node packages/harness/src/run.ts archive           only scenarios whose name contains "archive"
//   node packages/harness/src/run.ts --bail archive    once each, stopping at the first failed run
//
// Builds the Rust core first, so the scenarios always run the source as it is.
// Writes one transcript per run and a summary to artifacts/scenarios/. When the second copy's
// transcript differs, it goes next to the first as `<scenario>.<dialect>.again.jsonl`.
// Exits 1 if any scenario fails or drifts outside drift-allowed.txt, 2 if the core does not compile, 3
// if its build broke for another reason, such as the compiler being killed (see `buildCore`), and 4
// if every failed run failed on a tool outside the system, such as a browser that would not launch.
//
// The second copy runs the same list starting halfway down, so each run shares the machine
// with a different scenario. The load moves timing about, as a busy CI machine does, which
// is what makes an unfixed order show. It costs about a third more time than one copy.
//
// `--bail` is for the break test (breaks.ts). It only asks whether any run fails, and a
// broken core often fails by timing out, so it runs one copy, and the runs after the first
// failure only add waits.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { BUILD_BROKE, buildCore, CORE_DID_NOT_BUILD, TOOL_FAILED } from './client.ts'
import { allowedDrift, drift, DRIFT_ALLOWED } from './drift.ts'
import { lifecycleChart } from './invariants.ts'
import { ARTIFACTS, definitions, type Result, runOne } from './scenario.ts'

const { values, positionals } = parseArgs({
  options: { bail: { type: 'boolean', default: false } },
  allowPositionals: true,
})
const only = positionals[0]

const build = buildCore()
if (build.kind === 'does-not-compile') {
  console.log('The core did not build, so no scenario ran.')
  process.exit(CORE_DID_NOT_BUILD)
}
if (build.kind === 'broke') {
  console.log(`The core did not build because ${build.why}. That is this machine, not the source. No scenario ran.`)
  process.exit(BUILD_BROKE)
}

const scenarioFolder = fileURLToPath(new URL('../scenarios/', import.meta.url))
for (const file of readdirSync(scenarioFolder).toSorted()) {
  if (file.endsWith('.ts')) await import(pathToFileURL(join(scenarioFolder, file)).href)
}

// Read first, so a list that grew fails before minutes of runs.
const allowed = values.bail ? new Set<string>() : allowedDrift(new Set(definitions.map(({ name }) => name)))

const runs = definitions
  .filter((definition) => !only || definition.name.includes(only))
  .flatMap((definition) => definition.dialects.map((dialect) => ({ definition, dialect })))
const artifacts = ARTIFACTS
if (!only) rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })
const transcriptOf = (result: Result, copy = '') => join(artifacts, `${result.name}.${result.dialect}${copy}.jsonl`)

/** Each run's result, per copy, by its index in `runs`. */
const firsts: Result[] = []
const seconds: Result[] = []

/** Runs the runs at `order`, one at a time, into `into`. `--bail` stops it at the first failure. */
async function lane(order: number[], into: Result[], copy: string) {
  for (const index of order) {
    const { definition, dialect } = runs[index]!
    const result = await runOne(definition, dialect)
    into[index] = result
    // The second copy says only what went wrong, so the log reads as one copy.
    if (copy === '' || !result.passed)
      console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${definition.name} (${dialect}${copy})`)
    if (result.failure) console.log(`      ${result.failure.replaceAll('\n', '\n      ')}`)
    if (values.bail && !result.passed) break
  }
}

const indexes = runs.map((_, index) => index)
const half = Math.floor(runs.length / 2)
await Promise.all([
  lane(indexes, firsts, ''),
  ...(values.bail ? [] : [lane([...indexes.slice(half), ...indexes.slice(0, half)], seconds, ', second copy')]),
])

// Transcripts are compared only where both copies passed: a failure already fails the run.
const drifted: { result: Result; diff: string }[] = []
for (const [index, result] of firsts.entries()) {
  writeFileSync(transcriptOf(result), result.transcript)
  rmSync(transcriptOf(result, '.again'), { force: true })
  const again = seconds[index]
  const diff = again && result.passed && again.passed ? drift(result.transcript, again.transcript) : null
  if (diff === null || again === undefined) continue
  writeFileSync(transcriptOf(result, '.again'), again.transcript)
  drifted.push({ result, diff })
}
const known = drifted.filter(({ result }) => allowed.has(result.name))
const unknown = drifted.filter(({ result }) => !allowed.has(result.name))
for (const { result } of known) console.log(`known drift  ${result.name} (${result.dialect})`)
for (const { result, diff } of unknown) {
  console.log(`\nDRIFT  ${result.name} (${result.dialect}): the two copies' transcripts differ.`)
  console.log(`       ${diff.replaceAll('\n', '\n       ')}`)
  console.log(
    `       Both copies are in ${relative(process.cwd(), artifacts)}/, the second as ${relative(artifacts, transcriptOf(result, '.again'))}.`,
  )
}
if (unknown.length > 0)
  console.log(
    `\nA transcript must be the same on every run. Fix the order in the scenario, as a held provider call does. ${DRIFT_ALLOWED} only shrinks.`,
  )

const results = [...firsts, ...seconds].filter((result) => result !== undefined)
const failed = results.filter((result) => !result.passed)
writeFileSync(join(artifacts, 'change-lifecycle.mmd'), lifecycleChart(firsts.flatMap((result) => result.edges)))
writeFileSync(
  join(artifacts, 'summary.json'),
  `${JSON.stringify(
    {
      total: results.length,
      failed: failed.length,
      drifted: drifted.map(({ result }) => ({
        name: result.name,
        dialect: result.dialect,
        known: allowed.has(result.name),
      })),
      results: results.map(({ edges: _edges, transcript: _transcript, ...result }) => result),
    },
    null,
    2,
  )}\n`,
)
const copies = values.bail ? 1 : 2
const skipped = runs.length * copies - results.length
console.log(
  `\n${results.length - failed.length} of ${results.length} runs passed${copies === 2 ? ` (each of ${runs.length} runs twice)` : ''}${skipped > 0 ? `, and ${skipped} more were skipped after the first failure` : ''}.${copies === 2 ? ` ${drifted.length} drifted, ${known.length} of them known.` : ''} Transcripts and the change lifecycle chart are in ${relative(process.cwd(), artifacts)}/.`,
)
const tools = failed.filter((result) => result.tool)
if (tools.length > 0)
  console.log(
    `${tools.length} of the failed runs failed on a tool, not on a check: ${(tools[0]?.failure ?? '').split('\n')[0]}`,
  )
if (failed.length > 0 && tools.length === failed.length) process.exit(TOOL_FAILED)
process.exit(failed.length === 0 && unknown.length === 0 && results.length > 0 ? 0 : 1)
