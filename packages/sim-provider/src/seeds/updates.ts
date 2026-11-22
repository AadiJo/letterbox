// `updates`: `people-first`, made to read like a real inbox for Updates and Let go?:
//   - its machines get names that look apart (one "C" tile, not five) and subjects of their own
//   - two weeks of mail from eight of them, each day's count from the Updates design, so a busy
//     sender sits beside a quiet one. Today's is unread, and about half of each one's older mail
//   - the bank's newest alert is its statement, with the statement attached as a PDF
//   - five more turns of mine that waited over 30 days, four of them two to four letters long
// Every name, address and company here is made up.

import type { SeedAddress, SeedMessage } from '../contract.ts'
import type { DevSeed, PersonConversation } from '../seeds.ts'
import { ME } from './people-mail.ts'
import { peopleFirst } from './people-first.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const NOW = Date.parse(peopleFirst.now)
/** The start of the seed's day, in UTC. */
const TODAY = NOW - (NOW % DAY)
const at = (ms: number) => new Date(ms).toISOString()

/** Each machine in people-first, by address: the name and address it has here, and what it writes about. */
const MACHINES: Record<string, { name: string; address: string; subjects: readonly string[] }> = {
  'notifications@codeyard.example': {
    name: 'Codeyard',
    address: 'notifications@codeyard.example',
    subjects: [
      'New comment on your pull request',
      'Build passed on main',
      'Your review was requested',
      'A dependency needs an update',
    ],
  },
  'notifications@tasklane.example': {
    name: 'Tasklane',
    address: 'notifications@tasklane.example',
    subjects: ['You were mentioned in a task', 'Weekly summary: 14 tasks closed', 'A task is due tomorrow'],
  },
  'no-reply@chatter.example': {
    name: 'Huddle',
    address: 'no-reply@huddle.example',
    subjects: ['Unread messages in #general', 'Priya replied in a thread', 'New messages in #design'],
  },
  'calendar-noreply@calendo.example': {
    name: 'Agenda Calendar',
    address: 'invites@agenda.example',
    subjects: ['Reminder: standup at 9:30', 'Invitation: design review', 'Updated: planning moved to 3 PM'],
  },
  'alerts@northbank.example': {
    name: 'Northwind Bank',
    address: 'alerts@northwind-bank.example',
    subjects: ['A payment left your account', 'Your statement is ready', 'Your card was used online'],
  },
  'no-reply@cloudnest.example': {
    name: 'Driftbox',
    address: 'no-reply@driftbox.example',
    subjects: ['Your storage is 80% full', 'A file was shared with you', 'Your backup finished'],
  },
  'tracking@parcelpoint.example': {
    name: 'Parcelpost',
    address: 'tracking@parcelpost.example',
    subjects: ['Out for delivery: order 4471', 'Delivered: order 4398', 'Your order has shipped'],
  },
  'noreply@homewire.example': {
    name: 'Homewire',
    address: 'noreply@homewire.example',
    subjects: ['New sign-in to your account', 'Your router updated overnight', 'Your monthly usage report'],
  },
  'notifications@fitloop.example': {
    name: 'Fitloop',
    address: 'notifications@fitloop.example',
    subjects: ['Your weekly activity summary', 'You closed your rings 5 days in a row'],
  },
  'orders@greengrocerbox.example': {
    name: 'Greengrocer Box',
    address: 'orders@greengrocerbox.example',
    subjects: ['Your order confirmation', 'Your box arrives Thursday'],
  },
  'no-reply@railtickets.example': {
    name: 'Fernway Rail',
    address: 'tickets@fernwayrail.example',
    subjects: ['Your e-ticket for Lisbon', 'Your trip to Lisbon: check in now'],
  },
  'receipts@ridely.example': {
    name: 'Ridely',
    address: 'receipts@ridely.example',
    subjects: ['Your trip receipt', 'Thanks for riding with Ridely'],
  },
  'billing@streamhouse.example': {
    name: 'Streamhouse',
    address: 'billing@streamhouse.example',
    subjects: ['Your monthly invoice', 'Your plan renews next week'],
  },
  'shop@cornerbooks.example': {
    name: 'Paper Lantern Books',
    address: 'shop@paperlantern.example',
    subjects: ['Thanks for your order', 'Your book has shipped'],
  },
  'billing@powergrid.example': {
    name: 'Powergrid Energy',
    address: 'billing@powergrid.example',
    subjects: ['Your bill is ready', 'Your meter reading is due'],
  },
  'no-reply@mobileo.example': {
    name: 'Mobileo',
    address: 'no-reply@mobileo.example',
    subjects: ['Payment received', 'You have used 80% of your data'],
  },
  'billing@hostbarn.example': {
    name: 'Hostbarn',
    address: 'billing@hostbarn.example',
    subjects: ['Domain renewal receipt', 'Your domain renews in 30 days'],
  },
  'newsletter@longread.example': {
    name: 'The Long Read',
    address: 'newsletter@longread.example',
    subjects: ['This week: five essays', 'Issue 212: the quiet web', 'The slow mornings issue'],
  },
  'editor@frontendweekly.example': {
    name: 'Frontend Weekly',
    address: 'editor@frontendweekly.example',
    subjects: ['Container queries, at last', 'A smaller bundle in ten steps'],
  },
  'news@trailmix.example': {
    name: 'Trailmix Outdoor',
    address: 'news@trailmix.example',
    subjects: ['Spring sale starts now', 'New tents for the season'],
  },
  'hello@citycinema.example': {
    name: 'Odeon Lane',
    address: 'hello@odeonlane.example',
    subjects: ['Showing this weekend', 'Presale opens Friday at 10 AM'],
  },
  'news@beanandleaf.example': {
    name: 'Leaf Roasters',
    address: 'news@leafroasters.example',
    subjects: ['New single origins', 'Brewing guide: the pour-over'],
  },
  'events@library.example': {
    name: 'Local Library',
    address: 'events@library.example',
    subjects: ['Events this month', 'Your reserved book is ready'],
  },
  'digest@rustdigest.example': {
    name: 'Rust Digest',
    address: 'digest@rustdigest.example',
    subjects: ['This week in async', 'Five crates worth a look'],
  },
  'deals@travelnest.example': {
    name: 'Travelnest',
    address: 'deals@travelnest.example',
    subjects: ['Weekend getaways from 49', 'Last minute: the coast in April'],
  },
  'notes@marketnotes.example': {
    name: 'Market Notes',
    address: 'notes@marketnotes.example',
    subjects: ['Morning briefing', 'The week ahead'],
  },
}

