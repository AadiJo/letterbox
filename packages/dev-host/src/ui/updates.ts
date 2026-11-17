// The UI check over the `updates` seed, read in Chicago, where the evening's dates differ
// from UTC's: Updates with its volume strips counted by the user's days, the list windowed
// to its last sender, an opened sender with its newest marked read and every older line
// reachable, Mark read and Archive all of a sender with over 50 conversations and their
// undo, the Let go? pile by month with Let go on d and its toast, People, and avatar
// contrast. Each is checked against what the seed holds, and captured at the mock's scenes
// (c2-updates-1440.png beside b-updates-1440.png, and so on).

import type { SeedAddress, SeedMessage } from '@letterbox/sim-provider/contract'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Browser, Locator, Page } from 'playwright'
import { MUTED } from './c2.ts'
import { appErrors, captureC2, equal, openPage, SIZES } from './record.ts'

const seed = devSeeds.updates
const ZONE = 'America/Chicago'
const DAY = 86_400_000
const NOW = Date.parse(seed.now)
const CODEYARD = 'notifications@codeyard.example'

const addressOf = (who: SeedAddress) => (typeof who === 'string' ? who : who.address)
const nameOf = (who: SeedAddress) => (typeof who === 'string' ? who : who.name)
const sent = (message: SeedMessage) => Date.parse(message.sentAt)

/** The Chicago date `ms` falls on, as YYYY-MM-DD. */
const dayIn = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(ms)
const today = dayIn(NOW)
const yesterday = dayIn(NOW - DAY)
/** The last 14 Chicago days, oldest first. */
const lastDays = Array.from({ length: 14 }, (_, index) => dayIn(NOW - (13 - index) * DAY))

/** Mail from machines: every message the seed sends alone, each its own conversation. */
const automated = seed.seed.messages.filter((message) => /^(auto-|volume-|html-newsletter)/.test(message.key))
const byAddress = Map.groupBy(automated, (message) => addressOf(message.from))
const unreadSenders = [...byAddress.values()].filter((mail) => mail.some((message) => message.unread === true))
const unreadMessages = automated.filter((message) => message.unread === true).length
/** The sender whose newest mail is oldest: Updates' last row. */
const lastSender = [...byAddress.values()]
  .map((mail) => ({ name: nameOf(mail[0]?.from ?? ''), newest: Math.max(...mail.map(sent)) }))
  .toSorted((a, b) => a.newest - b.newest)[0]

const codeyard = (byAddress.get(CODEYARD) ?? []).toSorted((a, b) => sent(b) - sent(a))
/** Codeyard's messages on each of the last 14 Chicago days, oldest first, and whether each day has unread mail. */
const codeyardDays = lastDays.map((day) => {
  const mail = codeyard.filter((message) => dayIn(sent(message)) === day)
  return { messages: mail.length, unread: mail.some((message) => message.unread === true) }
})
const late = codeyard.find((message) => message.key === 'volume-late')
const oldest = codeyard.at(-1)

/** My turns that waited 30 days or more, newest first: the Let go? pile. */
const pile = seed.conversations
  .filter((conversation) => conversation.turn === 'mine' && NOW - Date.parse(conversation.lastAt) >= 30 * DAY)
  .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))

const monthIndex = (time: string) => {
  const [year = 0, month = 0] = dayIn(Date.parse(time)).split('-').map(Number)
  return year * 12 + month - 1
}
const monthName = (month: number) => {
  const first = new Date(Date.UTC(Math.floor(month / 12), month % 12, 15))
  const sameYear = first.getUTCFullYear() === new Date(NOW).getUTCFullYear()
  return first.toLocaleString('en-US', { month: 'long', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }) })
}

/**
 * The pile's headings as the design groups them: last month and the month before while each
 * has 3 or more turns, then "… and older" from the first month that has fewer.
 */
