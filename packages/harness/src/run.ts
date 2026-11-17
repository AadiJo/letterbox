// Runs every scenario against every dialect.
//
//   node packages/harness/src/run.ts                   all scenarios
//   node packages/harness/src/run.ts archive           only scenarios whose name contains "archive"
//   node packages/harness/src/run.ts --bail archive    the same, but stops at the first failed run
//
// Builds the Rust core first, so the scenarios always run the source as it is.
// Writes one transcript per run and a summary to artifacts/scenarios/.
// Exits 1 if any scenario fails, and 2 if the core does not build.
//
// `--bail` is for the break test (breaks.ts). It only asks whether any run fails, and a
// broken core often fails by timing out, so the runs after the first failure only add waits.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { buildCore, CORE_DID_NOT_BUILD } from './client.ts'
import { lifecycleChart } from './invariants.ts'
import { ARTIFACTS, definitions, type Result, runOne } from './scenario.ts'

const { values, positionals } = parseArgs({
  options: { bail: { type: 'boolean', default: false } },
  allowPositionals: true,
})
const only = positionals[0]

if (!buildCore()) {
  console.log('The core did not build, so no scenario ran.')
  process.exit(CORE_DID_NOT_BUILD)
}

const scenarioFolder = fileURLToPath(new URL('../scenarios/', import.meta.url))
for (const file of readdirSync(scenarioFolder).toSorted()) {
  if (file.endsWith('.ts')) await import(pathToFileURL(join(scenarioFolder, file)).href)
}

const runs = definitions
  .filter((definition) => !only || definition.name.includes(only))
  .flatMap((definition) => definition.dialects.map((dialect) => ({ definition, dialect })))
const artifacts = ARTIFACTS
if (!only) rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const results: Result[] = []
for (const { definition, dialect } of runs) {
  const result = await runOne(definition, dialect)
  results.push(result)
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${definition.name} (${dialect})`)
  if (result.failure) console.log(`      ${result.failure.replaceAll('\n', '\n      ')}`)
  if (values.bail && !result.passed) break
}

const failed = results.filter((result) => !result.passed)
writeFileSync(join(artifacts, 'change-lifecycle.mmd'), lifecycleChart(results.flatMap((result) => result.edges)))
writeFileSync(
  join(artifacts, 'summary.json'),
  `${JSON.stringify({ total: results.length, failed: failed.length, results: results.map(({ edges: _edges, ...result }) => result) }, null, 2)}\n`,
)
const skipped = runs.length - results.length
console.log(
  `\n${results.length - failed.length} of ${results.length} runs passed${skipped > 0 ? `, and ${skipped} more were skipped after the first failure` : ''}. Transcripts and the change lifecycle chart are in ${relative(process.cwd(), artifacts)}/.`,
)
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
