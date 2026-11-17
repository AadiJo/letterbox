// The open conversation: subject, whose turn and why, then its messages. Earlier messages
// fold to one line each and the newest is open, as is any reply of the user's still on its
// way or not sent. Bodies load through the core's thread view. The reply editor docks below.

import type { Mailbox, Message, MessageId, Person, ThreadDetail, ThreadId, TurnState } from '@letterbox/protocol'
import { ChevronRight, Hourglass, Reply } from 'lucide-react'
import { useState } from 'react'
import { Body } from './Body.tsx'
import { Dock } from './Composer.tsx'
import { DeliveryMark, NotSent } from './Delivery.tsx'
import { useNow } from './clock.ts'
import { otherPerson, personName } from './Row.tsx'
import { useThreadDetail } from './threads.ts'
import { isLate, messageTime } from './time.ts'

export function Reader({ id, mailboxes }: { id: ThreadId | null; mailboxes: readonly Mailbox[] }) {
  if (!id) return <p className="m-auto text-[13px] text-faint">No conversation selected</p>
  return <Conversation key={id} id={id} mailboxes={mailboxes} />
}

function Conversation({ id, mailboxes }: { id: ThreadId; mailboxes: readonly Mailbox[] }) {
  const thread = useThreadDetail(id)
  const now = useNow()
  const [opened, setOpened] = useState<ReadonlySet<MessageId>>(new Set())
  if (thread === undefined) return null
  if (thread === null) return <p className="m-auto text-[13px] text-faint">This conversation is gone</p>

  const labels = mailboxes.filter((mailbox) => mailbox.role === null && thread.mailboxIds.includes(mailbox.id))
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? 'message' : 'messages'}`
  const newest = thread.messages.at(-1)?.id
  return (
    <article aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
      {/* The header and messages fill the pane, 40 px in from each side. Only plain-text paragraphs are capped (Body.tsx). */}
      <header className="mx-10 border-b border-line pt-3.5 pb-4">
        <h3 className="text-[22px] leading-[1.25] font-semibold tracking-[-0.015em]" data-field="reader-subject">
          {thread.subject}
        </h3>
        <div className="mt-2 flex items-center gap-1.5 text-[13px] text-muted" data-field="reason">
          <Turn turn={thread.turn} late={isLate(thread.lastMessageAt, now)} />
          <span>{reasonText(thread)}</span>
        </div>
        <div className="mt-[3px] text-[12.5px] text-faint">
          {[...labels.map((label) => label.name), count].join(' · ')}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-1 [scrollbar-color:var(--color-line2)_transparent] [scrollbar-width:thin]">
        {thread.messages.map((message) =>
          message.id === newest || message.delivery || opened.has(message.id) ? (
            <OpenMessage key={message.id} thread={thread} message={message} now={now} />
          ) : (
            <FoldedMessage
              key={message.id}
              from={known(thread, message.from)}
              message={message}
              now={now}
              onOpen={() => setOpened(new Set([...opened, message.id]))}
            />
          ),
        )}
      </div>
      <Dock thread={thread} />
    </article>
  )
}

/** "Your turn" or "Waiting on Maya", then the separator. Nothing when the turn is nobody's. */
function Turn({ turn, late }: { turn: TurnState; late: boolean }) {
  if (turn.holder === 'none') return null
  const icon = { className: 'size-3.5', strokeWidth: 1.75, 'aria-hidden': true } as const
  return (
    <>
      <b
        className={`inline-flex items-center gap-1.5 font-medium ${turn.holder === 'mine' && late ? 'text-amber' : 'text-fg'}`}
      >
        {turn.holder === 'mine' ? <Reply {...icon} /> : <Hourglass {...icon} />}
        {turn.holder === 'mine' ? 'Your turn' : 'Waiting on them'}
      </b>
      <span className="text-faint">·</span>
    </>
  )
}

const firstName = (person: Person | undefined) => personName(person).split(' ')[0] ?? ''

/** Why the core gave the turn to whoever has it, in words. */
function reasonText(thread: ThreadDetail) {
  switch (thread.turn.reason) {
    case 'they-wrote-last':
      return `${firstName(otherPerson(thread))} wrote last`
    case 'i-wrote-last':
      return 'You wrote last'
    case 'automated':
      return 'Sent automatically'
    case 'not-addressed-to-me':
      return 'Not addressed to you'
    case 'asks-nothing':
      return 'Asks nothing of you'
    case 'set-by-user':
      return 'You set this'
  }
}

const initials = (person: Person) =>
  (person.name ?? person.address)
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

const who = (person: Person) => (person.isMe ? 'You' : personName(person))

/**
 * `person` with the name the conversation knows them by, when the message itself gives none,
 * as on a reply the core has not sent yet, which carries bare addresses.
 */
const known = (thread: ThreadDetail, person: Person) =>
  person.name !== null
    ? person
    : (thread.people.find(
        (other) => other.name !== null && other.address.toLowerCase() === person.address.toLowerCase(),
      ) ?? person)

function Avatar({ person, small }: { person: Person; small?: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex flex-none items-center justify-center rounded-full bg-raised font-semibold text-fg2 shadow-[inset_0_0_0_1px_var(--color-line2)] ${small ? 'size-6 text-[10.5px]' : 'size-8 text-[11.5px]'}`}
    >
      {initials(person)}
    </span>
  )
}

