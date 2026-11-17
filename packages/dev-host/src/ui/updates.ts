// The UI check over the `updates` seed: Updates with its volume strips, an opened sender, Mark
// read and Archive all from a hovered row and their undo, the Let go? pile by month with Let
// go on d and its toast, and People beside them. Each is checked against what the seed holds,
// and captured at the mock's scenes (c2-updates-1440.png beside b-updates-1440.png, and so on).

import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { SeedAddress } from '@letterbox/sim-provider/contract'
import type { Browser, Page } from 'playwright'
import { MUTED } from './c2.ts'
import { appErrors, captureC2, equal, openPage, SIZES } from './record.ts'

const seed = devSeeds.updates
const DAY = 86_400_000
const NOW = Date.parse(seed.now)
const TODAY = NOW - (NOW % DAY)
const CODEYARD = 'notifications@codeyard.example'

const addressOf = (who: SeedAddress) => (typeof who === 'string' ? who : who.address)

/** Codeyard's messages on each of the last 14 UTC days, oldest first, and whether each day has unread mail. */
const codeyardDays = Array.from({ length: 14 }, (_, index) => {
  const start = TODAY - (13 - index) * DAY
  const sent = seed.seed.messages.filter(
    (message) =>
      addressOf(message.from) === CODEYARD &&
      Date.parse(message.sentAt) >= start &&
      Date.parse(message.sentAt) < start + DAY,
  )
  return { messages: sent.length, unread: sent.some((message) => message.unread === true) }
})

/** Codeyard's conversations in the inbox: one per message, as the seed sends each alone. */
const codeyardThreads = seed.seed.messages.filter((message) => addressOf(message.from) === CODEYARD).length

/** My turns that waited 30 days or more, newest first: the Let go? pile. */
const pile = seed.conversations
  .filter((conversation) => conversation.turn === 'mine' && NOW - Date.parse(conversation.lastAt) >= 30 * DAY)
  .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))

const monthIndex = (time: string) => new Date(time).getUTCFullYear() * 12 + new Date(time).getUTCMonth()
const lastMonth = monthIndex(seed.now) - 1

/** A month from `monthIndex` by name, with its year when that is not the seed's. */
const monthName = (month: number) => {
  const first = new Date(Date.UTC(Math.floor(month / 12), month % 12, 1))
  const sameYear = first.getUTCFullYear() === new Date(NOW).getUTCFullYear()
  return first.toLocaleString('en-US', { month: 'long', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The pile's month headings as the design groups them: last month, the one before, then the rest. */
function monthsOf(conversations: typeof pile) {
  const count = (keep: (month: number) => boolean) =>
    conversations.filter((conversation) => keep(monthIndex(conversation.lastAt))).length
  return [
    `${monthName(lastMonth)} ${count((month) => month >= lastMonth)}`,
    `${monthName(lastMonth - 1)} ${count((month) => month === lastMonth - 1)}`,
    `${monthName(lastMonth - 2)} and older ${count((month) => month < lastMonth - 1)}`,
  ].filter((heading) => !heading.endsWith(' 0'))
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const nav = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })
const text = (page: Page, selector: string) => page.locator(selector).first().textContent()
const toast = (page: Page) => page.locator('[role="status"]').filter({ has: page.locator('[data-field="toast"]') })

/** Waits for the page's `selector` to read `expected`. */
const waitForText = (page: Page, selector: string, expected: string) =>
  page.waitForFunction(([where, wanted]) => document.querySelector(where)?.textContent === wanted, [
    selector,
    expected,
  ] as const)

/** Every sender row's name and unread count, top to bottom. */
const senderRows = (page: Page) =>
  page.locator('[data-sender]').evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-sender') ?? '',
      name: row.querySelector('[data-field="person"]')?.textContent ?? '',
      unread: Number(row.querySelector('[data-field="unread-count"]')?.textContent ?? 0),
    })),
  )

const codeyardRow = (page: Page) =>
  page.locator('[data-sender]').filter({ has: page.locator('[data-field="person"]', { hasText: /^Codeyard$/ }) })

