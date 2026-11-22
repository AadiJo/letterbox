// What each attachment's latest open or save came to, by blob id. A fetch under way lives
// outside the reader, so a file row that goes with its conversation still shows it when it
// comes back, and a file the shell is still fetching is never asked for twice: a second ask
// while one runs does nothing. A failure lives only while a row shows that file: once the last
// one goes, or if the answer comes after it went, the file is at rest again, so the next visit
// starts clean (the file may be there by then) and failures never pile up. The desktop shell
// does the work through its bridge (window.letterbox): it fetches the file from the core, then
// saves it where the person picks or hands it to the OS. A plain browser tab has no shell, so
// every ask there fails.

import type { AttachmentOutcome } from '@letterbox/client/message-port'
import type { BlobId } from '@letterbox/protocol'
import { useEffect, useSyncExternalStore } from 'react'

export type Action = 'open' | 'save'
export type Reason = Extract<AttachmentOutcome, { ok: false }>['reason']
/** A file: at rest, being fetched for an action, or showing why its last action failed. */
export type FileState =
  | { kind: 'rest' }
  | { kind: 'fetching'; action: Action }
  | { kind: 'failed'; action: Action; reason: Reason }

const REST: FileState = { kind: 'rest' }
const states = new Map<BlobId, FileState>()
/** How many rows show each file right now. */
const shown = new Map<BlobId, number>()
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
  const failed = !outcome.ok && !quiet(outcome.reason)
  set(id, failed && shown.has(id) ? { kind: 'failed', action, reason: outcome.reason } : REST)
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

/** One file's state, for its row. While the row is up it counts as showing the file. */
export function useFileState(id: BlobId) {
  useEffect(() => {
    shown.set(id, (shown.get(id) ?? 0) + 1)
    return () => {
      const left = (shown.get(id) ?? 1) - 1
      if (left > 0) return void shown.set(id, left)
      shown.delete(id)
      if (states.get(id)?.kind === 'failed') set(id, REST)
    }
  }, [id])
  return useSyncExternalStore(subscribe, () => states.get(id) ?? REST)
}
