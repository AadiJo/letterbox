// The people the core suggests for what an address line of the compose page holds, floating
// under the field: each one's avatar, name and address, with the typed text marked where it
// starts a word, and how long ago the newest mail with them was. ↑ and ↓ choose one, and ↵ or
// a click adds it (AddressLine.tsx).

import type { Recipient as Suggested } from '@letterbox/protocol'
import { Fragment, useState } from 'react'
import { Avatar } from './Avatar.tsx'
import { useNow } from './clock.ts'
import { useView } from './core.ts'
import type { Field, Reply } from './drafts.ts'
import { Key } from './Key.tsx'
import { age, isRetired, listTime } from './time.ts'

export type { Suggested }

/** The most people suggested at once. */
const LIMIT = 4

/**
 * The people to suggest for line `field` of `reply`, best first, without anyone already on
 * the message. Empty while nothing is typed. The last answer stays while the next is on its way.
 */
export function useSuggested(reply: Reply, field: Field): readonly Suggested[] {
  const taken = new Set([...reply.to, ...reply.cc, ...reply.bcc].map((person) => person.address.toLowerCase()))
  const prefix = reply.typing[field].trim()
  const found = useView({ view: 'recipients', accountId: reply.accountId, prefix, limit: LIMIT + taken.size })
  const [last, setLast] = useState<readonly Suggested[]>([])
  if (found && found !== last) setLast(found)
  if (prefix === '') return []
  return (found ?? last).filter((person) => !taken.has(person.address.toLowerCase())).slice(0, LIMIT)
}

type Props = {
  people: readonly Suggested[]
  /** What is typed, marked where it starts a word of a name or an address. */
  typed: string
  active: number
  onAdd: (person: Suggested) => void
}

/** How long ago `time` was, as a list says it: "7h" or "5d", and a date past People's 30 days. */
const ago = (time: string, now: number) => (isRetired(time, now) ? listTime(time, now) : age(time, now))

export function Suggestions({ people, typed, active, onAdd }: Props) {
  const now = useNow()
  return (
    // It starts at the reading column's edge: the label's 30 px and the 10 px gap to the left of the field.
    <div
      role="listbox"
      aria-label="Suggestions"
      className="absolute top-[calc(100%-4px)] left-[-40px] z-30 w-[380px] rounded-xl bg-float p-1.5 shadow-float"
    >
      {people.map((person, index) => (
        <div
          key={person.address}
          role="option"
          aria-selected={index === active}
          data-suggestion={person.address}
          // Keeps focus in the field, so the click does not first turn the text into a chip.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAdd(person)}
          className={`flex h-12 cursor-default items-center gap-2.5 rounded-lg px-2.5 ${index === active ? 'bg-hover' : ''}`}
        >
          <Avatar who={person} size="folded" />
          <div className="min-w-0">
            <div data-field="name" className="truncate text-row font-medium text-fg2">
              <Marked text={person.name ?? person.address} typed={typed} />
            </div>
            {person.name !== null && (
              <div className="truncate text-meta text-muted">
                <Marked text={person.address} typed={typed} />
              </div>
            )}
          </div>
          <span data-field="last-mail" className="ml-auto flex-none pl-2 text-meta text-muted tabular-nums">
            {ago(person.lastAt, now)}
          </span>
        </div>
      ))}
      <div className="-mx-1.5 mt-1 -mb-1.5 flex gap-3.5 border-t border-line px-4 py-2 text-meta text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Key>↑</Key>
          <Key>↓</Key>
          Choose
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Key>↵</Key>
          Add
        </span>
      </div>
    </div>
  )
}

/** `text` with `typed` marked wherever it starts a word, ignoring case: "Leo **Ma**rchetti". */
function Marked({ text, typed }: { text: string; typed: string }) {
  const escaped = typed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(?<![\\p{L}\\p{N}])(${escaped})`, 'iu'))
  // Split keeps each match at an odd place.
  return parts.map((part, index) => (
    <Fragment key={index}>{index % 2 === 1 ? <b className="font-semibold text-fg">{part}</b> : part}</Fragment>
  ))
}
