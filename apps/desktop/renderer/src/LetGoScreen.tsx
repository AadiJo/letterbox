// Let go?: conversations where my turn has waited 30 days or more, which the core moves out
// of Your turn (`retired: true`), newest first, grouped by the month they last moved: last
// month, the month before, then the rest, where a month too small for a heading joins the rest. Let go takes Done's place in the toolbar, with
// its key d: it hands the turn to nobody, and the toast's Undo (or z) brings it back.

import type { Account, ThreadFilter, ThreadId } from '@letterbox/protocol'
import { useEffect, useRef } from 'react'
import { useNow } from './clock.ts'
import { useHeld } from './motion.ts'
import { Row } from './Row.tsx'
import { type Chrome, Screen, useSelection } from './Screen.tsx'
import { type Entry, useThreadSection } from './threads.ts'
import { monthOf, monthTitle } from './time.ts'
import { notify, notifyLetGo } from './undo.ts'

/** The most conversations the pile asks the core for. The core sends the newest first. */
const LIMIT = 200

const LET_GO: ThreadFilter = { turn: 'mine', retired: true }

/** The pile, newest first, and how many it holds. Undefined until the core answers. */
export const useLetGo = () => useThreadSection(LET_GO, LIMIT)

type Month = { title: string; ids: readonly ThreadId[]; count: number }

/** The local month a turn last moved in (time.ts `monthOf`). */
const monthOfEntry = (entry: Entry) => monthOf(Date.parse(entry.lastMessageAt))

/** A month keeps a heading of its own only with this many turns. A smaller one joins the older ones. */
const OWN_MONTH = 3

/**
 * The pile by month: last month and the month before, each with a heading of its own, then
 * "… and older", which counts every older turn, listed or not. A turn waits 30 days to get
 * here, so last month holds the newest, and the headings stay put as turns leave. A month
 * with nothing is left out. From the first month with fewer than OWN_MONTH turns, the rest
 * go under "… and older", so no heading stands over one or two rows.
 */
function byMonth(entries: readonly Entry[], total: number, now: number): Month[] {
  // On the 31st, a turn from the 1st has waited 30 days, so last month's heading takes it too.
  const last = monthOf(now) - 1
  const months: Month[] = []
  let older = last - 2
  for (const month of [last, last - 1]) {
    const ids = entries
      .filter((entry) => (month === last ? monthOfEntry(entry) >= last : monthOfEntry(entry) === month))
      .map((entry) => entry.id)
    if (ids.length === 0) continue
    if (ids.length < OWN_MONTH) {
      older = month
      break
    }
    months.push({ title: monthTitle(month, now), ids, count: ids.length })
  }
  const taken = new Set(months.flatMap((month) => month.ids))
  const rest = entries.filter((entry) => !taken.has(entry.id))
  const shown = months.reduce((sum, month) => sum + month.count, 0)
  if (total > shown)
    months.push({
      title: `${monthTitle(older, now)} and older`,
      ids: rest.map((entry) => entry.id),
      count: total - shown,
    })
  return months
}

export function LetGoScreen({ chrome, accounts }: { chrome: Chrome; accounts: readonly Account[] }) {
  const pile = useLetGo()
  const now = useNow()
  const order = pile?.entries.map((entry) => entry.id) ?? []
  // Let go hands the turn to nobody, which takes the conversation out of the pile.
  const selection = useSelection(
    order,
    chrome.mail,
    (command) => command.kind === 'set-turn' && command.turn === 'none',
    (action, thread, change) =>
      action === 'done' ? notifyLetGo(thread.id, thread.subject, change) : notify(action, thread.id, change),
  )
  const list = useRef<HTMLDivElement>(null)

  // Keeps the selected row on screen when the keyboard moves past the edge.
  useEffect(() => {
    if (selection.selected)
      list.current?.querySelector(`[data-row="${selection.selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selection.selected])

  const total = pile?.total ?? 0
  const subtitle = pile
    ? {
        wide: `${total} ${total === 1 ? 'turn' : 'turns'} waited over 30 days`,
        narrow: `${total} waited over 30 days`,
      }
    : 'Loading'
  const months = pile ? byMonth(pile.entries, total, now) : []
  return (
    <Screen title="Let go?" subtitle={subtitle} chrome={chrome} accounts={accounts} selection={selection} letGo>
      <div
        ref={list}
        className="min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin]"
      >
        {months.map((month) => (
          <MonthSection key={month.title} month={month} selection={selection} />
        ))}
        {pile && total === 0 && (
          <p className="animate-appear px-5 pt-[22px] text-row text-muted" data-field="empty">
            No turn has waited over 30 days
          </p>
        )}
      </div>
    </Screen>
  )
}

function MonthSection({ month, selection }: { month: Month; selection: ReturnType<typeof useSelection> }) {
  const { selected, select } = selection
  const { rows, held } = useHeld(month.ids)
  return (
    <section aria-label={month.title}>
      <h3 className="flex h-[34px] items-center pr-5 pl-[22px] text-meta font-semibold text-fg2" data-field="month">
        {month.title}
        {/* Keyed by the count, so a new count drops into place. */}
        <span key={month.count} className="ml-auto animate-tick font-medium text-muted tabular-nums" data-field="count">
          {month.count}
        </span>
      </h3>
      <div role="listbox" aria-label={month.title}>
        {rows.map((id, index) => (
          <Row
            key={id}
            id={id}
            slot="waited"
            selected={id === selected}
            divider={index > 0 && id !== selected && rows[index - 1] !== selected}
            onSelect={select}
            held={held.has(id)}
          />
        ))}
      </div>
    </section>
  )
}
