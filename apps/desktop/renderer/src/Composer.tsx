// The reply editor, docked to the bottom of the reader under the conversation, which keeps
// scrolling above it. A grip resizes it. Esc folds it to a bar and keeps the draft; Discard
// throws the draft away. drafts.ts holds the draft and sending.ts sends it. While a reply is
// on its way, the dock shows that reply read only, with Undo, instead of a second draft.

import type { ThreadDetail, ThreadId } from '@letterbox/protocol'
import { ChevronDown, CircleAlert, Clock, Reply as ReplyIcon, SendHorizontal, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import {
  collapse,
  commitTyping,
  type Composer,
  discard,
  edit,
  type Field,
  isPlainAddress,
  openReply,
  parseRecipients,
  type Problem,
  type Recipient,
  showExtra,
  takeOpening,
  useComposer,
} from './drafts.ts'
import { slideUp } from './motion.ts'
import { useSecondsUntil } from './clock.ts'
import { hidePending, type Pending, sendReply, undoSend, useShownPending } from './sending.ts'
import { UNDO_KEY } from './undo.ts'

/** The dock's share of the reader's height: 40% to start, and what the user last dragged it to this session. */
const SHARE = { initial: 0.4, min: 0.22, max: 0.78, step: 0.04 } as const
const STORED = 'letterbox.dock-share'

/** Session storage only spares a reload the drag. It may be missing or refuse, and the dock works without it. */
function readShare() {
  try {
    const stored = Number(sessionStorage.getItem(STORED))
    return stored >= SHARE.min && stored <= SHARE.max ? stored : SHARE.initial
  } catch {
    return SHARE.initial
  }
}

let dockShare = readShare()

function keepShare(share: number) {
  dockShare = share
  try {
    sessionStorage.setItem(STORED, String(share))
  } catch {
    // Without storage the height lasts until the page reloads, which is all it promises.
  }
}

const clampShare = (share: number) => Math.min(SHARE.max, Math.max(SHARE.min, share))

const SEND_KEY = navigator.userAgent.includes('Mac') ? '⌘↵' : 'Ctrl ↵'

const firstName = (recipient: Recipient | undefined) => recipient?.name?.split(' ')[0] ?? recipient?.address ?? ''

/** The reply on its way, the editor or its bar for `thread`, or nothing while it has none of them. */
export function Dock({ thread }: { thread: ThreadDetail }) {
  const composer = useComposer(thread.id)
  const pending = useShownPending(thread.id)
  if (pending) return <PendingReply pending={pending} />
  if (!composer) return null
  if (composer.state === 'collapsed') return <Bar thread={thread} composer={composer} />
  return <Editor id={thread.id} composer={composer} />
}

/** The folded draft: who it goes to and how it starts. R or a click opens it again. */
function Bar({ thread, composer }: { thread: ThreadDetail; composer: Composer }) {
  const preview = composer.reply.text.replace(/\s+/g, ' ').trim()
  return (
    <div className="flex-none px-10 pt-2 pb-4">
      <button
        type="button"
        data-field="reply-bar"
        onClick={() => openReply(thread, false)}
        className="flex h-11 w-full items-center gap-2.5 rounded-xl border border-line2 bg-panel px-4 text-left text-[13px] hover:bg-raised"
      >
        <ReplyIcon className="size-[15px] flex-none text-muted" strokeWidth={1.75} aria-hidden />
        <span className="flex-none font-medium text-fg">Reply to {firstName(composer.reply.to[0])}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{preview === '' ? 'Draft' : preview}</span>
        <kbd className="rounded border border-key px-[5px] font-mono text-[11px] leading-4 text-faint">R</kbd>
      </button>
    </div>
  )
}

/**
 * The dock itself: a resizable panel at the bottom of the reader, holding a bordered box.
 * `onMount` runs as it renders, for the editor's entrance and focus.
 */
function DockFrame({
  onMount,
  onKeyDown,
  children,
}: {
  onMount?: (element: HTMLElement) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  children: ReactNode
}) {
  const [share, setShare] = useState(dockShare)
  const resize = (next: number) => {
    const clamped = clampShare(next)
    setShare(clamped)
    keepShare(clamped)
  }
  return (
    <section
      aria-label="Reply"
      ref={(element) => {
        if (element) onMount?.(element)
      }}
      onKeyDown={onKeyDown}
      style={{ height: `${share * 100}%` }}
      className="relative flex min-h-[220px] flex-none flex-col border-t border-line bg-win px-10 pt-3 pb-4"
    >
      <Grip share={share} onResize={resize} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-[0_-1px_0_rgb(255_255_255/0.03)_inset,0_12px_32px_rgb(0_0_0/0.35)]">
        {children}
      </div>
    </section>
  )
}

const BODY_CLASS =
  'min-h-0 w-full flex-1 resize-none bg-transparent py-3 pr-[max(1rem,calc(100%-72ch-1rem))] pl-4 text-[15px] leading-[23px] text-body outline-none [scrollbar-color:var(--color-line2)_transparent] [scrollbar-width:thin] placeholder:text-faint'

function Editor({ id, composer }: { id: ThreadId; composer: Exclude<Composer, { state: 'collapsed' }> }) {
  const { reply } = composer
  const problem = composer.state === 'open' ? composer.problem : null
  const busy = composer.state !== 'open'

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
      // Slides in, and takes focus, only when the user just opened it.
      onMount={(element) => {
        if (!takeOpening(id)) return
        slideUp(element)
        const target = reply.to.length > 0 ? 'textarea' : 'input[data-line="to"]'
        element.querySelector<HTMLElement>(target)?.focus()
      }}
      onKeyDown={onKeyDown}
    >
      <AddressLine id={id} field="to" label="To" reply={reply} problem={problem}>
        {!composer.extra && (
          <button
            type="button"
            onClick={() => showExtra(id)}
            className="flex-none rounded-md px-1.5 py-0.5 text-[12.5px] text-muted hover:bg-hover hover:text-fg"
          >
            Cc Bcc
          </button>
        )}
      </AddressLine>
      {composer.extra && (
        <>
          <AddressLine id={id} field="cc" label="Cc" reply={reply} problem={problem} />
          <AddressLine id={id} field="bcc" label="Bcc" reply={reply} problem={problem} />
        </>
      )}
      {/* Lines wrap at the 72ch of a message body (Body.tsx), and the scrollbar stays at the box's edge. */}
      <textarea
        aria-label="Message"
        value={reply.text}
        readOnly={busy}
        placeholder={`Reply to ${firstName(reply.to[0])}`}
        onChange={(event) => {
          const text = event.target.value
          edit(id, (current) => ({ ...current, text }))
        }}
        className={BODY_CLASS}
      />
      <footer className="flex h-[52px] flex-none items-center gap-3 border-t border-line px-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void sendReply(id)}
          className="inline-flex h-8 items-center gap-2 rounded-lg bg-blue pr-1.5 pl-3 text-[13px] font-semibold text-desk shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(0_0_0/0.5)] enabled:hover:brightness-110 disabled:opacity-60"
        >
          <SendHorizontal className="size-[15px]" strokeWidth={2} aria-hidden />
          Send
          <kbd className="rounded-[5px] bg-desk/15 px-1.5 font-sans text-[11px] leading-5 font-medium text-desk/75">
            {SEND_KEY}
          </kbd>
        </button>
        {composer.state === 'checking' ? (
          <p role="status" data-field="send-checking" className="truncate text-[12.5px] text-fg2">
            Checking whether this was sent…
          </p>
        ) : problem?.at === 'send' ? (
          <p
            role="alert"
            data-field="send-problem"
            className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-red"
          >
            <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
            <span className="truncate">{problem.text}</span>
          </p>
        ) : (
          <p className="truncate text-[12.5px] text-faint">Sends after 10 s. Undo with {UNDO_KEY.toUpperCase()}.</p>
        )}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Minimize"
          title="Minimize (Esc)"
          onClick={() => collapse(id)}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => discard(id)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-fg2 enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60"
        >
          <Trash2 className="size-3.5" strokeWidth={1.75} aria-hidden />
          Discard
        </button>
      </footer>
    </DockFrame>
  )
}

