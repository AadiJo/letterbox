// The end-to-end Electron check, run by `pnpm check:electron` and `pnpm check`.
//
// Builds the shell and a renderer, signs the people-first seed in at the sim provider, and
// launches the app with Playwright's Electron driver. Main starts core-sim itself, as it
// starts letterbox-core in the app. Four runs, each a fresh app over the same store:
//   built     the built renderer on app://. The first row paints, the core's messages go
//             over the MessagePort and nothing opens a WebSocket, the page is sandboxed
//             and its policy blocks inline script. Quitting lets the idle core finish.
//   busy      the Vite renderer, as `pnpm dev:desktop` runs it. A reload gets a new core.
//             Then the core is made to wait on a snapshot page the provider holds, and the
//             app quits while it waits. Main waits STOP_MS, then kills the core by PID.
//   crash     the built renderer. The core is killed under the app, and the page says so.
//   gmail     real mode with no client file, and with one that does not exist. Main exits
//             with 1 and says what to set, before any window or core.
// Every core main started must be gone once its app has quit.
//
// Writes electron.json (the checks and the cold start, from launch to the first painted
// row), screenshots and the shell's log to artifacts/ui/.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildShell, electronBinary, SHELL } from '@letterbox/desktop-shell/build'
import { STOP_MS } from '@letterbox/desktop-shell/core'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { exited, killChildrenNow, logChildrenTo, startChild, stopChildren } from './children.ts'
import type { Paths } from './core.ts'
import { missingDisplay, shellEnv } from './desktop.ts'
import { type DevServer, startServer } from './server.ts'
import { type RunningSim, startSim } from './sim.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
const ARTIFACTS = join(root, 'artifacts/ui')
const STATE = join(root, '.letterbox/electron-check')
const SHELL_LOG = join(ARTIFACTS, 'electron-shell.log')
/** Main's own log, in the user data folder shellEnv gives it. */
const MAIN_LOG = join(STATE, 'electron/main.log')
/** Bounds on waits that should end long before, so a broken run fails instead of hanging. */
const WAIT_MS = 30_000

const seed = devSeeds['people-first']
const yourTurn = seed.conversations
  .filter((conversation) => conversation.turn === 'mine')
  .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))
  .map((conversation) => conversation.subject)

const paths: Paths = {
  root,
  data: join(STATE, 'data'),
  socket: join(STATE, 'provider.sock'),
  coreLog: join(STATE, 'core.log'),
}
const checks: { ok: boolean; what: string }[] = []
let failure: string | null = null

/** Records a check and fails the run unless the two values are deeply equal. */
const equal = <Value>(actual: Value, expected: Value, what: string) => {
  const ok = isDeepStrictEqual(actual, expected)
  checks.push({ ok, what })
  if (ok) console.log(`ok   ${what}`)
  else throw new Error(`${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
}

/** Rejects with `what` if `promise` takes longer than WAIT_MS. */
const within = <Value>(promise: Promise<Value>, what: string) =>
  new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${WAIT_MS} ms`)), WAIT_MS)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Launched = {
  app: ElectronApplication
  page: Page
  /** Main's log lines from this launch so far. */
  lines(): string[]
  /** Resolves with Electron's exit code. */
  exit: Promise<number | null>
  /** When the launch began, by this machine's clock, which the page shares. */
  startedAt: number
}

