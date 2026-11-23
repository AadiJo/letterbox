// Unsubscribing from a sender (crates/core/src/unsubscribe). The user confirms, the core holds
// the request for the send undo window, then carries it out once: a one-click POST when a DKIM
// signature over both List-Unsubscribe headers verifies (RFC 8058), else the header's mailto
// through the outbox, else the page, which the shell opens. Updates shows where it has got.
// Every DKIM key comes from the fake web's DNS, and every POST goes to the fake web.

import type { ChangeId, SenderSummary } from '@letterbox/protocol'
import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import { OTHER_DKIM_RECORD, SIM_DKIM_RECORD } from '@letterbox/sim-provider/raw'
import { readSent } from '@letterbox/sim-provider/sent'
import type { CoreClient } from '../src/client.ts'
import { ME, PASSWORD, mailbox, readThread, signIn, sync, thread } from '../src/fixtures.ts'
import { type CoreOptions, HELD_WINDOW, type Scenario, scenario } from '../src/scenario.ts'
import { accept } from '../src/undoing.ts'

const ONE_CLICK = 'List-Unsubscribe=One-Click'
const FORM = 'application/x-www-form-urlencoded'

const list = (
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
const oneClick = (url: string, dkim: NonNullable<SeedMessage['dkim']>): Partial<SeedMessage> => ({
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
 */
const seed = (): Seed => ({
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
  ],
})

/** Serves the DNS and the pages the seed's senders use. */
function web(t: Scenario) {
  t.web.txt('sel._domainkey.list.example', [SIM_DKIM_RECORD])
  t.web.txt('sel._domainkey.shop.example', [SIM_DKIM_RECORD])
  t.web.txt('k1._domainkey.other.example', [OTHER_DKIM_RECORD])
  t.web.txt('sel._domainkey.intranet.example', [SIM_DKIM_RECORD])
  t.web.txt('sel._domainkey.esp.example', [SIM_DKIM_RECORD])
  t.web.resolve('intranet.example', ['10.0.0.5'])
  const pages = ['list.example/u/1', 'shop.example/u/2', 'other.example/u/3', 'intranet.example/u/4']
  for (const page of [...pages, 'list.example/u/7', 'brand.example/u/8', 'list.example/u/9', 'list.example/u/11'])
    t.web.serve(`https://${page}`, { kind: 'status', status: 200 })
  t.web.serve('https://list.example/u/6', { kind: 'redirect', location: 'https://list.example/elsewhere' })
  t.web.serve('https://list.example/elsewhere', { kind: 'status', status: 200 })
}

/** Signs in to the seed's mailbox with a core started with `options`. */
async function begin(t: Scenario, options: CoreOptions = {}) {
  web(t)
  const box = t.mailbox(seed())
  const core = t.startCore(options)
  await core.hello()
  await signIn(t, core, ME, PASSWORD)
  await sync(core)
  return { core, box }
}

/** The id of the one message in the conversation with this subject. */
async function messageOf(core: CoreClient, subject: string) {
  const id = (await readThread(core, (await thread(core, subject)).id))?.messages[0]?.id
  if (id === undefined) throw new Error(`"${subject}" has no message`)
  return id
}

/** The Updates row of `address`, as the core shows it now. */
async function row(core: CoreClient, address: string): Promise<SenderSummary | undefined> {
  const inbox = await mailbox(core, 'Inbox')
  const page = await core.query({ view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 })
  return page.senders.find((sender) => sender.address === address)
}

/**
 * Unsubscribes from the sender of the message with this subject, and fails unless it is
 * accepted. Its message is looked up first, so no query runs while the unsubscribe goes out.
 */
const unsubscribe = async (t: Scenario, core: CoreClient, subject: string): Promise<ChangeId> =>
  accept(t, core, { kind: 'unsubscribe', messageId: await messageOf(core, subject) }, `unsubscribing from ${subject}`)

/** What left the device: POSTs, DNS lookups, raw fetches and sends. */
const traffic = (t: Scenario, box: ReturnType<Scenario['mailbox']>) => ({
  posted: t.web.posted().length,
  lookups: t.web.lookups().length,
  raw: box.calls().raw,
  sent: box.sent().length,
})

scenario('an unsubscribe held for its window is undone, and nothing leaves the device', async (t) => {
  const { core, box } = await begin(t, { undoWindow: HELD_WINDOW })
  t.equal((await row(core, 'news@list.example'))?.unsubscribed, null, 'before, the row shows no unsubscribe')

  const change = await unsubscribe(t, core, 'Weekly news')
  const held = (await row(core, 'news@list.example'))?.unsubscribed
  t.equal(
    held?.state === 'held' && [held.change, held.method],
    [change, 'one-click'],
    'the row shows it held, by one-click, under its change',
  )
  t.equal(
    (await core.command({ kind: 'unsubscribe', messageId: await messageOf(core, 'Weekly news') })).kind,
    'rejected',
    'a second unsubscribe from the same sender is refused while one is held',
  )

  const undo = await accept(t, core, { kind: 'undo', change }, 'the undo')
  t.equal(
    [(await core.settled(change)).result, (await core.settled(undo)).result],
    ['undone', 'done'],
    'the unsubscribe settles undone and the undo done',
  )
  t.equal((await row(core, 'news@list.example'))?.unsubscribed, null, 'the row offers the button again')
  t.equal(traffic(t, box), { posted: 0, lookups: 0, raw: 0, sent: 0 }, 'nothing was posted, looked up, fetched or sent')
})

scenario('a one-click unsubscribe whose DKIM signature verifies is posted once', async (t) => {
  const { core, box } = await begin(t)
  const inbox = await mailbox(core, 'Inbox')
  const updates = core.subscribe({ view: 'senders', mailboxId: inbox.id, offset: 0, limit: 50 })
  const change = await unsubscribe(t, core, 'Weekly news')
  t.equal((await core.settled(change)).result, 'done', 'it settles done once its window ends')
  t.equal(
    updates.latest()?.senders.find((sender) => sender.address === 'news@list.example')?.unsubscribed,
    { state: 'done', change, method: 'one-click' },
    'an open Updates shows it done before it settles',
  )
  updates.close()
  t.equal(
    t.web.posted(),
    [{ url: 'https://list.example/u/1', type: FORM, body: ONE_CLICK }],
    'one POST of List-Unsubscribe=One-Click went to the signed URL, form-encoded, with no cookie or credentials',
  )
  t.equal(t.web.lookups(), ['sel._domainkey.list.example'], 'the key was looked up once, through the host')
  t.equal([box.calls().raw, box.sent().length], [1, 0], 'the raw message was fetched once, and no mail was sent')
  t.equal(
    (await row(core, 'news@list.example'))?.unsubscribed,
    { state: 'done', change, method: 'one-click' },
    'the row shows it done by one-click',
  )

  const command = { kind: 'unsubscribe', messageId: await messageOf(core, 'Weekly news') } as const
  const again = await core.command(command)
  t.equal(again.kind, 'accepted', 'a new unsubscribe after one is done is accepted')
  t.equal((await core.settled(again.change)).result, 'done', 'it settles done')
  const resent = await core.command(command, again.change)
  t.equal(resent.kind, 'accepted', 'the same command sent again is answered again')
  t.equal(t.web.posted().length, 2, 'the command sent twice posted once')
  t.equal(
    (await core.command({ kind: 'undo', change })).kind,
    'rejected',
    'an undo after the window is refused: the sender has it',
  )
})

scenario('a one-click unsubscribe whose DKIM check fails goes out once as mail', async (t) => {
  const { core, box } = await begin(t)
  const unsigned = await unsubscribe(t, core, 'Deals')
  t.equal((await core.settled(unsigned)).result, 'done', 'it settles done once the provider holds its mail')
  const wrongKey = await unsubscribe(t, core, 'Promotions')
  t.equal((await core.settled(wrongKey)).result, 'done', 'so does the other')
  t.equal(t.web.posted(), [], 'nothing was posted: neither signature covers both headers and verifies')
  t.equal(
    t.web.lookups(),
    ['k1._domainkey.other.example'],
    'only the key of a signature over both headers was looked up',
  )
  const sent = box.sent()
  t.equal(sent.length, 2, 'the provider got one email for each')
  t.equal(
    sent.map((copy) => copy.recipients),
    [['leave@list.example'], ['leave@list.example']],
    'each went to the mailto address',
  )
  t.equal(
    sent.map((copy) => {
      const read = readSent(copy.raw, null)
      return [read.facts.subject, read.body.text]
    }),
    [
      ['Leave weekly+news', 'Remove me'],
      ['Leave weekly+news', 'Remove me'],
    ],
    'each has the subject and body the URI names, with + kept as a plus',
  )
  t.equal(
    [(await row(core, 'deals@shop.example'))?.unsubscribed, (await row(core, 'promo@other.example'))?.unsubscribed],
    [
      { state: 'done', change: unsigned, method: 'mailto' },
      { state: 'done', change: wrongKey, method: 'mailto' },
    ],
    'each row shows it done by mail',
  )
  await sync(core)
  t.equal(box.sent().length, 2, 'a sync after sends nothing again')
})

scenario('a one-click unsubscribe at a private address is refused, and a redirect is not followed', async (t) => {
  const { core } = await begin(t)
  const change = await unsubscribe(t, core, 'Alerts')
  t.equal((await core.settled(change)).result, { failed: 'not-public' }, 'it fails not-public')
  t.equal([t.web.posted(), t.web.requested()], [[], []], 'nothing was sent to the host')
  t.equal((await row(core, 'alerts@intranet.example'))?.unsubscribed, null, 'the row offers the button again')

  const moved = await unsubscribe(t, core, 'Moved list')
  t.equal(
    (await core.settled(moved)).result,
    { failed: 'refused-by-provider' },
    'a redirect, which RFC 8058 forbids, fails it',
  )
  t.equal(
    [t.web.posted().map((post) => post.url), t.web.requested()],
    [['https://list.example/u/6'], []],
    'the POST went once, and the redirect was not followed',
  )
})

scenario("an unsubscribe's POST cut off by a stopped core is never sent again", async (t) => {
  const first = await begin(t)
  const held = t.web.hold('https://list.example/u/1')
  const change = await unsubscribe(t, first.core, 'Weekly news')
  await held.arrived
  await first.core.kill()
  held.release()

  const core = t.startCore()
  await core.hello()
  t.equal(
    (await core.settled(change)).result,
    { failed: 'unconfirmed' },
    'after the restart it fails unconfirmed: it may have arrived',
  )
  t.equal(t.web.posted().length, 1, 'it was posted once')
  t.equal((await row(core, 'news@list.example'))?.unsubscribed, null, 'the row offers the button again')
})

scenario('a web unsubscribe keeps its page for the user, and the core opens nothing', async (t) => {
  const first = await begin(t)
  const change = await unsubscribe(t, first.core, 'Daily digest')
  t.equal((await first.core.settled(change)).result, 'done', 'it settles done once its page is kept')
  const page = { state: 'page', change, url: 'https://list.example/u/5' } as const
  t.equal((await row(first.core, 'digest@list.example'))?.unsubscribed, page, 'the row offers the page, not done')
  t.equal(traffic(t, first.box), { posted: 0, lookups: 0, raw: 0, sent: 0 }, 'the core itself sent nothing')
  // An open-url naming a change is no message the protocol has, so the schema check fails any.
  await first.core.stop()
  const core = t.startCore()
  await core.hello()
  t.equal(
    (await row(core, 'digest@list.example'))?.unsubscribed,
    page,
    'after a restart the page is still only offered',
  )
})

scenario(
  'an unsubscribe held across a restart can still be undone, and one past its window goes out at start',
  async (t) => {
    const first = await begin(t, { undoWindow: HELD_WINDOW })
    const kept = await unsubscribe(t, first.core, 'Weekly news')
    const held = (await row(first.core, 'news@list.example'))?.unsubscribed
    await first.core.stop()

    const second = t.startCore({ undoWindow: HELD_WINDOW })
    await second.hello()
    t.equal(
      (await row(second, 'news@list.example'))?.unsubscribed,
      held,
      'after a restart it is held to the same deadline',
    )
    const undo = await accept(t, second, { kind: 'undo', change: kept }, 'the undo after the restart')
    t.equal(
      [(await second.settled(kept)).result, (await second.settled(undo)).result],
      ['undone', 'done'],
      'it is undone',
    )
    const due = await unsubscribe(t, second, 'Weekly news')
    await second.stop()
    t.equal(traffic(t, first.box), { posted: 0, lookups: 0, raw: 0, sent: 0 }, 'nothing left the device so far')

    // Two hours on, past the held window: the restarted core carries it out at once.
    const third = t.startCore({ now: '2026-01-01T02:00:00.000Z' })
    await third.hello()
    t.equal((await third.settled(due)).result, 'done', 'it goes out as the core starts, and settles done')
    t.equal(t.web.posted().length, 1, 'it was posted once')
  },
)

scenario('a one-click unsubscribe without an aligned signature over its fields goes out as mail', async (t) => {
  const { core, box } = await begin(t)
  const subjects = ['Weekly digest', 'Offers', 'Spaced list', 'Members', 'Archive']
  const ids = []
  for (const subject of subjects) ids.push(await messageOf(core, subject))
  const results = []
  for (const messageId of ids) {
    const change = await accept(t, core, { kind: 'unsubscribe', messageId }, 'the unsubscribe')
    results.push((await core.settled(change)).result)
  }
  t.equal(results, ['done', 'done', 'done', 'done', 'done'], 'each settles done once the provider holds its mail')
  t.equal(
    [t.web.posted(), t.web.lookups(), t.web.requested()],
    [[], [], []],
    'nothing was posted, no key was looked up, and no URL was asked for, so no Authorization header went anywhere',
  )
  t.equal(
    [box.calls().raw, box.sent().map((copy) => copy.recipients)],
    [5, Array.from({ length: 5 }, () => ['leave@list.example'])],
    'each raw source was asked for once, the big one cut off, and each sent one email to the mailto address',
  )
})

scenario("an unsubscribe's mail cut off by a stopped core is looked up, not sent again", async (t) => {
  const first = await begin(t)
  first.box.holdSends()
  const change = await unsubscribe(t, first.core, 'Deals')
  await first.box.sendHeld()
  await first.core.kill()

  const core = t.startCore({ holdWaits: true })
  await core.hello()
  await sync(core)
  t.equal(first.box.sent(), [], 'the restarted core looked it up, found nothing, and did not send it again')
  t.check(first.box.calls().find >= 1, 'it looked the mail up by its Message-ID')
  first.box.releaseSends()
  await sync(core)
  t.equal((await core.settled(change)).result, 'done', 'the sync that brings its copy settles it done')
  t.equal([first.box.sent().length, first.box.calls().send], [1, 1], 'the provider was asked to send it once')
})

scenario('a second core on the same store is refused, so one unsubscribe goes out from one core', async (t) => {
  const { core } = await begin(t)
  const second = t.startCore()
  await second.stop()
  t.equal(second.exitCode(), 1, 'the second core exits with an error')
  t.check(second.log().includes('another core has this store open'), 'it says another core has the store')
  const change = await unsubscribe(t, core, 'Weekly news')
  t.equal((await core.settled(change)).result, 'done', 'the first core carries on')
  t.equal(t.web.posted().length, 1, 'one POST went out')
})
