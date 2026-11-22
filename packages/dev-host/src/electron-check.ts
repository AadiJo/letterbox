// The end-to-end Electron check, run by `pnpm check:electron` and `pnpm check`.
//
// Builds the shell and a renderer, signs the people-first seed in at the sim provider, and
// launches the app with Playwright's Electron driver. Main starts core-sim itself, as it
// starts letterbox-core in the app. Seven runs, each a fresh app over the same store:
//   built     the built renderer on app://. The first row paints, the core's messages go
//             over the MessagePort and nothing opens a WebSocket, the page runs in the OS
//             sandbox with no switch turning it off, and its policy blocks inline script.
//             Quitting lets the idle core finish.
//   busy      the Vite renderer, as `pnpm dev:desktop` runs it. Two reloads while main stops
//             a busy core leave the newest page with a live core of its own. Then the app
//             quits while its core waits on the provider: main waits STOP_MS, then kills it.
//   crash     the built renderer. The core is killed under the app, and the page says so.
//   redirect  a dev URL that redirects to another origin. Main blocks it.
//   insecure  a plain http page that is not loopback, so not a secure context, still gets the bridge.
//   notify    the Vite renderer, as new mail syncs in, with main's notifications and badge
//             stubbed (electron-notify.ts).
//   gmail     real mode with no client file, and with one that does not exist. Main exits
//             with 1 and says what to set, before any window or core.
// It also checks that the dev host refuses a --state that would empty the real core's store.
// Every core main started must be gone once its app has quit.
//
// Writes electron.json (the checks and the cold start, from launch to the first painted
// row), screenshots, a Playwright trace per app run (electron-app.ts) and the shell's log to
// artifacts/ui/.

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { buildShell, electronBinary, SHELL } from '@letterbox/desktop-shell/build'
import { STOP_MS } from '@letterbox/desktop-shell/core'
import { exited, killChildrenNow, logChildrenTo, startChild, stopChildren } from './children.ts'
import { notifyRun } from './electron-notify.ts'
import {
  ARTIFACTS,
  CheckFailure,
  checkQuit,
  checks,
  corePids,
  equal,
  firstRowPainted,
  isRunning,
  sandboxGaps,
  paths,
  quit,
  untilLogged,
  root,
  seed,
  SHELL_LOG,
  STATE,
  WAIT_MS,
  within,
  withApp,
  yourTurn,
  yourTurnShown,
} from './electron-app.ts'
import { missingDisplay, shellEnv } from './desktop.ts'
import { listen } from './port.ts'
import { type DevServer, startServer } from './server.ts'
import { type RunningSim, startSim } from './sim.ts'

