// The images chip at the end of an open message's address line (pick B). With the message's
// images off it reads "Images off" and opens a menu with Show images (I). Shown, it reads
// "Images on" quietly and opens a menu with Block images again. Either menu notes the trackers
// the core took out, which showing images never brings back. A message whose images are all
// trackers, or that has none, has no chip. The choice is the message's own (protocol `ShowImages`).

import type { Message, ShowImages } from '@letterbox/protocol'
import { ChevronDown, Image as ImageIcon, ImageOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cx } from './cx.ts'
import { setImages, SHOW_IMAGES_KEY, trackerNote } from './images.ts'
import { Key } from './Key.tsx'

export function ImagesChip({ message }: { message: Message }) {
  const { body } = message
  // The menu is open for the choice it was opened at, so it closes once the core takes a new one.
  const [openAt, setOpenAt] = useState<ShowImages | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  const shown = body.state === 'ready' ? body.images.shown : null
  const open = openAt !== null && openAt === shown

  // A click outside the menu, or Esc, puts it away.
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOpenAt(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpenAt(null)
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
    setOpenAt(null)
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
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-field="images-chip"
        data-images={body.images.shown}
        onClick={() => setOpenAt(open ? null : body.images.shown)}
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
          role="menu"
          aria-label="Images"
          data-field="images-menu"
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
              className="-mx-1.5 mt-1.5 -mb-1.5 border-t border-line px-4 pt-[9px] pb-2.5 text-meta whitespace-nowrap text-muted"
            >
              {note}
            </p>
          )}
        </div>
      )}
    </span>
  )
}
