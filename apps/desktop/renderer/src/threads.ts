// Conversation lists and their rows. The only place the renderer subscribes to the core's
// threads view; lint/rules/renderer-thread-lists.ts keeps it that way.
//
// A list holds ids, never rows. Each row reads its own record with `useThread`, and a
// record only tells its watchers when its own data changed. So when one conversation
// changes, one row re-renders, and the list re-renders only when its order or length does.

import type { Subscription } from '@letterbox/client'
import type { ThreadFilter, ThreadId, ThreadPage, ThreadSummary } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'
import { client } from './core.ts'

/** What a list knows about one row: enough to place it and to filter it by age. */
export type Entry = Pick<ThreadSummary, 'id' | 'lastMessageAt'>

/** The part of a list the core sent: `entries` are rows `offset` onward, out of `total`. */
export type Slice = { total: number; offset: number; entries: readonly Entry[] }

/** Rows `offset` to `offset + limit` of a list. */
export type Range = { offset: number; limit: number }

// Records: the newest summary of every conversation any list has shown.

const records = new Map<ThreadId, { thread: ThreadSummary; json: string }>()
const recordWatchers = new Map<ThreadId, Set<() => void>>()

/** Saves a page's rows, and tells each changed row's watchers. */
function remember(page: ThreadPage) {
  for (const thread of page.threads) {
    const json = JSON.stringify(thread)
    if (records.get(thread.id)?.json === json) continue
    records.set(thread.id, { thread, json })
    recordWatchers.get(thread.id)?.forEach((watcher) => watcher())
  }
}

/** One subscribe function per id, so React keeps a row's subscription across renders. */
const recordSubscribers = new Map<ThreadId, (onChange: () => void) => () => void>()

const watchRecord = (id: ThreadId) => {
  const existing = recordSubscribers.get(id)
  if (existing) return existing
  const subscribe = (onChange: () => void) => {
    const watchers = recordWatchers.get(id) ?? new Set()
    recordWatchers.set(id, watchers.add(onChange))
    return () => void watchers.delete(onChange)
  }
  recordSubscribers.set(id, subscribe)
  return subscribe
}

const watchNothing = () => () => {}

/** One conversation's newest summary, for a row. Undefined until a list has shown it, or for no id. */
export function useThread(id: ThreadId | null) {
  return useSyncExternalStore(id === null ? watchNothing : watchRecord(id), () =>
    id === null ? undefined : records.get(id)?.thread,
  )
}

/** The same, read once, for an event handler. */
export const threadRecord = (id: ThreadId) => records.get(id)?.thread

// Pagers: one live list each, over one filter, showing one range at a time.

type Open = { range: Range; subscription: Subscription<'threads'>; stop: () => void }

const sameRange = (a: Range | undefined, b: Range) => a?.offset === b.offset && a.limit === b.limit

const sameEntries = (a: readonly Entry[], b: readonly Entry[]) =>
  a.length === b.length &&
  a.every((entry, index) => entry.id === b[index]?.id && entry.lastMessageAt === b[index].lastMessageAt)

/**
 * A list over `filter`. It subscribes to the range it was last asked to `show`, while
 * anyone watches. Moving the range keeps the old one on screen until the new one arrives.
 * At most one new range is on its way at a time: a fast scroll asks for many ranges, and
 * the core answers each over the whole list, so only the newest wish is sent once the
 * one in flight lands.
 */
function createPager(filter: ThreadFilter, initial: Range | undefined) {
  let wanted = initial
  let shown: Open | undefined
  let pending: Open | undefined
  let slice: Slice | undefined
  const watchers = new Set<() => void>()

  const close = (open: Open | undefined) => {
    open?.stop()
    open?.subscription.close()
  }

  const receive = (open: Open) => {
    const page = open.subscription.latest()
    if (!page) return
    remember(page)
    if (open === pending) {
      close(shown)
      shown = open
      pending = undefined
      follow()
    }
    if (open !== shown) return
    const entries = page.threads.map(({ id, lastMessageAt }) => ({ id, lastMessageAt }))
    const next = { total: page.total, offset: open.range.offset, entries }
    if (slice && slice.total === next.total && slice.offset === next.offset && sameEntries(slice.entries, entries))
      return
    slice = next
    watchers.forEach((watcher) => watcher())
  }

  /** Subscribes to `wanted` unless it is shown, or any range is already on its way. */
  const follow = () => {
    if (!wanted || watchers.size === 0 || pending || sameRange(shown?.range, wanted)) return
    const subscription = client.subscribe({ view: 'threads', filter, ...wanted })
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

type Pager = ReturnType<typeof createPager>

const pagers = new Map<string, Pager>()

/** The pager for `key`, made on first use. Making one sends nothing, so it is safe during render. */
const pagerFor = (key: string, filter: ThreadFilter, initial?: Range) => {
  const existing = pagers.get(key)
  if (existing) return existing
  const pager = createPager(filter, initial)
  pagers.set(key, pager)
  return pager
}

/**
 * The first `limit` rows of a list, newest first, for a short list such as a People
 * section. Every component that asks for the same filter and limit shares one subscription.
 */
export function useThreadSection(filter: ThreadFilter, limit: number) {
  const pager = pagerFor(`section ${limit} ${JSON.stringify(filter)}`, filter, { offset: 0, limit })
  return useSyncExternalStore(pager.subscribe, pager.slice)
}

/**
 * A long list that subscribes only to the rows on screen. Call `show` with the range the
 * screen holds. The slice keeps the previous range until the new one arrives.
 */
export function useThreadWindow(filter: ThreadFilter) {
  const pager = pagerFor(`window ${JSON.stringify(filter)}`, filter)
  return { slice: useSyncExternalStore(pager.subscribe, pager.slice), show: pager.show }
}
