// Unsubscribing by one-click (crates/core/src/unsubscribe/dkim.rs): a POST only when a DKIM
// signature verifies, covers From and both List-Unsubscribe fields, and aligns with the From
// domain within its registrable domain (RFC 8058, RFC 6376). Otherwise the header's mailto goes
// out through the outbox. Every DKIM key comes from the fake web's DNS.

import { readSent } from '@letterbox/sim-provider/sent'
import { mailbox, sync } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import { accept } from '../src/undoing.ts'
import { FORM, ONE_CLICK, begin, messageOf, row, unsubscribe } from '../src/unsubscribing.ts'

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

scenario("an unsubscribe's one-click signature aligns only within the From domain's registrable domain", async (t) => {
  const { core, box } = await begin(t)
  const ids = []
  for (const subject of ['Shop news', 'Shop deals', 'Site notes']) ids.push(await messageOf(core, subject))
  const results = []
  for (const messageId of ids) {
    const change = await accept(t, core, { kind: 'unsubscribe', messageId }, 'the unsubscribe')
    results.push((await core.settled(change)).result)
  }
  t.equal(results, ['done', 'done', 'done'], 'each settles done')
  t.equal(
    [t.web.posted().map((post) => post.url), t.web.lookups()],
    [['https://shop.co.uk/u/13'], ['sel._domainkey.shop.co.uk']],
    'only the signature by shop.co.uk, the registrable domain, vouched for a POST',
  )
  t.equal(
    box.sent().map((copy) => copy.recipients),
    [['leave@list.example'], ['leave@list.example']],
    'the ones signed by co.uk and github.io, public suffixes, went out as mail',
  )
})
