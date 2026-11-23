// `pnpm dev`: the renderer in a plain browser, against fake mail.
// `pnpm dev:desktop`: the same renderer in the desktop shell, whose main starts the core.
//
//   node packages/dev-host/src/main.ts [--seed people-first] [--port <n>] [--state <dir>]
//                                      [--desktop [--core sim|gmail]]
//
// Builds core-sim, starts the sim provider with a named seed (packages/sim-provider/src/seeds.ts)
// and the fake web with the seed's images, signs a core in to the provider, and serves the
// renderer through Vite with `/core` relayed to a core. Every sim core fetches images from the fake web.
// Prints one line, `[dev] http://127.0.0.1:<port>/`, once the page is ready.
//
// With --desktop it serves the renderer with `/core` off and opens it in the Electron shell
// (desktop.ts), with HMR. The shell's main starts the core exactly as the app does. It prints
// `[dev] desktop <url>` and stops when the app quits. The shell's log is in <state>/shell.log.
// `--core gmail` runs the app's real core, letterbox-core, against Gmail instead of the sim.
// It needs LETTERBOX_GMAIL_CLIENT, the path to a Google OAuth client file of type Desktop app,
// and keeps its store in `.letterbox/gmail/`, which no run empties. With no account signed in,
// the page starts the core's OAuth sign-in, and the shell opens Google's consent page in the
// browser. After consent the account syncs, and a later run resumes it. Its session goes to the
// system keychain under the service "letterbox" (crates/keychain says where each OS shows it):
//
//   LETTERBOX_GMAIL_CLIENT=<client.json> pnpm dev:desktop --core gmail          Linux, macOS
//   $env:LETTERBOX_GMAIL_CLIENT='<client.json>'; pnpm dev:desktop --core gmail   Windows PowerShell
//
// It runs on Linux, macOS and Windows. On Windows, run it with Windows' own Node, pnpm and Rust
// (MSVC) from PowerShell or cmd, in a checkout on the Windows disk: from WSL it builds Linux
// programs. The sim provider listens on a named pipe there instead of a unix socket. On macOS
// the first keychain access asks to allow letterbox-core. A debug build is not signed, so macOS
// may ask again after each rebuild. On Linux Electron needs a display (see desktop.ts).
//
// State lives in the worktree's `.letterbox/dev/` (or `--state`, which must also be under
// `.letterbox/`) and starts empty on every run, so every run shows the same mailbox.
// The port comes from the worktree path (port.ts). `--port 0` lets the system pick one.
// On exit it stops every process it started, by PID (children.ts). On Windows that stop is a
// kill, as Windows has no SIGTERM. The shell's core then sees its input close, and exits.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { devSeeds, isDevSeedName } from '@letterbox/sim-provider/seeds'
import { localSocket } from '@letterbox/sim-provider/socket'
import { type Child, exited, killChildrenNow, logChildrenTo, stopChild, stopChildren } from './children.ts'
import { buildCore, type Paths } from './core.ts'
import { launchDesktop, missingDisplay } from './desktop.ts'
import { portFor } from './port.ts'
import { type DevServer, startServer } from './server.ts'
import { type RunningSim, startSim } from './sim.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')

/**
 * Unix socket paths longer than this many bytes, in UTF-8, do not fit in sockaddr_un: 108 bytes
 * on Linux and 104 on macOS, less the closing zero. Windows uses a named pipe, whose name is short and fixed.
 */
const MAX_SOCKET_PATH = process.platform === 'darwin' ? 103 : process.platform === 'linux' ? 107 : Infinity

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
    desktop: { type: 'boolean', default: false },
    core: { type: 'string', default: 'sim' },
  },
})

const core = values.core
if (core !== 'sim' && core !== 'gmail') fail(`--core ${core} is not a core. Use sim or gmail.`)
if (core === 'gmail' && !values.desktop) fail('--core gmail runs in the desktop shell only. Add --desktop.')
const display = values.desktop ? missingDisplay() : undefined
if (display !== undefined) fail(display)

