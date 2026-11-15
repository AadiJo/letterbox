// The one database for every account. It keeps each record as a JSON document
// in a table named for its kind. The core holds all records in memory and
// writes every change through here in a transaction, so what is on disk is
// always a state the core was really in.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AccountId, ChangeId, MailboxId, MessageId, Rev, ThreadId } from '@letterbox/protocol'

const TABLES = ['accounts', 'mailboxes', 'messages', 'threads', 'changes'] as const
export type Table = (typeof TABLES)[number]

/** The id type of each table's records. */
type Ids = { accounts: AccountId; mailboxes: MailboxId; messages: MessageId; threads: ThreadId; changes: ChangeId }

/** The record type each table holds. The caller names them, so the store never guesses. */
export type Records = { [T in Table]: { id: Ids[T] } }

export type Transaction<R extends Records> = {
  /** Inserts the record, or replaces the one with the same id. */
  put<T extends Table>(table: T, record: R[T]): void
  remove<T extends Table>(table: T, id: Ids[T]): void
}

/** Tables whose ids the store mints. Change ids come from the client. */
type Minted = Exclude<Table, 'changes'>

export type Store<R extends Records> = {
  /** Every record of one kind, in the order they were first written. */
  load<T extends Table>(table: T): R[T][]
  /** A new id for a record in `table` that this store has never returned, for example "thread_12". */
  nextId<T extends Minted>(table: T): Ids[T]
  rev(): Rev
  /** Runs `work` as one transaction at the next revision, and returns that revision. */
  write(work: (tx: Transaction<R>, rev: Rev) => void): Rev
  close(): void
}

/** The prefix of each minted id: "thread" for the threads table. */
const PREFIX: { [T in Minted]: string } = {
  accounts: 'account',
  mailboxes: 'mailbox',
  messages: 'message',
  threads: 'thread',
}

/** Opens the store in `dataPath`, creating the folder and the tables when they are missing. */
export function openStore<R extends Records>(dataPath: string): Store<R> {
  mkdirSync(dataPath, { recursive: true })
  const db = new DatabaseSync(join(dataPath, 'letterbox.sqlite'))
  db.exec('pragma journal_mode = wal')
  db.exec('pragma synchronous = normal')
  db.exec('create table if not exists meta (key text primary key, value integer not null) strict')
  for (const table of TABLES) {
    db.exec(
      `create table if not exists ${table} (seq integer primary key autoincrement, id text not null unique, record text not null) strict`,
    )
  }

  const readMeta = db.prepare('select value from meta where key = ?')
  const writeMeta = db.prepare(
    'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
  )
  const meta = (key: string) => Number(readMeta.get(key)?.['value'] ?? 0)
  let rev = meta('rev')
  let counter = meta('counter')

  const statements = (table: Table) => ({
    put: db.prepare(
      `insert into ${table} (id, record) values (?, ?) on conflict (id) do update set record = excluded.record`,
    ),
    remove: db.prepare(`delete from ${table} where id = ?`),
    load: db.prepare(`select record from ${table} order by seq`),
  })
  const prepared = {
    accounts: statements('accounts'),
    mailboxes: statements('mailboxes'),
    messages: statements('messages'),
    threads: statements('threads'),
    changes: statements('changes'),
  }

  return {
    // The store wrote every document from an R[T], so reading it back gives an R[T].
    load: <T extends Table>(table: T) =>
      prepared[table].load.all().map((row) => JSON.parse(String(row['record'])) as R[T]),
    // Ids are the prefix and a count, so the string is the brand's whole contract.
    nextId: <T extends Minted>(table: T) => `${PREFIX[table]}_${++counter}` as Ids[T],
    rev: () => rev,
    write: (work) => {
      db.exec('begin')
      try {
        work(
          {
            put: (table, record) => void prepared[table].put.run(record.id, JSON.stringify(record)),
            remove: (table, id) => void prepared[table].remove.run(id),
          },
          rev + 1,
        )
        writeMeta.run('rev', rev + 1)
        writeMeta.run('counter', counter)
        db.exec('commit')
      } catch (error) {
        db.exec('rollback')
        throw error
      }
      rev += 1
      return rev
    },
    close: () => db.close(),
  }
}
