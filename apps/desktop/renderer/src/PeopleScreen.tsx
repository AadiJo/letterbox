// People: conversations where it is my turn, newest first, then those waiting on someone
// else. Conversations quiet for more than 30 days leave People; a later Let go? view will hold them.

import type { ThreadId } from '@letterbox/protocol'
import { CircleCheck, Hourglass, Reply, type LucideIcon } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { useNow } from './clock.ts'
import { useHeld } from './motion.ts'
import { Row, type Slot } from './Row.tsx'
import { type Chrome, Screen, useSelection } from './Screen.tsx'
import { type Entry, useThreadSection } from './threads.ts'
import { isLate, isRetired } from './time.ts'
import type { Account } from '@letterbox/protocol'

/** The most conversations one section asks the core for. The core sends the newest first. */
const LIMIT = 200

/** Both People sections, without conversations older than 30 days. Undefined until the core answers. */
export function usePeople() {
  const now = useNow()
  const mine = useThreadSection({ turn: 'mine' }, LIMIT)
  const theirs = useThreadSection({ turn: 'theirs' }, LIMIT)
  if (!mine || !theirs) return undefined
  const fresh = (entries: readonly Entry[]) => entries.filter((entry) => !isRetired(entry.lastMessageAt, now))
  const yours = fresh(mine.entries)
  return {
    mine: yours.map((entry) => entry.id),
    theirs: fresh(theirs.entries).map((entry) => entry.id),
    late: yours.some((entry) => isLate(entry.lastMessageAt, now)),
  }
}

export function PeopleScreen({ chrome, accounts }: { chrome: Chrome; accounts: readonly Account[] }) {
  const people = usePeople()
  const order = people ? [...people.mine, ...people.theirs] : []
  // Done hands the turn to nobody, which takes the conversation out of both sections.
  const selection = useSelection(
    order,
    chrome.mail,
    (command) => command.kind === 'set-turn' && command.turn === 'none',
  )
  const list = useRef<HTMLDivElement>(null)

  // Keeps the selected row on screen when the keyboard moves past the edge.
  useEffect(() => {
    if (selection.selected)
      list.current?.querySelector(`[data-row="${selection.selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selection.selected])

  const subtitle = people ? `${people.mine.length} wait on you · ${people.theirs.length} waiting on others` : 'Loading'
  return (
    <Screen title="People" subtitle={subtitle} chrome={chrome} accounts={accounts} selection={selection}>
      <div
        ref={list}
        className="min-h-0 flex-1 overflow-y-auto pb-1 [scrollbar-color:var(--color-line2)_transparent] [scrollbar-width:thin]"
      >
        {people && (
          <>
            <Section
              title="Your turn"
              icon={Reply}
              slot="turn"
              ids={people.mine}
              selection={selection}
              empty={<NothingWaits />}
            />
            <Section title="Waiting on others" icon={Hourglass} slot="wait" ids={people.theirs} selection={selection} />
          </>
        )}
      </div>
    </Screen>
  )
}

type SectionProps = {
  title: string
  icon: LucideIcon
  slot: Slot
  ids: readonly ThreadId[]
  selection: ReturnType<typeof useSelection>
  /** What the section shows once its last row has gone. */
  empty?: ReactNode
}

function Section({ title, icon: Icon, slot, ids, selection, empty }: SectionProps) {
  const { selected, select } = selection
  const { rows, held } = useHeld(ids)
  return (
    <section aria-label={title}>
      <h3 className="flex items-center gap-[7px] px-[18px] pt-3 pb-1.5 text-xs font-semibold text-fg2">
        <Icon className="size-3.5 text-muted" strokeWidth={1.75} aria-hidden />
        {title}
        {/* Keyed by the count, so a new count drops into place. */}
        <span key={ids.length} className="ml-auto animate-tick font-medium text-muted tabular-nums" data-field="count">
          {ids.length}
        </span>
      </h3>
      <div role="listbox" aria-label={title}>
        {rows.map((id, index) => (
          <Row
            key={id}
            id={id}
            slot={slot}
            selected={id === selected}
            divider={index > 0 && id !== selected && rows[index - 1] !== selected}
            onSelect={select}
            held={held.has(id)}
          />
        ))}
      </div>
      {rows.length === 0 && empty}
    </section>
  )
}

/** Your turn with nothing in it. */
function NothingWaits() {
  return (
    <div className="flex animate-appear flex-col items-center gap-1.5 px-[18px] pt-[22px] pb-[18px]" data-field="empty">
      <CircleCheck className="size-7 text-green" strokeWidth={1.75} aria-hidden />
      <b className="text-[13.5px] font-semibold">Nothing waits on you</b>
    </div>
  )
}
