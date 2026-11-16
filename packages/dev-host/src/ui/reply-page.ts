// What the reply UI check (reply.ts, reply-recovery.ts) shares: the mail it delivers, the
// replies it writes, and the ways it finds and reads the page.

import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { ClientMessage } from '@letterbox/protocol'
import type { Page } from 'playwright'
import type { Relay } from './record.ts'

export const seed = devSeeds['people-first']
export const ME = seed.seed.address
/** A reply to GROUP that the check sends and takes back. */
export const BREAD = 'I can bring bread and cheese.'
/** A reply with a Bcc, for the reload that cannot read session storage. */
export const INVOICE = 'The invoice is paid, the receipt is copied to the ledger.'
/** A reply held in one conversation while that conversation is merged into an older one. */
export const TRIP = "I'm in for the bike trip."
/** A draft in the older conversation while the reply above is held. */
export const ROUTE = 'Which route are we taking?'

/** A message to the user and one more person, copying a third, for Reply all. */
export const GROUP = {
  key: 'group-1',
  mailboxes: ['inbox'],
  from: { name: 'Maya Lindqvist', address: 'maya@lindqvist.example' },
  to: [
    { name: 'Robin Vale', address: ME },
    { name: 'Tomas Okafor', address: 'tomas.okafor@fernway.example' },
  ],
  cc: [{ name: 'Priya Raman', address: 'priya@ramanstudio.example' }],
  subject: 'Picnic on Sunday',
  text: 'Hi all, can each of you bring something on Sunday?',
  sentAt: new Date(Date.parse(seed.now) - 10 * 60_000).toISOString(),
}

/** Tomas answers GROUP, everyone still on it, while a reply to Maya waits in its window. */
export const TOMAS = {
  key: 'group-2',
  mailboxes: ['inbox'],
  from: { name: 'Tomas Okafor', address: 'tomas.okafor@fernway.example' },
  to: [
    { name: 'Maya Lindqvist', address: 'maya@lindqvist.example' },
    { name: 'Robin Vale', address: ME },
  ],
  cc: GROUP.cc,
  subject: 'Re: Picnic on Sunday',
  text: 'I will bring a blanket and lemonade.',
  sentAt: new Date(Date.parse(seed.now) - 5 * 60_000).toISOString(),
  replyTo: ['group-1'],
}

export const OWEN = { name: 'Owen Hale', address: 'owen.hale@example.net' }
export const KIT = { name: 'Kit Ashworth', address: 'kit@ashworth.example' }
export const ROBIN = { name: 'Robin Vale', address: ME }
export const minutesAgo = (minutes: number) => new Date(Date.parse(seed.now) - minutes * 60_000).toISOString()

/** Two conversations with one subject that nothing links yet: Owen's (older) and Kit's. */
export const TRIPS = [
  {
    key: 'trip-1',
    mailboxes: ['inbox'],
    from: OWEN,
    to: [ROBIN],
    subject: 'Bike trip in May',
    text: 'Shall we ride to the coast in May?',
    sentAt: minutesAgo(3 * 24 * 60),
  },
  {
    key: 'trip-2',
    mailboxes: ['inbox'],
    from: KIT,
    to: [ROBIN],
    subject: 'Bike trip in May',
    text: 'Are you coming on the May bike trip?',
    sentAt: minutesAgo(120),
  },
]
/** Owen answers both, which links them. The core merges Kit's conversation into Owen's, the older. */
export const TRIP_LINK = {
  key: 'trip-3',
  mailboxes: ['inbox'],
  from: OWEN,
  to: [ROBIN, KIT],
  subject: 'Re: Bike trip in May',
  text: 'Kit is coming too, so it is the three of us.',
  sentAt: minutesAgo(30),
  replyTo: ['trip-1', 'trip-2'],
}

/** The draft of the last send command the page sent its core. */
export const lastSend = (relay: Relay) =>
  relay
    .fromPage()
    .flatMap((text) => {
      const message: ClientMessage = JSON.parse(text)
      return message.kind === 'command' && message.command.kind === 'send' ? [message.command.draft] : []
    })
    .at(-1)

export const dock = (page: Page) => page.locator('section[aria-label="Reply"]')
export const bar = (page: Page) => page.locator('[data-field="reply-bar"]')
export const body = (page: Page) => dock(page).getByRole('textbox', { name: 'Message' })
export const toast = (page: Page) => page.getByRole('status').filter({ has: page.locator('[data-field="toast"]') })
export const reason = (page: Page) => page.locator('[data-field="reason"]').textContent()
/** The count of send commands the page has sent its cores. */
export const sends = (relay: Relay) => relay.fromPage().filter((text) => text.includes('"kind":"send"')).length
/**
 * Opens the conversation `subject` with `person`, for subjects two conversations share. Then
 * waits for the core to answer everything the page sent, since a core holding its waits may
 * leave the conversation's answer until it next hears from the page.
 */
export async function openWith(page: Page, subject: string, person: string, text: string) {
  await rowWith(page, subject, person).first().click()
  await page.evaluate(() => window.letterboxDev?.settle())
  await page.locator('[data-message]', { hasText: text }).first().waitFor()
}

/** The row for `subject` with `person`, for subjects two conversations share. */
export const rowWith = (page: Page, subject: string, person: string) =>
  row(page, subject).filter({ has: page.locator('[data-field="person"]', { hasText: person }) })
export const sendButton = (page: Page) => dock(page).getByRole('button', { name: /^Send/ })
export const row = (page: Page, subject: string) =>
  page.locator('[role="option"]').filter({ has: page.locator('[data-field="subject"]', { hasText: subject }) })
/** Whether the toast offers Undo right now. */
export const undoOffered = async (page: Page) =>
  (await toast(page).getByRole('button', { name: /^Undo/ }).count()) === 1
export const yourTurn = (page: Page) => page.locator('[role="listbox"][aria-label="Your turn"] [role="option"]')
export const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: new RegExp(`^${name}`) })

/** The people on one address line of the open editor, as each chip's tooltip names them. */
export const chips = (page: Page, line: 'to' | 'cc') =>
  dock(page)
    .locator(`[data-address-line="${line}"] [data-chip]`)
    .evaluateAll((found) => found.map((chip) => chip.getAttribute('title')))

/** Opens the conversation `subject` from the list on screen and waits for its newest message. */
export async function open(page: Page, subject: string) {
  await row(page, subject).first().click()
  await page.locator('h3[data-field="reader-subject"]', { hasText: subject }).waitFor()
  await page.locator('[data-message="open"]').last().waitFor()
}
