// Unsubscribe targets (crates/core/src/body/unsubscribe.rs). The core picks one way: RFC 8058
// one-click, not yet verified, else the first mailto or https URI of List-Unsubscribe in the
// header's own order, read as RFC 2369 writes it, else a link in the body once it has loaded.
// It shows it on the message and on its sender's row in Updates, and never acts on one.

import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type { SenderPage, Unsubscribe } from '@letterbox/protocol'
import { mailbox, ME, openWithBody, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import type { CoreClient } from '../src/client.ts'

const mail = (
  key: string,
  address: string,
  subject: string,
  sentAt: string,
  more: Partial<SeedMessage>,
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: { name: subject, address },
  to: [ME],
  subject,
  text: `${subject}.`,
  sentAt,
  ...more,
})

/**
 *   one-click   a mailto and an https target, and List-Unsubscribe-Post: one-click wins
 *   mailto      a comment, then a mailto and an https target: the mailto comes first
 *   order       an https target, then a mailto: the header's order wins
 *   malformed   an entry outside angle brackets ends the reading, before the https target
 *   web-only    an https target alone, without one-click
 *   http-only   only an http target, which is not offered
 *   body-link   no header: a link whose text says unsubscribe beats one whose address does
 *   text-link   no header, plain text: a URL on the line after "unsubscribe"
 *   quoted-link from a person: the only unsubscribe link is in the quoted part
 */
const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    mail('one-click', 'lists@list.example', 'Weekly list', '2025-12-06T09:00:00.000Z', {
      headers: {
        listUnsubscribe: '<mailto:leave@list.example?subject=unsubscribe>, <https://list.example/u/1>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      },
    }),
    mail('mailto', 'weekly@list.example', 'Weekly notes', '2025-12-05T12:00:00.000Z', {
      headers: {
        listUnsubscribe:
          "(the list's own address) <mailto:leave@list.example?subject=unsubscribe>, <https://list.example/u/4>",
      },
    }),
    mail('order', 'order@list.example', 'Order news', '2025-12-05T11:00:00.000Z', {
      headers: { listUnsubscribe: '<https://list.example/u/5>, <mailto:leave@list.example>' },
    }),
    mail('malformed', 'bad@list.example', 'Bad header', '2025-12-05T10:00:00.000Z', {
      headers: { listUnsubscribe: 'mailto:leave@list.example, <https://list.example/u/6>' },
    }),
    mail('web-only', 'digest@list.example', 'Daily digest', '2025-12-05T09:00:00.000Z', {
      headers: { listUnsubscribe: '<https://list.example/u/2>' },
    }),
    mail('http-only', 'old@list.example', 'Old list', '2025-12-04T09:00:00.000Z', {
      headers: { listUnsubscribe: '<http://list.example/u/3>' },
      html: '<p>Old list.</p>',
    }),
    mail('body-link', 'promo@deals.example', 'Deals', '2025-12-03T09:00:00.000Z', {
      headers: { precedence: 'bulk' },
      html: [
        '<p>Deals.</p>',
        '<a href="https://deals.example/prefs?unsubscribe=1">Preferences</a> · ',
        '<a href="https://deals.example/leave?u=1&amp;t=2">Unsubscribe</a>',
      ].join(''),
    }),
    mail('text-link', 'notes@plain.example', 'Notes', '2025-12-02T09:00:00.000Z', {
      headers: { autoSubmitted: 'auto-generated' },
      text: 'Your weekly notes.\n\nTo unsubscribe, visit:\nhttps://plain.example/u?id=5.\n',
    }),
    mail('quoted-link', 'ben@example.com', 'Seen this?', '2025-12-01T09:00:00.000Z', {
      text: 'Did you see this one?\n\nOn Sun, Nov 30, 2025 at 9:00 AM Lists <lists@list.example> wrote:\n> Unsubscribe: https://quoted.example/u\n',
    }),
  ],
})

const ONE_CLICK: Unsubscribe = { method: 'one-click', url: 'https://list.example/u/1', verified: false }
const ORDER: Unsubscribe = { method: 'web', url: 'https://list.example/u/5', from: 'header' }
const MAILTO: Unsubscribe = {
  method: 'mailto',
  to: 'leave@list.example',
  uri: 'mailto:leave@list.example?subject=unsubscribe',
}
const WEB_ONLY: Unsubscribe = { method: 'web', url: 'https://list.example/u/2', from: 'header' }
const BODY_LINK: Unsubscribe = { method: 'web', url: 'https://deals.example/leave?u=1&t=2', from: 'body' }
const TEXT_LINK: Unsubscribe = { method: 'web', url: 'https://plain.example/u?id=5', from: 'body' }

/** Each Updates row's address and unsubscribe target. */
const rows = (page: SenderPage) => page.senders.map((sender) => [sender.address, sender.unsubscribe])

/** The unsubscribe target of the first message in the conversation with this subject, once its body has loaded. */
async function opened(core: CoreClient, subject: string) {
  return (await openWithBody(core, (await thread(core, subject)).id)).unsubscribe
}

scenario(
  'unsubscribe targets come from the headers, else from a link in the body, and nothing acts on them',
  async (t) => {
    const { core, box } = await start(t, seed())
    const inbox = await mailbox(core, 'Inbox')
    const query = { view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 } as const
    t.equal(
      rows(await core.query(query)),
      [
        ['lists@list.example', ONE_CLICK],
        ['weekly@list.example', MAILTO],
        ['order@list.example', ORDER],
        ['bad@list.example', null],
        ['digest@list.example', WEB_ONLY],
        ['old@list.example', null],
        ['promo@deals.example', null],
        ['notes@plain.example', null],
      ],
      'before any body loads, Updates shows the header targets: one-click only with List-Unsubscribe-Post and unverified, else the first in the header, none past a bad entry, and no http',
    )

    t.equal(await opened(core, 'Weekly list'), ONE_CLICK, 'the message carries the same target as its row')
    t.equal(await opened(core, 'Old list'), null, 'an http target is not offered, and its body names none')
    t.equal(
      await opened(core, 'Deals'),
      BODY_LINK,
      'a body link whose text says unsubscribe wins, read as a browser reads it',
    )
    t.equal(await opened(core, 'Notes'), TEXT_LINK, 'in plain text, the URL on the line after "unsubscribe"')
    t.equal(await opened(core, 'Seen this?'), null, 'a link in the quoted part is not offered for the message')
    t.equal(
      rows(await core.query(query)).slice(6),
      [
        ['promo@deals.example', BODY_LINK],
        ['notes@plain.example', TEXT_LINK],
      ],
      'once their bodies load, the rows of those senders show the links',
    )
    t.equal(box.sent().length, 0, 'nothing was sent to unsubscribe')
  },
)
