// What every editor ends with: Send, a line on why it waits or why it did not go, and
// Discard. The reply dock (Composer.tsx) and the compose page (ComposePage.tsx) share them.

import { CircleAlert, Trash2 } from 'lucide-react'
import { useSecondsUntil } from './clock.ts'
import type { Composer } from './drafts.ts'
import { chord, Key } from './Key.tsx'
import type { Pending } from './sending.ts'
import { UNDO_KEY } from './undo.ts'

const SEND_KEY = chord('↵')

/** The one blue button. `disabled` while the draft waits on the core or cannot go yet. */
export function SendButton({ disabled, onSend }: { disabled: boolean; onSend: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSend}
      className="inline-flex h-8 flex-none items-center gap-2.5 rounded-[9px] bg-blue pr-1.5 pl-3.5 text-row font-semibold text-paper enabled:hover:brightness-110 disabled:opacity-60"
    >
      Send
      <Key tone="send">{SEND_KEY}</Key>
    </button>
  )
}

type StatusProps = {
  composer: Exclude<Composer, { state: 'collapsed' }>
  /** The conversation's earlier reply still on its way, which holds this one. Null on the compose page. */
  earlier: Pending | null
}

/** Beside Send: Checking, the core's refusal, why Send waits, or else how Undo works. */
export function SendStatus({ composer, earlier }: StatusProps) {
  const problem = composer.state === 'open' ? composer.problem : null
  if (composer.state === 'checking')
    return (
      <p role="status" data-field="send-checking" className="truncate text-row text-fg2">
        Checking whether this was sent…
      </p>
    )
  if (problem?.at === 'send')
    return (
      <p role="alert" data-field="send-problem" className="flex min-w-0 items-center gap-1.5 text-row text-red">
        <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
        <span className="truncate">{problem.text}</span>
      </p>
    )
  if (composer.reply.bccLost)
    return (
      <p role="status" data-field="send-locked" className="truncate text-row text-fg2">
        Check the recipients before sending
      </p>
    )
  if (earlier)
    return (
      <p role="status" data-field="send-locked" className="truncate text-row text-fg2">
        {earlier.until === null ? 'Your earlier reply is still sending' : <StillSending until={earlier.until} />}
      </p>
    )
  return <p className="truncate text-row text-muted">Sends after 10 s. Undo with {UNDO_KEY.toUpperCase()}.</p>
}

/** Why this draft cannot go yet: the conversation's earlier reply, and its seconds left by the core's deadline. */
function StillSending({ until }: { until: string }) {
  return <>Your earlier reply is still sending ({useSecondsUntil(until)} s)</>
}

/** Throws the draft away. It asks nothing. */
export function DiscardButton({ disabled, onDiscard }: { disabled: boolean; onDiscard: () => void }) {
  return (
    <button
      type="button"
      aria-label="Discard"
      title="Discard"
      disabled={disabled}
      onClick={onDiscard}
      className="inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60"
    >
      <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
    </button>
  )
}
