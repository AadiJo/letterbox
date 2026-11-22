// What each attachment's latest open or save came to, by blob id. It lives outside the reader,
// so a file row that goes with its conversation shows the same when it comes back, and a file
// the shell is still fetching is never asked for twice: a second ask while one runs does
// nothing. The desktop shell does the work through its bridge (window.letterbox): it fetches
// the file from the core, then saves it where the person picks or hands it to the OS. A plain
// browser tab has no shell, so every ask there fails.

import type { AttachmentOutcome } from '@letterbox/client/message-port'
import type { BlobId } from '@letterbox/protocol'
import { useSyncExternalStore } from 'react'

export type Action = 'open' | 'save'
export type Reason = Extract<AttachmentOutcome, { ok: false }>['reason']
/** A file: at rest, being fetched for an action, or showing why its last action failed. */
export type FileState =
  | { kind: 'rest' }
  | { kind: 'fetching'; action: Action }
  | { kind: 'failed'; action: Action; reason: Reason }

const REST: FileState = { kind: 'rest' }
const states = new Map<BlobId, FileState>()
const watchers = new Set<() => void>()

const set = (id: BlobId, state: FileState) => {
  if (state.kind === 'rest') states.delete(id)
  else states.set(id, state)
  for (const watcher of watchers) watcher()
}

/** The person closed the save dialog, or chose not to open a program: nothing to say. */
const quiet = (reason: Reason) => reason === 'cancelled' || reason === 'declined'

/** Asks the shell to open or save one file. Settles once the shell answers. Does nothing while that file is being fetched. */
export async function fetchFile(action: Action, id: BlobId) {
  if (states.get(id)?.kind === 'fetching') return
  set(id, { kind: 'fetching', action })
  const shell = window.letterbox
  const outcome = shell
    ? await (action === 'open' ? shell.openAttachment(id) : shell.saveAttachment(id)).catch((): AttachmentOutcome => ({
        ok: false,
        reason: 'failed',
      }))
    : ({ ok: false, reason: 'failed' } satisfies AttachmentOutcome)
  set(id, outcome.ok || quiet(outcome.reason) ? REST : { kind: 'failed', action, reason: outcome.reason })
}

/** Forgets a `gone` answer for one file, as once its message reaches the provider. */
export function forgetGone(id: BlobId) {
  const state = states.get(id)
  if (state?.kind === 'failed' && state.reason === 'gone') set(id, REST)
}

const subscribe = (onChange: () => void) => {
  watchers.add(onChange)
  return () => void watchers.delete(onChange)
}

/** One file's state, for its row. */
export function useFileState(id: BlobId) {
  return useSyncExternalStore(subscribe, () => states.get(id) ?? REST)
}
