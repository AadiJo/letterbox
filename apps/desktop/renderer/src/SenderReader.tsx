// The reader for a sender in Updates: Mark read and Archive all for all of its mail, its name
// and volume, its newest message open in full, then the rest of its conversations folded to
// one line each and grouped by day: Today, Yesterday and Earlier. A folded line opens in
// place, like a folded message in a conversation, and opening one marks it read.

import type { MailboxId, SenderSummary, ThreadId } from '@letterbox/protocol'
import { Archive, ChevronRight, MailOpen } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'
import { type Mail, markRead } from './actions.ts'
import { Avatar } from './Avatar.tsx'
import { Body } from './Body.tsx'
import { useNow } from './clock.ts'
import type { Chrome } from './Screen.tsx'
import { threadRecord, useThread, useThreadDetail, useThreadSection } from './threads.ts'
import { dayOf, listTime, messageTime } from './time.ts'
import { rate, Strip } from './Volume.tsx'

/** The most conversations of one sender the reader lists. */
const LIMIT = 50

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
            {sender && <span className="font-normal text-muted tabular-nums">{sender.threads}</span>}
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
  const section = useThreadSection({ mailboxId: inbox, sender: sender.id }, LIMIT)
  const [newest, ...rest] = section?.entries ?? []
  const today = rest.filter((entry) => dayOf(entry.lastMessageAt, now) <= 0)
  const yesterday = rest.filter((entry) => dayOf(entry.lastMessageAt, now) === 1)
  const earlier = rest.filter((entry) => dayOf(entry.lastMessageAt, now) > 1)
  // Earlier counts every older conversation the sender has, not only the ones listed.
  const days = [
    { title: 'Today', entries: today, count: today.length },
    { title: 'Yesterday', entries: yesterday, count: yesterday.length },
    {
      title: 'Earlier',
      entries: earlier,
      count: (section?.total ?? 0) - 1 - today.length - yesterday.length,
    },
  ].filter((day) => day.count > 0)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin] wide:px-10">
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
          {newest && <Newest id={newest.id} sender={sender} now={now} />}
          {days.map((day) => (
            <section key={day.title} aria-label={day.title}>
              <h4
                className="flex h-9 items-center border-b border-line pt-1.5 text-caption font-semibold text-section"
                data-field="day"
              >
                {day.title}
                <span className="ml-auto font-normal text-muted tabular-nums" data-field="count">
                  {day.count}
                </span>
              </h4>
              {day.entries.map((entry) => (
                <Folded key={entry.id} id={entry.id} sender={sender} mail={mail} now={now} />
              ))}
            </section>
          ))}
        </div>
      </article>
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
function Newest({ id, sender, now }: { id: ThreadId; sender: SenderSummary; now: number }) {
  const thread = useThreadDetail(id)
  const message = thread?.messages.at(-1)
  if (!thread || !message) return null
  return (
    <section className="border-b border-line pt-5 pb-[26px]" data-message="open">
      <div className="flex items-start gap-3">
        <Avatar who={{ name: sender.name, address: sender.address }} size="sender-open" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 truncate text-subject font-semibold">{thread.subject}</span>
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

/** One older conversation, folded to its subject and time. A click opens it in place and marks it read. */
function Folded({ id, sender, mail, now }: { id: ThreadId; sender: SenderSummary; mail: Mail; now: number }) {
  const thread = useThread(id)
  const [open, setOpen] = useState(false)
  if (open) return <Newest id={id} sender={sender} now={now} />
  if (!thread) return <div className="h-9 border-b border-line wide:h-10" />
  return (
    <button
      type="button"
      onClick={() => {
        setOpen(true)
        const record = threadRecord(id)
        if (record) markRead(record, mail)
      }}
      className="flex h-9 w-full items-center gap-2.5 border-b border-line text-left wide:h-10"
      data-message="folded"
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
      {thread.unread && <span className="size-2 flex-none rounded-full bg-blue" data-field="unread" />}
      <span className="text-meta whitespace-nowrap text-muted tabular-nums" data-field="message-time">
        {listTime(thread.lastMessageAt, now)}
      </span>
    </button>
  )
}
