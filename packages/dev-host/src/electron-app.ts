// The pieces the Electron check (electron-check.ts) drives the app with: where it keeps its
// files, how it launches and quits the app, and how it records each check.
//
// Each launch records a Playwright trace, saved to artifacts/ui/trace-electron-<run>.zip as the
// app quits, a failed run's too. Open one with
//   pnpm --filter @letterbox/dev-host exec playwright show-trace "$PWD/artifacts/ui/trace-electron-busy.zip"

import type { ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, type FSWatcher, readFileSync, readlinkSync, watch } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { electronBinary, SHELL } from '@letterbox/desktop-shell/build'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import { localSocket } from '@letterbox/sim-provider/socket'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import type { Paths } from './core.ts'
import { shellEnv } from './desktop.ts'

export const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')
export const ARTIFACTS = join(root, 'artifacts/ui')
export const STATE = join(root, '.letterbox/electron-check')
export const SHELL_LOG = join(ARTIFACTS, 'electron-shell.log')
/** Main's own log, in the user data folder shellEnv gives it. */
export const MAIN_LOG = join(STATE, 'electron/main.log')
/** Bounds on waits that should end long before, so a broken run fails instead of hanging. */
export const WAIT_MS = 30_000

export const seed = devSeeds['people-first']
const DAY = 86_400_000
/** The seed's turns People shows: mine, from the last 30 days, newest first. */
export const yourTurn = seed.conversations
  .filter(
    (conversation) =>
      conversation.turn === 'mine' && Date.parse(seed.now) - Date.parse(conversation.lastAt) <= 30 * DAY,
  )
  .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))
  .map((conversation) => conversation.subject)

export const paths: Paths = {
  root,
  data: join(STATE, 'data'),
  socket: localSocket(join(STATE, 'provider.sock')),
  coreLog: join(STATE, 'core.log'),
}
export const checks: { ok: boolean; what: string }[] = []

/** A check that did not hold. Its message says what was expected and what came, so it needs no stack. */
export class CheckFailure extends Error {}

/** Records a check and fails the run unless the two values are deeply equal. */
export const equal = <Value>(actual: Value, expected: Value, what: string) => {
  const ok = isDeepStrictEqual(actual, expected)
  checks.push({ ok, what })
  if (ok) console.log(`ok   ${what}`)
  else throw new CheckFailure(`${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
}

/** Rejects with `what` if `promise` takes longer than WAIT_MS. */
export const within = <Value>(promise: Promise<Value>, what: string) =>
  new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${WAIT_MS} ms`)), WAIT_MS)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })

export const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type Launched = {
  app: ElectronApplication
  /**
   * Electron's main process, kept from the launch. Use it, never `app.process()`: once Playwright
   * has seen the app close it forgets the app, and `app.process()` throws "Cannot read properties
   * of undefined (reading '_object')". Whether it has, when the process exits, is a race.
   */
  process: ChildProcess
  page: Page
  /** Saves this launch's trace to artifacts/ui/. Only the first call does anything. `quit` calls it. */
  saveTrace(): Promise<void>
  /** Main's log lines from this launch so far. */
  lines(): string[]
  /** Resolves with Electron's exit code. */
  exit: Promise<number | null>
  /** When the launch began, by this machine's clock, which the page shares. */
  startedAt: number
}

/** Launches the app with its page at `renderer`, against the sim, with any extra Chromium `switches`. Main's output goes to the shell log. */
export async function launch(name: string, renderer: string, switches: string[] = []): Promise<Launched> {
  const from = existsSync(MAIN_LOG) ? readFileSync(MAIN_LOG, 'utf8').length : 0
  const startedAt = Date.now()
  // Playwright turns Chromium's sandbox off unless asked. The app runs with it on, so the check does too.
  const app = await _electron
    .launch({
      executablePath: electronBinary(),
      args: [...switches, SHELL],
      cwd: root,
      env: shellEnv(paths, renderer, { kind: 'sim', now: seed.now }),
      chromiumSandbox: true,
      timeout: WAIT_MS,
    })
    .catch((error: unknown) => {
      // Chromium's own words when its sandbox cannot start, as opposed to a sandbox switch in the call log.
      if (!/no usable sandbox|setuid_sandbox|user namespace/i.test(String(error))) throw error
      throw new Error(
        "Electron did not start with Chromium's sandbox on. On Linux the sandbox needs unprivileged user " +
          'namespaces: on Ubuntu 24.04 run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, ' +
          `as .github/workflows/check.yml does. Do not turn the sandbox off.\n${String(error)}`,
      )
    })
  const child = app.process()
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  // Started before the first window, so the trace shows the page loading.
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  let saved: Promise<void> | undefined
  const saveTrace = () =>
    (saved ??= app.context().tracing.stop({ path: join(ARTIFACTS, `trace-electron-${name}.zip`) }))
  // Playwright reads Electron's output from the start, so lines before this point reach main.log only.
  const record = (line: string) => appendFileSync(SHELL_LOG, `${name}: ${line}\n`)
  for (const output of [child.stdout, child.stderr]) if (output) createInterface({ input: output }).on('line', record)
  const lines = () => readFileSync(MAIN_LOG, 'utf8').slice(from).split('\n').filter(Boolean)
  const page = await app.firstWindow()
  page.on('console', (message) => record(`page ${message.type()}: ${message.text()}`))
  page.on('pageerror', (error) => record(`page error: ${error.message}`))
  return { app, process: child, page, saveTrace, lines, exit, startedAt }
}

