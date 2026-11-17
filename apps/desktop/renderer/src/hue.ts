// The one place a person or a label gets its color. Each gets a hue from a hash of its key,
// so the same person has the same color on every row, avatar and chip, and so does a label.
// An element sets the hue with `style={tint(hue)}` and colors itself with styles.css's
// `bg-tint`, `text-tint-fg` and `bg-tint-dot`.

import type { CSSProperties } from 'react'

declare module 'react' {
  interface CSSProperties {
    /** The hue the `tint` colors in styles.css read. Set it with `tint`. */
    '--hue'?: number
  }
}

/** People, as the design picks them: blues, violets, pinks and greens. Orange is left out: it means a late turn. */
const PEOPLE = [212, 262, 292, 330, 168, 190, 140, 236] as const
/** Labels: gold, violet, rose, green and sky. */
const LABELS = [42, 250, 345, 162, 200] as const

const hash = (key: string) => [...key].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 0)

const pick = (hues: readonly number[], key: string) => hues[hash(key) % hues.length] ?? hues[0] ?? 0

/** A person's hue, by the name they are shown by (Avatar.tsx `shownAs`). */
export const personHue = (shownAs: string) => pick(PEOPLE, shownAs)

/** A label's hue, by name. */
export const labelHue = (name: string) => pick(LABELS, name)

/** The style that gives an element `hue`. */
export const tint = (hue: number): CSSProperties => ({ '--hue': hue })
