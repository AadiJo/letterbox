// The toast, raised over the bottom of the reader and never over the list's rows: what the last
// action did, and Undo (z) when it can be undone. undo.ts decides what it says and for how long.

import { CircleCheck, Clock } from 'lucide-react'
import { useSecondsUntil } from './clock.ts'
import { Key } from './Key.tsx'
import { type Notice, UNDO_KEY, useNotice } from './undo.ts'

export function Toast({ onUndo }: { onUndo: () => Promise<void> }) {
  const notice = useNotice()
  if (!notice) return null
  return (
    <div
      // A new offer is a new toast, so it rises again.
      key={notice.serial}
      role="status"
      className={`absolute bottom-6 left-1/2 z-30 flex h-11 -translate-x-1/2 animate-rise items-center gap-2.5 rounded-xl bg-float pl-3.5 ${notice.undo ? 'pr-[7px]' : 'pr-4'} text-row font-medium whitespace-nowrap shadow-float`}
    >
      {notice.label === 'Sending' ? (
        <Clock className="size-[17px] text-fg2" strokeWidth={2} aria-hidden />
      ) : (
        <CircleCheck className="size-[17px] text-green" strokeWidth={2} aria-hidden />
      )}
      <span data-field="toast">{notice.label}</span>
      {notice.label === 'Sending' && <Countdown notice={notice} />}
      {notice.undo && (
        <>
          <span aria-hidden className="mx-0.5 h-[18px] w-px bg-hover" />
          <button
            type="button"
            onClick={() => void onUndo()}
            className="inline-flex h-[30px] items-center gap-2 rounded-lg bg-pill pr-2 pl-2.5 text-fg hover:bg-hover"
          >
            Undo
            <Key>{UNDO_KEY.toUpperCase()}</Key>
          </button>
        </>
      )}
    </div>
  )
}

/** The seconds left in a send's undo window, from the time the core gave it. */
function Countdown({ notice }: { notice: Extract<Notice, { label: 'Sending' }> }) {
  const seconds = useSecondsUntil(notice.until)
  return <span className="-ml-1 font-normal text-muted tabular-nums">in {seconds} s</span>
}
