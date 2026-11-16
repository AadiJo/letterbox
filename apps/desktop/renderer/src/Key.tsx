// A keycap: the key that does what its button or tooltip says. Every keycap is this one, and
// every shortcut with a modifier reads through `chord`, so the app names keys one way per platform.

import type { ReactNode } from 'react'
import { cx } from './cx.ts'

const MAC = window.letterbox?.platform === 'darwin' || navigator.userAgent.includes('Mac')

/** A shortcut with the platform's command key: "⌘K" on macOS, "Ctrl K" on Windows and Linux. */
export const chord = (key: string) => (MAC ? `⌘${key}` : `Ctrl ${key}`)

const TONES = {
  /** On the reader, the list and the toast. */
  plain: cx('border border-keycap text-faint'),
  /** On a tooltip, a step brighter. */
  tip: cx('border border-keycap text-fg2'),
  /** Inside the blue Send button. */
  send: cx('bg-blue-deep text-fg/85'),
} as const

export function Key({ children, tone = 'plain' }: { children: ReactNode; tone?: keyof typeof TONES }) {
  return (
    <kbd
      className={`inline-flex min-w-[18px] flex-none justify-center rounded px-[5px] font-sans text-key font-medium ${TONES[tone]}`}
    >
      {children}
    </kbd>
  )
}
