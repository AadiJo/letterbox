// The search field: full-text search over the core's local index. Enter searches, Escape
// clears. ⌘K or Ctrl+K focuses it. In a narrow window it is an icon until opened.

import { Search as SearchIcon } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Key } from './Key.tsx'

type Props = {
  /** The search that is showing, or '' for none. */
  query: string
  onSearch: (text: string) => void
}

export function Search({ query, onSearch }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(query)
  const [open, setOpen] = useState(query !== '')

  /** Shows the field, also in a narrow window, and puts the cursor in it. */
  const focus = () => {
    flushSync(() => setOpen(true))
    input.current?.focus()
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    focus()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return (
    <>
      <button
        type="button"
        aria-label="Search"
        onClick={focus}
        className={`size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg wide:hidden ${open ? 'hidden' : 'inline-flex'}`}
      >
        <SearchIcon className="size-[17px]" strokeWidth={1.75} aria-hidden />
      </button>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          onSearch(draft.trim())
        }}
        // Unboxed until it has focus, when it sinks into a well like the reply field.
        className={`h-8 w-[188px] items-center gap-2 rounded-lg pr-1 pl-2 text-row text-muted focus-within:bg-well focus-within:shadow-well wide:flex ${open ? 'flex' : 'hidden'}`}
      >
        <SearchIcon className="size-4 flex-none" strokeWidth={1.75} aria-hidden />
        <input
          ref={input}
          value={draft}
          placeholder="Search"
          aria-label="Search mail"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            setDraft('')
            setOpen(false)
            event.currentTarget.blur()
            onSearch('')
          }}
          className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
        />
        <Key>⌘K</Key>
      </form>
    </>
  )
}
