// The mailbox most scenarios start from, and the few steps they all share.

import type { Dialect, SimMailbox, Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type {
  Account,
  AccountId,
  Mailbox,
  Message,
  ThreadDetail,
  ThreadFilter,
  ThreadId,
  ThreadSummary,
} from '@letterbox/protocol'
import type { CoreClient, Subscription } from './client.ts'
import type { Scenario } from './scenario.ts'

export const ME = 'me@sim.test'
export const PASSWORD = 'correct horse'

const ANA = { name: 'Ana', address: 'ana@example.com' }
const BEN = { name: 'Ben', address: 'ben@example.com' }

/**
 * Six messages in five conversations:
 *   lunch       Ana asked, I answered            their turn
 *   review      Ben asked me something           my turn
 *   newsletter  a shop's mailing list            nobody's turn
 *   fyi         I am only copied                 nobody's turn
 *   photos      old, read, archived, flagged, with two attachments and a remote image
 * A labels mailbox archives by taking a message out of every mailbox.
 * A folders mailbox has an Archive folder.
 */
export function standardSeed(dialect: Dialect, changes: Partial<Seed> = {}): Seed {
  const archived = dialect === 'labels' ? [] : ['archive']
  return {
    address: ME,
    password: PASSWORD,
    mailboxes: [
      { key: 'inbox', name: 'Inbox', role: 'inbox' },
      { key: 'sent', name: 'Sent', role: 'sent' },
      { key: 'trash', name: 'Trash', role: 'trash' },
      { key: 'projects', name: 'Projects', role: null },
      ...(dialect === 'folders' ? [{ key: 'archive', name: 'Archive', role: 'archive' as const }] : []),
    ],
    messages: [
      {
        key: 'photos',
        mailboxes: archived,
        from: ANA,
        to: [ME],
        subject: 'Trip photos',
        text: 'Here are the photos from the trip.',
        html: '<p>Here are the photos.</p><img src="https://tracker.example/pixel.gif">',
        sentAt: '2025-11-20T09:00:00.000Z',
        unread: false,
        flagged: true,
        attachments: 2,
      },
      {
        key: 'lunch-ask',
        mailboxes: ['inbox'],
        from: ANA,
        to: [ME],
        subject: 'Lunch on Friday?',
        text: 'Are you free for lunch on Friday?',
        sentAt: '2025-12-01T09:00:00.000Z',
      },
      {
        key: 'lunch-answer',
        mailboxes: ['sent'],
        from: ME,
        to: [ANA],
        subject: 'Re: Lunch on Friday?',
        text: 'Yes. Noon works.\n> Are you free for lunch on Friday?',
        sentAt: '2025-12-01T10:00:00.000Z',
        unread: false,
        replyTo: ['lunch-ask'],
      },
      {
        key: 'review',
        mailboxes: ['inbox'],
        from: BEN,
        to: [ME],
        subject: 'Can you review the draft?',
        text: 'Can you review the draft before Thursday?',
        sentAt: '2025-12-02T09:00:00.000Z',
      },
      {
        key: 'newsletter',
        mailboxes: ['inbox'],
        from: { name: 'Shop News', address: 'news@shop.example' },
        to: [ME],
        subject: 'December offers',
        text: 'Everything is on sale.',
        sentAt: '2025-12-03T09:00:00.000Z',
        headers: { listUnsubscribe: true },
        bulk: true,
      },
      {
        key: 'fyi',
        mailboxes: ['inbox'],
        from: { name: 'Cara', address: 'cara@example.com' },
        to: ['dan@example.com'],
        cc: [ME],
        subject: 'Budget numbers',
        text: 'Dan, the numbers are attached. Copying the team.',
        sentAt: '2025-12-04T09:00:00.000Z',
      },
    ],
    ...changes,
  }
}

/** A message from Ben to me in the inbox, for scenarios that deliver new mail. */
export const fromBen = (
  key: string,
  subject: string,
  sentAt: string,
  more: Partial<SeedMessage> = {},
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: BEN,
  to: [ME],
  subject,
  text: `${subject}.`,
  sentAt,
  ...more,
})

export type SignedIn = { core: CoreClient; box: SimMailbox; accountId: AccountId }

