// The toast, raised over the bottom of the reader and never over the list's rows: what the
// last action did, and Undo (z) when it can be undone. With the reply dock up it sits 12 px
// above the dock (CSS anchor positioning, the dock is `--dock`), so it never covers Send or Undo. undo.ts decides what it says and for how long. With no notice up, it offers
// Undo for a reply in its undo window, for exactly as long as the core holds it (sending.ts).

import { CircleCheck, Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSecondsUntil } from './clock.ts'
import { Key } from './Key.tsx'
import { type Offer, useSendOffer } from './sending.ts'
import { UNDO_KEY, useNotice } from './undo.ts'

export function Toast({ onUndo }: { onUndo: () => Promise<void> }) {
  const notice = useNotice()
  const offer = useSendOffer()
  if (notice)
    return (
      // A new offer is a new toast, so it rises again.
      <Frame key={notice.serial} undo={notice.undo ? 'ready' : 'none'} onUndo={onUndo}>
        <CircleCheck className="size-[17px] text-green" strokeWidth={2} aria-hidden />
        <span data-field="toast">{notice.label}</span>
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
