// Replies being written: one draft per conversation, kept for the session as the user moves
// between conversations and screens. The composer reads and edits its draft here, and
// sending.ts takes it from here when it goes. Nothing else holds a draft.

import type {
  AccountId,
  ChangeId,
  Draft,
  Message,
  MessageId,
  Person,
  ThreadDetail,
  ThreadId,
} from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'

/** One person on the To, Cc or Bcc line. `name` is only for the chip. The core gets the address. */
export type Recipient = { address: string; name: string | null }

export type Field = 'to' | 'cc' | 'bcc'

/** The reply as the user has it so far. `typing` is what each address line holds that is not a chip yet. */
export type Reply = {
  accountId: AccountId
  /** The message being answered. */
  inReplyTo: MessageId
  /** Already "Re: …". The composer does not show it. */
  subject: string
  to: readonly Recipient[]
  cc: readonly Recipient[]
  bcc: readonly Recipient[]
  typing: Readonly<Record<Field, string>>
  text: string
  /**
   * True for a reply rebuilt from its message, which keeps no Bcc, until the user confirms the
   * people on it. Until then it cannot be sent (`check`), so hidden recipients are never dropped unseen.
   */
  bccLost: boolean
}

/** What stops a reply going, and where to say so: under an address line, or beside Send for the core's refusal. */
export type Problem = { at: Field | 'send'; text: string }

/**
 * A conversation's draft. `open` shows the docked editor and `collapsed` the bar under the
 * thread. `submitting` waits for the core's answer to Send under `change`. `checking` lost
 * that answer: the core may hold the reply, so it cannot be sent again, only asked about
 * under the same change (sending.ts). Once the core accepts, the draft goes and sending.ts
 * owns the reply.
 */
export type Composer =
  | { state: 'open' | 'collapsed'; reply: Reply; extra: boolean; problem: Problem | null }
  | { state: 'submitting' | 'checking'; reply: Reply; extra: boolean; change: ChangeId }

/** True while the draft waits on the core, and must not change or go again. */
export const isBusy = (
  composer: Composer | undefined,
): composer is Extract<Composer, { state: 'submitting' | 'checking' }> =>
  composer?.state === 'submitting' || composer?.state === 'checking'

const drafts = new Map<ThreadId, Composer>()
const watchers = new Set<() => void>()

const set = (id: ThreadId, next: Composer | null) => {
  if (next) drafts.set(id, next)
  else drafts.delete(id)
  watchers.forEach((watcher) => watcher())
}

const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  return () => void watchers.delete(onChange)
}

/** The draft for a conversation, or undefined when it has none. */
export function useComposer(id: ThreadId) {
  return useSyncExternalStore(subscribe, () => drafts.get(id))
}

/** The same, read once, for an event handler. */
export const composerFor = (id: ThreadId) => drafts.get(id)

/** The conversation whose editor the user just opened, until the editor takes it. */
let opening: ThreadId | null = null

/**
 * True once after the user opened `id`'s editor, by Reply, R, undo or a retry. The editor
 * slides in and takes focus only then, not when it reappears as the user moves between conversations.
 */
export function takeOpening(id: ThreadId) {
  if (opening !== id) return false
  opening = null
  return true
}

const recipient = (person: Person): Recipient => ({ address: person.address, name: person.name })

const sameAddress = (a: Recipient, b: Recipient) => a.address.toLowerCase() === b.address.toLowerCase()

/** `people` without the user, anyone in `except`, and repeats. */
function others(people: readonly Person[], except: readonly Recipient[]) {
  const kept: Recipient[] = []
  for (const person of people) {
    const candidate = recipient(person)
    if (person.isMe || [...except, ...kept].some((other) => sameAddress(other, candidate))) continue
    kept.push(candidate)
  }
  return kept
}

/** "Re: " once, and no line breaks, which a subject header cannot hold. */
const replySubject = (subject: string) => {
  const flat = subject.replace(/[\r\n]+/g, ' ').trim()
  return /^re:/i.test(flat) ? flat : `Re: ${flat}`
}

/**
 * Who a reply answers, among `messages`: the newest from someone else. In a conversation the
 * user alone wrote, their newest message, so the reply goes to the same people again.
 */
function answering(messages: readonly Message[]) {
  const theirs = messages.findLast((message) => !message.from.isMe)
  if (theirs) return { message: theirs, to: others([theirs.from], []) }
  const mine = messages.at(-1)
  return mine && { message: mine, to: others(mine.to, []) }
}

