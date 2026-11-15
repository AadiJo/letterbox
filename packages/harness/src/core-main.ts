// The core as a process, wired to the sim provider. This is what every
// scenario talks to: one JSON message per line on stdin, one per line on stdout.
//
//   node packages/harness/src/core-main.ts --data <folder> --sim <socket> [--now <time>]
//
// A real app gets its own entry point with real adapters. Nothing here is test
// logic inside the core: this file only chooses which factories and clock it gets.

import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { createCore } from '@letterbox/core'
import { fixedEnvironment } from '@letterbox/core/clock'
import { simAdapterFactories } from '@letterbox/sim-provider/client'

const { values } = parseArgs({
  options: { data: { type: 'string' }, sim: { type: 'string' }, now: { type: 'string' } },
})
if (!values.data || !values.sim) {
  process.stderr.write('usage: core-main.ts --data <folder> --sim <socket> [--now <time>]\n')
  process.exit(2)
}

const core = createCore({
  dataPath: values.data,
  env: fixedEnvironment(values.now ?? '2026-01-01T00:00:00.000Z'),
  factories: simAdapterFactories(values.sim),
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  log: (line) => process.stderr.write(`${line}\n`),
})

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue
  let value: unknown = line
  try {
    value = JSON.parse(line)
  } catch {
    // Leave the raw text in place. The core answers it with a protocol-error.
  }
  core.receive(value)
}
await core.close()
