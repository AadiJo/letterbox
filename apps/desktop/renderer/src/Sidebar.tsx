// The floating sidebar: People, All mail, then each account's mailboxes and labels from the
// core's mailboxes view. Only places the core can list are here.

import type { Account, Mailbox, MailboxId, Role } from '@letterbox/protocol'
import { Archive, FileText, Inbox, type LucideIcon, Mails, OctagonAlert, Send, Tag, Trash2, Users } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

/** Where the list pane is. */
export type Place = { kind: 'people' } | { kind: 'all' } | { kind: 'mailbox'; id: MailboxId }

const ROLES = {
  inbox: { icon: Inbox, order: 0 },
  drafts: { icon: FileText, order: 1 },
  sent: { icon: Send, order: 2 },
  archive: { icon: Archive, order: 3 },
  trash: { icon: Trash2, order: 4 },
  spam: { icon: OctagonAlert, order: 5 },
} as const satisfies Record<Role, { icon: LucideIcon; order: number }>

/** The number beside a mailbox: unread mail, as Apple Mail shows it, but every draft and no Sent count. */
const countOf = (mailbox: Mailbox) => {
  if (mailbox.role === 'sent') return 0
  return mailbox.role === 'drafts' ? mailbox.total : mailbox.unread
}

type Props = {
  place: Place
  onPlace: (place: Place) => void
  accounts: readonly Account[]
  mailboxes: readonly Mailbox[]
  /** Turns that wait on me, and whether any is late. Undefined until the core answers. */
  people: { count: number; late: boolean } | undefined
}

export function Sidebar({ place, onPlace, accounts, mailboxes, people }: Props) {
  const isOn = (candidate: Place) =>
    candidate.kind === place.kind &&
    (candidate.kind !== 'mailbox' || (place.kind === 'mailbox' && place.id === candidate.id))
  const nav = (target: Place, label: string, icon: LucideIcon, trailing?: ReactNode) => (
    <Nav label={label} icon={icon} on={isOn(target)} onClick={() => onPlace(target)}>
      {trailing}
    </Nav>
  )
  return (
    <nav
      aria-label="Sidebar"
      className="flex h-full w-[232px] flex-col overflow-y-auto rounded-xl border border-fg/8 bg-linear-to-b from-fg/7 to-fg/3.5 pb-2 shadow-[inset_0_1px_0_rgb(255_255_255/7%),0_10px_30px_rgb(0_0_0/45%),0_0_0_0.5px_rgb(0_0_0/60%)] [scrollbar-width:none]"
    >
      {/* Room for the window's own traffic lights, which the desktop shell draws. */}
      <div className="h-9 flex-none" />
      {nav(
        { kind: 'people' },
        'People',
        Users,
        people && people.count > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted tabular-nums" data-field="people-count">
            {people.late && <span className="size-1.5 rounded-full bg-amber" data-field="late" />}
            {people.count}
          </span>
        ),
      )}
      {nav({ kind: 'all' }, 'All mail', Mails)}
      {accounts.map((account) => {
        const own = mailboxes.filter((mailbox) => mailbox.accountId === account.id)
        const roles = own.flatMap((mailbox) => (mailbox.role ? [{ mailbox, role: mailbox.role }] : []))
        const labels = own.filter((mailbox) => mailbox.role === null)
        const syncing = account.status.state === 'syncing'
        const counted = (mailbox: Mailbox) =>
          countOf(mailbox) > 0 && (
            <span className={`text-xs tabular-nums ${syncing ? 'text-faint' : 'text-muted'}`}>
              {countOf(mailbox).toLocaleString()}
            </span>
          )
        return (
          <section key={account.id} aria-label={account.address}>
            <h2 className="px-4 pt-3.5 pb-1 text-[11.5px] font-semibold text-faint">
              Mailboxes
              <span className="mt-px block text-[11px] font-normal">{account.address}</span>
            </h2>
            {roles
              .toSorted((a, b) => ROLES[a.role].order - ROLES[b.role].order)
              .map(({ mailbox, role }) => (
                <Fragment key={mailbox.id}>
                  {nav({ kind: 'mailbox', id: mailbox.id }, mailbox.name, ROLES[role].icon, counted(mailbox))}
                </Fragment>
              ))}
            {(labels.length > 0 || syncing) && (
              <h2 className="px-4 pt-3.5 pb-1 text-[11.5px] font-semibold text-faint">
                Labels
                {labels.length === 0 && (
                  <span className="block pt-0.5 text-[11.5px] font-normal text-muted">
                    Arriving as older mail syncs
                  </span>
                )}
              </h2>
            )}
            {labels.map((label) => (
              <Fragment key={label.id}>
                {nav({ kind: 'mailbox', id: label.id }, label.name, Tag, counted(label))}
              </Fragment>
            ))}
          </section>
        )
      })}
    </nav>
  )
}

type NavProps = { label: string; icon: LucideIcon; on: boolean; onClick: () => void; children: ReactNode }

function Nav({ label, icon: Icon, on, onClick, children }: NavProps) {
  return (
    <button
      type="button"
      aria-current={on ? 'page' : undefined}
      onClick={onClick}
      className={`mx-1.5 flex h-[30px] w-[calc(100%-12px)] items-center gap-[9px] rounded-[7px] px-2.5 text-left text-[13px] ${on ? 'bg-sel text-fg' : 'text-fg2 hover:bg-hover'}`}
    >
      <Icon className={`size-4 ${on ? 'text-fg' : 'text-muted'}`} strokeWidth={1.75} aria-hidden />
      <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium' : ''}`}>{label}</span>
      {children}
    </button>
  )
}
