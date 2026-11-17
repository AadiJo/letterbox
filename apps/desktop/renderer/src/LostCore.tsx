// The strip across the reader's foot while this tab has lost the core: why, and Reload, which
// loads the page again and so connects to a core again. It sits under the controls it turns
// off (the toolbar's actions and the reply bar) and never over the toast or a list row: the
// reader's content ends above it, the list runs on to the window's foot, and the toast sits
// 12 px above it.

import { CircleAlert, RotateCw } from 'lucide-react'
import { useLost } from './core.ts'

/**
 * Why the page lost its core, as one plain sentence. The transports and the shell word their
 * reasons for a log (websocket.ts, message-port.ts, the shell's main/core.ts, the dev host's
 * server.ts): a line it could not read, a core that exited, or else a connection that closed,
 * for whatever reason. The raw reason stays in `lostReason` and the strip's tooltip.
 */
function sentence(reason: string) {
  if (reason.startsWith('the core sent a ') || reason.startsWith('the shell sent a frame'))
    return 'Lost the core: the page got a message it could not read.'
  if (reason.startsWith('the core exited') || reason.endsWith(': the core exited)'))
    return 'Lost the core: the core exited.'
  return 'Lost the core: the connection closed.'
}

/**
 * Screen renders it first in the reader pane, and `order-last` shows it at the foot. The toast
 * sits above the last `--dock` anchor in tree order, so a docked reply editor, which comes
 * later, keeps the toast above itself, clear of Send. With no editor up, the strip is the anchor.
 */
export function LostCore() {
  const lost = useLost()
  if (lost === null) return null
  return (
    <div
      role="alert"
      data-field="lost-core"
      className="order-last flex h-11 flex-none items-center border-t border-red/30 bg-red/[0.07] px-6 text-row text-fg2 [anchor-name:--dock] wide:px-10"
    >
      <div className="reading-column flex min-w-0 items-center gap-2">
        <CircleAlert className="size-4 flex-none text-red" strokeWidth={2} aria-hidden />
        {/* A long reason gives way first, so what to do and Reload stay whole. */}
        <b data-field="lost-reason" className="min-w-0 truncate font-medium text-fg" title={lost}>
          {sentence(lost)}
        </b>
        <span className="flex-none whitespace-nowrap">Reload to connect again.</span>
        <button
          type="button"
          onClick={() => location.reload()}
          className="ml-auto inline-flex h-7 flex-none items-center gap-2 rounded-lg bg-pill px-2.5 font-medium text-fg hover:bg-hover"
        >
          <RotateCw className="size-3.5" strokeWidth={1.75} aria-hidden />
          Reload
        </button>
      </div>
    </div>
  )
}
