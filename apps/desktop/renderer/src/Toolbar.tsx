// The reader's toolbar: the actions the core has for the open conversation, and search.
// A button is disabled when the core cannot do its action here (actions.ts decides).

import type { ThreadSummary } from '@letterbox/protocol'
import { Archive, Check, Flag, Mail as MailIcon, MailOpen, type LucideIcon, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { type Action, commandFor, type Mail, SHORTCUTS } from './actions.ts'

type Props = {
  thread: ThreadSummary | undefined
  mail: Mail
  /** Runs an action. It settles once the core has answered. */
  onAct: (action: Action) => Promise<void>
  search: ReactNode
}

/** A button's tooltip: what it does and its key. */
const title = (label: string, action: Action) => `${label} (${SHORTCUTS[action]})`

export function Toolbar({ thread, mail, onAct, search }: Props) {
  const can = (action: Action) => thread !== undefined && commandFor(action, thread, mail) !== null
  const icon = (action: Action, label: string, Icon: LucideIcon) => (
    <button
      type="button"
      aria-label={label}
      title={title(label, action)}
      disabled={!can(action)}
      onClick={() => void onAct(action)}
      className="inline-flex h-[26px] w-8 items-center justify-center text-fg2 not-first:border-l not-first:border-line2 enabled:hover:bg-hover disabled:text-faint"
    >
      <Icon className="size-[15px]" strokeWidth={1.75} aria-hidden />
    </button>
  )
  return (
    // Spans the reader pane, 40 px in from each side like the conversation below it.
    <div className="flex h-[72px] flex-none items-center gap-0.5 px-10">
      <button
        type="button"
        title={title('Done', 'done')}
        disabled={!can('done')}
        onClick={() => void onAct('done')}
        className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-key bg-raised px-2.5 text-[12.5px] font-medium whitespace-nowrap text-fg enabled:hover:bg-hover disabled:text-faint"
      >
        <Check className="size-3.5" strokeWidth={1.75} aria-hidden />
        Done
      </button>
      <span className="w-2" />
      <div className="inline-flex h-7 overflow-hidden rounded-[7px] border border-line2 bg-raised">
        {icon('archive', 'Archive', Archive)}
        {icon('trash', 'Move to Trash', Trash2)}
        {icon('flag', thread?.flagged ? 'Unflag' : 'Flag', Flag)}
        {thread?.unread ? icon('unread', 'Mark as read', MailOpen) : icon('unread', 'Mark as unread', MailIcon)}
      </div>
      <span className="flex-1" />
      {search}
    </div>
  )
}
