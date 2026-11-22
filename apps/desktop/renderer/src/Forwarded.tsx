// What a forward carries of its original, on the compose page: the original's files as chips
// the user can take off, then the original quoted, indented on a rule and a size smaller. The
// core writes the original into the message and carries the files left on (drafts.ts
// `Forwarding`). Watching the original's conversation keeps its body loaded, which the core
// needs to forward it.

import type { Attachment, Message, Person } from '@letterbox/protocol'
import { X } from 'lucide-react'
import { Avatar } from './Avatar.tsx'
import { useNow } from './clock.ts'
import { COMPOSE, edit, type Forwarding } from './drafts.ts'
import { personName } from './Row.tsx'
import { useThreadDetail } from './threads.ts'
import { messageTime } from './time.ts'

/** The original message, once its conversation is here. Undefined while it loads, null once it is gone. */
function useOriginal(forward: Forwarding): Message | null | undefined {
  const thread = useThreadDetail(forward.threadId)
  if (thread === undefined) return undefined
  return thread?.messages.find((message) => message.id === forward.of) ?? null
}

const KB = 1024

/** "212 KB" or "1.4 MB", as the reader writes a file's size. */
const sizeOf = (bytes: number) =>
  bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / KB / KB).toFixed(1)} MB`

/** The type a file's name ends in, such as PDF, or FILE when it has none. */
const typeOf = (name: string) => (/\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? 'file').toUpperCase()

/** Takes `file` off the page's forward. */
const takeOff = (file: Attachment) =>
  edit(COMPOSE, (current) =>
    current.forward
      ? { ...current, forward: { ...current.forward, without: [...current.forward.without, file.blobId] } }
      : current,
  )

/** The original's files the forward still carries, each with X to take it off. Inline images go with the text. */
export function ForwardedFiles({ forward }: { forward: Forwarding }) {
  const original = useOriginal(forward)
  const files = (original?.attachments ?? []).filter((file) => !file.inline && !forward.without.includes(file.blobId))
  if (files.length === 0) return null
  return (
    <ul className="mt-[18px] flex flex-wrap gap-2">
      {files.map((file) => (
        <li
          key={file.blobId}
          data-field="forward-file"
          className="inline-flex h-10 max-w-full items-center gap-2.5 rounded-[9px] pr-1.5 pl-2.5 text-addr text-fg2 inset-ring inset-ring-hover"
        >
          {/* Neutral and one width, so a type reads as a label and red keeps meaning what failed. */}
          <span className="w-[34px] flex-none rounded-[5px] bg-pill py-[3px] text-center text-tiny font-bold tracking-[0.04em] text-fg2">
            {typeOf(file.name)}
          </span>
          <span className="min-w-0 truncate">{file.name}</span>
          <span className="flex-none text-muted tabular-nums">{sizeOf(file.size)}</span>
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            title="Remove"
            onClick={() => takeOff(file)}
            className="inline-flex size-5 flex-none items-center justify-center rounded-md text-faint hover:bg-hover hover:text-fg"
          >
            <X className="size-[13px]" strokeWidth={2} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}

const shown = (person: Person) => (person.isMe ? 'you' : personName(person))

/** "to you, Hana Sato", or nothing for a message to no one on To or Cc. */
const to = (message: Message) => {
  const people = [...message.to, ...message.cc]
  return people.length > 0 ? [`to ${people.map(shown).join(', ')}`] : []
}

/** The original under a "Forwarding" heading: who wrote it, to whom and when, then its text. */
export function ForwardedOriginal({ forward }: { forward: Forwarding }) {
  const original = useOriginal(forward)
  const now = useNow()
  return (
    <div className="mt-7 border-t border-line" data-field="forwarding">
      <div className="flex h-10 items-center text-caption font-semibold text-section">Forwarding</div>
      {original === null ? (
        <p className="text-row text-muted">The message it forwards is no longer here.</p>
      ) : (
        original && (
          <div className="border-l-2 border-keycap pl-4">
            <div className="flex items-center gap-2.5">
              <Avatar who={original.from} size="folded" />
              <span className="flex-none text-row font-semibold text-fg2">{personName(original.from)}</span>
              <span className="min-w-0 truncate text-addr text-muted">
                {[original.from.address, ...to(original)].join(' · ')}
              </span>
              <span className="ml-auto flex-none text-meta text-muted tabular-nums">
                {messageTime(original.sentAt, now)}
              </span>
            </div>
            <div className="mt-3" data-field="forwarded-text">
              {original.body.state === 'ready' ? (
                original.body.text
                  .split(/\n\s*\n/)
                  .filter((paragraph) => paragraph.trim() !== '')
                  .map((paragraph, index) => (
                    // Paragraphs have no identity beyond their place in a body that never changes.
                    <p key={index} className="mb-3 max-w-[62ch] text-subject whitespace-pre-wrap text-muted">
                      {paragraph}
                    </p>
                  ))
              ) : (
                <p className="mb-3 text-subject text-muted">Loading the message</p>
              )}
            </div>
          </div>
        )
      )}
    </div>
  )
}
