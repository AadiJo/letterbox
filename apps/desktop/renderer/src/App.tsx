// The main window: the sidebar, then the list pane and the reader pane of the place it shows.
// Below 1100 px wide the sidebar folds away behind a toggle in the list's head. With the core
// lost, the reader pane says so at its foot (LostCore.tsx). Choosing a notification opens its
// conversation where it lives (chosen.ts).

import { useState } from 'react'
import { type Chosen, useChosen } from './chosen.ts'
import { useView } from './core.ts'
import { MailboxesProvider } from './Label.tsx'
import { MailScreen } from './MailScreen.tsx'
import { PeopleScreen, usePeople } from './PeopleScreen.tsx'
import type { Chrome } from './Screen.tsx'
import { Search } from './Search.tsx'
import { type Place, Sidebar } from './Sidebar.tsx'

export function App() {
  const accounts = useView({ view: 'accounts' }) ?? []
  const mailboxes = useView({ view: 'mailboxes' }) ?? []
  const people = usePeople()
  const [place, setPlace] = useState<Place>({ kind: 'people' })
  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // The choice of conversation App has acted on, and the one the screen is to open.
  const chosen = useChosen()
  const [handled, setHandled] = useState<Chosen | null>(null)
  const [opening, setOpening] = useState<Chosen | null>(null)

  const goTo = (next: Place) => {
    setPlace(next)
    setQuery('')
    setSidebarOpen(false)
    setOpening(null)
  }
  // A new choice opens in People when it is there, else in All mail, which holds every
  // conversation, and a gone one opens to the reader saying so. It waits for People to load,
  // as a choice that opened this window arrives first.
  if (chosen !== handled && people !== undefined) {
    setHandled(chosen)
    if (chosen) {
      goTo(people.mine.includes(chosen.id) || people.theirs.includes(chosen.id) ? { kind: 'people' } : { kind: 'all' })
      setOpening(chosen)
    }
  }
  const chrome: Chrome = {
    mail: { accounts, mailboxes },
    onToggleSidebar: () => setSidebarOpen(!sidebarOpen),
    search: (
      <Search
        query={query}
        onSearch={(text) => {
          setQuery(text)
          setOpening(null)
        }}
      />
    ),
    opening,
  }

  const screen = () => {
    if (query !== '')
      // Keyed by the query, so each search starts with nothing open.
      return (
        <MailScreen
          key={`search ${query}`}
          title="Search"
          filter={{ text: query }}
          chrome={chrome}
          accounts={accounts}
        />
      )
    switch (place.kind) {
      case 'people':
        return <PeopleScreen key="people" chrome={chrome} accounts={accounts} />
      case 'all':
        return <MailScreen key="all" title="All mail" filter={{}} chrome={chrome} accounts={accounts} />
      case 'mailbox': {
        const name = mailboxes.find((mailbox) => mailbox.id === place.id)?.name ?? 'Mailbox'
        return (
          <MailScreen
            key={place.id}
            title={name}
            filter={{ mailboxId: place.id }}
            chrome={chrome}
            accounts={accounts}
          />
        )
      }
    }
  }

  return (
    <div className="h-screen bg-desk font-sans text-row text-fg antialiased">
      {/* The rounded window. The hairline sits above the panes. */}
      <div className="relative flex h-full overflow-hidden rounded-2xl bg-side after:pointer-events-none after:absolute after:inset-0 after:z-40 after:rounded-2xl after:border after:border-fg/10 after:content-['']">
        <MailboxesProvider value={mailboxes}>
          <div
            className={`z-30 flex-none wide:static wide:block ${sidebarOpen ? 'absolute inset-y-0 left-0 block shadow-float' : 'hidden'}`}
          >
            <Sidebar
              place={place}
              onPlace={goTo}
              accounts={accounts}
              mailboxes={mailboxes}
              people={people && { count: people.mine.length, late: people.late }}
            />
          </div>
          {sidebarOpen && (
            <button
              type="button"
              aria-label="Hide the sidebar"
              onClick={() => setSidebarOpen(false)}
              className="absolute inset-0 z-20 bg-desk/40 wide:hidden"
            />
          )}
          <div className="flex min-w-0 flex-1">{screen()}</div>
        </MailboxesProvider>
      </div>
    </div>
  )
}
