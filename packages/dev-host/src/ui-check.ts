// The end-to-end UI check, run by `pnpm check:ui` and `pnpm check`.
//
// Starts the dev host (main.ts) on a free port with the people-first seed, opens People in
// Playwright's Chromium, and checks what the core shows against what the seed holds. Then it
// delivers new mail through the dev hook, reloads, and stops the host. Every process it
// started must be gone at the end.
//
// Writes screenshots, a Playwright trace and summary.json to artifacts/ui/. Open the trace with
//   pnpm --filter @letterbox/dev-host exec playwright show-trace "$PWD/artifacts/ui/trace.zip"

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import { type Browser, chromium, type Page } from 'playwright'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ARTIFACTS = join(root, 'artifacts/ui')
/** The dev host's state for this check, apart from the `pnpm dev` one so both can run at once. */
const STATE = '.letterbox/ui-check'
/** Long enough for cargo to build core-sim from cold. */
const START_MS = 600_000
const STOP_MS = 10_000

const seed = devSeeds['people-first']
const newestFirst = (turn: 'mine' | 'theirs') =>
  seed.conversations
    .filter((conversation) => conversation.turn === turn)
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))
    .map((conversation) => conversation.subject)
const DELIVER = 3

const checks: { ok: boolean; what: string }[] = []

/** Records a check and fails the run unless the two values are deeply equal. */
const equal = <Value>(actual: Value, expected: Value, what: string) => {
  const ok = isDeepStrictEqual(actual, expected)
  checks.push({ ok, what })
  if (ok) console.log(`ok   ${what}`)
  else throw new Error(`${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
}

/** Starts the dev host and resolves with its page URL once it prints its line. */
function startDevHost() {
  const child = spawn(process.execPath, ['packages/dev-host/src/main.ts', '--port', '0', '--state', STATE], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
  return { url, stop, stdout, stderr: () => stderr }
}

/** The subjects, people or ages shown in one People section, top to bottom. */
const column = (page: Page, section: string, field: 'subject' | 'age') =>
  page.getByRole('region', { name: section }).locator(`[data-field="${field}"]`).allTextContents()

/** Waits until a section shows `count` rows. */
const rowsShown = (page: Page, section: string, count: number) =>
  page.waitForFunction(
    ([name, rows]) => document.querySelectorAll(`section[aria-label="${name}"] li`).length === rows,
    [section, count] as const,
  )

/** The conversation count in the header, once the core has sent it. */
const total = async (page: Page) => {
  await page.waitForFunction(() =>
    /^\d+ conversations$/.test(document.querySelector('[data-field="total"]')?.textContent ?? ''),
  )
  return Number.parseInt((await page.locator('[data-field="total"]').textContent()) ?? '', 10)
}

/** Checks both sections against the seed. */
async function checkPeople(page: Page, when: string) {
  const mine = newestFirst('mine')
  const theirs = newestFirst('theirs')
  await rowsShown(page, 'Your turn', mine.length)
  await rowsShown(page, 'Waiting on others', theirs.length)
  equal(await column(page, 'Your turn', 'subject'), mine, `${when}: your-turn rows are the seed's, newest first`)
  equal(
    await column(page, 'Waiting on others', 'subject'),
    theirs,
    `${when}: waiting rows are the seed's, newest first`,
  )
}

const host = startDevHost()
let browser: Browser | undefined
let failure: string | null = null

/** Prints a failure. The first one is the run's verdict. */
function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`FAIL ${message}`)
  failure ??= message
}
rmSync(ARTIFACTS, { recursive: true, force: true })
mkdirSync(ARTIFACTS, { recursive: true })

try {
  const url = await host.url
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 900, height: 1200 } })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))

  await page.goto(url)
  await checkPeople(page, 'first load')
  equal(
    (await column(page, 'Your turn', 'age')).slice(0, 8),
    ['1h', '5h', '1d', '3d', '6d', '11d', '16d', '26d'],
    'ages come from the fixed clock',
  )
  const before = await total(page)
  // A message that answers no other starts a conversation.
  const conversations = seed.seed.messages.filter((message) => (message.replyTo ?? []).length === 0).length
  equal(before, conversations, 'the header counts every conversation in the seed')
  await page.screenshot({ path: join(ARTIFACTS, 'people.png'), fullPage: true })

  await page.waitForFunction(() => window.letterboxDev !== undefined)
  await page.evaluate((count) => window.letterboxDev?.deliver(count), DELIVER)
  await page.waitForFunction(
    (expected) => document.querySelector('[data-field="total"]')?.textContent === `${expected} conversations`,
    before + DELIVER,
  )
  equal(await total(page), before + DELIVER, `deliver(${DELIVER}) adds ${DELIVER} conversations`)
  await checkPeople(page, 'after deliver')
  await page.screenshot({ path: join(ARTIFACTS, 'people-after-deliver.png'), fullPage: true })

  // A reload is a new tab for the dev host: it stops the old core and starts one over the same store.
  await page.reload()
  await checkPeople(page, 'after a reload')
  equal(await total(page), before + DELIVER, 'the delivered mail is still there after a reload')

  const compiled = await (await fetch(new URL('src/People.tsx', url))).text()
  equal(compiled.includes('compiler-runtime'), true, 'React Compiler compiles the renderer')
  equal(await page.getByRole('alert').count(), 0, 'the page never lost the core')
  equal(errors, [], 'the page logged no errors')
  await context.tracing.stop({ path: join(ARTIFACTS, 'trace.zip') })
} catch (error) {
  fail(error)
} finally {
  await browser?.close()
}

const code = await host.stop()
try {
  equal(code, 0, 'the dev host exits cleanly on SIGTERM')
  equal(host.stdout.length, 1, 'the dev host prints one line')
  // children.ts logs each start and exit. Every child must have exited, and none may still run.
  const log = readFileSync(join(root, STATE, 'host.log'), 'utf8')
  const started = [...log.matchAll(/^started (\d+) /gm)].map((match) => Number(match[1]))
  const exitedPids = new Set([...log.matchAll(/^exited (\d+)$/gm)].map((match) => Number(match[1])))
  // cargo, the core that signs in, and one core per page load: the first load and the reload.
  equal(started.length, 4, 'the dev host started cargo and three cores')
  equal(
    started.filter((pid) => !exitedPids.has(pid) || isRunning(pid)),
    [],
    'every process the dev host started has exited',
  )
} catch (error) {
  fail(error)
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

writeFileSync(
  join(ARTIFACTS, 'summary.json'),
  `${JSON.stringify({ passed: failure === null, failure, checks }, null, 2)}\n`,
)
if (failure !== null) console.log(`\nThe UI check failed. Dev host stderr:\n${host.stderr()}`)
console.log(
  `\n${checks.filter((check) => check.ok).length} of ${checks.length} UI checks passed. Screenshots and the trace are in artifacts/ui/.`,
)
process.exitCode = failure === null ? 0 : 1