function headingsOf(conversations: typeof pile) {
  const last = monthIndex(seed.now) - 1
  const headings: string[] = []
  let older = last - 2
  for (const month of [last, last - 1]) {
    const count = conversations.filter((conversation) => monthIndex(conversation.lastAt) === month).length
    if (count === 0) continue
    if (count < 3) {
      older = month
      break
    }
    headings.push(`${monthName(month)}${count}`)
  }
  const shown = headings.reduce((sum, heading) => sum + Number(/\d+$/.exec(heading)?.[0]), 0)
  if (conversations.length > shown) headings.push(`${monthName(older)} and older${conversations.length - shown}`)
  return headings
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const nav = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })
const text = (page: Page, selector: string) => page.locator(selector).first().textContent()
const toast = (page: Page) => page.locator('[role="status"]').filter({ has: page.locator('[data-field="toast"]') })
const senderRow = (page: Page, name: string) =>
  page
    .locator('[data-sender]')
    .filter({ has: page.locator('[data-field="person"]', { hasText: new RegExp(`^${name}$`) }) })

/** Waits for the page's `selector` to read `expected`. */
const waitForText = (page: Page, selector: string, expected: string) =>
  page.waitForFunction(([where, wanted]) => document.querySelector(where)?.textContent === wanted, [
    selector,
    expected,
  ] as const)

/** The text of every match of `selector` under `within`. */
const texts = (within: Locator, selector: string) =>
  within.locator(selector).evaluateAll((all) => all.map((one) => one.textContent ?? ''))

async function checkList(page: Page) {
  await nav(page, 'Updates').click()
  await page.locator('[data-sender]').first().waitFor()
  equal(
    await text(page, '[data-field="updates-count"]'),
    `${unreadSenders.length}`,
    'the sidebar counts the senders with unread mail, not their messages',
  )
  equal(
    await page.locator('[data-field="subtitle"]').innerText(),
    `${unreadMessages} unread from ${unreadSenders.length} senders`,
    "the head's sender count is the sidebar's: senders with unread mail",
  )

  // Codeyard's strip holds the seed's Chicago days: the 10:30 PM notice is on yesterday's bar.
  const row = senderRow(page, 'Codeyard')
  const bars = await row.locator('[data-field="strip"] i').evaluateAll((all) =>
    all.map((bar) => ({
      messages: Number(bar.getAttribute('data-messages')),
      unread: bar.getAttribute('data-unread') === 'true',
      height: bar.getBoundingClientRect().height,
    })),
  )
  equal(
    bars.map(({ messages, unread }) => ({ messages, unread })),
    codeyardDays,
    "Codeyard's strip counts its mail by the user's days, bright where unread",
  )
  const most = Math.max(
    ...(await page
      .locator('[data-sender] [data-field="strip"] i')
      .evaluateAll((all) => all.map((bar) => Number(bar.getAttribute('data-messages'))))),
  )
  equal(
    bars.map((bar) => bar.height),
    codeyardDays.map((day) => (day.messages === 0 ? 0 : Math.round(2 + 12 * Math.sqrt(day.messages / most)))),
    "each bar's height follows its day's count against the busiest day shown, and an empty day is only baseline",
  )
  equal(
    await row.locator('[data-field="rate"]').textContent(),
    `about ${Math.round(codeyardDays.reduce((sum, day) => sum + day.messages, 0) / 14)} a day`,
    'the rate reads off the strip',
  )

  // The list is windowed: it renders the rows on screen, and scrolls to its last sender.
  const rendered = await page.locator('[data-sender]').count()
  equal(rendered < byAddress.size, true, `the list renders ${rendered} of ${byAddress.size} senders, not all of them`)
  await page
    .locator('[role="listbox"][aria-label="Updates"]')
    .evaluate((list) => list.scrollTo({ top: list.scrollHeight }))
  await senderRow(page, lastSender?.name ?? '').waitFor()
  equal(await senderRow(page, lastSender?.name ?? '').count(), 1, 'the oldest sender has a row at the end of the list')
  await page.locator('[role="listbox"][aria-label="Updates"]').evaluate((list) => list.scrollTo({ top: 0 }))
  await row.waitFor()
}