const addressOf = (who: SeedAddress) => (typeof who === 'string' ? who : who.address)

/** A people-first message as this seed has it: a machine's under its name here, with a subject of its own. */
function renamed(message: SeedMessage, index: number): SeedMessage {
  const machine = MACHINES[addressOf(message.from)]
  if (!machine || !message.key.startsWith('auto-')) return message
  const subject = machine.subjects[index % machine.subjects.length] ?? message.subject
  return Object.assign({}, message, {
    from: { name: machine.name, address: machine.address },
    subject,
    text: `${subject}. Open ${machine.name} to see the details, or change how often we email you in your settings.`,
  })
}

/** How each kind of sender marks itself as automated, as people-first.ts does. */
const NOTIFICATION = { headers: { autoSubmitted: 'auto-generated' }, bulk: false } as const
const NEWSLETTER = { headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' }, bulk: true } as const

type Volume = {
  /** The machine, by its people-first address. */
  from: string
  marks: Required<Pick<SeedMessage, 'headers' | 'bulk'>>
  /** Messages a day, oldest first, the last of them today. */
  days: readonly number[]
}

/** The design's days, but Codeyard's last two are quieter, so its Earlier mail shows below Today and Yesterday. */
const VOLUME: readonly Volume[] = [
  { from: 'notifications@codeyard.example', marks: NOTIFICATION, days: [7, 9, 11, 4, 2, 10, 12, 8, 9, 13, 3, 1, 2, 3] },
  { from: 'calendar-noreply@calendo.example', marks: NOTIFICATION, days: [1, 0, 2, 1, 0, 0, 1, 2, 1, 0, 0, 0, 2, 2] },
  { from: 'alerts@northbank.example', marks: NOTIFICATION, days: [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2] },
  { from: 'tracking@parcelpoint.example', marks: NOTIFICATION, days: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 2, 1, 1] },
  { from: 'notifications@tasklane.example', marks: NOTIFICATION, days: [3, 4, 2, 0, 0, 5, 3, 4, 2, 3, 0, 0, 4, 3] },
  { from: 'newsletter@longread.example', marks: NEWSLETTER, days: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0] },
  { from: 'no-reply@chatter.example', marks: NOTIFICATION, days: [0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0] },
  { from: 'no-reply@railtickets.example', marks: NOTIFICATION, days: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0] },
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