type FoldedProps = { from: Person; message: Message; now: number; onOpen: () => void }

function FoldedMessage({ from, message, now, onOpen }: FoldedProps) {
  const preview = message.body.state === 'ready' ? message.body.text.replace(/\s+/g, ' ').trim() : ''
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 border-b border-hair py-[11px] text-left"
      data-message="folded"
    >
      <span className="flex w-3.5 flex-none justify-center text-muted">
        <ChevronRight className="size-[13px]" strokeWidth={2} aria-hidden />
      </span>
      <Avatar person={from} small />
      <span className="flex-none text-[13.5px] font-semibold whitespace-nowrap">{who(from)}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{preview}</span>
      <span className="text-[12.5px] whitespace-nowrap text-muted tabular-nums" data-field="message-time">
        {messageTime(message.sentAt, now)}
      </span>
    </button>
  )
}

function OpenMessage({ thread, message, now }: { thread: ThreadDetail; message: Message; now: number }) {
  const to = [...message.to, ...message.cc].map((person) => (person.isMe ? 'you' : personName(known(thread, person))))
  const from = known(thread, message.from)
  const { delivery } = message
  const going = delivery !== null && delivery.state !== 'failed'
  return (
    <section
      className="border-b border-hair py-4"
      data-message="open"
      data-delivery={delivery?.state ?? 'delivered'}
      // A reply the user just sent comes into view as it lands in the thread.
      ref={(element) => {
        if (delivery?.state === 'held') element?.scrollIntoView({ block: 'nearest' })
      }}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span className="w-3.5 flex-none" />
        <Avatar person={from} />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold">{who(from)}</div>
          {to.length > 0 && <div className="truncate text-[12.5px] text-muted">to {to.join(', ')}</div>}
        </div>
        {going ? (
          <DeliveryMark thread={thread} delivery={delivery} />
        ) : (
          <span className="ml-auto text-[12.5px] whitespace-nowrap text-muted tabular-nums" data-field="message-time">
            {messageTime(message.sentAt, now)}
          </span>
        )}
      </div>
      {delivery?.state === 'failed' && <NotSent thread={thread} message={message} delivery={delivery} />}
      {/* On its way, the reply reads a step quieter than mail the provider holds. */}
      <div className={`pl-6 ${going ? 'opacity-70' : ''}`}>
        <Body body={message.body} />
      </div>
    </section>
  )
}