async function checkReader(page: Page) {
  const row = senderRow(page, 'Codeyard')
  const unreadBefore = Number(await row.locator('[data-field="unread-count"]').textContent())
  await row.click()
  await page.locator('article[aria-label="Sender"] [data-field="body"]').waitFor()
  equal(await text(page, '[data-field="reader-subject"]'), 'Codeyard', 'the reader is titled with the sender')
  equal(
    (await text(page, '[data-message="open"] [data-field="body"]'))?.startsWith('Lena Ortiz requested your review'),
    true,
    'the newest message is open in full',
  )
  await waitForText(page, '[data-sender][aria-selected="true"] [data-field="unread-count"]', `${unreadBefore - 1}`)
  equal(
    await text(page, '[data-sender][aria-selected="true"] [data-field="unread-count"]'),
    `${unreadBefore - 1}`,
    'opening the sender marks its newest message read',
  )

  // Today and Yesterday by the user's days, with times of day. Earlier counts the rest.
  const article = page.locator('article[aria-label="Sender"]')
  const inToday = codeyard.filter((message) => dayIn(sent(message)) === today).length
  const inYesterday = codeyard.filter((message) => dayIn(sent(message)) === yesterday).length
  equal(
    await texts(article, '[data-field="day"]'),
    [`Today${inToday - 1}`, `Yesterday${inYesterday}`, `Earlier${codeyard.length - inToday - inYesterday}`],
    'the rest fold under Today, Yesterday and Earlier, in Chicago',
  )
  const yesterdayLines = article.locator('section[aria-label="Yesterday"] [data-message="folded"]')
  equal(
    await yesterdayLines
      .filter({ hasText: late?.subject ?? '' })
      .locator('[data-field="message-time"]')
      .textContent(),
    '10:30 PM',
    "the notice from 03:30 UTC is yesterday's, at 10:30 PM",
  )
  const recentTimes = await texts(
    article.locator('section[aria-label="Today"], section[aria-label="Yesterday"]'),
    '[data-field="message-time"]',
  )
  equal(
    recentTimes.filter((time) => !/^\d{1,2}:\d{2} [AP]M$/.test(time)),
    [],
    'Today and Yesterday show the time of day, never "Yesterday"',
  )
  const dots = await article
    .locator('section[aria-label="Today"], section[aria-label="Yesterday"]')
    .locator('[data-message="folded"]')
    .evaluateAll((lines) =>
      lines.map((line) => {
        const time = line.querySelector('[data-field="message-time"]')?.getBoundingClientRect()
        const slot = line.querySelector('[data-field="unread"]')?.parentElement?.getBoundingClientRect()
        return { slot: slot ? Math.round(slot.left) : null, time: time ? Math.round(time.left) : null }
      }),
    )
  equal(
    new Set(dots.flatMap((dot) => (dot.slot === null ? [] : [dot.slot]))).size,
    1,
    'every unread dot sits in one column, whatever the time beside it',
  )
  equal(new Set(dots.map((dot) => dot.time)).size, 1, 'the times sit in one right-aligned column')

  // Every older conversation the reader counts can be reached: the last line is the oldest.
  await page.locator('section[aria-label="Reader"] .overflow-y-auto').evaluate((scroller) => {
    scroller.scrollTo({ top: scroller.scrollHeight })
  })
  const lastLine = article.locator('section[aria-label="Earlier"] [data-message="folded"]').last()
  const oldestTime = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: ZONE,
  }).format(oldest ? sent(oldest) : 0)
  await lastLine.filter({ hasText: oldestTime }).waitFor()
  equal(
    [
      await lastLine.locator('[data-field="subject"]').textContent(),
      await lastLine.locator('[data-field="message-time"]').textContent(),
    ],
    [oldest?.subject, oldestTime],
    `Earlier reaches Codeyard's oldest conversation, past the first 50`,
  )
  await page
    .locator('section[aria-label="Reader"] .overflow-y-auto')
    .evaluate((scroller) => scroller.scrollTo({ top: 0 }))
}

