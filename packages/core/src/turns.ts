// Whose turn is it in a conversation? This is the rule the product is built on.
// It reads only facts every provider can supply, so it gives the same answer
// for the same mail wherever that mail lives.
//
// The rule here is one candidate. It still has to be measured against real
// mail before anything is built on top of it.

import type { Turn, TurnReason } from '@letterbox/protocol'
import type { RemoteFacts } from './adapter.ts'

/** What the rule reads from one message. */
export type TurnMessage = {
  fromMe: boolean
  /** True when I am one of the people the message is addressed to, not only copied. */
  toMe: boolean
  toAddresses: string[]
  automated: boolean
}

const NO_REPLY = /\b(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounces?)\b[^@]*@/i

/** True when a machine sent the message: its own headers say so, its address does, or the provider does. */
export const isAutomated = (facts: RemoteFacts) =>
  facts.bulk === true ||
  facts.headers.listUnsubscribe ||
  facts.headers.listId ||
  /bulk|list|junk/i.test(facts.headers.precedence) ||
  (facts.headers.autoSubmitted !== '' && facts.headers.autoSubmitted.toLowerCase() !== 'no') ||
  NO_REPLY.test(facts.from.address)

/**
 * Decides the turn for one conversation. `messages` is oldest first.
 * The last person to write holds the turn until the other answers. Mail from
 * machines and mail I am only copied on are nobody's turn.
 */
export function decideTurn(messages: TurnMessage[], override: Turn | null): { holder: Turn; reason: TurnReason } {
  if (override) return { holder: override, reason: 'set-by-user' }
  const last = messages.at(-1)
  if (!last) return { holder: 'none', reason: 'automated' }

  if (last.fromMe) {
    // I wrote last. I am only waiting if a person could answer.
    const lastFromThem = messages.findLast((message) => !message.fromMe)
    const toMachine = last.toAddresses.some((address) => NO_REPLY.test(address))
    if (toMachine || lastFromThem?.automated) return { holder: 'none', reason: 'automated' }
    return { holder: 'theirs', reason: 'i-wrote-last' }
  }
  if (last.automated) return { holder: 'none', reason: 'automated' }
  if (!last.toMe) return { holder: 'none', reason: 'not-addressed-to-me' }
  return { holder: 'mine', reason: 'they-wrote-last' }
}
