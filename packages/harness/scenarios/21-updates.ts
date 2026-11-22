// Updates: automated mail, one row per sender. The core groups each automated conversation
// under the address of its newest message from someone else, compared without case, and
// keeps the groups between commits. An open Updates list must always show what a new one
// would, and acting on a sender is one command naming the conversations its threads list shows.

import type { Dialect, Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type { SenderPage, SenderSummary, ThreadFilter } from '@letterbox/protocol'
import { fromBen, mailbox, ME, start, standardSeed, sync, threads, truthOf } from '../src/fixtures.ts'
import { scenario, type Scenario } from '../src/scenario.ts'
import type { CoreClient } from '../src/client.ts'

const SHOP = { name: 'Shop News', address: 'news@shop.example' }
const BANK = { name: 'Northwind Bank', address: 'alerts@bank.example' }
const RECEIPTS = { name: 'Shop', address: 'no-reply@shop.example' }

/** An automated message in the inbox. Each one's own headers say a machine sent it. */
const automated = (
  key: string,
  from: SeedMessage['from'],
  subject: string,
  sentAt: string,
  more: Partial<SeedMessage> = {},
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from,
  to: [ME],
  subject,
  text: `${subject}.`,
  sentAt,
  headers: { listUnsubscribe: true },
  ...more,
})

/**
 * The standard mailbox, whose shop newsletter is the only automated mail in it, plus:
 *   winter-sale  the same newsletter's address in other case     Shop News, unread
 *   receipt      the shop's no-reply address, a second sender,   Shop, two unread messages
 *                and a follow-up in the same conversation
 *   statement    a bank's alert, marked auto-generated, and      Northwind Bank, read
 *                my reply to it, which leaves it the bank's
 */
function updatesSeed(dialect: Dialect): Seed {
  const seed = standardSeed(dialect)
  return {
    ...seed,
    messages: [
      ...seed.messages,
      automated('winter-sale', { ...SHOP, address: 'News@Shop.example' }, 'Winter sale', '2025-12-06T09:00:00.000Z'),
      automated('receipt', RECEIPTS, 'Your receipt', '2025-12-05T09:00:00.000Z', { headers: {} }),
      automated('shipped', RECEIPTS, 'Your receipt', '2025-12-05T10:00:00.000Z', {
        headers: {},
        replyTo: ['receipt'],
      }),
      automated('statement', BANK, 'Your statement is ready', '2025-12-04T12:00:00.000Z', {
        headers: { autoSubmitted: 'auto-generated' },
        unread: false,
      }),
      {
        key: 'statement-question',
        mailboxes: ['sent'],
        from: ME,
        to: [BANK],
        subject: 'Re: Your statement is ready',
        text: 'Why is there a fee?',
        sentAt: '2025-12-04T13:00:00.000Z',
        unread: false,
        replyTo: ['statement'],
      },
    ],
  }
}

/** What a person reads on one Updates row. */
const shown = (sender: SenderSummary) => ({
  name: sender.name,
  address: sender.address,
  threads: sender.threads,
  messages: sender.messages,
  unread: sender.unread,
  subject: sender.subject,
  lastMessageAt: sender.lastMessageAt,
})

const rows = (page: SenderPage | undefined) => (page?.senders ?? []).map(shown)

/** Opens Updates over the inbox and checks it after each step against a list opened afresh. */
async function openUpdates(t: Scenario, core: CoreClient) {
  const inbox = await mailbox(core, 'Inbox')
  const query = { view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 } as const
  const updates = core.subscribe(query)
  await updates.next()
  return {
    inbox,
    updates,
    /** Fails unless the open list shows what a new one would, and returns it. */
    agree: async (when: string) => {
      const fresh = await core.query(query)
      t.equal(updates.latest(), fresh, `${when}: the open Updates list shows what a new one would`)
      return fresh
    },
  }
}

/** The one row whose address is `address`, compared without case. */
const row = (page: SenderPage, address: string) => {
  const found = page.senders.find((sender) => sender.address.toLowerCase() === address)
  if (!found) throw new Error(`Updates has no row for ${address}`)
  return found
}

