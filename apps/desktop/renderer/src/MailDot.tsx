// Mark as unread: an envelope with a filled dot at its corner, drawn in Lucide's style (24 px
// grid, round caps and joins, stroke from the caller). Lucide has no such icon.

import type { LucideProps } from 'lucide-react'

export function MailDot({ className, strokeWidth = 2 }: Pick<LucideProps, 'className' | 'strokeWidth'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M13 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7" />
      <path d="m2 7 8.97 5.7a1.94 1.94 0 0 0 2.06 0L15.5 10" />
      {/* 4 px across at the toolbar's 17 px. */}
      <circle cx="19" cy="6" r="2.8" fill="currentColor" stroke="none" />
    </svg>
  )
}
