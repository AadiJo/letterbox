// `pnpm dev` as the UI check runs it: main.ts in a child process, on a free port, over a
// state folder of its own. After it stops, every process it started must be gone.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { DevSeedName } from '@letterbox/sim-provider/seeds'
import { equal, root } from './record.ts'

/** Long enough for cargo to build core-sim from cold. */
const START_MS = 600_000
const STOP_MS = 10_000

/** Starts main.ts with `seed` over `state`. `url` resolves once it prints its line. */
export function startDevHost(seed: DevSeedName, state: string) {
  const child = spawn(
    process.execPath,
    ['packages/dev-host/src/main.ts', '--seed', seed, '--port', '0', '--state', state],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const stdout: string[] = []
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()))
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the dev host printed no URL within ${START_MS} ms`)), START_MS)
    createInterface({ input: child.stdout }).on('line', (line) => {
      stdout.push(line)
      const found = /^\[dev\] (http:\/\/127\.0\.0\.1:\d+\/)$/.exec(line)?.[1]
      if (found === undefined) return
      clearTimeout(timer)
      resolve(found)
    })
    void exit.then((code) => {
      clearTimeout(timer)
      reject(new Error(`the dev host exited with ${code} before it was ready:\n${stderr}`))
    })
  })

  /** Sends SIGTERM by PID and resolves with the exit code. SIGKILL, and a failure, if it takes longer than STOP_MS. */
  const stop = async () => {
    if (child.exitCode !== null) return child.exitCode
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS)
    const code = await exit
    clearTimeout(timer)
    return code
  }

  /** Stops the host and checks it left nothing behind. `cores` is how many cores it should have started. */
  const stopAndCheck = async (cores: number) => {
    const code = await stop()
    equal(code, 0, `${seed}: the dev host exits cleanly on SIGTERM`)
    equal(stdout.length, 1, `${seed}: the dev host prints one line`)
    // children.ts logs each start and exit. Every child must have exited, and none may still run.
    const log = readFileSync(join(root, state, 'host.log'), 'utf8')
    const started = [...log.matchAll(/^started (\d+) /gm)].map((match) => Number(match[1]))
    const exitedPids = new Set([...log.matchAll(/^exited (\d+)$/gm)].map((match) => Number(match[1])))
    // cargo, the core that signs in, and one core per page load.
    equal(started.length, 2 + cores, `${seed}: the dev host started cargo and ${1 + cores} cores`)
    equal(
      started.filter((pid) => !exitedPids.has(pid) || isRunning(pid)),
      [],
      `${seed}: every process the dev host started has exited`,
    )
  }

  return { url, stop, stopAndCheck, stderr: () => stderr }
}

export function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
