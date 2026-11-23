// The mailbox and the steps the unsubscribe scenarios share (scenarios/30-unsubscribe*.ts):
// a seed of list mail, each sender a case, the fake web's DNS and pages for it, and what left
// the device.

import type { ChangeId, SenderSummary } from '@letterbox/protocol'
import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import { OTHER_DKIM_RECORD, SIM_DKIM_RECORD } from '@letterbox/sim-provider/raw'
import type { CoreClient } from './client.ts'
import { ME, PASSWORD, mailbox, readThread, signIn, sync, thread } from './fixtures.ts'
import type { CoreOptions, Scenario } from './scenario.ts'
import { accept } from './undoing.ts'

export const ONE_CLICK = 'List-Unsubscribe=One-Click'
export const FORM = 'application/x-www-form-urlencoded'

export const list = (
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
  text: `${subject}.\n`,
  sentAt,
  ...more,
})

/** A one-click header with a mailto beside it, signed as `dkim` says. */
export const oneClick = (url: string, dkim: NonNullable<SeedMessage['dkim']>): Partial<SeedMessage> => ({
  headers: {
    listUnsubscribe: `<mailto:leave@list.example?subject=Leave%20weekly+news&body=Remove%20me>, <${url}>`,
    listUnsubscribePost: ONE_CLICK,
  },
  dkim,
})

/**
 *   signed       one-click, signed over both headers by list.example, whose key the DNS serves
 *   unsigned-post signed, but not over List-Unsubscribe-Post: one-click cannot be used
 *   wrong-key    signed over both, but the DNS serves another key
 *   private      signed one-click only, at a host that resolves to a private address
 *   moved        signed one-click only, whose server answers the POST with a redirect
 *   web-only     an https page alone
 * and one-click with a mailto beside it, where the signature does not plainly vouch for the URL:
 *   no-from      signed over both unsubscribe fields, but not over From
 *   unaligned    signed by esp.example, whose key the DNS serves, for mail from brand.example
 *   spaced       its field is written `List-Unsubscribe :`, which a signature naming
 *                List-Unsubscribe does not cover, though a lenient parser reads it as one
 *   userinfo     signed, but its URL carries a user name and password
 *   big          signed, and over the 2 MB the core reads of a raw source
 * and three from below public suffixes, whose signatures verify:
 *   suffix       from news.shop.co.uk, signed by co.uk, a public suffix
 *   registrable  from news.shop.co.uk, signed by shop.co.uk, its registrable domain
 *   hosted       from x.github.io, signed by github.io, a private entry of the list
 */
export const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    list(
      'signed',
      'news@list.example',
      'Weekly news',
      '2025-12-06T09:00:00.000Z',
      oneClick('https://list.example/u/1', { domain: 'list.example', selector: 'sel' }),
    ),
    list(
      'unsigned-post',
      'deals@shop.example',
      'Deals',
      '2025-12-05T09:00:00.000Z',
      oneClick('https://shop.example/u/2', {
        domain: 'shop.example',
        selector: 'sel',
        signs: ['from', 'subject', 'list-unsubscribe'],
      }),
    ),
    list(
      'wrong-key',
      'promo@other.example',
      'Promotions',
      '2025-12-04T09:00:00.000Z',
      oneClick('https://other.example/u/3', { domain: 'other.example', selector: 'k1' }),
    ),
    list('private', 'alerts@intranet.example', 'Alerts', '2025-12-03T09:00:00.000Z', {
      headers: { listUnsubscribe: '<https://intranet.example/u/4>', listUnsubscribePost: ONE_CLICK },
      dkim: { domain: 'intranet.example', selector: 'sel' },
    }),
    list('moved', 'moved@list.example', 'Moved list', '2025-12-02T12:00:00.000Z', {
      headers: { listUnsubscribe: '<https://list.example/u/6>', listUnsubscribePost: ONE_CLICK },
      dkim: { domain: 'list.example', selector: 'sel' },
    }),
    list('web-only', 'digest@list.example', 'Daily digest', '2025-12-02T09:00:00.000Z', {
      headers: { listUnsubscribe: '<https://list.example/u/5>' },
    }),
    list(
      'no-from',
      'weekly@list.example',
      'Weekly digest',
      '2025-11-30T09:00:00.000Z',
      oneClick('https://list.example/u/7', {
        domain: 'list.example',
        selector: 'sel',
        signs: ['subject', 'list-unsubscribe', 'list-unsubscribe-post'],
      }),
    ),
    list(
      'unaligned',
      'offers@brand.example',
      'Offers',
      '2025-11-29T09:00:00.000Z',
      oneClick('https://brand.example/u/8', { domain: 'esp.example', selector: 'sel' }),
    ),
    {
      ...list(
        'spaced',
        'spaced@list.example',
        'Spaced list',
        '2025-11-28T09:00:00.000Z',
        oneClick('https://list.example/u/9', { domain: 'list.example', selector: 'sel' }),
      ),
      headers: {
        listUnsubscribe:
          '<mailto:leave@list.example?subject=Leave%20weekly+news&body=Remove%20me>, <https://list.example/u/9>',
        listUnsubscribePost: ONE_CLICK,
        listUnsubscribeField: 'List-Unsubscribe ',
      },
    },
    list(
      'userinfo',
      'members@list.example',
      'Members',
      '2025-11-27T09:00:00.000Z',
      oneClick('https://member:secret@list.example/u/10', { domain: 'list.example', selector: 'sel' }),
    ),
    {
      ...list(
        'big',
        'archive@list.example',
        'Archive',
        '2025-11-26T09:00:00.000Z',
        oneClick('https://list.example/u/11', { domain: 'list.example', selector: 'sel' }),
      ),
      text: `Archive.\n${`${'x'.repeat(76)}\n`.repeat(30_000)}`,
    },
    list(
      'suffix',
      'news@news.shop.co.uk',
      'Shop news',
      '2025-11-25T09:00:00.000Z',
      oneClick('https://shop.co.uk/u/12', { domain: 'co.uk', selector: 'sel' }),
    ),
    list(
      'registrable',
      'deals@news.shop.co.uk',
      'Shop deals',
      '2025-11-24T09:00:00.000Z',
      oneClick('https://shop.co.uk/u/13', { domain: 'shop.co.uk', selector: 'sel' }),
    ),
    list(
      'hosted',
      'site@x.github.io',
      'Site notes',
      '2025-11-23T09:00:00.000Z',
      oneClick('https://x.github.io/u/14', { domain: 'github.io', selector: 'sel' }),
    ),
  ],
})

