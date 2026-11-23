// Unsubscribe A: an outlined Unsubscribe beside Archive all in a sender's toolbar and before
// Search in a conversation's, ⇧U, and a third button on a hovered Updates row. Each opens one
// confirm, a float under the toolbar's button, pinned to the message it opened on. Everything
// they say comes from the core's view of that one sender (unsubscribe.ts): with no answer yet, or
// no row in Updates, there is no control. Once confirmed, the button says where it has got:
// "Unsubscribing" while held or sending, with Undo while held, "Unsubscribed" once done, or a
// button that opens the sender's page when only that is left. The toast says the same, with
// Undo while held and Archive all once done.

import type { MailboxId, SenderSummary, ThreadId, Unsubscribed } from '@letterbox/protocol'
import { Archive, CircleCheck, Clock, ExternalLink, Info, MailX, Zap } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Mail } from './actions.ts'
import { useSecondsUntil } from './clock.ts'
import { useLost } from './core.ts'
import { cx } from './cx.ts'
import { Key, shifted } from './Key.tsx'
import { useThreadDetail } from './threads.ts'
import { Frame } from './Toast.tsx'
import { Tooltip } from './Tooltip.tsx'
import {
  closeConfirm,
  type ConfirmPlace,
  hostOf,
  howItGoes,
  openConfirm,
  openUnsubscribePage,
  PAGE_REFUSALS,
  senderKey,
  type Target,
  targetIn,
  undoUnsubscribe,
  unsubscribe,
  UNSUBSCRIBE_KEY,
  useConfirmClaim,
  useConfirming,
  useInFlight,
  useSenderRow,
  useShown,
  viewed,
  whatItTells,
} from './unsubscribe.ts'

/** How far the confirm keeps from the reader's edges. */
const INSET = 8

const OUTLINED =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-row font-medium whitespace-nowrap text-fg shadow-outline enabled:hover:bg-hover'

type ControlProps = {
  place: ConfirmPlace
  target: Target
  /** In a conversation's toolbar, its tooltip names the sender and ⇧U. */
  tooltip: boolean
}

/**
 * The toolbar's Unsubscribe, its confirm, and what it says once confirmed, all from the core's
 * view of the sender. With no answer yet, or no row in Updates, there is nothing to show.
 */
function Control({ place, target, tooltip }: ControlProps) {
  const row = useSenderRow(target.inbox, target.accountId, target.address)
  return row ? <ForRow place={place} target={target} row={row} tooltip={tooltip} /> : null
}

function ForRow({ place, target, row, tooltip }: ControlProps & { row: SenderSummary }) {
  const lost = useLost() !== null
  const confirming = useConfirming(place)
  const inFlight = useInFlight(target)
  const trigger = useRef<HTMLButtonElement>(null)
  const state = row.unsubscribed
  const eligible = !lost && !inFlight && state === null
  useConfirmClaim(place, target, eligible)
  if (state) return <Where state={state} />
  const open = confirming?.target ?? null
  const label = `Unsubscribe from ${target.sender}`
  const button = (describedBy?: string) => (
    <button
      ref={trigger}
      type="button"
      aria-label={label}
      aria-describedby={describedBy}
      aria-keyshortcuts="Shift+U"
      aria-expanded={open !== null}
      data-field="unsubscribe"
      disabled={!eligible}
      onClick={() => (open ? closeConfirm() : openConfirm(place, target))}
      className={cx(OUTLINED, open && 'bg-hover', lost && 'opacity-40', inFlight && 'disabled:text-faint')}
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
          target={open}
          close={(refocus) => {
            closeConfirm()
            if (refocus) trigger.current?.focus()
          }}
        />
      )}
    </span>
  )
}

const MUTED = 'inline-flex h-8 items-center gap-1.5 px-2 text-row font-medium whitespace-nowrap text-muted'

/** Where a confirmed unsubscribe has got, in the toolbar's button's place. Undo comes only from the core's held state. */
function Where({ state }: { state: Unsubscribed }) {
  switch (state.state) {
    case 'held':
      return (
        <span className="inline-flex items-center gap-1">
          <span className={MUTED} data-field="unsubscribe-state" data-state="held">
            <Clock className="size-4" strokeWidth={1.75} aria-hidden />
            Unsubscribing
          </span>
          <button
            type="button"
            data-field="unsubscribe-undo"
            onClick={() => void undoUnsubscribe(state.change)}
            className="inline-flex h-7 items-center rounded-lg px-2.5 text-row font-medium text-fg2 hover:bg-hover hover:text-fg"
          >
            Undo
          </button>
        </span>
      )
    case 'sending':
      return (
        <span className={MUTED} data-field="unsubscribe-state" data-state="sending">
          <Clock className="size-4" strokeWidth={1.75} aria-hidden />
          Unsubscribing
        </span>
      )
    case 'done':
      return (
        <span className={MUTED} data-field="unsubscribe-state" data-state="done">
          <CircleCheck className="size-4 text-green" strokeWidth={1.75} aria-hidden />
          Unsubscribed
        </span>
      )
    case 'page':
      return (
        <PageButton url={state.url} className={OUTLINED} field="unsubscribe-page">
          <ExternalLink className="size-4" strokeWidth={1.75} aria-hidden />
          <span className="hidden wide:inline">Unsubscribe page</span>
        </PageButton>
      )
  }
}

type PageButtonProps = { url: string; className: string; field: string; children: ReactNode }

