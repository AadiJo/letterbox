// The reader for a sender in Updates: Mark read and Archive all for all of its mail, its name
// and volume, one conversation open in full (its newest, until another is picked), then every
// other conversation folded to one line, grouped by day: Today and Yesterday with the time of
// day, then Earlier with the day. Opening a conversation marks it read and shows it on top.
// Earlier is windowed like All mail, so every conversation it counts has a line to scroll to.

import type { MailboxId, SenderSummary, ThreadFilter, ThreadId } from '@letterbox/protocol'
import { Archive, ChevronRight, MailOpen } from 'lucide-react'
import { Fragment, type ReactNode, type RefObject, useEffect, useEffectEvent, useRef, useState } from 'react'
import { type Mail, markRead } from './actions.ts'
import { Avatar } from './Avatar.tsx'
import { Body } from './Body.tsx'
import { useNow } from './clock.ts'
import { rangeFor } from './MailScreen.tsx'
import type { Chrome } from './Screen.tsx'
import { type Entry, threadRecord, useThread, useThreadDetail, useThreadSection, useThreadWindow } from './threads.ts'
import { clockTime, dayOf, listTime, messageTime } from './time.ts'
import { rate, Strip } from './Volume.tsx'

/** The newest conversations the reader groups into Today and Yesterday. More in two days is rare. */
const RECENT = 200
/** A folded line's height, and a day heading's, in px. Earlier's window places lines by them. */
const LINE = 40
const HEADING = 36

type Props = {
  /** The open sender, or undefined for none. */
  sender: SenderSummary | undefined
  inbox: MailboxId
  /** The busiest day of any sender in the list, so this strip matches its row. */
  most: number
  chrome: Chrome
  onMarkRead: (sender: SenderSummary) => void
  onArchive: (sender: SenderSummary) => void
}

export function SenderReader({ sender, inbox, most, chrome, onMarkRead, onArchive }: Props) {
  const outlined =
    'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-row font-medium whitespace-nowrap text-fg shadow-outline enabled:hover:bg-hover disabled:text-faint'
  const unread = sender?.unread ?? 0
  return (
    <>
      {/* The toolbar band, as Toolbar.tsx draws it for a conversation. */}
      <div className="top-band relative z-20 bg-reader px-6 wide:px-10">
        <div className="reading-column flex items-center gap-2">
          <button
            type="button"
            disabled={unread === 0}
            onClick={() => sender && onMarkRead(sender)}
            className={`mr-2 ${outlined}`}
          >
            <MailOpen className="size-4" strokeWidth={1.75} aria-hidden />
            {unread > 0 ? `Mark ${unread} read` : 'All read'}
          </button>
          <button type="button" disabled={!sender} onClick={() => sender && onArchive(sender)} className={outlined}>
            <Archive className="size-4" strokeWidth={1.75} aria-hidden />
            Archive all
            {sender && (
              <span className="font-normal text-muted tabular-nums" data-field="archive-count">
                {sender.threads}
              </span>
            )}
          </button>
          <span className="flex-1" />
          {chrome.search}
        </div>
      </div>
      {sender ? (
        <SenderMail key={sender.id} sender={sender} inbox={inbox} most={most} mail={chrome.mail} />
      ) : (
        <p className="m-auto text-row text-faint">No sender selected</p>
      )}
    </>
  )
}

type MailProps = { sender: SenderSummary; inbox: MailboxId; most: number; mail: Mail }