/** Serves the DNS and the pages the seed's senders use. */
export function web(t: Scenario) {
  t.web.txt('sel._domainkey.list.example', [SIM_DKIM_RECORD])
  t.web.txt('sel._domainkey.shop.example', [SIM_DKIM_RECORD])
  t.web.txt('k1._domainkey.other.example', [OTHER_DKIM_RECORD])
  t.web.txt('sel._domainkey.intranet.example', [SIM_DKIM_RECORD])
  t.web.txt('sel._domainkey.esp.example', [SIM_DKIM_RECORD])
  for (const domain of ['co.uk', 'shop.co.uk', 'github.io']) t.web.txt(`sel._domainkey.${domain}`, [SIM_DKIM_RECORD])
  for (const page of ['shop.co.uk/u/12', 'shop.co.uk/u/13', 'x.github.io/u/14'])
    t.web.serve(`https://${page}`, { kind: 'status', status: 200 })
  t.web.resolve('intranet.example', ['10.0.0.5'])
  const pages = ['list.example/u/1', 'shop.example/u/2', 'other.example/u/3', 'intranet.example/u/4']
  for (const page of [...pages, 'list.example/u/7', 'brand.example/u/8', 'list.example/u/9', 'list.example/u/11'])
    t.web.serve(`https://${page}`, { kind: 'status', status: 200 })
  t.web.serve('https://list.example/u/6', { kind: 'redirect', location: 'https://list.example/elsewhere' })
  t.web.serve('https://list.example/elsewhere', { kind: 'status', status: 200 })
}

/** Signs in to the seed's mailbox with a core started with `options`. */
export async function begin(t: Scenario, options: CoreOptions = {}) {
  web(t)
  const box = t.mailbox(seed())
  const core = t.startCore(options)
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await sync(core)
  return { core, box }
}

/** The id of the one message in the conversation with this subject. */
export async function messageOf(core: CoreClient, subject: string) {
  const id = (await readThread(core, (await thread(core, subject)).id))?.messages[0]?.id
  if (id === undefined) throw new Error(`"${subject}" has no message`)
  return id
}

/** The Updates row of `address`, as the core shows it now. */
export async function row(core: CoreClient, address: string): Promise<SenderSummary | undefined> {
  const inbox = await mailbox(core, 'Inbox')
  const page = await core.query({ view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 })
  return page.senders.find((sender) => sender.address === address)
}

/**
 * Unsubscribes from the sender of the message with this subject, and fails unless it is
 * accepted. Its message is looked up first, so no query runs while the unsubscribe goes out.
 */
export const unsubscribe = async (t: Scenario, core: CoreClient, subject: string): Promise<ChangeId> =>
  accept(t, core, { kind: 'unsubscribe', messageId: await messageOf(core, subject) }, `unsubscribing from ${subject}`)

/** What left the device: POSTs, DNS lookups, raw fetches and sends. */
export const traffic = (t: Scenario, box: ReturnType<Scenario['mailbox']>) => ({
  posted: t.web.posted().length,
  lookups: t.web.lookups().length,
  raw: box.calls().raw,
  sent: box.sent().length,
})
