// The steps the send scenarios share: a reply to Ben's question, and a start with core options.

import type { AccountId, Draft, Message, MessageId, ThreadDetail, ThreadId } from '@letterbox/protocol'
import type { CoreClient } from './client.ts'
import { ME, PASSWORD, readThread, signIn, standardSeed, sync, thread } from './fixtures.ts'
import type { CoreOptions, Scenario } from './scenario.ts'

/** The subject of Ben's question in the standard seed. It is my turn there. */
export const ASKED = 'Can you review the draft?'

/** A reply from me to Ben's question, or a new message when `inReplyTo` is null. */
export const draft = (accountId: AccountId, inReplyTo: MessageId | null, more: Partial<Draft> = {}): Draft => ({
  accountId,
  to: ['ben@example.com'],
  cc: [],
  bcc: [],
  subject: `Re: ${ASKED}`,
  text: 'Yes, I will look at it tomorrow.\n> Can you review the draft before Thursday?',
  html: null,
  inReplyTo,
  ...more,
})

/** The usual start (see `start` in fixtures.ts), with the core's options. */
export async function startWith(t: Scenario, options: CoreOptions) {
  const box = t.mailbox(standardSeed(t.dialect))
  const core = t.startCore(options)
  await core.hello()
  const accountId = await signIn(t, core, ME, PASSWORD)
  await sync(core)
  return { core, box, accountId }
}

/** The question Ben asked, and its conversation. */
export async function asked(core: CoreClient): Promise<{ threadId: ThreadId; question: Message }> {
  const row = await thread(core, ASKED)
  const question = (await readThread(core, row.id))?.messages[0]
  if (!question) throw new Error('the question has no message')
  return { threadId: row.id, question }
}

/** The ids of a conversation's messages, oldest first. */
export const idsOf = (detail: ThreadDetail | null | undefined) => detail?.messages.map((message) => message.id)
