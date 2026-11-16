// The People screen: conversations where it is my turn, and those waiting on someone else.

import type { ThreadPage, ThreadSummary } from '@letterbox/protocol'
import { age } from './age.ts'
import { useLost, useView } from './core.ts'

/** The most rows one section shows. */
const LIMIT = 200

export function People() {
  const mine = useView({ view: 'threads', filter: { turn: 'mine' }, offset: 0, limit: LIMIT })
  const theirs = useView({ view: 'threads', filter: { turn: 'theirs' }, offset: 0, limit: LIMIT })
  // Every conversation, for the count in the header. One row is the least the core lists.
  const all = useView({ view: 'threads', filter: {}, offset: 0, limit: 1 })
  const lost = useLost()

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 text-sm text-neutral-900">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">People</h1>
        <p className="text-neutral-500" data-field="total">
          {all ? `${all.total} conversations` : 'Loading'}
        </p>
      </header>
      {lost && (
        <p role="alert" className="mb-4 text-red-700">
          Lost the core: {lost}. Reload to connect again.
        </p>
      )}
      <Section title="Your turn" page={mine} />
      <Section title="Waiting on others" page={theirs} />
    </main>
  )
}

function Section({ title, page }: { title: string; page: ThreadPage | undefined }) {
  return (
    <section aria-label={title} className="mb-8">
      <h2 className="mb-2 font-semibold">
        {title} {page && <span className="font-normal text-neutral-500">{page.total}</span>}
      </h2>
      {!page ? (
        <p className="text-neutral-500">Loading</p>
      ) : page.threads.length === 0 ? (
        <p className="text-neutral-500">Nobody.</p>
      ) : (
        <ol className="divide-y divide-neutral-200 border-y border-neutral-200">
          {page.threads.map((thread) => (
            <Row key={thread.id} thread={thread} />
          ))}
        </ol>
      )}
    </section>
  )
}

function Row({ thread }: { thread: ThreadSummary }) {
  // `people` lists who wrote. In a conversation only I have written in, nobody else is named yet.
  const person = thread.people.find((candidate) => !candidate.isMe)
  return (
    <li className="flex gap-3 py-2">
      <span className="w-40 shrink-0 truncate font-medium" data-field="person">
        {person ? (person.name ?? person.address) : 'You'}
      </span>
      <span className="min-w-0 flex-1 truncate" data-field="subject">
        {thread.subject}
      </span>
      <time className="shrink-0 text-neutral-500 tabular-nums" dateTime={thread.lastMessageAt} data-field="age">
        {age(thread.lastMessageAt)}
      </time>
    </li>
  )
}
