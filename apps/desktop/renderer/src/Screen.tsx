// What every list screen shares: the list pane's head and sync strip, the reader pane, and
// the selection with its keyboard. PeopleScreen and MailScreen fill in the list.

import type { Account, Command, ThreadId } from '@letterbox/protocol'
import { PanelLeft } from 'lucide-react'
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react'
import { type Action, actionForKey, canReply, type Mail, markRead, REPLY_KEY, run } from './actions.ts'
import { leave, release, shake } from './motion.ts'
import { Reader } from './Reader.tsx'
import { threadDetail, threadRecord, useThread } from './threads.ts'
import { Toast } from './Toast.tsx'
import { Toolbar } from './Toolbar.tsx'
import { startReply, undoSend } from './sending.ts'
import { hasNotice, notify, undo, UNDO_KEY, withdraw } from './undo.ts'

/** What App hands every screen. */
export type Chrome = {
  mail: Mail
  /** Opens the sidebar. Its button shows only in a narrow window. */
  onToggleSidebar: () => void
  /** The search field or, in a narrow window, its icon. */
  search: ReactNode
}

/** True when focus is in a text field, where letters are typing, not shortcuts. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * The selection in a list whose rows, top to bottom, are `order`. Arrow keys and j/k move,
 * actions.ts's keys act on the open conversation, r opens a reply (Shift+R, Reply all), and z
 * undoes the last undoable action.
 * `leaves` says whether a command takes a conversation out of this list. When it does, the
 * row slides out and the next one opens in its place.
 */
export function useSelection(order: readonly ThreadId[], mail: Mail, leaves: (command: Command) => boolean) {
  const [selected, setSelected] = useState<ThreadId | null>(null)
  // Rises on every selection and when the screen goes, so an action that resumes after a
  // wait can tell whether anything moved on meanwhile.
  const generation = useRef(0)
  // False once the screen has gone. An action it started that the core accepts later shows
  // no toast and moves no row: those belong to whatever screen is up now.
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      generation.current += 1
      withdraw()
    }
  }, [])

  /** Opens a conversation, or none. Every way of opening one comes here, so each is marked read. */
  const select = (id: ThreadId | null) => {
    generation.current += 1
    setSelected(id)
    const thread = id === null ? undefined : threadRecord(id)
    if (thread) markRead(thread, mail)
  }

  /**
   * Runs `action` on the open conversation, unless the screen goes before the core answers.
   * A refused action shakes its row. Once the core
   * accepts a command that takes the conversation out of this list, its row slides out and,
   * as the row folds, the next one opens, unless anything was selected or the screen left
   * meanwhile. The list has not changed yet when the action starts, so the rows around the
   * open one are where they were.
   */
  const act = async (action: Action) => {
    const thread = selected ? threadRecord(selected) : undefined
    if (!thread) return
    const index = order.indexOf(thread.id)
    const next = index === -1 ? null : (order[index + 1] ?? order[index - 1] ?? null)
    const started = generation.current
    const command = await run(action, thread, mail)
    if (!live.current) return
    if (!command) return shake(thread.id)
    notify(action, thread)
    if (!leaves(command)) return
    await leave(thread.id)
    if (generation.current === started) select(next)
  }

  /** Opens the reply editor on the open conversation, once its messages are here and its account can send. */
  const reply = (all: boolean) => {
    const thread = selected ? threadRecord(selected) : undefined
    const detail = selected ? threadDetail(selected) : undefined
    if (thread && detail && canReply(thread, mail)) startReply(detail, all)
  }

  /**
   * Undoes what the toast shows: the last action's notice, or else the reply in its undo
   * window. Once the core accepts, its conversation is back and opens again.
   */
  const undoLast = async () => {
    const started = generation.current
    const id = hasNotice() ? await undo() : await undoSend()
    if (!id || !live.current) return
    release(id)
    if (generation.current === started) select(id)
  }

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
    const index = selected ? order.indexOf(selected) : -1
    const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[event.key]
    if (step !== undefined) {
      const next = order[index === -1 ? 0 : index + step]
      if (next) select(next)
      event.preventDefault()
      return
    }
    if (event.key.toLowerCase() === REPLY_KEY) {
      reply(event.shiftKey)
      event.preventDefault()
      return
    }
    if (event.key === UNDO_KEY) {
      void undoLast()
      event.preventDefault()
      return
    }
    const action = actionForKey(event.key)
    if (!action) return
    void act(action)
    event.preventDefault()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])

  return { selected, select, act, reply, undo: undoLast }
}

type ScreenProps = {
  title: string
  subtitle: string
  chrome: Chrome
  accounts: readonly Account[]
  selection: ReturnType<typeof useSelection>
  /** The scrolling list. */
  children: ReactNode
}

/** The list pane beside the reader pane. */
export function Screen({ title, subtitle, chrome, accounts, selection, children }: ScreenProps) {
  const thread = useThread(selection.selected)
  return (
    <>
      <section aria-label={title} className="relative flex min-h-0 w-[384px] flex-none flex-col border-r border-line">
        <header className="flex h-[72px] flex-none items-center gap-2.5 pr-3 pl-[18px]">
          <button
            type="button"
            aria-label="Show the sidebar"
            onClick={chrome.onToggleSidebar}
            className="inline-flex size-7 items-center justify-center rounded-md text-fg2 hover:bg-hover wide:hidden"
          >
            <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] leading-[1.2] font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted" data-field="subtitle">
              {subtitle}
            </p>
          </div>
        </header>
        <SyncStrip accounts={accounts} />
        {children}
        <Toast onUndo={selection.undo} />
      </section>
      <section aria-label="Reader" className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          thread={thread}
          mail={chrome.mail}
          onAct={selection.act}
          onReply={selection.reply}
          search={chrome.search}
        />
        <Reader id={selection.selected} mailboxes={chrome.mail.mailboxes} />
      </section>
    </>
  )
}

const count = new Intl.NumberFormat()

/** The flat progress strip while an account's first sync, or a resync, pulls older mail. */
function SyncStrip({ accounts }: { accounts: readonly Account[] }) {
  const syncing = accounts.flatMap((account) => (account.status.state === 'syncing' ? [account.status] : []))
  if (syncing.length === 0) return null
  const done = syncing.reduce((sum, status) => sum + status.done, 0)
  const totals = syncing.map((status) => status.total)
  const total = totals.every((value) => value !== null) ? totals.reduce((sum, value) => sum + value, 0) : null
  return (
    <div role="status" aria-label="Sync" className="flex flex-col gap-1.5 px-[18px] pt-0.5 pb-3">
      <div className="flex justify-between text-xs text-fg2">
        <b className="font-medium text-fg">Syncing older mail</b>
        <span className="tabular-nums" data-field="sync-count">
          {total === null ? `${count.format(done)} messages so far` : `${count.format(done)} of ${count.format(total)}`}
        </span>
      </div>
      {total !== null && total > 0 && (
        <div className="h-[3px] overflow-hidden rounded-sm bg-line2">
          <div className="h-full bg-blue" style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
        </div>
      )}
      <p className="text-xs text-muted">Newest mail first. You can read it now.</p>
    </div>
  )
}
