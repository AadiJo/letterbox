// The open conversation, in the reading column: the subject, one line for whose turn it is
// (in Let go?, how long it waited), its labels and how many messages, then the messages.
// Earlier messages fold to one line each, previewing their new text, and the newest is open, as
// is any reply of the user's still on its way or not sent. An open message's address line ends
// in its images chip, and I shows the images of the newest open one whose images are off. Bodies load through the core's thread view. The reply bar ends
// it; while the user writes, the editor docks below and the subject stays pinned above.

import type { Message, MessageId, Person, ThreadDetail, ThreadId, TurnState } from '@letterbox/protocol'
import { ChevronRight, Hourglass, Reply, Wind } from 'lucide-react'
import { Fragment, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { canReply, type Mail } from './actions.ts'
import { Attachments } from './Attachments.tsx'
import { Avatar } from './Avatar.tsx'
import { Body } from './Body.tsx'
import { Editor, isComposing, PendingReply, ReplyBar, UndoneNotice } from './Composer.tsx'
import { DeliveryMark, NotSent } from './Delivery.tsx'
import { useNow } from './clock.ts'
import { useLost } from './core.ts'
import { useComposer } from './drafts.ts'
import { imagesOff, useShowImagesKey } from './images.ts'
import { ImagesChip } from './ImagesChip.tsx'
import { LabelChip, useLabels } from './Label.tsx'
import { useShownPending, useUndone } from './sending.ts'
import { otherPerson, personName } from './Row.tsx'
import { useThreadDetail } from './threads.ts'
import { age, isLate, listTime, messageTime } from './time.ts'

/** `waited`: the conversation is in Let go?, so its line says how long my turn has waited. */
export function Reader({ id, mail, waited = false }: { id: ThreadId | null; mail: Mail; waited?: boolean }) {
  if (!id) return <p className="m-auto text-row text-faint">No conversation selected</p>
  return <Conversation key={id} id={id} mail={mail} waited={waited} />
}

function Conversation({ id, mail, waited }: { id: ThreadId; mail: Mail; waited: boolean }) {
  const thread = useThreadDetail(id)
  const now = useNow()
  const composer = useComposer(id)
  const pending = useShownPending(id)
  const undone = useUndone(id)
  const lost = useLost() !== null
  // The dock is up: the editor, or with no draft, the user's reply on its way, read only.
  const docked = isComposing(composer) || (composer === undefined && pending !== null)
  const labels = useLabels(thread?.mailboxIds ?? [])
  const [opened, setOpened] = useState<ReadonlySet<MessageId>>(new Set())
  const [scrolled, setScrolled] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  useStickToEnd(scroller, docked)
  const isOpen = (message: Message) =>
    message.id === thread?.messages.at(-1)?.id || message.delivery !== null || opened.has(message.id)
  // I shows the images of the newest open message whose images are off.
  useShowImagesKey(
    thread?.messages.findLast(
      (message) => isOpen(message) && message.body.state === 'ready' && imagesOff(message.body.images),
    ),
  )
  if (thread === undefined) return null
  if (thread === null)
    return (
      <p data-thread={id} className="m-auto text-row text-faint">
        This conversation is gone
      </p>
    )

  const count = `${thread.messageCount} ${thread.messageCount === 1 ? 'message' : 'messages'}`
  const turn =
    thread.turn.holder === 'none' ? null : waited ? (
      <Waited thread={thread} now={now} />
    ) : (
      <Turn turn={thread.turn} late={isLate(thread.lastMessageAt, now)} why={reasonText(thread)} />
    )
  return (
    <article aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
      {docked && (
        // The subject, pinned while the conversation scrolls under the editor.
        <div data-field="subject-band" className="flex h-9 flex-none items-center bg-reader px-6 wide:px-10">
          <div className="reading-column flex min-w-0 items-baseline gap-2">
            <b className="truncate text-subject font-semibold">{thread.subject}</b>
            <span className="inline-flex flex-none gap-1.5 text-meta text-muted">
              <Line parts={[thread.turn.holder === 'none' ? null : turnLabel(thread.turn), count]} />
            </span>
          </div>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Only once the conversation has scrolled: a hairline under the band above, with a shadow
            of 10 px at most, so text slides under it without dimming. */}
        {scrolled && (
          <div
            aria-hidden
            data-field="scroll-edge"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-line shadow-band"
          />
        )}
        <div
          ref={scroller}
          data-scroll=""
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
          className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-6 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin] wide:px-10"
        >
          <div className="reading-column">
            <header>
              {/* Its capitals start 28 px under the toolbar's buttons. */}
              <h3 className="cap-top text-title font-semibold tracking-[-0.02em]" data-field="reader-subject">
                {thread.subject}
              </h3>
              <div className="mt-2 flex items-center gap-2 text-addr text-muted" data-field="reason">
                <Line parts={[turn, ...labels.map((name) => <LabelChip key={name} name={name} />), count]} />
              </div>
            </header>
            <div className="mt-3 border-t border-line wide:mt-6">
              {thread.messages.map((message) =>
                isOpen(message) ? (
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
            {/* With no draft, a reply the core took back waits here to be restored or dropped. */}
            {!docked && composer === undefined && undone && (
              <div className="-mx-4 mt-4 wide:-mx-6">
                <UndoneNotice undone={undone} over={false} busy={false} />
              </div>
            )}
            {!docked && (composer || canReply(thread, mail)) && (
              // With the core lost nothing can be sent, so the bar shows off at 40%, keycaps kept (LostCore.tsx).
              <div inert={lost} className={lost ? 'opacity-40' : undefined}>
                <ReplyBar thread={thread} composer={composer} />
              </div>
            )}
          </div>
        </div>
      </div>
      {composer && composer.state !== 'collapsed' ? (
        <Editor id={thread.id} composer={composer} />
      ) : (
        composer === undefined && pending && <PendingReply pending={pending} />
      )}
    </article>
  )
}

const atEnd = (element: HTMLElement) => element.scrollHeight - element.scrollTop - element.clientHeight < 2

/**
 * While `active`, keeps the conversation at its end as the editor below grows and shrinks, if
 * it was at its end, so the last message and the divider under it stay in view while the user writes.
 */
function useStickToEnd(scroller: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const element = scroller.current
    if (!active || !element) return
    let stuck = atEnd(element)
    const onScroll = () => {
      stuck = atEnd(element)
    }
    const observer = new ResizeObserver(() => {
      if (stuck) element.scrollTop = element.scrollHeight
    })
    element.addEventListener('scroll', onScroll)
    observer.observe(element)
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', onScroll)
    }
  }, [scroller, active])
}

/** The parts that are there, with a quiet dot between each two. */
function Line({ parts }: { parts: readonly ReactNode[] }) {
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

const turnLabel = (turn: TurnState) => (turn.holder === 'mine' ? 'Your turn' : 'Waiting on them')

/** "Your turn" or "Waiting on them", with why in its tooltip. */
function Turn({ turn, late, why }: { turn: TurnState; late: boolean; why: string }) {
  const icon = { className: 'size-3.5', strokeWidth: 1.75, 'aria-hidden': true } as const
  return (
    <b
      title={why}
      className={`inline-flex items-center gap-1.5 font-medium ${turn.holder === 'mine' && late ? 'text-amber' : 'text-fg'}`}
    >
      {turn.holder === 'mine' ? <Reply {...icon} /> : <Hourglass {...icon} />}
      {turnLabel(turn)}
    </b>
  )
}

/** In Let go?: "Waited 39d", then, in a wide window, who asked and when: "Ben asked on Oct 9". */
function Waited({ thread, now }: { thread: ThreadDetail; now: number }) {
  return (
    <>
      <b className="inline-flex items-center gap-1.5 font-medium text-fg" data-field="waited">
        <Wind className="size-3.5" strokeWidth={1.75} aria-hidden />
        Waited {age(thread.lastMessageAt, now)}
      </b>
      <span aria-hidden className="hidden text-sep wide:inline">
        ·
      </span>
      <span className="hidden wide:inline" data-field="asked">
        {firstName(otherPerson(thread))} asked on {listTime(thread.lastMessageAt, now)}
      </span>
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

type FoldedProps = { from: Person; message: Message; now: number; onOpen: () => void }

function FoldedMessage({ from, message, now, onOpen }: FoldedProps) {
  // The core's preview is the new text alone, never the history it quotes.
  const preview = message.body.state === 'ready' ? message.body.preview : ''
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-9 w-full items-center gap-2.5 border-b border-line text-left wide:h-10"
      data-message="folded"
    >
      <span className="flex w-4 flex-none justify-center text-muted">
        <ChevronRight className="size-3.5" strokeWidth={2} aria-hidden data-field="disclosure" />
      </span>
      <Avatar who={from} size="folded" />
      <span className="flex-none text-row font-semibold whitespace-nowrap text-fg2">{who(from)}</span>
      <span className="min-w-0 flex-1 truncate text-row text-muted" data-field="preview">
        {preview}
      </span>
      <span className="text-meta whitespace-nowrap text-muted tabular-nums" data-field="message-time">
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
      className="border-b border-line pt-5 pb-[26px]"
      data-message="open"
      data-delivery={delivery?.state ?? 'delivered'}
      // A reply the user just sent comes into view as it lands in the thread.
      ref={(element) => {
        if (delivery?.state === 'held') element?.scrollIntoView({ block: 'nearest' })
      }}
    >
      <div className="flex items-start gap-3">
        <Avatar who={from} size="open" />
        <div className="min-w-0 flex-1">
          {/* The time sits on the name's baseline. */}
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 truncate text-subject font-semibold">{who(from)}</span>
            {going ? (
              <DeliveryMark thread={thread} delivery={delivery} />
            ) : (
              <span className="ml-auto text-meta whitespace-nowrap text-muted tabular-nums" data-field="message-time">
                {messageTime(message.sentAt, now)}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-addr text-muted">
            <span className="truncate">
              {[from.address, ...(to.length > 0 ? [`to ${to.join(', ')}`] : [])].join(' · ')}
            </span>
            <ImagesChip message={message} />
          </div>
        </div>
      </div>
      {delivery?.state === 'failed' && <NotSent thread={thread} message={message} delivery={delivery} />}
      {/* On its way, the reply reads a step quieter than mail the provider holds. */}
      <div className={`mt-[18px] ${going ? 'opacity-70' : ''}`}>
        <Body id={message.id} body={message.body} />
        {/* Its files can be fetched only once the provider holds the message. */}
        <Attachments attachments={message.attachments} held={delivery === null} />
      </div>
    </section>
  )
}
