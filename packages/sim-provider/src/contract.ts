// The sim provider: a mail service that lives in the test process.
//
// It holds the ground truth for any number of mailboxes and lets a scenario
// change that truth the way another device or the provider itself would. The
// core reaches it through a local socket, the same way it will reach a real
// provider over the network, so a core restart does not lose the mail.
//
// Each mailbox speaks one of two dialects. They differ on purpose, in the ways
// real providers differ, so the adapter contract is tested against both.
//
//   labels   A message can sit in several mailboxes. Its ref never changes.
//            The cursor is a position in one change log for the whole account.
//            The log can be cut short, which expires older cursors.
//            Reports its own bulk verdict (`bulk` is true or false).
//
//   folders  A message sits in exactly one mailbox. Its ref names that mailbox
//            and a number inside it, so a move gives the message a new ref.
//            There is no change log. The cursor holds what the adapter saw last
//            in each mailbox, and `changes` works out the difference.
//            `expireCursors` resets every mailbox, which expires every cursor.
//            Gives no bulk verdict (`bulk` is null).
//
// server.ts runs the provider inside the harness. The core reaches it through the
// adapters in crates/sim-client. client.ts is a TypeScript twin of those adapters
// that the self-check uses to drive the server.

import type { AdapterFactory } from './adapter.ts'
import type { Mailbox, Time } from '@letterbox/protocol'

export type Dialect = 'labels' | 'folders'

export type SeedAddress = string | { name: string; address: string }

export type SeedMailbox = {
  /** The scenario's own name for this mailbox, for example "inbox". */
  key: string
  name: string
  role: Mailbox['role']
  /** Key of the parent mailbox. */
  parent?: string
}

export type SeedMessage = {
  /** The scenario's own name for this message, for example "invoice-1". */
  key: string
  /** Mailbox keys. The folders dialect accepts exactly one. */
  mailboxes: string[]
  from: SeedAddress
  to: SeedAddress[]
  cc?: SeedAddress[]
  subject: string
  text: string
  html?: string
  sentAt: Time
  /** Defaults to true. */
  unread?: boolean
  /** Defaults to false. */
  flagged?: boolean
  /** Defaults to "<key>@sim.test". */
  messageId?: string
  /** Keys of earlier messages this one answers, oldest first. */
  replyTo?: string[]
  headers?: { listUnsubscribe?: boolean; listId?: boolean; precedence?: string; autoSubmitted?: string }
  /** The provider's own bulk verdict. Only the labels dialect reports it. Defaults to false. */
  bulk?: boolean
  /** Its attachments: a number of placeholder files, or files as named. Defaults to 0. */
  attachments?: number | readonly SeedAttachment[]
}

/** One attachment a seed names, as a mail client would show it. */
export type SeedAttachment = { name: string; mime: string; size: number }

export type Seed = {
  /** The address the mailbox belongs to. Also the sign-in username. */
  address: string
  password: string
  /** False makes the account read-only: `capabilities.modify` is false. Defaults to true. */
  canModify?: boolean
  /** Messages per snapshot page, newest first. Defaults to 50. Small values exercise paging. */
  pageSize?: number
  mailboxes: SeedMailbox[]
  messages: SeedMessage[]
}

/** What the provider holds for one message right now, in the scenario's own keys. */
export type TruthMessage = { key: string; mailboxes: string[]; unread: boolean; flagged: boolean }

/** How many times the core called each adapter method on this mailbox. */
export type CallCounts = {
  snapshot: number
  changes: number
  body: number
  apply: number
  send: number
  find: number
}

/**
 * How the answer to a send or an apply the provider carried out can go wrong on its way back:
 * the connection drops before any answer (over HTTP, a send's after the status line, an
 * apply's before it), the answer is cut off halfway, or it arrives whole but is not JSON.
 */
export type AnswerDamage = 'disconnect' | 'truncated' | 'invalid-json'

/** One message the core sent through this mailbox, as the provider delivered it. */
export type SentCopy = {
  /** The key of the copy in the Sent mailbox, "sent-<n>" in the order they arrived. */
  key: string
  /** Every address it went to: To, Cc and Bcc. */
  recipients: string[]
  /** The message as the provider got it. */
  raw: string
}

/** One mailbox at the sim provider, as a scenario drives it. Every method takes effect at once. */
export interface SimMailbox {
  readonly address: string
  readonly dialect: Dialect