scenario('Updates groups automated mail by sender, live as it arrives, is read and is archived', async (t) => {
  const { core, box } = await start(t, updatesSeed(t.dialect))
  const { inbox, agree } = await openUpdates(t, core)
  const first = await agree('synced')
  t.equal(
    rows(first),
    [
      {
        name: 'Shop News',
        address: 'News@Shop.example',
        threads: 2,
        messages: 2,
        unread: 2,
        subject: 'Winter sale',
        lastMessageAt: '2025-12-06T09:00:00.000Z',
      },
      {
        name: 'Shop',
        address: 'no-reply@shop.example',
        threads: 1,
        messages: 2,
        unread: 2,
        subject: 'Your receipt',
        lastMessageAt: '2025-12-05T10:00:00.000Z',
      },
      {
        name: 'Northwind Bank',
        address: 'alerts@bank.example',
        threads: 1,
        messages: 2,
        unread: 0,
        subject: 'Your statement is ready',
        lastMessageAt: '2025-12-04T13:00:00.000Z',
      },
    ],
    "one row per address, newest first: the newsletter in either case is one sender, its no-reply address another, my reply leaves the alert the bank's, and mail from people is in none",
  )
  t.equal(first.total, 3, 'Updates counts three senders')

  box.deliver(
    automated('payment', BANK, 'Card payment received', '2025-12-07T09:00:00.000Z', {
      headers: { autoSubmitted: 'auto-generated' },
    }),
  )
  box.deliver(fromBen('standup', 'Standup moved to 10', '2025-12-08T09:00:00.000Z'))
  await sync(core)
  const arrived = await agree('new mail arrived')
  t.equal(
    rows(arrived).map((sender) => ({
      name: sender.name,
      threads: sender.threads,
      unread: sender.unread,
      subject: sender.subject,
    })),
    [
      { name: 'Northwind Bank', threads: 2, unread: 1, subject: 'Card payment received' },
      { name: 'Shop News', threads: 2, unread: 2, subject: 'Winter sale' },
      { name: 'Shop', threads: 1, unread: 2, subject: 'Your receipt' },
    ],
    "the bank's new alert moves it to the top, and Ben's new mail joins no sender",
  )

  const [sale] = await threads(core, { text: 'Winter sale' })
  if (!sale) throw new Error('no Winter sale thread')
  const read = await core.command({ kind: 'set-flags', threadIds: [sale.id], unread: false })
  t.equal((await core.settled(read.change)).result, 'done', 'marking the sale read settles')
  t.equal(row(await agree('one read'), SHOP.address).unread, 1, 'the newsletter has one unread message left')

  const [receipt] = await threads(core, { text: 'Your receipt' })
  if (!receipt) throw new Error('no receipt thread')
  const archive = await core.command({ kind: 'set-mailboxes', threadIds: [receipt.id], add: [], remove: [inbox.id] })
  t.equal((await core.settled(archive.change)).result, 'done', 'archiving the receipt settles')
  const archived = await agree('its only conversation archived')
  t.equal(
    archived.senders.map((sender) => sender.name),
    ['Northwind Bank', 'Shop News'],
    'a sender with nothing left in the inbox leaves Updates',
  )
  t.equal(archived.total, 2, 'Updates counts two senders')
})

scenario('acting on a whole sender marks all read and archives all, and undo brings them back', async (t) => {
  const { core, box } = await start(t, updatesSeed(t.dialect))
  const { inbox, agree } = await openUpdates(t, core)
  const shop = row(await agree('synced'), SHOP.address)

  // Opening a sender lists its conversations. A command names them, so it acts on exactly
  // what the list showed, and mail that arrives meanwhile stays as it was.
  const filter: ThreadFilter = { mailboxId: inbox.id, sender: shop.id }
  const listed = await threads(core, filter)
  t.equal(
    listed.map((thread) => thread.subject),
    ['Winter sale', 'December offers'],
    "opening the sender lists both of the newsletter's conversations, newest first",
  )
  const threadIds = listed.map((thread) => thread.id)

  const read = await core.command({ kind: 'set-flags', threadIds, unread: false })
  t.equal((await core.settled(read.change)).result, 'done', 'mark all read settles')
  const allRead = await agree('all read')
  t.equal(row(allRead, SHOP.address).unread, 0, 'the newsletter has no unread message')
  t.equal(row(allRead, BANK.address).unread, 0, 'the bank is untouched')
  t.equal(row(allRead, 'no-reply@shop.example').unread, 2, "the shop's other address is untouched")
  t.equal(
    ['newsletter', 'winter-sale'].map((key) => truthOf(box, key)?.unread),
    [false, false],
    'the provider holds both newsletters read',
  )

  const archive = await core.command({ kind: 'set-mailboxes', threadIds, add: [], remove: [inbox.id] })
  t.equal((await core.settled(archive.change)).result, 'done', 'archive all settles')
  const archived = await agree('all archived')
  t.equal(
    archived.senders.map((sender) => sender.name),
    ['Shop', 'Northwind Bank'],
    'the newsletter leaves Updates and the other senders stay',
  )
  t.equal(await threads(core, filter), [], 'the sender lists nothing in the inbox')
  const away = t.dialect === 'folders' ? ['archive'] : []
  t.equal(
    ['newsletter', 'winter-sale'].map((key) => truthOf(box, key)?.mailboxes),
    [away, away],
    'the provider holds both newsletters archived',
  )

  if (archive.kind !== 'accepted') throw new Error('the archive was not accepted')
  const undo = await core.command({ kind: 'undo', change: archive.change })
  t.equal(undo.kind, 'accepted', 'the undo is accepted')
  t.equal((await core.settled(undo.change)).result, 'done', 'the undo settles')
  await sync(core)
  t.equal(
    shown(row(await agree('archive undone'), SHOP.address)),
    { ...shown(shop), unread: 0 },
    'the newsletter is back in Updates as it was, still read',
  )
  t.equal(
    ['newsletter', 'winter-sale'].map((key) => truthOf(box, key)?.mailboxes),
    [['inbox'], ['inbox']],
    'the provider holds both newsletters in the inbox again',
  )
})
