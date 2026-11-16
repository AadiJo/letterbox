// The UI check over the `people-first` seed: People, All mail, the reader, the narrow
// window, keyboard actions, new mail and a reload, each checked against what the seed holds.

import type { SeedMessage } from '@letterbox/sim-provider/contract'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Browser, Page } from 'playwright'
import { join } from 'node:path'
import { ARTIFACTS, capture, equal, openPage, SIZES } from './record.ts'

const seed = devSeeds['people-first']
const DAY = 86_400_000
const NOW = Date.parse(seed.now)
const AMBER = 'rgb(255, 144, 94)'
const MUTED = 'rgb(165, 165, 165)'
const DELIVER = 3

/** The seed's conversations whose turn is `turn`, from the last 30 days, newest first. */
const fresh = (turn: 'mine' | 'theirs') =>
  seed.conversations
    .filter((conversation) => conversation.turn === turn && NOW - Date.parse(conversation.lastAt) <= 30 * DAY)
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt))
    .map((conversation) => conversation.subject)

const retired = seed.conversations
  .filter((conversation) => NOW - Date.parse(conversation.lastAt) > 30 * DAY)
  .map((conversation) => conversation.subject)

/** A message that answers no other starts a conversation. */
const conversations = seed.seed.messages.filter((message) => (message.replyTo ?? []).length === 0).length

const htmlMessage = seed.seed.messages.find(
  (message): message is SeedMessage & { html: string } => message.html !== undefined,
)

/** One field of every row in a People section, top to bottom. */
const column = (page: Page, section: string, field: string) =>
  page.locator(`[role="listbox"][aria-label="${section}"] [data-field="${field}"]`).allTextContents()

/** Waits until a list shows `subjects`, in order. */
const waitForSubjects = (page: Page, list: string, subjects: readonly string[]) =>
  page.waitForFunction(
    ([name, expected]) =>
      JSON.stringify(
        [...document.querySelectorAll(`[role="listbox"][aria-label="${name}"] [data-field="subject"]`)].map(
          (element) => element.textContent,
        ),
      ) === JSON.stringify(expected),
    [list, subjects] as const,
  )

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const nav = (page: Page, name: string) => sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })
const subtitle = (page: Page) => page.locator('[data-field="subtitle"]').textContent()

/** The unread count beside Inbox in the sidebar, read in the page. The sidebar leaves out a count of 0. */
const inboxCount = () => {
  const inbox = [...document.querySelectorAll('nav[aria-label="Sidebar"] button')].find((button) =>
    button.textContent?.startsWith('Inbox'),
  )
  return Number(inbox?.textContent?.replace(/\D/g, '') || 0)
}

const inboxUnread = (page: Page) => page.evaluate(inboxCount)

/** Waits for a list header to read `text`. */
const waitForSubtitle = (page: Page, text: string) =>
  page.waitForFunction((expected) => document.querySelector('[data-field="subtitle"]')?.textContent === expected, text)

/** Checks People against the seed, once the core has sent it. */
async function checkPeople(page: Page, when: string, mine: readonly string[]) {
  await waitForSubjects(page, 'Your turn', mine)
  await waitForSubjects(page, 'Waiting on others', fresh('theirs'))
  equal(
    await column(page, 'Your turn', 'subject'),
    mine,
    `${when}: your turn holds the seed's last 30 days, newest first`,
  )
  equal(
    await column(page, 'Waiting on others', 'subject'),
    fresh('theirs'),
    `${when}: waiting holds the seed's last 30 days, newest first`,
  )
  const shown = [
    ...(await column(page, 'Your turn', 'subject')),
    ...(await column(page, 'Waiting on others', 'subject')),
  ]
  equal(
    shown.filter((subject) => retired.includes(subject)),
    [],
    `${when}: People hides the ${retired.length} turns older than 30 days`,
  )
}

/** The color of every time slot in a People section. */
const slotColors = (page: Page, section: string) =>
  page
    .locator(`[role="listbox"][aria-label="${section}"] [data-field="age"]`)
    .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color))