async function checkUpdates(page: Page) {
  await nav(page, 'Updates').click()
  await page.locator('[data-sender]').first().waitFor()
  const rows = await senderRows(page)
  const unreadSenders = rows.filter((row) => row.unread > 0)
  equal(
    await text(page, '[data-field="updates-count"]'),
    `${unreadSenders.length}`,
    'the sidebar counts the senders with unread mail, not their messages',
  )
  const unread = unreadSenders.reduce((sum, row) => sum + row.unread, 0)
  equal(
    await page.locator('[data-field="subtitle"]').innerText(),
    `${unread.toLocaleString('en-US')} unread from ${rows.length} senders`,
    'the head counts unread messages and senders',
  )

  // Codeyard's strip holds the seed's days, and reads as a rate.
  const strip = await codeyardRow(page)
    .locator('[data-field="strip"] i')
    .evaluateAll((bars) =>
      bars.map((bar) => ({
        messages: Number(bar.getAttribute('data-messages')),
        unread: bar.getAttribute('data-unread') === 'true',
      })),
    )
  equal(strip, codeyardDays, "Codeyard's strip holds its messages on each of the last 14 days, bright where unread")
  const perDay = Math.round(codeyardDays.reduce((sum, day) => sum + day.messages, 0) / 14)
  equal(
    await codeyardRow(page).locator('[data-field="rate"]').textContent(),
    `about ${perDay} a day`,
    'the rate reads off the strip',
  )
  const heights = await codeyardRow(page)
    .locator('[data-field="strip"] i')
    .evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().height))
  equal(
    heights.map((height, index) => (codeyardDays[index]?.messages === 0 ? height === 0 : height >= 2)),
    heights.map(() => true),
    'a day with mail has a bar, and an empty day only the baseline',
  )

  // Opening Codeyard shows its newest message in full, and the rest folded by day.
  await codeyardRow(page).click()
  await page.locator('article[aria-label="Sender"] [data-field="body"]').waitFor()
  equal(await text(page, '[data-field="reader-subject"]'), 'Codeyard', 'the reader is titled with the sender')
  equal(
    (await text(page, '[data-message="open"] [data-field="body"]'))?.startsWith('Lena Ortiz requested your review'),
    true,
    'the newest message is open in full',
  )
  const codeyard = rows.find((row) => row.name === 'Codeyard')
  equal(
    await page.locator('section[aria-label="Reader"] button', { hasText: /^Mark \d+ read$/ }).textContent(),
    `Mark ${codeyard?.unread} read`,
    "the toolbar's Mark read counts the sender's unread messages",
  )
  const todayCount = codeyardDays.at(-1)?.messages ?? 0
  equal(
    await page.locator('[data-field="day"]').evaluateAll((days) => days.map((day) => day.textContent)),
    [
      `Today${todayCount - 1}`,
      `Yesterday${codeyardDays.at(-2)?.messages}`,
      `Earlier${codeyardThreads - todayCount - (codeyardDays.at(-2)?.messages ?? 0)}`,
    ],
    'the rest fold under Today, Yesterday and Earlier',
  )
  return { senders: rows.length, unread }
}

