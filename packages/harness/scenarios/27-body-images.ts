// The body pipeline's images (crates/core/src/body). The core takes trackers out of an HTML
// body for good and turns every other remote image into a placeholder. The renderer never
// reaches the network: once the user shows a message's images, for the message or for its
// verified sender, the core fetches each one a UI asks for, and nothing else.

import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type { Body, Command, Message, ShowImages } from '@letterbox/protocol'
import { ME, openThread, PASSWORD, start, sync, thread } from '../src/fixtures.ts'
import { scenario, type Scenario } from '../src/scenario.ts'
import type { CoreClient, Subscription } from '../src/client.ts'

const SHOP = { name: 'Shop News', address: 'news@shop.example' }
/** What Google's receiving server writes for mail the shop's domain really sent. */
const VERIFIED = ['mx.google.com; dkim=pass header.i=@shop.example; dmarc=pass (p=REJECT) header.from=shop.example']

/**
 * A newsletter with each kind of tracker the rules know, each kind of remote image, and the
 * tricks a sender could use to get past them:
 *   bg.png, hero.jpg, stripe.png, poster.jpg,     remote images: a background attribute, src,
 *   badge.svg, promo.jpg                          CSS, a video poster, an SVG image, a srcset
 *   a1.gif 1x1, h.png display:none                tiny, hidden
 *   list-manage.com, mailtrack.io, sendgrid       known hosts (mailtrack's URL hides its colon in an entity)
 *   pixel.png in an image input, open.gif twice   beacons: the second sits in a src beside a real srcset
 *   ns.gif 1x1 in a <noscript>                    read as the frame reads it, so a tiny tracker
 *   <base href>, rel/photo.png                    the base goes, so the relative image names no server
 *   image-set(), logo@2x.png beside cid:logo      not listed, so never fetched
 *   data-letterbox-image="7"                      an attribute that pretends to be the core's own
 *   <link> dns-prefetch, preconnect, stylesheet    hints a browser acts on outside the image policy
 *   <meta http-equiv>                              which would turn prefetching back on
 *   a preconnect and a refresh in a <noscript>     which become markup once the noscript is unwrapped
 *   US1.LIST-MANAGE.COM., ｍａｉｌｔｒａｃｋ.io       known hosts in capitals with a trailing dot, and in full-width letters
 */
const NEWSLETTER = [
  '<link rel="dns-prefetch" href="//cdn.shop.example"><link rel="preconnect" href="https://cdn.shop.example">',
  '<link rel="stylesheet" href="https://cdn.shop.example/mail.css">',
  '<meta http-equiv="x-dns-prefetch-control" content="on">',
  '<noscript><link rel="preconnect" href="https://cdn.shop.example"><meta http-equiv="refresh" content="0;url=https://evil.example"></noscript>',
  '<base href="https://evil.example/">',
  '<table><tr><td background="https://cdn.shop.example/bg.png">',
  '<img src="https://cdn.shop.example/hero.jpg" width="600" alt="Winter sale">',
  '<img src="cid:logo" srcset="https://cdn.shop.example/logo@2x.png 2x" alt="Shop">',
  `<p style="background-image:url('https://cdn.shop.example/stripe.png')" data-letterbox-image="7">Everything is on sale.</p>`,
  '<video poster="https://cdn.shop.example/poster.jpg"></video>',
  '<input type="image" src="https://news.shop.example/pixel.png" alt="Shop now">',
  '<svg><image href="https://cdn.shop.example/badge.svg" width="20" height="20"/></svg>',
  '<img src="https://news.shop.example/e/open.gif" srcset="https://cdn.shop.example/promo.jpg 1x" alt="Promo">',
  '</td></tr></table>',
  '<noscript><img src="https://news.shop.example/ns.gif" width="1" height="1"></noscript>',
  '<img src="rel/photo.png" alt="Relative">',
  `<div style="background-image:image-set('https://cdn.shop.example/set.png' 1x)">Set</div>`,
  '<img src="https://news.shop.example/t/a1.gif" width="1" height="1" alt="">',
  '<img src="https://news.shop.example/h.png" style="display: none">',
  '<img src="https://us1.list-manage.com/track/open.php?u=1">',
  '<img src="https://news.shop.example/e/open.gif?id=9">',
  '<img src="https&#58;//mailtrack.io/trace/mail/x.png">',
  '<img src="https://US1.LIST-MANAGE.COM./track/x.png" alt="">',
  '<img src="https://ｍａｉｌｔｒａｃｋ.io/y.png" alt="">',
  '<div style="background:url(https://ct.sendgrid.net/wf/open?upn=1)">Thanks for reading.</div>',
].join('')

