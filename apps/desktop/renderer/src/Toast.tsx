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
      <Frame key={notice.serial} onUndo={notice.undo ? onUndo : null}>
        <Check className="size-3.5 text-green" strokeWidth={2} aria-hidden />
        <span data-field="toast">{notice.label}</span>
      </Frame>
    )
  if (!offer) return null
  return (
    <Frame key={offer.change} onUndo={onUndo}>
      <Clock className="size-3.5 text-fg2" strokeWidth={2} aria-hidden />
      <span data-field="toast">Sending</span>
      <Countdown offer={offer} />
    </Frame>
  )
}

function Frame({ onUndo, children }: { onUndo: (() => Promise<void>) | null; children: ReactNode }) {
  return (
    <div
      role="status"
      className={`absolute bottom-4 left-1/2 z-10 flex h-[34px] -translate-x-1/2 animate-rise items-center gap-2.5 rounded-[10px] border border-key bg-raised pl-3 ${onUndo ? 'pr-1.5' : 'pr-3'} text-[12.5px] whitespace-nowrap shadow-[0_8px_24px_rgb(0_0_0/0.5)]`}
    >
      {children}
      {onUndo && (
        <button
          type="button"
          onClick={() => void onUndo()}
          className="inline-flex h-6 items-center gap-1.5 rounded-md border border-line2 bg-pill px-2 text-xs font-medium text-fg hover:bg-hover"
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
