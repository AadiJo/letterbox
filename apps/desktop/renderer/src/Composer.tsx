// Replying, under the conversation. With no editor open, a reply bar ends the conversation:
// Reply to the last sender, Reply all when anyone else is on the message, and a folded draft's
// first words. The editor docks below the conversation as an inset field that grows with its
// text up to 40% of the reader. Past that its lines and text scroll, and Send stays in view.
// Esc folds it back to the bar and keeps the draft; Discard throws the draft away. drafts.ts
// holds the draft, DraftText.tsx edits its text and sending.ts sends it. While a reply is on
// its way, the dock shows that reply read only, with Undo, or keeps an existing draft with its
// Send locked until that reply has gone.

import type { ThreadDetail, ThreadId } from '@letterbox/protocol'
import { ChevronDown, CircleAlert, Clock, Reply as ReplyIcon, ReplyAll, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode } from 'react'
import { REPLY_KEY } from './actions.ts'
import { Avatar } from './Avatar.tsx'
import {
  collapse,
  commitTyping,
  confirmBcc,
  type Composer,
  discard,
  edit,
  type Field,
  isPlainAddress,
  newReply,
  parseRecipients,
  type Problem,
  type Recipient,
  showExtra,
  takeOpening,
} from './drafts.ts'
import { DraftText } from './DraftText.tsx'
import { chord, Key } from './Key.tsx'
import { slideUp } from './motion.ts'
import { useSecondsUntil } from './clock.ts'
import {
  dropUndone,
  hidePending,
  type Pending,
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

const SEND_KEY = chord('↵')

const firstName = (recipient: Recipient | undefined) => recipient?.name?.split(' ')[0] ?? recipient?.address ?? ''

/** True while the editor shows, rather than the bar. */
export const isComposing = (composer: Composer | undefined) => composer !== undefined && composer.state !== 'collapsed'

/**
 * The bar that ends the conversation: Reply to whoever wrote last, with a folded draft's first
 * words, and Reply all only when the message went to anyone besides the user and them. It
 * shows whenever a reply can go to anyone, as on the user's own message sent only to Cc.
 */
export function ReplyBar({ thread, composer }: { thread: ThreadDetail; composer: Composer | undefined }) {
  const to = composer?.reply.to[0] ?? newReply(thread, false)?.to[0]
  const others = newReply(thread, true)?.cc.length ?? 0
  const preview = composer?.reply.text.replace(/\s+/g, ' ').trim() ?? ''
  if (!composer && !to && others === 0) return null
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
        <span className="min-w-0 flex-1 truncate text-faint">{preview}</span>
        <Key>{REPLY_KEY.toUpperCase()}</Key>
      </button>
      {others > 0 && (
        <button
          type="button"
          aria-keyshortcuts={`Shift+${REPLY_KEY}`}
          onClick={() => startReply(thread, true)}
          className="flex h-full flex-none items-center gap-1.5 rounded-r-[10px] pr-3.5 pl-3 hover:text-fg"
        >
          <ReplyAll className="size-[15px]" strokeWidth={1.75} aria-hidden />
          Reply all
        </button>
      )}
    </div>
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
          {undone && <UndoneNotice undone={undone} over />}
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
          <button
            type="button"
            disabled={blocked}
            onClick={() => void sendReply(id)}
            className="inline-flex h-8 flex-none items-center gap-2.5 rounded-[9px] bg-blue pr-1.5 pl-3.5 text-row font-semibold text-paper enabled:hover:brightness-110 disabled:opacity-60"
          >
            Send
            <Key tone="send">{SEND_KEY}</Key>
          </button>
          {composer.state === 'checking' ? (
            <p role="status" data-field="send-checking" className="truncate text-row text-fg2">
              Checking whether this was sent…
            </p>
          ) : problem?.at === 'send' ? (
            <p role="alert" data-field="send-problem" className="flex min-w-0 items-center gap-1.5 text-row text-red">
              <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
              <span className="truncate">{problem.text}</span>
            </p>
          ) : reply.bccLost ? (
            <p role="status" data-field="send-locked" className="truncate text-row text-fg2">
              Check the recipients before sending
            </p>
          ) : earlier ? (
            <p role="status" data-field="send-locked" className="truncate text-row text-fg2">
              {earlier.until === null ? 'Your earlier reply is still sending' : <StillSending until={earlier.until} />}
            </p>
          ) : (
            <p className="truncate text-row text-muted">Sends after 10 s. Undo with {UNDO_KEY.toUpperCase()}.</p>
          )}
          <span className="flex-1" />
          <Minimize onClick={() => collapse(id)} />
          <button
            type="button"
            aria-label="Discard"
            title="Discard"
            disabled={busy}
            onClick={() => discard(id)}
            className="inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60"
          >
            <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
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
export function PendingReply({ pending }: { pending: Pending }) {
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
 * draft, or discard it. `over` says a draft is there to be replaced.
 */
export function UndoneNotice({ undone, over }: { undone: Undone; over: boolean }) {
  return (
    <div
      data-field="undone-notice"
      className="mx-4 mb-2 flex flex-none items-center gap-3 rounded-lg bg-pill py-1.5 pr-1.5 pl-3 inset-ring inset-ring-keycap wide:mx-6"
    >
      <p className="min-w-0 flex-1 truncate text-row text-fg2">Undid your earlier reply.</p>
      <button
        type="button"
        onClick={() => restoreUndone(undone.change)}
        className="inline-flex h-7 flex-none items-center rounded-lg px-2.5 text-row font-medium text-fg shadow-outline hover:bg-hover"
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

/** Why this draft cannot go yet: the conversation's earlier reply, and its seconds left by the core's deadline. */
function StillSending({ until }: { until: string }) {
  return <>Your earlier reply is still sending ({useSecondsUntil(until)} s)</>
}

/** How long the core will hold the reply, by its deadline. Display only: the core's update ends it. */
function SendsIn({ until }: { until: string }) {
  const seconds = useSecondsUntil(until)
  return (
    <>{seconds > 0 ? `Your reply sends in ${seconds} s · Undo to edit it` : 'Your reply sends now · Undo to edit it'}</>
  )
}

type LineProps = {
  id: ThreadId
  field: Field
  label: string
  reply: Composer['reply']
  problem: Problem | null
  children?: ReactNode
}

/** One address line: its label, a chip per person, and a field to type more. */
function AddressLine({ id, field, label, reply, problem, children }: LineProps) {
  const people = reply[field]
  const typing = reply.typing[field]
  const set = (next: string) => edit(id, (current) => ({ ...current, typing: { ...current.typing, [field]: next } }))
  const commit = () => edit(id, (current) => commitTyping(current, field))
  const remove = (index: number) =>
    edit(id, (current) => ({ ...current, [field]: current[field].filter((_, at) => at !== index) }))
  const mine = problem?.at === field ? problem : null
  return (
    // A grid, so a problem under the line starts where its field starts, whatever the label's width.
    <div
      data-address-line={field}
      className="mx-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-line wide:mx-6"
    >
      <label htmlFor={`${id}-${field}`} className="text-row text-muted">
        {label}
      </label>
      <div className="flex min-h-11 min-w-0 items-center py-[9px]">
        <div data-field="address-field" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {people.map((person, index) => (
            <Chip key={`${person.address} ${index}`} person={person} onRemove={() => remove(index)} />
          ))}
          <input
            id={`${id}-${field}`}
            data-line={field}
            value={typing}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={mine !== null}
            onChange={(event) => {
              const value = event.target.value
              // A pasted or typed separator ends every address before it.
              const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
              if (cut === -1) return set(value)
              const done = parseRecipients(value.slice(0, cut))
              edit(id, (current) => ({
                ...current,
                [field]: [...current[field], ...done],
                typing: { ...current.typing, [field]: value.slice(cut + 1).trimStart() },
              }))
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && typing.trim() !== '') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Backspace' && typing === '' && people.length > 0) {
                remove(people.length - 1)
              }
            }}
            className="h-[26px] min-w-[120px] flex-1 bg-transparent text-row text-fg caret-blue outline-none"
          />
        </div>
      </div>
      {children}
      {mine && (
        <p
          role="alert"
          data-field="address-problem"
          className="col-span-2 col-start-2 -mt-0.5 flex items-center gap-1.5 pb-2 text-addr text-red"
        >
          <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
          {mine.text}
        </p>
      )}
    </div>
  )
}

/**
 * One person: their avatar, then their name, or the address alone. An address the core cannot
 * send to shows in red. With no `onRemove`, as on a reply on its way, it cannot be removed.
 */
function Chip({ person, onRemove }: { person: Recipient; onRemove: (() => void) | null }) {
  const valid = isPlainAddress(person.address)
  return (
    <span
      data-chip={valid ? 'ok' : 'invalid'}
      title={person.name ? `${person.name} <${person.address}>` : person.address}
      className={`group inline-flex h-[26px] max-w-[260px] items-center gap-[7px] rounded-[7px] pr-1 pl-1 text-row ${valid ? 'bg-pill text-fg' : 'bg-red/10 text-red inset-ring inset-ring-red/50'}`}
    >
      {valid ? (
        <Avatar who={person} size="chip" />
      ) : (
        <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
      )}
      <span className="truncate">{person.name ?? person.address}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${person.name ?? person.address}`}
          onClick={onRemove}
          className="inline-flex size-5 flex-none items-center justify-center rounded-md text-faint group-hover:text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-[13px]" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  )
}
