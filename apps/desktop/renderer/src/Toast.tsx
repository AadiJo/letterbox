// The toast at the bottom of the list pane: what the last action did, and Undo (z) when it
// can be undone. undo.ts decides what it says and for how long. With no notice up, it offers
// Undo for a reply in its undo window, for exactly as long as the core holds it (sending.ts).

import { Check, Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSecondsUntil } from './clock.ts'
import { type Offer, useSendOffer } from './sending.ts'
import { UNDO_KEY, useNotice } from './undo.ts'

export function Toast({ onUndo }: { onUndo: () => Promise<void> }) {
  const notice = useNotice()
  const offer = useSendOffer()
  if (notice)
    return (
      // A new offer is a new toast, so it rises again.
      <Frame key={notice.serial} undo={notice.undo ? 'ready' : 'none'} onUndo={onUndo}>
        {notice.label === "Too late to undo. It's sending." ? (
          <Clock className="size-3.5 text-fg2" strokeWidth={2} aria-hidden />
        ) : (
          <Check className="size-3.5 text-green" strokeWidth={2} aria-hidden />
        )}
        <span data-field="toast">{notice.label}</span>
      </Frame>
    )
  if (!offer) return null
  return (
    <Frame key={offer.change} undo={offer.located ? 'ready' : 'waiting'} onUndo={onUndo}>
      <Clock className="size-3.5 text-fg2" strokeWidth={2} aria-hidden />
      <span data-field="toast">Sending</span>
      {offer.located ? (
        <Countdown offer={offer} />
      ) : (
        // A merge moved the reply. Undo waits until the conversation that holds it is found.
        <span className="-ml-1 text-muted" data-field="toast-note">
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
      className={`absolute bottom-4 left-1/2 z-10 flex h-[34px] -translate-x-1/2 animate-rise items-center gap-2.5 rounded-[10px] border border-key bg-raised pl-3 ${undo === 'none' ? 'pr-3' : 'pr-1.5'} text-[12.5px] whitespace-nowrap shadow-[0_8px_24px_rgb(0_0_0/0.5)]`}
    >
      {children}
      {undo !== 'none' && (
        <button
          type="button"
          disabled={undo === 'waiting'}
          onClick={() => void onUndo()}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line2 bg-pill px-2 text-xs font-medium text-fg enabled:hover:bg-hover disabled:opacity-50"
        >
          Undo
          <kbd className="rounded border border-key px-[5px] font-mono text-[11px] leading-4 text-faint">
            {UNDO_KEY.toUpperCase()}
          </kbd>
        </button>
      )}
    </div>
  )
}

/** The seconds left by the core's deadline. Display only: the core's update ends the offer. */
function Countdown({ offer }: { offer: Offer }) {
  const seconds = useSecondsUntil(offer.until)
  return seconds > 0 ? <span className="-ml-1 text-muted tabular-nums">in {seconds} s</span> : null
}
