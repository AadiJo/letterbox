// All mail, one mailbox or label, or a search: one windowed list for all of them. It renders
// only the rows on screen plus a small overscan, and subscribes only to that range of the
// core's threads view, so a mailbox of any size costs the same.

import type { Account, ThreadFilter } from '@letterbox/protocol'
import { useEffect, useRef, useState } from 'react'
import { Row, ROW_HEIGHT } from './Row.tsx'
import { type Chrome, Screen, useSelection } from './Screen.tsx'
import { type Range, type Slice, useThreadWindow } from './threads.ts'

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
  const selection = useSelection(order, chrome.mail)
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
      <WindowedList key={JSON.stringify(filter)} label={title} slice={slice} show={show} selection={selection} />
    </Screen>
  )
}

type ListProps = {
  label: string
  slice: Slice | undefined
  show: (range: Range) => void
  selection: ReturnType<typeof useSelection>
}

function WindowedList({ label, slice, show, selection }: ListProps) {
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

  const total = slice?.total ?? 0
  const start = Math.max(0, first - OVERSCAN)
  const end = Math.min(total, first + fits + OVERSCAN)
  const rows = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index)

  return (
    <div
      ref={list}
      role="listbox"
      aria-label={label}
      data-list="mail"
      onScroll={(event) => setFirst(Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT))}
      className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-color:var(--color-line2)_transparent] [scrollbar-width:thin]"
    >
      <div style={{ height: total * ROW_HEIGHT }}>
        {rows.map((index) => {
          const id = idAt(index)
          const style = { position: 'absolute', top: index * ROW_HEIGHT, left: 0, right: 0 } as const
          if (!id) return <div key={`empty ${index}`} data-row="" className="mx-1.5 h-[73px]" style={style} />
          return (
            <Row
              key={id}
              id={id}
              slot="time"
              selected={id === selection.selected}
              divider={index > 0 && id !== selection.selected && idAt(index - 1) !== selection.selected}
              onSelect={selection.select}
              style={style}
            />
          )
        })}
      </div>
    </div>
  )
}
