// `many`: a mailbox of 6,000 conversations, one message each, for scrolling a whole mailbox.
// Every message is a made-up notification, a minute apart, the newest five minutes before NOW.
// It has no Trash, as some folder accounts have none, so the core cannot trash anything here.

import type { SeedMessage } from '../contract.ts'
import type { DevSeed } from '../seeds.ts'

const NOW = '2026-03-09T16:00:00.000Z'
const ME = { name: 'Robin Vale', address: 'robin@vale.test' }
const COUNT = 6000

const SENDERS = [
  { name: 'Codeyard', address: 'notifications@codeyard.example', subject: 'Build passed on main' },
  { name: 'Tasklane', address: 'notifications@tasklane.example', subject: 'You were mentioned in a task' },
  { name: 'Parcelpoint', address: 'tracking@parcelpoint.example', subject: 'Your parcel is on its way' },
  { name: 'Northbank', address: 'alerts@northbank.example', subject: 'A payment left your account' },
  { name: 'Calendo', address: 'calendar-noreply@calendo.example', subject: 'Reminder: standup at 9:30' },
]

/** The `index`th message, counting from the oldest. Each one starts its own conversation. */
const message = (index: number, sentAt: string): SeedMessage => {
  const sender = SENDERS[index % SENDERS.length]
  if (!sender) throw new Error('many has no senders')
  return {
    key: `many-${index}`,
    mailboxes: ['inbox'],
    from: { name: sender.name, address: sender.address },
    to: [ME],
    subject: `${sender.subject} #${index}`,
    text: `${sender.subject}. Message ${index} of a large mailbox.`,
    sentAt,
    unread: false,
    headers: { autoSubmitted: 'auto-generated' },
  }
}

const minutesBefore = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString()

export const many: DevSeed = {
  dialect: 'labels',
  now: NOW,
  seed: {
    address: ME.address,
    password: 'many',
    // Big pages keep the first sync short. The scroll check needs the whole mailbox, not the paging.
    pageSize: 1000,
    mailboxes: [
      { key: 'inbox', name: 'Inbox', role: 'inbox' },
      { key: 'sent', name: 'Sent', role: 'sent' },
    ],
    messages: Array.from({ length: COUNT }, (_, index) => message(index, minutesBefore(5 + COUNT - 1 - index))),
  },
  delivery: (n) => message(COUNT + n, NOW),
  conversations: [],
  images: [],
  web: { txt: [], resolve: [], serve: [] },
}
