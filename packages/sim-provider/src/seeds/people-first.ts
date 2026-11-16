// `people-first`: a mailbox shaped like a real one we measured. About 95% of it is automated
// mail from many senders: notifications, receipts and newsletters. The rest is people:
//   8 conversations where it is my turn, 1 hour to 26 days old
//   12 where I am waiting on them, 2 hours to 29 days old
//   27 turns older than 30 days, some mine and some theirs
// Receipts, travel mail and a few conversations carry labels, and one newsletter is HTML
// that tries to run script and load remote content, which the reader must block.
// Every name, address and company here is made up.

import type { SeedAddress, SeedMessage } from '../contract.ts'
import type { DevSeed, PersonConversation } from '../seeds.ts'

const NOW = '2026-03-09T16:00:00.000Z'
const ME = { name: 'Robin Vale', address: 'robin@vale.test' }

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The time `ms` before NOW. */
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString()

/** People I write with, by first name. */
const PEOPLE = {
  maya: { name: 'Maya Lindqvist', address: 'maya@lindqvist.example' },
  tomas: { name: 'Tomas Okafor', address: 'tomas.okafor@fernway.example' },
  priya: { name: 'Priya Raman', address: 'priya@ramanstudio.example' },
  jonah: { name: 'Jonah Feld', address: 'jonah.feld@example.org' },
  ines: { name: 'Ines Carvalho', address: 'ines@harbourlane.example' },
  wen: { name: 'Wen Zhao', address: 'wen.zhao@example.net' },
  dara: { name: 'Dara Quinn', address: 'dara@quinnandco.example' },
  felix: { name: 'Felix Brandt', address: 'felix@brandt.example' },
  amara: { name: 'Amara Osei', address: 'amara.osei@example.org' },
  leo: { name: 'Leo Marchetti', address: 'leo@marchetti.example' },
  sana: { name: 'Sana Mirza', address: 'sana@mirzalab.example' },
  owen: { name: 'Owen Hale', address: 'owen.hale@example.net' },
  noor: { name: 'Noor Haddad', address: 'noor@haddad.example' },
  kit: { name: 'Kit Ashworth', address: 'kit@ashworth.example' },
} satisfies Record<string, SeedAddress>

/** One conversation with a person: who, about what, whose turn the seed means, how long ago it last moved, and a label. */
type Spec = {
  with: keyof typeof PEOPLE
  subject: string
  turn: 'mine' | 'theirs'
  age: number
  length: 1 | 2 | 3
  label?: 'projects'
}

