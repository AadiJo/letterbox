// The UI check's verdicts: each check is recorded, printed, and written to summary.json.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { Refusal, Request } from '@letterbox/protocol'
import type { Browser, BrowserContext, Page } from 'playwright'

export const root = fileURLToPath(new URL('../../../../', import.meta.url))
export const ARTIFACTS = join(root, 'artifacts/ui')

/** The longest any one wait in a check may take. */
export const WAIT_MS = 15_000

/** A list row's height in px: the renderer's ROW_HEIGHT (apps/desktop/renderer/src/Row.tsx). */
export const ROW_HEIGHT = 78

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
 * refuse its script, loads and links. Those are the protection working. A check that ends the
 * connection on purpose passes `lostCore`, and the page's report of each loss ("lost the core:",
 * the renderer's core.ts) is expected there. Anywhere else a lost core is an error.
 */
export const appErrors = (errors: readonly string[], { lostCore = false } = {}) =>
  errors.filter(
    (error) =>
      !/Content Security Policy|in a sandboxed frame|sandboxed and the 'allow-scripts'/.test(error) &&
      !(lostCore && error.startsWith('lost the core: ')),
  )

/** True for a URL that leaves this machine. */
const isRemote = (url: string) => {
  const { protocol, hostname } = new URL(url)
  return (protocol === 'http:' || protocol === 'https:') && hostname !== '127.0.0.1'
}

/** A close's code and reason as `WebSocketRoute.close` takes them, leaving out what the other side did not send. */
const closeOptions = (code: number | undefined, reason: string | undefined) => ({
  ...(code === undefined ? {} : { code }),
  ...(reason === undefined ? {} : { reason }),
})

/**
 * Relays the page's `/core` socket, so a check can make the core slow on cue. After
 * `pauseAtAccepted`, the core's next `accepted` and everything after it wait until `resume`,
 * in order, or until `drop` ends the connection with them still unsent. The returned promise resolves once the relay holds that `accepted`.
 * After `failNextUndo`, the page's next undo ends the connection instead of reaching the core.
 * After `holdNextUndoAnswer`, the page's next undo reaches the core, and the core's answer to
 * it waits until `releaseUndoAnswer`, or for good, while everything else passes. `sees`
 * resolves once the core sends a message, held or not, that contains `text`. It rejects
 * after WAIT_MS, or when the connection closes first, naming what never came.
 */