/**
 * The reply on its way in this conversation, read only: who it goes to and what it says. Undo
 * takes it back into the editor while the core holds it. No second draft starts meanwhile.
 */
function PendingReply({ pending }: { pending: Pending }) {
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
    >
      {lines.map((line) => (
        <div key={line.label} data-address-line={line.label.toLowerCase()} className="border-b border-line px-4">
          <div className="flex min-h-11 items-center gap-2 py-1.5">
            <span className="w-8 flex-none text-[12.5px] text-muted">{line.label}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {line.people.map((person, index) => (
                <Chip key={`${person.address} ${index}`} person={person} onRemove={null} />
              ))}
            </div>
          </div>
        </div>
      ))}
      <textarea aria-label="Message" value={reply?.text ?? ''} readOnly className={`${BODY_CLASS} text-fg2`} />
      <footer className="flex h-[52px] flex-none items-center gap-3 border-t border-line px-3">
        <Clock className="ml-1 size-[15px] flex-none text-fg2" strokeWidth={1.75} aria-hidden />
        <p role="status" data-field="reply-pending" className="min-w-0 truncate text-[13px] text-fg2">
          {pending.until === null ? 'Your reply is on its way' : <SendsIn until={pending.until} />}
        </p>
        <span className="flex-1" />
        {pending.until !== null && (
          <button
            type="button"
            onClick={() => void undoSend(pending.change)}
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-key bg-raised pr-1.5 pl-3 text-[13px] font-medium text-fg hover:bg-hover"
          >
            Undo
            <kbd className="rounded border border-key px-[5px] font-mono text-[11px] leading-4 text-faint">
              {UNDO_KEY.toUpperCase()}
            </kbd>
          </button>
        )}
        <button
          type="button"
          aria-label="Minimize"
          title="Minimize (Esc)"
          onClick={() => hidePending(pending.threadId)}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
        >
          <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      </footer>
    </DockFrame>
  )
}

