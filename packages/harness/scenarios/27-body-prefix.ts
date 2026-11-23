// The names a shown CSS image is set on (crates/core/src/body). The core writes each remote CSS
// image as `var(<prefix>image-i, none)`, and a UI sets that custom property to the image once
// it is shown. The prefix is drawn at random as each body is processed (`Body.ready.cssPrefix`),
// and the sender never sees the result, so the sender's CSS cannot name it: a declaration
// cannot replace a shown image, and a `var()` cannot draw one on another element. The sender's
// CSS stays as written, escaped names and all.

import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import { ME, openWithBody, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

const SHOP = { name: 'Shop News', address: 'news@shop.example' }

/** A prefix the core drew: `--letterbox-`, 32 hex digits (128 bits), and a dash. */
const PREFIX = /^--letterbox-[0-9a-f]{32}-$/

/**
 * CSS that names what a shown image's property would be without the prefix: a declaration
 * plain and escaped (`\6c` is "l"), and a `var()` of each on another element.
 */
const CLAIMS = [
  '<style>:root{--letterbox-image-0:url(data:image/png;base64,AA);--\\6c etterbox-image-0:red}',
  '.a{background-image:var(--letterbox-image-0)}.b{background-image:var(--\\6c etterbox-image-0)}</style>',
].join('')

const newsletter = (key: string, subject: string, html: string, sentAt: string): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: SHOP,
  to: [ME],
  subject,
  text: `${subject}.`,
  html,
  sentAt,
  headers: { listUnsubscribe: true },
})

const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [{ key: 'inbox', name: 'Inbox', role: 'inbox' }],
  messages: [
    newsletter(
      'claims',
      'Claims',
      `${CLAIMS}<p style="background-image:url('https://cdn.shop.example/own.png')">Own</p><div class="a">A</div><div class="b">B</div>`,
      '2025-12-02T10:00:00.000Z',
    ),
    newsletter(
      'other',
      'Other',
      `<p style="background-image:url('https://cdn.shop.example/other.png')">Other</p>`,
      '2025-12-02T11:00:00.000Z',
    ),
  ],
})

scenario('the names a shown css image is set on start with a random prefix the sender cannot name', async (t) => {
  const { core } = await start(t, seed())
  const claims = await openWithBody(core, (await thread(core, 'Claims')).id)
  const other = await openWithBody(core, (await thread(core, 'Other')).id)
  if (claims.body.state !== 'ready' || other.body.state !== 'ready') throw new Error('the bodies are not ready')
  const prefix = claims.body.cssPrefix
  t.equal(
    [claims.body.html, claims.body.images.remote],
    [
      `${CLAIMS}<p style="background-image:var(${prefix}image-0, none)">Own</p><div class="a">A</div><div class="b">B</div>`,
      ['https://cdn.shop.example/own.png'],
    ],
    "the sender's CSS stays as written, and the core's placeholder names its image with the body's prefix",
  )
  t.equal(
    [PREFIX.test(prefix), PREFIX.test(other.body.cssPrefix), prefix === other.body.cssPrefix],
    [true, true, false],
    'each body has a prefix of its own: --letterbox-, 128 random bits in hex, and a dash',
  )
})
