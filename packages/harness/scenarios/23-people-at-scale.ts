// Updates, Your turn and Let go? over a mailbox shaped like the scale bench's
// (packages/harness/src/bench.ts), each checked against what the seed itself says they
// should hold. The bench times these lists at 100k messages. This checks they are right,
// before and after a burst of commands and new mail, with every list kept open throughout.

import type { SeedMailbox, SeedMessage, Seed } from '@letterbox/sim-provider/contract'
import type { ThreadFilter } from '@letterbox/protocol'
import { ME, PASSWORD, signIn, sync, threads } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const SIZE = 1000
/** The core's clock. The first half of the mailbox is from November 2024, over 30 days before
 * it, and the second from January 2025, which turns 30 days old a day later. */
const NOW = '2025-01-30T00:00:00.000Z'
const CUTOFF = '2024-12-31T00:00:00.000Z'

const MAILBOXES: SeedMailbox[] = [
  { key: 'inbox', name: 'Inbox', role: 'inbox' },
  { key: 'sent', name: 'Sent', role: 'sent' },
  { key: 'archive', name: 'Archive', role: 'archive' },
  { key: 'trash', name: 'Trash', role: 'trash' },
]

/**
 * One message, as the bench makes them: every second message in a conversation is mine,
 * and every seventh conversation is a newsletter, sent by one of 300 people's addresses.
 */
function message(index: number, conversation: number, place: number): SeedMessage {
  const other = { name: `Person ${conversation % 300}`, address: `person${conversation % 300}@example.com` }
  const mine = place % 2 === 1
  const start = index < SIZE / 2 ? Date.UTC(2024, 10, 1) : Date.UTC(2025, 0, 1)
  return {
    key: `m${index}`,
    mailboxes: mine ? ['sent'] : ['inbox'],
    from: mine ? ME : other,
    to: mine ? [other] : [ME],
    subject: place === 0 ? `Topic ${conversation}` : `Re: Topic ${conversation}`,
    text: `Message m${index} about topic ${conversation}.`,
    sentAt: new Date(start + index * 60_000).toISOString(),
    unread: index % 3 === 0,
    ...(place > 0 && { replyTo: [`m${index - 1}`] }),
    ...(conversation % 7 === 0 && { headers: { listUnsubscribe: true } }),
  }
}

/** The mailbox's conversations, each a list of its messages, oldest first. */
function conversations(size: number, first = 0, from = 0): SeedMessage[][] {
  const all: SeedMessage[][] = []
  let index = first
  for (let conversation = from; index < first + size; conversation += 1) {
    const length = 1 + (conversation % 4)
    const messages: SeedMessage[] = []
    for (let place = 0; place < length && index < first + size; place += 1) {
      messages.push(message(index, conversation, place))
      index += 1
    }
    all.push(messages)
  }
  return all
}

const isMine = (one: SeedMessage) => one.from === ME
const last = <T>(items: readonly T[]) => items[items.length - 1] as T

