// One mailbox at the sim provider: the control object a scenario drives, and
// the answers to the adapter calls that arrive over the socket.

import type {
  ApplyResult,
  BodyResult,
  Cursor,
  MailboxRef,
  MessageRef,
  Mutation,
  Outcome,
  PageToken,
  SnapshotPage,
} from './adapter.ts'
import type { CallCounts, Dialect, SimMailbox, Seed, SeedMailbox, SeedMessage } from './contract.ts'
import { foldersEngine } from './folders.ts'
import { labelsEngine } from './labels.ts'
import { bareMessageId, bodyOf, boxOf, factsOf, remoteMailboxes, remoteMessage } from './store.ts'
import type { Box, Store, Stored } from './store.ts'
import { failedCall, isRecord } from './wire.ts'
import type { Call, CallResult, Session } from './wire.ts'

type Flags = { unread?: boolean; flagged?: boolean }
type Refusal = Extract<ApplyResult, { kind: 'refused' }>['reason']

/** What server.ts, and the fake Gmail server in gmail/, need from one mailbox. */
export type MailboxEntry = {
  control: SimMailbox
  /** The ground truth, for reading only. Changes go through `control` or `respond`. */
  store: Store
  /** The cursor for the mailbox as it is now, as the first snapshot page takes it. */
  cursor(): Cursor
  password: string
  /** Goes into the session string, so `resume` can rebuild the adapter. */
  session: Session
  isOffline(): boolean
  /** Answers one adapter call through `reply`. A body call waits while bodies are held. */
  respond(call: Call, reply: (result: CallResult) => void): void
}

/** Reads a snapshot page token: the delivery count of the last message listed, and the first page's cursor. */
const readToken = (token: PageToken): { after: number; cursor: Cursor } | null => {
  let value: unknown
  try {
    value = JSON.parse(token)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.after !== 'number' || typeof value.cursor !== 'string') return null
  return { after: value.after, cursor: value.cursor as Cursor }
}

/** The answer to an apply that changed nothing. */
const refused = (reason: Refusal): ApplyResult => ({ kind: 'refused', reason })

