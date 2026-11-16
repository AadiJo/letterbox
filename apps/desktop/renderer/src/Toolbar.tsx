// The reader's toolbar: Done, the actions the core has for the open conversation, and search,
// in the reading column. A button is disabled when the core cannot do its action here
// (actions.ts decides). Each one's tooltip names its key from SHORTCUTS.

import type { ThreadSummary } from '@letterbox/protocol'
import { Archive, Check, Flag, MailOpen, Trash2 } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { type Action, commandFor, type Mail, SHORTCUTS } from './actions.ts'
import { MailDot } from './MailDot.tsx'
import { Tooltip } from './Tooltip.tsx'

type Props = {
  thread: ThreadSummary | undefined
  mail: Mail
  /** Runs an action. It settles once the core has answered. */
  onAct: (action: Action) => Promise<void>
  search: ReactNode
}

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>

export function Toolbar({ thread, mail, onAct, search }: Props) {
  const can = (action: Action) => thread !== undefined && commandFor(action, thread, mail) !== null
  const icon = (action: Action, label: string, Glyph: Icon) => (
    <Tooltip label={label} shortcut={SHORTCUTS[action]}>
      {(describedBy) => (
        <button
          type="button"
          aria-label={label}
          aria-describedby={describedBy}
          aria-keyshortcuts={SHORTCUTS[action]}
          disabled={!can(action)}
          onClick={() => void onAct(action)}
          className="inline-flex size-8 items-center justify-center rounded-lg text-fg2 enabled:hover:bg-hover enabled:hover:text-fg disabled:text-faint"
        >
          <Glyph className="size-[17px]" strokeWidth={1.75} />
        </button>
      )}
    </Tooltip>
  )
  return (
    // Its controls start on the top band's line, low enough for a tooltip to fit above them.
    // The fade under the band shows only once the conversation scrolls beneath it.
    <div className="top-band relative z-20 bg-reader px-6 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-5 after:bg-linear-to-b after:from-reader after:to-transparent after:content-[''] wide:px-10">
      <div className="reading-column flex items-center gap-2">
        <Tooltip label="Done" shortcut={SHORTCUTS.done}>
          {(describedBy) => (
            <button
              type="button"
              aria-describedby={describedBy}
              aria-keyshortcuts={SHORTCUTS.done}
              disabled={!can('done')}
              onClick={() => void onAct('done')}
              className="mr-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-row font-medium whitespace-nowrap text-fg shadow-outline enabled:hover:bg-hover disabled:text-faint"
            >
              <Check className="size-4" strokeWidth={1.75} aria-hidden />
              Done
            </button>
          )}
        </Tooltip>
        {icon('archive', 'Archive', Archive)}
        {icon('trash', 'Move to Trash', Trash2)}
        {icon('flag', thread?.flagged ? 'Unflag' : 'Flag', Flag)}
        {thread?.unread ? icon('unread', 'Mark as read', MailOpen) : icon('unread', 'Mark as unread', MailDot)}
        <span className="flex-1" />
        {search}
      </div>
    </div>
  )
}
