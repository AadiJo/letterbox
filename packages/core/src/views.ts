// Answers the live views a client subscribes to, from the world as it is now.
// Everything here is a pure read.

import type {
  Account,
  AccountStatus,
  Body,
  Mailbox,
  MailboxId,
  Message,
  Person,
  Query,
  SignInOption,
  ThreadDetail,
  ThreadFilter,
  ThreadId,
  ThreadSummary,
  Update,
} from '@letterbox/protocol'
import type { RemoteAddress } from './adapter.ts'
import { pendingOps, viewState } from './changes.ts'
import { decideTurn, isAutomated } from './turns.ts'
import { type AccountRecord, blobIdOf, type MessageRecord, messagesOf, type Op, scoped, type World } from './world.ts'

/** The parts of an answer that live outside the world: what is in flight right now. */
export type Live = {
  status(account: AccountRecord): AccountStatus
  /** The body state for a message whose body is not stored yet. */
  missingBody(record: MessageRecord): Body
  options: SignInOption[]
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const person = (address: RemoteAddress, me: string): Person => ({
  name: address.name,
  address: address.address,
  isMe: same(address.address, me),
})

const REMOTE_CONTENT = /\b(src|srcset|background|poster)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i

/** One row for a thread, or null when the thread has no messages left. */
function summarize(world: World, threadId: ThreadId, pending: Op[]): ThreadSummary | null {
  const thread = world.threads.get(threadId)
  const account = thread && world.accounts.get(thread.accountId)
  const records = messagesOf(world, threadId)
  const first = records[0]
  const last = records.at(-1)
  if (!thread || !account || !first || !last) return null

  const states = records.map((record) => viewState(record, pending))
  const people = new Map<string, Person>()
  for (const record of records) {
    const from = person(record.facts.from, account.address)
    if (!people.has(from.address.toLowerCase())) people.set(from.address.toLowerCase(), from)
  }
  const turn = decideTurn(
    records.map((record) => ({
      fromMe: same(record.facts.from.address, account.address),
      toMe: record.facts.to.some((to) => same(to.address, account.address)),
      toAddresses: record.facts.to.map((to) => to.address),
      automated: isAutomated(record.facts),
    })),
    thread.override,
  )
  const ids = new Set(records.map((record) => record.id))
  return {
    id: thread.id,
    accountId: account.id,
    subject: first.facts.subject,
    people: [...people.values()],
    snippet: last.facts.preview,
    lastMessageAt: last.facts.sentAt,
    messageCount: records.length,
    unread: states.some((state) => state.unread),
    flagged: states.some((state) => state.flagged),
    hasAttachments: records.some((record) => record.facts.hasAttachments),
    mailboxIds: [...new Set(states.flatMap((state) => state.mailboxes))].filter((id) => world.mailboxes.has(id)),
    turn,
    pending: pending.some((op) => op.messageIds.some((id) => ids.has(id))),
  }
}

const matches = (summary: ThreadSummary, filter: ThreadFilter) => {
  if (filter.accountId !== undefined && summary.accountId !== filter.accountId) return false
  if (filter.mailboxId !== undefined && !summary.mailboxIds.includes(filter.mailboxId)) return false
  if (filter.turn !== undefined && summary.turn.holder !== filter.turn) return false
  if (filter.unread !== undefined && summary.unread !== filter.unread) return false
  if (filter.text !== undefined) {
    const haystack = [
      summary.subject,
      summary.snippet,
      ...summary.people.flatMap((who) => [who.name ?? '', who.address]),
    ]
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(filter.text.toLowerCase())) return false
  }
  return true
}

/** The message as a client sees it, with its body in whatever state it is in. */
function message(world: World, record: MessageRecord, pending: Op[], live: Live): Message {
  const me = world.accounts.get(record.accountId)?.address ?? ''
  const body = (): Body => {
    if (!record.body) return live.missingBody(record)
    if (record.body.kind === 'gone') return { state: 'unavailable', reason: 'gone' }
    const { text, html } = record.body.body
    return { state: 'ready', text, html, hasRemoteContent: html !== null && REMOTE_CONTENT.test(html) }
  }
  const attachments = record.body?.kind === 'body' ? record.body.body.attachments : []
  return {
    id: record.id,
    from: person(record.facts.from, me),
    to: record.facts.to.map((to) => person(to, me)),
    cc: record.facts.cc.map((cc) => person(cc, me)),
    sentAt: record.facts.sentAt,
    unread: viewState(record, pending).unread,
    body: body(),
    attachments: attachments.map(({ name, mime, size, inline }, index) => ({
      blobId: blobIdOf(record.id, index),
      name,
      mime,
      size,
      inline,
    })),
  }
}

/** Every mailbox with its message counts, as the user sees them. */
function mailboxes(world: World, pending: Op[], accountId: string | undefined): Mailbox[] {
  const counts = new Map<MailboxId, { total: number; unread: number }>()
  for (const record of world.messages.values()) {
    const state = viewState(record, pending)
    for (const id of state.mailboxes) {
      const count = counts.get(id) ?? { total: 0, unread: 0 }
      counts.set(id, { total: count.total + 1, unread: count.unread + (state.unread ? 1 : 0) })
    }
  }
  return [...world.mailboxes.values()]
    .filter((record) => accountId === undefined || record.accountId === accountId)
    .map((record) => ({
      id: record.id,
      accountId: record.accountId,
      name: record.name,
      role: record.role,
      parentId: record.parent ? (world.mailboxByRef.get(scoped(record.accountId, record.parent)) ?? null) : null,
      unread: counts.get(record.id)?.unread ?? 0,
      total: counts.get(record.id)?.total ?? 0,
    }))
}

const account = (record: AccountRecord, live: Live): Account => ({
  id: record.id,
  address: record.address,
  providerLabel: record.providerLabel,
  can: record.capabilities,
  status: live.status(record),
})

/** The current answer to one query, paired with the view it answers. */
export function evaluate(world: World, query: Query, live: Live): Update {
  const pending = pendingOps(world)
  switch (query.view) {
    case 'accounts':
      return { view: 'accounts', data: [...world.accounts.values()].map((record) => account(record, live)) }
    case 'sign-in-options':
      return { view: 'sign-in-options', data: live.options }
    case 'mailboxes':
      return { view: 'mailboxes', data: mailboxes(world, pending, query.accountId) }
    case 'threads': {
      const all = [...world.threads.keys()]
        .flatMap((id) => summarize(world, id, pending) ?? [])
        .filter((summary) => matches(summary, query.filter))
        .toSorted((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id))
      return {
        view: 'threads',
        data: { total: all.length, threads: all.slice(query.offset, query.offset + query.limit) },
      }
    }
    case 'thread': {
      const summary = summarize(world, query.threadId, pending)
      if (!summary) return { view: 'thread', data: null }
      const detail: ThreadDetail = {
        ...summary,
        messages: messagesOf(world, query.threadId).map((record) => message(world, record, pending, live)),
      }
      return { view: 'thread', data: detail }
    }
  }
}
