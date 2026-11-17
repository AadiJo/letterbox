// Updates' volume: each sender's messages per day over the last 14 days, and how many of them
// are unread, which the renderer draws as a strip and reads as "about 9 a day". The core sums
// them per sender between commits, counts them by the days of the zone the query names, and
// its clock moves the days on at the zone's midnight with no command. Updates' page also
// counts the senders with unread mail, which the sidebar shows.

import type { SenderDay, SenderPage, SenderSummary } from '@letterbox/protocol'
import type { Dialect, Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import { mailbox, ME, PASSWORD, signIn, standardSeed, sync, threads } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const HUB = { name: 'Codehub', address: 'notifications@codehub.example' }

/** A notification from Codehub in the inbox. */
const notice = (key: string, subject: string, sentAt: string, more: Partial<SeedMessage> = {}): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: HUB,
  to: [ME],
  subject,
  text: `${subject}.`,
  sentAt,
  headers: { autoSubmitted: 'auto-generated' },
  ...more,
})

/**
 * The standard mailbox, whose shop newsletter is unread, plus Codehub's notifications. The
 * core starts at 23:30 on Jan 1, so its 14 days are Dec 19 to Jan 1:
 *   ci, hub-review  Jan 1, one unread and one read
 *   failed       Dec 31, unread
 *   release      Dec 25, read, and a follow-up in it on Dec 26, read
 *   digest       Dec 18, read: a day too old for the strip
 */
function volumeSeed(dialect: Dialect): Seed {
  const seed = standardSeed(dialect)
  return {
    ...seed,
    messages: [
      ...seed.messages,
      notice('ci', 'CI passed on main', '2026-01-01T09:00:00.000Z'),
      notice('hub-review', 'Review requested on #212', '2026-01-01T10:00:00.000Z', { unread: false }),
      notice('failed', 'CI failed on fold-quotes', '2025-12-31T12:00:00.000Z'),
      notice('release', 'Release v0.9.0 published', '2025-12-25T12:00:00.000Z', { unread: false }),
      notice('release-notes', 'Release v0.9.0 published', '2025-12-26T12:00:00.000Z', {
        unread: false,
        replyTo: ['release'],
      }),
      notice('digest', 'Your weekly digest', '2025-12-18T12:00:00.000Z', { unread: false }),
    ],
  }
}

/** 14 days, oldest first, with `at` (days before the last) set to `[messages, unread]`. */
const days = (at: Record<number, [number, number]>): SenderDay[] =>
  Array.from({ length: 14 }, (_, index) => {
    const [messages, unread] = at[13 - index] ?? [0, 0]
    return { messages, unread }
  })

const hub = (page: SenderPage | undefined): SenderSummary => {
  const found = page?.senders.find((sender) => sender.address === HUB.address)
  if (!found) throw new Error('Updates has no row for Codehub')
  return found
}

/** What the sidebar and the list's head read off the page: senders with unread mail, and unread messages. */
const unreadOf = (page: SenderPage | undefined) => ({ senders: page?.unreadSenders, messages: page?.unread })

