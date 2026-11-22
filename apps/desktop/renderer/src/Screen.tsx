// What every list screen shares: the list pane's head and sync strip, the reader pane, and
// the selection with its keyboard. PeopleScreen and MailScreen fill in the list. The compose
// page (ComposePage.tsx) takes the reader pane while it is up. Meanwhile the list shows the
// conversation a forward comes from selected, and for a new message, none.

import type { Account, Command, MailboxId, ThreadId } from '@letterbox/protocol'
import { PanelLeft, SquarePen } from 'lucide-react'
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react'
import {
  type Action,
  actionForKey,
  canReply,
  COMPOSE_KEY,
  FORWARD_KEY,
  type Mail,
  markRead,
  REPLY_KEY,
  run,
} from './actions.ts'
import { ComposePage } from './ComposePage.tsx'
import { forwardable } from './Composer.tsx'
import { COMPOSE, composeForward, composeNew, showPage, useComposer, usePageUp } from './drafts.ts'
import { lostReason } from './core.ts'
import { LostCore } from './LostCore.tsx'
import { leave, release, shake } from './motion.ts'
import { Reader } from './Reader.tsx'
import { threadDetail, threadRecord, useThread } from './threads.ts'
import { Toast } from './Toast.tsx'
import { Toolbar } from './Toolbar.tsx'
import { Tooltip } from './Tooltip.tsx'
import { startReply, undoSend } from './sending.ts'
import { hasNotice, notify, undo, UNDO_KEY, withdraw } from './undo.ts'

/** What App hands every screen. */
export type Chrome = {
  mail: Mail
  /** Opens the sidebar. Its button shows only in a narrow window. */
  onToggleSidebar: () => void
  /** The search field or, in a narrow window, its icon. */
  search: ReactNode
  /** A conversation to open, as when the person chose its notification. A new object for each. */
  opening: { id: ThreadId } | null
}

/** True when focus is in a text field, where letters are typing, not shortcuts. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/**
 * The selection in a list whose rows, top to bottom, are `order`. Arrow keys and j/k move,
 * actions.ts's keys act on the open conversation, r opens a reply (Shift+R, Reply all), f
 * forwards, c starts a new message, and z undoes what the toast shows. While the compose page
 * is up, the row a forward comes from shows selected, or none for a new message, and only
 * moving, which puts the page away, and z act.
 * `leaves` says whether a command takes a conversation out of this list. When it does, the
 * row slides out and the next one opens in its place.
 */