/**
 * When the first People row painted, by the page's clock. The page checks on every frame and
 * reads the clock one frame after the row is there, once that frame has painted.
 */
export const firstRowPainted = async (page: Page) => {
  const found = await page.waitForFunction(
    () =>
      document.querySelector('[role="option"][data-row] [data-field="subject"]') !== null &&
      new Promise((painted) => requestAnimationFrame(() => painted(Date.now()))),
    null,
    { polling: 'raf', timeout: WAIT_MS },
  )
  return Number(await found.jsonValue())
}

/** The Your turn subjects, top to bottom. */
export const yourTurnShown = (page: Page) =>
  page.getByRole('listbox', { name: 'Your turn' }).locator('[data-field="subject"]').allTextContents()

/** The PIDs of the cores main started, from its log. */
export const corePids = (lines: string[]) =>
  lines.flatMap((line) => /^\[shell\] core (\d+) started/.exec(line)?.[1] ?? []).map(Number)

/** Saves the trace, then quits the app the way a person does and resolves with its exit code. Kills it by PID if it hangs. */
export async function quit(run: Launched) {
  await run.saveTrace()
  await run.app.evaluate(({ app: electron }) => electron.quit())
  return within(run.exit, 'quitting the app').catch((error: unknown) => {
    const { pid } = run.process
    if (pid !== undefined && isRunning(pid)) process.kill(pid, 'SIGKILL')
    throw error
  })
}

/**
 * Launches the app, hands it to `body`, and makes sure it is gone afterwards, even when
 * `body` fails part way: quit as a person does, which saves the trace, then kill it by PID
 * if that hangs.
 */
export async function withApp<Result>(
  name: string,
  renderer: string,
  body: (run: Launched) => Promise<Result>,
  switches: string[] = [],
) {
  const run = await launch(name, renderer, switches)
  try {
    return await body(run)
  } finally {
    if (run.process.exitCode === null && run.process.signalCode === null) await quit(run).catch(() => undefined)
  }
}

/** Checks that the app exited cleanly and left no core running. */
export function checkQuit(name: string, run: Launched, code: number | null, cores = 1) {
  equal(code, 0, `${name}: the app exits with 0`)
  const pids = corePids(run.lines())
  equal(pids.length, cores, `${name}: main started ${cores === 1 ? 'one core' : `${cores} cores, one per page load`}`)
  equal(pids.filter(isRunning), [], `${name}: no core outlives the app`)
}

/** Resolves once main's log from this launch passes `done`. It looks again on every write to main.log. */
export async function untilLogged(run: Launched, done: (lines: string[]) => boolean, what: string) {
  let watcher: FSWatcher | undefined
  try {
    await within(
      new Promise<void>((resolve) => {
        const look = () => done(run.lines()) && resolve()
        watcher = watch(MAIN_LOG, look)
        look()
      }),
      what,
    )
  } finally {
    watcher?.close()
  }
}

/** Chromium switches that turn some or all of its sandbox off. */
const SANDBOX_OFF = [
  '--no-sandbox',
  '--disable-seccomp-filter-sandbox',
  '--disable-namespace-sandbox',
  '--disable-setuid-sandbox',
  '--no-zygote-sandbox',
]

/** How many seccomp filters the kernel says the process `pid` runs under. NaN if it does not say. */
const seccompFilters = (pid: number | undefined) =>
  Number(/^Seccomp_filters:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? Number.NaN)

/**
 * Why the window's page is not in the OS sandbox, or an empty list when it is. On Linux the
 * kernel is asked, through /proc, and three things must hold for the renderer process:
 *   - its command line has no switch that turns the sandbox off;
 *   - it has a PID namespace of its own, apart from main's;
 *   - Chromium's own seccomp-bpf filter is on it: it carries more filters than main, so the
 *     count is not just what both inherited from whatever started them.
 * On macOS and Windows there is no /proc, so this takes Electron's word for it: the renderer's
 * entry in app.getAppMetrics() says `sandboxed`. That is Chromium reporting that it started the
 * process under its sandbox (Seatbelt on macOS, a restricted token and job on Windows), not an
 * outside look at the process.
 */
export async function sandboxGaps(run: Launched): Promise<string[]> {
  const pid = await run.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId(),
  )
  if (pid === undefined) return ['the app has no window to check']
  if (process.platform !== 'linux') {
    const metric = await run.app.evaluate(
      ({ app }, renderer) => app.getAppMetrics().find((candidate) => candidate.pid === renderer),
      pid,
    )
    return metric?.sandboxed === true ? [] : ['Electron reports the renderer as not sandboxed']
  }
  const main = run.process.pid
  // A zygote child rewrites its command line into one string, so split it on spaces too.
  const switches = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/)
  const gaps = SANDBOX_OFF.filter((off) => switches.includes(off)).map((off) => `the renderer runs with ${off}`)
  if (readlinkSync(`/proc/${pid}/ns/pid`) === readlinkSync(`/proc/${main}/ns/pid`)) {
    gaps.push("the renderer shares main's PID namespace")
  }
  const own = seccompFilters(pid)
  const inherited = seccompFilters(main)
  if (Number.isNaN(own) || Number.isNaN(inherited)) gaps.push('the kernel does not report Seccomp_filters')
  else if (own <= inherited) gaps.push(`the renderer has ${own} seccomp filters, no more than main's ${inherited}`)
  return gaps
}
