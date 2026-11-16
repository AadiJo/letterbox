// A person's initials on their own tint. Every avatar in the app is this one.

import { personHue, tint } from './hue.ts'

/** Who an avatar shows: a name when there is one, and the address that keys their color. */
export type Who = { name: string | null; address: string }

const SIZES = {
  chip: 'size-5 text-tiny',
  account: 'size-[22px] text-tiny',
  folded: 'size-6 text-tiny',
  open: 'size-8 text-caption',
} as const

/** Up to two initials: "Maya Lindqvist" is ML, "robin@vale.test" is R. */
export const initials = ({ name, address }: Who) =>
  (name ?? address.split('@')[0] ?? address)
    .split(/[\s.]+/)
    .filter((word) => word !== '')
    .slice(0, name ? 2 : 1)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')

export function Avatar({ who, size }: { who: Who; size: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      data-avatar=""
      style={tint(personHue(who.address))}
      className={`inline-flex flex-none items-center justify-center rounded-full bg-tint leading-none font-semibold text-tint-fg ${SIZES[size]}`}
    >
      {initials(who)}
    </span>
  )
}
