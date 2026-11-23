// `people-first`: a mailbox shaped like a real one we measured. About 95% of it is automated
// mail from many senders: notifications, receipts and newsletters. The rest is people:
//   8 conversations where it is my turn, 1 hour to 26 days old
//   12 where I am waiting on them, 2 hours to 29 days old
//   27 turns older than 30 days, some mine and some theirs
// The people and their letters are in people-mail.ts, two of which quote the history before
// them, one in plain text and one in HTML. Receipts, travel mail and some conversations carry
// labels (Projects, Home, Receipts, Travel). The HTML mail, hostile and branded, is in people-html.ts.
// Every name, address and company here is made up.

import type { SeedAddress, SeedMessage } from '../contract.ts'
import type { DevSeed, PersonConversation } from '../seeds.ts'
import { HTML_MAIL, IMAGES } from './people-html.ts'
import { agesOf, ago, CONVERSATIONS, type Conversation, DAY, ME, NOW, PEOPLE } from './people-mail.ts'

/** Whose turn a conversation is: theirs when I wrote last, mine when they did. */
const turnOf = (conversation: Conversation) => (conversation.says.at(-1)?.me ? 'theirs' : 'mine')

/** A message as a later one quotes it: who wrote it, when, and what it said. */
type Written = { from: { name: string; address: string }; sentAt: string; text: string }

/** "On Mon, Feb 16, 2026 at 4:40 PM, Robin Vale <robin@vale.test> wrote:", as Gmail writes it, in UTC. */
const attribution = ({ from, sentAt }: Written) => {
  const at = new Date(sentAt)
  const day = at.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  // Newer ICU puts a narrow no-break space before AM and PM. Mail clients write a plain one.
  return `On ${day} at ${time.replace(/\s/g, ' ')}, ${from.name} <${from.address}> wrote:`
}

/** `earlier`, newest last, quoted in plain text: each one's attribution, then its lines behind `>`, nesting the rest. */
const quotedText = (earlier: readonly Written[]): string => {
  const last = earlier.at(-1)
  if (!last) return ''
  const rest = quotedText(earlier.slice(0, -1))
  const body = rest === '' ? last.text : `${last.text}\n\n${rest}`
  return `${attribution(last)}\n${body
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')}`
}

const escaped = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const paragraphs = (text: string) =>
  text
    .split('\n\n')
    .map((paragraph) => `<p>${escaped(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('')

/** `earlier`, newest last, quoted as Gmail's HTML quotes it: a gmail_quote block, each one nested in the next. */
const quotedHtml = (earlier: readonly Written[]): string => {
  const last = earlier.at(-1)
  if (!last) return ''
  return (
    `<div class="gmail_quote"><div class="gmail_attr">${escaped(attribution(last))}<br></div>` +
    '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">' +
    `${paragraphs(last.text)}${quotedHtml(earlier.slice(0, -1))}</blockquote></div>`
  )
}

/** The messages of one conversation, oldest first, each answering all before it. */
const conversation = (spec: Conversation, number: number): SeedMessage[] => {
  const them = PEOPLE[spec.with]
  const keys = spec.says.map((_, index) => `person-${number}-${index}`)
  const ages = agesOf(spec)
  const written = spec.says.map((say, index): Written => ({
    from: say.me ? ME : them,
    sentAt: ago(ages[index] ?? spec.age),
    text: say.text,
  }))
  return spec.says.map((say, index): SeedMessage => {
    const mine = say.me === true
    const from: SeedAddress = mine ? ME : them
    const to: SeedAddress = mine ? them : ME
    const earlier = written.slice(0, index)
    return {
      key: keys[index] ?? `person-${number}-${index}`,
      mailboxes: [mine ? 'sent' : 'inbox', ...(spec.label ? [spec.label] : [])],
      from,
      to: [to],
      subject: index === 0 ? spec.subject : `Re: ${spec.subject}`,
      text: say.quotes ? `${say.text}\n\n${quotedText(earlier)}` : say.text,
      ...(say.quotes === 'html' && {
        html: `<div dir="ltr">${paragraphs(say.text)}${say.logo ? `<p><img src="${say.logo.url}" width="160" height="32" alt="${escaped(say.logo.alt)}"></p>` : ''}</div>${quotedHtml(earlier)}`,
      }),
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
    messages: [...people, ...machines, ...HTML_MAIL].toSorted((a, b) => a.sentAt.localeCompare(b.sentAt)),
  },
  delivery: (n) => automated(AUTOMATED + n, NOW),
  images: IMAGES,
  conversations: CONVERSATIONS.map((spec): PersonConversation => ({
    subject: spec.subject,
    turn: turnOf(spec),
    lastAt: ago(spec.age),
  })),
}
