// How a message's HTML is colored (pick C of the dark-mode mocks). The core names every color
// the HTML sets (protocol `Colors`): each is `var(<cssPrefix>color-N, <the sender's own>)`. Dark,
// the reader sets each one to its swatch's dark value on the frame's root, so the HTML shows
// restyled for the reader. Original, it sets none, so the sender's own colors show, on a dimmed
// card. The choice is the sender's: `set-colors` keeps it for that From address, in its account.
//
// Only DOM APIs write into the frame, through frame-dom.ts: the scheme's attributes and an
// important `color-scheme` on its root, and the colors as custom properties there, named with the
// body's random prefix, which the sender's CSS cannot name. No CSS text is built from what the
// core sent, and a color that is not hex is never written. The scheme changes in place, on the
// same document, so a switch never reloads the frame.

import type { Colors, ColorScheme, Message, MessageId } from '@letterbox/protocol'
import { command } from './core.ts'
import { frameDom } from './frame-dom.ts'

/**
 * Sets how the sender of `messageId` has its HTML colored. The thread view reports the new
 * scheme once the core takes it. Resolves false when the core refused it as `not-permitted`:
 * the message's From has no address, so it names no sender to choose for.
 */
export async function setColors(messageId: MessageId, scheme: ColorScheme): Promise<boolean> {
  const answer = await command({ kind: 'set-colors', messageId, scheme }).answer.catch(() => null)
  return !(answer?.kind === 'rejected' && answer.reason === 'not-permitted')
}

/** The colors of a message whose HTML a reader shows, or null for one with no HTML. */
export function colorsOf(message: Message): Colors | null {
  if (message.body.state !== 'ready' || message.body.html === null) return null
  return message.body.colors
}

/**
 * The characters Rust's `char::is_whitespace` takes, the Unicode `White_Space` property, which
 * the core trims from a From address before it refuses an empty one. JavaScript's `trim` takes a
 * different set: it keeps U+0085, and takes U+FEFF, which is not white space.
 */
const WHITE_SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u

/**
 * True when the reader offers a choice of colors for `message`: it has HTML, and its From has an
 * address. One with none names no sender to choose for, and the core refuses a choice for it
 * (`not-permitted`), as the switch also learns from a refusal.
 */
export const choosable = (message: Message) => colorsOf(message) !== null && !WHITE_SPACE.test(message.from.address)

/** A dark value as the core writes one (protocol `Swatch`): `#rrggbb` or `#rrggbbaa`. */
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i

/**
 * Shows the frame's document `doc` in its scheme, in place: its root says the scheme and the
 * look, which pick the frame's own defaults (Body.tsx), its `color-scheme` is set inline and
 * important, which no stylesheet of the sender's can override, any transition the sender set on
 * the root is turned off first, so the new scheme shows at once, and each color in the palette is
 * `<prefix>color-N` on the root, dark, or taken away for the sender's own. A value that is not a
 * hex color is never written: its `var()` then falls back to the sender's color. Safe to call
 * again on the same document, as the scheme changes.
 */
export function applyScheme(doc: Document, colors: Colors | null, prefix: string) {
  const root = frameDom.root(doc)
  if (!root) return
  const scheme = colors?.scheme ?? 'dark'
  // First, so no transition of the sender's on the root keeps the old scheme a while.
  frameDom.setProperty(doc, 'transition', 'none', 'important')
  frameDom.set(root, 'data-letterbox-scheme', scheme)
  frameDom.set(root, 'data-letterbox-look', colors?.look ?? 'branded')
  frameDom.setProperty(doc, 'color-scheme', scheme === 'dark' ? 'dark' : 'light', 'important')
  colors?.palette.forEach((swatch, index) => {
    const name = `${prefix}color-${index}`
    if (scheme === 'dark' && HEX.test(swatch.dark)) frameDom.setProperty(doc, name, swatch.dark)
    else frameDom.removeProperty(doc, name)
  })
}
