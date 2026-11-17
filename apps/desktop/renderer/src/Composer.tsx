// Replying, under the conversation. With no editor open, a reply bar ends the conversation:
// Reply to the last sender, with a folded draft's first words, Reply all when anyone else is
// on the message, and Forward, which opens the compose page (ComposePage.tsx). The editor docks below the conversation as an inset field that grows with its
// text up to 40% of the reader. Past that its lines and text scroll, and Send stays in view.
// Esc folds it back to the bar and keeps the draft; Discard throws the draft away. drafts.ts
// holds the draft, DraftText.tsx edits its text and sending.ts sends it. While a reply is on
// its way, the dock shows that reply read only, with Undo, or keeps an existing draft with its
// Send locked until that reply has gone.

import type { ThreadDetail, ThreadId } from '@letterbox/protocol'
import { ChevronDown, CircleAlert, Clock, Forward, Reply as ReplyIcon, ReplyAll } from 'lucide-react'
import { type KeyboardEvent, type ReactNode } from 'react'
import { FORWARD_KEY, REPLY_KEY } from './actions.ts'
import { AddressLine, Chip } from './AddressLine.tsx'
import {
  collapse,
  composeForward,
  confirmBcc,
  type Composer,
  discard,
  newReply,
  type Recipient,
  showExtra,
  takeOpening,
} from './drafts.ts'
import { DraftText } from './DraftText.tsx'
import { Key, shifted } from './Key.tsx'
import { DiscardButton, SendButton, SendStatus } from './Send.tsx'
import { slideUp } from './motion.ts'
import { useSecondsUntil } from './clock.ts'
import {
  dropUndone,
  hidePending,
  type Located,
  restoreUndone,
  sendReply,
  startReply,
  type Undone,
  undoSend,
  usePendingIn,
  useUndone,
} from './sending.ts'
import { Tooltip } from './Tooltip.tsx'
import { UNDO_KEY } from './undo.ts'

const firstName = (recipient: Recipient | undefined) => recipient?.name?.split(' ')[0] ?? recipient?.address ?? ''

/** True while the editor shows, rather than the bar. */
export const isComposing = (composer: Composer | undefined) => composer !== undefined && composer.state !== 'collapsed'

/** The message Forward sends on: the newest the provider holds, not one of the user's still on its way. */
export const forwardable = (thread: ThreadDetail) => thread.messages.findLast((message) => message.delivery === null)

/**
 * The bar that ends the conversation: Reply to whoever wrote last, with a folded draft's first
 * words, Reply all only when the message went to anyone besides the user and them, and
 * Forward. It shows whenever a reply can go to anyone, as on the user's own message sent only
 * to Cc, or there is a message to forward.
 */
export function ReplyBar({ thread, composer }: { thread: ThreadDetail; composer: Composer | undefined }) {
  const to = composer?.reply.to[0] ?? newReply(thread, false)?.to[0]
  const others = newReply(thread, true)?.cc.length ?? 0
  const preview = composer?.reply.text.replace(/\s+/g, ' ').trim() ?? ''
  const original = forwardable(thread)
  if (!composer && !to && others === 0 && !original) return null
  return (
    <div className="mt-4 flex h-11 items-center rounded-[10px] bg-well text-row text-muted shadow-well">
      <button
        type="button"
        data-field="reply-bar"
        aria-keyshortcuts={REPLY_KEY}
        onClick={() => startReply(thread, false)}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[10px] pr-2 pl-3.5 text-left hover:text-fg"
      >
        <ReplyIcon className="size-[15px] flex-none" strokeWidth={1.75} aria-hidden />
        <span className="flex-none">{to ? `Reply to ${firstName(to)}` : 'Reply'}</span>
        <Key>{REPLY_KEY.toUpperCase()}</Key>
        <span className="min-w-0 flex-1 truncate text-faint">{preview}</span>
      </button>
      {others > 0 && (
        <Segment
          label="Reply all"
          icon={<ReplyAll className="size-[15px]" strokeWidth={1.75} aria-hidden />}
          shortcut={`Shift+${REPLY_KEY}`}
          keycap={shifted(REPLY_KEY.toUpperCase())}
          onClick={() => startReply(thread, true)}
        />
      )}
      {original && (
        <Segment
          label="Forward"
          icon={<Forward className="size-[15px]" strokeWidth={1.75} aria-hidden />}
          shortcut={FORWARD_KEY}
          keycap={FORWARD_KEY.toUpperCase()}
          onClick={() => composeForward(thread, original)}
        />
      )}
    </div>
  )
}

type SegmentProps = { label: string; icon: ReactNode; shortcut: string; keycap: string; onClick: () => void }

