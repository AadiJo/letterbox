// The UI check of the strip that says the page lost the core (LostCore.tsx), in the mock's
// scene: People, Maya marked done, Tomas open, then the connection drops and z finds it gone.
// The strip spans the reader's foot, its words on the reading column, and covers no list row:
// the reader's content ends above it and the list runs on to the window's foot. The toast
// sits 12 px above it, centered on the reader, its words on top. The toolbar's actions and the
// reply bar show off at 40%, and r opens no reply. Reload connects again. With the reply editor
// up, the toast keeps to the editor instead. Like rollback.ts, this
// check builds the dev host's parts in this process, over state of its own, so Maya's turn is
// there to mark done. Writes lost-core.png (1440×900) and lost-core-narrow.png (1024×700).

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startSimProvider } from '@letterbox/sim-provider/server'
import type { Browser, Locator, Page } from 'playwright'
import { logChildrenTo, stopChildren } from '../children.ts'
import { buildCore, type Paths } from '../core.ts'
import { startServer } from '../server.ts'
import { appErrors, boxOf, capture, equal, openPage, overlaps, root, SIZES } from './record.ts'
import { dock, ME, open, seed, toast, yourTurn } from './reply-page.ts'

const STATE = join(root, '.letterbox/ui-check-lost-core')
const strip = (page: Page) => page.locator('[data-field="lost-core"]')

/** What the toast says when the connection was gone before z could send the undo (renderer undo.ts). */
const NOT_UNDONE = "Lost the connection, so this wasn't undone"

/**
 * Where the toast sits against the strip once it has risen: the gap between them in px, and
 * whether its words are what shows at their center. Waits for the strip first.
 */