const TRACKERS = [
  { host: 'news.shop.example', reason: 'beacon' },
  { host: 'news.shop.example', reason: 'beacon' },
  { host: 'news.shop.example', reason: 'tiny' },
  { host: 'news.shop.example', reason: 'tiny' },
  { host: 'news.shop.example', reason: 'hidden' },
  { host: 'us1.list-manage.com', reason: 'known-host' },
  { host: 'news.shop.example', reason: 'beacon' },
  { host: 'mailtrack.io', reason: 'known-host' },
  { host: 'us1.list-manage.com', reason: 'known-host' },
  { host: 'mailtrack.io', reason: 'known-host' },
  { host: 'ct.sendgrid.net', reason: 'known-host' },
]

const REMOTE = [
  'https://cdn.shop.example/bg.png',
  'https://cdn.shop.example/hero.jpg',
  'https://cdn.shop.example/stripe.png',
  'https://cdn.shop.example/poster.jpg',
  'https://cdn.shop.example/badge.svg',
  'https://cdn.shop.example/promo.jpg',
]

/** The html a UI shows, in every state: each remote image a placeholder that names its place in REMOTE. */
const HTML = [
  '<table><tr><td data-letterbox-background="0">',
  '<span data-letterbox-image="1" data-letterbox-width="600">Winter sale</span>',
  '<img src="cid:logo" alt="Shop">',
  '<p style="background-image:var(--letterbox-image-2, none)">Everything is on sale.</p>',
  '<video data-letterbox-image="3"></video>',
  '<input type="image" alt="Shop now">',
  '<svg><image width="20" height="20" data-letterbox-image="4" /></svg>',
  '<span data-letterbox-image="5">Promo</span>',
  '</td></tr></table>',
  '<img src="rel/photo.png" alt="Relative">',
  `<div style="background-image:image-set('https://cdn.shop.example/set.png' 1x)">Set</div>`,
  '<div style="background:none">Thanks for reading.</div>',
].join('')

const newsletter = (
  key: string,
  subject: string,
  from: SeedMessage['from'],
  html: string,
  sentAt: string,
  authenticationResults: readonly string[] = VERIFIED,
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from,
  to: [ME],
  subject,
  text: `${subject}.`,
  html,
  sentAt,
  headers: { listUnsubscribe: true, authenticationResults },
})