const EMPTY_TYPING = { to: '', cc: '', bcc: '' } as const

/**
 * A new reply to `thread`. Reply goes to the sender of the newest message from someone else.
 * Reply all copies everyone else on that message, never the user. With `before`, only messages
 * older than it count. Null when no message does.
 */
export function newReply(thread: ThreadDetail, all: boolean, before?: Message): Reply | null {
  const index = before ? thread.messages.indexOf(before) : -1
  const found = answering(index === -1 ? thread.messages : thread.messages.slice(0, index))
  if (!found) return null
  const { message, to } = found
  return {
    accountId: thread.accountId,
    inReplyTo: message.id,
    subject: replySubject(thread.subject),
    to,
    cc: all ? others([...message.to, ...message.cc], to) : [],
    bcc: [],
    typing: EMPTY_TYPING,
    bccLost: false,
    text: '',
  }
}

/**
 * Opens the editor on `thread`'s draft, starting one if there is none. Reply all on a draft
 * that exists adds the people it lacks to Cc and keeps everything the user wrote.
 */
export function openReply(thread: ThreadDetail, all: boolean) {
  const current = drafts.get(thread.id)
  if (isBusy(current)) return
  const fresh = newReply(thread, all)
  if (!current && !fresh) return
  opening = thread.id
  if (!current) {
    if (fresh) set(thread.id, { state: 'open', reply: fresh, extra: fresh.cc.length > 0, problem: null })
    return
  }
  const { reply } = current
  const cc =
    all && fresh
      ? [...reply.cc, ...fresh.cc.filter((add) => ![...reply.to, ...reply.cc].some((had) => sameAddress(had, add)))]
      : reply.cc
  set(thread.id, { ...current, state: 'open', reply: { ...reply, cc }, extra: current.extra || cc.length > 0 })
}

/**
 * Puts one reply back in the editor, exactly as it was: its people, its text and the message
 * it answers, as after an undo or for "Edit and send again". A conversation holds at most one
 * reply on its way (sending.ts), so nothing else is there to merge with or lose.
 */
export function restore(id: ThreadId, reply: Reply) {
  if (isBusy(drafts.get(id))) return
  opening = id
  set(id, { state: 'open', reply, extra: reply.cc.length > 0 || reply.bcc.length > 0, problem: null })
}

/** Changes the open draft. Any problem shown goes, since the user is fixing it. */
export function edit(id: ThreadId, change: (reply: Reply) => Reply) {
  const current = drafts.get(id)
  if (current?.state !== 'open') return
  set(id, { ...current, reply: change(current.reply), problem: null })
}

/** The user has looked at the recipients of a reply rebuilt without its Bcc, so it can be sent. */
export function confirmBcc(id: ThreadId) {
  edit(id, (reply) => ({ ...reply, bccLost: false }))
  showExtra(id)
}

/** Opens the editor on the draft with `text` beside Send, to say why something it asked for cannot happen yet. */
export function refuse(id: ThreadId, text: string) {
  const current = drafts.get(id)
  if (current?.state !== 'open' && current?.state !== 'collapsed') return
  opening = id
  set(id, { ...current, state: 'open', problem: { at: 'send', text } })
}

/** Shows the Cc and Bcc lines. */
export function showExtra(id: ThreadId) {
  const current = drafts.get(id)
  if (current?.state === 'open') set(id, { ...current, extra: true })
}

/** Folds the editor to the bar under the thread, keeping the draft. Esc does this. */
export function collapse(id: ThreadId) {
  const current = drafts.get(id)
  if (current?.state === 'open') set(id, { ...current, state: 'collapsed' })
}

/** Throws the draft away. Discard asks nothing. */
export const discard = (id: ThreadId) => set(id, null)

/** Shows why the draft cannot go, with `reply` as Send left it. */
export function flag(id: ThreadId, reply: Reply, problem: Problem) {
  const current = drafts.get(id)
  if (current?.state === 'open') set(id, { ...current, reply, problem })
}

/** Marks the open draft as handed to the core under `change`. Only sending.ts calls this, and then `settle`. */
export function submit(id: ThreadId, reply: Reply, change: ChangeId) {
  const current = drafts.get(id)
  if (current?.state === 'open') set(id, { state: 'submitting', reply, extra: current.extra, change })
}

/**
 * Marks `reply` as sent under `change` with no answer known: the answer was lost, or this is
 * a reload asking again. Only sending.ts calls this, and `settle` once the core says.
 */
