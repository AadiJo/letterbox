// The folders dialect: a ref names a mailbox, its epoch and a number inside it.
// There is no change log. The cursor holds what the adapter saw in each mailbox.

import type { ChangesResult, Cursor, MessageRef } from './adapter.ts'
import { boxOf, remoteMailboxes, remoteMessage, stateOf } from './store.ts'
import type { Box, Engine, Store, Stored } from './store.ts'
import { isRecord } from './wire.ts'

/** What a cursor remembers about one mailbox. */
type Seen = { epoch: number; numbers: number[]; counter: number }

const isSeen = (value: unknown): value is Seen =>
  isRecord(value) &&
  typeof value.epoch === 'number' &&
  typeof value.counter === 'number' &&
  Array.isArray(value.numbers) &&
  value.numbers.every((entry) => typeof entry === 'number')

/** Reads a cursor: a JSON object from mailbox ref to what was seen there. Null if it is not one of ours. */
const readCursor = (cursor: Cursor): Map<string, Seen> | null => {
  let value: unknown
  try {
    value = JSON.parse(cursor)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const seen = new Map<string, Seen>()
  for (const [ref, entry] of Object.entries(value)) {
    if (!isSeen(entry)) return null
    seen.set(ref, entry)
  }
  return seen
}

/** The ref of the message with this number in a mailbox, at the mailbox's current epoch. */
const refOf = (box: Box, number: number): MessageRef => `${box.ref}/${box.epoch}/${number}` as MessageRef

/** Orders messages oldest delivery first. */
const byDelivery = (left: Stored, right: Stored): number => left.order - right.order

/** The next free number in a mailbox, with the ref and counter value that go with it. */
const placeIn = (box: Box) => {
  const number = box.nextNumber
  box.nextNumber += 1
  return { ref: refOf(box, number), number, changed: box.counter }
}

/** Builds the folders engine for one mailbox. */
export const foldersEngine = (store: Store): Engine => {
  /** The one mailbox a message must sit in. Anything else is a scenario bug. */
  const onlyBox = (key: string, mailboxes: string[]): Box => {
    const [first, ...rest] = mailboxes
    if (first === undefined || rest.length > 0) {
      throw new Error(`sim provider: folders message "${key}" needs exactly one mailbox, got ${mailboxes.length}`)
    }
    return boxOf(store, first)
  }

  /** Every message in a mailbox, lowest number first. */
  const messagesIn = (box: Box): Stored[] =>
    [...store.messages.values()]
      .filter((message) => message.mailboxes[0] === box.key)
      .toSorted((left, right) => left.number - right.number)

  const cursor = (): Cursor => {
    const seen: Record<string, Seen> = {}
    for (const box of store.boxes.values()) {
      const numbers = messagesIn(box).map((message) => message.number)
      seen[box.ref] = { epoch: box.epoch, numbers, counter: box.counter }
    }
    return JSON.stringify(seen) as Cursor
  }

  const changes = (since: Cursor): ChangesResult => {
    const seen = readCursor(since)
    if (seen === null) return { kind: 'cursor-expired' }
    const added: Stored[] = []
    const updated: Stored[] = []
    const removed: MessageRef[] = []
    let listChanged = false
    for (const box of store.boxes.values()) {
      // A mailbox the cursor has never seen counts as empty then, so all its messages are added.
      const known = seen.get(box.ref) ?? null
      if (known === null) listChanged = true
      else if (known.epoch !== box.epoch) return { kind: 'cursor-expired' }
      const before = new Set(known?.numbers)
      const now = messagesIn(box)
      for (const message of now) {
        if (!before.has(message.number)) added.push(message)
        else if (known !== null && message.changed > known.counter) updated.push(message)
      }
      const present = new Set(now.map((message) => message.number))
      for (const number of before) if (!present.has(number)) removed.push(refOf(box, number))
    }
    return {
      kind: 'changes',
      added: added.toSorted(byDelivery).map((message) => remoteMessage(store, message)),
      updated: updated.toSorted(byDelivery).map((message) => stateOf(store, message)),
      removed,
      mailboxes: listChanged ? remoteMailboxes(store) : null,
      cursor: cursor(),
    }
  }

  return {
    deliver: (draft) => ({ ...draft, ...placeIn(onlyBox(draft.key, draft.mailboxes)) }),
    refile: (message, mailboxes) => {
      const from = message.ref
      Object.assign(message, placeIn(onlyBox(message.key, mailboxes)), { mailboxes })
      return { from, to: message.ref }
    },
    flagsChanged: (message) => {
      const box = onlyBox(message.key, message.mailboxes)
      box.counter += 1
      message.changed = box.counter
    },
    // The number leaves the mailbox with the message, and the next cursor diff reports it.
    expunged: () => {},
    mailboxCreated: () => {},
    expire: () => {
      for (const box of store.boxes.values()) {
        const messages = messagesIn(box)
        box.epoch += 1
        box.nextNumber = 1
        for (const message of messages) Object.assign(message, placeIn(box))
      }
    },
    cursor,
    changes,
  }
}