const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    newsletter('winter', 'Winter sale', SHOP, NEWSLETTER, '2025-12-01T09:00:00.000Z'),
    // The same sender, its address in other case.
    newsletter(
      'spring',
      'Spring sale',
      { ...SHOP, address: 'News@Shop.example' },
      '<p>Spring is here.</p><img src="https://cdn.shop.example/spring.jpg" alt="Spring">',
      '2025-12-02T09:00:00.000Z',
    ),
    // Only claims the shop's address: Google's own header says DMARC failed. The pass below it
    // is the sender's own writing, which counts for nothing.
    newsletter(
      'forged',
      'Your account is locked',
      SHOP,
      '<img src="https://cdn.shop.example/forged.png" alt="Locked">',
      '2025-12-02T10:00:00.000Z',
      ['mx.google.com; dmarc=fail (p=REJECT) header.from=shop.example', ...VERIFIED],
    ),
    // Claims Google's verdict, but the topmost header is another server's.
    newsletter(
      'claimed',
      'Claimed verdict',
      SHOP,
      '<img src="https://cdn.shop.example/claimed.png" alt="Claimed">',
      '2025-12-02T11:00:00.000Z',
      ['relay.example; dmarc=pass header.from=shop.example'],
    ),
    // Google's first verdict passes, but another of Google's below it fails: unsure, so unverified.
    newsletter(
      'split',
      'Split verdict',
      SHOP,
      '<img src="https://cdn.shop.example/split.png" alt="Split">',
      '2025-12-02T11:30:00.000Z',
      [...VERIFIED, 'mx.google.com; dmarc=fail header.from=shop.example'],
    ),
    // Verified, but for evil.example: the shop's address is only in the quoted display name.
    newsletter(
      'display',
      'Display name',
      { name: 'Shop <news@shop.example>', address: 'x@evil.example' },
      '<img src="https://cdn.shop.example/display.png" alt="Display">',
      '2025-12-02T11:45:00.000Z',
      ['mx.google.com; dmarc=pass header.from=evil.example'],
    ),
    // Images that point inside the network: an IP literal, one in IPv6 form, a name the fake
    // web resolves to loopback, one to a public and a private address, and a redirect to one.
    newsletter(
      'inner',
      'Inner images',
      SHOP,
      [
        '<img src="https://127.0.0.1/a.png" alt="A">',
        '<img src="https://[::ffff:127.0.0.1]/b.png" alt="B">',
        '<img src="https://inner.shop.example/c.png" alt="C">',
        '<img src="https://mixed.shop.example/d.png" alt="D">',
        '<img src="https://cdn.shop.example/hop.png" alt="E">',
      ].join(''),
      '2025-12-02T12:00:00.000Z',
    ),
    // IPv6 hosts from the special-purpose registry's ranges that are not global, a name at a
    // unique-local address, and one global address that does go through.
    newsletter(
      'six',
      'IPv6 images',
      SHOP,
      [
        '<img src="https://[64:ff9b:1::a00:5]/a.png" alt="local NAT64">',
        '<img src="https://[2001:db8::1]/b.png" alt="documentation">',
        '<img src="https://[2002:7f00:1::]/c.png" alt="6to4 of loopback">',
        '<img src="https://[100::1]/d.png" alt="discard">',
        '<img src="https://[3fff::1]/e.png" alt="documentation">',
        '<img src="https://[2001:2::1]/f.png" alt="benchmarking">',
        '<img src="https://six.shop.example/g.png" alt="unique-local">',
        '<img src="https://[2606:4700::1111]/h.png" alt="global">',
      ].join(''),
      '2025-12-02T12:30:00.000Z',
    ),
  ],
})

type Ready = Extract<Body, { state: 'ready' }>

/** The first message's body, which must be ready. */
function bodyOf(open: Subscription<'thread'>): { message: Message; body: Ready } {
  const message = open.latest()?.messages[0]
  if (message?.body.state !== 'ready') throw new Error(`the body is not ready: ${JSON.stringify(message?.body)}`)
  return { message, body: message.body }
}

/** Sends one command, which must be accepted and settle done. */
async function done(t: Scenario, core: CoreClient, command: Command, what: string) {
  const answer = await core.command(command)
  t.equal(answer.kind, 'accepted', `${what}: accepted`)
  if (answer.kind !== 'accepted') return
  t.equal((await core.settled(answer.change)).result, 'done', `${what}: settles at once`)
}

const show = (message: Message, choice: ShowImages): Command => ({
  kind: 'set-images',
  messageId: message.id,
  show: choice,
})

/** Asks the core for one remote image, and returns its answer and the bytes its chunks carried. */
async function image(core: CoreClient, message: Message, index: number) {
  const response = await core.request({ method: 'image', messageId: message.id, index })
  if (!response.ok) return { answer: response.error, bytes: '' }
  const chunks = Math.ceil(response.result.size / (64 * 1024))
  const parts: Buffer[] = []
  for (let taken = 0; taken < chunks; taken += 1) parts.push(Buffer.from((await core.take('chunk')).data, 'base64'))
  return { answer: response.result, bytes: Buffer.concat(parts).toString('base64') }
}