/** Newest first within each group. */
const SPECS: Spec[] = [
  // My turn, 1 hour to 26 days.
  { with: 'maya', subject: 'Notes from Thursday', turn: 'mine', age: 1 * HOUR, length: 3, label: 'projects' },
  { with: 'tomas', subject: 'Can you sign the lease addendum?', turn: 'mine', age: 5 * HOUR, length: 1 },
  { with: 'priya', subject: 'Draft cover for the zine', turn: 'mine', age: 26 * HOUR, length: 3, label: 'projects' },
  { with: 'jonah', subject: 'Climbing on Saturday?', turn: 'mine', age: 3 * DAY, length: 1 },
  { with: 'ines', subject: 'Invoice question', turn: 'mine', age: 6 * DAY, length: 3 },
  { with: 'wen', subject: 'Reference letter', turn: 'mine', age: 11 * DAY, length: 1 },
  { with: 'dara', subject: 'Quote for the kitchen shelves', turn: 'mine', age: 16 * DAY, length: 3 },
  { with: 'felix', subject: 'Old photos from the reunion', turn: 'mine', age: 26 * DAY, length: 1 },
  // Waiting on them, 2 hours to 29 days.
  { with: 'amara', subject: 'Dinner next week', turn: 'theirs', age: 2 * HOUR, length: 2 },
  { with: 'leo', subject: 'Bike for sale', turn: 'theirs', age: 7 * HOUR, length: 2 },
  { with: 'sana', subject: 'Sample results', turn: 'theirs', age: 20 * HOUR, length: 1 },
  { with: 'owen', subject: 'Spare keys', turn: 'theirs', age: 2 * DAY, length: 2 },
  { with: 'noor', subject: 'Translation help', turn: 'theirs', age: 4 * DAY, length: 1 },
  { with: 'kit', subject: 'Garden plot rota', turn: 'theirs', age: 5 * DAY, length: 2 },
  { with: 'maya', subject: 'Book club pick', turn: 'theirs', age: 8 * DAY, length: 1 },
  { with: 'tomas', subject: 'Deposit return', turn: 'theirs', age: 10 * DAY, length: 2 },
  { with: 'priya', subject: 'Print shop contact', turn: 'theirs', age: 13 * DAY, length: 1 },
  { with: 'jonah', subject: 'Borrowed tent', turn: 'theirs', age: 18 * DAY, length: 2 },
  { with: 'ines', subject: 'Contract renewal', turn: 'theirs', age: 22 * DAY, length: 1 },
  { with: 'wen', subject: 'Conference talk slot', turn: 'theirs', age: 29 * DAY, length: 2, label: 'projects' },
  // Turns older than 30 days, alternating mine and theirs, 13 days apart.
  ...(
    [
      ['Housewarming', 'maya'],
      ['Recipe you asked about', 'tomas'],
      ['Moving boxes', 'priya'],
      ['Piano tuner', 'jonah'],
      ['Tax documents', 'ines'],
      ['Wedding playlist', 'wen'],
      ['Lost scarf', 'dara'],
      ['Choir schedule', 'felix'],
      ['Camera lens', 'amara'],
      ['Allotment shed', 'leo'],
      ['Recommendation for a dentist', 'sana'],
      ['Car share', 'owen'],
      ['Birthday plans', 'noor'],
      ['Old laptop', 'kit'],
      ['Language exchange', 'maya'],
      ['Volunteer shifts', 'tomas'],
      ['Paint colours', 'priya'],
      ['Train tickets', 'jonah'],
      ['Running club', 'ines'],
      ['Holiday cottage', 'wen'],
      ['Ceramics class', 'dara'],
      ['Window repair', 'felix'],
      ['Podcast idea', 'amara'],
      ['School fundraiser', 'leo'],
      ['Chess rematch', 'sana'],
      ['Board game night', 'owen'],
      ['Plant cuttings', 'noor'],
    ] as const
  ).map(([subject, person], index): Spec => ({
    with: person,
    subject,
    turn: index % 2 === 0 ? 'mine' : 'theirs',
    age: (31 + index * 13) * DAY,
    length: index % 3 === 0 ? 2 : 1,
  })),
]

/** The messages of one conversation, oldest first. The last is from them on my turn, from me on theirs. */
const conversation = (spec: Spec, number: number): SeedMessage[] => {
  const them = PEOPLE[spec.with]
  const keys = Array.from({ length: spec.length }, (_, index) => `person-${number}-${index}`)
  return keys.map((key, index) => {
    const fromEnd = spec.length - 1 - index
    const mine = (fromEnd % 2 === 0) === (spec.turn === 'theirs')
    const from: SeedAddress = mine ? ME : them
    const to: SeedAddress = mine ? them : ME
    return {
      key,
      mailboxes: [mine ? 'sent' : 'inbox', ...(spec.label ? [spec.label] : [])],
      from,
      to: [to],
      subject: index === 0 ? spec.subject : `Re: ${spec.subject}`,
      text: mine ? 'Thanks, I will get back to you on this.' : `Hi Robin, about "${spec.subject}". What do you think?`,
      sentAt: ago(spec.age + fromEnd * 3 * HOUR),
      unread: !mine && fromEnd === 0 && spec.turn === 'mine',
      replyTo: keys.slice(0, index),
    }
  })
}

type Kind = 'notification' | 'receipt' | 'newsletter'

