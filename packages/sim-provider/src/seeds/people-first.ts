// `people-first`: a mailbox shaped like a real one we measured. About 95% of it is automated
// mail from many senders: notifications, receipts and newsletters. The rest is people:
//   8 conversations where it is my turn, 1 hour to 26 days old
//   12 where I am waiting on them, 2 hours to 29 days old
//   27 turns older than 30 days, some mine and some theirs
// The people and their letters are in people-mail.ts. Receipts, travel mail and some
// conversations carry labels (Projects, Home, Receipts, Travel), and one newsletter is HTML
// that tries to run script and load remote content, which the reader must block.
// Every name, address and company here is made up.

import type { SeedAddress, SeedMessage } from '../contract.ts'
import type { DevSeed, PersonConversation } from '../seeds.ts'
import { agesOf, CONVERSATIONS, type Conversation, ME, PEOPLE } from './people-mail.ts'

const NOW = '2026-03-09T16:00:00.000Z'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The time `ms` before NOW. */
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString()

/** Whose turn a conversation is: theirs when I wrote last, mine when they did. */
const turnOf = (conversation: Conversation) => (conversation.says.at(-1)?.me ? 'theirs' : 'mine')

/** The messages of one conversation, oldest first, each answering all before it. */
const conversation = (spec: Conversation, number: number): SeedMessage[] => {
  const them = PEOPLE[spec.with]
  const keys = spec.says.map((_, index) => `person-${number}-${index}`)
  const ages = agesOf(spec)
  return spec.says.map((say, index): SeedMessage => {
    const mine = say.me === true
    const from: SeedAddress = mine ? ME : them
    const to: SeedAddress = mine ? them : ME
    return {
      key: keys[index] ?? `person-${number}-${index}`,
      mailboxes: [mine ? 'sent' : 'inbox', ...(spec.label ? [spec.label] : [])],
      from,
      to: [to],
      subject: index === 0 ? spec.subject : `Re: ${spec.subject}`,
      text: say.text,
      sentAt: ago(ages[index] ?? spec.age),
      unread: !mine && index === spec.says.length - 1 && spec.unread === true,
      replyTo: keys.slice(0, index),
      ...(say.attachments && { attachments: say.attachments }),
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

/** What each kind of machine says, so automated previews read like the real thing. */
const AUTOMATED_TEXT: Record<Kind, (name: string, index: number) => string> = {
  notification: (name) =>
    `You have a new notification from ${name}. Open ${name} to see it, or change how often we email you in your settings.`,
  receipt: (name, index) =>
    `Thanks for your order with ${name}. Total paid: €${10 + ((index * 7) % 90)}.${String(index % 100).padStart(2, '0')}. Receipt ${4000 + index}. Keep this email for your records.`,
  newsletter: (name) =>
    `This week from ${name}: what we read, what we made, and what is coming up. Read it online, or unsubscribe at any time.`,
}

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
    text: AUTOMATED_TEXT[sender.kind](sender.name, index),
    sentAt,
    // Older automated mail has been read. The newest day's is not.
    unread: index >= AUTOMATED - 8,
    ...marks[sender.kind],
  }
}

/**
 * An HTML newsletter that tries what hostile mail tries: a script, an inline handler, a
 * tracking pixel, a remote stylesheet, DNS-prefetch and preconnect hints (one in a noscript, one
 * in an iframe's srcdoc), a remote font and a link to a remote page. The `probe` paragraph keeps its
 * text only if none of it ran, and the dev host's UI check reads it. A preconnect also hides in text
 * around a deleted element, which must never join into a tag. The core takes the pixel out, blocks the
 * cover image until the user shows images, and reads the one-click unsubscribe from its headers.
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
    '<link rel="dns-prefetch" href="//prefetch.longread.example"><link rel="preconnect" href="https://connect.longread.example">',
    '<noscript><link rel="preconnect" href="https://noscript.longread.example"></noscript>',
    '<iframe srcdoc="&lt;link rel=preconnect href=https://srcdoc.longread.example&gt;"></iframe>',
    '<<iframe></iframe>link rel=dns-prefetch href=//joined.longread.example>',
    '<style>@font-face{font-family:Remote;src:url(https://fonts.longread.example/serif.woff2)}h1{font-family:Remote,Georgia,serif}</style>',
    '<h1>Five essays for the weekend</h1>',
    '<img src="https://images.longread.example/cover.jpg" width="560" height="280" alt="This week\'s cover">',
    '<p id="probe">Nothing in this message ran.</p>',
    '<p>On slow mornings, small gardens and the quiet web.</p>',
    '<p><a id="out" href="https://read.longread.example/essays">Read in your browser</a></p>',
    '<p><a href="https://longread.example/unsubscribe?u=1">Unsubscribe</a></p>',
    '<img src="https://pixel.longread.example/open.gif" width="1" height="1" alt="">',
    '<img src="missing.png" alt="" onerror="document.getElementById(\'probe\').textContent=\'A handler ran.\'">',
    "<script>document.getElementById('probe').textContent='A script ran.';top.postMessage('script ran','*')</script>",
  ].join(''),
  sentAt: ago(40 * 60_000),
  unread: true,
  headers: {
    listUnsubscribe: '<mailto:leave@longread.example>, <https://longread.example/unsubscribe?u=1>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
    listId: true,
    precedence: 'bulk',
  },
  bulk: true,
}

/**
 * HTML the core withholds, with no plain part: its one image is an SVG feImage, which the core's
 * rewrite does not placeholder, so the check on its output keeps the HTML from the reader. The
 * reader says so instead of showing nothing.
 */
const withheldNewsletter: SeedMessage = {
  key: 'withheld-newsletter',
  mailboxes: ['inbox'],
  from: { name: 'The Long Read', address: 'newsletter@longread.example' },
  to: [ME],
  subject: 'A layout we could not show',
  text: '',
  html: '<svg><filter><feImage href="https://images.longread.example/f.png"/></filter></svg><p>Hidden.</p>',
  sentAt: ago(41 * 60_000),
  unread: false,
  headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' },
  bulk: true,
}

const people = CONVERSATIONS.flatMap(conversation)
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
      { key: 'home', name: 'Home', role: null },
      { key: 'receipts', name: 'Receipts', role: null },
      { key: 'travel', name: 'Travel', role: null },
    ],
    messages: [...people, ...machines, htmlNewsletter, withheldNewsletter].toSorted((a, b) =>
      a.sentAt.localeCompare(b.sentAt),
    ),
  },
  delivery: (n) => automated(AUTOMATED + n, NOW),
  conversations: CONVERSATIONS.map((spec): PersonConversation => ({
    subject: spec.subject,
    turn: turnOf(spec),
    lastAt: ago(spec.age),
  })),
}
