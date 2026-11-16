// The toast at the bottom of the list pane: what the last action did, and Undo (z) when it
// can be undone. undo.ts decides what it says and for how long.

import { Check, Clock } from 'lucide-react'
import { useSecondsUntil } from './clock.ts'
import { type Notice, UNDO_KEY, useNotice } from './undo.ts'

export function Toast({ onUndo }: { onUndo: () => Promise<void> }) {
  const notice = useNotice()
  if (!notice) return null
  return (
    <div
      // A new offer is a new toast, so it rises again.
      key={notice.serial}
      role="status"
      className={`absolute bottom-4 left-1/2 z-10 flex h-[34px] -translate-x-1/2 animate-rise items-center gap-2.5 rounded-[10px] border border-key bg-raised pl-3 ${notice.undo ? 'pr-1.5' : 'pr-3'} text-[12.5px] whitespace-nowrap shadow-[0_8px_24px_rgb(0_0_0/0.5)]`}
    >
      {notice.label === 'Sending' ? (
        <Clock className="size-3.5 text-fg2" strokeWidth={2} aria-hidden />
      ) : (
        <Check className="size-3.5 text-green" strokeWidth={2} aria-hidden />
      )}
      <span data-field="toast">{notice.label}</span>
      {notice.label === 'Sending' && <Countdown notice={notice} />}
      {notice.undo && (
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

/** The seconds left in a send's undo window, from the time the core gave it. */
function Countdown({ notice }: { notice: Extract<Notice, { label: 'Sending' }> }) {
  const seconds = useSecondsUntil(notice.until)
  return <span className="-ml-1 text-muted tabular-nums">in {seconds} s</span>
}
