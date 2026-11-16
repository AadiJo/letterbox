// Replying, under the conversation. With no editor open, a reply bar ends the conversation:
// Reply to the last sender, Reply all when anyone else is on the message, and a folded draft's
// first words. The editor docks below the conversation as an inset field that grows with its
// text up to 40% of the reader, then scrolls. Esc folds it back to the bar and keeps the draft;
// Discard throws the draft away. drafts.ts holds the draft and sending.ts sends it.

import type { ThreadDetail, ThreadId } from '@letterbox/protocol'
import { ChevronDown, CircleAlert, Reply as ReplyIcon, ReplyAll, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode } from 'react'
import { REPLY_KEY } from './actions.ts'
import { Avatar } from './Avatar.tsx'
import {
  collapse,
  commitTyping,
  type Composer,
  discard,
  edit,
  type Field,
  isPlainAddress,
  newReply,
  openReply,
  parseRecipients,
  type Problem,
  type Recipient,
  showExtra,
  takeOpening,
} from './drafts.ts'
import { Key } from './Key.tsx'
import { slideUp } from './motion.ts'
import { sendReply } from './sending.ts'
import { UNDO_KEY } from './undo.ts'

const SEND_KEY = navigator.userAgent.includes('Mac') ? '⌘↵' : 'Ctrl ↵'

const firstName = (recipient: Recipient | undefined) => recipient?.name?.split(' ')[0] ?? recipient?.address ?? ''

/** True while the editor shows, rather than the bar. */
export const isComposing = (composer: Composer | undefined) => composer !== undefined && composer.state !== 'collapsed'

/**
 * The bar that ends the conversation: Reply to whoever wrote last, with a folded draft's first
 * words, and Reply all only when the message went to anyone besides the user and them.
 */
export function ReplyBar({ thread, composer }: { thread: ThreadDetail; composer: Composer | undefined }) {
  const to = composer?.reply.to[0] ?? newReply(thread, false)?.to[0]
  const others = newReply(thread, true)?.cc.length ?? 0
  const preview = composer?.reply.text.replace(/\s+/g, ' ').trim() ?? ''
  if (!to && !composer) return null
  return (
    <div className="mt-4 flex h-11 items-center rounded-[10px] bg-well text-row text-muted shadow-well">
      <button
        type="button"
        data-field="reply-bar"
        aria-keyshortcuts={REPLY_KEY}
        onClick={() => openReply(thread, false)}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[10px] pr-2 pl-3.5 text-left hover:text-fg"
      >
        <ReplyIcon className="size-[15px] flex-none" strokeWidth={1.75} aria-hidden />
        <span className="flex-none">Reply to {firstName(to)}</span>
        <span className="min-w-0 flex-1 truncate text-faint">{preview}</span>
        <Key>{REPLY_KEY.toUpperCase()}</Key>
      </button>
      {others > 0 && (
        <button
          type="button"
          aria-keyshortcuts={`Shift+${REPLY_KEY}`}
          onClick={() => openReply(thread, true)}
          className="flex h-full flex-none items-center gap-1.5 rounded-r-[10px] pr-3.5 pl-3 hover:text-fg"
        >
          <ReplyAll className="size-[15px]" strokeWidth={1.75} aria-hidden />
          Reply all
        </button>
      )}
    </div>
  )
}

/**
 * Brings the end of the conversation into view and the editor up, as the user opens it. Only
 * then: not when it shows again as the user moves between conversations.
 */
function arrive(element: HTMLElement | null, id: ThreadId, target: string) {
  if (!element || !takeOpening(id)) return
  const thread = element.closest('article')?.querySelector('[data-scroll]')
  if (thread) thread.scrollTop = thread.scrollHeight
  slideUp(element)
  element.querySelector<HTMLElement>(target)?.focus()
}

