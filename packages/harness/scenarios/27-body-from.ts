// The From address the reader shows, as the Gmail adapter reads it (crates/gmail/src/message.rs):
// the mailbox, never an address written inside a comment or a quoted display name, a comment
// in a name read as a space, and the space inside a quoted local part kept.

import type { Seed } from '@letterbox/sim-provider/contract'
import { ME, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

scenario(
  'on gmail, a comment in From or a quoted display name is not read as the address the reader shows',
  async (t) => {
    const commented: Seed = {
      address: ME,
      password: PASSWORD,
      mailboxes: [{ key: 'inbox', name: 'Inbox', role: 'inbox' }],
      messages: [
        {
          key: 'commented',
          mailboxes: ['inbox'],
          from: 'news@shop.example (Shop <alerts@bank.example>)',
          to: [ME],
          subject: 'Commented sender',
          text: 'Hello.',
          sentAt: '2025-12-01T09:00:00.000Z',
        },
        {
          key: 'spaced',
          mailboxes: ['inbox'],
          from: 'Jane(her work address)Doe  <jane@example.com>',
          to: [ME],
          subject: 'Spaced sender',
          text: 'Hello.',
          sentAt: '2025-12-03T09:00:00.000Z',
        },
        {
          key: 'local',
          mailboxes: ['inbox'],
          from: 'First Last <"first last"@example.com>',
          to: [ME],
          subject: 'Quoted mailbox',
          text: 'Hello.',
          sentAt: '2025-12-04T09:00:00.000Z',
        },
        {
          key: 'quoted',
          mailboxes: ['inbox'],
          from: '"Bank <alerts@bank.example>" <news@shop.example>',
          to: [ME],
          subject: 'Quoted sender',
          text: 'Hello.',
          sentAt: '2025-12-02T09:00:00.000Z',
        },
      ],
    }
    const { core } = await start(t, commented)
    const listed = await thread(core, 'Commented sender')
    t.equal(
      listed.people.map((person) => person.address),
      ['news@shop.example', ME],
      'the From address is the mailbox, not the one written inside its comment',
    )
    const quoted = await thread(core, 'Quoted sender')
    t.equal(
      quoted.people.map((person) => [person.name, person.address]),
      [
        ['Bank <alerts@bank.example>', 'news@shop.example'],
        [null, ME],
      ],
      'nor one written inside its quoted display name',
    )
    const spaced = await thread(core, 'Spaced sender')
    t.equal(
      spaced.people[0],
      { name: 'Jane Doe', address: 'jane@example.com', isMe: false },
      'a comment in a display name separates words as a space does, and runs of space are one',
    )
    const local = await thread(core, 'Quoted mailbox')
    t.equal(
      local.people[0],
      { name: 'First Last', address: '"first last"@example.com', isMe: false },
      'the space inside a quoted local part is part of the mailbox',
    )
  },
  ['gmail'],
)