export async function toastBesideStrip(page: Page) {
  await strip(page).waitFor()
  return page.evaluate(async () => {
    const box = document.querySelector('[role="status"]:has([data-field="toast"])')
    const words = box?.querySelector('[data-field="toast"]')
    const foot = document.querySelector('[data-field="lost-core"]')
    if (!box || !words || !foot) throw new Error('the page shows no toast, or no lost-core strip')
    await Promise.all(box.getAnimations().map((animation) => animation.finished))
    const text = words.getBoundingClientRect()
    const shown = document.elementFromPoint(text.left + text.width / 2, text.top + text.height / 2)
    return {
      gap: Math.round(foot.getBoundingClientRect().top - box.getBoundingClientRect().bottom),
      readable: shown !== null && words.contains(shown),
    }
  })
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5
const READER = 'section[aria-label="Reader"]'
const STRIP = '[data-field="lost-core"]'

/** How the strip sits in the window: each rule of the mock, with whether it holds. */
async function placement(page: Page) {
  const at = await boxOf(page, STRIP)
  const reader = await boxOf(page, READER)
  const list = await boxOf(page, 'section[aria-label="People"]')
  const content = await boxOf(page, `${READER} [data-scroll]`)
  const column = await boxOf(page, `${STRIP} .reading-column`)
  const toolbarColumn = await boxOf(page, `${READER} .top-band .reading-column`)
  const icon = await boxOf(page, `${STRIP} svg`)
  const reload = await boxOf(page, `${STRIP} button`)
  const box = await boxOf(page, '[role="status"]:has([data-field="toast"])')
  const rows = await page.locator('[role="option"]').evaluateAll((found) =>
    found.map((row) => {
      const { left, top, right, bottom } = row.getBoundingClientRect()
      return { left, top, right, bottom }
    }),
  )
  return {
    'spans the reader pane at its foot, 44 px tall':
      near(at.left, reader.left) &&
      near(at.right, reader.right) &&
      near(at.bottom, reader.bottom) &&
      near(at.bottom - at.top, 44),
    "the reader's content ends above it": content.bottom <= at.top + 0.5,
    "the list runs to the window's foot": near(list.bottom, page.viewportSize()?.height ?? 0),
    'covers no list row': rows.every((row) => !overlaps(row, at)),
    'its words and Reload span the reading column':
      near(column.left, toolbarColumn.left) && near(icon.left, column.left) && near(reload.right, column.right),
    'the toast is centered on the reader': Math.abs((box.left + box.right) / 2 - (reader.left + reader.right) / 2) < 1,
  }
}

/** Each match's opacity through all its ancestors, to two places. */
const opacities = (found: Locator) =>
  found.evaluateAll((elements) =>
    elements.map((element) => {
      let shown = 1
      for (let at: Element | null = element; at; at = at.parentElement) shown *= Number(getComputedStyle(at).opacity)
      return Math.round(shown * 100) / 100
    }),
  )

/** The reader's controls while the core is lost: which are off, and how they show. */
async function controls(page: Page) {
  const reader = page.locator(READER)
  const actions = reader.locator('.top-band button[aria-keyshortcuts]')
  const bar = reader.locator('[data-field="reply-bar"]')
  return {
    actions: await actions.evaluateAll((buttons) =>
      buttons.map((button) => [button.getAttribute('aria-keyshortcuts'), button.matches(':disabled')]),
    ),
    opacity: await opacities(actions),
    search: await opacities(reader.locator('form[role="search"], button[aria-label="Search"]')),
    bar: {
      inert: await bar.evaluate((element) => element.closest('[inert]') !== null),
      opacity: await opacities(bar),
      keycaps: await bar.locator('kbd').count(),
    },
  }
}

/** Checks the strip, the toast and the controls at `size`. */
async function checkAt(page: Page, size: keyof typeof SIZES) {
  await page.setViewportSize(SIZES[size])
  const rules = await placement(page)
  equal(
    Object.entries(rules).flatMap(([rule, kept]) => (kept ? [] : [rule])),
    [],
    `${size}: the strip spans the reader's foot, clear of the list, with the toast centered above it`,
  )
  equal(
    await toastBesideStrip(page),
    { gap: 12, readable: true },
    `${size}: "${NOT_UNDONE}" sits 12 px above the strip, readable`,
  )
}

export async function checkLostCore(browser: Browser) {
  rmSync(STATE, { recursive: true, force: true })
  const paths: Paths = {
    root,
    data: join(STATE, 'data'),
    socket: join(STATE, 'provider.sock'),
    coreLog: join(STATE, 'core.log'),
  }
  mkdirSync(paths.data, { recursive: true })
  logChildrenTo(join(STATE, 'host.log'))

  await buildCore(paths)
  const provider = await startSimProvider(paths.socket)
  provider.createMailbox(seed.dialect, seed.seed)
  const server = await startServer({ paths, port: 0, relay: true, sim: { now: seed.now, deliver: () => {} } })
  const opened = await openPage(browser, server.url, 'trace-lost-core.zip')
  const { page, errors, relay } = opened
  try {
    await page.waitForFunction(() => window.letterboxDev !== undefined)
    await page.evaluate(([address, password]) => window.letterboxDev?.signIn(address, password), [
      ME,
      seed.seed.password,
    ] as const)
    await yourTurn(page).first().waitFor()

    // The mock's scene: Maya marked done, so Tomas opens next, and the toast offers Undo.
    await open(page, 'Notes from Thursday')
    const maya = await page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row')
    await page.keyboard.press('d')
    await toast(page).filter({ hasText: 'Marked done' }).waitFor()
    await page.locator(`[data-row="${maya}"]`).waitFor({ state: 'detached' })
    await page.locator('h3[data-field="reader-subject"]', { hasText: 'Lease addendum for 4B' }).waitFor()
    await relay.drop()
    equal(
      await toastBesideStrip(page),
      { gap: 12, readable: true },
      'with the core lost, the toast that offers Undo sits 12 px above the strip, readable',
    )
    equal(
      await controls(page),
      {
        actions: [
          ['d', true],
          ['e', true],
          ['#', true],
          ['s', true],
          ['u', true],
        ],
        opacity: [0.4, 0.4, 0.4, 0.4, 0.4],
        search: [1, 1],
        bar: { inert: true, opacity: [0.4], keycaps: 1 },
      },
      'with the core lost, Done, the actions and the reply bar are off at 40%, keycaps kept, and search is not',
    )
    await page.keyboard.press('r')
    equal(await dock(page).count(), 0, 'with the core lost, r opens no reply')

    await page.keyboard.press('z')
    await toast(page).filter({ hasText: NOT_UNDONE }).waitFor()
    await checkAt(page, 'wide')
    await checkAt(page, 'narrow')
    await capture(page, 'lost-core')
    // The notice lasts 5 s. Every picture above must show it.
    equal(await toast(page).filter({ hasText: NOT_UNDONE }).count(), 1, 'the toast was up for every picture')

    await Promise.all([page.waitForEvent('load'), strip(page).getByRole('button', { name: 'Reload' }).click()])
    await yourTurn(page).first().waitFor()
    equal(await strip(page).count(), 0, 'Reload connects to a core again, and the strip goes')

    // With the reply editor up, the toast keeps to the editor, clear of Send, and not to the strip below it.
    await open(page, 'Lease addendum for 4B')
    const tomas = await page.locator('[role="option"][aria-selected="true"]').getAttribute('data-row')
    await page.keyboard.press('d')
    await toast(page).filter({ hasText: 'Marked done' }).waitFor()
    await page.locator(`[data-row="${tomas}"]`).waitFor({ state: 'detached' })
    await page.keyboard.press('r')
    await dock(page).waitFor()
    await relay.drop()
    await strip(page).waitFor()
    await toast(page).evaluate((box) => Promise.all(box.getAnimations().map((animation) => animation.finished)))
    // The editor slides up as it docks. The toast keeps to where it lands, so measure it there.
    await dock(page).evaluate((box) => Promise.all(box.getAnimations().map((animation) => animation.finished)))
    const editor = await boxOf(page, 'section[aria-label="Reply"]')
    const above = await boxOf(page, '[role="status"]:has([data-field="toast"])')
    equal(
      Math.round(editor.top - above.bottom),
      12,
      'with the reply editor up and the core lost, the toast sits 12 px above the editor, not the strip',
    )
    equal(appErrors(errors), [], 'the lost-core page logged no errors')
  } finally {
    await opened.close()
    await server.close()
    await provider.close()
    await stopChildren()
  }
}