async function relayCore(page: Page) {
  let armed: (() => void) | undefined
  let held: string[] | undefined
  let toPage: ((message: string) => void) | undefined
  let close: (() => Promise<void>) | undefined
  const fromPage: string[] = []
  let watched: { text: string; seen: () => void } | undefined
  // The answer the relay gives the page's next undo itself, instead of passing it to the core.
  let refuseUndo: { conflict?: unknown } | undefined
  // The reason the relay refuses the page's next unsubscribe with itself, instead of passing it to the core.
  let refuseUnsubscribe: Refusal | undefined
  // True once `swallowNextUnsubscribe` is called: the page's next unsubscribe never reaches the core, and nothing answers it.
  let swallowUnsubscribe = false
  // Armed by `holdFromCore`: each holds every message from the core its `test` takes, until its release.
  const coreHolds = new Set<{ test: (message: string) => boolean; held: string[]; first: () => void }>()
  // True once `failNextUndo` is called: the page's next undo ends the connection, and the core never sees it.
  let failUndo = false
  // Armed by `holdNextUndoAnswer`: the change id of the page's next undo, once sent, and the core's answer to it, once held.
  let undoAnswer: { change: string | null; answer: string | null; held: () => void } | undefined
  const waiters = new Set<{ text: string; settle: (error?: Error) => void }>()
  /**
   * Armed by `holdAnswer`: each waits for the page's next request its `test` takes, then holds
   * every chunk and the response the core sends for it, until its release.
   */
  const answerHolds = new Set<{
    test: (request: Request) => boolean
    id: string | null
    held: string[]
    answered: () => void
  }>()
  const see = (message: string) => {
    for (const waiter of waiters) if (message.includes(waiter.text)) waiter.settle()
  }
  const closed = () => {
    for (const waiter of waiters)
      waiter.settle(new Error(`the core connection closed before the core sent a message with ${waiter.text}`))
  }
  const sees = (text: string) => {
    const seen = new Promise<void>((resolve, reject) => {
      const waiter = {
        text,
        settle: (error?: Error) => {
          clearTimeout(timer)
          waiters.delete(waiter)
          if (error) reject(error)
          else resolve()
        },
      }
      const timer = setTimeout(
        () => waiter.settle(new Error(`the core sent no message with ${text} within ${WAIT_MS} ms`)),
        WAIT_MS,
      )
      waiters.add(waiter)
    })
    // Handled here too, so a failure that lands before the check awaits it does not end the process.
    seen.catch(() => {})
    return seen
  }
  await page.routeWebSocket(/\/core$/, (socket) => {
    const core = socket.connectToServer()
    // A close handler stops Playwright passing a close on, so each side passes it on itself.
    socket.onClose((code, reason) => {
      void core.close(closeOptions(code, reason))
      closed()
    })
    core.onClose((code, reason) => {
      void socket.close(closeOptions(code, reason))
      closed()
    })
    socket.onMessage((message) => {
      const text = String(message)
      fromPage.push(text)
      if (answerHolds.size > 0 && text.startsWith('{"kind":"request"')) {
        const { id, request } = JSON.parse(text) as { id: string; request: Request }
        const hold = [...answerHolds].find((one) => one.id === null && one.test(request))
        if (hold) hold.id = id
      }
      if (swallowUnsubscribe && text.includes('"kind":"unsubscribe"')) {
        swallowUnsubscribe = false
        return
      }
      if (refuseUnsubscribe && text.includes('"kind":"unsubscribe"')) {
        const reason = refuseUnsubscribe
        refuseUnsubscribe = undefined
        const { change } = JSON.parse(text) as { change: string }
        return void socket.send(JSON.stringify({ kind: 'rejected', change, reason }))
      }
      if (refuseUndo && text.includes('"kind":"undo"')) {
        const { conflict } = refuseUndo
        refuseUndo = undefined
        const { change } = JSON.parse(text) as { change: string }
        const rejected = { kind: 'rejected', change, reason: 'conflict', ...(conflict ? { conflict } : {}) }
        return void socket.send(JSON.stringify(rejected))
      }
      if (failUndo && text.includes('"kind":"undo"')) {
        failUndo = false
        return void close?.()
      }
      if (undoAnswer?.change === null && text.includes('"kind":"undo"'))
        undoAnswer.change = (JSON.parse(text) as { change: string }).change
      core.send(message)
      if (watched && text.includes(watched.text)) {
        held ??= []
        watched.seen()
        watched = undefined
      }
    })
    toPage = (message) => socket.send(message)
    close = async () => {
      await socket.close({ code: 1011, reason: 'the check dropped the connection' })
      await core.close()
    }
    core.onMessage((frame) => {
      const message = frame.toString()
      see(message)
      // serde writes `kind` first and `id` next, so only these lines answer a request.
      const answer = /^\{"kind":"(chunk|response)","id":"([^"]+)"/.exec(message)
      const hold = answer && [...answerHolds].find((one) => one.id === answer[2])
      if (hold) {
        hold.held.push(message)
        if (answer[1] === 'response') hold.answered()
        return
      }
      const coreHold = [...coreHolds].find((one) => one.test(message))
      if (coreHold) {
        coreHold.held.push(message)
        return coreHold.first()
      }
      if (undoAnswer?.change && undoAnswer.answer === null && /"kind":"(accepted|rejected)"/.test(message)) {
        const { change } = JSON.parse(message) as { change?: string }
        if (change === undoAnswer.change) {
          undoAnswer.answer = message
          return void undoAnswer.held()
        }
      }
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
    /** Resolves once the page sends a message containing `text`. Everything the core sends after it waits until `resume`. */
    pauseAfterPageSends: (text: string) => new Promise<void>((resolve) => (watched = { text, seen: resolve })),
    /** Refuses the page's next undo `conflict`, with `conflict` as its reason, as the core would. It never reaches the core. */
    /** Refuses the page's next unsubscribe with `reason`, as the core would. It never reaches the core. */
    refuseNextUnsubscribe: (reason: Refusal) => {
      refuseUnsubscribe = reason
    },
    /** The page's next unsubscribe never reaches the core, and nothing answers it, though the connection stays open. */
    swallowNextUnsubscribe: () => {
      swallowUnsubscribe = true
    },
    /**
     * Holds every message the core sends that `test` takes, while everything else passes, until
     * `release` hands them to the page in order, or `releaseLast` hands over only the newest, as
     * a core that sent one update for several changes would. `first` resolves once it holds one.
     */
    holdFromCore: (test: (message: string) => boolean) => {
      const { promise: first, resolve } = Promise.withResolvers<void>()
      const hold = { test, held: [] as string[], first: resolve }
      coreHolds.add(hold)
      return {
        first,
        /** How many messages it holds now. */
        count: () => hold.held.length,
        release: () => {
          coreHolds.delete(hold)
          for (const message of hold.held) toPage?.(message)
        },
        releaseLast: () => {
          coreHolds.delete(hold)
          const last = hold.held.at(-1)
          if (last !== undefined) toPage?.(last)
        },
      }
    },
    refuseNextUndo: (conflict?: unknown) => {
      refuseUndo = { conflict }
    },
    /** Ends the connection both ways when the page sends its next undo, which never reaches the core. */
    failNextUndo: () => {
      failUndo = true
    },
    /**
     * Passes the page's next undo to the core and holds the core's answer to it, and only that,
     * until `releaseUndoAnswer`. Never released, the answer is lost while the connection stays
     * open. Arming again forgets any answer still held. Resolves once the relay holds the answer.
     */
    holdNextUndoAnswer: () =>
      new Promise<void>((resolve) => {
        undoAnswer = { change: null, answer: null, held: resolve }
      }),
    /** Hands the page the answer `holdNextUndoAnswer` held. */
    releaseUndoAnswer: () => {
      const answer = undoAnswer?.answer
      undoAnswer = undefined
      if (!answer) throw new Error('the relay holds no answer to an undo')
      toPage?.(answer)
    },
    sees,
    /**
     * Holds the core's answer to the page's next request that `test` takes, its chunks and its
     * response, until `release` hands them to the page in order. `answered` resolves once the
     * relay holds the response.
     */
    holdAnswer: (test: (request: Request) => boolean) => {
      const { promise: answered, resolve } = Promise.withResolvers<void>()
      const hold = { test, id: null as string | null, held: [] as string[], answered: resolve }
      answerHolds.add(hold)
      return {
        answered,
        release: () => {
          answerHolds.delete(hold)
          for (const message of hold.held) toPage?.(message)
        },
      }
    },
    /** Every message the page sent its cores, in order, as sent. */
    fromPage: () => [...fromPage],
    /** Ends the connection both ways. What the relay held is never delivered, as when an answer is lost. */
    drop: async () => {
      held = undefined
      armed = undefined
      watched = undefined
      await close?.()
    },
    resume: () => {
      const queued = held ?? []
      held = undefined
      for (const message of queued) toPage?.(message)
    },
  }
}

/** The relay `openPage` puts between the page and its core. */
export type Relay = Awaited<ReturnType<typeof relayCore>>

/** Characters an artifact's file name may not hold: CI's artifact upload refuses them. As UNSAFE_IN_FILE_NAMES in packages/harness/src/scenario.ts. */
const UNSAFE_IN_FILE_NAMES = /[":<>|*?\\/\r\n]/

/** The `close` of every page `openPage` opened that has not closed yet. A check that failed part way leaves its page here. */
const openPages = new Set<() => Promise<void>>()

/**
 * Saves the trace of every page a check left open, as one that failed part way does, and closes
 * it. ui-check.ts calls it after each check, so a failed check still leaves its trace in artifacts/ui/.
 */
export async function closeLeftOpen() {
  await Promise.all(Array.from(openPages, (close) => close().catch(fail)))
}

/**
 * A page at a fixed locale and time zone (UTC unless `timezoneId` names another), so dates
 * read the same on every machine. It collects page errors and remote requests. Chromium reports a load that a frame's
 * Content Security Policy refused as a request that failed with "csp" before it reached
 * the network: those go in `blocked`. Every other remote request goes in `remote`.
 * Its trace goes to artifacts/ui/`trace` when the check closes it, or when `closeLeftOpen` does.
 * `deviceScaleFactor` 2 takes screenshots at twice their pixels, to compare with 2x mocks.
 */
export async function openPage(
  browser: Browser,
  url: string,
  trace: string,
  { timezoneId = 'UTC', deviceScaleFactor = 1 } = {},
) {
  const unsafe = trace.match(UNSAFE_IN_FILE_NAMES)
  if (unsafe)
    throw new Error(
      `the trace name "${trace}" has ${JSON.stringify(unsafe[0])} in it, which CI's artifact upload rejects`,
    )
  const context: BrowserContext = await browser.newContext({
    viewport: SIZES.wide,
    deviceScaleFactor,
    locale: 'en-US',
    timezoneId,
  })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page: Page = await context.newPage()
  page.setDefaultTimeout(WAIT_MS)
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
  /** Saves the trace and closes the page. Only the first call does anything. */
  const close = async () => {
    if (!openPages.delete(close)) return
    await context.tracing.stop({ path: join(ARTIFACTS, trace) })
    await context.close()
  }
  openPages.add(close)
  const relay = await relayCore(page)
  await page.goto(url)
  return { page, relay, errors, remote, blocked, close }
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

/** The C2 design's screens, each named for the mock it is compared with: `c2-<screen>.png`. */
export type C2Screen =
  | 'people-1440'
  | 'people-1920'
  | 'done-1440'
  | 'reply-1440'
  | 'narrow-1024'
  | 'updates-1440'
  | 'updates-1024'
  | 'letgo-1440'
  | 'letgo-undo-1440'
  | 'letgo-undo-1024'
  | 'people-letgo-1440'

const C2_SIZES = {
  'people-1440': SIZES.wide,
  'people-1920': SIZES.full,
  'done-1440': SIZES.wide,
  'reply-1440': SIZES.wide,
  'narrow-1024': SIZES.narrow,
  'updates-1440': SIZES.wide,
  'updates-1024': SIZES.narrow,
  'letgo-1440': SIZES.wide,
  'letgo-undo-1440': SIZES.wide,
  'letgo-undo-1024': SIZES.narrow,
  'people-letgo-1440': SIZES.wide,
} as const satisfies Record<C2Screen, (typeof SIZES)[keyof typeof SIZES]>

/**
 * Screenshots the page as `c2-<screen>.png` at the screen's size and twice its pixels, as the
 * mocks are, then gives the page back its own size. `before` runs once the page is at that
 * size, for a hover that must land on the final layout.
 */
export async function captureC2(page: Page, screen: C2Screen, before?: () => Promise<void>) {
  const size = C2_SIZES[screen]
  const cdp = await page.context().newCDPSession(page)
  await page.setViewportSize(size)
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: false })
  await before?.()
  // Every one-shot animation finished, as `capture` has them. Playwright's own screenshot
  // keeps its scale of 1, so the page takes this one itself.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((animation) => animation.finished)))
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(ARTIFACTS, `c2-${screen}.png`), Buffer.from(data, 'base64'))
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
  // Playwright sends its own size again, which the override replaced.
  await page.setViewportSize(SIZES.wide)
}

/** A box on screen, as `boxOf` reads it. */
export type Box = { left: number; top: number; right: number; bottom: number }

/** Where `selector`'s first match is on screen. Throws if nothing matches or it is hidden. */
export async function boxOf(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox()
  if (!found) throw new Error(`the page shows no ${selector}`)
  return { left: found.x, top: found.y, right: found.x + found.width, bottom: found.y + found.height }
}

/** True when two boxes share any area. */
export const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** A box's vertical middle, to the nearest half pixel. */
export const middle = (box: Box) => Math.round(box.top + box.bottom) / 2