scenario('trackers leave an html body for good, and its remote images wait until the user shows them', async (t) => {
  const { core, box } = await start(t, seed())
  const winter = await openThread(core, (await thread(core, 'Winter sale')).id)
  const first = bodyOf(winter)
  t.equal(
    first.body.images,
    { shown: 'blocked', remote: REMOTE, trackers: TRACKERS },
    'it lists the remote images and the trackers taken out, the one in a noscript and the one in a src beside a srcset too',
  )
  t.equal(first.body.html, HTML, 'each remote image is a placeholder, and the base and every tracker are gone')
  t.check(first.message.senderVerified, "Google's own verdict verifies the shop")

  await done(t, core, show(first.message, 'message'), 'show this message')
  t.equal(
    [bodyOf(winter).body.images.shown, bodyOf(winter).body.html],
    ['message', HTML],
    'shown, it is the same html: the images come from the core',
  )
  await done(t, core, show(first.message, 'blocked'), 'block it again')
  t.equal(bodyOf(winter).body.images.shown, 'blocked', 'blocked again')
  await done(t, core, show(first.message, 'message'), 'show it once more')

  const spring = await openThread(core, (await thread(core, 'Spring sale')).id)
  const other = bodyOf(spring)
  t.equal(
    [other.body.images.shown, other.body.html],
    ['blocked', '<p>Spring is here.</p><span data-letterbox-image="0">Spring</span>'],
    "showing one message does not show the sender's next",
  )
  await done(t, core, show(other.message, 'sender'), 'always show this sender')
  t.equal(bodyOf(spring).body.images.shown, 'sender', 'the message shows its images for its sender')
  t.equal(bodyOf(winter).body.images.shown, 'sender', "the sender's other message, its address in other case, does too")

  for (const subject of ['Your account is locked', 'Claimed verdict', 'Split verdict']) {
    const open = await openThread(core, (await thread(core, subject)).id)
    const forged = bodyOf(open)
    t.equal(
      [forged.message.senderVerified, forged.body.images.shown],
      [false, 'blocked'],
      `${subject}: mail that only claims the address stays blocked`,
    )
    const refused = await core.command(show(forged.message, 'sender'))
    t.equal(
      refused.kind === 'rejected' && refused.reason,
      'not-permitted',
      `${subject}: its sender cannot be always shown`,
    )
  }
  const display = bodyOf(await openThread(core, (await thread(core, 'Display name')).id))
  t.equal(
    [display.message.from.address, display.body.images.shown],
    ['x@evil.example', 'blocked'],
    "a mailbox named only in a quoted display name is not the shop's, so its mail stays blocked",
  )

  box.deliver(
    newsletter(
      'summer',
      'Summer sale',
      SHOP,
      '<img src="https://cdn.shop.example/summer.jpg" alt="Summer">',
      '2025-12-03T09:00:00.000Z',
    ),
  )
  await sync(core)
  const summer = await openThread(core, (await thread(core, 'Summer sale')).id)
  t.equal(bodyOf(summer).body.images.shown, 'sender', "the sender's new verified mail shows its images as it arrives")

  const fetched = box.calls().body
  await core.stop()
  const again = t.startCore()
  await again.hello()
  const winterAgain = await openThread(again, (await thread(again, 'Winter sale')).id)
  const springAgain = await openThread(again, (await thread(again, 'Spring sale')).id)
  t.equal(
    [bodyOf(winterAgain).body.images.shown, bodyOf(springAgain).body.images.shown],
    ['sender', 'sender'],
    'after a restart the sender is still shown',
  )
  t.equal(box.calls().body, fetched, 'no body was fetched again')

  await done(t, again, show(bodyOf(springAgain).message, 'blocked'), 'block the sender from its newer message')
  t.equal(
    [bodyOf(springAgain).body.images.shown, bodyOf(winterAgain).body.images.shown],
    ['blocked', 'message'],
    'that message and the sender are blocked, and the older message keeps its own choice from before the restart',
  )
  const unknown = await again.command({
    kind: 'set-images',
    messageId: 'message_404' as Message['id'],
    show: 'message',
  })
  t.equal(
    unknown.kind === 'rejected' && unknown.reason,
    'unknown-target',
    'set-images on a message the core does not have is refused',
  )
  t.equal(t.web.requested(), [], 'nothing was fetched: no UI asked for an image')
})