export function useSelection(order: readonly ThreadId[], mail: Mail, leaves: (command: Command) => boolean) {
  const [selected, setSelected] = useState<ThreadId | null>(null)
  const page = usePageUp()
  // The conversation the page's forward comes from. A new message comes from none.
  const source = useComposer(COMPOSE)?.reply.forward?.threadId ?? null
  // Rises on every selection, on every z and when the screen goes, so an action that resumes
  // after a wait can tell whether anything moved on meanwhile.
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
    // Opening a conversation puts the compose page away. Its draft stays.
    showPage(false)
    generation.current += 1
    setSelected(id)
    const thread = id === null ? undefined : threadRecord(id)
    if (thread) markRead(thread, mail)
  }

  /**
   * Runs `action` on the open conversation, unless the screen goes before the core answers.
   * Does nothing while the core is lost. A refused action shakes its row. Once the core
   * accepts a command that takes the conversation out of this list, its row slides out and,
   * as the row folds, the next one opens, unless anything was selected, z began an undo, or
   * the screen left meanwhile. The list has not changed yet when the action starts, so the
   * rows around the open one are where they were.
   */
  const act = async (action: Action) => {
    // The toolbar shows every action off while the core is lost, and the keys match it.
    if (lostReason() !== null) return
    const thread = selected ? threadRecord(selected) : undefined
    if (!thread) return
    const index = order.indexOf(thread.id)
    const next = index === -1 ? null : (order[index + 1] ?? order[index - 1] ?? null)
    const started = generation.current
    const accepted = await run(action, thread, mail)
    if (!live.current) return
    if (!accepted) return shake(thread.id)
    notify(action, thread.id, accepted.change)
    if (!leaves(accepted.command)) return
    await leave(thread.id)
    if (generation.current === started) select(next)
  }

  /**
   * Opens the reply editor on the open conversation, once its messages are here and its account
   * can send. Not while the core is lost: the reply bar shows off then, and r matches it.
   */
  const reply = (all: boolean) => {
    if (lostReason() !== null) return
    const thread = selected ? threadRecord(selected) : undefined
    const detail = selected ? threadDetail(selected) : undefined
    if (thread && detail && canReply(thread, mail)) startReply(detail, all)
  }

  /** Forwards the open conversation's newest message on the compose page. */
  const forward = () => {
    if (lostReason() !== null) return
    const thread = selected ? threadRecord(selected) : undefined
    const detail = selected ? threadDetail(selected) : undefined
    const original = detail && forwardable(detail)
    if (thread && detail && original && canReply(thread, mail)) composeForward(detail, original)
  }

  /** A new message on the compose page, from the open conversation's account, or else the first that can send. */
  const compose = () => {
    if (lostReason() !== null) return
    const open = selected ? threadRecord(selected) : undefined
    const account =
      (open && canReply(open, mail) && open.accountId) ||
      mail.accounts.find((candidate) => candidate.can.send && candidate.can.modify)?.id
    if (account) composeNew(account)
  }

  /**
   * Undoes what the toast shows: the last action's notice, or else the reply in its undo
   * window. Once the core accepts, its conversation is back and opens again. z counts as
   * moving on, so a row whose exit ends while the core decides opens no next one.
   */
  const undoLast = async () => {
    generation.current += 1
    const started = generation.current
    const names = {
      provider: (threadId: ThreadId) => {
        const accountId = threadRecord(threadId)?.accountId
        return mail.accounts.find((account) => account.id === accountId)?.providerLabel ?? 'the provider'
      },
      mailbox: (mailboxId: MailboxId) => mail.mailboxes.find((mailbox) => mailbox.id === mailboxId)?.name,
    }
    const id = hasNotice() ? await undo(names) : await undoSend()
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
    if (event.key === UNDO_KEY) {
      void undoLast()
      event.preventDefault()
      return
    }
    // The conversation is out of view while the page is up, so nothing else acts on it.
    if (page) return
    if (event.key === COMPOSE_KEY || event.key === FORWARD_KEY) {
      if (event.key === COMPOSE_KEY) compose()
      else forward()
      event.preventDefault()
      return
    }
    if (event.key.toLowerCase() === REPLY_KEY) {
      reply(event.shiftKey)
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

  return { selected: page ? source : selected, select, act, reply, compose, undo: undoLast }
}

/** A list's subtitle. People has a shorter one for a narrow window. */
export type Subtitle = string | { wide: string; narrow: string }

type ScreenProps = {
  title: string
  subtitle: Subtitle
  chrome: Chrome
  accounts: readonly Account[]
  selection: ReturnType<typeof useSelection>
  /** The scrolling list. */
  children: ReactNode
}

/**
 * The list pane beside the reader pane. The toast floats over the reader, never over the rows.
 * With the core lost, a strip across the reader's foot says so (LostCore), and the list runs on past it.
 */
export function Screen({ title, subtitle, chrome, accounts, selection, children }: ScreenProps) {
  const thread = useThread(selection.selected)
  // Opens what App asks for once this screen is up, whether it just came or was already here.
  const open = useEffectEvent((id: ThreadId) => selection.select(id))
  const { opening } = chrome
  useEffect(() => {
    if (opening) open(opening.id)
  }, [opening])
  const draft = useComposer(COMPOSE)
  const page = usePageUp() && draft !== undefined && draft.state !== 'collapsed' ? draft : null
  return (
    <>
      <section
        aria-label={title}
        className="relative flex min-h-0 w-[340px] flex-none flex-col border-r border-line bg-list wide:w-[372px] full:w-[392px]"
      >
        {/* In a narrow window the sidebar's toggle sits in the margin, so the title lines up with the rows' text. */}
        <header className="top-band relative pr-[18px] pl-[34px] wide:pl-5" data-field="list-head">
          <button
            type="button"
            aria-label="Show the sidebar"
            onClick={chrome.onToggleSidebar}
            className="absolute top-[33px] left-0.5 inline-flex size-[30px] items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg wide:hidden"
          >
            <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="cap-top text-head font-semibold tracking-[-0.01em]" data-field="list-title">
              {title}
            </h2>
            <p className="mt-1 truncate text-meta text-muted" data-field="subtitle">
              {typeof subtitle === 'string' ? (
                subtitle
              ) : (
                <>
                  <span className="wide:hidden">{subtitle.narrow}</span>
                  <span className="hidden wide:inline">{subtitle.wide}</span>
                </>
              )}
            </p>
          </div>
          <Tooltip label="New message" shortcut={COMPOSE_KEY}>
            {(describedBy) => (
              <button
                type="button"
                aria-label="New message"
                aria-describedby={describedBy}
                aria-keyshortcuts={COMPOSE_KEY}
                aria-pressed={page !== null}
                data-field="compose"
                onClick={selection.compose}
                // Lit while the compose page is up.
                className={`inline-flex size-[30px] flex-none items-center justify-center rounded-lg hover:bg-hover hover:text-fg ${page ? 'bg-hover text-fg' : 'text-muted'}`}
              >
                <SquarePen className="size-4" strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </Tooltip>
        </header>
        <SyncStrip accounts={accounts} />
        {children}
      </section>
      <section aria-label="Reader" className="relative flex min-w-0 flex-1 flex-col bg-reader">
        {/* First in tree order and shown last: LostCore says why. */}
        <LostCore />
        {page ? (
          <ComposePage composer={page} search={chrome.search} />
        ) : (
          <>
            <Toolbar thread={thread} mail={chrome.mail} onAct={selection.act} search={chrome.search} />
            <Reader id={selection.selected} mail={chrome.mail} />
          </>
        )}
        <Toast onUndo={selection.undo} />
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
    <div role="status" aria-label="Sync" className="flex flex-col gap-1.5 px-5 pt-0.5 pb-3">
      <div className="flex justify-between text-meta text-fg2">
        <b className="font-medium text-fg">Syncing older mail</b>
        <span className="tabular-nums" data-field="sync-count">
          {total === null ? `${count.format(done)} messages so far` : `${count.format(done)} of ${count.format(total)}`}
        </span>
      </div>
      {total !== null && total > 0 && (
        <div className="h-[3px] overflow-hidden rounded-sm bg-pill">
          <div className="h-full bg-blue" style={{ width: `${Math.min(100, (done / total) * 100)}%` }} />
        </div>
      )}
      <p className="text-meta text-muted">Newest mail first. You can read it now.</p>
    </div>
  )
}
