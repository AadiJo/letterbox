// The search field: full-text search over the core's local index. Enter searches, Escape
// clears. ⌘K or Ctrl+K focuses it. In a narrow window it is an icon until opened.

import { Search as SearchIcon } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

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
        className={`size-7 items-center justify-center rounded-md text-fg2 hover:bg-hover wide:hidden ${open ? 'hidden' : 'inline-flex'}`}
      >
        <SearchIcon className="size-4" strokeWidth={1.75} aria-hidden />
      </button>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          onSearch(draft.trim())
        }}
        className={`h-7 w-[220px] items-center gap-[7px] rounded-[7px] border border-line bg-raised px-2.5 text-[12.5px] text-muted wide:flex ${open ? 'flex' : 'hidden'}`}
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
        <kbd className="rounded border border-key px-[5px] font-mono text-[11px] leading-4 text-faint">⌘K</kbd>
      </form>
    </>
  )
}