/** A PNG, a JPEG and an SVG's first bytes, which is all the core reads to tell them apart. */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('hero')])
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('poster')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><a href="https://shop.example">x</a></svg>')

scenario('the core fetches a shown image a UI asks for, checks every redirect, and fetches nothing else', async (t) => {
  // Says it is a JPEG, but its bytes are a PNG: the core goes by the bytes.
  t.web.serve('https://cdn.shop.example/hero.jpg', { kind: 'body', mime: 'image/jpeg', bytes: PNG })
  t.web.serve('https://cdn.shop.example/bg.png', { kind: 'redirect', location: 'https://us1.list-manage.com./o.gif' })
  t.web.serve('https://cdn.shop.example/stripe.png', { kind: 'redirect', location: 'http://cdn.shop.example/s.png' })
  t.web.serve('https://cdn.shop.example/poster.jpg', { kind: 'redirect', location: '/moved/poster.jpg' })
  t.web.serve('https://cdn.shop.example/moved/poster.jpg', { kind: 'body', mime: 'image/jpeg', bytes: JPEG })
  t.web.serve('https://cdn.shop.example/badge.svg', { kind: 'body', mime: 'image/svg+xml', bytes: SVG })
  t.web.serve('https://cdn.shop.example/promo.jpg', {
    kind: 'body',
    mime: 'image/jpeg',
    bytes: Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]),
  })
  t.web.resolve('inner.shop.example', ['127.0.0.1'])
  t.web.resolve('mixed.shop.example', ['93.184.215.14', '10.0.0.5'])
  t.web.resolve('hidden.shop.example', ['169.254.169.254'])
  t.web.serve('https://cdn.shop.example/hop.png', { kind: 'redirect', location: 'https://hidden.shop.example/e.png' })
  t.web.resolve('six.shop.example', ['fd12:3456::1'])
  t.web.serve('https://[2606:4700::1111]/h.png', { kind: 'body', mime: 'image/png', bytes: PNG })
  const { core } = await start(t, seed())
  const winter = await openThread(core, (await thread(core, 'Winter sale')).id)
  const message = bodyOf(winter).message
  t.equal(await image(core, message, 1), { answer: 'blocked', bytes: '' }, 'nothing is fetched while blocked')
  t.equal(t.web.requested(), [], 'and nothing reached the web')

  await done(t, core, show(message, 'message'), 'show this message')
  t.equal(
    await image(core, message, 1),
    { answer: { mime: 'image/png', size: PNG.length }, bytes: PNG.toString('base64') },
    'a shown image comes from the core, in chunks, its type read from its bytes',
  )
  t.equal(
    await image(core, message, 0),
    { answer: 'refused', bytes: '' },
    'a redirect to a tracker, its host in another spelling, is not followed',
  )
  t.equal(await image(core, message, 2), { answer: 'refused', bytes: '' }, 'nor one away from https')
  t.equal(
    await image(core, message, 3),
    { answer: { mime: 'image/jpeg', size: JPEG.length }, bytes: JPEG.toString('base64') },
    'a relative redirect to another image on https is',
  )
  t.equal(
    await image(core, message, 4),
    { answer: 'refused', bytes: '' },
    'an SVG, which can carry links, is not passed on',
  )
  t.equal(await image(core, message, 5), { answer: 'too-large', bytes: '' }, 'nor an image over 5 MB')
  t.equal(await image(core, message, 6), { answer: 'gone', bytes: '' }, 'an index past the list is gone')

  const inner = bodyOf(await openThread(core, (await thread(core, 'Inner images')).id)).message
  await done(t, core, show(inner, 'message'), 'show the inner images')
  const refused = []
  for (const index of [0, 1, 2, 3, 4]) refused.push((await image(core, inner, index)).answer)
  t.equal(
    refused,
    ['refused', 'refused', 'refused', 'refused', 'refused'],
    'a loopback literal, its IPv6 form, a name that resolves to loopback, one with a private address among public ones, and a redirect to cloud metadata are all refused',
  )
  const six = bodyOf(await openThread(core, (await thread(core, 'IPv6 images')).id)).message
  await done(t, core, show(six, 'message'), 'show the IPv6 images')
  const answers = []
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const { answer } = await image(core, six, index)
    answers.push(typeof answer === 'string' ? answer : answer.mime)
  }
  t.equal(
    answers,
    ['refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'image/png'],
    'local-use NAT64, documentation, 6to4 of loopback, discard, the new documentation range, benchmarking and a unique-local name are refused, and a global address is not',
  )
  t.equal(
    t.web.requested(),
    [
      'https://cdn.shop.example/hero.jpg',
      'https://cdn.shop.example/bg.png',
      'https://cdn.shop.example/stripe.png',
      'https://cdn.shop.example/poster.jpg',
      'https://cdn.shop.example/moved/poster.jpg',
      'https://cdn.shop.example/badge.svg',
      'https://cdn.shop.example/promo.jpg',
      'https://cdn.shop.example/hop.png',
      'https://[2606:4700::1111]/h.png',
    ],
    'the web saw only the listed public images and the redirects allowed: no tracker, no address inside the network, no noscript image, base, image-set or srcset beside a local image',
  )
})

