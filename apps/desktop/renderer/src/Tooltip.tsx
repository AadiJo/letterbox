// The one tooltip: what a control does and its key, shown on hover or keyboard focus.
// It sits above its control, 6 px clear of it and 8 px clear of the window's top, so it stays
// in the toolbar's band and never covers the subject below. CSS alone shows it, so it costs
// nothing until it appears.

import { type ReactElement, useId } from 'react'
import { Key } from './Key.tsx'

type Props = {
  label: string
  /** The key that does the same, from actions.ts's SHORTCUTS. */
  shortcut: string
  /** The control, given the tooltip's id to describe itself with. */
  children: (describedBy: string) => ReactElement
}

export function Tooltip({ label, shortcut, children }: Props) {
  const id = useId()
  return (
    <span className="group relative inline-flex">
      {children(id)}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 hidden h-[22px] -translate-x-1/2 items-center gap-2 rounded-lg bg-float pr-1 pl-2.5 text-meta font-medium whitespace-nowrap text-fg shadow-float group-hover:flex group-has-focus-visible:flex"
      >
        {label}
        {/* A letter key reads as its capital; a named key, such as Esc, as written. */}
        <Key tone="tip">{shortcut.length === 1 ? shortcut.toUpperCase() : shortcut}</Key>
      </span>
    </span>
  )
}
