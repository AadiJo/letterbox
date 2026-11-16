// The main window: the sidebar, then the list pane and the reader pane of the place it shows.
// Below 1100 px wide the sidebar folds away behind a toggle in the list's head.

import { useState } from 'react'
import { useLost, useView } from './core.ts'
import { MailScreen } from './MailScreen.tsx'
import { PeopleScreen, usePeople } from './PeopleScreen.tsx'
import type { Chrome } from './Screen.tsx'
import { Search } from './Search.tsx'
import { type Place, Sidebar } from './Sidebar.tsx'

export function App() {
  const accounts = useView({ view: 'accounts' }) ?? []
  const mailboxes = useView({ view: 'mailboxes' }) ?? []
  const people = usePeople()
  const lost = useLost()
  const [place, setPlace] = useState<Place>({ kind: 'people' })
  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const goTo = (next: Place) => {
    setPlace(next)
    setQuery('')
    setSidebarOpen(false)
  }
  const chrome: Chrome = {
    mail: { accounts, mailboxes },
    onToggleSidebar: () => setSidebarOpen(!sidebarOpen),
    search: <Search query={query} onSearch={setQuery} />,
  }

  const screen = () => {
    if (query !== '')
      return <MailScreen key="search" title="Search" filter={{ text: query }} chrome={chrome} accounts={accounts} />
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
    <div className="h-screen bg-desk font-sans text-[13px] leading-[1.45] text-fg antialiased">
      {/* The rounded window. The hairline sits above the panes. */}
      <div className="relative flex h-full overflow-hidden rounded-2xl bg-win after:pointer-events-none after:absolute after:inset-0 after:rounded-2xl after:border after:border-fg/10 after:content-['']">
        <div
          className={`z-20 flex-none p-2 pr-0 wide:static wide:block ${sidebarOpen ? 'absolute inset-y-0 left-0 block rounded-l-2xl bg-win pr-2 wide:bg-transparent wide:pr-0' : 'hidden'}`}
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
            className="absolute inset-0 z-10 bg-desk/40 wide:hidden"
          />
        )}
        <div className="flex min-w-0 flex-1">{screen()}</div>
        {lost && (
          <p
            role="alert"
            className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-line2 bg-panel px-3 py-2 text-xs text-fg2"
          >
            Lost the core: {lost}. Reload to connect again.
          </p>
        )}
      </div>
    </div>
  )
}
