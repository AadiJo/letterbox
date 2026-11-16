// Labels, everywhere they show: a named chip on a row and in the reader, and a dot in the
// sidebar. App provides the mailboxes, so a row finds its labels without a view of its own.

import type { Mailbox, MailboxId } from '@letterbox/protocol'
import { createContext, use } from 'react'
import { labelHue, tint } from './hue.ts'

const Mailboxes = createContext<readonly Mailbox[]>([])

/** Gives every row and reader below it the core's mailboxes. */
export const MailboxesProvider = Mailboxes

/** The names of the labels among `mailboxIds`, in the order the core lists labels. */
export function useLabels(mailboxIds: readonly MailboxId[]) {
  return use(Mailboxes)
    .filter((mailbox) => mailbox.role === null && mailboxIds.includes(mailbox.id))
    .map((mailbox) => mailbox.name)
}

/** A label by name, on its tint. `compact` for a list row, beside the sender. */
export function LabelChip({ name, compact = false }: { name: string; compact?: boolean }) {
  return (
    <span
      data-label={name}
      style={tint(labelHue(name))}
      className={`inline-flex flex-none items-center rounded-md bg-tint font-medium whitespace-nowrap text-tint-fg ${compact ? 'h-4 px-1.5 text-key' : 'h-5 gap-1.5 px-2 text-meta'}`}
    >
      {!compact && <LabelDot name={name} />}
      {name}
    </span>
  )
}

/** A label's color alone, where its name is beside it already. */
export function LabelDot({ name, size = 'small' }: { name: string; size?: 'small' | 'nav' }) {
  return (
    <i
      aria-hidden
      style={tint(labelHue(name))}
      className={`block flex-none rounded-full bg-tint-dot ${size === 'nav' ? 'size-2' : 'size-1.5'}`}
    />
  )
}
