// Updates: automated mail in the inbox, one row per sender, newest first, from the core's
// senders view. Opening a sender shows its mail in the reader (SenderReader.tsx). Mark read
// and Archive all act on every one of a sender's conversations in one command, which the
// toast's Undo (or z) takes back. j and k, or the arrow keys, move between senders.

import type { Account, Mailbox, MailboxId, SenderId, SenderSummary } from '@letterbox/protocol'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { commandFor, send } from './actions.ts'
import { useView } from './core.ts'
import { SenderRow } from './Row.tsx'
import { type Chrome, ListPane, namesIn, typing } from './Screen.tsx'
import { SenderReader } from './SenderReader.tsx'
import { threadsOf } from './threads.ts'
import { Toast } from './Toast.tsx'
import { notifySender, undo, UNDO_KEY } from './undo.ts'
import { busiest } from './Volume.tsx'

/** The most senders the list asks the core for. The core sends the newest first. */
const LIMIT = 200

/** The inbox Updates covers: the first account's. Undefined until the core lists it. */
export const updatesInbox = (accounts: readonly Account[], mailboxes: readonly Mailbox[]) =>
  mailboxes.find((mailbox) => mailbox.role === 'inbox' && mailbox.accountId === accounts[0]?.id)?.id

/** Updates over `inbox`: the newest LIMIT senders, and the counts over all of them. Undefined until the core answers. */
export const useUpdates = (inbox: MailboxId, limit = LIMIT) =>
  useView({ view: 'senders', mailboxId: inbox, offset: 0, limit })

const count = new Intl.NumberFormat()

type Props = { chrome: Chrome; accounts: readonly Account[]; inbox: MailboxId }

export function UpdatesScreen({ chrome, accounts, inbox }: Props) {
  const page = useUpdates(inbox)
  const senders = page?.senders ?? []
  const [selectedId, setSelected] = useState<SenderId | null>(null)
  const selected = senders.find((sender) => sender.id === selectedId)
  const most = busiest(senders.flatMap((sender) => sender.days))
  const list = useRef<HTMLDivElement>(null)

  /**
   * Marks all of a sender's mail read, or archives all of it: one command naming the
   * conversations the core lists for it, built as the toolbar's would be for the first.
   */
  const act = async (sender: SenderSummary, kind: 'read' | 'archive') => {
    const filter = { mailboxId: inbox, sender: sender.id, ...(kind === 'read' && { unread: true }) }
    const threads = await threadsOf(filter, kind === 'read' ? sender.unread : sender.threads)
    const [first] = threads
    const command = first && commandFor(kind === 'read' ? 'unread' : 'archive', first, chrome.mail)
    if (!first || (command?.kind !== 'set-flags' && command?.kind !== 'set-mailboxes')) return
    const threadIds = threads.map((thread) => thread.id)
    const change = await send({ ...command, threadIds })
    if (!change) return
    notifySender(kind === 'read' ? 'Marked read' : 'Archived', sender.name ?? sender.address, first.id, change)
    // Archiving the open sender takes it out of the list, so the next one opens in its place.
    if (kind === 'archive' && sender.id === selectedId) {
      const index = senders.findIndex((one) => one.id === sender.id)
      setSelected((senders[index + 1] ?? senders[index - 1])?.id ?? null)
    }
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
    if (event.key === UNDO_KEY) {
      void undo(namesIn(chrome.mail))
      event.preventDefault()
      return
    }
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key]
    if (step === undefined) return
    const index = senders.findIndex((sender) => sender.id === selectedId)
    const next = senders[index === -1 ? 0 : index + step]
    if (next) setSelected(next.id)
    event.preventDefault()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  // Keeps the open sender on screen when the keyboard moves past the edge.
  useEffect(() => {
    if (selectedId) list.current?.querySelector(`[data-sender="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const subtitle = page
    ? {
        wide: `${count.format(page.unread)} unread from ${count.format(page.total)} senders`,
        narrow: `${count.format(page.unread)} unread · ${count.format(page.total)} senders`,
      }
    : 'Loading'
  return (
    <>
      <ListPane title="Updates" subtitle={subtitle} chrome={chrome} accounts={accounts}>
        <div
          ref={list}
          role="listbox"
          aria-label="Updates"
          className="min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin]"
        >
          {senders.map((sender, index) => (
            <SenderRow
              key={sender.id}
              sender={sender}
              most={most}
              selected={sender.id === selectedId}
              divider={index > 0 && sender.id !== selectedId && senders[index - 1]?.id !== selectedId}
              onSelect={setSelected}
              onMarkRead={(one) => void act(one, 'read')}
              onArchive={(one) => void act(one, 'archive')}
            />
          ))}
          {page?.total === 0 && <p className="px-5 pt-[22px] text-row text-muted">No updates in the inbox</p>}
        </div>
      </ListPane>
      <section aria-label="Reader" className="relative flex min-w-0 flex-1 flex-col bg-reader">
        <SenderReader
          sender={selected}
          inbox={inbox}
          most={most}
          chrome={chrome}
          onMarkRead={(one) => void act(one, 'read')}
          onArchive={(one) => void act(one, 'archive')}
        />
        <Toast
          onUndo={async () => {
            await undo(namesIn(chrome.mail))
          }}
        />
      </section>
    </>
  )
}
