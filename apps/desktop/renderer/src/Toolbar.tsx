// The reader's toolbar: Done (Let go in Let go?), the actions the core has for the open
// conversation, and search, in the reading column. A button is disabled when the core cannot
// do its action here (actions.ts decides), and it shows faint. With the core lost, the lead
// button and the actions are all off at 40%, colors kept, as the strip at the reader's foot
// explains (LostCore.tsx). Search stays on. Each one's tooltip names its key from SHORTCUTS.

import type { ThreadSummary } from '@letterbox/protocol'
import { Archive, Check, Flag, MailOpen, Trash2, Wind } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { type Action, commandFor, type Mail, SHORTCUTS } from './actions.ts'
import { useLost } from './core.ts'
import { cx } from './cx.ts'
import { MailDot } from './MailDot.tsx'
import { Tooltip } from './Tooltip.tsx'

type Props = {
  thread: ThreadSummary | undefined
  mail: Mail
  /** Runs an action. It settles once the core has answered. */
  onAct: (action: Action) => Promise<void>
  search: ReactNode
  /**
   * The outlined first button. Both hand the turn to nobody (`done`, key d). In Let go? that
   * lets an old turn go rather than finishing it, so it says so.
   */
  lead: 'done' | 'let-go'
}

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>

const LEADS = { done: { label: 'Done', Glyph: Check }, 'let-go': { label: 'Let go', Glyph: Wind } } as const

export function Toolbar({ thread, mail, onAct, search, lead }: Props) {
  const { label: leadLabel, Glyph: Lead } = LEADS[lead]
  const lost = useLost() !== null
  const can = (action: Action) => !lost && thread !== undefined && commandFor(action, thread, mail) !== null
  /** How a button looks off: faint where the core cannot act, dimmed whole while it is gone. */
  const off = lost ? 'opacity-40' : 'disabled:text-faint'
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
          className={cx(
            'inline-flex size-8 items-center justify-center rounded-lg text-fg2 enabled:hover:bg-hover enabled:hover:text-fg',
            off,
          )}
        >
          <Glyph className="size-[17px]" strokeWidth={1.75} />
        </button>
      )}
    </Tooltip>
  )
  return (
    // Its controls start on the top band's line, low enough for a tooltip to fit above them.
    <div className="top-band relative z-20 bg-reader px-6 wide:px-10">
      <div className="reading-column flex items-center gap-2">
        <Tooltip label={leadLabel} shortcut={SHORTCUTS.done}>
          {(describedBy) => (
            <button
              type="button"
              aria-describedby={describedBy}
              aria-keyshortcuts={SHORTCUTS.done}
              disabled={!can('done')}
              onClick={() => void onAct('done')}
              className={cx(
                'mr-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-row font-medium whitespace-nowrap text-fg shadow-outline enabled:hover:bg-hover',
                off,
              )}
            >
              <Lead className="size-4" strokeWidth={1.75} aria-hidden />
              {leadLabel}
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