function SenderMail({ sender, inbox, most, mail }: MailProps) {
  const now = useNow()
  const filter: ThreadFilter = { mailboxId: inbox, sender: sender.id }
  const recent = useThreadSection(filter, RECENT)
  const scroller = useRef<HTMLDivElement>(null)
  const [picked, setPicked] = useState<ThreadId | null>(null)
  const newest = recent?.entries[0]?.id
  const open = picked ?? newest
  // The lines leave out the newest while it is the open one. Another open one keeps its line.
  const skip = newest !== undefined && open === newest ? 1 : 0
  const listed = (recent?.entries ?? []).slice(skip)
  const today = listed.filter((entry) => dayOf(entry.lastMessageAt, now) <= 0)
  const yesterday = listed.filter((entry) => dayOf(entry.lastMessageAt, now) === 1)
  const earlierFrom = skip + today.length + yesterday.length
  const earlierCount = Math.max(0, (recent?.total ?? 0) - earlierFrom)

  // Opening a conversation marks it read, as opening one anywhere does: once per opening.
  const markOpened = useEffectEvent((id: ThreadId) => {
    const record = threadRecord(id)
    if (record) markRead(record, mail)
  })
  useEffect(() => {
    if (open) markOpened(open)
  }, [open])

  const pick = (id: ThreadId) => {
    setPicked(id)
    scroller.current?.scrollTo({ top: 0 })
  }
  const line = (entry: Entry, time: string) => (
    <Folded key={entry.id} id={entry.id} time={time} current={entry.id === open} onOpen={pick} />
  )
  return (
    <div
      ref={scroller}
      className="relative min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin] wide:px-10"
    >
      <article aria-label="Sender" className="reading-column">
        <header>
          <h3 className="cap-top text-title font-semibold tracking-[-0.02em]" data-field="reader-subject">
            {sender.name ?? sender.address}
          </h3>
          <div className="mt-2 flex items-center gap-2 text-addr whitespace-nowrap text-muted" data-field="reason">
            <Dotted
              parts={[
                <b key="rate" className="inline-flex items-center gap-1.5 font-medium text-fg">
                  <Strip days={sender.days} most={most} />
                  <span className="ml-1" data-field="rate">
                    {rate(sender.days)}
                  </span>
                </b>,
                sender.unread > 0 ? `${sender.unread} unread` : null,
                `${sender.messages} ${sender.messages === 1 ? 'message' : 'messages'}`,
              ]}
            />
          </div>
        </header>
        <div className="mt-3 border-t border-line wide:mt-6">
          {open && <OpenMessage key={open} id={open} sender={sender} now={now} />}
          {today.length > 0 && (
            <Day title="Today" count={today.length}>
              {today.map((entry) => line(entry, clockTime(entry.lastMessageAt)))}
            </Day>
          )}
          {yesterday.length > 0 && (
            <Day title="Yesterday" count={yesterday.length}>
              {yesterday.map((entry) => line(entry, clockTime(entry.lastMessageAt)))}
            </Day>
          )}
          {earlierCount > 0 && (
            <Day title="Earlier" count={earlierCount}>
              <Earlier
                filter={filter}
                from={earlierFrom}
                count={earlierCount}
                scroller={scroller}
                render={(entry) => line(entry, listTime(entry.lastMessageAt, now))}
              />
            </Day>
          )}
        </div>
      </article>
    </div>
  )
}

/** One day's heading and its lines. */
function Day({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h4
        className="flex items-center border-b border-line pt-1.5 text-caption font-semibold text-section"
        style={{ height: HEADING }}
        data-field="day"
      >
        {title}
        <span className="ml-auto font-normal text-muted tabular-nums" data-field="count">
          {count}
        </span>
      </h4>
      {children}
    </section>
  )
}

type EarlierProps = {
  filter: ThreadFilter
  /** Where Earlier starts in the sender's list, and how many it holds. */
  from: number
  count: number
  scroller: RefObject<HTMLDivElement | null>
  render: (entry: Entry) => ReactNode
}

/**
 * Earlier's lines on screen plus a small overscan, with spacers for the rest. It follows the
 * reader's scroll, and subscribes only to the lines it shows.
 */
