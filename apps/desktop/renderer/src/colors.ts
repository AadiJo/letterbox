// How a message's HTML is colored (pick C of the dark-mode mocks). The core names every color
// the HTML sets (protocol `Colors`): each is `var(<cssPrefix>color-N, <the sender's own>)`. Dark,
// the reader sets each one to its swatch's dark value on the frame's root, so the HTML shows
// restyled for the reader. Original, it sets none, so the sender's own colors show, on a dimmed
// card. The choice is the sender's: `set-colors` keeps it for that From address, in its account.
//
// Only DOM APIs write into the frame, through frame-dom.ts: a custom property on its root, named
// with the body's random prefix, which the sender's CSS cannot name. No CSS text is built from
// what the core sent.

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
 * True when the reader offers a choice of colors for `message`: it has HTML, and its From has an
 * address. One with none names no sender to choose for, and the core refuses a choice for it
 * (`not-permitted`).
 */
export const choosable = (message: Message) => colorsOf(message) !== null && message.from.address.trim() !== ''

/**
 * Sets the dark value of each color in `colors.palette` on the frame's root, as
 * `<prefix><color-N>`, when the scheme is dark, and takes each away when it is the sender's own,
 * so every `var()` falls back to the sender's color. Safe to call again on the same document.
 */
export function bindColors(doc: Document, colors: Colors | null, prefix: string) {
  if (!colors) return
  colors.palette.forEach((swatch, index) => {
    const name = `${prefix}color-${index}`
    if (colors.scheme === 'dark') frameDom.setProperty(doc, name, swatch.dark)
    else frameDom.removeProperty(doc, name)
  })
}
