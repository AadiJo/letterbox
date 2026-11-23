// The list mail in `people-first` (people-first.ts) that each unsubscribe outcome needs, with
// what the dev host's fake web answers for it: the DKIM key a signature names (raw.ts signs
// with the sim's key), each unsubscribe page, and where a name resolves.
//   Homeware Outlet       one-click signed over both unsubscribe fields: the core posts it
//   Fernhill Garden Club  one-click whose signature leaves out List-Unsubscribe-Post: it emails
//   Bramble Books         an unsubscribe page alone, which the user opens
//   Quayside Pharmacy     signed one-click at a host on a private address: it fails not-public
//   Kestrel Air           signed one-click whose server redirects: it fails refused-by-provider
// Every name, address and company here is made up.

import type { SeedMessage } from '../contract.ts'
import { SIM_DKIM_RECORD } from '../raw.ts'
import type { DevWeb } from '../seeds.ts'
import { ago, DAY, HOUR, ME } from './people-mail.ts'

const ONE_CLICK = 'List-Unsubscribe=One-Click'
const LIST = { listId: true, precedence: 'bulk' } as const

/** The `n`th message from `from`, a list, each its own conversation. */
const list = (
  key: string,
  from: { name: string; address: string },
  subject: string,
  sentAt: string,
  more: Partial<SeedMessage>,
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from,
  to: [ME],
  subject,
  text: `${subject}.`,
  sentAt,
  unread: true,
  bulk: true,
  ...more,
})

const HOMEWARE = { name: 'Homeware Outlet', address: 'deals@homeware.example' }
const HOMEWARE_PAGE = 'https://homeware.example/unsubscribe/u1'

/** The newest sale mail, with a remote image and a body link, as in the Unsubscribe mocks. */
const HOMEWARE_SALE = [
  '<div style="max-width:600px;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b">',
  '<img src="https://images.homeware.example/winter-sale.jpg" width="600" height="150" alt="Winter sale, 30% off">',
  '<h1 style="margin:14px 0 0;font:400 26px/32px Georgia,serif">Last day: 30% off bedding</h1>',
  '<p style="font-size:16px;line-height:26px">The winter sale ends tonight at midnight. Duvets, linen sets and throws are all 30% off, and delivery is free over €60.</p>',
  '<p><a href="https://homeware.example/sale" style="display:inline-block;border-radius:5px;background:#9a3f2a;padding:11px 18px;color:#fbefe8;text-decoration:none;font-weight:600">Shop the sale</a></p>',
  `<p style="font-size:12px;color:#6b6b6b">You get these because you bought from homeware.example. <a href="${HOMEWARE_PAGE}" style="color:#6b6b6b">Unsubscribe</a> · Homeware Outlet, Unit 4, Dockside Park</p>`,
  '</div>',
].join('')

/** One-click, and a mailto beside it, signed by `domain` over the headers `signs` names (all the default ones when left out). */
const oneClick = (page: string, leave: string, domain: string, signs?: readonly string[]): Partial<SeedMessage> => ({
  headers: {
    listUnsubscribe: `<mailto:${leave}?subject=Unsubscribe>, <${page}>`,
    listUnsubscribePost: ONE_CLICK,
    ...LIST,
  },
  dkim: { domain, selector: 'sel', ...(signs && { signs }) },
})

const homeware = (key: string, subject: string, sentAt: string, html?: string) =>
  list(key, HOMEWARE, subject, sentAt, {
    ...oneClick(HOMEWARE_PAGE, 'leave@homeware.example', 'homeware.example'),
    ...(html && { html }),
  })

const FERNHILL = { name: 'Fernhill Garden Club', address: 'club@fernhill.example' }
const BRAMBLE = { name: 'Bramble Books', address: 'news@bramblebooks.example' }
const QUAYSIDE = { name: 'Quayside Pharmacy', address: 'offers@quayside.example' }
const KESTREL = { name: 'Kestrel Air', address: 'deals@kestrel.example' }

export const LIST_MAIL: readonly SeedMessage[] = [
  homeware('list-homeware-1', 'Up to 40% off rugs', ago(2 * DAY), undefined),
  homeware('list-homeware-2', 'New in: wool throws', ago(26 * HOUR), undefined),
  homeware('list-homeware-3', 'Flash sale: kitchen textiles', ago(5 * HOUR), undefined),
  homeware('list-homeware-4', 'Last day: 30% off bedding', ago(50 * 60_000), HOMEWARE_SALE),
  list(
    'list-fernhill',
    FERNHILL,
    'Seed swap this Saturday',
    ago(3 * HOUR),
    oneClick('https://fernhill.example/unsubscribe', 'leave@fernhill.example', 'fernhill.example', [
      'from',
      'subject',
      'list-unsubscribe',
    ]),
  ),
  list('list-bramble', BRAMBLE, 'Five new paperbacks', ago(4 * HOUR), {
    headers: { listUnsubscribe: '<https://bramblebooks.example/unsubscribe?u=9>', ...LIST },
  }),
  list('list-quayside', QUAYSIDE, 'Your flu jab reminder', ago(6 * HOUR), {
    headers: { listUnsubscribe: '<https://lists.quayside.example/u/3>', listUnsubscribePost: ONE_CLICK, ...LIST },
    dkim: { domain: 'quayside.example', selector: 'sel' },
  }),
  list('list-kestrel', KESTREL, 'Fares to Lisbon from €39', ago(7 * HOUR), {
    headers: { listUnsubscribe: '<https://kestrel.example/unsubscribe/7>', listUnsubscribePost: ONE_CLICK, ...LIST },
    dkim: { domain: 'kestrel.example', selector: 'sel' },
  }),
]

/** What the dev host's fake web answers for the list mail. */
export const LIST_WEB: DevWeb = {
  txt: ['homeware.example', 'fernhill.example', 'quayside.example', 'kestrel.example'].map((domain) => ({
    name: `sel._domainkey.${domain}`,
    records: [SIM_DKIM_RECORD],
  })),
  resolve: [{ name: 'lists.quayside.example', addresses: ['10.0.0.5'] }],
  serve: [
    { url: HOMEWARE_PAGE, answer: { kind: 'status', status: 200 } },
    {
      url: 'https://kestrel.example/unsubscribe/7',
      answer: { kind: 'redirect', location: 'https://kestrel.example/elsewhere' },
    },
    { url: 'https://kestrel.example/elsewhere', answer: { kind: 'status', status: 200 } },
  ],
}
