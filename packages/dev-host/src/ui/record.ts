// The UI check's verdicts: each check is recorded, printed, and written to summary.json.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'

export const root = fileURLToPath(new URL('../../../../', import.meta.url))
export const ARTIFACTS = join(root, 'artifacts/ui')

/** The two window sizes every scene is captured at. */
export const SIZES = {
  wide: { width: 1440, height: 900 },
  narrow: { width: 1024, height: 700 },
} as const

const checks: { ok: boolean; what: string }[] = []
let failure: string | null = null

/** Records a check and throws unless the two values are deeply equal. */
export const equal = <Value>(actual: Value, expected: Value, what: string) => {
  const ok = isDeepStrictEqual(actual, expected)
  checks.push({ ok, what })
  if (ok) console.log(`ok   ${what}`)
  else throw new Error(`${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
}

/** Records a failure. The first one is the run's verdict. */
export function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`FAIL ${message}`)
  failure ??= message
}

export const failed = () => failure !== null

/** Writes summary.json and prints the tally. */
export function summarize() {
  writeFileSync(
    join(ARTIFACTS, 'summary.json'),
    `${JSON.stringify({ passed: failure === null, failure, checks }, null, 2)}\n`,
  )
  console.log(
    `\n${checks.filter((check) => check.ok).length} of ${checks.length} UI checks passed. Screenshots, timings and traces are in artifacts/ui/.`,
  )
}

/** True for a URL that leaves this machine. */
const isRemote = (url: string) => {
  const { protocol, hostname } = new URL(url)
  return (protocol === 'http:' || protocol === 'https:') && hostname !== '127.0.0.1'
}

/**
 * Relays the page's `/core` socket, so a check can make the core slow on cue. After
 * `pauseAtAccepted`, the core's next `accepted` and everything after it wait until `resume`,
 * in order. The returned promise resolves once the relay holds that `accepted`.
 */
async function relayCore(page: Page) {
  let armed: (() => void) | undefined
  let held: string[] | undefined
  let toPage: ((message: string) => void) | undefined
  await page.routeWebSocket(/\/core$/, (socket) => {
    const core = socket.connectToServer()
    socket.onMessage((message) => core.send(message))
    toPage = (message) => socket.send(message)
    core.onMessage((frame) => {
      const message = frame.toString()
      if (held) return void held.push(message)
      if (armed && message.includes('"kind":"accepted"')) {
        held = [message]
        armed()
        armed = undefined
        return
      }
      socket.send(message)
    })
  })
  return {
    pauseAtAccepted: () => new Promise<void>((resolve) => (armed = resolve)),
    resume: () => {
      const queued = held ?? []
      held = undefined
      for (const message of queued) toPage?.(message)
    },
  }
}

/**
 * A page at a fixed locale and time zone, so dates read the same on every machine. It
 * collects page errors and remote requests. Chromium reports a load that a frame's
 * Content Security Policy refused as a request that failed with "csp" before it reached
 * the network: those go in `blocked`. Every other remote request goes in `remote`.
 */
export async function openPage(browser: Browser, url: string, trace: string) {
  const context: BrowserContext = await browser.newContext({ viewport: SIZES.wide, locale: 'en-US', timezoneId: 'UTC' })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page: Page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  const remote: string[] = []
  const blocked: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  page.on('requestfinished', (request) => isRemote(request.url()) && remote.push(request.url()))
  page.on('requestfailed', (request) => {
    if (!isRemote(request.url())) return
    if (request.failure()?.errorText === 'csp') blocked.push(request.url())
    else remote.push(request.url())
  })
  const relay = await relayCore(page)
  await page.goto(url)
  return {
    page,
    relay,
    errors,
    remote,
    blocked,
    /** Saves the trace and closes the page. */
    close: async () => {
      await context.tracing.stop({ path: join(ARTIFACTS, trace) })
      await context.close()
    },
  }
}

/** Screenshots the page at both sizes as `<name>.png` and `<name>-narrow.png`, and leaves it wide. */
export async function capture(page: Page, name: string) {
  await page.setViewportSize(SIZES.wide)
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
  await page.setViewportSize(SIZES.narrow)
  await page.screenshot({ path: join(ARTIFACTS, `${name}-narrow.png`) })
  await page.setViewportSize(SIZES.wide)
}