/** One of the bar's buttons after Reply, behind a hairline. The last one rounds off the bar. */
function Segment({ label, icon, shortcut, keycap, onClick }: SegmentProps) {
  return (
    <>
      <span aria-hidden className="h-[18px] w-px flex-none bg-line" />
      <button
        type="button"
        aria-label={label}
        aria-keyshortcuts={shortcut}
        onClick={onClick}
        className="flex h-full flex-none items-center gap-1.5 pr-2.5 pl-3 last:rounded-r-[10px] hover:bg-hover hover:text-fg"
      >
        {icon}
        {label}
        <Key>{keycap}</Key>
      </button>
    </>
  )
}

/**
 * Brings the end of the conversation into view and the editor up, as the user opens it. Only
 * then: not when it shows again as the user moves between conversations.
 */
function arrive(element: HTMLElement | null, id: ThreadId, target: string) {
  if (!element || !takeOpening(id)) return
  const thread = element.closest('article')?.querySelector('[data-scroll]')
  if (thread) thread.scrollTop = thread.scrollHeight
  slideUp(element)
  const field = element.querySelector<HTMLElement>(target)
  field?.focus()
  // The caret goes after what is already written.
  if (field instanceof HTMLTextAreaElement) field.setSelectionRange(field.value.length, field.value.length)
}

export function Editor({ id, composer }: { id: ThreadId; composer: Exclude<Composer, { state: 'collapsed' }> }) {
  const { reply } = composer
  const problem = composer.state === 'open' ? composer.problem : null
  const busy = composer.state !== 'open'
  // An earlier reply of this conversation still on its way, or a Bcc a reload lost, holds Send.
  const earlier = usePendingIn(id)
  // A reply the core took back while this draft had text, waiting beside it to be restored or dropped.
  const undone = useUndone(id)
  const blocked = busy || earlier !== null || reply.bccLost

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      collapse(id)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void sendReply(id)
    }
  }

  return (
    <DockFrame
      onMount={(element) => arrive(element, id, reply.to.length > 0 ? '[data-field="draft"]' : 'input[data-line="to"]')}
      onKeyDown={onKeyDown}
      notice={
        <>
          {undone && <UndoneNotice undone={undone} over busy={busy} />}
          {reply.bccLost && (
            <button
              type="button"
              data-field="bcc-notice"
              title="Confirm the recipients"
              onClick={() => confirmBcc(id)}
              className="mx-4 mb-2 flex flex-none items-center gap-2 rounded-lg bg-red/[0.07] px-3 py-2 text-left text-row text-fg2 inset-ring inset-ring-red/35 hover:bg-red/[0.12] wide:mx-6"
            >
              <CircleAlert className="size-3.5 flex-none text-red" strokeWidth={2} aria-hidden />
              Bcc wasn't kept after the reload. Check recipients before sending.
            </button>
          )}
        </>
      }
      footer={
        <>
          <SendButton disabled={blocked} onSend={() => void sendReply(id)} />
          <SendStatus composer={composer} earlier={earlier} />
          <span className="flex-1" />
          <Minimize onClick={() => collapse(id)} />
          <DiscardButton disabled={busy} onDiscard={() => discard(id)} />
        </>
      }
    >
      <AddressLine id={id} field="to" label="To" reply={reply} problem={problem}>
        {!composer.extra && (
          <button
            type="button"
            onClick={() => showExtra(id)}
            // Its text ends where the line under it ends, as Discard's icon does below.
            className="-mr-1.5 flex-none rounded-md px-1.5 py-0.5 text-row whitespace-pre text-muted hover:bg-hover hover:text-fg"
          >
            Cc{'  '}Bcc
          </button>
        )}
      </AddressLine>
      {composer.extra && (
        <>
          <AddressLine id={id} field="cc" label="Cc" reply={reply} problem={problem} />
          <AddressLine id={id} field="bcc" label="Bcc" reply={reply} problem={problem} />
        </>
      )}
      <DraftText id={id} text={reply.text} readOnly={busy} placeholder={`Reply to ${firstName(reply.to[0])}`} />
    </DockFrame>
  )
}

type FrameProps = {
  /** Runs each time the dock renders, for the editor's entrance and focus. */
  onMount?: (element: HTMLElement) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  /** Why Send waits, kept in view above the footer however long the draft. */
  notice?: ReactNode
  footer: ReactNode
  /** The address lines and the text. */
  children: ReactNode
}

/**
 * The dock: an inset field in the reading column that grows with what it holds, up to 40% of
 * the reader. Past that its lines and text scroll, and the footer stays in view.
 */