/** The bank's newest alert: its statement, with the statement as a PDF, so Updates shows a file. */
const STATEMENT = {
  from: 'alerts@northbank.example',
  subject: 'Your February statement is ready',
  text: 'Your statement for February is attached. It is also in your account under Documents.',
  file: { name: 'Northwind-statement-2026-02.pdf', mime: 'application/pdf', size: 188_416 },
} as const

const NEWEST_TEXT =
  'Lena Ortiz requested your review on harbor/api #212.\n\nFold quoted replies behind a single line, so long threads open at the newest message. 4 files changed, 212 additions, 31 deletions.'

/**
 * One machine's two weeks, oldest first: each day's spread from 07:00 to 18:00 UTC. Today's
 * end 10 minutes before now for the first machine, 20 for the second and so on, so Codeyard's
 * newest is the newest mail in the inbox, as in the design.
 */
function messagesOf(volume: Volume, number: number): SeedMessage[] {
  const machine = MACHINES[volume.from]
  if (!machine) throw new Error(`updates: no machine at ${volume.from}`)
  const times = volume.days.flatMap((count, index) => {
    const back = volume.days.length - 1 - index
    const start = TODAY - back * DAY + 7 * HOUR
    const span = back === 0 ? NOW - (number + 1) * 10 * MINUTE - start : 11 * HOUR
    return Array.from({ length: count }, (_, k) => start + Math.floor(((k + 1) * span) / count))
  })
  return times.map((sentAt, index): SeedMessage => {
    const fromNewest = times.length - 1 - index
    const statement = volume.from === STATEMENT.from && fromNewest === 0
    const subject = statement
      ? STATEMENT.subject
      : ((number === 0 ? CODEYARD[fromNewest] : undefined) ?? machine.subjects[index % machine.subjects.length] ?? '')
    return {
      key: `volume-${number}-${index}`,
      mailboxes: ['inbox'],
      from: { name: machine.name, address: machine.address },
      to: [ME],
      subject,
      text: statement ? STATEMENT.text : number === 0 && fromNewest === 0 ? NEWEST_TEXT : `${subject}.`,
      attachments: statement ? [STATEMENT.file] : 0,
      sentAt: at(sentAt),
      // Today's mail is unread, and every other message before it.
      unread: sentAt >= TODAY || index % 2 === 0,
      headers: volume.marks.headers,
      bulk: volume.marks.bulk,
    }
  })
}

/**
 * A Codeyard notice at 03:30 UTC today: still yesterday evening west of UTC (10:30 PM in
 * Chicago), so it sits on another day there than in UTC. The UI check reads Updates in Chicago.
 */
const LATE: SeedMessage = {
  key: 'volume-late',
  mailboxes: ['inbox'],
  from: { name: 'Codeyard', address: 'notifications@codeyard.example' },
  to: [ME],
  subject: '[harbor/api] Nightly build failed',
  text: 'The nightly build failed on main at 3c9e1f2. 1 of 3 checks failed: integration.',
  sentAt: at(TODAY + 3.5 * HOUR),
  unread: true,
  headers: NOTIFICATION.headers,
  bulk: false,
}

type Letter = { me?: true; text: string }

/** A turn of mine that waited: who, about what, when they last wrote, and the letters, oldest first, a day apart. */
type Waited = { with: { name: string; address: string }; subject: string; age: number; letters: readonly Letter[] }

const letter = (...paragraphs: string[]) => paragraphs.join('\n\n')

