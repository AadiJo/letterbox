// The undo toast at the bottom of the list pane: what the last action did, and Undo (z).
// undo.ts decides what is on offer and for how long.

import { Check } from 'lucide-react'
import { UNDO_KEY, useOffer } from './undo.ts'

export function Toast({ onUndo }: { onUndo: () => Promise<void> }) {
  const offer = useOffer()
  if (!offer) return null
  return (
    <div
      // A new offer is a new toast, so it rises again.
      key={offer.serial}
      role="status"
      className="absolute bottom-4 left-1/2 z-10 flex h-[34px] -translate-x-1/2 animate-rise items-center gap-2.5 rounded-[10px] border border-key bg-raised pr-1.5 pl-3 text-[12.5px] whitespace-nowrap shadow-[0_8px_24px_rgb(0_0_0/0.5)]"
    >
      <Check className="size-3.5 text-green" strokeWidth={2} aria-hidden />
      <span data-field="toast">{offer.label}</span>
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
    </div>
  )
}