let failure: string | null = null

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
      {
        bridge: ['connect', 'onOpenConversation', 'platform'],
        platform: process.platform,
        node: ['undefined', 'undefined'],
      },
      'built: the page sees only the bridge, and no Node',
    )
    equal(
      await page.evaluate(() => window.open('https://example.com/') === null),
      true,
      'built: new windows are denied',
    )
    equal(
      await sandboxGaps(run),
      [],
      "built: the page's renderer runs in the OS sandbox, with no switch turning it off",
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

/** True once `count` pages have asked main for a core. */
const asked = (count: number) => (lines: string[]) =>
  lines.filter((line) => line.endsWith('a page asked for a core')).length >= count

/**
 * The busy run. First, two reloads while main waits for a busy core to stop: the older page's
 * request must not hand the newest page a core that is then stopped. Then a quit while the
 * core waits on the provider. The provider's snapshot hold sets the order, not timers.
 */
const busyRun = (sim: RunningSim, server: DevServer) =>
  withApp('busy', server.url, async (run) => {
    /** Makes the page's core wait on the provider: a delivery syncs, and with the cursor expired the sync starts a snapshot whose first page is held. */
    const busy = async () => {
      await run.page.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
      sim.mailbox.expireCursors()
      sim.mailbox.holdSnapshots()
      await run.page.evaluate(() => void window.letterboxDev?.deliver(1).catch(() => {}))
      await within(sim.mailbox.snapshotHeld(), 'the core asking for a snapshot page')
    }

    await firstRowPainted(run.page)
    await busy()
    // Each reload is a new page, as after an HMR full reload. Main stops the busy core for the
    // first one, and that stop waits on the provider while the second asks.
    await run.page.reload()
    await untilLogged(run, asked(2), 'the first reload asking for a core')
    await run.page.reload()
    await untilLogged(run, asked(3), 'the second reload asking for a core')
    sim.mailbox.releaseSnapshots()
    await firstRowPainted(run.page)
    await run.page.waitForFunction(() => window.letterboxDev !== undefined, null, { timeout: WAIT_MS })
    const synced = await within(
      run.page.evaluate(() => window.letterboxDev?.deliver(1).then(() => 'synced')),
      "a sync through the newest page's core",
    )
    equal(synced, 'synced', 'busy: after two reloads during a stop, the newest page syncs through its own core')
    equal(corePids(run.lines()).filter(isRunning).length, 1, 'busy: one core runs')
    equal(
      run.lines().filter((line) => line.startsWith('[shell] dropped a core request')).length,
      1,
      'busy: main dropped the request of the page that reloaded while it waited',
    )
    equal(await run.page.getByRole('alert').count(), 0, 'busy: the newest page never lost its core')

    await busy()
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
    // The strip says it plainly. Main's own words, with the signal, stay in its tooltip.
    const reason = alert.locator('[data-field="lost-reason"]')
    equal(
      [await reason.textContent(), (await reason.getAttribute('title'))?.startsWith('the core exited on SIGKILL')],
      ['Lost the core: the core exited.', true],
      "crash: the page shows that the core exited, with main's reason in the tooltip",
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

/**
 * A dev URL that starts to redirect to another origin, as a misconfigured dev server might.
 * The page loads once, then reloads into the redirect. Main blocks it, so the page with the
 * bridge never loads elsewhere. The other origin counts the requests it gets.
 */
async function redirectRun() {
  let elsewhereHits = 0
  const elsewhere = createServer((_request, response) => {
    elsewhereHits += 1
    response.end('<p>elsewhere</p>')
  })
  const elsewhereUrl = `http://127.0.0.1:${await listen(elsewhere, 0)}/`
  let served = 0
  const dev = createServer((_request, response) => {
    served += 1
    if (served === 1) return response.end('<p>the dev page</p>')
    response.writeHead(302, { location: elsewhereUrl })
    response.end()
  })
  const devUrl = `http://127.0.0.1:${await listen(dev, 0)}/`
  try {
    await withApp('redirect', devUrl, async (run) => {
      // The reload never finishes loading, so nothing waits for it. Main's log says when it was blocked.
      void run.page.reload().catch(() => undefined)
      await untilLogged(
        run,
        (lines) => lines.some((line) => line.includes('blocked a redirect')),
        'main blocking a redirect to another origin',
      )
      equal(elsewhereHits, 0, 'redirect: the page never loads from the origin a redirect points to')
      checkQuit('redirect', run, await quit(run))
    })
  } finally {
    for (const server of [elsewhere, dev]) {
      server.closeAllConnections()
      server.close()
    }
  }
}

/**
 * A dev URL on plain http under a name that is not loopback, so not a secure context and
 * without APIs such as crypto.randomUUID. Chromium maps the name to this machine, so nothing
 * is served to the network. The preload must still put the bridge on the page.
 */
async function insecureRun() {
  const plain = createServer((_request, response) => response.end('<p>a plain http page</p>'))
  const port = await listen(plain, 0)
  try {
    await withApp(
      'insecure',
      `http://insecure.test:${port}/`,
      async (run) => {
        await run.page.waitForLoadState('domcontentloaded')
        equal(
          await run.page.evaluate(() => ({
            secure: isSecureContext,
            bridge: Object.keys(window.letterbox ?? {}).toSorted(),
          })),
          { secure: false, bridge: ['connect', 'onOpenConversation', 'platform'] },
          'insecure: on plain http that is not loopback, the page still gets the bridge',
        )
        checkQuit('insecure', run, await quit(run))
      },
      ['--host-resolver-rules=MAP insecure.test 127.0.0.1'],
    )
  } finally {
    plain.closeAllConnections()
    plain.close()
  }
}

/** The dev host refuses a state folder that would empty the real core's store, before it deletes anything. */
function stateRun() {
  for (const state of ['.letterbox/gmail', '.letterbox/gmail/dev']) {
    const run = spawnSync(process.execPath, ['packages/dev-host/src/main.ts', '--state', state, '--port', '0'], {
      cwd: root,
      encoding: 'utf8',
      timeout: WAIT_MS,
    })
    equal(run.status, 1, `state: the dev host refuses --state ${state}`)
    equal(
      run.stderr.includes('.letterbox/gmail, where the real core keeps its store'),
      true,
      `state: it says why --state ${state} is refused`,
    )
  }
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
const traces = readdirSync(ARTIFACTS).filter((file) => file.startsWith('trace-electron-'))
for (const file of ['electron.json', 'electron.png', 'electron-core-lost.png', 'electron-shell.log', ...traces]) {
  rmSync(join(ARTIFACTS, file), { force: true })
}
logChildrenTo(join(STATE, 'host.log'))
process.on('exit', killChildrenNow)

let sim: RunningSim | undefined
let server: DevServer | undefined
/** The cold start, once the built run has measured it. */
const measured: { coldStart?: { ms: number; toPageMs: number } } = {}
/**
 * Runs one part of the check. A failure is noted, and the parts after it still run. Any error
 * but a failed check also prints its stack, since its message alone may not say where it came from.
 */
async function part(run: () => unknown) {
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`FAIL ${message}`)
    if (error instanceof Error && !(error instanceof CheckFailure)) console.log(error.stack)
    failure ??= message
  }
}

const renderer = join(STATE, 'renderer')
await part(async () => {
  sim = await startSim(paths, seed)
  await buildRenderer(renderer)
  await buildShell()
})
if (failure === null) {
  await part(async () => (measured.coldStart = await builtRun(renderer)))
  await part(async () => {
    if (!sim) return
    server = await startServer({ paths, port: 0, relay: false, sim: sim.sim })
    await busyRun(sim, server)
  })
  await part(async () => sim && server && (await notifyRun(sim, server)))
  await part(() => crashRun(renderer))
  await part(redirectRun)
  await part(insecureRun)
  await part(() => gmailRun(renderer))
}
await part(stateRun)
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
        ...measured.coldStart,
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
  `\n${checks.filter((check) => check.ok).length} of ${checks.length} Electron checks passed. electron.json, screenshots, traces and the shell log are in artifacts/ui/.`,
)
process.exitCode = failure === null ? 0 : 1
