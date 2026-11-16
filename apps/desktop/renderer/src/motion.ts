// Row motion, and the only place the renderer animates an element from script
// (lint/rules/renderer-motion.ts keeps it that way). A row an action takes out of a list
// slides right and fades, then folds closed. A row whose action the core refused shakes once,
// and so does a leaving row the core takes back. Each step runs once, takes 250 ms or less,
// and moves only transform, opacity and height. With the system's reduced motion setting
// every step is instant. styles.css holds the CSS half.

import type { ThreadId } from '@letterbox/protocol'
import { type RefCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { withdrawFor } from './undo.ts'

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
const SLIDE_MS = 160
const FOLD_MS = 180
const SHAKE_MS = 120

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Each row's element while it is on screen. Row registers it with `trackRow`. */
const elements = new Map<ThreadId, HTMLElement>()

/**
 * Rows that are sliding or folding out, each with the element that moves. Lists keep them
 * in place until they are gone (`useHeld`). The element marks one exit: another list's row
 * for the same conversation is another element, and never part of it.
 */
let leaving: ReadonlyMap<ThreadId, HTMLElement> = new Map()
const watchers = new Set<() => void>()

const setLeaving = (id: ThreadId, element: HTMLElement | null) => {
  if ((leaving.get(id) ?? null) === element) return
  const next = new Map(leaving)
  if (element) next.set(id, element)
  else next.delete(id)
  leaving = next
  watchers.forEach((watcher) => watcher())
}

/** A row's ref callback: lets this module find the row's element. */
export const trackRow =
  (id: ThreadId): RefCallback<HTMLElement> =>
  (element) => {
    if (!element) return
    elements.set(id, element)
    return () => {
      if (elements.get(id) === element) elements.delete(id)
    }
  }

/**
 * Slides the row out, then folds its space closed. Resolves as the fold starts, which is
 * when the next conversation should open. Resolves at once when the row is off screen or
 * motion is reduced, and the row then goes with the list's next update.
 */
export async function leave(id: ThreadId) {
  const row = elements.get(id)
  if (!row || reduced()) return
  setLeaving(id, row)
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
  // `release` cancels the animation.
  const slid = await slide.finished.then(
    () => true,
    () => false,
  )
  if (!slid || leaving.get(id) !== row) return
  // The row went mid-slide, with its screen or window. Nothing is left to fold.
  if (!row.isConnected) return release(id)
  const { height, paddingTop, paddingBottom } = getComputedStyle(row)
  const fold = row.animate(
    [
      { height, paddingTop, paddingBottom },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px' },
    ],
    { duration: FOLD_MS, easing: EASE, fill: 'forwards' },
  )
  void fold.finished.then(
    () => {
      if (leaving.get(id) === row) setLeaving(id, null)
    },
    () => {},
  )
}

/** Stops a row leaving and shows it as it was, as for an undo that lands while it still moves. */
export function release(id: ThreadId) {
  leaving
    .get(id)
    ?.getAnimations()
    .forEach((animation) => animation.cancel())
  setLeaving(id, null)
}

/** Shakes a row once, 2 px each way, for an action the core refused. */
export const shake = (id: ThreadId) => shakeElement(elements.get(id))

function shakeElement(element: HTMLElement | undefined) {
  if (reduced()) return
  element?.animate(
    [{ transform: 'none' }, { transform: 'translateX(2px)' }, { transform: 'translateX(-2px)' }, { transform: 'none' }],
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
function hold<Id extends ThreadId | null>(
  shown: readonly Id[],
  next: readonly Id[],
  keep: ReadonlyMap<ThreadId, HTMLElement>,
) {
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
 * folding out, where it was. `held` names those. Every list that loses rows to an action
 * renders through this, and hands each row whether it is held (`useExit`).
 *
 * `frame` names the stretch of the list `ids` covers, such as a windowed list's first row.
 * When it moves, nothing is held: a leaving row is not placed among rows it never sat beside.
 */
export function useHeld<Id extends ThreadId | null>(ids: readonly Id[], frame = 0) {
  const keep = useSyncExternalStore(subscribe, () => leaving)
  const [shown, setShown] = useState({ rows: ids, frame })
  const rows = shown.frame === frame ? hold(shown.rows, ids, keep) : ids
  if (shown.frame !== frame || !same(rows, shown.rows)) setShown({ rows, frame })
  const held: ReadonlySet<ThreadId | null> = new Set(rows.filter((id) => !ids.includes(id)))
  return { rows, held }
}

/**
 * Ends the exit of a row that a list held (`held`) once the list stops holding it. If the
 * very element that was leaving is still on screen, its list has it again mid-exit: the
 * core took the change back, as after a provider refusal. The row then shows as it was,
 * shakes once, and its toast goes. If the element went (its window scrolled on, or its
 * screen closed, even as another list mounts a row for the same conversation), the exit is
 * released with it.
 */
export function useExit(id: ThreadId, held: boolean) {
  useEffect(() => {
    const exiting = held ? leaving.get(id) : undefined
    if (!exiting) return
    return () => {
      if (leaving.get(id) !== exiting) return
      release(id)
      if (!exiting.isConnected) return
      shakeElement(exiting)
      withdrawFor(id)
    }
  }, [id, held])
}
