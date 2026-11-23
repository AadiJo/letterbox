// Updates: automated mail in the inbox, one row per sender, newest first, from the core's
// senders view. The list is windowed like All mail, so every sender the head counts has a row
// to scroll to. Opening a sender shows its mail in the reader (SenderReader.tsx). Mark read
// and Archive all act on every one of a sender's conversations in one command, which the
// toast's Undo (or z) takes back. j and k, or the arrow keys, move between senders.

import type { Account, Mailbox, MailboxId, SenderId, SenderSummary } from '@letterbox/protocol'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useView } from './core.ts'
import { LostCore } from './LostCore.tsx'
import { OVERSCAN, rangeFor } from './MailScreen.tsx'
import { ROW_HEIGHT, SenderRow } from './Row.tsx'
import { type Chrome, ListPane, namesIn, typing } from './Screen.tsx'
import { actOnSender } from './sender-actions.ts'
import { SenderReader } from './SenderReader.tsx'
import { type Range, type SenderSlice, useSenderWindow } from './senders.ts'
import { undoSend } from './sending.ts'
import { Toast } from './Toast.tsx'
import { hasNotice, undo, UNDO_KEY } from './undo.ts'
import {
  closeConfirm,
  confirmOpen,
  requestConfirm,
  undoableUnsubscribe,
  undoUnsubscribe,
  UNSUBSCRIBE_KEY,
} from './unsubscribe.ts'
import { busiest } from './Volume.tsx'

/** The inbox Updates covers: the first account's. Undefined until the core lists it. */
export const updatesInbox = (accounts: readonly Account[], mailboxes: readonly Mailbox[]) =>
  mailboxes.find((mailbox) => mailbox.role === 'inbox' && mailbox.accountId === accounts[0]?.id)?.id

/** How many senders in Updates over `inbox` have unread mail, for the sidebar. Undefined until the core answers. */
export const useUnreadSenders = (inbox: MailboxId) =>
  useView({ view: 'senders', mailboxId: inbox, offset: 0, limit: 1 })?.unreadSenders

const count = new Intl.NumberFormat()

type Props = { chrome: Chrome; accounts: readonly Account[]; inbox: MailboxId }

export function UpdatesScreen({ chrome, accounts, inbox }: Props) {
  const { slice, show } = useSenderWindow(inbox)
  const senders = slice?.page.senders ?? []
  // The open sender, as last listed: it stays open when the window scrolls away from its row.
  const [open, setOpen] = useState<SenderSummary | null>(null)
  const selected = senders.find((sender) => sender.id === open?.id) ?? open
  const most = busiest(senders.flatMap((sender) => sender.days))
  // Rises whenever the user moves on: opening a sender, or z. An Archive all that the core
  // answers later opens the next sender only if nothing moved on meanwhile, as in Screen.tsx.
  const generation = useRef(0)
  const openSender = (sender: SenderSummary | null) => {
    generation.current += 1
    // An open unsubscribe confirm was about the sender before, so it closes.
    if (sender?.id !== open?.id) closeConfirm()
    setOpen(sender)
  }
  const select = (id: SenderId) => openSender(senders.find((sender) => sender.id === id) ?? null)

  /**
   * Marks all of a sender's mail read, or archives all of it (sender-actions.ts).
   */
  const act = async (sender: SenderSummary, kind: 'read' | 'archive') => {
    const started = generation.current
    if (!(await actOnSender(sender, kind, inbox, chrome.mail))) return
    // Archiving the open sender takes it out of the list, so the next one opens in its place.
    if (kind === 'archive' && sender.id === open?.id && generation.current === started) {
      const index = senders.findIndex((one) => one.id === sender.id)
      openSender(senders[index + 1] ?? senders[index - 1] ?? null)
    }
  }

  /** Undoes what the toast shows: the last action's notice, or else a reply in its undo window (sending.ts). */
  const undoLast = async () => {
    // An unsubscribe on the toast takes z and Undo while the core holds it (unsubscribe.ts).
    const held = undoableUnsubscribe()
    if (held) return undoUnsubscribe(held)
    // z counts as moving on, so an action still waiting on the core opens nothing after it.
    generation.current += 1
    await (hasNotice() ? undo(namesIn(chrome.mail)) : undoSend())
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    // An open unsubscribe confirm takes the keyboard until it closes.
    if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || confirmOpen()) return
    if (event.key === UNDO_KEY) {
      void undoLast()
      event.preventDefault()
      return
    }
    if (event.key === UNSUBSCRIBE_KEY && event.shiftKey) {
      // ⇧U opens the open sender's confirm. Its button decides whether it can.
      requestConfirm('sender')
      event.preventDefault()
      return
    }
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key]
    if (step === undefined) return
    const index = senders.findIndex((sender) => sender.id === open?.id)
    const next = senders[index === -1 ? 0 : index + step]
    if (next) openSender(next)
    event.preventDefault()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  // The head counts the senders with unread mail, the same number the sidebar shows.
  const subtitle = slice
    ? {
        wide: `${count.format(slice.page.unread)} unread from ${count.format(slice.page.unreadSenders)} senders`,
        narrow: `${count.format(slice.page.unread)} unread · ${count.format(slice.page.unreadSenders)} senders`,
      }
    : 'Loading'
  return (
    <>
      <ListPane title="Updates" subtitle={subtitle} chrome={chrome} accounts={accounts}>
        <SenderList
          slice={slice}
          show={show}
          selected={selected?.id ?? null}
          most={most}
          onSelect={select}
          onAct={(sender, kind) => void act(sender, kind)}
          onUnsubscribe={(sender) => {
            openSender(sender)
            requestConfirm('sender')
          }}
        />
      </ListPane>
      <section aria-label="Reader" className="relative flex min-w-0 flex-1 flex-col bg-reader">
        {/* First in tree order and shown last, as in Screen.tsx: LostCore says why. */}
        <LostCore />
        <SenderReader
          sender={selected ?? undefined}
          inbox={inbox}
          most={most}
          chrome={chrome}
          onMarkRead={(one) => void act(one, 'read')}
          onArchive={(one) => void act(one, 'archive')}
        />
        <Toast onUndo={undoLast} onArchiveAll={(row) => void act(row, 'archive')} />
      </section>
    </>
  )
}