/** Builds one mailbox from its seed. */
export const createMailboxEntry = (dialect: Dialect, seed: Seed): MailboxEntry => {
  const store: Store = { boxes: new Map(), messages: new Map() }
  const engine = dialect === 'labels' ? labelsEngine(store) : foldersEngine(store)
  // The Message-ID of every key ever delivered. It outlives an expunge, so replies can still name it.
  const messageIds = new Map<string, string>()
  const counts: CallCounts = { snapshot: 0, changes: 0, body: 0, apply: 0 }
  const pageSize = seed.pageSize ?? 50
  const canModify = seed.canModify ?? true
  let delivered = 0
  let offline = false
  let refusal: Refusal | null = null
  // Body calls waiting for `releaseBodies`. Null while bodies are not held.
  let heldBodies: (() => void)[] | null = null
  // Apply calls waiting for `releaseApplies`. Null while applies are not held.
  let heldApplies: (() => void)[] | null = null
  // Callers of `applyHeld` waiting for the next apply call to be held.
  const onApplyHeld: (() => void)[] = []

  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error(`sim provider: pageSize ${pageSize} is not usable`)

  /** Adds a mailbox to the store. Mailbox refs count up in creation order. */
  const addBox = (mailbox: SeedMailbox): void => {
    if (store.boxes.has(mailbox.key)) throw new Error(`sim provider: mailbox key "${mailbox.key}" is already used`)
    if (mailbox.parent !== undefined) boxOf(store, mailbox.parent)
    store.boxes.set(mailbox.key, {
      key: mailbox.key,
      ref: `${dialect === 'labels' ? 'label' : 'folder'}-${store.boxes.size + 1}` as MailboxRef,
      name: mailbox.name,
      role: mailbox.role,
      parent: mailbox.parent ?? null,
      epoch: 1,
      nextNumber: 1,
      counter: 0,
    })
  }

  /** Adds a message to the store. Used for the seed and for `deliver`. */
  const deliver = (message: SeedMessage): void => {
    if (messageIds.has(message.key)) throw new Error(`sim provider: message key "${message.key}" is already used`)
    const mailboxes = [...new Set(message.mailboxes)]
    for (const key of mailboxes) boxOf(store, key)
    const references = (message.replyTo ?? []).map((key) => {
      const messageId = messageIds.get(key)
      if (messageId === undefined) throw new Error(`sim provider: "${message.key}" replies to unknown "${key}"`)
      return messageId
    })
    const stored = engine.deliver({
      key: message.key,
      order: delivered + 1,
      facts: factsOf(message, references, dialect === 'labels' ? (message.bulk ?? false) : null),
      body: bodyOf(message),
      unread: message.unread ?? true,
      flagged: message.flagged ?? false,
      mailboxes,
    })
    delivered += 1
    store.messages.set(message.key, stored)
    messageIds.set(message.key, bareMessageId(message))
  }

  /** Looks up a message that exists by key. An unknown key is a scenario bug. */
  const messageOf = (key: string): Stored => {
    const message = store.messages.get(key)
    if (!message) throw new Error(`sim provider: no message with key "${key}"`)
    return message
  }

  /** Sets the given flags. Records a change only if a value really changed. */
  const setFlags = (message: Stored, flags: Flags): void => {
    const unread = flags.unread ?? message.unread
    const flagged = flags.flagged ?? message.flagged
    if (unread === message.unread && flagged === message.flagged) return
    message.unread = unread
    message.flagged = flagged
    engine.flagsChanged(message)
  }

  /** Puts a message in exactly `mailboxes`. Returns the ref pair if the dialect gave it a new ref. */
  const refile = (message: Stored, mailboxes: string[]) => {
    const same =
      mailboxes.length === message.mailboxes.length && mailboxes.every((key) => message.mailboxes.includes(key))
    return same ? null : engine.refile(message, mailboxes)
  }

  /** Stops the folders dialect from being asked for something only labels can do. */
  const labelsOnly = (method: string): void => {
    if (dialect === 'folders') throw new Error(`sim provider: ${method} does not exist in the folders dialect`)
  }

  const control: SimMailbox = {
    address: seed.address,
    dialect,
    deliver,
    setFlags: (key, flags) => setFlags(messageOf(key), flags),
    move: (key, toMailbox) => void refile(messageOf(key), [boxOf(store, toMailbox).key]),
    addToMailbox: (key, mailbox) => {
      labelsOnly('addToMailbox')
      const message = messageOf(key)
      refile(message, [...new Set([...message.mailboxes, boxOf(store, mailbox).key])])
    },
    removeFromMailbox: (key, mailbox) => {
      labelsOnly('removeFromMailbox')
      const message = messageOf(key)
      const gone = boxOf(store, mailbox).key
      refile(
        message,
        message.mailboxes.filter((kept) => kept !== gone),
      )
    },
    expunge: (key) => {
      const message = messageOf(key)
      store.messages.delete(key)
      engine.expunged(message)
    },
    createMailbox: (mailbox) => {
      addBox(mailbox)
      engine.mailboxCreated()
    },
    expireCursors: () => engine.expire(),
    setOffline: (value) => {
      offline = value
    },
    refuseNextApply: (reason) => {
      refusal = reason
    },
    holdBodies: () => {
      heldBodies ??= []
    },
    releaseBodies: () => {
      const waiting = heldBodies ?? []
      heldBodies = null
      for (const answerNow of waiting) answerNow()
    },
    holdApplies: () => {
      heldApplies ??= []
    },
    applyHeld: () =>
      new Promise<void>((resolve) => {
        if (heldApplies !== null && heldApplies.length > 0) resolve()
        else onApplyHeld.push(resolve)
      }),
    releaseApplies: () => {
      const waiting = heldApplies ?? []
      heldApplies = null
      for (const answerNow of waiting) answerNow()
    },
    truth: () =>
      [...store.messages.values()].map((message) => ({
        key: message.key,
        mailboxes: message.mailboxes.toSorted(),
        unread: message.unread,
        flagged: message.flagged,
      })),
    calls: () => ({ ...counts }),
  }

  /** One snapshot page. The first page takes the cursor and every token carries it to the last page. */
  const snapshot = (token: PageToken | null): Outcome<SnapshotPage> => {
    const from = token === null ? { after: 0, cursor: engine.cursor() } : readToken(token)
    if (from === null) return { ok: false, failure: 'provider-error' }
    // A later page lists what exists now. Whatever it misses is in `changes` from the first page's cursor.
    const rest = [...store.messages.values()].filter((message) => message.order > from.after)
    const page = rest.slice(0, pageSize)
    const last = page.at(-1)
    const more = last !== undefined && rest.length > page.length
    return {
      ok: true,
      mailboxes: remoteMailboxes(store),
      messages: page.map((message) => remoteMessage(store, message)),
      next: more ? (JSON.stringify({ after: last.order, cursor: from.cursor }) as PageToken) : null,
      cursor: more ? null : from.cursor,
    }
  }

  /** The messages these refs name now, without repeats. Refs that name nothing are left out. */
  const targetsOf = (refs: MessageRef[]): Stored[] => {
    const wanted = new Set(refs)
    return [...store.messages.values()].filter((message) => wanted.has(message.ref))
  }

  const body = (ref: MessageRef): BodyResult => {
    const [message] = targetsOf([ref])
    return message ? { kind: 'body', body: message.body } : { kind: 'gone' }
  }

  /** The mailboxes these refs name, or null if one of them names nothing. */
  const boxesOf = (refs: MailboxRef[]): Box[] | null => {
    const found = refs.flatMap((ref) => [...store.boxes.values()].filter((box) => box.ref === ref))
    return found.length === refs.length ? found : null
  }

  const apply = (mutation: Mutation): ApplyResult => {
    if (refusal !== null) {
      const reason = refusal
      refusal = null
      return refused(reason)
    }
    if (!canModify) return refused('not-permitted')
    const targets = targetsOf(mutation.refs)
    if (mutation.kind === 'flags') {
      if (targets.length === 0) return refused('unknown-target')
      for (const message of targets) setFlags(message, mutation)
      return { kind: 'applied', moved: [] }
    }
    // Plain folders can only move: out of one mailbox, into one other.
    const isMove = mutation.add.length === 1 && mutation.remove.length === 1
    if (dialect === 'folders' && !isMove) return refused('not-supported')
    const add = boxesOf(mutation.add)?.map((box) => box.key)
    const remove = boxesOf(mutation.remove)?.map((box) => box.key)
    if (add === undefined || remove === undefined) return refused('unknown-target')
    // A folders ref that is not in the source mailbox is not a target of the move, so it is skipped.
    const movable =
      dialect === 'folders'
        ? targets.filter((message) => message.mailboxes.every((key) => remove.includes(key)))
        : targets
    if (movable.length === 0) return refused('unknown-target')
    const moved = movable.flatMap((message) => {
      const kept = message.mailboxes.filter((key) => !remove.includes(key))
      return refile(message, [...new Set([...kept, ...add])]) ?? []
    })
    return { kind: 'applied', moved }
  }

  /** Answers one adapter call, unless the mailbox is offline. Counts the calls it answers. */
  const answer = (call: Call): CallResult => {
    if (offline) return failedCall(call, 'offline')
    counts[call.method] += 1
    switch (call.method) {
      case 'snapshot':
        return { method: 'snapshot', outcome: snapshot(call.arg) }
      case 'changes':
        return { method: 'changes', outcome: { ok: true, ...engine.changes(call.arg) } }
      case 'body':
        return { method: 'body', outcome: { ok: true, ...body(call.arg) } }
      case 'apply':
        return { method: 'apply', outcome: { ok: true, ...apply(call.arg) } }
    }
  }

  for (const mailbox of seed.mailboxes) addBox(mailbox)
  for (const message of seed.messages) deliver(message)

  return {
    control,
    store,
    cursor: () => engine.cursor(),
    password: seed.password,
    session: { address: seed.address, dialect, modify: canModify },
    isOffline: () => offline,
    respond: (call, reply) => {
      if (call.method === 'body' && heldBodies !== null && !offline) heldBodies.push(() => reply(answer(call)))
      else if (call.method === 'apply' && heldApplies !== null && !offline) {
        heldApplies.push(() => reply(answer(call)))
        for (const notify of onApplyHeld.splice(0)) notify()
      } else reply(answer(call))
    },
  }
}