scenario("Updates counts each sender's mail per day for 14 days, and moves the days on at midnight", async (t) => {
  const box = t.mailbox(volumeSeed(t.dialect))
  const core = t.startCore({ now: '2026-01-01T23:30:00.000Z' })
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await sync(core)
  const inbox = await mailbox(core, 'Inbox')
  const query = { view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 } as const

  // Opening Updates books a wake for midnight, half an hour away. A wait under an hour ends
  // at once on core-sim's clock, so the second answer is the one after midnight. The scenario
  // sends nothing in between, so only the wake can move the days.
  const updates = core.subscribe(query)
  const before = await updates.next()
  t.equal(
    hub(before).days,
    days({ 0: [2, 1], 1: [1, 1], 6: [1, 0], 7: [1, 0] }),
    "Jan 1 holds two messages, one unread, then Dec 31's unread failure and the release's two days. Dec 18 is too old",
  )
  t.equal(
    [hub(before).messages, hub(before).unread],
    [6, 2],
    'the strip leaves out the digest, which the message count keeps',
  )
  t.equal(
    unreadOf(before),
    { senders: 2, messages: 3 },
    "the newsletter and Codehub have unread mail: Codehub's two messages and the newsletter's one",
  )
  const opened = updates.rev()

  const after = await updates.next()
  t.equal(
    hub(after).days,
    days({ 1: [2, 1], 2: [1, 1], 7: [1, 0], 8: [1, 0] }),
    'at midnight every day moves back one, and the new day is empty',
  )
  t.equal(updates.rev(), opened, 'no commit came between: the clock alone moved the days')
  t.equal(updates.latest(), await core.query(query), 'after midnight, the open Updates shows what a new one would')

  // Reading and archiving move a sender's days and unread counts in the open list.
  const [ci] = await threads(core, { text: 'CI passed on main' })
  if (!ci) throw new Error('no CI thread')
  const read = await core.command({ kind: 'set-flags', threadIds: [ci.id], unread: false })
  t.equal((await core.settled(read.change)).result, 'done', 'marking the CI notice read settles')
  const readPage = await core.query(query)
  t.equal(updates.latest(), readPage, 'once read, the open Updates shows what a new one would')
  t.equal(hub(readPage).days[12], { messages: 2, unread: 0 }, "Jan 1's message is read")
  t.equal(unreadOf(readPage), { senders: 2, messages: 2 }, 'Updates holds one unread message fewer')

  const [failed] = await threads(core, { text: 'CI failed on fold-quotes' })
  if (!failed) throw new Error('no failed CI thread')
  const archive = await core.command({ kind: 'set-mailboxes', threadIds: [failed.id], add: [], remove: [inbox.id] })
  t.equal((await core.settled(archive.change)).result, 'done', 'archiving the failure settles')
  const archived = await core.query(query)
  t.equal(updates.latest(), archived, 'once archived, the open Updates shows what a new one would')
  t.equal(
    hub(archived).days,
    days({ 1: [2, 0], 7: [1, 0], 8: [1, 0] }),
    'the archived failure leaves its day, and Codehub has no unread day left',
  )
  t.equal(unreadOf(archived), { senders: 1, messages: 1 }, 'only the newsletter has unread mail')

  box.deliver(notice('mention', 'Sam mentioned you in #199', '2026-01-02T00:20:00.000Z'))
  await sync(core)
  const arrived = await core.query(query)
  t.equal(updates.latest(), arrived, 'after new mail, the open Updates shows what a new one would')
  t.equal(hub(arrived).days.at(-1), { messages: 1, unread: 1 }, "the new mention fills today's day")
  t.equal(unreadOf(arrived), { senders: 2, messages: 2 }, 'Codehub has unread mail again')
})

/**
 * Codehub's mail around the night Chicago's clocks went forward, Mar 8, 2026. Chicago's Mar 9
 * starts at 05:00 UTC, not 06:00 as on the nights before:
 *   late      Mar 9 03:00 UTC, which is Mar 8, 10 pm in Chicago
 *   morning   Mar 8 15:00 UTC, 10 am in Chicago
 *   friday    Mar 6 20:00 UTC, 2 pm in Chicago
 */
function zoneSeed(dialect: Dialect): Seed {
  const seed = standardSeed(dialect)
  return {
    ...seed,
    messages: [
      ...seed.messages,
      notice('late', 'CI failed on main', '2026-03-09T03:00:00.000Z'),
      notice('morning', 'Review requested on #212', '2026-03-08T15:00:00.000Z'),
      notice('friday', 'Your weekly digest', '2026-03-06T20:00:00.000Z', { unread: false }),
    ],
  }
}

scenario(
  "Updates counts the user's days in their zone, and moves them at its midnight across a clock change",
  async (t) => {
    t.mailbox(zoneSeed(t.dialect))
    // 23:30 on Mar 8 in Chicago, half an hour before its midnight, which the clock change moved to 05:00 UTC.
    const core = t.startCore({ now: '2026-03-09T04:30:00.000Z' })
    await core.hello()
    await signIn(t, core, ME, PASSWORD)
    await sync(core)
    const inbox = await mailbox(core, 'Inbox')
    const chicago = { view: 'senders', mailboxId: inbox.id, zone: 'America/Chicago', offset: 0, limit: 50 } as const

    // The wake for Chicago's midnight is half an hour away, so it ends at once on core-sim's
    // clock: the second answer is the one after midnight. Nothing else is sent in between.
    const updates = core.subscribe(chicago)
    t.equal(
      hub(await updates.next()).days,
      days({ 0: [2, 2], 2: [1, 0] }),
      "in Chicago it is still Mar 8, which holds the 10 pm failure and the morning's review. Friday's digest is two days back",
    )
    const opened = updates.rev()
    t.equal(
      hub(await updates.next()).days,
      days({ 1: [2, 2], 3: [1, 0] }),
      "at Chicago's midnight, an hour sooner than the night before, Mar 8 moves back one and Mar 9 starts empty",
    )
    t.equal(updates.rev(), opened, 'no commit came between: the clock alone moved the days')
    t.equal(updates.latest(), await core.query(chicago), 'the open Updates shows what a new one in Chicago would')

    const utc = await core.query({ view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 })
    t.equal(
      hub(utc).days,
      days({ 0: [1, 1], 1: [1, 1], 3: [1, 0] }),
      "with no zone the days are UTC's: the 10 pm failure is on Mar 9 there, apart from the morning's review",
    )
    t.equal(
      hub(await core.query({ ...chicago, zone: 'Not/A_Zone' })).days,
      hub(utc).days,
      'a zone the core does not know counts UTC days',
    )
  },
)