type ListProps = {
  slice: SenderSlice | undefined
  show: (range: Range) => void
  selected: SenderId | null
  most: number
  onSelect: (id: SenderId) => void
  onAct: (sender: SenderSummary, kind: 'read' | 'archive') => void
  /** Opens the sender with its unsubscribe confirm up: the hovered row's third button. */
  onUnsubscribe: (sender: SenderSummary) => void
}

/**
 * The senders on screen plus a small overscan, with spacers standing in for the rest, as
 * MailScreen's list does. It subscribes only to the range on screen.
 */
function SenderList({ slice, show, selected, most, onSelect, onAct, onUnsubscribe }: ListProps) {
  const list = useRef<HTMLDivElement>(null)
  const [first, setFirst] = useState(0)
  const [fits, setFits] = useState(0)

  // Follows the list's height, which sets how many rows it shows.
  useEffect(() => {
    const element = list.current
    if (!element) return
    const observer = new ResizeObserver(() => setFits(Math.ceil(element.clientHeight / ROW_HEIGHT) + 1))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Moves the core subscription with the screen.
  const range = rangeFor(first, fits)
  useEffect(() => {
    show({ offset: range.offset, limit: range.limit })
  }, [show, range.offset, range.limit])

  // Keeps the open sender on screen when the keyboard moves past the edge. It scrolls by the
  // sender's place in the whole list, so a sender in the loaded window but not yet painted still comes into view.
  const position = slice && selected ? slice.page.senders.findIndex((sender) => sender.id === selected) : -1
  const selectedIndex = slice && position !== -1 ? slice.offset + position : -1
  useEffect(() => {
    const element = list.current
    if (!element || selectedIndex === -1) return
    const top = selectedIndex * ROW_HEIGHT
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + ROW_HEIGHT - element.clientHeight
  }, [selectedIndex])

  const total = slice?.page.total ?? 0
  const start = Math.max(0, first - OVERSCAN)
  const end = Math.min(total, first + fits + OVERSCAN)
  const at = (index: number) => (slice ? slice.page.senders[index - slice.offset] : undefined)
  const indexes = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index)
  return (
    <div
      ref={list}
      role="listbox"
      aria-label="Updates"
      onScroll={(event) => setFirst(Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT))}
      className="relative min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-color:var(--color-pill)_transparent] [scrollbar-width:thin]"
    >
      <div style={{ height: start * ROW_HEIGHT }} />
      {indexes.map((index) => {
        const sender = at(index)
        if (!sender) return <div key={`empty ${index}`} className="mx-2" style={{ height: ROW_HEIGHT }} />
        return (
          <SenderRow
            key={sender.id}
            sender={sender}
            most={most}
            selected={sender.id === selected}
            divider={index > 0 && sender.id !== selected && at(index - 1)?.id !== selected}
            onSelect={onSelect}
            onMarkRead={(one) => onAct(one, 'read')}
            onArchive={(one) => onAct(one, 'archive')}
            onUnsubscribe={onUnsubscribe}
          />
        )
      })}
      <div style={{ height: Math.max(0, total - end) * ROW_HEIGHT }} />
      {slice?.page.total === 0 && <p className="px-5 pt-[22px] text-row text-muted">No updates in the inbox</p>}
    </div>
  )
}
