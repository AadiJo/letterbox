// All mail, one mailbox or label, or a search: one windowed list for all of them. It renders
// only the rows on screen plus a small overscan, and subscribes only to that range of the
// core's threads view, so a mailbox of any size costs the same. Spacers above and below the
// rendered rows stand in for the rest, so a row that leaves can fold and the rows below follow.

import type { Account, ThreadFilter, ThreadId } from '@letterbox/protocol'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { leavesMailbox } from './actions.ts'
import { useHeld } from './motion.ts'
import { Row, ROW_HEIGHT } from './Row.tsx'
import { type Chrome, type Opening, Screen, useSelection } from './Screen.tsx'
import { positionOf, type Range, type Slice, useThreadWindow } from './threads.ts'

/** Rows rendered above and below the screen. */
const OVERSCAN = 6
/** The subscribed range moves in steps of this many rows, so a scroll of a few rows reuses it. */
const STEP = 10

/** The range to subscribe to while rows `first` to `first + count` are on screen. */
const rangeFor = (first: number, count: number): Range => {
  const offset = Math.max(0, Math.floor((first - OVERSCAN) / STEP) * STEP)
  const end = Math.ceil((first + count + OVERSCAN) / STEP) * STEP
  return { offset, limit: end - offset }
}

const count = new Intl.NumberFormat()

type Props = { title: string; filter: ThreadFilter; chrome: Chrome; accounts: readonly Account[] }

export function MailScreen({ title, filter, chrome, accounts }: Props) {
  const { slice, show } = useThreadWindow(filter)
  const order = slice?.entries.map((entry) => entry.id) ?? []
  // Only a mailbox list loses rows to an action. All mail and search keep archived and trashed mail.
  const { mailboxId } = filter
  const selection = useSelection(
    order,
    chrome.mail,
    (command) => mailboxId !== undefined && leavesMailbox(command, mailboxId, chrome.mail),
  )
  const total = slice?.total ?? 0
  return (
    <Screen
      title={title}
      subtitle={slice ? `${count.format(total)} ${total === 1 ? 'conversation' : 'conversations'}` : 'Loading'}
      chrome={chrome}
      accounts={accounts}
      selection={selection}
    >
      {/* A new filter starts a new list at the top. */}
      <WindowedList
        key={JSON.stringify(filter)}
        label={title}
        filter={filter}
        opening={chrome.opening}
        slice={slice}
        show={show}
        selection={selection}
      />
    </Screen>
  )
}

type ListProps = {
  label: string
  filter: ThreadFilter
  opening: Opening
  slice: Slice | undefined
  show: (range: Range) => void
  selection: ReturnType<typeof useSelection>
}

function WindowedList({ label, filter, opening, slice, show, selection }: ListProps) {
  const list = useRef<HTMLDivElement>(null)
  // The first row on screen, and how many rows fit.
  const [first, setFirst] = useState(0)
  const [fits, setFits] = useState(0)

  // Follows the list's height, which sets how many rows it shows.
  useEffect(() => {
    const element = list.current
    if (!element) return
    const observer = new ResizeObserver(() => setFits(Math.ceil(element.clientHeight / ROW_HEIGHT) + 1))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Moves the core subscription with the screen.
  const range = rangeFor(first, fits)
  useEffect(() => {
    show({ offset: range.offset, limit: range.limit })
  }, [show, range.offset, range.limit])

  const idAt = (index: number) => (slice ? slice.entries[index - slice.offset]?.id : undefined)

  // Keeps the selected row on screen when the keyboard moves past the edge.
  const position =
    slice && selection.selected ? slice.entries.findIndex((entry) => entry.id === selection.selected) : -1
  const selectedIndex = slice && position !== -1 ? slice.offset + position : -1
  useEffect(() => {
    const element = list.current
    if (!element || selectedIndex === -1) return
    const top = selectedIndex * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }, [selectedIndex])

  // A conversation App opened, as from a notification, may sit outside the window: once the
  // list has its length, the core says where, and the list scrolls there, its row a third of
  // the way down. Once per open, so a later scroll of the person's own stays where they put it.
  const placed = useRef<Opening>(null)
  const ready = slice !== undefined
  // The list is keyed by its filter, so the filter is the same for as long as it is up.
  const find = useEffectEvent((id: ThreadId) => positionOf(filter, id))
  useEffect(() => {
    if (!opening || !ready || placed.current === opening) return
    let current = true
    void find(opening.id).then((offset) => {
      const element = list.current
      if (!current || !element) return
      placed.current = opening
      if (offset !== null) element.scrollTop = Math.max(0, offset * ROW_HEIGHT - element.clientHeight / 3)
    })
    return () => {
      current = false
    }
  }, [opening, ready])

  const total = slice?.total ?? 0
  const start = Math.max(0, first - OVERSCAN)
  const end = Math.min(total, first + fits + OVERSCAN)
  // Null for a row the core has not sent yet. A scroll moves `start`, which ends any exit.
  const { rows: ids, held } = useHeld(
    Array.from({ length: Math.max(0, end - start) }, (_, index) => idAt(start + index) ?? null),
    start,
  )

  return (
    <div
      ref={list}
      role="listbox"
      aria-label={label}
      data-list="mail"
      onScroll={(event) => setFirst(Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT))}
      className="relative min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin]"
    >
      <div style={{ height: start * ROW_HEIGHT }} />
      {ids.map((id, index) => {
        if (!id)
          return <div key={`empty ${start + index}`} data-row="" className="mx-2" style={{ height: ROW_HEIGHT }} />
        const above = index > 0 ? ids[index - 1] : idAt(start - 1)
        return (
          <Row
            key={id}
            id={id}
            slot="time"
            selected={id === selection.selected}
            divider={start + index > 0 && id !== selection.selected && above !== selection.selected}
            onSelect={selection.select}
            held={held.has(id)}
          />
        )
      })}
      <div style={{ height: Math.max(0, total - end) * ROW_HEIGHT }} />
    </div>
  )
}