  // Things another device does.
  deliver(message: SeedMessage): void
  setFlags(key: string, flags: { unread?: boolean; flagged?: boolean }): void
  /** Takes the message out of every mailbox it is in and puts it in one. */
  move(key: string, toMailbox: string): void
  /** Labels dialect only. Throws on folders. */
  addToMailbox(key: string, mailbox: string): void
  /** Labels dialect only. Throws on folders. */
  removeFromMailbox(key: string, mailbox: string): void
  /** Removes the message for good. */
  expunge(key: string): void
  createMailbox(mailbox: SeedMailbox): void
  /** Deletes a mailbox. With labels, every message in it loses it. With folders it must be empty. */
  deleteMailbox(key: string): void

  // Things the provider does.
  /** Every cursor handed out so far stops working. `changes` answers cursor-expired. */
  expireCursors(): void
  /** Every snapshot page token handed out so far stops working. `snapshot` answers page-expired. */
  expirePageTokens(): void
  /** While true, every adapter call answers `offline`. */
  setOffline(offline: boolean): void
  /** The next `apply` answers refused with this reason and changes nothing. */
  refuseNextApply(reason: 'conflict' | 'refused-by-provider'): void
  /** The next `send` answers refused with this reason and delivers nothing. */
  refuseNextSend(reason: 'not-permitted' | 'refused-by-provider'): void
  /** The next `send` delivers the message, then its answer reaches the core damaged this way. */
  damageNextSendAnswer(how: AnswerDamage): void
  /** The next `apply` changes the mailbox, then its answer reaches the core damaged this way. */
  damageNextApplyAnswer(how: AnswerDamage): void
  /** The next `find` fails, as a provider's search does when it is briefly down. */
  failNextFind(): void
  /** While true, `find` finds nothing, as a provider's search does before its index catches up. */
  setSearchLag(lagging: boolean): void
  /** From now on, body calls wait. Lets a scenario change the mailbox while a fetch is in flight. */
  holdBodies(): void
  /** Answers every waiting body call, from the truth as it is now, and stops holding. */
  releaseBodies(): void
  /** From now on, apply calls wait and change nothing. Lets a scenario sign out while a push is in flight. */
  holdApplies(): void
  /** Resolves once an apply call is waiting, at once if one already is. */
  applyHeld(): Promise<void>
  /** Applies and answers every waiting apply call, in the order they came, and stops holding. */
  releaseApplies(): void
  /** From now on, snapshot calls wait. Lets a scenario stop a backfill at a known page. */
  holdSnapshots(): void
  /** Resolves once a snapshot call is waiting, at once if one already is. */
  snapshotHeld(): Promise<void>
  /** Answers every waiting snapshot call, from the truth as it is now, and stops holding. */
  releaseSnapshots(): void
  /** From now on, send calls wait and deliver nothing. Lets a scenario stop a core in the middle of a send. */
  holdSends(): void
  /** Resolves once `count` send calls (1 unless given) are waiting, at once if they already are. */
  sendHeld(count?: number): Promise<void>
  /** Delivers and answers every waiting send call, in the order they came, and stops holding. */
  releaseSends(): void

  // What a scenario checks.
  truth(): TruthMessage[]
  calls(): CallCounts
  /** Every message the core sent, in the order the provider delivered them. */
  sent(): SentCopy[]
}

/** A pending sim oauth attempt, named by the url the core was told to open. */
export interface SimProvider {
  /** The socket the core connects to. Passed to `simAdapterFactories`. */
  readonly socketPath: string
  createMailbox(dialect: Dialect, seed: Seed): SimMailbox
  /** Finishes the oauth attempt behind `url` as the owner of `address`. */
  approveSignIn(url: string, address: string): void
  /** Finishes the oauth attempt behind `url` with a refusal. */
  denySignIn(url: string): void
  /** Every ref, cursor, page token and session string this provider gave the core. None may reach a UI. */
  handedOut(): ReadonlySet<string>
  /** The session strings among `handedOut`. The core keeps these in its secret store, never in its own store. */
  sessions(): ReadonlySet<string>
  close(): Promise<void>
}

/** Starts the provider on a new socket at `socketPath`. Exported from server.ts. */
export type StartSimProvider = (socketPath: string) => Promise<SimProvider>

/**
 * The sign-in options the core offers when it runs against the sim provider.
 * Made by client.ts here and by crates/sim-client for the core. Two factories, in this order:
 *   id "sim-password", method password: username is the address, password must match the seed.
 *   id "sim-oauth", method oauth: calls `openUrl`, then waits for approveSignIn or denySignIn.
 * The provider label is "Sim labels" or "Sim folders", by the mailbox's dialect.
 */
export type SimAdapterFactories = (socketPath: string) => AdapterFactory[]
