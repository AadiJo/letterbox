// Unsubscribe A: an outlined Unsubscribe beside Archive all in a sender's toolbar and before
// Search in a conversation's, ⇧U, and a third button on a hovered Updates row. Each opens one
// confirm, a float under the toolbar's button. Once confirmed, the button and the row say where
// it has got, from the sender's Updates row: "Unsubscribing" while held or sending,
// "Unsubscribed" once done, or a button that opens the sender's page when only that is left.
// The toast says the same, with Undo while held and Archive all once done (unsubscribe.ts).

import type { SenderSummary, ThreadId, Unsubscribed } from '@letterbox/protocol'
import { Archive, CircleCheck, Clock, ExternalLink, Info, MailX, Zap } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Mail } from './actions.ts'
import { useSecondsUntil } from './clock.ts'
import { useLost } from './core.ts'
import { cx } from './cx.ts'
import { Key, shifted } from './Key.tsx'
import { actOnSender } from './sender-actions.ts'
import { useThreadDetail } from './threads.ts'
import { Frame } from './Toast.tsx'
import { Tooltip } from './Tooltip.tsx'
import {
  type ConfirmPlace,
  hostOf,
  howItGoes,
  openUnsubscribePage,
  reachedEnd,
  setConfirming,
  type Target,
  targetIn,
  unsubscribe,
  UNSUBSCRIBE_KEY,
  useConfirming,
  useSenderRow,
  useTracked,
} from './unsubscribe.ts'

/** How far the confirm keeps from the reader's edges. */
const INSET = 8

const OUTLINED =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-row font-medium whitespace-nowrap text-fg shadow-outline enabled:hover:bg-hover'

type ControlProps = {
  place: ConfirmPlace
  target: Target
  /** The sender's Updates row, which says where an unsubscribe has got. Undefined until known. */
  row: SenderSummary | undefined
  /** In a conversation's toolbar, its tooltip names the sender and ⇧U. */
  tooltip: boolean
}

/** The toolbar's Unsubscribe, its confirm, and what it says once confirmed. */
function Control({ place, target, row, tooltip }: ControlProps) {
  const lost = useLost() !== null
  const open = useConfirming(place)
  const trigger = useRef<HTMLButtonElement>(null)
  const state = row?.unsubscribed ?? null
  if (state) return <Where state={state} />
  const label = `Unsubscribe from ${target.sender}`
  const button = (describedBy?: string) => (
    <button
      ref={trigger}
      type="button"
      aria-label={label}
      aria-describedby={describedBy}
      aria-keyshortcuts="Shift+U"
      aria-expanded={open}
      data-field="unsubscribe"
      disabled={lost}
      onClick={() => setConfirming(open ? null : place)}
      className={cx(OUTLINED, open && 'bg-hover', lost && 'opacity-40')}
    >
      <MailX className="size-4" strokeWidth={1.75} aria-hidden />
      {/* A narrow window shows the mark alone. */}
      <span className="hidden wide:inline">Unsubscribe</span>
    </button>
  )
  return (
    <span className="relative inline-flex flex-none">
      {/* One tree open or shut, so the button keeps its focus when the confirm closes. */}
      {tooltip ? (
        <Tooltip label={label} shortcut={shifted(UNSUBSCRIBE_KEY)}>
          {(describedBy) => button(describedBy)}
        </Tooltip>
      ) : (
        button()
      )}
      {open && (
        <Confirm
          target={target}
          close={(refocus) => {
            setConfirming(null)
            if (refocus) trigger.current?.focus()
          }}
        />
      )}
    </span>
  )
}

/** Where a confirmed unsubscribe has got, in the toolbar's button's place. */
function Where({ state }: { state: Unsubscribed }) {
  switch (state.state) {
    case 'held':
    case 'sending':
      return (
        <span
          className="inline-flex h-8 items-center gap-1.5 px-2 text-row font-medium whitespace-nowrap text-muted"
          data-field="unsubscribe-state"
          data-state={state.state}
        >
          <Clock className="size-4" strokeWidth={1.75} aria-hidden />
          Unsubscribing
        </span>
      )
    case 'done':
      return (
        <span
          className="inline-flex h-8 items-center gap-1.5 px-2 text-row font-medium whitespace-nowrap text-muted"
          data-field="unsubscribe-state"
          data-state="done"
        >
          <CircleCheck className="size-4 text-green" strokeWidth={1.75} aria-hidden />
          Unsubscribed
        </span>
      )
    case 'page':
      return (
        <button
          type="button"
          title={`Opens ${hostOf(state.url)} in your browser`}
          data-field="unsubscribe-page"
          onClick={() => openUnsubscribePage(state.url)}
          className={OUTLINED}
        >
          <ExternalLink className="size-4" strokeWidth={1.75} aria-hidden />
          <span className="hidden wide:inline">Unsubscribe page</span>
        </button>
      )
  }
}

