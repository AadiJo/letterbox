// `updates`: `people-first`, plus two weeks of automated mail from eight of its senders, each
// day's count taken from the Updates design, so Updates shows a busy sender beside a quiet
// one. Mail from the last three days is unread, as the design's brighter bars are. Codeyard's
// newest messages carry the design's subjects, and the newest its body.
// Every name, address and company here is made up.

import type { SeedAddress, SeedMessage } from '../contract.ts'
import type { DevSeed } from '../seeds.ts'
import { ME } from './people-mail.ts'
import { peopleFirst } from './people-first.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How each kind of sender marks itself as automated, as people-first.ts does. */
const NOTIFICATION = { headers: { autoSubmitted: 'auto-generated' }, bulk: false } as const
const NEWSLETTER = { headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' }, bulk: true } as const

type Volume = {
  from: SeedAddress
  subject: string
  marks: Required<Pick<SeedMessage, 'headers' | 'bulk'>>
  /** Messages a day, oldest first, the last of them today. */
  days: readonly number[]
}

const VOLUME: readonly Volume[] = [
  {
    from: { name: 'Codeyard', address: 'notifications@codeyard.example' },
    subject: 'New comment on your pull request',
    marks: NOTIFICATION,
    days: [7, 9, 11, 4, 2, 10, 12, 8, 9, 13, 3, 1, 11, 7],
  },
  {
    from: { name: 'Calendo', address: 'calendar-noreply@calendo.example' },
    subject: 'Invitation: design review',
    marks: NOTIFICATION,
    days: [1, 0, 2, 1, 0, 0, 1, 2, 1, 0, 0, 0, 2, 2],
  },
  {
    from: { name: 'Northbank', address: 'alerts@northbank.example' },
    subject: 'Your statement is ready',
    marks: NOTIFICATION,
    days: [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2],
  },
  {
    from: { name: 'Parcelpoint', address: 'tracking@parcelpoint.example' },
    subject: 'Out for delivery: order 4471',
    marks: NOTIFICATION,
    days: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 2, 1, 1],
  },
  {
    from: { name: 'Tasklane', address: 'notifications@tasklane.example' },
    subject: 'Weekly summary: 14 tasks closed',
    marks: NOTIFICATION,
    days: [3, 4, 2, 0, 0, 5, 3, 4, 2, 3, 0, 0, 4, 3],
  },
  {
    from: { name: 'The Long Read', address: 'newsletter@longread.example' },
    subject: 'Issue 212: the quiet web',
    marks: NEWSLETTER,
    days: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0],
  },
  {
    from: { name: 'Chatter', address: 'no-reply@chatter.example' },
    subject: 'Unread messages in #general',
    marks: NOTIFICATION,
    days: [0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0],
  },
  {
    from: { name: 'Railway Tickets', address: 'no-reply@railtickets.example' },
    subject: 'Your trip to Lisbon: check in now',
    marks: NOTIFICATION,
    days: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
  },
]

/** Codeyard's newest subjects, newest first, from the design. */
const CODEYARD = [
  'Review requested on #212: fold quoted replies',
  '[harbor/api] CI passed on main',
  'Comment on #208: retry webhooks after a timeout',
  '[harbor/api] CI failed on fold-quotes',
  'Lena Ortiz approved #205',
  'Your weekly digest: 23 updates in 4 repositories',
  'Security alert: 2 dependencies need updates',
  '[harbor/api] Release v0.9.0 published',
  'Comment on #201: drop the legacy export path',
  '[harbor/web] CI passed on main',
  'Sam Whitlow mentioned you in #199',
]

const NEWEST_TEXT =
  'Lena Ortiz requested your review on harbor/api #212.\n\nFold quoted replies behind a single line, so long threads open at the newest message. 4 files changed, 212 additions, 31 deletions.'

const NOW = Date.parse(peopleFirst.now)
/** The start of the seed's day, in UTC, as the core counts days. */
const TODAY = NOW - (NOW % DAY)

/**
 * One sender's messages, oldest first: each day's spread from 07:00 to 18:00. Today's end
 * 10 minutes before now for the first sender, 20 for the second and so on, so Codeyard's
 * newest is the newest mail in the inbox, as in the design.
 */
function messagesOf(volume: Volume, number: number): SeedMessage[] {
  const times = volume.days.flatMap((count, index) => {
    const back = volume.days.length - 1 - index
    const start = TODAY - back * DAY + 7 * HOUR
    const span = back === 0 ? NOW - (number + 1) * 10 * MINUTE - start : 11 * HOUR
    return Array.from({ length: count }, (_, k) => start + Math.floor(((k + 1) * span) / count))
  })
  const unreadFrom = TODAY - 2 * DAY
  return times.map((at, index): SeedMessage => {
    const fromNewest = times.length - 1 - index
    const designed = number === 0 ? CODEYARD[fromNewest] : undefined
    return {
      key: `volume-${number}-${index}`,
      mailboxes: ['inbox'],
      from: volume.from,
      to: [ME],
      subject: designed ?? `${volume.subject} #${2000 + index}`,
      text: designed && fromNewest === 0 ? NEWEST_TEXT : `${designed ?? volume.subject}.`,
      sentAt: new Date(at).toISOString(),
      unread: at >= unreadFrom,
      headers: volume.marks.headers,
      bulk: volume.marks.bulk,
    }
  })
}

export const updates: DevSeed = {
  ...peopleFirst,
  seed: {
    ...peopleFirst.seed,
    messages: [...peopleFirst.seed.messages, ...VOLUME.flatMap(messagesOf)].toSorted((a, b) =>
      a.sentAt.localeCompare(b.sentAt),
    ),
  },
}
