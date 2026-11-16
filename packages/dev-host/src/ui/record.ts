// The UI check's verdicts: each check is recorded, printed, and written to summary.json.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from 'playwright'

export const root = fileURLToPath(new URL('../../../../', import.meta.url))
export const ARTIFACTS = join(root, 'artifacts/ui')

/** The window sizes every scene is captured at. */
export const SIZES = {
  wide: { width: 1440, height: 900 },
  full: { width: 1920, height: 1080 },
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

/**
 * The page's errors, without those an HTML body's frame logs when its sandbox and policy
 * refuse its script, loads and links. Those are the protection working.
 */
export const appErrors = (errors: readonly string[]) =>
  errors.filter(
    (error) => !/Content Security Policy|in a sandboxed frame|sandboxed and the 'allow-scripts'/.test(error),
  )

/** True for a URL that leaves this machine. */
const isRemote = (url: string) => {
  const { protocol, hostname } = new URL(url)
  return (protocol === 'http:' || protocol === 'https:') && hostname !== '127.0.0.1'
}

/**
 * Relays the page's `/core` socket, so a check can make the core slow on cue. After
 * `pauseAtAccepted`, the core's next `accepted` and everything after it wait until `resume`,
 * in order. The returned promise resolves once the relay holds that `accepted`. `sees`
 * resolves once the core sends a message, held or not, that contains `text`.
 */
async function relayCore(page: Page) {
  let armed: (() => void) | undefined
  let held: string[] | undefined
  let toPage: ((message: string) => void) | undefined
  const waiters = new Set<{ text: string; resolve: () => void }>()
  const see = (message: string) => {
    for (const waiter of waiters) {
      if (!message.includes(waiter.text)) continue
      waiters.delete(waiter)
      waiter.resolve()
    }
  }
  await page.routeWebSocket(/\/core$/, (socket) => {
    const core = socket.connectToServer()
    socket.onMessage((message) => core.send(message))
    toPage = (message) => socket.send(message)
    core.onMessage((frame) => {
      const message = frame.toString()
      see(message)
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
    sees: (text: string) => new Promise<void>((resolve) => void waiters.add({ text, resolve })),
    resume: () => {
      const queued = held ?? []
      held = undefined
      for (const message of queued) toPage?.(message)
    },
  }
}

/** The relay `openPage` puts between the page and its core. */
export type Relay = Awaited<ReturnType<typeof relayCore>>

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

/**
 * Screenshots the page at each size as `<name>.png`, `<name>-1920.png` and `<name>-narrow.png`,
 * and leaves it wide. Animations are finished first, so a capture never catches one midway.
 */
export async function capture(page: Page, name: string) {
  const shot = async (size: (typeof SIZES)[keyof typeof SIZES], file: string) => {
    await page.setViewportSize(size)
    await page.screenshot({ path: join(ARTIFACTS, file), animations: 'disabled' })
  }
  await shot(SIZES.wide, `${name}.png`)
  await shot(SIZES.full, `${name}-1920.png`)
  await shot(SIZES.narrow, `${name}-narrow.png`)
  await page.setViewportSize(SIZES.wide)
}