/** Machines that write to me. Each kind marks itself as automated the way real ones do. Travel mail is labelled. */
const SENDERS: { name: string; address: string; kind: Kind; subject: string; travel?: true }[] = [
  {
    name: 'Codeyard',
    address: 'notifications@codeyard.example',
    kind: 'notification',
    subject: 'New comment on your pull request',
  },
  {
    name: 'Codeyard',
    address: 'notifications@codeyard.example',
    kind: 'notification',
    subject: 'Build passed on main',
  },
  {
    name: 'Tasklane',
    address: 'notifications@tasklane.example',
    kind: 'notification',
    subject: 'You were mentioned in a task',
  },
  {
    name: 'Chatter',
    address: 'no-reply@chatter.example',
    kind: 'notification',
    subject: 'Unread messages in #general',
  },
  {
    name: 'Calendo',
    address: 'calendar-noreply@calendo.example',
    kind: 'notification',
    subject: 'Reminder: standup at 9:30',
  },
  {
    name: 'Northbank',
    address: 'alerts@northbank.example',
    kind: 'notification',
    subject: 'A payment left your account',
  },
  {
    name: 'Cloudnest',
    address: 'no-reply@cloudnest.example',
    kind: 'notification',
    subject: 'Your storage is 80% full',
  },
  {
    name: 'Parcelpoint',
    address: 'tracking@parcelpoint.example',
    kind: 'notification',
    subject: 'Your parcel is out for delivery',
  },
  {
    name: 'Homewire',
    address: 'noreply@homewire.example',
    kind: 'notification',
    subject: 'New sign-in to your account',
  },
  {
    name: 'Fitloop',
    address: 'notifications@fitloop.example',
    kind: 'notification',
    subject: 'Your weekly activity summary',
  },
  {
    name: 'Greengrocer Box',
    address: 'orders@greengrocerbox.example',
    kind: 'receipt',
    subject: 'Your order confirmation',
  },
  {
    name: 'Railway Tickets',
    address: 'no-reply@railtickets.example',
    kind: 'receipt',
    subject: 'Your e-ticket',
    travel: true,
  },
  { name: 'Ridely', address: 'receipts@ridely.example', kind: 'receipt', subject: 'Your trip receipt' },
  { name: 'Streamhouse', address: 'billing@streamhouse.example', kind: 'receipt', subject: 'Your monthly invoice' },
  { name: 'Corner Books', address: 'shop@cornerbooks.example', kind: 'receipt', subject: 'Thanks for your order' },
  { name: 'Powergrid Energy', address: 'billing@powergrid.example', kind: 'receipt', subject: 'Your bill is ready' },
  { name: 'Mobileo', address: 'no-reply@mobileo.example', kind: 'receipt', subject: 'Payment received' },
  { name: 'Hostbarn', address: 'billing@hostbarn.example', kind: 'receipt', subject: 'Domain renewal receipt' },
  {
    name: 'The Long Read',
    address: 'newsletter@longread.example',
    kind: 'newsletter',
    subject: 'This week: five essays',
  },
  { name: 'Frontend Weekly', address: 'editor@frontendweekly.example', kind: 'newsletter', subject: 'Issue' },
  { name: 'Trailmix Outdoor', address: 'news@trailmix.example', kind: 'newsletter', subject: 'Spring sale starts now' },
  { name: 'City Cinema', address: 'hello@citycinema.example', kind: 'newsletter', subject: 'Showing this weekend' },
  { name: 'Bean & Leaf', address: 'news@beanandleaf.example', kind: 'newsletter', subject: 'New single origins' },
  { name: 'Local Library', address: 'events@library.example', kind: 'newsletter', subject: 'Events this month' },
  { name: 'Rust Digest', address: 'digest@rustdigest.example', kind: 'newsletter', subject: 'Digest' },
  {
    name: 'Travelnest',
    address: 'deals@travelnest.example',
    kind: 'newsletter',
    subject: 'Weekend getaways from 49',
    travel: true,
  },
  { name: 'Market Notes', address: 'notes@marketnotes.example', kind: 'newsletter', subject: 'Morning briefing' },
]

/** How many automated messages the seed holds, each its own conversation: about 95% of the conversations. */
const AUTOMATED = 900

