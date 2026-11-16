// The sidebar, the darkest of the three flat panes: who is signed in, People, All mail, then
// each account's mailboxes and labels from the core's mailboxes view. Only places the core can
// list are here.

import type { Account, Mailbox, MailboxId, Role } from '@letterbox/protocol'
import { Archive, FileText, Inbox, type LucideIcon, Mails, OctagonAlert, Send, Trash2, Users } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Avatar } from './Avatar.tsx'
import { LabelDot } from './Label.tsx'

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

const glyph = (Icon: LucideIcon) => <Icon className="size-4" strokeWidth={1.75} aria-hidden />

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
  const nav = (target: Place, label: string, icon: ReactNode, trailing?: ReactNode) => (
    <Nav label={label} icon={icon} on={isOn(target)} onClick={() => onPlace(target)}>
      {trailing}
    </Nav>
  )
  const [first, ...rest] = accounts
  return (
    <nav
      aria-label="Sidebar"
      className="flex h-full w-[232px] flex-col overflow-y-auto border-r border-line bg-side pb-2 [scrollbar-width:none]"
    >
      {/* Who is signed in, its avatar's top on the top band's line. On macOS it starts past the traffic lights. */}
      <div className="top-band mb-2 px-2 mac:pl-20">{first && <AccountRow account={first} />}</div>
      {rest.map((account) => (
        <div key={account.id} className="mb-2 px-2">
          <AccountRow account={account} />
        </div>
      ))}
      {nav(
        { kind: 'people' },
        'People',
        glyph(Users),
        people && people.count > 0 && (
          <span className="inline-flex items-center gap-1.5" data-field="people-count">
            {people.late && <span className="size-1.5 rounded-full bg-amber" data-field="late" />}
            {people.count}
          </span>
        ),
      )}
      {nav({ kind: 'all' }, 'All mail', glyph(Mails))}
      {accounts.map((account) => {
        const own = mailboxes.filter((mailbox) => mailbox.accountId === account.id)
        const roles = own.flatMap((mailbox) => (mailbox.role ? [{ mailbox, role: mailbox.role }] : []))
        const labels = own.filter((mailbox) => mailbox.role === null)
        const syncing = account.status.state === 'syncing'
        const counted = (mailbox: Mailbox) =>
          countOf(mailbox) > 0 && (
            <span className={syncing ? 'text-faint' : undefined}>{countOf(mailbox).toLocaleString()}</span>
          )
        return (
          <section key={account.id} aria-label={account.address}>
            <h2 className="px-[18px] pt-4 pb-1.5 text-caption font-semibold text-section">
              Mailboxes
              {accounts.length > 1 && <span className="block font-normal">{account.address}</span>}
            </h2>
            {roles
              .toSorted((a, b) => ROLES[a.role].order - ROLES[b.role].order)
              .map(({ mailbox, role }) => (
                <Fragment key={mailbox.id}>
                  {nav({ kind: 'mailbox', id: mailbox.id }, mailbox.name, glyph(ROLES[role].icon), counted(mailbox))}
                </Fragment>
              ))}
            {(labels.length > 0 || syncing) && (
              <h2 className="px-[18px] pt-4 pb-1.5 text-caption font-semibold text-section">
                Labels
                {labels.length === 0 && (
                  <span className="block pt-0.5 font-normal text-muted">Arriving as older mail syncs</span>
                )}
              </h2>
            )}
            {labels.map((label) => (
              <Fragment key={label.id}>
                {nav(
                  { kind: 'mailbox', id: label.id },
                  label.name,
                  <span className="flex w-4 justify-center">
                    <LabelDot name={label.name} size="nav" />
                  </span>,
                  counted(label),
                )}
              </Fragment>
            ))}
          </section>
        )
      })}
    </nav>
  )
}

/** One signed-in account. The protocol names an account only by its address. */
function AccountRow({ account }: { account: Account }) {
  return (
    <div
      data-field="account"
      title={account.address}
      className="flex h-[22px] min-w-0 flex-1 items-center gap-[9px] px-2.5 text-row font-medium text-fg"
    >
      <Avatar who={{ name: null, address: account.address }} size="account" />
      <span className="min-w-0 flex-1 truncate">{account.address}</span>
    </div>
  )
}

type NavProps = { label: string; icon: ReactNode; on: boolean; onClick: () => void; children: ReactNode }

function Nav({ label, icon, on, onClick, children }: NavProps) {
  return (
    <button
      type="button"
      aria-current={on ? 'page' : undefined}
      onClick={onClick}
      className={`mx-2 flex h-[30px] w-[calc(100%-16px)] flex-none items-center gap-2.5 rounded-lg px-2.5 text-left text-row ${on ? 'bg-nav text-fg' : 'text-fg2 hover:bg-hover'}`}
    >
      <span className={`flex ${on ? 'text-fg' : 'text-muted'}`}>{icon}</span>
      <span className={`min-w-0 flex-1 truncate ${on ? 'font-medium' : ''}`}>{label}</span>
      <span className="text-meta text-muted tabular-nums">{children}</span>
    </button>
  )
}
