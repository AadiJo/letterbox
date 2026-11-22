// What each toolbar button and shortcut does to a conversation, as a protocol command.
// Replies, new messages and forwards go through drafts.ts and sending.ts.

import type { Account, Command, Mailbox, MailboxId, ThreadSummary } from '@letterbox/protocol'
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

/** The key that opens a reply to the open conversation. With Shift, Reply all. */
export const REPLY_KEY = 'r'

/** The key that forwards the open conversation's newest message, on the compose page. */
export const FORWARD_KEY = 'f'

/** The key that starts a new message, on the compose page. */
export const COMPOSE_KEY = 'c'

/** Whether the account can send a reply in `thread` at all. */
export function canReply(thread: ThreadSummary, mail: Mail) {
  const account = mail.accounts.find((candidate) => candidate.id === thread.accountId)
  return account !== undefined && account.can.send && account.can.modify
}

const byKey = new Map<string, Action>(ALL.map((action) => [SHORTCUTS[action], action]))

/** The action a key runs, if any. */
export const actionForKey = (key: string) => byKey.get(key)

/**
 * Whether `command` takes a conversation out of the mailbox `mailboxId`, as the core does it.
 * Set-mailboxes takes it out of each one it removes. Trash moves it out of every mailbox but
 * Trash, except on a labels account, where it keeps Sent and Drafts, which the provider sets.
 */
export function leavesMailbox(command: Command, mailboxId: MailboxId, mail: Mail) {
  if (command.kind === 'set-mailboxes') return command.remove.includes(mailboxId)
  if (command.kind !== 'trash') return false
  const mailbox = mail.mailboxes.find((candidate) => candidate.id === mailboxId)
  const account = mail.accounts.find((candidate) => candidate.id === mailbox?.accountId)
  const kept: (Mailbox['role'] | undefined)[] = account?.can.multipleMailboxes ? ['trash', 'sent', 'drafts'] : ['trash']
  return !kept.includes(mailbox?.role)
}

/**
 * The command for `action` on `thread`, or null where the account cannot do it: read-only
 * access, a turn that is already nobody's, a conversation not in the inbox, a folder
 * account with no Archive, or an account with no Trash.
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
    case 'trash': {
      // The core moves trashed mail to the account's Trash. An account without one cannot trash.
      const trash = mail.mailboxes.some((mailbox) => mailbox.accountId === account.id && mailbox.role === 'trash')
      return trash ? { kind: 'trash', threadIds } : null
    }
    case 'flag':
      return { kind: 'set-flags', threadIds, flagged: !thread.flagged }
    case 'unread':
      return { kind: 'set-flags', threadIds, unread: !thread.unread }
  }
}

/**
 * Sends `command` and resolves with the change the core accepted it as, or with null when the
 * core refuses or is gone. The lists and the reader follow the core's views, which show the
 * change or its refusal.
 */
export async function send(command: Command) {
  const answer = await client.command(command).catch(() => null)
  return answer?.kind === 'accepted' ? answer.change : null
}

/**
 * Sends `action` for `thread` if the account allows it. Resolves with the command and the
 * change the core accepted it as, or null when the account cannot do it, the core refuses,
 * or the core is gone.
 */
export async function run(action: Action, thread: ThreadSummary, mail: Mail) {
  const command = commandFor(action, thread, mail)
  const change = command ? await send(command) : null
  return command && change ? { command, change } : null
}

/** Marks a conversation read when it opens, as Apple Mail does. With the core gone, nothing happens. */
export function markRead(thread: ThreadSummary, mail: Mail) {
  if (!thread.unread) return
  const account = mail.accounts.find((candidate) => candidate.id === thread.accountId)
  if (account?.can.modify) void send({ kind: 'set-flags', threadIds: [thread.id], unread: false })
}
