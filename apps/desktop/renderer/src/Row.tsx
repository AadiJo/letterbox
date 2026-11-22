// One conversation in a list, and one sender in Updates. Every list uses them, at one fixed
// height, selected or not. Unread rows are bright and their subject is the row's only
// semibold line. Read rows step down in brightness. The selected row is raised above the list.

import type { Person, SenderId, SenderSummary, ThreadId, ThreadSummary } from '@letterbox/protocol'
import { Archive, Flag, Hourglass, MailOpen } from 'lucide-react'
import type { MouseEvent } from 'react'
import { Avatar } from './Avatar.tsx'
import { useNow } from './clock.ts'
import { cx } from './cx.ts'
import { LabelChip, useLabels } from './Label.tsx'
import { trackRow, useExit } from './motion.ts'
import { useThread } from './threads.ts'
import { age, isLate, listTime } from './time.ts'
import { rate, Strip } from './Volume.tsx'

/** Every row's height in px. The windowed list sizes its scroll area by it. */
export const ROW_HEIGHT = 78

/**
 * The one time a row shows. `turn`: how long the turn has waited, amber once late. `waited`:
 * the same, never amber, for Let go?, where every turn is old. `wait`: an hourglass and how
 * long since I wrote. `time`: when it last moved.
 */
export type Slot = 'turn' | 'waited' | 'wait' | 'time'

/** Every row's box, clipped so it can fold closed when it leaves (motion.ts). */
const shell = cx('relative mx-2 flex h-[78px] overflow-hidden rounded-[9px] py-2.5 pr-3.5 pl-1')

/** The hairline above a row. */
const hairline = cx(
  "before:absolute before:top-0 before:right-3.5 before:left-[22px] before:h-px before:bg-line before:content-['']",
)

/**
 * Who a row is with: the first person who is not me. The core lists everyone a message was
 * from, to or cc'd, so this is me only in a conversation with nobody else.
 */
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
  /** Shown only while it leaves: the list no longer has it (motion.ts `useHeld`). */
  held: boolean
}