/**
 * The confirm, under its button: what unsubscribing tells the sender, how the request goes
 * out, and Cancel (Esc) and Unsubscribe (↵). It keeps inside the reader's visible part.
 */
function Confirm({ target, close }: { target: Target; close: (refocus: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null)
  // Where it sits once fitted into the reader. Null while it shows at its own size, to be
  // measured: as it opens, and again when the window resizes.
  const [shift, setShift] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element || shift !== null) return
    const reader = element.closest('section[aria-label="Reader"]') ?? document.documentElement
    const bounds = reader.getBoundingClientRect()
    const [left, right] = [Math.max(bounds.left, 0) + INSET, Math.min(bounds.right, window.innerWidth) - INSET]
    const own = element.getBoundingClientRect()
    const width = Math.min(own.width, right - left)
    setShift(
      own.right > right || own.width > width ? { maxWidth: width, left: Math.min(0, right - (own.left + width)) } : {},
    )
  }, [shift])
  useEffect(() => {
    const refit = () => setShift(null)
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
  }, [])
  // Esc, or a click outside it, puts it away. From the keyboard, focus goes back to its button.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const outside = event.target instanceof Node && !box.current?.parentElement?.contains(event.target)
      if (outside) close(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close(true)
    }
    document.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', escape, true)
    }
  }, [close])
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Unsubscribe from ${target.sender}?`}
      data-field="unsubscribe-confirm"
      style={shift ?? undefined}
      className="absolute top-10 left-0 z-30 w-[348px] rounded-xl bg-float px-4 pt-4 pb-3 whitespace-normal shadow-float"
    >
      <h4 className="text-subject font-semibold text-fg">Unsubscribe from {target.sender}?</h4>
      <p className="mt-1.5 text-cite text-fg2">
        This tells {target.sender} that {target.me} is read by a person. Most senders stop within a few days.
      </p>
      <p className="mt-2.5 flex items-start gap-1.5 text-meta text-muted" data-field="unsubscribe-how">
        <Zap className="mt-0.5 size-[13px] flex-none" strokeWidth={1.75} aria-hidden />
        {howItGoes(target)}
      </p>
      <div className="mt-3.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => close(true)}
          className="inline-flex h-7 items-center gap-2 rounded-lg pr-[5px] pl-2.5 text-row font-medium text-muted hover:bg-hover hover:text-fg"
        >
          Cancel
          <Key>Esc</Key>
        </button>
        <button
          type="button"
          // Focused as it opens, so Enter confirms.
          ref={(element) => element?.focus({ preventScroll: true })}
          onClick={() => {
            close(true)
            void unsubscribe(target)
          }}
          className="inline-flex h-7 items-center gap-2 rounded-lg bg-pill pr-[5px] pl-2.5 text-row font-medium text-fg outline-none hover:bg-hover focus-visible:bg-hover"
        >
          Unsubscribe
          <Key>↵</Key>
        </button>
      </div>
    </div>
  )
}

/** A conversation's Unsubscribe, before Search, when its newest message from the sender names a way. */
export function ConversationUnsubscribe({ id, mail }: { id: ThreadId; mail: Mail }) {
  const target = targetIn(useThreadDetail(id), mail)
  return target ? <WithRow target={target} /> : null
}

/** The conversation's control, with its sender's Updates row. */
function WithRow({ target }: { target: Target }) {
  const row = useSenderRow(target.inbox, target.accountId, target.address)
  return <Control place="toolbar" target={target} row={row} tooltip />
}

/** A sender's Unsubscribe, beside Archive all, from its newest conversation's target. */
export function SenderUnsubscribe({ sender, newest, mail }: { sender: SenderSummary; newest: ThreadId; mail: Mail }) {
  const target = targetIn(useThreadDetail(newest), mail)
  if (!target) return null
  return <Control place="sender" target={target} row={sender} tooltip={false} />
}

/** On an Updates row, where an unsubscribe from its sender has got, in its volume line. */
export function RowUnsubscribed({ state }: { state: Unsubscribed }) {
  const [Glyph, words, tone] =
    state.state === 'done'
      ? [CircleCheck, 'Unsubscribed', 'text-green']
      : state.state === 'page'
        ? [ExternalLink, 'Unsubscribe page', '']
        : [Clock, 'Unsubscribing', '']
  return (
    <span className="inline-flex items-center gap-1" data-field="row-unsubscribed" data-state={state.state}>
      <span aria-hidden className="text-sep">
        ·
      </span>
      <Glyph className={cx('size-3', tone)} strokeWidth={2} aria-hidden />
      {words}
    </span>
  )
}

/**
 * The toast for the followed unsubscribe, from its sender's row: Undo with the seconds left
 * while held, quiet while sending, then "Unsubscribed" with Archive all, or the page to open.
 */
export function UnsubscribeToast({ mail, onUndo }: { mail: Mail; onUndo: () => Promise<void> }) {
  const followed = useTracked()
  if (!followed) return null
  return (
    <Followed
      key={`${followed.target.messageId} ${followed.change ?? ''}`}
      followed={followed}
      mail={mail}
      onUndo={onUndo}
    />
  )
}

type Followed = NonNullable<ReturnType<typeof useTracked>>

/** A toast's lead icon, at the toast's size. */
const icon = (Glyph: typeof Clock, tone = 'text-fg2') => (
  <Glyph className={`size-[17px] ${tone}`} strokeWidth={2} aria-hidden />
)

function Followed({ followed, mail, onUndo }: { followed: Followed; mail: Mail; onUndo: () => Promise<void> }) {
  const { target, change, failed } = followed
  const row = useSenderRow(target.inbox, target.accountId, target.address)
  const state = row?.unsubscribed?.change === change ? row?.unsubscribed : null
  const over = state?.state === 'done' || state?.state === 'page'
  useEffect(() => {
    if (over && change) reachedEnd(change)
  }, [over, change])
  const ghost = 'inline-flex h-[30px] items-center gap-2 rounded-lg pr-2 pl-2.5 text-fg hover:bg-hover'
  const rule = <span aria-hidden className="mx-0.5 h-[18px] w-px bg-hover" />
  if (failed)
    return (
      <Frame undo="none" onUndo={onUndo}>
        {icon(Info)}
        <span data-field="toast" className="max-w-[460px] truncate">
          {failed}
        </span>
      </Frame>
    )
  if (state?.state === 'done')
    return (
      <Frame undo="none" onUndo={onUndo}>
        {icon(CircleCheck, 'text-green')}
        <span data-field="toast">Unsubscribed from {target.sender}</span>
        {row && row.threads > 0 && (
          <>
            {rule}
            <button
              type="button"
              className={ghost}
              onClick={() => void actOnSender(row, 'archive', target.inbox, mail)}
            >
              <Archive className="size-[15px]" strokeWidth={1.75} aria-hidden />
              Archive all {row.threads}
            </button>
          </>
        )}
      </Frame>
    )
  if (state?.state === 'page')
    return (
      <Frame undo="none" onUndo={onUndo}>
        {icon(Info)}
        <span data-field="toast">{target.sender} unsubscribes on its own page</span>
        {rule}
        <button type="button" className={ghost} onClick={() => openUnsubscribePage(state.url)}>
          <ExternalLink className="size-[15px]" strokeWidth={1.75} aria-hidden />
          Open unsubscribe page
          <span className="font-normal text-muted">· {hostOf(state.url)}</span>
        </button>
      </Frame>
    )
  if (state?.state === 'sending')
    return (
      <Frame undo="none" onUndo={onUndo}>
        {icon(Clock)}
        <span data-field="toast">Unsubscribing from {target.sender}…</span>
      </Frame>
    )
  return (
    <Frame undo={change ? 'ready' : 'waiting'} onUndo={onUndo}>
      {icon(Clock)}
      <span data-field="toast">Unsubscribing from {target.sender}</span>
      {state?.state === 'held' && <Left until={state.until} />}
    </Frame>
  )
}

/** The seconds left of the undo window. Display only: the core's row moves it on. */
function Left({ until }: { until: string }) {
  const seconds = useSecondsUntil(until)
  return seconds > 0 ? (
    <span className="-ml-1 font-normal text-muted tabular-nums" data-field="toast-note">
      in {seconds} s
    </span>
  ) : null
}
