// One conversation in a list. Every list uses it, at one fixed height, selected or not.

import type { Person, ThreadId, ThreadSummary } from '@letterbox/protocol'
import { Flag, Hourglass, Paperclip, Reply } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useNow } from './clock.ts'
import { useThread } from './threads.ts'
import { age, isLate, listTime } from './time.ts'

/** Every row's height in px. The windowed list places rows by it. */
export const ROW_HEIGHT = 73

/**
 * The one time a row shows. `turn`: a reply arrow and how long the turn has waited, amber
 * once late. `wait`: an hourglass and how long since I wrote. `time`: when it last moved.
 */
export type Slot = 'turn' | 'wait' | 'time'

/** Who a row is with: the first person who is not me. The core lists only who wrote, so it can be me. */
export const otherPerson = (thread: ThreadSummary): Person | undefined =>
  thread.people.find((person) => !person.isMe) ?? thread.people[0]

export const personName = (person: Person | undefined) => (person ? (person.name ?? person.address) : '')

type Props = {
  id: ThreadId
  slot: Slot
  selected: boolean
  /** Draws the hairline above the row. Off for a section's first row and next to the selection. */
  divider: boolean
  onSelect: (id: ThreadId) => void
  /** Absolute placement, for a windowed list. */
  style?: CSSProperties
}

export function Row({ id, slot, selected, divider, onSelect, style }: Props) {
  const thread = useThread(id)
  const now = useNow()
  const base = 'relative mx-1.5 flex h-[73px] gap-2 rounded-lg pt-2 pr-3 pb-[9px] pl-2'
  const line = divider
    ? "before:absolute before:top-0 before:right-1.5 before:left-7 before:h-px before:bg-hair before:content-['']"
    : ''
  if (!thread) return <div role="option" aria-selected={selected} data-row={id} className={base} style={style} />

  // The open conversation counts as read. Read rows step down in brightness, never in the sender's weight.
  const unread = thread.unread && !selected
  const late = slot === 'turn' && isLate(thread.lastMessageAt, now)
  return (
    <div
      role="option"
      aria-selected={selected}
      data-row={id}
      data-unread={unread}
      onClick={() => onSelect(id)}
      className={`${base} ${line} cursor-default ${selected ? 'bg-sel' : ''}`}
      style={style}
    >
      <div className="flex w-3.5 flex-none justify-center pt-[5px]">
        {unread && <span className="size-2 rounded-full bg-blue" data-field="unread" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 shrink truncate text-[13px] font-semibold ${unread ? 'text-fg' : 'text-fg2'}`}
            data-field="person"
          >
            {personName(otherPerson(thread))}
          </span>
          {thread.messageCount > 1 && (
            <span
              className={`flex-none rounded-full px-1.5 text-[11px] leading-4 font-medium tabular-nums ${selected ? 'bg-pill-sel text-fg' : 'bg-pill text-fg2'}`}
            >
              {thread.messageCount}
            </span>
          )}
          {thread.hasAttachments && (
            <Paperclip aria-label="Has attachments" className="size-[13px] text-muted" strokeWidth={2} />
          )}
          {thread.flagged && <Flag aria-label="Flagged" className="size-[13px] text-muted" strokeWidth={2} />}
          <RowTime slot={slot} time={thread.lastMessageAt} now={now} late={late} />
        </div>
        <div className={`truncate text-[13px] ${unread ? 'font-medium text-fg' : 'text-fg2'}`} data-field="subject">
          {thread.subject}
        </div>
        <div className="mt-px truncate text-[12.5px] leading-[1.4] text-muted">{thread.snippet}</div>
      </div>
    </div>
  )
}

function RowTime({ slot, time, now, late }: { slot: Slot; time: string; now: number; late: boolean }) {
  const icon = { className: 'size-[13px]', strokeWidth: 2, 'aria-hidden': true } as const
  return (
    <span
      className={`ml-auto inline-flex flex-none items-center gap-[5px] text-xs whitespace-nowrap tabular-nums ${late ? 'font-medium text-amber' : 'text-muted'}`}
      data-field={slot === 'time' ? 'time' : 'age'}
      data-late={late}
    >
      {slot === 'turn' && <Reply {...icon} />}
      {slot === 'wait' && <Hourglass {...icon} />}
      <time dateTime={time}>{slot === 'time' ? listTime(time, now) : age(time, now)}</time>
    </span>
  )
}