scenario('a block while an image is fetched ends the fetch as blocked', async (t) => {
  t.web.serve('https://cdn.shop.example/hero.jpg', { kind: 'body', mime: 'image/png', bytes: PNG })
  const { core } = await start(t, seed())
  const winter = await openThread(core, (await thread(core, 'Winter sale')).id)
  const message = bodyOf(winter).message
  await done(t, core, show(message, 'message'), 'show this message')
  const held = t.web.hold('https://cdn.shop.example/hero.jpg')
  const asked = core.begin({ method: 'image', messageId: message.id, index: 1 })
  await held.arrived
  await done(t, core, show(message, 'blocked'), 'block it while the image is on its way')
  held.release()
  const response = await asked.done
  t.equal(response.ok ? 'fetched' : response.error, 'blocked', 'the bytes that came are not passed on')

  // A redirect held, then a block: the next hop is never asked for.
  t.web.serve('https://cdn.shop.example/poster.jpg', { kind: 'redirect', location: '/moved/poster.jpg' })
  await done(t, core, show(message, 'message'), 'show it again')
  const redirect = t.web.hold('https://cdn.shop.example/poster.jpg')
  const second = core.begin({ method: 'image', messageId: message.id, index: 3 })
  await redirect.arrived
  await done(t, core, show(message, 'blocked'), 'block it while the redirect is on its way')
  redirect.release()
  const answer = await second.done
  t.equal(answer.ok ? 'fetched' : answer.error, 'blocked', 'a block before a hop ends the fetch')
  t.equal(
    t.web.requested(),
    ['https://cdn.shop.example/hero.jpg', 'https://cdn.shop.example/poster.jpg'],
    'and the redirect was never followed',
  )
})

scenario('set-images cannot be undone', async (t) => {
  const { core } = await start(t, seed())
  const winter = await openThread(core, (await thread(core, 'Winter sale')).id)
  const answer = await core.command(show(bodyOf(winter).message, 'message'))
  if (answer.kind !== 'accepted') return t.check(false, 'set-images is accepted')
  await core.settled(answer.change)
  const undo = await core.command({ kind: 'undo', change: answer.change })
  t.equal(undo.kind === 'rejected' && undo.reason, 'not-supported', 'its undo is refused not-supported')
  t.equal(bodyOf(winter).body.images.shown, 'message', 'and the images stay shown')
})