const parseColor = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number)
const channel = (value: number) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = ([r = 0, g = 0, b = 0]: readonly number[]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

/** Every avatar on screen: its tile's alpha, and the WCAG contrast of its initials on it. */
async function checkAvatars(page: Page) {
  const colors = await page
    .locator('[data-avatar]')
    .evaluateAll((all) =>
      all.map((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]),
    )
  const avatars = colors.map(([tile = '', initials = '']) => {
    const [light = 0, dark = 0] = [luminance(parseColor(initials)), luminance(parseColor(tile))].toSorted(
      (a, b) => b - a,
    )
    return { ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 10) / 10, alpha: parseColor(tile)[3] ?? 1 }
  })
  equal(
    avatars.filter((avatar) => avatar.alpha < 1 || avatar.ratio < 4.5),
    [],
    `all ${avatars.length} avatars are opaque tiles whose initials read at 4.5:1 or more`,
  )
}

/**
 * With the open sender scrolled out of the list, j opens the next sender the list has loaded,
 * and the list scrolls to it, even when its row was not painted. In a 1024 by 700 window, the
 * last screen of the list leaves loaded rows above the painted ones.
 */
async function checkKeyboardPastTheWindow(page: Page) {
  const list = page.locator('[role="listbox"][aria-label="Updates"]')
  await page.setViewportSize(SIZES.narrow)
  await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await senderRow(page, lastSender?.name ?? '').waitFor()
  equal(
    await page.locator('[data-sender][aria-selected="true"]').count(),
    0,
    'the open sender has scrolled out of the list',
  )
  await page.keyboard.press('j')
  const opened = page.locator('[data-sender][aria-selected="true"]')
  await opened.waitFor()
  const [row, box] = [await opened.boundingBox(), await list.boundingBox()]
  equal(
    row !== null && box !== null && row.y >= box.y && row.y + row.height <= box.y + box.height,
    true,
    'j opens a sender the list then scrolls fully into view',
  )
  await page.setViewportSize(SIZES.wide)
  await list.evaluate((element) => element.scrollTo({ top: 0 }))
  await senderRow(page, 'Codeyard').click()
  await page.locator('[data-field="archive-count"]').waitFor()
}

