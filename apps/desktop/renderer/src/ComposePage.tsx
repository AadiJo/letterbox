// The compose page: a new message or a forward takes the reader. The reader's toolbar band
// says which, To and Cc sit in the reading column, the subject is the 25 px title, and the text
// follows as a message's body would. A forward then shows the original's files, which the user
// can take off, and the original quoted (Forwarded.tsx). Send follows the content and pins to
// the reader's foot once the content reaches it. Esc puts the page away and keeps the draft;
// C, the list head's pen or Forward brings it back. drafts.ts holds the draft (`COMPOSE`) and
// sending.ts sends it, exactly as a reply.

import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { flushSync } from 'react-dom'
import { AddressLine } from './AddressLine.tsx'
import { BccNotice, UndoneNotice } from './Composer.tsx'
import {
  COMPOSE,
  type Composer,
  discard,
  edit,
  type Field,
  type Problem,
  type Reply,
  showPage,
  takeOpening,
} from './drafts.ts'
import { DraftText } from './DraftText.tsx'
import { ForwardedFiles, ForwardedOriginal } from './Forwarded.tsx'
import { DiscardButton, SendButton, SendStatus } from './Send.tsx'
import { sendReply, useUndone } from './sending.ts'
import { useSuggested } from './Suggestions.tsx'

/** Esc puts the page away and keeps the draft. ⌘↵ (Ctrl ↵) sends it. */
function onKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key === 'Escape') {
    event.preventDefault()
    showPage(false)
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void sendReply(COMPOSE)
  }
}

type Props = { composer: Exclude<Composer, { state: 'collapsed' }>; search: ReactNode }

export function ComposePage({ composer, search }: Props) {
  const { reply } = composer
  const problem = composer.state === 'open' ? composer.problem : null
  const busy = composer.state !== 'open'
  // A send the core took back while this draft had text, waiting beside it to be restored or dropped.
  const undone = useUndone(COMPOSE)
  // The Cc and Bcc lines the user asked for. A line with anyone on it shows anyway.
  const [asked, setAsked] = useState<ReadonlySet<Field>>(new Set())
  const shows = (field: 'cc' | 'bcc') => asked.has(field) || reply[field].length > 0 || reply.typing[field] !== ''
  const hidden = (['cc', 'bcc'] as const).filter((field) => !shows(field))
  const show = (field: Field) => {
    flushSync(() => setAsked(new Set([...asked, field])))
    document.getElementById(`${COMPOSE}-${field}`)?.focus()
  }

  const title = reply.forward ? 'Forward' : 'New message'
  return (
    <section
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
      ref={(element) => {
        // As the user opens it, not as it shows again: the cursor goes to To, or to the text once To has someone.
        if (!element || !takeOpening(COMPOSE)) return
        element
          .querySelector<HTMLElement>(reply.to.length > 0 ? '[data-field="draft"]' : 'input[data-line="to"]')
          ?.focus()
      }}
    >
      <div className="top-band relative z-20 bg-reader px-6 wide:px-10">
        <div className="reading-column flex items-center gap-2">
          <span data-field="compose-title" className="inline-flex h-8 items-center text-row font-medium text-muted">
            {title}
          </span>
          <span className="flex-1" />
          {search}
        </div>
      </div>
      <div
        data-scroll=""
        className="min-h-0 flex-1 overflow-y-auto px-6 pt-1 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin] wide:px-10"
      >
        <div className="reading-column">
          <PageLine field="to" label="To" reply={reply} problem={problem}>
            {!shows('cc') && <MoreLines fields={hidden} onShow={show} />}
          </PageLine>
          {shows('cc') && (
            <PageLine field="cc" label="Cc" reply={reply} problem={problem}>
              <MoreLines fields={hidden} onShow={show} />
            </PageLine>
          )}
          {shows('bcc') && <PageLine field="bcc" label="Bcc" reply={reply} problem={problem} />}
          <Subject reply={reply} />
          <DraftText id={COMPOSE} text={reply.text} readOnly={busy} placeholder="Write your message" look="page" />
          {reply.forward && (
            <>
              <ForwardedFiles forward={reply.forward} />
              <ForwardedOriginal forward={reply.forward} />
            </>
          )}
          {(undone || reply.bccLost) && (
            <div className="-mx-4 mt-6 wide:-mx-6">
              {undone && <UndoneNotice undone={undone} over busy={busy} />}
              {reply.bccLost && <BccNotice id={COMPOSE} />}
            </div>
          )}
          {/* Follows the content 24 px below it, and pins to the reader's foot once the content reaches it. */}
          <footer className="sticky bottom-0 mt-6 flex h-16 items-center gap-3 border-t border-line bg-reader">
            <SendButton disabled={busy || reply.bccLost} onSend={() => void sendReply(COMPOSE)} />
            <SendStatus composer={composer} earlier={null} />
            <span className="flex-1" />
            <DiscardButton disabled={busy} onDiscard={() => discard(COMPOSE)} />
          </footer>
        </div>
      </div>
    </section>
  )
}

type LineProps = { field: Field; label: string; reply: Reply; problem: Problem | null; children?: ReactNode }

/** An address line of the page, with people suggested as the user types. */
function PageLine({ field, label, reply, problem, children }: LineProps) {
  const suggested = useSuggested(reply, field)
  return (
    <AddressLine id={COMPOSE} field={field} label={label} reply={reply} problem={problem} suggested={suggested}>
      {children}
    </AddressLine>
  )
}

/** Cc and Bcc, at the end of the last line above them, until the user asks for them. */
function MoreLines({ fields, onShow }: { fields: readonly ('cc' | 'bcc')[]; onShow: (field: Field) => void }) {
  if (fields.length === 0) return null
  return (
    // Its text ends where the line ends.
    <span className="-mr-1 flex flex-none">
      {fields.map((field) => (
        <button
          key={field}
          type="button"
          onClick={() => onShow(field)}
          className="rounded-md px-1 py-0.5 text-row text-muted hover:bg-hover hover:text-fg"
        >
          {field === 'cc' ? 'Cc' : 'Bcc'}
        </button>
      ))}
    </span>
  )
}

/** A forward's leading "Fwd:", which stays as it is while the user edits the rest. */
const LEAD = /^\s*fwd?:\s*/i

/** The subject, as the page's title. A forward's "Fwd:" is quieter, so the weight goes to the real subject. */
function Subject({ reply }: { reply: Reply }) {
  const lead = reply.forward ? (LEAD.exec(reply.subject)?.[0] ?? '') : ''
  const rest = reply.subject.slice(lead.length)
  return (
    <div className="mt-7 flex items-baseline gap-[0.25em] text-title font-semibold tracking-[-0.02em]">
      {lead !== '' && <span className="flex-none font-normal text-muted">{lead.trim()}</span>}
      <input
        aria-label="Subject"
        data-field="subject"
        value={rest}
        placeholder="Subject"
        spellCheck={false}
        onChange={(event) => {
          const next = `${lead.trim()} ${event.target.value}`.trimStart()
          edit(COMPOSE, (current) => ({ ...current, subject: lead === '' ? event.target.value : next }))
        }}
        className="min-w-0 flex-1 bg-transparent text-fg caret-blue outline-none placeholder:text-faint"
      />
    </div>
  )
}