/** The `index`th automated message, sent at `sentAt`. Every one starts its own conversation. */
const automated = (index: number, sentAt: string): SeedMessage => {
  const sender = SENDERS[index % SENDERS.length]
  if (!sender) throw new Error('people-first has no automated senders')
  const marks: Record<Kind, Pick<SeedMessage, 'headers' | 'bulk'>> = {
    notification: { headers: { autoSubmitted: 'auto-generated' } },
    receipt: { headers: { autoSubmitted: 'auto-generated' } },
    newsletter: { headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' }, bulk: true },
  }
  return {
    key: `auto-${index}`,
    mailboxes: ['inbox', ...(sender.kind === 'receipt' ? ['receipts'] : []), ...(sender.travel ? ['travel'] : [])],
    from: { name: sender.name, address: sender.address },
    to: [ME],
    subject: `${sender.subject} #${1000 + index}`,
    text: `${sender.subject}. This message was sent automatically.`,
    sentAt,
    // Older automated mail has been read. The newest day's is not.
    unread: index >= AUTOMATED - 8,
    ...marks[sender.kind],
  }
}

/**
 * An HTML newsletter that tries what hostile mail tries: a script, an inline handler, a
 * tracking pixel, a remote stylesheet, a remote font and a link to a remote page. The `probe` paragraph keeps its
 * text only if none of it ran, and the dev host's UI check reads it.
 */
const htmlNewsletter: SeedMessage = {
  key: 'html-newsletter',
  mailboxes: ['inbox'],
  from: { name: 'The Long Read', address: 'newsletter@longread.example' },
  to: [ME],
  subject: 'Five essays for the weekend',
  text: 'Five essays for the weekend. Read them in your browser.',
  html: [
    '<link rel="stylesheet" href="https://styles.longread.example/mail.css">',
    '<style>@font-face{font-family:Remote;src:url(https://fonts.longread.example/serif.woff2)}h1{font-family:Remote,Georgia,serif}</style>',
    '<h1>Five essays for the weekend</h1>',
    '<p id="probe">Nothing in this message ran.</p>',
    '<p>On slow mornings, small gardens and the quiet web.</p>',
    '<p><a id="out" href="https://read.longread.example/essays">Read in your browser</a></p>',
    '<img src="https://pixel.longread.example/open.gif" width="1" height="1" alt="">',
    '<img src="missing.png" alt="" onerror="document.getElementById(\'probe\').textContent=\'A handler ran.\'">',
    "<script>document.getElementById('probe').textContent='A script ran.';top.postMessage('script ran','*')</script>",
  ].join(''),
  sentAt: ago(40 * 60_000),
  unread: true,
  headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' },
  bulk: true,
}

const people = SPECS.flatMap(conversation)
// Spread over the last 120 days, oldest first, the newest 30 minutes before NOW.
const machines = Array.from({ length: AUTOMATED }, (_, index) =>
  automated(index, ago(30 * 60_000 + (AUTOMATED - 1 - index) * Math.floor((120 * DAY) / AUTOMATED))),
)

export const peopleFirst: DevSeed = {
  dialect: 'labels',
  now: NOW,
  seed: {
    address: ME.address,
    password: 'people-first',
    mailboxes: [
      { key: 'inbox', name: 'Inbox', role: 'inbox' },
      { key: 'sent', name: 'Sent', role: 'sent' },
      { key: 'trash', name: 'Trash', role: 'trash' },
      { key: 'projects', name: 'Projects', role: null },
      { key: 'receipts', name: 'Receipts', role: null },
      { key: 'travel', name: 'Travel', role: null },
    ],
    messages: [...people, ...machines, htmlNewsletter].toSorted((a, b) => a.sentAt.localeCompare(b.sentAt)),
  },
  delivery: (n) => automated(AUTOMATED + n, NOW),
  conversations: SPECS.map((spec): PersonConversation => ({
    subject: spec.subject,
    turn: spec.turn,
    lastAt: ago(spec.age),
  })),
}