/** Signs in with a password through the options the core lists. Fails the scenario if it does not work. */
export async function signIn(t: Scenario, core: CoreClient, address: string, password: string): Promise<AccountId> {
  const options = await core.query({ view: 'sign-in-options' })
  const option = options.find((candidate) => candidate.method === 'password')
  if (!option) throw new Error('the core lists no password sign-in option')
  const response = await core.request({
    method: 'sign-in',
    option: option.id,
    password: { username: address, password },
  })
  if (!response.ok) throw new Error(`sign-in failed: ${response.error}`)
  t.note(`signed in as ${address}`)
  return response.result.accountId
}

/** The usual start: one mailbox at the provider, a running core, signed in and synced once. */
export async function start(t: Scenario, seed: Seed = standardSeed(t.dialect)): Promise<SignedIn> {
  const box = t.mailbox(seed)
  const core = t.startCore()
  await core.hello()
  const accountId = await signIn(t, core, seed.address, seed.password)
  await sync(core)
  return { core, box, accountId }
}

/** Runs one sync pass and fails unless it reached the provider. */
export async function sync(core: CoreClient) {
  const response = await core.request({ method: 'sync-now' })
  if (!response.ok) throw new Error(`sync failed: ${response.error}`)
}

/**
 * Waits until an open accounts view passes `ready`, closes it, and returns what it shows.
 * Scenarios wait on what the core reports, never on time. Open the view before the step
 * whose effect it waits for: a view opened while that effect is on its way may or may not
 * get an update from before it, so the transcript would change from run to run.
 */
export async function untilAccounts(
  view: Subscription<'accounts'>,
  ready: (accounts: Account[]) => boolean,
): Promise<Account[]> {
  for (;;) {
    const accounts = view.latest()
    if (accounts && ready(accounts)) {
      view.close()
      return accounts
    }
    await view.next()
  }
}

/** Every thread that passes `filter`, newest first. */
export async function threads(core: CoreClient, filter: ThreadFilter = {}): Promise<ThreadSummary[]> {
  return (await core.query({ view: 'threads', filter, offset: 0, limit: 500 })).threads
}

/** The one thread with this subject. Throws if there is none, or more than one. */
export async function thread(core: CoreClient, subject: string): Promise<ThreadSummary> {
  const found = (await threads(core)).filter((candidate) => candidate.subject === subject)
  if (found.length !== 1) throw new Error(`expected one thread with subject "${subject}", found ${found.length}`)
  return found[0] as ThreadSummary
}

/** The one mailbox with this name. */
export async function mailbox(core: CoreClient, name: string): Promise<Mailbox> {
  const found = (await core.query({ view: 'mailboxes' })).find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no mailbox named "${name}"`)
  return found
}

/** Waits until no message in an open conversation shows a loading body, and returns the conversation. */
export async function bodiesSettled(open: Subscription<'thread'>): Promise<ThreadDetail | null> {
  let detail = open.count() > 0 ? (open.latest() ?? null) : await open.next()
  while (detail?.messages.some((message) => message.body.state === 'loading')) detail = await open.next()
  return detail
}

/** Opens a conversation and waits until no body is loading. The scenario closes it, or the run ends it. */
export async function openThread(core: CoreClient, threadId: ThreadId): Promise<Subscription<'thread'>> {
  const open = core.subscribe({ view: 'thread', threadId })
  await bodiesSettled(open)
  return open
}

/** Reads a conversation once, after its bodies have settled. */
export async function readThread(core: CoreClient, threadId: ThreadId): Promise<ThreadDetail | null> {
  const open = await openThread(core, threadId)
  const detail = open.latest() ?? null
  open.close()
  return detail
}

/** Opens a conversation without waiting. Only for scenarios that hold the mailbox's bodies. */
export const watchThread = (core: CoreClient, threadId: ThreadId): Subscription<'thread'> =>
  core.subscribe({ view: 'thread', threadId })

/** Reads a conversation and returns its first message, which must have its body. */
export async function openWithBody(core: CoreClient, threadId: ThreadId): Promise<Message> {
  const first = (await readThread(core, threadId))?.messages[0]
  if (first?.body.state !== 'ready') throw new Error(`the body did not load: ${JSON.stringify(first?.body)}`)
  return first
}

/** What the provider holds for one message. */
export const truthOf = (box: SimMailbox, key: string) => box.truth().find((message) => message.key === key)
