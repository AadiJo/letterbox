// `pnpm dev`: the renderer in a plain browser, against fake mail.
//
//   node packages/dev-host/src/main.ts [--seed people-first] [--port <n>] [--state <dir>]
//
// Builds core-sim, starts the sim provider with a named seed (packages/sim-provider/src/seeds.ts),
// signs a core in to it, and serves the renderer through Vite with `/core` relayed to a core.
// Prints one line, `[dev] http://127.0.0.1:<port>/`, once the page is ready.
//
// State lives in the worktree's `.letterbox/dev/` (or `--state`, which must also be under
// `.letterbox/`) and starts empty on every run, so every run shows the same mailbox.
// The port comes from the worktree path (port.ts). `--port 0` lets the system pick one.
// On exit it stops every process it started, by PID (children.ts).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { devSeeds, isDevSeedName } from '@letterbox/sim-provider/seeds'
import type { SimProvider } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import { killChildrenNow, logChildrenTo, stopChildren } from './children.ts'
import { buildCore, type Paths, signIn } from './core.ts'
import { portFor } from './port.ts'
import { type DevServer, startServer } from './server.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')

/** Unix socket paths longer than this do not fit in sockaddr_un on Linux. */
const MAX_SOCKET_PATH = 107

/** Prints why the dev host cannot start, then exits. */
function fail(reason: string): never {
  console.error(`[dev] ${reason}`)
  process.exit(1)
}

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: 'people-first' },
    port: { type: 'string' },
    state: { type: 'string', default: '.letterbox/dev' },
  },
})

const seedName = values.seed
if (!isDevSeedName(seedName)) fail(`no seed named "${seedName}". Seeds: ${Object.keys(devSeeds).join(', ')}.`)
const devSeed = devSeeds[seedName]

const port = values.port === undefined ? portFor(root) : Number(values.port)
if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`--port ${values.port} is not a port number.`)

const state = resolve(root, values.state)
const underLetterbox = relative(join(root, '.letterbox'), state)
if (underLetterbox === '' || underLetterbox.startsWith('..') || isAbsolute(underLetterbox)) {
  fail('--state must be a folder inside .letterbox/, because the dev host empties it on every start.')
}
const paths: Paths = {
  root,
  data: join(state, 'data'),
  socket: join(state, 'provider.sock'),
  coreLog: join(state, 'core.log'),
}
if (paths.socket.length > MAX_SOCKET_PATH) fail(`the sim socket path is too long for a unix socket: ${paths.socket}`)

// One dev host per state folder. Starting clears the folder, which would pull the store out from under another.
const lock = join(state, 'host.pid')
const holder = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : undefined
if (holder !== undefined && holder !== process.pid && isAlive(holder)) {
  fail(`another dev host (pid ${holder}) is using ${relative(root, state)}. Stop it, or pass another --state.`)
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

rmSync(state, { recursive: true, force: true })
mkdirSync(paths.data, { recursive: true })
writeFileSync(lock, String(process.pid))
logChildrenTo(join(state, 'host.log'))

let stopping: Promise<void> | undefined
let provider: SimProvider | undefined
let server: DevServer | undefined

/** Stops the server, the provider and every child, then exits with `code`. Safe to call more than once. */
const shutdown = (code: number) => {
  stopping ??= (async () => {
    // The server first: it stops the tab's core, which is still talking to the provider.
    await server?.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    await stopChildren()
    rmSync(lock, { force: true })
    process.exit(code)
  })()
  return stopping
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(0))
// Last chance, if something exits the process another way. It cannot wait, so it kills.
process.on('exit', killChildrenNow)

try {
  await buildCore(paths)
  provider = await startSimProvider(paths.socket)
  const mailbox = provider.createMailbox(devSeed.dialect, devSeed.seed)
  await signIn(paths, devSeed.now, devSeed.seed.address, devSeed.seed.password)

  let delivered = 0
  server = await startServer({
    paths,
    port,
    now: devSeed.now,
    deliver: (count) => {
      for (let index = 0; index < count; index += 1) mailbox.deliver(devSeed.delivery(delivered++))
    },
  })
  console.log(`[dev] ${server.url}`)
} catch (error) {
  console.error(`[dev] could not start: ${error instanceof Error ? error.message : String(error)}`)
  await shutdown(1)
}
