// The files a message carries, under its body: a row each with the file's type, name and size,
// and Open and Save. Inline images belong to the body, so only attachments proper show here.
//
// fetches.ts asks the desktop shell to open or save a file, and keeps what came of it by blob
// id. While the shell fetches, the row says "Fetching" and the size. The core sends nothing
// until the provider has handed it the whole file, so there is no progress to show, and
// nothing on the row pretends to move. A failed fetch says so in red, with the reason after it
// in a quieter color, and Retry where trying again can help. A message the provider does not
// hold yet, such as a forward still on its way, offers neither Open nor Save: the core has no
// file to give for it.
//
// Names come from the message, so the row shows the name the shell will save under
// (safeName). A file that can run code is marked Program at rest, from the same list the shell
// warns from (runsCode). Opening one goes straight to the shell, whose native warning, with
// Cancel the default, is the only one asked.
//
// When the card is narrow, the right side of a row (its buttons, or what happened) wraps under
// the name, and within itself, a reason or Retry onto a line of its own, rather than spill out
// of the card.

import { runsCode, safeName } from '@letterbox/client/files'
import type { Attachment } from '@letterbox/protocol'
import { CircleAlert, Download, RotateCw, ShieldAlert } from 'lucide-react'
import { type ReactNode, useEffect, useEffectEvent, useRef } from 'react'
import { type Action, type FileState, fetchFile, forgetGone, type Reason, useFileState } from './fetches.ts'

const KB = 1024

/** "212 KB" or "1.4 MB". */
const sizeOf = (bytes: number) =>
  bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / KB / KB).toFixed(1)} MB`

/** The type a file's name ends in, such as PDF, or FILE when it has none. */
const typeOf = (name: string) => (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? 'file').toUpperCase()

/** What a failure says: what went wrong, why if there is more to say, and whether trying again can help. */
function failure(action: Action, reason: Reason) {
  switch (reason) {
    case 'cancelled':
    case 'declined':
      return null
    case 'offline':
      return { says: 'Couldn’t fetch', why: 'offline', retry: true }
    case 'gone':
      return { says: 'Couldn’t fetch', why: 'no longer on the server', retry: false }
    case 'too-large':
      return { says: 'Couldn’t fetch', why: 'too large', retry: false }
    case 'failed':
      return { says: action === 'open' ? 'Couldn’t open' : 'Couldn’t save', why: null, retry: true }
  }
}

type Props = {
  attachments: readonly Attachment[]
  /** Whether the provider holds the message, so the core can fetch its files. */
  held: boolean
}

export function Attachments({ attachments, held }: Props) {
  const files = attachments.filter((attachment) => !attachment.inline)
  // A message that reaches the provider keeps its id, and so its files keep theirs: a `gone`
  // from before it got there no longer holds.
  const wasHeld = useRef(held)
  const forget = useEffectEvent(() => {
    for (const file of files) forgetGone(file.blobId)
  })
  useEffect(() => {
    if (held && !wasHeld.current) forget()
    wasHeld.current = held
  }, [held])
  if (files.length === 0) return null
  return (
    <ul className="mt-[18px] max-w-[640px] overflow-hidden rounded-[10px] inset-ring inset-ring-hover">
      {files.map((file) => (
        <FileRow key={file.blobId} file={file} held={held} />
      ))}
    </ul>
  )
}

function FileRow({ file, held }: { file: Attachment; held: boolean }) {
  const state = useFileState(file.blobId)
  const name = safeName(file.name)
  const act = (action: Action) => void fetchFile(action, file.blobId)
  return (
    <li
      data-field="attachment"
      data-state={state.kind}
      className="group flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-line py-1.5 pr-2 pl-3 first:border-t-0 hover:bg-wash"
    >
      {/* The name gives way first; the rest of this side keeps its width. */}
      <span className="flex min-w-min flex-1 basis-0 items-center gap-2.5">
        <span
          data-field="type"
          className="w-[34px] flex-none rounded-[5px] bg-pill py-[3px] text-center text-tiny font-bold tracking-[0.04em] text-fg2"
        >
          {typeOf(name)}
        </span>
        <span data-field="name" className="w-0 max-w-fit min-w-0 flex-1 truncate text-row text-fg2 group-hover:text-fg">
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
      </span>
      {held && (
        <span className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-0.5">
          <Status state={state} name={name} size={file.size} onAct={act} />
        </span>
      )}
    </li>
  )
}

/** The right side of a row: Open and Save, the fetch under way, or why the last one failed. */
function Status({
  state,
  name,
  size,
  onAct,
}: {
  state: FileState
  name: string
  size: number
  onAct: (action: Action) => void
}) {
  switch (state.kind) {
    case 'rest':
      return (
        <>
          <RowButton label={`Open ${name}`} onClick={() => onAct('open')}>
            Open
          </RowButton>
          <RowButton label={`Save ${name}`} onClick={() => onAct('save')}>
            Save
          </RowButton>
        </>
      )
    case 'fetching':
      return (
        <span
          role="status"
          data-field="fetching"
          className="inline-flex items-center gap-1.5 pr-2.5 text-row text-muted tabular-nums"
        >
          <Download className="size-3.5" strokeWidth={1.75} aria-hidden />
          Fetching · {sizeOf(size)}
        </span>
      )
    case 'failed': {
      const failed = failure(state.action, state.reason)
      if (!failed) return null
      return (
        <>
          <span
            data-field="failed"
            className="inline-flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 pr-1 text-row"
          >
            <CircleAlert className="size-3.5 text-red" strokeWidth={2} aria-hidden />
            <span className="text-red">{failed.says}</span>
            {/* The space reads between the two; the gap draws it. */}
            {failed.why && ' '}
            {failed.why && <span className="text-muted">· {failed.why}</span>}
          </span>
          {failed.retry && (
            <RowButton label={`Retry ${name}`} onClick={() => onAct(state.action)} tone="text-fg2">
              <RotateCw className="size-3.5" strokeWidth={1.75} aria-hidden />
              Retry
            </RowButton>
          )}
        </>
      )
    }
  }
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
