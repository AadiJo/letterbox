// Sending at the fake: users.messages.send, and the rfc822msgid: search a careful client
// runs before it sends again. The message goes through the labels mailbox's own `send`, so
// holding sends, refusing the next one, going offline and the call counts work as they do
// over the sim socket.
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send

import type { MessageRef } from '../adapter.ts'
import type { AnswerDamage } from '../contract.ts'
import type { MailboxEntry } from '../mailbox.ts'
import { withoutBcc } from '../sent.ts'
import { isRecord } from '../wire.ts'
import type { CallResult } from '../wire.ts'
import { type Failure, ask } from './modify.ts'

/** The status for a send the mailbox refused. */
const REFUSAL_STATUS = {
  'not-permitted': 403,
  'refused-by-provider': 400,
  'not-supported': 400,
  'unknown-target': 404,
  conflict: 409,
}

/**
 * Sends the base64url message in a messages.send body. Gmail reads the recipients from its
 * headers and delivers Bcc without the header. `threadId` must name a thread the account has.
 * 'dropped' when the account went offline while the send was held: the connection then
 * drops with no answer, as a send's does when the network fails after the request went out.
 */
export const send = async (
  entry: MailboxEntry,
  body: unknown,
  hasThread: (threadId: string) => boolean,
): Promise<{ ref: MessageRef; threadId: string | null; damage: AnswerDamage | null } | Failure | 'dropped'> => {
  const raw = isRecord(body) && typeof body.raw === 'string' ? body.raw : null
  if (raw === null) return { status: 400, message: "'raw' RFC822 payload message string required" }
  const threadId = isRecord(body) && typeof body.threadId === 'string' ? body.threadId : null
  if (threadId !== null && !hasThread(threadId)) return { status: 404, message: 'Requested entity was not found.' }
  const message = withoutBcc(Buffer.from(raw, 'base64url').toString('utf8'))
  const messageId = /^Message-ID:\s*<([^>]+)>/im.exec(message.raw)?.[1] ?? ''
  const arg = { raw: message.raw, bcc: message.bcc, messageId, replyTo: null }
  const { result, damage } = await new Promise<{ result: CallResult; damage: AnswerDamage | null }>((resolve) =>
    entry.respond({ method: 'send', arg }, (answer, how) => resolve({ result: answer, damage: how ?? null })),
  )
  if (result.method !== 'send') return { status: 503, message: 'Backend error' }
  if (!result.outcome.ok) return 'dropped'
  if (result.outcome.kind === 'refused')
    return { status: REFUSAL_STATUS[result.outcome.reason], message: result.outcome.reason }
  // The mailbox answers in the same process, so its answer is never lost.
  if (result.outcome.kind === 'unconfirmed') return { status: 503, message: 'Backend error' }
  return { ref: result.outcome.ref, threadId, damage }
}

/**
 * The search a `q` of "rfc822msgid:<id>" runs, through the mailbox's own `find`, so a lagging
 * or failing search works as it does over the sim socket. Null for any other query, and a
 * failure when the search fails.
 */
export const searchMessageId = async (entry: MailboxEntry, q: string): Promise<MessageRef[] | Failure | null> => {
  const id = /^rfc822msgid:<?([^>\s]+)>?$/.exec(q.trim())?.[1]
  if (id === undefined) return null
  const result = await ask(entry, { method: 'find', arg: id })
  if (result.method !== 'find' || !result.outcome.ok) return { status: 503, message: 'Backend error' }
  return result.outcome.ref === null ? [] : [result.outcome.ref]
}