/** Launches the app with its page at `renderer`, against the sim. Main's output goes to the shell log. */
async function launch(name: string, renderer: string): Promise<Launched> {
  const from = existsSync(MAIN_LOG) ? readFileSync(MAIN_LOG, 'utf8').length : 0
  const startedAt = Date.now()
  const app = await _electron.launch({
    executablePath: electronBinary(),
    args: [SHELL],
    cwd: root,
    env: shellEnv(paths, renderer, { kind: 'sim', now: seed.now }),
  })
  const child = app.process()
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  // Playwright reads Electron's output from the start, so lines before this point reach main.log only.
  const record = (line: string) => appendFileSync(SHELL_LOG, `${name}: ${line}\n`)
  for (const output of [child.stdout, child.stderr]) if (output) createInterface({ input: output }).on('line', record)
  const lines = () => readFileSync(MAIN_LOG, 'utf8').slice(from).split('\n').filter(Boolean)
  const page = await app.firstWindow()
  page.on('console', (message) => record(`page ${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => record(`page error: ${error.message}`))
  return { app, page, lines, exit, startedAt }
}

/**
 * When the first People row painted, by the page's clock. The page checks on every frame and
 * reads the clock one frame after the row is there, once that frame has painted.
 */
const firstRowPainted = async (page: Page) => {
  const found = await page.waitForFunction(
    () =>
      document.querySelector('section li') !== null &&
      new Promise((painted) => requestAnimationFrame(() => painted(Date.now()))),
    null,
    { polling: 'raf', timeout: WAIT_MS },
  )
  return Number(await found.jsonValue())
}

/** The Your turn subjects, top to bottom. */
const yourTurnShown = (page: Page) =>
  page.getByRole('region', { name: 'Your turn' }).locator('[data-field="subject"]').allTextContents()

/** The PIDs of the cores main started, from its log. */
const corePids = (lines: string[]) =>
  lines.flatMap((line) => /^\[shell\] core (\d+) started/.exec(line)?.[1] ?? []).map(Number)

/** Quits the app the way a person does and resolves with its exit code. Kills it by PID if it hangs. */
async function quit({ app, exit }: Launched) {
  await app.evaluate(({ app: electron }) => electron.quit())
  return within(exit, 'quitting the app').catch((error: unknown) => {
    const { pid } = app.process()
    if (pid !== undefined && isRunning(pid)) process.kill(pid, 'SIGKILL')
    throw error
  })
}

/**
 * Launches the app, hands it to `body`, and makes sure it is gone afterwards, even when
 * `body` fails part way: quit as a person does, then kill it by PID if that hangs.
 */
async function withApp<Result>(name: string, renderer: string, body: (run: Launched) => Promise<Result>) {
  const run = await launch(name, renderer)
  try {
    return await body(run)
  } finally {
    const child = run.app.process()
    if (child.exitCode === null && child.signalCode === null) await quit(run).catch(() => undefined)
  }
}

/** Checks that the app exited cleanly and left no core running. */
function checkQuit(name: string, run: Launched, code: number | null, cores = 1) {
  equal(code, 0, `${name}: the app exits with 0`)
  const pids = corePids(run.lines())
  equal(pids.length, cores, `${name}: main started ${cores === 1 ? 'one core' : `${cores} cores, one per page load`}`)
  equal(pids.filter(isRunning), [], `${name}: no core outlives the app`)
}

/** The built run: cold start, the MessagePort, the sandbox and the policy, and a clean quit. */
const builtRun = (renderer: string) =>
  withApp('built', renderer, async (run) => {
    const { page } = run
    const sockets: string[] = []
    const errors: string[] = []
    page.on('websocket', (socket) => sockets.push(socket.url()))
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))

    const paintedAt = await firstRowPainted(page)
    const pageAt = await page.evaluate(() => performance.timeOrigin)
    const coldStart = { ms: paintedAt - run.startedAt, toPageMs: Math.round(pageAt - run.startedAt) }
    console.log(
      `     cold start: ${coldStart.ms} ms from launch to the first painted row (page began at ${coldStart.toPageMs} ms)`,
    )
    await page.screenshot({ path: join(ARTIFACTS, 'electron.png') })
    equal(await yourTurnShown(page), yourTurn, "built: Your turn shows the seed's rows, newest first")
    equal(new URL(page.url()).protocol, 'app:', 'built: the page comes from app://, not a server')
    equal(
      await page.evaluate(() => ({
        bridge: Object.keys(window.letterbox ?? {}).toSorted(),
        platform: window.letterbox?.platform,
        node: [typeof Reflect.get(window, 'require'), typeof Reflect.get(window, 'process')],
      })),
      { bridge: ['connect', 'platform'], platform: process.platform, node: ['undefined', 'undefined'] },
      'built: the page sees only the bridge, and no Node',
    )
    equal(
      await page.evaluate(() => window.open('https://example.com/') === null),
      true,
      'built: new windows are denied',
    )
    equal(errors, [], 'built: the page logged no errors')
    equal(sockets, [], 'built: the page opened no WebSocket')
    // The policy allows no inline script, so this one never runs. Its refusal logs an error, so it goes last.
    const inline = await page.evaluate(() => {
      const script = document.createElement('script')
      script.textContent = 'document.body.dataset.inline = "ran"'
      document.head.append(script)
      return document.body.dataset.inline ?? 'blocked'
    })
    equal(inline, 'blocked', 'built: the content security policy blocks inline script')

    const code = await quit(run)
    checkQuit('built', run, code)
    const relayed = run.lines().flatMap((line) => /(\d+) lines to the page, (\d+) from it$/.exec(line)?.slice(1) ?? [])
    equal(
      relayed.map((count) => Number(count) > 0),
      [true, true],
      'built: every core message went over the MessagePort, both ways',
    )
    equal(
      run.lines().some((line) => line.endsWith('stopped: finished its work')),
      true,
      'built: the idle core finished on its own when its input closed',
    )
    return coldStart
  })

/** The busy run: quit while the core waits on the provider, with the order set by the provider's hold. */
const busyRun = (sim: RunningSim, server: DevServer) =>
  withApp('busy', server.url, async (run) => {
    await firstRowPainted(run.page)
    // A reload is a new page, as after an HMR full reload. Main stops the first core, then starts its own.
    await run.page.reload()
    await firstRowPainted(run.page)
    equal(
      run.lines().filter((line) => line.endsWith('stopped: finished its work')).length,
      1,
      'busy: a reload stops the first core before the next one starts',
    )
    await run.page.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
    // A delivery syncs. With the cursor expired the sync starts a snapshot, and its first page waits.
    sim.mailbox.expireCursors()
    sim.mailbox.holdSnapshots()
    await run.page.evaluate(() => void window.letterboxDev?.deliver(1).catch(() => {}))
    await within(sim.mailbox.snapshotHeld(), 'the core asking for a snapshot page')
    const quitAt = Date.now()
    const code = await quit(run)
    const tookMs = Date.now() - quitAt
    sim.mailbox.releaseSnapshots()
    checkQuit('busy', run, code, 2)
    equal(
      run.lines().some((line) => line.endsWith(`stopped: killed after ${STOP_MS} ms`)),
      true,
      `busy: main killed the core still at work after ${STOP_MS} ms`,
    )
    equal(tookMs >= STOP_MS, true, `busy: the app waited for its core before it quit (${tookMs} ms)`)
  })

/** The crash run: the core dies under the app, and the page says so. */
const crashRun = (renderer: string) =>
  withApp('crash', renderer, async (run) => {
    await firstRowPainted(run.page)
    const [pid] = corePids(run.lines())
    if (pid === undefined) throw new Error('main logged no core PID')
    process.kill(pid, 'SIGKILL')
    const alert = run.page.getByRole('alert')
    await alert.waitFor({ timeout: WAIT_MS })
    equal(
      (await alert.textContent())?.includes('the core exited on SIGKILL'),
      true,
      'crash: the page shows that the core exited',
    )
    await run.page.screenshot({ path: join(ARTIFACTS, 'electron-core-lost.png') })
    const code = await quit(run)
    checkQuit('crash', run, code)
    equal(
      run.lines().some((line) => line.endsWith('stopped: had already exited')),
      true,
      'crash: nothing restarted the core',
    )
  })

/**
 * Builds the renderer for app://, with ages measured from the seed's time. It runs in a
 * process of its own: a build sets NODE_ENV to production for the process it runs in, and
 * the busy run's dev server must stay in development.
 */
async function buildRenderer(outDir: string) {
  const folder = join(root, 'apps/desktop/renderer')
  const env = { ...process.env, VITE_LETTERBOX_NOW: seed.now }
  const args = ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn']
  const vite = startChild(join(folder, 'node_modules/.bin/vite'), args, folder, env)
  let output = ''
  for (const stream of [vite.stdout, vite.stderr])
    stream.on('data', (chunk: Buffer) => void (output += chunk.toString()))
  await exited(vite)
  if (vite.exitCode !== 0) throw new Error(`the renderer did not build:\n${output}`)
}

/** Real mode without a usable client file: main exits with 1 and says what to set, before any core. */
function gmailRun(renderer: string) {
  const cases = [
    { client: undefined, says: 'LETTERBOX_GMAIL_CLIENT is not set' },
    { client: join(STATE, 'no-such-client.json'), says: 'no-such-client.json, which does not exist' },
  ]
  for (const { client, says } of cases) {
    const env = shellEnv(paths, renderer, { kind: 'gmail', client })
    const run = spawnSync(electronBinary(), [SHELL], { cwd: root, env, encoding: 'utf8', timeout: WAIT_MS })
    appendFileSync(SHELL_LOG, `gmail: ${run.stdout}${run.stderr}`)
    equal(
      run.status,
      1,
      `gmail: with ${client === undefined ? 'no client file' : 'a missing client file'}, main exits with 1`,
    )
    equal(run.stderr.includes(says), true, `gmail: main says "${says}"`)
    equal(run.stdout.includes('core'), false, 'gmail: main started no core')
  }
}

const display = missingDisplay()
if (display !== undefined) {
  console.error(`FAIL ${display}`)
  process.exit(1)
}

rmSync(STATE, { recursive: true, force: true })
mkdirSync(paths.data, { recursive: true })
mkdirSync(ARTIFACTS, { recursive: true })
for (const file of ['electron.json', 'electron.png', 'electron-core-lost.png', 'electron-shell.log']) {
  rmSync(join(ARTIFACTS, file), { force: true })
}
logChildrenTo(join(STATE, 'host.log'))
process.on('exit', killChildrenNow)

let sim: RunningSim | undefined
let server: DevServer | undefined
let coldStart: { ms: number; toPageMs: number } | null = null
try {
  sim = await startSim(paths, seed)
  const renderer = join(STATE, 'renderer')
  await buildRenderer(renderer)
  await buildShell()
  coldStart = await builtRun(renderer)
  server = await startServer({ paths, port: 0, relay: false, sim: sim.sim })
  await busyRun(sim, server)
  await crashRun(renderer)
  gmailRun(renderer)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`FAIL ${message}`)
  failure = message
}
await server?.close().catch(() => undefined)
await sim?.provider.close().catch(() => undefined)
await stopChildren()

const host = readFileSync(join(STATE, 'host.log'), 'utf8')
const started = [...host.matchAll(/^started (\d+) /gm)].map((match) => Number(match[1]))
if (started.some(isRunning)) failure ??= 'a process the check started is still running'

writeFileSync(
  join(ARTIFACTS, 'electron.json'),
  `${JSON.stringify(
    {
      passed: failure === null,
      failure,
      coldStart: {
        ...coldStart,
        from: 'Playwright launching Electron, which holds back the ready event until it attaches',
        toPage: 'the page starts to load',
        to: 'the frame after the first People row is in the page',
      },
      electron: electronVersion(),
      checks,
    },
    null,
    2,
  )}\n`,
)

function electronVersion() {
  return spawnSync(electronBinary(), ['--version'], { encoding: 'utf8' }).stdout.trim()
}

console.log(
  `\n${checks.filter((check) => check.ok).length} of ${checks.length} Electron checks passed. electron.json, screenshots and the shell log are in artifacts/ui/.`,
)
process.exitCode = failure === null ? 0 : 1