export async function checkUpdatesScreens(browser: Browser, url: string) {
  const { page, errors, close } = await openPage(browser, url, 'trace-updates.zip', ZONE)
  await page.locator('[data-field="people-count"]').waitFor()
  await checkList(page)
  await checkReader(page)
  await checkAvatars(page)

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
      `${unreadMessages - 1} unread · ${unreadSenders.length} senders`,
      'narrow: the head is the short one',
    )
  })

  await checkKeyboardPastTheWindow(page)

  // Mark read from a hovered row reads all of one sender's mail. z takes it back.
  const target = senderRow(page, 'Tasklane')
  const tasklaneUnread = Number(await target.locator('[data-field="unread-count"]').textContent())
  const sidebarCount = Number(await text(page, '[data-field="updates-count"]'))
  await target.hover()
  await target.getByRole('button', { name: 'Mark read' }).click()
  await target.locator('[data-field="unread-count"]').waitFor({ state: 'detached' })
  equal(
    [await text(page, '[data-field="toast"]'), await text(page, '[data-field="toast-note"]')],
    ['Marked read', 'Tasklane'],
    'the toast says what Mark read did, to whom',
  )
  await waitForText(page, '[data-field="updates-count"]', `${sidebarCount - 1}`)
  equal(await text(page, '[data-field="updates-count"]'), `${sidebarCount - 1}`, 'the sidebar counts one sender fewer')
  await page.mouse.move(0, 0)
  await page.keyboard.press('z')
  await target.locator('[data-field="unread-count"]').waitFor()
  equal(
    Number(await target.locator('[data-field="unread-count"]').textContent()),
    tasklaneUnread,
    'z brings back every unread message',
  )

  // Archive all takes every one of Codeyard's conversations, past the first 50. Undo brings them all back.
  const codeyardRow = senderRow(page, 'Codeyard')
  equal(
    await text(page, '[data-field="archive-count"]'),
    `${codeyard.length}`,
    "Archive all counts every one of Codeyard's conversations",
  )
  await codeyardRow.hover()
  await codeyardRow.getByRole('button', { name: 'Archive all' }).click()
  await codeyardRow.waitFor({ state: 'detached' })
  equal(await text(page, '[data-field="toast"]'), 'Archived', 'the toast says the sender was archived')
  equal(await codeyardRow.count(), 0, 'Codeyard leaves Updates: none of its conversations is left in the inbox')
  await toast(page).getByRole('button', { name: /^Undo/ }).click()
  await codeyardRow.waitFor()
  await codeyardRow.click()
  await waitForText(page, '[data-field="archive-count"]', `${codeyard.length}`)
  equal(
    await text(page, '[data-field="archive-count"]'),
    `${codeyard.length}`,
    'Undo brings back every one of its conversations',
  )

  // Let go?: the pile under People, by month, never amber.
  await nav(page, 'Let go').click()
  await page.locator('[role="option"] [data-field="subject"]').first().waitFor()
  equal(await text(page, '[data-field="let-go-count"]'), `${pile.length}`, 'the sidebar counts the turns in Let go?')
  equal(
    await texts(page.locator('body'), '[data-field="month"]'),
    headingsOf(pile),
    'the pile is grouped by last month, the month before, and the rest',
  )
  equal(
    await texts(page.locator('body'), '[role="option"] [data-field="subject"]'),
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
  const [first, second] = pile
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
  // The next one opens as the row folds away.
  await waitForText(page, '[role="option"][aria-selected="true"] [data-field="subject"]', second?.subject ?? '')
  equal(
    await page.locator('[role="option"][aria-selected="true"] [data-field="subject"]').textContent(),
    second?.subject,
    'the next turn opens in its place',
  )
  await captureC2(page, 'letgo-undo-1440')
  await captureC2(page, 'letgo-undo-1024')

  // Letting go of one more leaves last month two turns, too few for a heading: they join the older ones.
  await page.keyboard.press('d')
  await waitForText(page, '[data-field="let-go-count"]', `${pile.length - 2}`)
  equal(
    await texts(page.locator('body'), '[data-field="month"]'),
    headingsOf(pile.slice(2)),
    'a month with fewer than 3 turns folds into "… and older"',
  )
  await page.keyboard.press('z')
  await waitForText(page, '[data-field="let-go-count"]', `${pile.length - 1}`)
  equal(
    await texts(page.locator('body'), '[data-field="month"]'),
    headingsOf(pile.slice(1)),
    'z brings the turn back, and its month its heading',
  )

  // People: Your turn holds only the turns of the last 30 days, which the core splits off.
  await nav(page, 'People').click()
  const fresh = seed.conversations.filter(
    (conversation) => conversation.turn === 'mine' && NOW - Date.parse(conversation.lastAt) < 30 * DAY,
  )
  await waitForText(page, 'h3 [data-field="count"]', `${fresh.length}`)
  equal(
    (await texts(page.locator('[role="listbox"][aria-label="Your turn"]'), '[data-field="subject"]')).filter(
      (subject) => pile.some((old) => old.subject === subject),
    ),
    [],
    'Your turn holds none of the turns in Let go?',
  )
  await page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]').first().click()
  await page.locator('[data-message="open"] [data-field="body"]').waitFor()
  await checkAvatars(page)
  await captureC2(page, 'people-letgo-1440')

  await page.setViewportSize(SIZES.wide)
  equal(appErrors(errors), [], 'the page logged no errors')
  await close()
}
