// Changing labels at the fake: one users.messages.modify or batchModify body becomes
// at most two applies on the labels mailbox, one for the flags and one for the mailboxes.

import type { MessageRef, Mutation } from '../adapter.ts'
import type { AnswerDamage } from '../contract.ts'
import type { MailboxEntry } from '../mailbox.ts'
import { isRecord } from '../wire.ts'
import type { Call, CallResult } from '../wire.ts'
import { EXTRA_SYSTEM_LABELS, mailboxRefsOf } from './shapes.ts'

/** Why a call failed, as the HTTP status and message to answer with. */
export type Failure = { status: number; message: string }

/** The strings in a JSON request body's list field. */
export const strings = (body: unknown, key: string): string[] => {
  const value = isRecord(body) ? body[key] : undefined
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Parses a JSON request body. An empty or broken one reads as no fields. */
export const parse = (body: string): unknown => {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/** Asks a mailbox one adapter call and waits for its answer, which may be held. */
export const ask = (entry: MailboxEntry, call: Call): Promise<CallResult> =>
  new Promise((resolve) => entry.respond(call, resolve))

/** The status for an apply the mailbox refused. */
const REFUSAL_STATUS = {
  'unknown-target': 404,
  'unknown-mailbox': 400,
  'not-permitted': 403,
  conflict: 409,
  'refused-by-provider': 400,
  'not-supported': 400,
}

/** The most labels one modify or batchModify body may add, and the most it may remove. */
const LABEL_LIMIT = 100

/** A modify the mailbox carried out, and how its answer goes wrong on the way back, if it does. */
export type Modified = { damage: AnswerDamage | null }

/** Applies the mutations in order and stops at the first that fails. */
const applyAll = async (
  entry: MailboxEntry,
  mutations: Mutation[],
  damage: AnswerDamage | null = null,
): Promise<Failure | Modified> => {
  const [first, ...rest] = mutations
  if (first === undefined) return { damage }
  const { result, how } = await new Promise<{ result: CallResult; how: AnswerDamage | null }>((resolve) =>
    entry.respond({ method: 'apply', arg: first }, (answer, damaged) =>
      resolve({ result: answer, how: damaged ?? null }),
    ),
  )
  if (result.method !== 'apply' || !result.outcome.ok) return { status: 503, message: 'Backend error' }
  if (result.outcome.kind === 'refused')
    return { status: REFUSAL_STATUS[result.outcome.reason], message: result.outcome.reason }
  return applyAll(entry, rest, damage ?? how)
}

/** Applies one modify body to `refs`. */
export const modify = (entry: MailboxEntry, refs: MessageRef[], body: unknown): Promise<Failure | Modified> => {
  const add = strings(body, 'addLabelIds')
  const remove = strings(body, 'removeLabelIds')
  // "You can add up to 100 labels with each update", and the same for removing.
  // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify
  if (add.length > LABEL_LIMIT || remove.length > LABEL_LIMIT)
    return Promise.resolve({ status: 400, message: `At most ${LABEL_LIMIT} labels can be added or removed at once` })
  const isBox = (id: string) => mailboxRefsOf(entry.store, [id]) !== null
  const known = (id: string) => isBox(id) || EXTRA_SYSTEM_LABELS.some((extra) => extra === id)
  const bad = [...add, ...remove].find((id) => !known(id) || id === 'SENT' || id === 'DRAFT')
  if (bad !== undefined) return Promise.resolve({ status: 400, message: `Invalid label: ${bad}` })
  const flag = (label: string) => (add.includes(label) ? true : remove.includes(label) ? false : undefined)
  const unread = flag('UNREAD')
  const flagged = flag('STARRED')
  // Importance, chat and the inbox tabs are not modelled. Changing them changes nothing here.
  const boxes = {
    add: mailboxRefsOf(entry.store, add.filter(isBox)) ?? [],
    remove: mailboxRefsOf(entry.store, remove.filter(isBox)) ?? [],
  }
  const mutations: Mutation[] = []
  if (unread !== undefined || flagged !== undefined)
    mutations.push({
      kind: 'flags',
      refs,
      ...(unread === undefined ? {} : { unread }),
      ...(flagged === undefined ? {} : { flagged }),
    })
  if (boxes.add.length > 0 || boxes.remove.length > 0) mutations.push({ kind: 'mailboxes', refs, ...boxes })
  return applyAll(entry, mutations)
}