function Earlier({ filter, from, count, scroller, render }: EarlierProps) {
  const { slice, show } = useThreadWindow(filter)
  const body = useRef<HTMLDivElement>(null)
  const [first, setFirst] = useState(0)
  const [fits, setFits] = useState(0)

  // Follows the reader's scroll and height, which set the lines on screen, and the column's
  // height: when the open message's body arrives, or Today fills in, Earlier starts lower.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const follow = () => {
      const top = body.current?.offsetTop ?? 0
      setFirst(Math.max(0, Math.floor((element.scrollTop - top) / LINE)))
      setFits(Math.ceil(element.clientHeight / LINE) + 1)
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    element.addEventListener('scroll', follow)
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', follow)
    }
  }, [scroller])

  const range = rangeFor(first, fits)
  useEffect(() => {
    show({ offset: from + range.offset, limit: range.limit })
  }, [show, from, range.offset, range.limit])

  const start = Math.min(count, range.offset)
  const end = Math.min(count, range.offset + range.limit)
  const at = (index: number) => (slice ? slice.entries[from + index - slice.offset] : undefined)
  return (
    <div ref={body}>
      <div style={{ height: start * LINE }} />
      {Array.from({ length: Math.max(0, end - start) }, (_, index) => {
        const entry = at(start + index)
        return entry ? (
          render(entry)
        ) : (
          <div key={`empty ${start + index}`} className="border-b border-line" style={{ height: LINE }} />
        )
      })}
      <div style={{ height: Math.max(0, count - end) * LINE }} />
    </div>
  )
}

/** The parts that are there, with a quiet dot between each two. */
function Dotted({ parts }: { parts: readonly ReactNode[] }) {
  return parts
    .filter((part) => part !== null)
    .map((part, index) => (
      <Fragment key={index}>
        {index > 0 && (
          <span aria-hidden className="text-sep">
            ·
          </span>
        )}
        {part}
      </Fragment>
    ))
}

/** A conversation's newest message, open: the sender's mark, the subject in the name's place, then the body. */
function OpenMessage({ id, sender, now }: { id: ThreadId; sender: SenderSummary; now: number }) {
  const thread = useThreadDetail(id)
  const message = thread?.messages.at(-1)
  if (!thread || !message) return null
  return (
    <section className="border-b border-line pt-5 pb-[26px]" data-message="open">
      <div className="flex items-start gap-3">
        <Avatar who={{ name: sender.name, address: sender.address }} size="sender-open" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 truncate text-subject font-semibold" data-field="open-subject">
              {thread.subject}
            </span>
            <span className="ml-auto text-meta whitespace-nowrap text-muted tabular-nums" data-field="message-time">
              {messageTime(message.sentAt, now)}
            </span>
          </div>
          <div className="truncate text-addr text-muted">{message.from.address} · to you</div>
        </div>
      </div>
      <div className="mt-[18px]">
        <Body body={message.body} />
      </div>
    </section>
  )
}

type FoldedProps = { id: ThreadId; time: string; current: boolean; onOpen: (id: ThreadId) => void }

/**
 * One conversation, folded to its subject and time. The unread dot has its own slot and the
 * time a right-aligned column as wide as "12:00 PM", so neither moves with the other's width.
 */
function Folded({ id, time, current, onOpen }: FoldedProps) {
  const thread = useThread(id)
  if (!thread) return <div className="border-b border-line" style={{ height: LINE }} />
  return (
    <button
      type="button"
      aria-current={current || undefined}
      onClick={() => onOpen(id)}
      className={`flex w-full items-center gap-2.5 border-b border-line text-left ${current ? 'bg-hover' : ''}`}
      style={{ height: LINE }}
      data-message="folded"
      data-thread={id}
      data-unread={thread.unread}
    >
      <span className="flex w-4 flex-none justify-center text-muted">
        <ChevronRight className="size-3.5" strokeWidth={2} aria-hidden />
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-row ${thread.unread ? 'font-semibold text-fg' : 'text-fg2'}`}
        data-field="subject"
      >
        {thread.subject}
      </span>
      <span className="flex w-2 flex-none justify-center">
        {thread.unread && <span className="size-2 rounded-full bg-blue" data-field="unread" />}
      </span>
      <span
        className="min-w-[58px] text-right text-meta whitespace-nowrap text-muted tabular-nums"
        data-field="message-time"
      >
        {time}
      </span>
    </button>
  )
}
