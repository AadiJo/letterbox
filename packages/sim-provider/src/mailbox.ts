// One mailbox at the sim provider: the control object a scenario drives, and
// the answers to the adapter calls that arrive over the socket.

import type {
  ApplyResult,
  AttachmentResult,
  BodyResult,
  Cursor,
  MailboxRef,
  MessageRef,
  Mutation,
  Outcome,
  Outgoing,
  PageToken,
  SendResult,
  SnapshotPage,
} from './adapter.ts'
import type {
  CallCounts,
  Dialect,
  AnswerDamage,
  SentCopy,
  SimMailbox,
  Seed,
  SeedMailbox,
  SeedMessage,
} from './contract.ts'
import { foldersEngine } from './folders.ts'
import { labelsEngine } from './labels.ts'
import { readSent } from './sent.ts'
import { bodyOf, boxOf, contentsOf, factsOf, remoteMailboxes, remoteMessage } from './store.ts'
import type { Box, Draft, Store, Stored } from './store.ts'
import { failedCall, isRecord } from './wire.ts'
import type { Call, CallResult, Session } from './wire.ts'

type Flags = { unread?: boolean; flagged?: boolean }
type Refusal = Extract<ApplyResult, { kind: 'refused' }>['reason']
type SendRefusal = Extract<SendResult, { kind: 'refused' }>['reason']

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
  /** Answers one adapter call through `reply`. A body, attachment, apply, send or snapshot call waits while its method is held. */
  respond(call: Call, reply: (result: CallResult, damage?: AnswerDamage) => void): void
}

/** Where a snapshot page starts: below this delivery count, with the first page's cursor. */
type PageStart = { before: number; cursor: Cursor; generation: number }

/** Reads a snapshot page token. `generation` counts `expirePageTokens` calls before the first page. */
const readToken = (token: PageToken): PageStart | null => {
  let value: unknown
  try {
    value = JSON.parse(token)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.before !== 'number' || typeof value.cursor !== 'string') return null
  if (typeof value.generation !== 'number') return null
  return { before: value.before, cursor: value.cursor as Cursor, generation: value.generation }
}

/** Calls of one method that wait at the provider until a scenario releases them. */
const createHold = () => {
  // Answers waiting for `release`. Null while calls are not held.
  let waiting: (() => void)[] | null = null
  // Callers of `held`, each checked again whenever another call is held.
  let onHeld: (() => boolean)[] = []
  return {
    hold: () => {
      waiting ??= []
    },
    /** Keeps `answerNow` until release, if calls are held. False when they are not. */
    keep: (answerNow: () => void): boolean => {
      if (waiting === null) return false
      waiting.push(answerNow)
      onHeld = onHeld.filter((ready) => !ready())
      return true
    },
    /** Resolves once at least `count` calls are waiting. */
    held: (count = 1) =>
      new Promise<void>((resolve) => {
        const ready = () => (waiting?.length ?? 0) >= count && (resolve(), true)
        if (!ready()) onHeld.push(ready)
      }),
    release: () => {
      const now = waiting ?? []
      waiting = null
      for (const answerNow of now) answerNow()
    },
  }
}

/** The answer to an apply that changed nothing. */
const refused = (reason: Refusal): ApplyResult => ({ kind: 'refused', reason })