export function Editor({ id, composer }: { id: ThreadId; composer: Exclude<Composer, { state: 'collapsed' }> }) {
  const { reply } = composer
  const problem = composer.state === 'open' ? composer.problem : null
  const busy = composer.state !== 'open'

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      collapse(id)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void sendReply(id)
    }
  }

  return (
    <section
      aria-label="Reply"
      ref={(element) => arrive(element, id, reply.to.length > 0 ? 'textarea' : 'input[data-line="to"]')}
      onKeyDown={onKeyDown}
      className="relative z-10 flex max-h-[40%] flex-none flex-col px-6 pb-4 wide:px-10"
    >
      {/* The field reaches 16 or 24 px past the column each side, so its text lines up with the body's. */}
      <div className="reading-column flex min-h-0 flex-1 flex-col">
        <div className="-mx-4 flex min-h-0 flex-1 flex-col rounded-xl bg-well shadow-well wide:-mx-6">
          <AddressLine id={id} field="to" label="To" reply={reply} problem={problem}>
            {!composer.extra && (
              <button
                type="button"
                onClick={() => showExtra(id)}
                className="flex-none rounded-md px-1.5 py-0.5 text-row whitespace-pre text-muted hover:bg-hover hover:text-fg"
              >
                Cc{'  '}Bcc
              </button>
            )}
          </AddressLine>
          {composer.extra && (
            <>
              <AddressLine id={id} field="cc" label="Cc" reply={reply} problem={problem} />
              <AddressLine id={id} field="bcc" label="Bcc" reply={reply} problem={problem} />
            </>
          )}
          {/* As tall as its text, from 120 px, until the dock reaches 40% of the reader. Then it scrolls. */}
          <textarea
            aria-label="Message"
            value={reply.text}
            readOnly={busy}
            placeholder={`Reply to ${firstName(reply.to[0])}`}
            onChange={(event) => {
              const text = event.target.value
              edit(id, (current) => ({ ...current, text }))
            }}
            className="min-h-[120px] w-full flex-[0_1_auto] resize-none bg-transparent px-4 pt-3 text-body text-prose caret-blue outline-none [field-sizing:content] [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin] placeholder:text-faint wide:px-6"
          />
          <footer className="flex h-[50px] flex-none items-center gap-3 pr-2 pl-4 wide:pl-6">
            <button
              type="button"
              disabled={busy}
              onClick={() => void sendReply(id)}
              className="inline-flex h-8 flex-none items-center gap-2.5 rounded-[9px] bg-blue pr-1.5 pl-3.5 text-row font-semibold text-paper enabled:hover:brightness-110 disabled:opacity-60"
            >
              Send
              <Key tone="send">{SEND_KEY}</Key>
            </button>
            {composer.state === 'checking' ? (
              <p role="status" data-field="send-checking" className="truncate text-row text-fg2">
                Checking whether this was sent…
              </p>
            ) : problem?.at === 'send' ? (
              <p role="alert" data-field="send-problem" className="flex min-w-0 items-center gap-1.5 text-row text-red">
                <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
                <span className="truncate">{problem.text}</span>
              </p>
            ) : (
              <p className="truncate text-row text-muted">Sends after 10 s. Undo with {UNDO_KEY.toUpperCase()}.</p>
            )}
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Minimize"
              title="Minimize (Esc)"
              onClick={() => collapse(id)}
              className="inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
            >
              <ChevronDown className="size-4" strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Discard"
              title="Discard"
              disabled={busy}
              onClick={() => discard(id)}
              className="inline-flex size-8 flex-none items-center justify-center rounded-lg text-muted enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-60"
            >
              <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
            </button>
          </footer>
        </div>
      </div>
    </section>
  )
}

type LineProps = {
  id: ThreadId
  field: Field
  label: string
  reply: Composer['reply']
  problem: Problem | null
  children?: ReactNode
}

/** One address line: its label, a chip per person, and a field to type more. */
function AddressLine({ id, field, label, reply, problem, children }: LineProps) {
  const people = reply[field]
  const typing = reply.typing[field]
  const set = (next: string) => edit(id, (current) => ({ ...current, typing: { ...current.typing, [field]: next } }))
  const commit = () => edit(id, (current) => commitTyping(current, field))
  const remove = (index: number) =>
    edit(id, (current) => ({ ...current, [field]: current[field].filter((_, at) => at !== index) }))
  const mine = problem?.at === field ? problem : null
  return (
    <div data-address-line={field} className="mx-4 border-b border-line wide:mx-6">
      <div className="flex min-h-11 items-center gap-2.5 py-[9px]">
        <label htmlFor={`${id}-${field}`} className="w-7 flex-none text-row text-muted">
          {label}
        </label>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {people.map((person, index) => (
            <Chip key={`${person.address} ${index}`} person={person} onRemove={() => remove(index)} />
          ))}
          <input
            id={`${id}-${field}`}
            data-line={field}
            value={typing}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={mine !== null}
            onChange={(event) => {
              const value = event.target.value
              // A pasted or typed separator ends every address before it.
              const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
              if (cut === -1) return set(value)
              const done = parseRecipients(value.slice(0, cut))
              edit(id, (current) => ({
                ...current,
                [field]: [...current[field], ...done],
                typing: { ...current.typing, [field]: value.slice(cut + 1).trimStart() },
              }))
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && typing.trim() !== '') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Backspace' && typing === '' && people.length > 0) {
                remove(people.length - 1)
              }
            }}
            className="h-[26px] min-w-[120px] flex-1 bg-transparent text-row text-fg caret-blue outline-none"
          />
        </div>
        {children}
      </div>
      {mine && (
        <p
          role="alert"
          data-field="address-problem"
          className="-mt-0.5 flex items-center gap-1.5 pb-2 pl-[38px] text-addr text-red"
        >
          <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
          {mine.text}
        </p>
      )}
    </div>
  )
}

/** One person: their avatar, then their name, or the address alone. An address the core cannot send to shows in red. */
function Chip({ person, onRemove }: { person: Recipient; onRemove: () => void }) {
  const valid = isPlainAddress(person.address)
  return (
    <span
      data-chip={valid ? 'ok' : 'invalid'}
      title={person.name ? `${person.name} <${person.address}>` : person.address}
      className={`group inline-flex h-[26px] max-w-[260px] items-center gap-[7px] rounded-[7px] pr-1 pl-1 text-row ${valid ? 'bg-pill text-fg' : 'bg-red/10 text-red inset-ring inset-ring-red/50'}`}
    >
      {valid ? (
        <Avatar who={person} size="chip" />
      ) : (
        <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
      )}
      <span className="truncate">{person.name ?? person.address}</span>
      <button
        type="button"
        aria-label={`Remove ${person.name ?? person.address}`}
        onClick={onRemove}
        className="inline-flex size-5 flex-none items-center justify-center rounded-md text-faint group-hover:text-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-[13px]" strokeWidth={2} aria-hidden />
      </button>
    </span>
  )
}
