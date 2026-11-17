// The files a message carries, under its body: a row each with the file's type, name and size,
// and Open and Save. Inline images belong to the body, so only attachments proper show here.
//
// The desktop shell does the work, through its bridge (window.letterbox): it fetches the file
// from the core, then saves it where the person picks, or hands it to the OS to open. While it
// fetches, the row says so over a 2 px track. The core sends nothing until the provider has
// handed it the whole file, so there is no progress to show: the track stays empty rather than
// move on a guess. A failed fetch says why, with Retry where trying again can help.
//
// Names come from the message, so the row shows the name the shell will save under
// (safeName). A file that can run code is marked Program at rest, from the same list the shell
// warns from (runsCode). Opening one goes straight to the shell, whose native warning, with
// Cancel the default, is the only one asked.

import { runsCode, safeName } from '@letterbox/client/files'
import type { AttachmentOutcome } from '@letterbox/client/message-port'
import type { Attachment, BlobId } from '@letterbox/protocol'
import { CircleAlert, RotateCw, ShieldAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'

const KB = 1024

/** "212 KB" or "1.4 MB". */
const sizeOf = (bytes: number) =>
  bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / KB / KB).toFixed(1)} MB`

/** The type a file's name ends in, such as PDF, or FILE when it has none. */
const typeOf = (name: string) => (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? 'file').toUpperCase()

type Action = 'open' | 'save'
type Reason = Extract<AttachmentOutcome, { ok: false }>['reason']
/** A row: at rest, waiting on the shell, or showing why the last try failed. */
type State = { kind: 'rest' } | { kind: 'fetching' } | { kind: 'failed'; action: Action; reason: Reason }

/** Asks the shell to open or save a file. A plain browser tab has no shell, so nothing can. */
function viaShell(action: Action, blobId: BlobId): Promise<AttachmentOutcome> {
  const shell = window.letterbox
  if (!shell) return Promise.resolve({ ok: false, reason: 'failed' })
  return action === 'open' ? shell.openAttachment(blobId) : shell.saveAttachment(blobId)
}

/** What a failure says, and whether trying again can help. Null when there is nothing to say. */
function failure(action: Action, reason: Reason) {
  switch (reason) {
    case 'cancelled':
    case 'declined':
      return null
    case 'offline':
      return { says: "Couldn't fetch while offline", retry: true }
    case 'gone':
      return { says: 'No longer on the server', retry: false }
    case 'too-large':
      return { says: 'Too large to fetch', retry: false }
    case 'failed':
      return { says: action === 'open' ? "Couldn't open" : "Couldn't save", retry: true }
  }
}

export function Attachments({ attachments }: { attachments: readonly Attachment[] }) {
  const files = attachments.filter((attachment) => !attachment.inline)
  if (files.length === 0) return null
  return (
    <ul className="mt-[18px] max-w-[640px] overflow-hidden rounded-[10px] inset-ring inset-ring-hover">
      {files.map((file) => (
        <FileRow key={file.blobId} file={file} />
      ))}
    </ul>
  )
}

function FileRow({ file }: { file: Attachment }) {
  const [state, setState] = useState<State>({ kind: 'rest' })
  const name = safeName(file.name)
  const act = async (action: Action) => {
    setState({ kind: 'fetching' })
    const outcome = await viaShell(action, file.blobId).catch((): AttachmentOutcome => ({
      ok: false,
      reason: 'failed',
    }))
    setState(
      outcome.ok || failure(action, outcome.reason) === null
        ? { kind: 'rest' }
        : { kind: 'failed', action, reason: outcome.reason },
    )
  }
  return (
    <li
      data-field="attachment"
      data-state={state.kind}
      className="group relative flex h-12 items-center gap-2.5 border-t border-line pr-2 pl-3 first:border-t-0 hover:bg-wash"
    >
      <span
        data-field="type"
        className="w-[34px] flex-none rounded-[5px] bg-pill py-[3px] text-center text-tiny font-bold tracking-[0.04em] text-fg2"
      >
        {typeOf(name)}
      </span>
      <span data-field="name" className="min-w-0 truncate text-row text-fg2 group-hover:text-fg">
        {name}
      </span>
      {state.kind !== 'fetching' && (
        <span data-field="size" className="flex-none text-meta text-muted tabular-nums">
          {sizeOf(file.size)}
        </span>
      )}
      {runsCode(name) && (
        <span
          data-field="program"
          className="inline-flex flex-none items-center gap-1 rounded-md bg-pill pr-1.5 pl-1 text-key font-medium text-fg2"
        >
          <ShieldAlert className="size-3" strokeWidth={2} aria-hidden />
          Program
        </span>
      )}
      <span className="flex-1" />
      {state.kind === 'rest' && (
        <span className="flex flex-none gap-0.5">
          <RowButton label={`Open ${name}`} onClick={() => void act('open')}>
            Open
          </RowButton>
          <RowButton label={`Save ${name}`} onClick={() => void act('save')}>
            Save
          </RowButton>
        </span>
      )}
      {state.kind === 'fetching' && (
        <>
          <span role="status" data-field="fetching" className="flex-none pr-2.5 text-row text-muted tabular-nums">
            Fetching · {sizeOf(file.size)}
          </span>
          <span aria-hidden data-field="fetch-track" className="absolute inset-x-3 bottom-0 h-0.5 bg-pill" />
        </>
      )}
      {state.kind === 'failed' && <Failed state={state} name={name} onRetry={() => void act(state.action)} />}
    </li>
  )
}

/** Why the last try failed, in red, and Retry when trying again can help. */
function Failed({
  state,
  name,
  onRetry,
}: {
  state: Extract<State, { kind: 'failed' }>
  name: string
  onRetry: () => void
}) {
  const failed = failure(state.action, state.reason)
  if (!failed) return null
  return (
    <>
      <span data-field="failed" className="inline-flex flex-none items-center gap-1.5 pr-1 text-row text-red">
        <CircleAlert className="size-3.5" strokeWidth={2} aria-hidden />
        {failed.says}
      </span>
      {failed.retry && (
        <RowButton label={`Retry ${name}`} onClick={onRetry} tone="text-fg2">
          <RotateCw className="size-3.5" strokeWidth={1.75} aria-hidden />
          Retry
        </RowButton>
      )}
    </>
  )
}

/** A text button on a file's row: muted at rest, brighter while the row is hovered, filled under the pointer. */
function RowButton({
  label,
  onClick,
  tone = 'text-muted group-hover:text-fg2',
  children,
}: {
  label: string
  onClick: () => void
  tone?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-7 flex-none items-center gap-2 rounded-lg px-2.5 text-row font-medium hover:bg-pill hover:text-fg ${tone}`}
    >
      {children}
    </button>
  )
}
