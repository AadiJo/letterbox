// T3 Code's "Setup Worktree" script (t3.json): installs packages and builds core-sim in debug,
// so `pnpm dev` and `pnpm check` start fast in a new worktree. It runs before `pnpm install`,
// so it imports only Node's own modules.
//
// An agent reads its progress from `.letterbox/`:
//   setup-running   this script's PID, while it runs
//   setup-done      written once both steps pass
//   setup-failed    the step that failed and the end of its output

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const folder = join(root, '.letterbox')
const RUNNING = join(folder, 'setup-running')
const DONE = join(folder, 'setup-done')
const FAILED = join(folder, 'setup-failed')
/** How many lines of a failed step's output go into setup-failed. */
const TAIL = 60

/** Runs one step, echoing its output. Resolves null if it passes, else the step and the end of its output. */
const run = (command: string, args: string[]) =>
  new Promise<string | null>((resolve) => {
    let output = ''
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => {
      to.write(chunk)
      output += chunk.toString()
    }
    child.stdout.on('data', (chunk: Buffer) => keep(chunk, process.stdout))
    child.stderr.on('data', (chunk: Buffer) => keep(chunk, process.stderr))
    const step = [command, ...args].join(' ')
    child.on('error', (error) => resolve(`${step} could not start: ${error.message}`))
    child.on('exit', (code) =>
      resolve(
        code === 0 ? null : `${step} failed with exit code ${code}:\n${output.split('\n').slice(-TAIL).join('\n')}`,
      ),
    )
  })

/** Ends the run: writes the marker and removes setup-running. */
const finish = (marker: string, text: string) => {
  writeFileSync(marker, text)
  rmSync(RUNNING, { force: true })
}

mkdirSync(folder, { recursive: true })
for (const marker of [DONE, FAILED]) rmSync(marker, { force: true })
writeFileSync(RUNNING, String(process.pid))

const failed =
  (await run('pnpm', ['install', '--frozen-lockfile'])) ?? (await run('cargo', ['build', '--bin', 'core-sim']))

if (failed !== null) {
  finish(FAILED, `${failed}\n`)
  console.error("setup failed. The end of the failed step's output is in .letterbox/setup-failed.")
  process.exitCode = 1
} else {
  finish(DONE, `${new Date().toISOString()}\n`)
  console.log('setup done: packages installed and core-sim built.')
}
