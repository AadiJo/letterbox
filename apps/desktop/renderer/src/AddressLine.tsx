// An address line of the reply dock (Composer.tsx) or the compose page (ComposePage.tsx): its
// label, a chip per person, and a field to type more, with any problem the core found under
// the field. On the page, people the core suggests for what is typed float under the field
// (Suggestions.tsx). A chip is also how the read-only reply on its way names its people.

import { CircleAlert, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Avatar } from './Avatar.tsx'
import {
  commitTyping,
  type DraftKey,
  edit,
  type Field,
  isPlainAddress,
  parseRecipients,
  type Problem,
  type Recipient,
  type Reply,
} from './drafts.ts'
import { type Suggested, Suggestions } from './Suggestions.tsx'

type LineProps = {
  id: DraftKey
  field: Field
  label: string
  reply: Reply
  problem: Problem | null
  /**
   * On the compose page: the people to suggest for what the line holds, and the line sits
   * flush with the reading column. In the dock, undefined.
   */
  suggested?: readonly Suggested[]
  children?: ReactNode
}

/** One address line: its label, a chip per person, and a field to type more. */
export function AddressLine({ id, field, label, reply, problem, suggested, children }: LineProps) {
  const people = reply[field]
  const typing = reply.typing[field]
  const page = suggested !== undefined
  // The suggestion ↑ and ↓ chose, for the text it was chosen at. New text starts at the top.
  const [choice, setChoice] = useState({ typed: '', index: 0 })
  // Esc and leaving the field put the suggestions away until the text changes. Until the field is focused, too.
  const [hidden, setHidden] = useState<string | null>(typing)
  const offered = suggested && hidden !== typing && typing.trim() !== '' ? suggested : []
  const active = choice.typed === typing ? Math.min(choice.index, offered.length - 1) : 0
  const choose = (step: number) =>
    setChoice({ typed: typing, index: (active + step + offered.length) % offered.length })
  const add = (person: Suggested) =>
    edit(id, (current) => ({
      ...current,
      [field]: [...current[field], { address: person.address, name: person.name }],
      typing: { ...current.typing, [field]: '' },
    }))
  const set = (next: string) => edit(id, (current) => ({ ...current, typing: { ...current.typing, [field]: next } }))
  const commit = () => edit(id, (current) => commitTyping(current, field))
  const remove = (index: number) =>
    edit(id, (current) => ({ ...current, [field]: current[field].filter((_, at) => at !== index) }))
  const mine = problem?.at === field ? problem : null
  return (
    // A grid, so a problem under the line starts where its field starts, whatever the label's width.
    <div
      data-address-line={field}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-line ${page ? '' : 'mx-4 wide:mx-6'}`}
    >
      {/* On the page, every label is as wide, so the chips of each line start together. */}
      <label htmlFor={`${id}-${field}`} className={`text-row text-muted ${page ? 'min-w-[30px]' : ''}`}>
        {label}
      </label>
      <div className="relative flex min-h-11 min-w-0 items-center py-[9px]">
        <div data-field="address-field" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
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
            role={page ? 'combobox' : undefined}
            aria-autocomplete={page ? 'list' : undefined}
            aria-expanded={page ? offered.length > 0 : undefined}
            onFocus={() => setHidden(null)}
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
            onBlur={() => {
              setHidden(typing)
              commit()
            }}
            onKeyDown={(event) => {
              const picked = offered[active]
              if (offered.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                choose(event.key === 'ArrowDown' ? 1 : -1)
              } else if (picked && event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                event.preventDefault()
                add(picked)
              } else if (offered.length > 0 && event.key === 'Escape') {
                // Only the suggestions go. The page stays.
                event.stopPropagation()
                setHidden(typing)
              } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && typing.trim() !== '') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Backspace' && typing === '' && people.length > 0) {
                remove(people.length - 1)
              }
            }}
            className="h-[26px] min-w-[120px] flex-1 bg-transparent text-row text-fg caret-blue outline-none"
          />
        </div>
        {offered.length > 0 && <Suggestions people={offered} typed={typing.trim()} active={active} onAdd={add} />}
      </div>
      {children}
      {mine && (
        <p
          role="alert"
          data-field="address-problem"
          className="col-span-2 col-start-2 -mt-0.5 flex items-center gap-1.5 pb-2 text-addr text-red"
        >
          <CircleAlert className="size-3.5 flex-none" strokeWidth={2} aria-hidden />
          {mine.text}
        </p>
      )}
    </div>
  )
}

/**
 * One person: their avatar, then their name, or the address alone. An address the core cannot
 * send to shows in red. With no `onRemove`, as on a reply on its way, it cannot be removed.
 */
export function Chip({ person, onRemove }: { person: Recipient; onRemove: (() => void) | null }) {
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
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${person.name ?? person.address}`}
          onClick={onRemove}
          className="inline-flex size-5 flex-none items-center justify-center rounded-md text-faint group-hover:text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-[13px]" strokeWidth={2} aria-hidden />
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  )
}
