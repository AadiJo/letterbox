// The Dark / Original switch at the right of an open message's address line (pick C): a 24 px
// well with two 20 px segments, the scheme the message shows raised. The choice is the
// sender's, kept by the core for its From address (`set-colors`), so it reaches the sender's
// other mail, new mail too. A message with no HTML has no switch, and neither has one whose From
// has no address: the core refuses a choice for it (`not-permitted`), and a refusal it sends all
// the same takes the switch away. It is a radio group: the chosen segment holds the tab stop, and
// the arrow keys choose within it, never reaching the reader's own keys (↑ and ↓ move between
// conversations).

import type { ColorScheme, Message } from '@letterbox/protocol'
import { Moon, Sun } from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import { choosable, colorsOf, setColors } from './colors.ts'
import { cx } from './cx.ts'

const SEGMENTS = [
  { scheme: 'dark', label: 'Dark', Icon: Moon },
  { scheme: 'original', label: 'Original', Icon: Sun },
] as const satisfies readonly { scheme: ColorScheme; label: string; Icon: typeof Moon }[]

export function ColorsSwitch({ message }: { message: Message }) {
  const [refused, setRefused] = useState(false)
  const segments = useRef<(HTMLButtonElement | null)[]>([])
  const colors = colorsOf(message)
  if (!colors || refused || !choosable(message)) return null
  const choose = (scheme: ColorScheme) => {
    if (scheme === colors.scheme) return
    void setColors(message.id, scheme).then((taken) => {
      if (!taken) setRefused(true)
    })
  }
  // An arrow chooses the segment before or after the chosen one, and focus follows it.
  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const at = SEGMENTS.findIndex((segment) => segment.scheme === colors.scheme)
    const next = (at + step + SEGMENTS.length) % SEGMENTS.length
    const segment = SEGMENTS[next]
    if (!segment) return
    choose(segment.scheme)
    segments.current[next]?.focus()
  }
  return (
    <span
      role="radiogroup"
      aria-label="Colors"
      data-field="colors-switch"
      data-scheme={colors.scheme}
      className="ml-auto inline-flex h-6 flex-none items-center gap-0.5 rounded-[7px] bg-well p-0.5 text-meta font-medium shadow-well"
    >
      {SEGMENTS.map(({ scheme, label, Icon }, index) => {
        const on = scheme === colors.scheme
        return (
          <button
            key={scheme}
            ref={(element) => {
              segments.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={onKeyDown}
            data-scheme-option={scheme}
            onClick={() => choose(scheme)}
            className={cx(
              'inline-flex h-5 items-center gap-[5px] rounded-[5px] pr-2 pl-1.5',
              on ? 'bg-sel text-fg shadow-raised' : 'text-muted hover:text-fg2',
            )}
          >
            <Icon className="size-3" strokeWidth={2} aria-hidden />
            {label}
          </button>
        )
      })}
    </span>
  )
}