export async function checkPeopleFirst(browser: Browser, url: string) {
  const { page, errors, remote, blocked, close } = await openPage(browser, url, 'trace-people-first.zip')

  // People, as the core sorts and the renderer filters it.
  const mine = fresh('mine')
  await checkPeople(page, 'first load', mine)
  const ages = await column(page, 'Your turn', 'age')
  equal(ages, ['1h', '5h', '1d', '3d', '6d', '11d', '16d', '26d'], 'ages come from the fixed clock')
  const late = ages.map((shown) => Number.parseInt(shown, 10) > 7 && shown.endsWith('d'))
  equal(
    await slotColors(page, 'Your turn'),
    late.map((isLate) => (isLate ? AMBER : MUTED)),
    'a turn is amber only past 7 days',
  )
  equal(
    (await slotColors(page, 'Waiting on others')).filter((color) => color !== MUTED),
    [],
    'waiting rows are never amber',
  )
  equal(
    await sidebar(page).locator('[data-field="people-count"]').textContent(),
    `${mine.length}`,
    'People counts your turns',
  )
  equal(await sidebar(page).locator('[data-field="late"]').count(), 1, 'People has the late dot')

  // Opening a conversation shows its body.
  await page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]').first().click()
  await page.locator('[data-message="open"] [data-field="body"]').waitFor()
  equal(await page.locator('[data-field="reader-subject"]').textContent(), mine[0], 'the reader shows the open subject')
  equal(
    (await page.locator('[data-message="open"] [data-field="body"]').textContent())?.startsWith('Hi Robin'),
    true,
    'the reader shows the newest message body',
  )
  await capture(page, 'people')

  // The narrow window: the sidebar folds behind a toggle, and search is an icon.
  await page.setViewportSize(SIZES.narrow)
  equal(await sidebar(page).isVisible(), false, 'narrow: the sidebar is hidden')
  equal(await page.getByRole('search').isVisible(), false, 'narrow: the search field is folded')
  equal(await page.getByRole('button', { name: 'Search', exact: true }).isVisible(), true, 'narrow: search is an icon')
  await page.getByRole('button', { name: 'Show the sidebar' }).click()
  equal(await sidebar(page).isVisible(), true, 'narrow: the toggle shows the sidebar')
  await page.screenshot({ path: join(ARTIFACTS, 'narrow-sidebar.png') })
  await page.getByRole('button', { name: 'Hide the sidebar' }).click()
  await page.setViewportSize(SIZES.wide)

  // Done, from the keyboard, takes the open turn out of Your turn and out of the count.
  await page.keyboard.press('d')
  await checkPeople(page, 'after Done', mine.slice(1))
  equal(
    await sidebar(page).locator('[data-field="people-count"]').textContent(),
    `${mine.length - 1}`,
    'Done lowers the People count',
  )

  // All mail lists every conversation.
  await nav(page, 'All mail').click()
  await waitForSubtitle(page, `${conversations} conversations`)
  await page.locator('[data-list="mail"] [role="option"]').first().click()
  await page.locator('[data-message="open"] [data-field="body"]').waitFor()
  await capture(page, 'all-mail')

  // An HTML body renders, and nothing in it runs or loads from the network.
  if (!htmlMessage) throw new Error('people-first has no HTML message')
  await page.evaluate(() => {
    window.addEventListener('message', (event) => document.body.setAttribute('data-got-message', String(event.data)))
  })
  // Every remote URL the body names. Each must be refused before it reaches the network.
  const remoteLoads = [...htmlMessage.html.matchAll(/(?:<link [^>]*href="|src="|url\()(https:[^")]+)/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  )
  const refused = Promise.all(
    remoteLoads.map((load) => page.waitForEvent('requestfailed', (request) => request.url() === load)),
  )
  await page.locator('[data-list="mail"] [role="option"]', { hasText: htmlMessage.subject }).click()
  const frame = page.frameLocator('iframe[title="Message"]')
  await frame.locator('h1').waitFor()
  equal(
    await frame.locator('#probe').textContent(),
    'Nothing in this message ran.',
    'an HTML body cannot run script or handlers',
  )
  equal(await page.locator('body').getAttribute('data-got-message'), null, 'an HTML body cannot reach the app')
  equal(
    await page.locator('iframe[title="Message"]').getAttribute('sandbox'),
    'allow-same-origin',
    'the body frame is sandboxed without scripts',
  )
  await refused
  equal(blocked.toSorted(), remoteLoads.toSorted(), "the body frame's policy blocked its stylesheet, font and pixel")
  equal(remote, [], 'the page never reached past 127.0.0.1')
  await page.screenshot({ path: join(ARTIFACTS, 'html-body.png') })

  // A link in the body cannot take the frame to a remote page. The click ends in a request,
  // or in a refusal the console names by origin, and either way nothing remote may load.
  const link = /<a id="out" href="([^"]+)"/.exec(htmlMessage.html)?.[1]
  if (!link) throw new Error('the HTML message has no link')
  const clicked = Promise.race([
    page.waitForEvent('requestfinished', (request) => request.url().startsWith(link)),
    page.waitForEvent('requestfailed', (request) => request.url().startsWith(link)),
    page.waitForEvent('console', (message) => message.text().includes(new URL(link).origin)),
  ])
  await frame.locator('#out').click()
  await clicked
  equal(remote, [], 'clicking a link in the body loads nothing remote')
  equal(
    page
      .frames()
      .slice(1)
      .map((child) => child.url()),
    ['about:srcdoc'],
    'the body frame stays on its own document after a link click',
  )

  // Archiving from the keyboard takes the row out of Inbox and out of its count. The next
  // conversation opens in its place, marked read like one opened by hand.
  await nav(page, 'Inbox').click()
  await page.waitForFunction(() =>
    /^\d+ conversations$/.test(document.querySelector('[data-field="subtitle"]')?.textContent ?? ''),
  )
  const inbox = Number.parseInt((await subtitle(page)) ?? '', 10)
  const rows = page.locator('[data-list="mail"] [role="option"]')
  const listed = await rows.evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute('data-row') ?? '',
      unread: element.getAttribute('data-unread') === 'true',
    })),
  )
  const at = listed.findIndex((row, index) => row.unread && listed[index + 1]?.unread)
  const [first, second] = [listed[at]?.id, listed[at + 1]?.id]
  if (!first || !second) throw new Error('Inbox shows no two unread conversations next to each other')
  const unreadBefore = await inboxUnread(page)
  await page.locator(`[data-row="${first}"]`).click()
  await page.keyboard.press('e')
  await waitForSubtitle(page, `${inbox - 1} conversations`)
  equal(await page.locator(`[data-row="${first}"]`).count(), 0, 'archiving with e takes the row out of Inbox')
  equal(
    await page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row'),
    second,
    'the next conversation opens in its place',
  )
  // Marking read is a command of its own, so give its update a moment to land.
  await page.waitForFunction(`(${inboxCount})() === ${unreadBefore - 2}`, null, { timeout: 5000 }).catch(() => {})
  equal(await inboxUnread(page), unreadBefore - 2, 'the conversation that opens after an archive is marked read')

  // Flagging leaves the row in Inbox, so scrolling it out of the window keeps it open.
  const open = await page.locator('[data-field="reader-subject"]').textContent()
  await page.keyboard.press('s')
  const away = 400 * 73
  await page.locator('[data-list="mail"]').evaluate((list, top) => list.scrollTo({ top }), away)
  await page.waitForFunction(
    (top) =>
      [...document.querySelectorAll<HTMLElement>('[data-list="mail"] [role="option"]')].some(
        (row) => Number.parseFloat(row.style.top) >= top,
      ),
    away,
  )
  equal(await page.locator(`[data-row="${second}"]`).count(), 0, 'the flagged row scrolled out of the window')
  equal(
    await page.locator('[data-field="reader-subject"]').textContent(),
    open,
    'scrolling a flagged conversation out of the window keeps it open',
  )

  // Each search starts with nothing open.
  const search = page.getByLabel('Search mail')
  await search.fill('Climbing on Saturday')
  await search.press('Enter')
  await page.waitForFunction(() =>
    /^[1-9]\d* conversations?$/.test(document.querySelector('[data-field="subtitle"]')?.textContent ?? ''),
  )
  await page.locator('[data-list="mail"] [role="option"]').first().click()
  await page.locator('[data-message="open"]').waitFor()
  await page.getByLabel('Search mail').fill('no conversation says this')
  await page.getByLabel('Search mail').press('Enter')
  await waitForSubtitle(page, '0 conversations')
  equal(await page.getByText('No conversation selected').isVisible(), true, 'a new search starts with nothing open')
  equal(await page.getByRole('button', { name: 'Archive' }).isDisabled(), true, 'with nothing open, the toolbar is off')
  await page.getByLabel('Search mail').press('Escape')

  // New mail shows up live.
  await nav(page, 'All mail').click()
  await page.waitForFunction(() => window.letterboxDev !== undefined)
  await page.evaluate((count) => window.letterboxDev?.deliver(count), DELIVER)
  await waitForSubtitle(page, `${conversations + DELIVER} conversations`)
  equal(
    await subtitle(page),
    `${conversations + DELIVER} conversations`,
    `deliver(${DELIVER}) adds ${DELIVER} conversations`,
  )

  // A reload is a new tab for the dev host: it stops the old core and starts one over the same store.
  await page.reload()
  await checkPeople(page, 'after a reload', mine.slice(1))

  const compiled = await (await fetch(new URL('src/Row.tsx', url))).text()
  equal(compiled.includes('compiler-runtime'), true, 'React Compiler compiles the renderer')
  equal(await page.getByRole('alert').count(), 0, 'the page never lost the core')
  // The body frame's blocked script, loads and link log errors. They are the sandbox and the policy working.
  const refusal = /Content Security Policy|in a sandboxed frame|sandboxed and the 'allow-scripts'/
  equal(
    errors.filter((error) => !refusal.test(error)),
    [],
    'the page logged no errors',
  )
  await close()
}
