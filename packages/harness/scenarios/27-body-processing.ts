// When the body pipeline runs (crates/core/src/body/mod.rs). A body is processed once and its
// reading kept: a restart reuses it and processes nothing. A rules change (a new VERSION)
// reprocesses a stored body only when its conversation opens again, in a job of its own, and a
// large sent body waits for that job too instead of holding up its send.
//
// To tell a reused reading from a fresh one, the scenario rewrites the stored raw body while no
// core runs: a reprocessed body shows the rewrite, a reused reading does not.

import type { Seed } from '@letterbox/sim-provider/contract'
import type { Body } from '@letterbox/protocol'
import { ME, openThread, PASSWORD, readThread, standardSeed, start, thread, watchThread } from '../src/fixtures.ts'
import { ASKED, asked, draft } from '../src/sending.ts'
import { scenario } from '../src/scenario.ts'
import type { CoreClient } from '../src/client.ts'

const ANA = { name: 'Ana', address: 'ana@example.com' }

const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    {
      key: 'first',
      mailboxes: ['inbox'],
      from: ANA,
      to: [ME],
      subject: 'First',
      text: 'First.',
      html: '<p>First <img src="https://cdn.example/a.png" alt="A"></p>',
      sentAt: '2025-12-01T09:00:00.000Z',
    },
    {
      key: 'second',
      mailboxes: ['inbox'],
      from: ANA,
      to: [ME],
      subject: 'Second',
      text: 'Second.',
      html: '<p>Second</p>',
      sentAt: '2025-12-02T09:00:00.000Z',
    },
  ],
})

/** The states the first message's body goes through as its conversation opens, until it is ready. */
async function opening(core: CoreClient, subject: string): Promise<{ states: Body['state'][]; html: string | null }> {
  // The body is stored, so nothing is fetched while it opens: only the pipeline can run.
  const open = watchThread(core, (await thread(core, subject)).id)
  const states: Body['state'][] = []
  for (;;) {
    const body = (await open.next())?.messages[0]?.body
    if (body === undefined) throw new Error(`${subject} has no message`)
    states.push(body.state)
    if (body.state !== 'loading') {
      open.close()
      return { states, html: body.state === 'ready' ? body.html : null }
    }
  }
}

/** What the store says each message's reading was made by, by subject. */
const versions = (rows: Record<string, unknown>[]) => rows.map((row) => [row['subject'], row['version']])

scenario('a stored reading survives a restart, and a rules change reprocesses only what opens again', async (t) => {
  const { core } = await start(t, seed())
  await readThread(core, (await thread(core, 'First')).id)
  await readThread(core, (await thread(core, 'Second')).id)
  await core.stop()
  t.sql(
    `update messages set record = json_set(record, '$.body.body.html', '<p>Rewritten</p>') where json_extract(record, '$.body.kind') = 'body'`,
  )

  const warm = t.startCore()
  await warm.hello()
  t.equal(
    await opening(warm, 'First'),
    { states: ['ready'], html: '<p>First <span data-letterbox-image="0">A</span></p>' },
    'after a restart the body is ready at once, from its stored reading: nothing was processed again',
  )
  await warm.stop()
  // Version 3 is what the rules wrote before deleted elements left a boundary and the output was
  // checked, so a reading from then must not reach the frame.
  t.sql(
    `update messages set record = json_set(record, '$.reading.processed.version', 3) where json_extract(record, '$.reading.processed') is not null`,
  )

  const changed = t.startCore()
  await changed.hello()
  t.equal(
    await opening(changed, 'First'),
    { states: ['loading', 'ready'], html: '<p>Rewritten</p>' },
    'after a rules change, an opened body loads while a job processes it again',
  )
  await changed.stop()
  t.equal(
    versions(
      t.sql(
        `select json_extract(record, '$.facts.subject') as subject, json_extract(record, '$.reading.processed.version') as version from messages order by subject`,
      ),
    ),
    [
      ['First', 6],
      ['Second', 3],
    ],
    'only the body that opened was processed again: the other keeps its old reading until it opens',
  )
})

scenario('a large sent body is processed after its send, not before it is accepted', async (t) => {
  const { core, accountId } = await start(t, standardSeed(t.dialect))
  const { threadId, question } = await asked(core)
  const open = await openThread(core, threadId)
  const long = `${'A long answer. '.repeat(5000)}\n> ${ASKED}`
  const answer = await core.command({ kind: 'send', draft: draft(accountId, question.id, { text: long }) })
  t.equal(answer.kind, 'accepted', 'the send is accepted')
  const states: Body['state'][] = []
  for (;;) {
    const mine = (open.latest() ?? (await open.next()))?.messages.at(-1)
    const state = mine?.from.isMe === true ? mine.body.state : undefined
    if (state !== undefined && states.at(-1) !== state) states.push(state)
    if (state === 'ready') break
    await open.next()
  }
  t.equal(states, ['loading', 'ready'], 'it shows loading, then ready once its job has run')
})
