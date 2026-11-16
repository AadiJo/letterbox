// The dock's frame, which the reply editor and the read-only reply share: a panel at the
// bottom of the reader that the user resizes with its grip, a bordered box inside it, and
// the chips that name the people on a reply.

import { CircleAlert, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { isPlainAddress, type Recipient } from './drafts.ts'

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

/**
 * The dock itself: a resizable panel at the bottom of the reader, holding a bordered box.
 * `onMount` runs as it renders, for the editor's entrance and focus.
 */
export function DockFrame({
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

export const BODY_CLASS =
  'min-h-0 w-full flex-1 resize-none bg-transparent py-3 pr-[max(1rem,calc(100%-72ch-1rem))] pl-4 text-[15px] leading-[23px] text-body outline-none [scrollbar-color:var(--color-line2)_transparent] [scrollbar-width:thin] placeholder:text-faint'

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

const initials = (person: Recipient) =>
  (person.name ?? person.address)
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

/** One person: initials, then their name, or the address alone. An address the core cannot send to shows in red. With no `onRemove`, it cannot be removed. */
export function Chip({ person, onRemove }: { person: Recipient; onRemove: (() => void) | null }) {
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
