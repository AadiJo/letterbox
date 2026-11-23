// The images chip at the end of an open message's address line (pick B). With the message's
// images off it reads "Images off" and opens a menu with Show images (I). Shown, it reads
// "Images on" quietly and opens a menu with Block images again. Either menu notes the trackers
// the core took out, which showing images never brings back. A message whose images are all
// trackers, or that has none, has no chip. The choice is the message's own (protocol `ShowImages`).
// I inside an open menu acts on that menu's message. The menu keeps inside the reader, as the
// window resizes too, opening upward when there is no room below, and closing it from the
// keyboard gives focus back to the chip. A reader keys the chip by its message, so an open
// menu never carries over to another message.

import type { Message, ShowImages } from '@letterbox/protocol'
import { ChevronDown, Image as ImageIcon, ImageOff } from 'lucide-react'
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx } from './cx.ts'
import { setImages, SHOW_IMAGES_KEY, trackerNote } from './images.ts'
import { Key } from './Key.tsx'

/** How far the menu stays from the edges of the reader it opens in. */
const INSET = 8

/** The gap between the chip's box and the menu: its 20 px plus 8 px, as `top-7` places it below. */
const GAP = 28

/** The box of the nearest element around `element` that scrolls: the reader's visible part. */
function visibleBounds(element: Element) {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at.getBoundingClientRect()
  }
  return document.documentElement.getBoundingClientRect()
}

export function ImagesChip({ message }: { message: Message }) {
  const { body } = message
  // The menu is open for the choice it was opened at, so it closes once the core takes a new one.
  const [openAt, setOpenAt] = useState<ShowImages | null>(null)
  // Where the menu sits once fitted into the reader. Null while it shows at its own size, to be
  // measured: as it opens, and again when the window resizes.
  const [fit, setFit] = useState<CSSProperties | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const shown = body.state === 'ready' ? body.images.shown : null
  const open = openAt !== null && openAt === shown

  /** Puts the menu away. From the keyboard, focus goes back to the chip. */
  const close = (refocus: boolean) => {
    setOpenAt(null)
    setFit(null)
    if (refocus) chip.current?.focus()
  }

  // Opened, the menu keeps inside the reader's visible part: narrower, so its note wraps, moved
  // left as far as it must, and above the chip when there is not room below it and there is
  // more above. It is measured at its own size, before it paints, each time `fit` is cleared.
  useLayoutEffect(() => {
    const element = menu.current
    if (!open || fit !== null || !element || !box.current) return
    const bounds = visibleBounds(box.current)
    const [left, right] = [Math.max(bounds.left, 0) + INSET, Math.min(bounds.right, window.innerWidth) - INSET]
    const [top, bottom] = [Math.max(bounds.top, 0) + INSET, Math.min(bounds.bottom, window.innerHeight) - INSET]
    const chipBox = box.current.getBoundingClientRect()
    const own = element.getBoundingClientRect()
    const room = right - left
    const width = Math.min(own.width, room)
    const below = bottom - (chipBox.top + GAP)
    // Above, the menu's foot sits INSET over the chip's top.
    const above = chipBox.top - INSET - top
    setFit({
      ...(own.width > room && { maxWidth: room, minWidth: 0 }),
      ...(chipBox.left + width > right && { left: right - (chipBox.left + width) }),
      ...(own.height > below && above > below && { top: 'auto', bottom: GAP }),
    })
  }, [open, fit])

  // A window that resizes while the menu is open fits it again.
  useEffect(() => {
    if (!open) return
    const refit = () => setFit(null)
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
  }, [open])

  // A click outside the menu, or Esc, puts it away.
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) close(false)
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
  }, [open])

  if (body.state !== 'ready' || body.images.remote.length === 0) return null
  const blocked = body.images.shown === 'blocked'
  const note = trackerNote(body.images)
  const choose = (show: ShowImages) => {
    close(true)
    setImages(message.id, show)
  }
  const icon = { className: 'size-[13px] flex-none', strokeWidth: 1.75, 'aria-hidden': true } as const
  return (
    <span ref={box} className="relative inline-flex flex-none items-center gap-1.5">
      {!blocked && (
        <span aria-hidden className="text-sep">
          ·
        </span>
      )}
      <button
        ref={chip}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-field="images-chip"
        data-images={body.images.shown}
        onClick={() => (open ? close(false) : setOpenAt(body.images.shown))}
        className={
          blocked
            ? cx(
                'inline-flex h-5 items-center gap-[5px] rounded-md pr-[7px] pl-1.5 text-meta font-medium',
                open ? 'bg-hover text-fg' : 'bg-pill text-fg2 hover:bg-hover hover:text-fg',
              )
            : 'inline-flex h-5 items-center gap-[5px] rounded-md text-addr text-muted hover:text-fg2'
        }
      >
        {blocked ? <ImageOff {...icon} /> : <ImageIcon {...icon} />}
        {blocked ? 'Images off' : 'Images on'}
        {blocked && <ChevronDown className="size-3 flex-none" strokeWidth={2} aria-hidden />}
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Images"
          data-field="images-menu"
          // I in this menu shows this message's images, whichever message the reader's I would pick.
          onKeyDown={(event) => {
            if (event.key !== SHOW_IMAGES_KEY || event.metaKey || event.ctrlKey || event.altKey) return
            event.preventDefault()
            event.stopPropagation()
            if (blocked) choose('message')
          }}
          style={fit ?? undefined}
          className="absolute top-7 left-0 z-30 w-max min-w-[300px] rounded-xl bg-float p-1.5 shadow-float wide:min-w-[316px]"
        >
          <button
            type="button"
            role="menuitem"
            // The menu's one choice has focus as it opens, so Enter takes it and it reads as chosen.
            ref={(element) => element?.focus({ preventScroll: true })}
            onClick={() => choose(blocked ? 'message' : 'blocked')}
            className="group flex h-[34px] w-full items-center gap-2.5 rounded-lg pr-1.5 pl-2.5 text-left text-row text-fg2 outline-none hover:bg-hover hover:text-fg focus:bg-hover focus:text-fg"
          >
            {blocked ? (
              <ImageIcon
                className="size-4 flex-none text-muted group-hover:text-fg group-focus:text-fg"
                strokeWidth={1.75}
                aria-hidden
              />
            ) : (
              <ImageOff
                className="size-4 flex-none text-muted group-hover:text-fg group-focus:text-fg"
                strokeWidth={1.75}
                aria-hidden
              />
            )}
            <span className="flex-1">{blocked ? 'Show images' : 'Block images again'}</span>
            {blocked && <Key>{SHOW_IMAGES_KEY.toUpperCase()}</Key>}
          </button>
          {note && (
            <p
              data-field="tracker-note"
              className="-mx-1.5 mt-1.5 -mb-1.5 border-t border-line px-4 pt-[9px] pb-2.5 text-meta text-muted"
            >
              {note}
            </p>
          )}
        </div>
      )}
    </span>
  )
}
