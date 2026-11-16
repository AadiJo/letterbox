// The steps the undo scenarios share: every kind of change a user can undo, made on one
// conversation, and what "exactly as before" compares.

import type { Command, ThreadSummary } from '@letterbox/protocol'
import type { Dialect, Seed, SimMailbox } from '@letterbox/sim-provider/contract'
import type { CoreClient } from './client.ts'
import { ME, mailbox, standardSeed, thread } from './fixtures.ts'
import type { Scenario } from './scenario.ts'

/** Ben's question in the standard seed: in Inbox, unread, not flagged, and my turn. */
export const TARGET = 'Can you review the draft?'

/** One kind of change, as a user makes it on a conversation. */
export type Kind = {
  name: string
  /** True for a change that never leaves the device. */
  local: boolean
  command: (core: CoreClient, t: Scenario, row: ThreadSummary) => Promise<Command>
}

const inbox = (core: CoreClient) => mailbox(core, 'Inbox').then((found) => found.id)

/** Every kind of change undo takes back. */
export const KINDS: Kind[] = [
  {
    name: 'archive',
    local: false,
    command: async (core, _, row) => ({
      kind: 'set-mailboxes',
      threadIds: [row.id],
      add: [],
      remove: [await inbox(core)],
    }),
  },
  { name: 'trash', local: false, command: async (_, __, row) => ({ kind: 'trash', threadIds: [row.id] }) },
  {
    // A label added, or on plain folders, a move to one.
    name: 'label',
    local: false,
    command: async (core, t, row) => ({
      kind: 'set-mailboxes',
      threadIds: [row.id],
      add: [(await mailbox(core, 'Projects')).id],
      remove: t.dialect === 'labels' ? [] : [await inbox(core)],
    }),
  },
  {
    name: 'read',
    local: false,
    command: async (_, __, row) => ({ kind: 'set-flags', threadIds: [row.id], unread: false }),
  },
  {
    name: 'flag',
    local: false,
    command: async (_, __, row) => ({ kind: 'set-flags', threadIds: [row.id], flagged: true }),
  },
  {
    name: 'done',
    local: true,
    command: async (_, __, row) => ({ kind: 'set-turn', threadIds: [row.id], turn: 'none' }),
  },
]

/** What the provider holds for every message, so a scenario can compare all of it. */
export const allTruth = (box: SimMailbox) => box.truth().toSorted((a, b) => a.key.localeCompare(b.key))

/** The target's row as the core shows it. */
export const targetRow = (core: CoreClient) => thread(core, TARGET)

/** Sends `command` and fails the scenario unless the core accepts it. Resolves with its change. */
export async function accept(t: Scenario, core: CoreClient, command: Command, what: string) {
  const answer = await core.command(command)
  t.equal(answer.kind, 'accepted', `${what} is accepted`)
  return answer.change
}

/**
 * The standard seed, with a third message in the lunch conversation that is already archived:
 * Ana's thanks. The conversation then holds one message in Inbox, one in Sent and one archived.
 */
export function lunchSeed(dialect: Dialect): Seed {
  const standard = standardSeed(dialect)
  const thanks = {
    key: 'lunch-thanks',
    mailboxes: dialect === 'labels' ? [] : ['archive'],
    from: { name: 'Ana', address: 'ana@example.com' },
    to: [ME],
    subject: 'Re: Lunch on Friday?',
    text: 'Great, see you then.',
    sentAt: '2025-12-01T11:00:00.000Z',
    unread: false,
    replyTo: ['lunch-ask', 'lunch-answer'],
  }
  return { ...standard, messages: [...standard.messages, thanks] }
}