function DockFrame({ onMount, onKeyDown, notice, footer, children }: FrameProps) {
  return (
    <section
      aria-label="Reply"
      ref={(element) => {
        if (element) onMount?.(element)
      }}
      onKeyDown={onKeyDown}
      // The toast anchors above it (Toast.tsx).
      className="relative z-10 flex max-h-[40%] flex-none flex-col px-6 pb-4 [anchor-name:--dock] wide:px-10"
    >
      {/* The field reaches 16 or 24 px past the column each side, so its text lines up with the body's. */}
      <div className="reading-column flex min-h-0 flex-1 flex-col">
        <div className="-mx-4 flex min-h-0 flex-1 flex-col rounded-xl bg-well shadow-well wide:-mx-6">
          <div
            data-field="draft-scroll"
            className="min-h-0 flex-[0_1_auto] overflow-y-auto [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin]"
          >
            {children}
          </div>
          {notice}
          {/* Its last icon ends where the address lines' dividers end: 16 or 24 px in, less the button's 8 px around its glyph. */}
          <footer className="flex h-[50px] flex-none items-center gap-3 pr-2 pl-4 wide:pr-4 wide:pl-6">{footer}</footer>
        </div>
      </div>
    </section>
  )
}

/** Folds the dock away. Esc does the same, which its tooltip says. */
function Minimize({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label="Minimize" shortcut="Esc">
      {(describedBy) => (
        <button
          type="button"
          aria-label="Minimize"
          aria-describedby={describedBy}
          aria-keyshortcuts="Escape"
          onClick={onClick}
          className="inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      )}
    </Tooltip>
  )
}

/**
 * The reply on its way in this conversation, read only: who it goes to and what it says. Undo
 * takes it back into the editor while the core holds it. No second draft starts meanwhile.
 */
export function PendingReply({ pending }: { pending: Located }) {
  const { reply } = pending
  const lines = [
    { label: 'To', people: reply?.to ?? [] },
    { label: 'Cc', people: reply?.cc ?? [] },
    { label: 'Bcc', people: reply?.bcc ?? [] },
  ].filter((line) => line.label === 'To' || line.people.length > 0)
  return (
    <DockFrame
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        hidePending(pending.threadId)
      }}
      footer={
        <>
          <Clock className="size-4 flex-none text-fg2" strokeWidth={1.75} aria-hidden />
          <p role="status" data-field="reply-pending" className="min-w-0 truncate text-row text-fg2">
            {pending.until === null ? 'Your reply is on its way' : <SendsIn until={pending.until} />}
          </p>
          <span className="flex-1" />
          {pending.until !== null && (
            <button
              type="button"
              onClick={() => void undoSend(pending.change)}
              className="inline-flex h-8 flex-none items-center gap-2 rounded-lg pr-1.5 pl-3 text-row font-medium text-fg shadow-outline hover:bg-hover"
            >
              Undo
              <Key>{UNDO_KEY.toUpperCase()}</Key>
            </button>
          )}
          <Minimize onClick={() => hidePending(pending.threadId)} />
        </>
      }
    >
      {lines.map((line) => (
        <div
          key={line.label}
          data-address-line={line.label.toLowerCase()}
          className="mx-4 border-b border-line wide:mx-6"
        >
          <div className="flex min-h-11 items-center gap-2.5 py-[9px]">
            <span className="flex-none text-row text-muted">{line.label}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {line.people.map((person, index) => (
                <Chip key={`${person.address} ${index}`} person={person} onRemove={null} />
              ))}
            </div>
          </div>
        </div>
      ))}
      <DraftText id={pending.threadId} text={reply?.text ?? ''} readOnly placeholder="" />
    </DockFrame>
  )
}

/**
 * A reply the core took back while the conversation's draft had text: Restore it over the
 * draft, or discard it. `over` says a draft is there to be replaced, and `busy` that it waits
 * on the core, so nothing can replace it yet.
 */
export function UndoneNotice({ undone, over, busy }: { undone: Undone; over: boolean; busy: boolean }) {
  return (
    <div
      data-field="undone-notice"
      className="mx-4 mb-2 flex flex-none items-center gap-3 rounded-lg bg-pill py-1.5 pr-1.5 pl-3 inset-ring inset-ring-keycap wide:mx-6"
    >
      <p className="min-w-0 flex-1 truncate text-row text-fg2">Undid your earlier reply.</p>
      <button
        type="button"
        // While the draft waits on the core, nothing can replace it.
        disabled={busy}
        onClick={() => restoreUndone(undone.change)}
        className="inline-flex h-7 flex-none items-center rounded-lg px-2.5 text-row font-medium text-fg shadow-outline enabled:hover:bg-hover disabled:opacity-50"
      >
        {over ? 'Restore it (replaces this draft)' : 'Restore it'}
      </button>
      <button
        type="button"
        onClick={() => dropUndone(undone.change)}
        className="inline-flex h-7 flex-none items-center rounded-lg px-2.5 text-row font-medium text-fg2 hover:bg-hover hover:text-fg"
      >
        Discard it
      </button>
    </div>
  )
}

/** How long the core will hold the reply, by its deadline. Display only: the core's update ends it. */
function SendsIn({ until }: { until: string }) {
  const seconds = useSecondsUntil(until)
  return (
    <>{seconds > 0 ? `Your reply sends in ${seconds} s · Undo to edit it` : 'Your reply sends now · Undo to edit it'}</>
  )
}
