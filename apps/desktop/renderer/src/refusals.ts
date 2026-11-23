// Why the core refused a send, in words, for the editor that sent it and for a message marked Not sent.

import type { Refusal } from '@letterbox/protocol'
import type { Reply } from './drafts.ts'

/** Why a reply did not go, in words, for the editor and for a message marked Not sent. */
export const REFUSALS = {
  'not-permitted': 'This account is not allowed to send right now.',
  'not-supported': 'This account cannot send mail.',
  'unknown-target': 'The message it answers is no longer here.',
  conflict: 'Another change to this conversation got in the way.',
  'refused-by-provider': 'The mail server refused it.',
  invalid: 'An address or the subject is not one the core can send.',
  unconfirmed: 'It may not have been sent. Check Sent before sending again.',
  // Only an unsubscribe's one-click URL fails this way, never a send.
  'not-public': 'Its address is not on the public internet.',
  // Only an unsubscribe is refused this way (`refusalFor` in unsubscribe.ts names the sender).
  'already-unsubscribed': 'You’ve already unsubscribed from this sender.',
} as const satisfies Record<Refusal, string>

/** Why the core refused `reply`, in words. A forward names its original where the reply would name the message it answers. */
export const refusal = (reply: Reply, reason: Refusal) =>
  reply.forward ? (FORWARD_REFUSALS[reason] ?? REFUSALS[reason]) : REFUSALS[reason]

const FORWARD_REFUSALS: Partial<Record<Refusal, string>> = {
  'unknown-target': 'The message it forwards is no longer here.',
  conflict: 'The message it forwards has not loaded yet. Try again in a moment.',
}