/** Builds one mailbox from its seed. */
export const createMailboxEntry = (dialect: Dialect, seed: Seed): MailboxEntry => {
  const store: Store = { boxes: new Map(), messages: new Map() }
  const engine = dialect === 'labels' ? labelsEngine(store) : foldersEngine(store)
  // The Message-ID of every key ever delivered. It outlives an expunge, so replies can still name it.
  const messageIds = new Map<string, string>()
  const counts: CallCounts = { snapshot: 0, changes: 0, body: 0, attachment: 0, apply: 0, send: 0, find: 0 }
  const sentCopies: SentCopy[] = []
  const pageSize = seed.pageSize ?? 50
  const canModify = seed.canModify ?? true
  let delivered = 0
  let offline = false
  let refusal: Refusal | null = null
  let sendRefusal: SendRefusal | null = null
  let sendDamage: AnswerDamage | null = null
  let applyDamage: AnswerDamage | null = null
  let findFails = false
  let searchLags = false
  // Rises on `expirePageTokens`. A page token from an older generation answers page-expired.
  let generation = 0
  const holds = {
    body: createHold(),
    attachment: createHold(),
    apply: createHold(),
    snapshot: createHold(),
    send: createHold(),
  }

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

  /** Files a message in the store, in delivery order. Seeded, delivered and sent mail all come through here. */
  const file = (draft: Omit<Draft, 'order'>): Stored => {
    const stored = engine.deliver({ ...draft, order: delivered + 1 })
    delivered += 1
    store.messages.set(draft.key, stored)
    messageIds.set(draft.key, draft.facts.messageId ?? '')
    return stored
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
    file({
      key: message.key,
      facts: factsOf(message, references, dialect === 'labels' ? (message.bulk ?? false) : null),
      body: bodyOf(message),
      contents: contentsOf(message),
      unread: message.unread ?? true,
      flagged: message.flagged ?? false,
      mailboxes,
    })
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
      engine.mailboxesChanged()
    },
    deleteMailbox: (key) => {
      const box = boxOf(store, key)
      const holding = [...store.messages.values()].filter((message) => message.mailboxes.includes(key))
      if (dialect === 'folders' && holding.length > 0)
        throw new Error(`sim provider: folder "${key}" still holds messages, so it cannot be deleted`)
      for (const message of holding)
        refile(
          message,
          message.mailboxes.filter((kept) => kept !== box.key),
        )
      store.boxes.delete(key)
      engine.mailboxesChanged()
    },
    expireCursors: () => engine.expire(),
    setOffline: (value) => {
      offline = value
    },
    refuseNextApply: (reason) => {
      refusal = reason
    },
    refuseNextSend: (reason) => {
      sendRefusal = reason
    },
    damageNextSendAnswer: (how) => {
      sendDamage = how
    },
    damageNextApplyAnswer: (how) => {
      applyDamage = how
    },
    failNextFind: () => {
      findFails = true
    },
    setSearchLag: (lagging) => {
      searchLags = lagging
    },
    expirePageTokens: () => {
      generation += 1
    },
    holdBodies: holds.body.hold,
    releaseBodies: holds.body.release,
    holdApplies: holds.apply.hold,
    applyHeld: holds.apply.held,
    releaseApplies: holds.apply.release,
    holdSnapshots: holds.snapshot.hold,
    snapshotHeld: holds.snapshot.held,
    releaseSnapshots: holds.snapshot.release,
    holdSends: holds.send.hold,
    sendHeld: holds.send.held,
    releaseSends: holds.send.release,
    holdAttachments: holds.attachment.hold,
    attachmentHeld: holds.attachment.held,
    releaseAttachments: holds.attachment.release,
    truth: () =>
      [...store.messages.values()].map((message) => ({
        key: message.key,
        mailboxes: message.mailboxes.toSorted(),
        unread: message.unread,
        flagged: message.flagged,
      })),
    calls: () => ({ ...counts }),
    sent: () => sentCopies.map((copy) => ({ ...copy, recipients: [...copy.recipients] })),
    attachmentBytes: (key, index) => {
      const content = messageOf(key).contents[index]?.()
      if (content === undefined) throw new Error(`sim provider: "${key}" has no attachment ${index}`)
      return content
    },
  }

  /**
   * One snapshot page, newest delivery first. The first page takes the cursor and every
   * token carries it to the last page.
   */
  const snapshot = (token: PageToken | null): Outcome<SnapshotPage> => {
    const first: PageStart = { before: Number.MAX_SAFE_INTEGER, cursor: engine.cursor(), generation }
    const from = token === null ? first : readToken(token)
    if (from === null) return { ok: false, failure: 'provider-error' }
    if (from.generation !== generation) return { ok: false, failure: 'page-expired' }
    // A later page lists what exists now. Whatever it misses is in `changes` from the first page's cursor.
    const rest = [...store.messages.values()].filter((message) => message.order < from.before).toReversed()
    const page = rest.slice(0, pageSize)
    const last = page.at(-1)
    const more = last !== undefined && rest.length > page.length
    const next: PageStart | null = more ? { ...from, before: last.order } : null
    return {
      ok: true,
      mailboxes: remoteMailboxes(store),
      messages: page.map((message) => remoteMessage(store, message)),
      next: next && (JSON.stringify(next) as PageToken),
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

  /** The content of the attachment at `index` in a message's body, or gone. */
  const attachment = ({ ref, index }: { ref: MessageRef; index: number }): AttachmentResult => {
    const content = targetsOf([ref])[0]?.contents[index]?.()
    return content === undefined ? { kind: 'gone' } : { kind: 'bytes', base64: content.toString('base64') }
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
    if (add === undefined || remove === undefined) return refused('unknown-mailbox')
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

  /**
   * Delivers a message the core wrote (adapter rule 10): files a copy in the Sent mailbox,
   * read, with the facts read from the message, so the copy is what a later sync reports.
   */
  const send = (outgoing: Outgoing): SendResult => {
    if (sendRefusal !== null) {
      const reason = sendRefusal
      sendRefusal = null
      return { kind: 'refused', reason }
    }
    if (!canModify) return { kind: 'refused', reason: 'not-permitted' }
    // RFC 5322 section 2.1.1: "Each line of characters MUST be no more than 998 characters".
    if (outgoing.raw.split('\r\n').some((line) => line.length > 998))
      return { kind: 'refused', reason: 'refused-by-provider' }
    const sentBox = [...store.boxes.values()].find((box) => box.role === 'sent')
    if (!sentBox) return { kind: 'refused', reason: 'not-supported' }
    const copy = readSent(outgoing.raw, dialect === 'labels' ? false : null)
    const key = `sent-${sentCopies.length + 1}`
    const contents = copy.contents.map((content) => () => content)
    const stored = file({ key, ...copy, contents, unread: false, flagged: false, mailboxes: [sentBox.key] })
    const recipients = [...copy.facts.to, ...copy.facts.cc].map((address) => address.address)
    sentCopies.push({ key, recipients: [...recipients, ...outgoing.bcc], raw: outgoing.raw })
    return { kind: 'sent', ref: stored.ref }
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
      case 'attachment':
        return { method: 'attachment', outcome: { ok: true, ...attachment(call.arg) } }
      case 'apply':
        return { method: 'apply', outcome: { ok: true, ...apply(call.arg) } }
      case 'send':
        return { method: 'send', outcome: { ok: true, ...send(call.arg) } }
      case 'find': {
        if (findFails) {
          findFails = false
          return failedCall(call, 'provider-error')
        }
        const found = [...store.messages.values()].find((message) => message.facts.messageId === call.arg)
        return { method: 'find', outcome: { ok: true, ref: searchLags ? null : (found?.ref ?? null) } }
      }
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
      const answerNow = () => {
        const result = answer(call)
        const damage = call.method === 'send' ? sendDamage : call.method === 'apply' ? applyDamage : null
        if (damage === null) return reply(result)
        if (call.method === 'send') sendDamage = null
        else applyDamage = null
        reply(result, damage)
      }
      const hold = call.method === 'changes' || call.method === 'find' || offline ? null : holds[call.method]
      if (!hold?.keep(answerNow)) answerNow()
    },
  }
}
