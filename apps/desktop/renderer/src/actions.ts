// What each toolbar button and shortcut does to a conversation, as a protocol command.
// Only commands the core already has are here. Reply and compose wait for the core.

import type { Account, Command, Mailbox, ThreadSummary } from '@letterbox/protocol'
import { client } from './core.ts'

/** The accounts and mailboxes an action needs to build its command. */
export type Mail = { accounts: readonly Account[]; mailboxes: readonly Mailbox[] }

const ALL = ['done', 'archive', 'trash', 'flag', 'unread'] as const

export type Action = (typeof ALL)[number]

/** The key that runs each action on the open conversation. */
export const SHORTCUTS = { done: 'd', archive: 'e', trash: '#', flag: 's', unread: 'u' } as const satisfies Record<
  Action,
  string
>

const byKey = new Map<string, Action>(ALL.map((action) => [SHORTCUTS[action], action]))

/** The action a key runs, if any. */
export const actionForKey = (key: string) => byKey.get(key)

/** Whether `action` takes the conversation out of the list it is in, so the selection moves on. */
export const removes = (action: Action) => action === 'archive' || action === 'trash'

/**
 * The command for `action` on `thread`, or null where the account cannot do it: read-only
 * access, a turn that is already nobody's, a conversation not in the inbox, or a folder
 * account with no Archive.
 */
export function commandFor(action: Action, thread: ThreadSummary, mail: Mail): Command | null {
  const account = mail.accounts.find((candidate) => candidate.id === thread.accountId)
  // set-turn never leaves the device, so it works with read-only access too.
  if (action === 'done') {
    return thread.turn.holder === 'none' ? null : { kind: 'set-turn', threadIds: [thread.id], turn: 'none' }
  }
  if (!account?.can.modify) return null
  const threadIds = [thread.id]
  switch (action) {
    case 'archive': {
      const own = mail.mailboxes.filter((mailbox) => mailbox.accountId === account.id)
      const inbox = own.find((mailbox) => mailbox.role === 'inbox')
      if (!inbox || !thread.mailboxIds.includes(inbox.id)) return null
      if (account.can.multipleMailboxes) return { kind: 'set-mailboxes', threadIds, add: [], remove: [inbox.id] }
      const archive = own.find((mailbox) => mailbox.role === 'archive')
      return archive ? { kind: 'set-mailboxes', threadIds, add: [archive.id], remove: [inbox.id] } : null
    }
    case 'trash':
      return { kind: 'trash', threadIds }
    case 'flag':
      return { kind: 'set-flags', threadIds, flagged: !thread.flagged }
    case 'unread':
      return { kind: 'set-flags', threadIds, unread: !thread.unread }
  }
}

/** Sends `action` for `thread` if the account allows it. Returns whether it went. */
export function run(action: Action, thread: ThreadSummary, mail: Mail) {
  const command = commandFor(action, thread, mail)
  // The lists and the reader follow the core's views, which show the change or its refusal.
  if (command) void client.command(command)
  return command !== null
}

/** Marks a conversation read when it opens, as Apple Mail does. */
export function markRead(thread: ThreadSummary, mail: Mail) {
  if (!thread.unread) return
  const account = mail.accounts.find((candidate) => candidate.id === thread.accountId)
  if (account?.can.modify) void client.command({ kind: 'set-flags', threadIds: [thread.id], unread: false })
}