const WAITED: readonly Waited[] = [
  {
    with: { name: 'Ben Hale', address: 'ben.hale@fernmail.test' },
    subject: 'Coffee next week?',
    age: 30 * DAY + 12 * HOUR,
    letters: [
      { text: letter('Hi Robin,', 'I’m back in town at the end of the month. Are you around?', 'Ben') },
      {
        me: true,
        text: 'Let me know next time you are in town! The new place on Alder Street does a good breakfast.',
      },
      {
        text: letter(
          'Hi Robin,',
          'Back in town for a few days. Any chance you are free Tuesday or Wednesday morning?',
          'Happy to come to you. The place by the station works too, if that’s easier.',
          'Ben',
        ),
      },
    ],
  },
  {
    with: { name: 'Ken Ito', address: 'ken@itostudio.test' },
    subject: 'Quick question about the export API',
    age: 33 * DAY,
    letters: [
      { text: 'Is the export API still in beta? We’d like to build on it.' },
      {
        text: letter(
          'Hi Robin,',
          'Is there a way to export only one label? The docs only show the whole mailbox, and ours is about 40 GB.',
          'If not, no worries. I can filter it after.',
          'Ken',
        ),
      },
    ],
  },
  {
    with: { name: 'Sara Wong', address: 'sara.wong@ardenmail.test' },
    subject: 'Grant report, section 3',
    age: 35 * DAY,
    letters: [
      {
        text: letter(
          'Hi Robin,',
          'Section 3 still needs your paragraph on outcomes. Can you send a draft by the end of the week?',
          'Two or three sentences is plenty. I’ll fold it into the rest.',
          'Sara',
        ),
      },
    ],
  },
  {
    with: { name: 'Mia Chen', address: 'mia.chen@fernmail.test' },
    subject: 'Volunteer schedule',
    age: 45 * DAY,
    letters: [
      { text: letter('Hi all,', 'The volunteer schedule for March is up. Shout if a shift doesn’t work.', 'Mia') },
      { me: true, text: 'Thanks Mia. Sunday mornings are hard for me this month.' },
      { text: 'No problem, I’ll see what I can move.' },
      {
        text: letter(
          'Hi Robin,',
          'Could you take the Saturday morning shift instead of Sunday? Teo can swap with you.',
          'It’s 9 to 12 at the community hall. Coffee is on us.',
          'Mia',
        ),
      },
    ],
  },
  {
    with: { name: 'Rosa Diaz', address: 'rosa@diazkitchen.test' },
    subject: 'The lemon cake recipe',
    age: 50 * DAY,
    letters: [
      { me: true, text: 'The lemon cake on Sunday was wonderful. Was that your grandmother’s recipe?' },
      { text: 'It was! I’ll dig it out.' },
      {
        text: letter(
          'Hi Robin,',
          'Found it. Could you send me the one you made for the picnic, too? Mine came out flat last time.',
          'I think I over-mixed it, but I’d like to see what you do differently.',
          'Rosa',
        ),
      },
    ],
  },
]

/** One waited turn's letters, oldest first, each answering all before it, the last from them `age` ago. */
function lettersOf(waited: Waited, number: number): SeedMessage[] {
  const keys = waited.letters.map((_, index) => `waited-${number}-${index}`)
  return waited.letters.map((one, index): SeedMessage => {
    const sentAt = NOW - waited.age - (waited.letters.length - 1 - index) * DAY
    return {
      key: keys[index] ?? `waited-${number}-${index}`,
      mailboxes: [one.me ? 'sent' : 'inbox'],
      from: one.me ? ME : waited.with,
      to: [one.me ? waited.with : ME],
      subject: index === 0 ? waited.subject : `Re: ${waited.subject}`,
      text: one.text,
      sentAt: at(sentAt),
      unread: false,
      replyTo: keys.slice(0, index),
    }
  })
}

export const updates: DevSeed = {
  ...peopleFirst,
  seed: {
    ...peopleFirst.seed,
    messages: [
      ...peopleFirst.seed.messages.map(renamed),
      ...VOLUME.flatMap(messagesOf),
      LATE,
      ...WAITED.flatMap(lettersOf),
    ].toSorted((a, b) => a.sentAt.localeCompare(b.sentAt)),
  },
  conversations: [
    ...peopleFirst.conversations,
    ...WAITED.map((waited): PersonConversation => ({
      subject: waited.subject,
      turn: 'mine',
      lastAt: at(NOW - waited.age),
    })),
  ],
}