const seedName = values.seed
if (!isDevSeedName(seedName)) fail(`no seed named "${seedName}". Seeds: ${Object.keys(devSeeds).join(', ')}.`)
const devSeed = devSeeds[seedName]

const port = values.port === undefined ? portFor(root) : Number(values.port)
if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`--port ${values.port} is not a port number.`)

/** True when `inner` is `outer` or a folder inside it. */
const isWithin = (outer: string, inner: string) => {
  const path = relative(outer, inner)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** The real core's store, kept across runs. No --state may empty it. */
const GMAIL = join(root, '.letterbox/gmail')

const state = resolve(root, values.state)
const underLetterbox = relative(join(root, '.letterbox'), state)
if (underLetterbox === '' || underLetterbox.startsWith('..') || isAbsolute(underLetterbox)) {
  fail('--state must be a folder inside .letterbox/, because the dev host empties it on every start.')
}
if (isWithin(GMAIL, state) || isWithin(state, GMAIL)) {
  fail(
    `--state ${values.state} would empty .letterbox/gmail, where the real core keeps its store. ` +
      'Use a folder beside it, such as .letterbox/dev or .letterbox/desktop.',
  )
}
const paths: Paths = {
  root,
  // The real core keeps its store across runs, outside the state folder that every start empties.
  data: core === 'gmail' ? join(GMAIL, 'core') : join(state, 'data'),
  socket: localSocket(join(state, 'provider.sock')),
  coreLog: join(state, 'core.log'),
}
if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH)
  fail(`the sim socket path is too long for a unix socket: ${paths.socket}`)

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
mkdirSync(state, { recursive: true })
mkdirSync(paths.data, { recursive: true })
writeFileSync(lock, String(process.pid))
logChildrenTo(join(state, 'host.log'))

let stopping: Promise<void> | undefined
let running: RunningSim | undefined
let server: DevServer | undefined
let desktop: Child | undefined

/** Stops the app, the server, the provider, the fake web and every child, then exits with `code`. Safe to call more than once. */
const shutdown = (code: number) => {
  stopping ??= (async () => {
    // The app and the server first: they stop the cores, which are still talking to the provider and the web.
    if (desktop) await stopChild(desktop)
    await server?.close().catch(() => undefined)
    await running?.close()
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
  if (!values.desktop) {
    running = await startSim(paths, devSeed)
    server = await startServer({ paths, port, relay: true, sim: running.sim })
    console.log(`[dev] ${server.url}`)
  } else {
    const shellLog = join(state, 'shell.log')
    if (core === 'gmail') {
      await buildCore(paths, 'letterbox-core')
      server = await startServer({ paths, port, relay: false, sim: undefined })
      const client = process.env.LETTERBOX_GMAIL_CLIENT
      // The renderer starts Gmail's OAuth sign-in when no account is signed in (apps/desktop/renderer/src/dev.ts).
      desktop = await launchDesktop(paths, `${server.url}?sign-in=oauth`, { kind: 'gmail', client }, shellLog)
    } else {
      running = await startSim(paths, devSeed)
      server = await startServer({ paths, port, relay: false, sim: running.sim })
      const simCore = { kind: 'sim', now: devSeed.now, web: running.web.url } as const
      desktop = await launchDesktop(paths, server.url, simCore, shellLog)
    }
    const app = desktop
    console.log(`[dev] desktop ${server.url}`)
    void exited(app).then(() => {
      if (app.exitCode !== 0) {
        const tail = readFileSync(shellLog, 'utf8').trim().split('\n').slice(-10).join('\n')
        console.error(`[dev] the desktop app exited with ${app.exitCode}. The end of ${shellLog}:\n${tail}`)
      }
      void shutdown(app.exitCode ?? 1)
    })
  }
} catch (error) {
  console.error(`[dev] could not start: ${error instanceof Error ? error.message : String(error)}`)
  await shutdown(1)
}