export function unsure(id: ThreadId, reply: Reply, change: ChangeId) {
  const current = drafts.get(id)
  set(id, { state: 'checking', reply, extra: current?.extra ?? reply.cc.length + reply.bcc.length > 0, change })
}

/** Ends a submit or a check: the core accepted it, so the draft goes, or it did not, so the editor shows why. */
export function settle(id: ThreadId, problem: Problem | null) {
  const current = drafts.get(id)
  if (!isBusy(current)) return
  set(id, problem ? { state: 'open', reply: current.reply, extra: current.extra, problem } : null)
}

/**
 * A reply saying again what `message`, one of the user's that was not sent, said: to the same
 * people, answering the message before it. Bcc is not kept on a message, so it starts empty
 * and marked `bccLost` until the user confirms the recipients.
 */
export function replyFrom(thread: ThreadDetail, message: Message): Reply | null {
  const base = newReply(thread, false, message)
  if (!base) return null
  const text = message.body.state === 'ready' ? message.body.text : ''
  return { ...base, to: message.to.map(recipient), cc: message.cc.map(recipient), text, bccLost: true }
}

/** `reply` with whatever was typed on each address line turned into chips. */
export function commitTyping(reply: Reply, only?: Field): Reply {
  const fields = only ? [only] : (['to', 'cc', 'bcc'] as const)
  const next = { ...reply, typing: { ...reply.typing } }
  for (const field of fields) {
    next[field] = [...reply[field], ...parseRecipients(reply.typing[field])]
    next.typing[field] = ''
  }
  return next
}

// Addresses. The core sends only to bare ASCII addresses (crates/core/src/mime.rs,
// `is_plain_address`) and refuses anything else as `invalid`. These rules are the same, so
// the editor can say what is wrong on the line itself before anything is sent.

const FORBIDDEN = /[<>()[\]\\,;:"@]/

/** True for an address the core will send to, such as "ana@example.com". */
export function isPlainAddress(address: string) {
  if (address.length > 254) return false
  const at = address.indexOf('@')
  if (at <= 0 || at === address.length - 1) return false
  const parts = [address.slice(0, at), address.slice(at + 1)]
  return parts.every((part) => /^[!-~]+$/.test(part) && !FORBIDDEN.test(part))
}

/**
 * The recipients in what the user typed or pasted on an address line: addresses split by
 * commas, semicolons, spaces or line breaks. "Maya Lindqvist <maya@example.com>" becomes a chip
 * named Maya Lindqvist, since the core takes the bare address only.
 */
export function parseRecipients(text: string): Recipient[] {
  const named = /([^<>,;]*)<([^<>]*)>/g
  const found: Recipient[] = []
  const rest = text.replace(named, (_, name: string, address: string) => {
    found.push({ address: address.trim(), name: name.trim().replace(/^"|"$/g, '') || null })
    return ' '
  })
  for (const address of rest.split(/[\s,;]+/)) if (address !== '') found.push({ address, name: null })
  return found
}

/** The draft for the core, or the first problem with it. Text still being typed on a line counts as its recipients. */
export function check(reply: Reply): { draft: Draft } | { problem: Problem } {
  if (reply.bccLost) return { problem: { at: 'send', text: "Check the recipients first: Bcc wasn't kept." } }
  const lines = {
    to: [...reply.to, ...parseRecipients(reply.typing.to)],
    cc: [...reply.cc, ...parseRecipients(reply.typing.cc)],
    bcc: [...reply.bcc, ...parseRecipients(reply.typing.bcc)],
  } satisfies Record<Field, Recipient[]>
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const bad = lines[field].find((person) => !isPlainAddress(person.address))
    if (!bad) continue
    const text = `"${bad.address}" is not an address Letterbox can send to. Use a plain address, like name@example.com.`
    return { problem: { at: field, text } }
  }
  const addresses = (field: Field) => lines[field].map((person) => person.address)
  const [to, cc, bcc] = [addresses('to'), addresses('cc'), addresses('bcc')]
  if (to.length + cc.length + bcc.length === 0) return { problem: { at: 'to', text: 'Add someone to send this to.' } }
  return {
    draft: {
      accountId: reply.accountId,
      to,
      cc,
      bcc,
      subject: reply.subject,
      text: reply.text,
      html: null,
      inReplyTo: reply.inReplyTo,
    },
  }
}
