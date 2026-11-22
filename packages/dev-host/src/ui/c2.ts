// The C2 design's rules, checked on the page as the user sees it: one top line across the
// panes, tooltips above their buttons with the app's real keys, label chips that name their
// label, readable disclosure chevrons, a filled dot on Mark as unread, and no control that
// does nothing. people-first.ts and done.ts call these with a conversation open.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { boxOf, equal, overlaps, root } from './record.ts'

/** The secondary text color, muted in styles.css. */
export const MUTED = 'rgb(163, 163, 163)'

/** Each toolbar control and the key its tooltip must show: actions.ts's SHORTCUTS. */
const KEYS = { Done: 'D', Archive: 'E', 'Move to Trash': '#', Flag: 'S', 'Mark as unread': 'U' } as const

/** Controls that would do nothing yet, by their Lucide icon class or their name. The list head's pen works: it opens the compose page. */
const DEAD = '.lucide-paperclip, .lucide-chevrons-up-down'

/**
 * A class name that is both a color and a type size (`text-key`) gets both, so its text takes
 * the color and turns unreadable. Tokens must not share a name across the two.
 */
function checkTokenNames() {
  const css = readFileSync(join(root, 'apps/desktop/renderer/src/styles.css'), 'utf8')
  const names = (prefix: string) =>
    new Set([...css.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+?):`, 'g'))].flatMap((match) => match[1] ?? []))
  const sizes = names('text')
  equal(
    [...names('color')].filter((name) => sizes.has(name)),
    [],
    'no design token is both a color and a type size',
  )
}

/** The rules on a 1440 px window with a conversation open in People. */
export async function checkC2(page: Page) {
  checkTokenNames()
  const reader = 'section[aria-label="Reader"]'

  // One top line: the account's avatar, the list's title and the toolbar all start on it.
  const tops = {
    account: (await boxOf(page, '[data-field="account"] [data-avatar]')).top,
    title: (await boxOf(page, '[data-field="list-title"]')).top,
    toolbar: (await boxOf(page, `${reader} button[aria-keyshortcuts="d"]`)).top,
    search: (await boxOf(page, `${reader} form[role="search"]`)).top,
  }
  equal(
    Object.values(tops).every((top) => Math.abs(top - tops.toolbar) <= 0.5),
    true,
    `every pane's first element starts on one line (${JSON.stringify(tops)})`,
  )

  // The subject has room under the toolbar: its capitals start 28 px below the buttons.
  const done = await boxOf(page, `${reader} button[aria-keyshortcuts="d"]`)
  equal(
    Math.round((await boxOf(page, '[data-field="reader-subject"]')).top - done.bottom),
    28,
    'the subject starts 28 px under the toolbar',
  )

  // The list is as wide as the design sets it at 1440 px.
  equal(
    Math.round(
      (await boxOf(page, 'section[aria-label="People"]')).right -
        (await boxOf(page, 'nav[aria-label="Sidebar"]')).right,
    ),
    372,
    'the list is 372 px wide at 1440 px',
  )

  // Search is one group sized to its content: icon, "Search", then its key 8 px on.
  const search = await page.locator(`${reader} form[role="search"]`).evaluate((form) => {
    const [field, key] = [form.querySelector('input'), form.querySelector('kbd')]
    if (!field || !key) throw new Error('search has no field or key')
    const [fieldBox, keyBox] = [field.getBoundingClientRect(), key.getBoundingClientRect()]
    return { gap: keyBox.left - fieldBox.right, tail: form.getBoundingClientRect().right - keyBox.right }
  })
  equal(
    [Math.round(search.gap), search.tail <= 4],
    [8, true],
    `search's key sits 8 px after its label, and the group ends at the key (${JSON.stringify(search)})`,
  )

  // At rest the conversation has nothing over its subject. Scrolled, a hairline marks its top
  // edge, with a shadow of 10 px at most and no gradient, and the first line under it keeps its color.
  const edge = page.locator('[data-field="scroll-edge"]')
  equal(await edge.count(), 0, 'an unscrolled conversation has no edge over its subject')
  await page.locator('[data-scroll]').evaluate((element) => element.scrollTo({ top: 300 }))
  await edge.waitFor()
  const scrolled = await page.locator('[data-scroll]').evaluate((scroller) => {
    const region = scroller.getBoundingClientRect()
    const line = scroller.parentElement?.querySelector<HTMLElement>('[data-field="scroll-edge"]')
    const first = [...scroller.querySelectorAll<HTMLElement>('[data-field="body"] p')].find(
      (paragraph) => paragraph.getBoundingClientRect().bottom > region.top + 1,
    )
    if (!line || !first) throw new Error('the scrolled conversation has no edge or no paragraph in view')
    const gradients = [...document.querySelectorAll('section[aria-label="Reader"] *')].filter((element) =>
      getComputedStyle(element).backgroundImage.includes('gradient'),
    ).length
    return {
      edge: [line.getBoundingClientRect().height, Math.round(line.getBoundingClientRect().top - region.top)],
      // Tailwind lists its unused ring shadows first. The band's own shadow is the last.
      shadow: getComputedStyle(line)
        .boxShadow.split(/,\s*(?=rgba)/)
        .at(-1),
      gradients,
      firstLine: getComputedStyle(first).color,
    }
  })
  equal(
    scrolled,
    { edge: [1, 0], shadow: 'rgba(0, 0, 0, 0.35) 0px 2px 8px 0px', gradients: 0, firstLine: 'rgb(228, 228, 228)' },
    'a scrolled conversation shows a hairline with a 10 px shadow, no gradient, and its first line at full color',
  )
  await page.locator('[data-scroll]').evaluate((element) => element.scrollTo({ top: 0 }))
  await edge.waitFor({ state: 'detached' })

  // Each tooltip names its key, sits 6 px above its button and 8 px or more inside the window, and clears the subject.
  const subject = await boxOf(page, '[data-field="reader-subject"]')
  const seen: Record<string, string> = {}
  const hoverTooltip = async (name: string) => {
    const control = page.locator(reader).getByRole('button', { name, exact: true })
    await control.hover()
    const tip = page.locator('[role="tooltip"]:visible')
    const [tipBox, buttonBox, key] = await Promise.all([
      tip.boundingBox(),
      control.boundingBox(),
      tip.locator('kbd').textContent(),
    ])
    if (!tipBox || !buttonBox) throw new Error(`hovering ${name} shows no tooltip`)
    seen[name] = key ?? ''
    const box = { left: tipBox.x, top: tipBox.y, right: tipBox.x + tipBox.width, bottom: tipBox.y + tipBox.height }
    equal(
      [Math.round(buttonBox.y - box.bottom), box.top >= 8, overlaps(box, subject)],
      [6, true, false],
      `${name}'s tooltip sits 6 px above its button, 8 px or more from the window's top, clear of the subject`,
    )
  }
  for (const name of Object.keys(KEYS)) {
    // oxlint-disable-next-line no-await-in-loop -- one tooltip shows at a time, so each hover waits for the last
    await hoverTooltip(name)
  }
  equal(seen, KEYS, "each tooltip shows the app's own key")
  await page.mouse.move(0, 0)

  // Mark as unread is the envelope with a filled dot, 4 px across.
  const dot = await page
    .getByRole('button', { name: 'Mark as unread', exact: true })
    .locator('circle')
    .evaluate((circle) => ({ fill: circle.getAttribute('fill'), width: circle.getBoundingClientRect().width }))
  equal([dot.fill, Math.round(dot.width)], ['currentColor', 4], 'Mark as unread has a filled 4 px dot')

  // Label chips say which label they are.
  const chips = await page
    .locator('[role="listbox"] [data-label]')
    .evaluateAll((found) => found.map((chip) => [chip.getAttribute('data-label'), chip.textContent]))
  equal(chips.length > 0, true, `rows show label chips (${chips.length})`)
  equal(
    chips.filter(([label, text]) => label !== text || text === ''),
    [],
    'every label chip on a row names its label in text',
  )

  // Folded messages open with a 14 px chevron in the readable secondary color.
  const chevron = await page
    .locator('[data-message="folded"] [data-field="disclosure"]')
    .first()
    .evaluate((icon) => ({ size: icon.getBoundingClientRect().width, color: getComputedStyle(icon).color }))
  equal(chevron, { size: 14, color: MUTED }, 'a folded message has a 14 px chevron in the secondary color')

  equal(
    [await page.locator(DEAD).count(), await page.getByRole('button', { name: /switch account|attach/i }).count()],
    [0, 0],
    'no account switcher or attachment control',
  )
}