export async function checkUpdatesScreens(browser: Browser, url: string) {
  const { page, errors, close } = await openPage(browser, url, 'trace-updates.zip')
  await page.locator('[data-field="people-count"]').waitFor()

  const shown = await checkUpdates(page)

  // The mock's scene: Codeyard open, the fifth row hovered with its two buttons.
  const hovered = page.locator('[data-sender]').nth(4)
  await captureC2(page, 'updates-1440', () => hovered.hover())
  equal(
    await hovered.getByRole('button', { name: 'Archive all' }).isVisible(),
    true,
    'a hovered row shows Archive all in place of its time',
  )
  await captureC2(page, 'updates-1024', async () => {
    await hovered.hover()
    equal(
      await page.locator('[data-field="subtitle"]').innerText(),
      `${shown.unread.toLocaleString('en-US')} unread · ${shown.senders} senders`,
      'narrow: the head is the short one',
    )
  })

  // Mark read from a hovered row reads all of one sender's mail. z takes it back.
  const before = await senderRows(page)
  const target = before.find((row, index) => index > 0 && row.unread > 0 && row.name !== 'Codeyard')
  if (!target) throw new Error('Updates shows no second sender with unread mail')
  const row = page.locator(`[data-sender="${target.id}"]`)
  const sidebarCount = Number(await text(page, '[data-field="updates-count"]'))
  await row.hover()
  await row.getByRole('button', { name: 'Mark read' }).click()
  await row.locator('[data-field="unread-count"]').waitFor({ state: 'detached' })
  equal(
    [await text(page, '[data-field="toast"]'), await text(page, '[data-field="toast-note"]')],
    ['Marked read', target.name],
    'the toast says what Mark read did, to whom',
  )
  await waitForText(page, '[data-field="updates-count"]', `${sidebarCount - 1}`)
  equal(await text(page, '[data-field="updates-count"]'), `${sidebarCount - 1}`, 'the sidebar counts one sender fewer')
  await page.mouse.move(0, 0)
  await page.keyboard.press('z')
  await row.locator('[data-field="unread-count"]').waitFor()
  equal(
    Number(await row.locator('[data-field="unread-count"]').textContent()),
    target.unread,
    'z brings back every unread message',
  )

  // Archive all takes the sender out of Updates. Undo brings it back.
  await row.hover()
  await row.getByRole('button', { name: 'Archive all' }).click()
  await row.waitFor({ state: 'detached' })
  equal(await text(page, '[data-field="toast"]'), 'Archived', 'the toast says the sender was archived')
  await toast(page).getByRole('button', { name: /^Undo/ }).click()
  await row.waitFor()
  equal((await senderRows(page)).length, before.length, 'Undo brings the sender back to Updates')

  // Let go?: the pile under People, by month, never amber.
  await nav(page, 'Let go').click()
  await page.locator('[role="option"] [data-field="subject"]').first().waitFor()
  equal(await text(page, '[data-field="let-go-count"]'), `${pile.length}`, 'the sidebar counts the turns in Let go?')
  equal(
    await page.locator('[data-field="month"]').evaluateAll((months) => months.map((month) => month.textContent)),
    monthsOf(pile).map((heading) => heading.replace(/ (\d+)$/, '$1')),
    'the pile is grouped by last month, the month before, and the rest',
  )
  equal(
    await page
      .locator('[role="option"] [data-field="subject"]')
      .evaluateAll((all) => all.map((one) => one.textContent)),
    pile.map((conversation) => conversation.subject),
    'the pile holds my turns that waited 30 days, newest first',
  )
  equal(
    [
      ...new Set(
        await page
          .locator('[role="option"] [data-field="age"]')
          .evaluateAll((ages) => ages.map((age) => getComputedStyle(age).color)),
      ),
    ],
    [MUTED],
    'an old turn waits in muted grey, not amber',
  )
  await page.locator('[role="option"]').first().click()
  await page.locator('[data-field="waited"]').waitFor()
  const first = pile[0]
  const days = first ? Math.floor((NOW - Date.parse(first.lastAt)) / DAY) : 0
  equal(await text(page, '[data-field="waited"]'), `Waited ${days}d`, 'the reader says how long the turn waited')
  const letGoButton = page.getByRole('button', { name: 'Let go', exact: true })
  equal(await letGoButton.getAttribute('aria-keyshortcuts'), 'd', "Let go takes Done's place, with its key")
  await captureC2(page, 'letgo-1440', () => letGoButton.hover())
  equal(await page.getByRole('tooltip', { name: 'Let go D' }).isVisible(), true, "Let go's tooltip names its key")
  await page.mouse.move(0, 0)

  // d lets the open turn go: it leaves the pile, the next one opens, and the toast offers Undo.
  await page.keyboard.press('d')
  await waitForText(page, '[data-field="let-go-count"]', `${pile.length - 1}`)
  await page.locator('[data-field="toast"]').waitFor()
  equal(
    [await text(page, '[data-field="toast"]'), await text(page, '[data-field="toast-note"]')],
    ['Let go', first?.subject ?? ''],
    'the toast says Let go, and what',
  )
  equal(await toast(page).locator('[data-icon="wind"]').count(), 1, 'the toast has the grey wind, not the green check')
  equal(
    await page.locator('[role="option"][aria-selected="true"] [data-field="subject"]').textContent(),
    pile[1]?.subject,
    'the next turn opens in its place',
  )
  await captureC2(page, 'letgo-undo-1440')
  await captureC2(page, 'letgo-undo-1024')
  await page.keyboard.press('z')
  await waitForText(page, '[data-field="let-go-count"]', `${pile.length}`)
  equal(
    await page.locator('[role="option"] [data-field="subject"]').first().textContent(),
    first?.subject,
    'z brings the turn back to the pile',
  )

  // People: Your turn holds only the turns of the last 30 days, which the core splits off.
  await nav(page, 'People').click()
  const fresh = seed.conversations.filter(
    (conversation) => conversation.turn === 'mine' && NOW - Date.parse(conversation.lastAt) < 30 * DAY,
  )
  await waitForText(page, 'h3 [data-field="count"]', `${fresh.length}`)
  equal(
    (
      await page
        .locator('[role="listbox"][aria-label="Your turn"] [data-field="subject"]')
        .evaluateAll((all) => all.map((one) => one.textContent))
    ).filter((subject) => pile.some((old) => old.subject === subject)),
    [],
    'Your turn holds none of the turns in Let go?',
  )
  await page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]').first().click()
  await page.locator('[data-message="open"] [data-field="body"]').waitFor()
  await captureC2(page, 'people-letgo-1440')

  await page.setViewportSize(SIZES.wide)
  equal(appErrors(errors), [], 'the page logged no errors')
  await close()
}
