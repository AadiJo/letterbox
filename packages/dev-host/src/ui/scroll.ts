// The UI check over the `many` seed: scrolls All mail from the top to the bottom of a
// mailbox of thousands of conversations. The DOM must never hold more than a screen's rows
// plus the overscan. Frame timings go to artifacts/ui/scroll.json.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Browser } from 'playwright'
import { ARTIFACTS, equal, openPage } from './record.ts'

const seed = devSeeds.many
const total = seed.seed.messages.length
/** Rows the scroll moves each frame. Fast enough to outrun the core now and then. */
const ROWS_PER_FRAME = 10
/** The most rows the list may hold at once: the rows that fit in 900 px, plus overscan above and below. */
const MAX_ROWS = 30

/** The value below which `share` of the sorted values fall. */
const percentile = (sorted: readonly number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0

/** Milliseconds to one decimal place. */
const round = (ms: number) => Math.round(ms * 10) / 10

export async function checkScroll(browser: Browser, url: string) {
  const { page, close } = await openPage(browser, url, 'trace-scroll.zip')
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^All mail/ })
    .click()
  const expected = `${total.toLocaleString('en-US')} conversations`
  await page.waitForFunction(
    (text) => document.querySelector('[data-field="subtitle"]')?.textContent === text,
    expected,
  )
  await page.locator('[data-list="mail"] [role="option"][data-unread]').first().waitFor()

  // One step per animation frame, from the top until the list can scroll no further.
  const run = await page.evaluate(async (step) => {
    const list = document.querySelector<HTMLElement>('[data-list="mail"]')
    if (!list) throw new Error('All mail has no list')
    const frames: number[] = []
    let rows = 0
    let blankFrames = 0
    let last = performance.now()
    await new Promise<void>((resolve) => {
      const tick = (time: number) => {
        frames.push(time - last)
        last = time
        const shown = list.querySelectorAll('[data-row]')
        rows = Math.max(rows, shown.length)
        if ([...shown].some((row) => row.getAttribute('data-row') === '')) blankFrames += 1
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 1) return resolve()
        list.scrollTop += step
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return { frames: frames.slice(1), rows, blankFrames }
  }, ROWS_PER_FRAME * 73)

  // The oldest conversation arrives at the bottom once the window catches up.
  const oldest = seed.seed.messages[0]?.subject ?? ''
  await page.locator('[data-list="mail"] [data-field="subject"]', { hasText: oldest }).waitFor()
  equal(
    run.rows <= MAX_ROWS,
    true,
    `scrolling ${total} conversations never holds more than ${MAX_ROWS} rows (most: ${run.rows})`,
  )
  const rowsAtRest = await page.locator('[data-list="mail"] [data-row]').count()
  equal(rowsAtRest <= MAX_ROWS, true, `the bottom of the list holds ${rowsAtRest} rows`)

  const sorted = run.frames.toSorted((a, b) => a - b)
  const timings = {
    conversations: total,
    frames: run.frames.length,
    rowsPerFrame: ROWS_PER_FRAME,
    mostRowsInDom: run.rows,
    framesWithBlankRows: run.blankFrames,
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    longestMs: round(sorted.at(-1) ?? 0),
  }
  writeFileSync(join(ARTIFACTS, 'scroll.json'), `${JSON.stringify(timings, null, 2)}\n`)
  console.log(`     scroll: ${JSON.stringify(timings)}`)

  // The mailbox has no Trash, so the core cannot trash. Nothing offers it, and the key leaves the open one open.
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Inbox/ })
    .click()
  const rows = page.locator('[data-list="mail"] [role="option"]')
  await rows.first().locator('[data-field="subject"]').waitFor()
  const first = await rows.first().getAttribute('data-row')
  await rows.first().click()
  equal(
    await page.getByRole('button', { name: 'Move to Trash' }).isDisabled(),
    true,
    'with no Trash mailbox, Move to Trash is off',
  )
  await page.keyboard.press('#')
  // Two frames: long enough for React to render any change the key made.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  equal(
    await page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row'),
    first,
    'trashing where the core cannot leaves the selection where it was',
  )
  await close()
}