/**
 * Every person keeps one tint, picked from their name, and the user looks the same everywhere.
 * Opens Lease addendum for 4B, then Notes from Thursday again, so run it once the screens are captured.
 */
export async function checkAvatars(page: Page) {
  const tintOf = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((avatar) => ({
        text: avatar.textContent,
        fill: getComputedStyle(avatar).backgroundColor,
      }))
  const user = await tintOf('[data-field="account"] [data-avatar]')
  const youInReader = await tintOf('[data-message] [data-avatar="R"]')
  const maya = await tintOf('[data-message="open"] [data-avatar]')
  await page.locator('[role="option"]', { hasText: 'Lease addendum for 4B' }).click()
  await page.locator('[data-field="reader-subject"]', { hasText: 'Lease addendum for 4B' }).waitFor()
  const tomas = await tintOf('[data-message="open"] [data-avatar]')
  await page.locator('[role="option"]', { hasText: 'Notes from Thursday' }).click()
  equal(
    [user.text, youInReader, maya.text, tomas.text],
    ['R', user, 'ML', 'TO'],
    'the user is R with one tint in the sidebar and the reader, and others show their initials',
  )
  equal(new Set([user.fill, maya.fill, tomas.fill]).size, 3, 'Maya, Tomas and the user each have their own tint')
}