/** How long the core will hold the reply, by its deadline. Display only: the core's update ends it. */
function SendsIn({ until }: { until: string }) {
  const seconds = useSecondsUntil(until)
  return (
    <>{seconds > 0 ? `Your reply sends in ${seconds} s · Undo to edit it` : 'Your reply sends now · Undo to edit it'}</>
  )
}

/** The edge the user drags, or moves with the arrow keys, to change the dock's height. */
function Grip({ share, onResize }: { share: number; onResize: (share: number) => void }) {
  const follow = (element: HTMLElement, y: number) => {
    const pane = element.closest('article')?.getBoundingClientRect()
    if (pane && pane.height > 0) onResize((pane.bottom - y) / pane.height)
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the reply"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={Math.round(SHARE.min * 100)}
      aria-valuemax={Math.round(SHARE.max * 100)}
      tabIndex={0}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) follow(event.currentTarget, event.clientY)
      }}
      onKeyDown={(event) => {
        const step = { ArrowUp: SHARE.step, ArrowDown: -SHARE.step }[event.key]
        if (step === undefined) return
        event.preventDefault()
        onResize(share + step)
      }}
      className="group absolute inset-x-0 -top-1.5 flex h-3 cursor-row-resize items-center justify-center outline-none"
    >
      <span className="h-1 w-9 rounded-full bg-line2 group-hover:bg-key group-focus-visible:bg-blue" />
    </div>
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
    <div data-address-line={field} className="border-b border-line px-4">
      <div className="flex min-h-11 items-center gap-2 py-1.5">
        <label htmlFor={`${id}-${field}`} className="w-8 flex-none text-[12.5px] text-muted">
          {label}
        </label>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
            className="h-7 min-w-[120px] flex-1 bg-transparent text-[13.5px] text-fg outline-none"
          />
        </div>
        {children}
      </div>
      {mine && (
        <p
          role="alert"
          data-field="address-problem"
          className="-mt-0.5 flex items-center gap-1.5 pb-2 pl-10 text-[12.5px] text-red"
        >
          <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
          {mine.text}
        </p>
      )}
    </div>
  )
}

const initials = (person: Recipient) =>
  (person.name ?? person.address)
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

/** One person: initials, then their name, or the address alone. An address the core cannot send to shows in red. With no `onRemove`, it cannot be removed. */
function Chip({ person, onRemove }: { person: Recipient; onRemove: (() => void) | null }) {
  const valid = isPlainAddress(person.address)
  return (
    <span
      data-chip={valid ? 'ok' : 'invalid'}
      title={person.name ? `${person.name} <${person.address}>` : person.address}
      className={`group inline-flex h-7 max-w-[260px] items-center gap-1.5 rounded-full border pr-1 pl-0.5 text-[13px] ${valid ? 'border-line2 bg-raised text-fg' : 'border-red/50 bg-red/10 text-red'}`}
    >
      {valid ? (
        <span
          aria-hidden
          className="inline-flex size-[22px] flex-none items-center justify-center rounded-full bg-pill-sel text-[10px] font-semibold text-fg2"
        >
          {initials(person)}
        </span>
      ) : (
        <CircleAlert className="ml-1 size-3.5 flex-none" strokeWidth={2} aria-hidden />
      )}
      <span className="truncate">{person.name ?? person.address}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${person.name ?? person.address}`}
          onClick={onRemove}
          className="inline-flex size-5 flex-none items-center justify-center rounded-full text-faint group-hover:text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-3" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  )
}
