// The toast, raised over the bottom of the reader and never over the list's rows: what the
// last action did, to what, and Undo (z), or why there is nothing to undo. With the reply dock up it
// sits 12 px above the dock (CSS anchor positioning, the dock is `--dock`), so it never covers
// Send or Undo. undo.ts decides what it says and for how long. With no notice up, it says
// "Undoing…" while the core has not answered an undo of a reply, and otherwise offers Undo for a
// reply in its undo window, for exactly as long as the core holds it (sending.ts).

import { CircleCheck, Clock, Info, Wind } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSecondsUntil } from './clock.ts'
import { Key } from './Key.tsx'
import { type Offer, useSendOffer, useUndoingSend } from './sending.ts'
import { type Notice, UNDO_KEY, useNotice } from './undo.ts'

export function Toast({ onUndo }: { onUndo: () => Promise<void> }) {
  const notice = useNotice()
  const offer = useSendOffer()
  const undoing = useUndoingSend()
  if (notice)
    return (
      // A new offer is a new toast, so it rises again.
      <Frame key={notice.serial} undo={notice.change ? 'ready' : 'none'} onUndo={onUndo}>
        <NoticeIcon icon={notice.icon} />
        <span data-field="toast">{notice.label}</span>
        {notice.note && (
          <span className="-ml-1 max-w-[220px] truncate font-normal text-muted" data-field="toast-note">
            {notice.note}
          </span>
        )}
      </Frame>
    )
  if (undoing)
    return (
      // The reply's text stays kept until the core answers, after a reload if the answer is lost.
      <Frame key="undoing" undo="none" onUndo={onUndo}>
        <Clock className="size-[17px] text-fg2" strokeWidth={2} aria-hidden />
        <span data-field="toast">Undoing…</span>
      </Frame>
    )
  if (!offer) return null
  return (
    <Frame key={offer.change} undo={offer.located ? 'ready' : 'waiting'} onUndo={onUndo}>
      <Clock className="size-[17px] text-fg2" strokeWidth={2} aria-hidden />
      <span data-field="toast">Sending</span>
      {offer.located ? (
        <Countdown offer={offer} />
      ) : (
        // A merge moved the reply. Undo waits until the conversation that holds it is found.
        <span className="-ml-1 font-normal text-muted" data-field="toast-note">
          Finding the conversation…
        </span>
      )}
    </Frame>
  )
}

/** What kind of word the notice is: done, let go, waiting on the provider, or why there is nothing to undo. */
function NoticeIcon({ icon }: { icon: Notice['icon'] }) {
  switch (icon) {
    case 'done':
      return <CircleCheck className="size-[17px] text-green" strokeWidth={2} aria-hidden data-icon="done" />
    case 'wind':
      return <Wind className="size-[17px] text-fg2" strokeWidth={2} aria-hidden data-icon="wind" />
    case 'clock':
      return <Clock className="size-[17px] text-fg2" strokeWidth={2} aria-hidden />
    case 'info':
      return <Info className="size-[17px] text-fg2" strokeWidth={2} aria-hidden />
  }
}

/** The toast's box. `undo` says whether it offers Undo, and whether Undo can run yet. */
function Frame({
  undo,
  onUndo,
  children,
}: {
  undo: 'ready' | 'waiting' | 'none'
  onUndo: () => Promise<void>
  children: ReactNode
}) {
  return (
    <div
      role="status"
      className={`absolute bottom-[calc(anchor(--dock_top,12px)+12px)] left-1/2 z-30 flex h-11 -translate-x-1/2 animate-rise items-center gap-2.5 rounded-xl bg-float pl-3.5 ${undo === 'none' ? 'pr-4' : 'pr-[7px]'} text-row font-medium whitespace-nowrap shadow-float`}
    >
      {children}
      {undo !== 'none' && (
        <>
          <span aria-hidden className="mx-0.5 h-[18px] w-px bg-hover" />
          <button
            type="button"
            disabled={undo === 'waiting'}
            onClick={() => void onUndo()}
            className="inline-flex h-[30px] items-center gap-2 rounded-lg bg-pill pr-2 pl-2.5 text-fg enabled:hover:bg-hover disabled:opacity-50"
          >
            Undo
            <Key>{UNDO_KEY.toUpperCase()}</Key>
          </button>
        </>
      )}
    </div>
  )
}

/** The seconds left by the core's deadline. Display only: the core's update ends the offer. */
function Countdown({ offer }: { offer: Offer }) {
  const seconds = useSecondsUntil(offer.until)
  return seconds > 0 ? <span className="-ml-1 font-normal text-muted tabular-nums">in {seconds} s</span> : null
}
