// Updates' senders, from the core's senders view. A list holds a window of them that follows
// the screen, as threads.ts's pagers do for conversations: it subscribes only to the range on
// screen, keeps the old range on screen until the new one arrives, and has at most one new
// range on its way. Every window carries the counts over all senders.

import type { Subscription } from '@letterbox/client'
import type { MailboxId, SenderPage } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { client } from './core.ts'

/** The user's IANA time zone, so the core counts a sender's days as theirs (SenderSummary.days). */
export const userZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Senders `offset` to `offset + limit` of Updates. */
export type Range = { offset: number; limit: number }

/** The part of Updates the core sent: `page.senders` are senders `offset` onward. */
export type SenderSlice = { offset: number; page: SenderPage }

type Open = { range: Range; subscription: Subscription<'senders'>; stop: () => void }

const sameRange = (a: Range | undefined, b: Range) => a?.offset === b.offset && a.limit === b.limit

function createPager(mailboxId: MailboxId, zone: string) {
  let wanted: Range | undefined
  let shown: Open | undefined
  let pending: Open | undefined
  let slice: SenderSlice | undefined
  const watchers = new Set<() => void>()

  const close = (open: Open | undefined) => {
    open?.stop()
    open?.subscription.close()
  }

  const receive = (open: Open) => {
    const page = open.subscription.latest()
    if (!page) return
    if (open === pending) {
      close(shown)
      shown = open
      pending = undefined
      follow()
    }
    if (open !== shown) return
    slice = { offset: open.range.offset, page }
    watchers.forEach((watcher) => watcher())
  }

  /** Subscribes to `wanted` unless it is shown, or any range is already on its way. */
  const follow = () => {
    if (!wanted || watchers.size === 0 || pending || sameRange(shown?.range, wanted)) return
    const subscription = client.subscribe({ view: 'senders', mailboxId, zone, ...wanted })
    const open: Open = { range: wanted, subscription, stop: () => {} }
    open.stop = subscription.watch(() => receive(open))
    pending = open
  }

  return {
    show: (range: Range) => {
      wanted = range
      follow()
    },
    subscribe: (onChange: () => void) => {
      watchers.add(onChange)
      follow()
      return () => {
        watchers.delete(onChange)
        // React unsubscribes and subscribes again at once in Strict Mode. Close only if nobody came back.
        queueMicrotask(() => {
          if (watchers.size > 0) return
          close(shown)
          close(pending)
          shown = undefined
          pending = undefined
        })
      }
    },
    slice: () => slice,
  }
}

const pagers = new Map<string, ReturnType<typeof createPager>>()

/**
 * Updates over `inbox`, in the user's zone, windowed: call `show` with the range the screen
 * holds. The slice keeps the previous range until the new one arrives. A new zone is a new
 * list, so the core counts days by it from then on.
 */
export function useSenderWindow(inbox: MailboxId) {
  const zone = userZone()
  const key = `${inbox} ${zone}`
  let pager = pagers.get(key)
  if (!pager) {
    pager = createPager(inbox, zone)
    pagers.set(key, pager)
  }
  return { slice: useSyncExternalStore(pager.subscribe, pager.slice), show: pager.show }
}