/** A button that opens a sender's unsubscribe page, and says in a few words why when the shell refuses. */
function PageButton({ url, className, field, children }: PageButtonProps) {
  const [said, setSaid] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        title={`Opens ${hostOf(url)} in your browser`}
        data-field={field}
        onClick={async () => {
          const outcome = await openUnsubscribePage(url)
          setSaid(outcome === 'opened' ? null : PAGE_REFUSALS[outcome])
        }}
        className={className}
      >
        {children}
      </button>
      {said && (
        <span role="status" className="text-meta font-normal text-muted" data-field="page-refused">
          {said}
        </span>
      )}
    </span>
  )
}

/**
 * The confirm, under its button, for the target pinned as it opened: what unsubscribing tells
 * the sender, how the request goes out, and Cancel (Esc) and Unsubscribe (↵). Tab stays inside
 * it, and the reader's shortcuts wait while it is up. It keeps inside the reader.
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
    const escape = (event: globalThis.KeyboardEvent) => {
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
  /** Tab and Shift+Tab go round its buttons and never leave it. */
  const trap = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const buttons = [...(box.current?.querySelectorAll('button') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]
    event.preventDefault()
    next?.focus()
  }
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={`Unsubscribe from ${target.sender}?`}
      data-field="unsubscribe-confirm"
      data-message={target.messageId}
      onKeyDown={trap}
      style={shift ?? undefined}
      className="absolute top-10 left-0 z-30 w-[348px] rounded-xl bg-float px-4 pt-4 pb-3 whitespace-normal shadow-float"
    >
      <h4 className="text-subject font-semibold text-fg">Unsubscribe from {target.sender}?</h4>
      <p className="mt-1.5 text-cite text-fg2" data-field="unsubscribe-tells">
        {whatItTells(target)}
      </p>
      <p className="mt-2.5 flex items-start gap-1.5 text-meta text-muted" data-field="unsubscribe-how">
        <Zap className="mt-0.5 size-[13px] flex-none" strokeWidth={1.75} aria-hidden />
        {howItGoes(target)}
      </p>
      <div className="mt-3.5 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => close(true)}
          className="inline-flex h-7 items-center gap-2 rounded-lg pr-[5px] pl-2.5 text-row font-medium text-muted outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover"
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
  return target ? <Control place="toolbar" target={target} tooltip /> : null
}

type SenderProps = { sender: Pick<SenderSummary, 'accountId' | 'address'>; newest: ThreadId; mail: Mail }

/**
 * A sender's Unsubscribe, beside Archive all, from its newest conversation's target. Keyed by
 * its sender (`senderKey`), so it only ever shows a target from that sender: none until one
 * loads. While a newer conversation from the same sender loads, the last target stays, so the
 * Unsubscribe, and a confirm open on it, stay up.
 */
export function SenderUnsubscribe({ sender, newest, mail }: SenderProps) {
  const detail = useThreadDetail(newest)
  const loaded = targetIn(detail, mail)
  const found = loaded && senderKey(loaded) === senderKey(sender) ? loaded : null
  const [kept, keep] = useState(found)
  if (detail !== undefined && found?.messageId !== kept?.messageId) keep(found)
  const target = detail === undefined ? kept : found
  return target ? <Control place="sender" target={target} tooltip={false} /> : null
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

/** Archives all of a sender's conversations from the toast: the screen's own Archive all, so its selection moves on as the toolbar's does. */
export type ArchiveAll = (row: SenderSummary, inbox: MailboxId) => void

/**
 * The toast for the unsubscribe it shows, from its sender's view: Undo with the seconds left
 * while held, quiet while sending, then "Unsubscribed" with Archive all, or the page to open.
 */
export function UnsubscribeToast({ onUndo, onArchiveAll }: { onUndo: () => Promise<void>; onArchiveAll: ArchiveAll }) {
  const shown = useShown()
  if (!shown) return null
  return (
    <ShownToast
      key={`${shown.target.messageId} ${shown.change ?? ''} ${shown.failed ?? ''}`}
      shown={shown}
      onUndo={onUndo}
      onArchiveAll={onArchiveAll}
    />
  )
}

type Shown = NonNullable<ReturnType<typeof useShown>>

/** A toast's lead icon, at the toast's size. */
const icon = (Glyph: typeof Clock, tone = 'text-fg2') => (
  <Glyph className={`size-[17px] ${tone}`} strokeWidth={2} aria-hidden />
)

type ShownProps = { shown: Shown; onUndo: () => Promise<void>; onArchiveAll: ArchiveAll }

function ShownToast({ shown, onUndo, onArchiveAll }: ShownProps) {
  const { target, change, failed } = shown
  const row = useSenderRow(target.inbox, target.accountId, target.address)
  const state = row?.unsubscribed?.change === change ? row.unsubscribed : null
  useEffect(() => {
    if (change) viewed(change, state?.state ?? null)
  }, [change, state])
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
            <button type="button" className={ghost} onClick={() => onArchiveAll(row, target.inbox)}>
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
        <PageButton url={state.url} className={ghost} field="toast-page">
          <ExternalLink className="size-[15px]" strokeWidth={1.75} aria-hidden />
          Open unsubscribe page
          <span className="font-normal text-muted">· {hostOf(state.url)}</span>
        </PageButton>
      </Frame>
    )
  // Undo only once the core's view says it holds it, under this change.
  return (
    <Frame undo={state?.state === 'held' ? 'ready' : 'none'} onUndo={onUndo}>
      {icon(Clock)}
      <span data-field="toast">
        Unsubscribing from {target.sender}
        {state?.state === 'held' ? '' : '…'}
      </span>
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