/** What Updates should show for these conversations, worked out from the seed alone. */
function expectedSenders(all: SeedMessage[][]) {
  const groups = new Map<
    string,
    {
      name: string
      address: string
      threads: number
      messages: number
      unread: number
      subject: string
      lastMessageAt: string
    }
  >()
  for (const messages of all) {
    const newest = messages.findLast((one) => !isMine(one))
    if (!newest?.headers?.listUnsubscribe || typeof newest.from === 'string') continue
    const at = last(messages).sentAt
    const group = groups.get(newest.from.address) ?? {
      name: newest.from.name,
      address: newest.from.address,
      threads: 0,
      messages: 0,
      unread: 0,
      subject: '',
      lastMessageAt: '',
    }
    group.threads += 1
    group.messages += messages.length
    group.unread += messages.filter((one) => one.unread ?? true).length
    if (at > group.lastMessageAt)
      Object.assign(group, { subject: (messages[0] as SeedMessage).subject, lastMessageAt: at })
    groups.set(newest.from.address, group)
  }
  return [...groups.values()].toSorted((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
}

/** The subjects Your turn (`retired` false) or Let go? (true) should list, newest first. */
function expectedTurns(all: SeedMessage[][], retired: boolean) {
  return all
    .filter((messages) => !isMine(last(messages)) && !last(messages).headers?.listUnsubscribe)
    .filter((messages) => last(messages).sentAt <= CUTOFF === retired)
    .toSorted((a, b) => last(b).sentAt.localeCompare(last(a).sentAt))
    .map((messages) => (messages[0] as SeedMessage).subject)
}

scenario('Updates, Your turn and Let go hold what the seed says over a bench-shaped mailbox', async (t) => {
  const all = conversations(SIZE)
  const seed: Seed = { address: ME, password: PASSWORD, pageSize: 200, mailboxes: MAILBOXES, messages: all.flat() }
  const box = t.mailbox(seed)
  const core = t.startCore({ now: NOW })
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await sync(core)

  const inbox = (await core.query({ view: 'mailboxes' })).find((one) => one.role === 'inbox')
  if (!inbox) throw new Error('no inbox')
  const updatesQuery = { view: 'senders', mailboxId: inbox.id, offset: 0, limit: 500 } as const
  const lists: [name: string, filter: ThreadFilter][] = [
    ['Your turn', { turn: 'mine', retired: false }],
    ['Let go?', { turn: 'mine', retired: true }],
  ]
  const updates = core.subscribe(updatesQuery)
  const open = lists.map(([name, filter]) => ({
    name,
    filter,
    list: core.subscribe({ view: 'threads', filter, offset: 0, limit: 500 }),
  }))
  await Promise.all([updates.next(), ...open.map(({ list }) => list.next())])

  /** Checks every open list against the seed, and against the same list opened now. */
  const check = async (when: string, mail: SeedMessage[][]) => {
    const fresh = await core.query(updatesQuery)
    t.equal(updates.latest(), fresh, `${when}: the open Updates list shows what a new one would`)
    t.equal(
      fresh.senders.map(({ name, address, threads: count, messages, unread, subject, lastMessageAt }) => ({
        name,
        address,
        threads: count,
        messages,
        unread,
        subject,
        lastMessageAt,
      })),
      expectedSenders(mail),
      `${when}: Updates groups every newsletter under its sender, as the seed says`,
    )
    for (const { name, filter, list } of open) {
      const listed = await core.query({ view: 'threads', filter, offset: 0, limit: 500 })
      t.equal(list.latest(), listed, `${when}: the open ${name} list shows what a new one would`)
      t.equal(
        listed.threads.map((thread) => thread.subject),
        expectedTurns(mail, filter.retired === true),
        `${when}: ${name} holds the seed's turns of mine on its side of 30 days`,
      )
    }
  }
  await check('synced', all)

  // A burst, as select-all sends: mark ten newsletters read, one command each, all at once.
  const newsletters = (await threads(core, { mailboxId: inbox.id })).filter(
    (thread) => /^Topic \d+$/.test(thread.subject) && Number(thread.subject.slice(6)) % 7 === 0,
  )
  const burst = await Promise.all(
    newsletters
      .slice(0, 10)
      .map((thread) => core.command({ kind: 'set-flags', threadIds: [thread.id], unread: false })),
  )
  for (const answer of burst) t.equal((await core.settled(answer.change)).result, 'done', 'a mark-read settles')
  const read = new Set(newsletters.slice(0, 10).map((thread) => thread.subject))
  const afterBurst = all.map((messages) =>
    read.has((messages[0] as SeedMessage).subject) ? messages.map((one) => ({ ...one, unread: false })) : messages,
  )
  await check('ten newsletters read', afterBurst)

  // New mail: 50 more messages, in new conversations after the newest.
  const arriving = conversations(50, SIZE, all.length)
  for (const one of arriving.flat()) box.deliver(one)
  await sync(core)
  await check('50 new messages arrived', [...afterBurst, ...arriving])
})