export function Row({ id, slot, selected, divider, onSelect, held }: Props) {
  const thread = useThread(id)
  const now = useNow()
  const labels = useLabels(thread?.mailboxIds ?? [])
  useExit(id, held)
  const base = `${shell} gap-1`
  const line = divider ? hairline : ''
  if (!thread) return <div ref={trackRow(id)} role="option" aria-selected={selected} data-row={id} className={base} />

  // The open conversation counts as read.
  const unread = thread.unread && !selected
  const bright = unread || selected
  const late = slot === 'turn' && isLate(thread.lastMessageAt, now)
  return (
    <div
      ref={trackRow(id)}
      role="option"
      aria-selected={selected}
      data-row={id}
      data-unread={unread}
      onClick={() => onSelect(id)}
      className={`${base} ${line} cursor-default ${selected ? 'z-[1] bg-sel shadow-raised' : ''}`}
    >
      <div className="flex w-[18px] flex-none justify-center pt-[5px]">
        {unread && <span className="size-2 rounded-full bg-blue" data-field="unread" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 shrink truncate text-row font-medium ${bright ? 'text-fg' : 'text-read'}`}
            data-field="person"
          >
            {personName(otherPerson(thread))}
          </span>
          {thread.messageCount > 1 && (
            <span className="flex-none rounded-full bg-pill px-1.5 text-key font-medium text-fg2 tabular-nums">
              {thread.messageCount}
            </span>
          )}
          {labels.map((name) => (
            <LabelChip key={name} name={name} compact />
          ))}
          {thread.flagged && (
            <Flag aria-label="Flagged" className="size-[13px] flex-none text-muted" strokeWidth={1.75} />
          )}
          <RowTime slot={slot} time={thread.lastMessageAt} now={now} late={late} />
        </div>
        <div
          className={`mt-px truncate text-subject ${unread ? 'font-semibold text-fg' : selected ? 'text-fg' : 'text-read2'}`}
          data-field="subject"
        >
          {thread.subject}
        </div>
        <div className="mt-px truncate text-row text-muted">{thread.snippet}</div>
      </div>
    </div>
  )
}

function RowTime({ slot, time, now, late }: { slot: Slot; time: string; now: number; late: boolean }) {
  return (
    <span
      className={`ml-auto inline-flex flex-none items-center gap-1.5 pl-2 text-meta whitespace-nowrap tabular-nums ${late ? 'font-medium text-amber' : 'text-muted'}`}
      data-field={slot === 'time' ? 'time' : 'age'}
      data-late={late}
    >
      {slot === 'wait' && <Hourglass className="size-[13px]" strokeWidth={1.75} aria-hidden />}
      <time dateTime={time}>{slot === 'time' ? listTime(time, now) : age(time, now)}</time>
    </span>
  )
}

/** A button on a sender row. It acts without opening the sender. */
function RowButton({ label, Glyph, run }: { label: string; Glyph: typeof Archive; run: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        run()
      }}
      className="inline-flex size-7 items-center justify-center rounded-[7px] text-fg2 hover:bg-hover hover:text-fg"
    >
      <Glyph className="size-4" strokeWidth={1.75} aria-hidden />
    </button>
  )
}

type SenderRowProps = {
  sender: SenderSummary
  /** The busiest day of any row in the list, so the strips compare. */
  most: number
  selected: boolean
  divider: boolean
  onSelect: (id: SenderId) => void
  /** Marks all of the sender's mail read, and archives all of it: the hovered row's buttons. */
  onMarkRead: (sender: SenderSummary) => void
  onArchive: (sender: SenderSummary) => void
}

/**
 * One sender in Updates: its square mark, its name and unread count, its newest subject, and
 * its volume. On hover, Mark read and Archive all take the time's place.
 */
export function SenderRow({ sender, most, selected, divider, onSelect, onMarkRead, onArchive }: SenderRowProps) {
  const now = useNow()
  const unread = sender.unread > 0 && !selected
  const bright = unread || selected
  return (
    <div
      role="option"
      aria-selected={selected}
      data-sender={sender.id}
      data-unread={unread}
      onClick={() => onSelect(sender.id)}
      className={`group ${shell} gap-2.5 ${divider ? hairline : ''} cursor-default ${selected ? 'z-[1] bg-sel shadow-raised' : 'hover:bg-hover'}`}
    >
      <div className="-mr-1.5 flex w-2.5 flex-none justify-center pt-[5px]">
        {unread && <span className="size-2 rounded-full bg-blue" data-field="unread" />}
      </div>
      <span className="pt-px">
        <Avatar who={{ name: sender.name, address: sender.address }} size="sender" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex h-[18px] min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 shrink truncate text-row font-medium ${bright ? 'text-fg' : 'text-read'}`}
            data-field="person"
          >
            {sender.name ?? sender.address}
          </span>
          {sender.unread > 0 && (
            <span
              className="flex-none rounded-full bg-pill px-1.5 text-key font-medium text-fg2 tabular-nums"
              data-field="unread-count"
            >
              {sender.unread}
            </span>
          )}
          <span className="ml-auto flex group-hover:hidden">
            <RowTime slot="time" time={sender.lastMessageAt} now={now} late={false} />
          </span>
          <span className="-my-[5px] ml-auto hidden flex-none items-center gap-0.5 group-hover:flex">
            {sender.unread > 0 && <RowButton label="Mark read" Glyph={MailOpen} run={() => onMarkRead(sender)} />}
            <RowButton label="Archive all" Glyph={Archive} run={() => onArchive(sender)} />
          </span>
        </div>
        <div
          className={`mt-px truncate text-subject ${unread ? 'font-semibold text-fg' : selected ? 'text-fg' : 'text-read2'}`}
          data-field="subject"
        >
          {sender.subject}
        </div>
        <div className="mt-[5px] flex h-3.5 items-center gap-2 text-meta whitespace-nowrap text-muted">
          <Strip days={sender.days} most={most} />
          <span data-field="rate">{rate(sender.days)}</span>
        </div>
      </div>
    </div>
  )
}
