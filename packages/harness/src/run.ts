// Runs every scenario against every dialect.
//
//   node packages/harness/src/run.ts            all scenarios
//   node packages/harness/src/run.ts archive    only scenarios whose name contains "archive"
//
// Writes one transcript per run and a summary to artifacts/scenarios/.
// Exits 1 if any scenario fails.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lifecycleChart } from './invariants.ts'
import { ARTIFACTS, definitions, type Result, runOne } from './scenario.ts'

const scenarioFolder = fileURLToPath(new URL('../scenarios/', import.meta.url))
for (const file of readdirSync(scenarioFolder).toSorted()) {
  if (file.endsWith('.ts')) await import(pathToFileURL(join(scenarioFolder, file)).href)
}

const only = process.argv[2]
const chosen = definitions.filter((definition) => !only || definition.name.includes(only))
const artifacts = ARTIFACTS
if (!only) rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const results: Result[] = []
for (const definition of chosen) {
  for (const dialect of definition.dialects) {
    const result = await runOne(definition, dialect)
    results.push(result)
    console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${definition.name} (${dialect})`)
    if (result.failure) console.log(`      ${result.failure.replaceAll('\n', '\n      ')}`)
  }
}

const failed = results.filter((result) => !result.passed)
writeFileSync(join(artifacts, 'change-lifecycle.mmd'), lifecycleChart(results.flatMap((result) => result.edges)))
writeFileSync(
  join(artifacts, 'summary.json'),
  `${JSON.stringify({ total: results.length, failed: failed.length, results: results.map(({ edges: _edges, ...result }) => result) }, null, 2)}\n`,
)
console.log(
  `\n${results.length - failed.length} of ${results.length} runs passed. Transcripts and the change lifecycle chart are in artifacts/scenarios/.`,
)
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1)
