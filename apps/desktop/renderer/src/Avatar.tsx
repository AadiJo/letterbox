// A person's initials on their own tint. Every avatar in the app is this one, so a person
// looks the same in the sidebar, the reader and the composer. A sender in Updates, a machine,
// gets the same tint on a rounded square, so it never reads as a person.

import { personHue, tint } from './hue.ts'
import { cx } from './cx.ts'

/**
 * Who an avatar shows. `isMe` marks the user, whom the app knows only by their account's
 * address (the protocol's Account has no name), so the user is shown that way everywhere.
 */
export type Who = { name: string | null; address: string; isMe?: boolean }

const SIZES = {
  chip: cx('size-5 rounded-full text-tiny'),
  account: cx('size-[22px] rounded-full text-tiny'),
  folded: cx('size-6 rounded-full text-tiny'),
  open: cx('size-8 rounded-full text-caption'),
  /** A sender's mark in an Updates row. */
  sender: cx('size-7 rounded-[7px] text-mark'),
  /** A sender's mark on its newest message in the reader. */
  'sender-open': cx('size-8 rounded-lg text-caption'),
} as const

/** The name a person is shown by: their own, or their address before the @. */
export const shownAs = ({ name, address, isMe = false }: Who) =>
  isMe || name === null ? (address.split('@')[0] ?? address) : name

/** Up to two initials: "Maya Lindqvist" is ML. An address gives one: "robin@vale.test" is R. */
export const initials = (who: Who) =>
  shownAs(who)
    .split(/[\s._-]+/)
    .filter((word) => word !== '')
    .slice(0, who.isMe || who.name === null ? 1 : 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

export function Avatar({ who, size }: { who: Who; size: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      data-avatar={initials(who)}
      style={tint(personHue(shownAs(who)))}
      className={`inline-flex flex-none items-center justify-center bg-avatar leading-none font-semibold text-avatar-fg ${SIZES[size]}`}
    >
      {initials(who)}
    </span>
  )
}
