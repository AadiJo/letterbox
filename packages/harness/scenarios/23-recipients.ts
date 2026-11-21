// Recipient suggestions: a recipient field types a prefix, and a live view lists the people
// the user has written with, from the local store alone. People the user wrote to come first,
// then people who only wrote to the user, each group by how much and how recent their mail is.
// Machines, spam, people only copied on someone else's mail, and the user are never suggested.

import type { AccountId, Recipient } from '@letterbox/protocol'
import type { Dialect, Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type { CoreClient } from '../src/client.ts'
import { ME, PASSWORD, signIn, sync } from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'
import { draft } from '../src/sending.ts'

const ANA = { name: 'Ana Lima', address: 'ana@example.com' }
const ANABEL = { name: 'Anabel Ortiz', address: 'Anabel@Example.org' }
const ANDREW = 'andrew@example.com'
const ANDREA = { name: 'Andrea Ruiz', address: 'andrea@example.com' }

/** One message, from `from` to `to`, sent at `sentAt`. Mail from me goes to Sent, the rest to the inbox. */
const mail = (
  key: string,
  from: SeedMessage['from'],
  to: SeedMessage['to'],
  sentAt: string,
  more: Partial<SeedMessage> = {},
): SeedMessage => ({
  key,
  mailboxes: [from === ME ? 'sent' : 'inbox'],
  from,
  to,
  subject: `About ${key}`,
  text: `A note about ${key}.`,
  sentAt,
  unread: false,
  ...more,
})

/**
 *   Ana       wrote to me and I answered, in December 2025              wrote to, recent
 *   Andrew    I wrote to him once, a year before                        wrote to, old
 *   Anabel    wrote to me three times in October 2025, never answered   only wrote to me
 *   Anton     copied on Ana's mail, never in touch                      not suggested
 *   machines  a newsletter and a no-reply sender whose names match,     not suggested
 *             and a notifications address I once wrote to
 *   Anastasia mail that sits in spam                                    not suggested
 *   Ben, Bea  I wrote to Ben twice and Bea once, the same week          more mail first
 *             (and named Bea in To and Cc, and copied myself to her: still one message)
 *   Megan     wrote to me, so a prefix of my own address finds her alone
 */
function seed(dialect: Dialect): Seed {
  return {
    address: ME,
    password: PASSWORD,
    mailboxes: [
      { key: 'inbox', name: 'Inbox', role: 'inbox' },
      { key: 'sent', name: 'Sent', role: 'sent' },
      { key: 'spam', name: 'Spam', role: 'spam' },
      ...(dialect === 'folders' ? [{ key: 'archive', name: 'Archive', role: 'archive' as const }] : []),
    ],
    messages: [
      mail('ana-asks', ANA, [ME], '2025-12-01T09:00:00.000Z', { cc: ['anton@example.com'] }),
      mail('ana-answer', ME, [ANA], '2025-12-01T10:00:00.000Z', {
        replyTo: ['ana-asks'],
        subject: 'Re: About ana-asks',
      }),
      mail('andrew', ME, [ANDREW], '2024-12-01T09:00:00.000Z'),
      mail('anabel-1', ANABEL, [ME], '2025-10-01T09:00:00.000Z'),
      mail('anabel-2', ANABEL, [ME], '2025-10-02T09:00:00.000Z'),
      mail('anabel-3', ANABEL, [ME], '2025-10-03T09:00:00.000Z'),
      mail('news', { name: "Ana's Weekly", address: 'ana-weekly@shop.example' }, [ME], '2025-12-05T09:00:00.000Z', {
        headers: { listUnsubscribe: true },
        bulk: true,
      }),
      mail(
        'reports',
        { name: 'Annual Reports', address: 'no-reply@reports.example' },
        [ME],
        '2025-12-06T09:00:00.000Z',
      ),
      mail('spam', { name: 'Anastasia', address: 'anastasia@spam.example' }, [ME], '2025-12-07T09:00:00.000Z', {
        mailboxes: ['spam'],
      }),
      mail('ben-1', ME, [{ name: 'Ben', address: 'ben@example.com' }], '2025-12-02T09:00:00.000Z'),
      mail('ben-2', ME, [{ name: 'Ben', address: 'ben@example.com' }], '2025-12-03T09:00:00.000Z'),
      mail('bea', ME, ['bea@example.com'], '2025-12-03T10:00:00.000Z', { cc: [ME, 'Bea@example.com'] }),
      mail('bot', ME, ['notifications@tracker.example'], '2025-12-04T09:00:00.000Z'),
      mail('megan', { name: 'Megan', address: 'megan@example.com' }, [ME], '2025-12-08T09:00:00.000Z'),
    ],
  }
}

async function begin(t: Scenario) {
  const box = t.mailbox(seed(t.dialect))
  const core = t.startCore()
  await core.hello()
  const accountId = await signIn(t, core, ME, PASSWORD)
  await sync(core)
  return { core, box, accountId }
}

/** What the recipients view suggests for `prefix`, asked once. */
const suggest = (core: CoreClient, accountId: AccountId, prefix: string, limit = 10): Promise<Recipient[]> =>
  core.query({ view: 'recipients', accountId, prefix, limit })

const addresses = (recipients: Recipient[] | undefined) => recipients?.map((recipient) => recipient.address)

scenario('recipient suggestions put people I wrote to first, then by how much and how recent', async (t) => {
  const { core, accountId } = await begin(t)
  t.equal(
    await suggest(core, accountId, 'an'),
    [
      { name: 'Ana Lima', address: 'ana@example.com' },
      { name: null, address: ANDREW },
      { name: 'Anabel Ortiz', address: 'Anabel@Example.org' },
    ],
    'Ana and Andrew, whom I wrote to, newest first, then Anabel, who only wrote to me, as her mail wrote her address',
  )
  t.equal(
    addresses(await suggest(core, accountId, 'b')),
    ['ben@example.com', 'bea@example.com'],
    'Ben, with two messages, before Bea, with one the same week that named her twice',
  )
  t.equal(addresses(await suggest(core, accountId, 'an', 1)), ['ana@example.com'], 'the limit keeps the best')
})

scenario(
  'recipient suggestions match the start of an address or of any word of a name, and nothing else',
  async (t) => {
    const { core, accountId } = await begin(t)
    t.equal(
      addresses(await suggest(core, accountId, 'LIM')),
      ['ana@example.com'],
      'a word of the name, whatever its case',
    )
    t.equal(addresses(await suggest(core, accountId, 'ana l')), ['ana@example.com'], 'the start of the whole name')
    t.equal(addresses(await suggest(core, accountId, 'anabel@')), ['Anabel@Example.org'], 'the start of the address')
    t.equal(addresses(await suggest(core, accountId, 'example')), [], 'not the middle of an address')
    t.equal(addresses(await suggest(core, accountId, 'me')), ['megan@example.com'], 'never my own address')
    t.equal(await suggest(core, accountId, ''), [], 'nothing before the user types')
    t.equal(addresses(await suggest(core, accountId, 'ant')), [], 'not Anton, who was only copied on mail to me')
    t.equal(
      [
        addresses(await suggest(core, accountId, 'weekly')),
        addresses(await suggest(core, accountId, 'annual')),
        addresses(await suggest(core, accountId, 'anastasia')),
        addresses(await suggest(core, accountId, 'notif')),
      ],
      [[], [], [], []],
      'not a newsletter, a no-reply sender, mail in spam, or a notifications address I wrote to',
    )
  },
)

scenario('recipient suggestions stay live as mail arrives, is sent and goes', async (t) => {
  const { core, box, accountId } = await begin(t)
  const view = core.subscribe({ view: 'recipients', accountId, prefix: 'an', limit: 10 })
  await view.next()
  t.equal(
    addresses(view.latest()),
    ['ana@example.com', ANDREW, 'Anabel@Example.org'],
    'the view opens with the people the prefix matches',
  )

  box.deliver(mail('andrea', ANDREA, [ME], '2025-12-31T09:00:00.000Z'))
  await sync(core)
  t.equal(
    addresses(view.latest()),
    ['ana@example.com', ANDREW, 'andrea@example.com', 'Anabel@Example.org'],
    "Andrea's one new message outweighs Anabel's three from three months before",
  )

  const send = await core.command({
    kind: 'send',
    draft: draft(accountId, null, { to: ['anabel@example.org'], subject: 'Hello', text: 'Sorry for the wait.' }),
  })
  t.equal((await core.settled(send.change)).result, 'done', 'a message to Anabel goes out')
  t.equal(
    view.latest()?.map((recipient) => [recipient.address, recipient.name]),
    [
      ['anabel@example.org', 'Anabel Ortiz'],
      ['ana@example.com', 'Ana Lima'],
      [ANDREW, null],
      ['andrea@example.com', 'Andrea Ruiz'],
    ],
    'now I wrote to Anabel, newest of all, so she leads, under the address I wrote and the name her mail gave',
  )

  box.expunge('andrea')
  await sync(core)
  t.equal(
    addresses(view.latest()),
    ['anabel@example.org', 'ana@example.com', ANDREW],
    'once her only message is gone, so is Andrea',
  )
  view.close()
})
