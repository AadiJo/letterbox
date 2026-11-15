// The labels dialect: refs that never change and one change log for the whole mailbox.

import type { ChangesResult, Cursor, MessageRef } from '@letterbox/core/adapter'
import { remoteMailboxes, remoteMessage, stateOf } from './store.ts'
import type { Engine, Store } from './store.ts'

/** One line of the change log. A message entry names the ref only. `changes` reads the current state. */
type Entry = { kind: 'added' | 'updated' | 'removed'; ref: MessageRef } | { kind: 'mailbox' }

/** Builds the labels engine for one mailbox. */
export const labelsEngine = (store: Store): Engine => {
  // A cursor is "log-<generation>-<position>". Cutting the log starts a new generation.
  let generation = 1
  let log: Entry[] = []
  let minted = 0

  const cursor = (): Cursor => `log-${generation}-${log.length}` as Cursor

  /** The log position a cursor names, or null if this log no longer covers it. */
  const positionOf = (value: Cursor): number | null => {
    const match = /^log-(\d+)-(\d+)$/.exec(value)
    const position = Number(match?.[2])
    return match && Number(match[1]) === generation && position <= log.length ? position : null
  }

  const changes = (since: Cursor): ChangesResult => {
    const position = positionOf(since)
    if (position === null) return { kind: 'cursor-expired' }
    const seen = { added: new Set<MessageRef>(), updated: new Set<MessageRef>(), removed: new Set<MessageRef>() }
    let listChanged = false
    for (const entry of log.slice(position)) {
      if (entry.kind === 'mailbox') listChanged = true
      else seen[entry.kind].add(entry.ref)
    }
    // An expunged message is no longer in the store, so it drops out of `added` and `updated` here.
    const live = [...store.messages.values()]
    return {
      kind: 'changes',
      added: live.filter((message) => seen.added.has(message.ref)).map((message) => remoteMessage(store, message)),
      updated: live
        .filter((message) => seen.updated.has(message.ref) && !seen.added.has(message.ref))
        .map((message) => stateOf(store, message)),
      removed: [...seen.removed],
      mailboxes: listChanged ? remoteMailboxes(store) : null,
      cursor: cursor(),
    }
  }

  return {
    deliver: (draft) => {
      const ref = `msg-${++minted}` as MessageRef
      log.push({ kind: 'added', ref })
      return { ...draft, ref, number: 0, changed: 0 }
    },
    refile: (message, mailboxes) => {
      message.mailboxes = mailboxes
      log.push({ kind: 'updated', ref: message.ref })
      return null
    },
    flagsChanged: (message) => void log.push({ kind: 'updated', ref: message.ref }),
    expunged: (message) => void log.push({ kind: 'removed', ref: message.ref }),
    mailboxCreated: () => void log.push({ kind: 'mailbox' }),
    expire: () => {
      generation += 1
      log = []
    },
    cursor,
    changes,
  }
}
