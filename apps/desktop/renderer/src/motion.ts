// Row motion, and the only place the renderer animates an element from script
// (lint/rules/renderer-motion.ts keeps it that way). A row an action takes out of a list
// slides right and fades, then folds closed. A row whose action the core refused shakes once.
// Each step runs once, takes 250 ms or less, and moves only transform, opacity and height.
// With the system's reduced motion setting every step is instant. styles.css holds the CSS half.

import type { ThreadId } from '@letterbox/protocol'
import { type RefCallback, useState, useSyncExternalStore } from 'react'

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
const SLIDE_MS = 160
const FOLD_MS = 180
const SHAKE_MS = 120

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Each row's element while it is on screen. Row registers it with `trackRow`. */
const rows = new Map<ThreadId, HTMLElement>()

/** Rows that are sliding or folding out. Lists keep them in place until they are gone (`useHeld`). */
let leaving: ReadonlySet<ThreadId> = new Set()
const watchers = new Set<() => void>()

const setLeaving = (id: ThreadId, on: boolean) => {
  if (leaving.has(id) === on) return
  const next = new Set(leaving)
  if (on) next.add(id)
  else next.delete(id)
  leaving = next
  watchers.forEach((watcher) => watcher())
}

/** A row's ref callback: lets this module find the row's element. */
export const trackRow =
  (id: ThreadId): RefCallback<HTMLElement> =>
  (element) => {
    if (!element) return
    rows.set(id, element)
    return () => {
      if (rows.get(id) === element) rows.delete(id)
    }
  }

/**
 * Slides the row out, then folds its space closed. Resolves as the fold starts, which is
 * when the next conversation should open. Resolves at once when the row is off screen or
 * motion is reduced, and the row then goes with the list's next update.
 */
export async function leave(id: ThreadId) {
  const row = rows.get(id)
  if (!row || reduced()) return
  setLeaving(id, true)
  const slide = row.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: 'translateX(18px)', opacity: 0 },
    ],
    {
      duration: SLIDE_MS,
      easing: EASE,
      fill: 'forwards',
    },
  )
  // `restore` cancels the animation, and the row stays.
  const slid = await slide.finished.then(
    () => true,
    () => false,
  )
  if (!slid) return
  const { height, paddingTop, paddingBottom } = getComputedStyle(row)
  const fold = row.animate(
    [
      { height, paddingTop, paddingBottom },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px' },
    ],
    { duration: FOLD_MS, easing: EASE, fill: 'forwards' },
  )
  void fold.finished.then(
    () => setLeaving(id, false),
    () => {},
  )
}

/** Stops a row leaving and shows it as it was, for an undo that lands while it still moves. */
export function restore(id: ThreadId) {
  rows
    .get(id)
    ?.getAnimations()
    .forEach((animation) => animation.cancel())
  setLeaving(id, false)
}

/** Shakes a row once, 2 px each way, for an action the core refused. */
export function shake(id: ThreadId) {
  if (reduced()) return
  rows
    .get(id)
    ?.animate(
      [
        { transform: 'none' },
        { transform: 'translateX(2px)' },
        { transform: 'translateX(-2px)' },
        { transform: 'none' },
      ],
      { duration: SHAKE_MS },
    )
}

const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  return () => void watchers.delete(onChange)
}

/**
 * Inserts each row of `shown` that is still leaving into `next`, after the row it followed.
 * Empty slots (null, a row still loading) are never kept.
 */
function hold<Id extends ThreadId | null>(shown: readonly Id[], next: readonly Id[], keep: ReadonlySet<ThreadId>) {
  const result = [...next]
  shown.forEach((id, index) => {
    if (id === null || !keep.has(id) || result.includes(id)) return
    const before = shown.slice(0, index).findLast((earlier) => earlier !== null && result.includes(earlier))
    result.splice(before === undefined ? Math.min(index, result.length) : result.indexOf(before) + 1, 0, id)
  })
  return result
}

const same = <Id>(a: readonly Id[], b: readonly Id[]) =>
  a.length === b.length && a.every((id, index) => id === b[index])

/**
 * The rows a list renders: `ids`, plus any row that left `ids` but is still sliding or
 * folding out, where it was. Every list that loses rows to an action renders through this.
 */
export function useHeld<Id extends ThreadId | null>(ids: readonly Id[]) {
  const keep = useSyncExternalStore(subscribe, () => leaving)
  const [shown, setShown] = useState(ids)
  const next = hold(shown, ids, keep)
  if (!same(next, shown)) setShown(next)
  return next
}
