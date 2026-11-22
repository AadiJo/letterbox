// The body pipeline's images (crates/core/src/body). The core takes trackers out of an HTML
// body for good, and blocks every other remote image until the user shows images for the
// message or for its sender. Each state's HTML comes from the core, and the choice survives
// a restart without the body being fetched again.

import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type { Body, Command, Message, ShowImages } from '@letterbox/protocol'
import { ME, openThread, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario, type Scenario } from '../src/scenario.ts'
import type { CoreClient, Subscription } from '../src/client.ts'

const SHOP = { name: 'Shop News', address: 'news@shop.example' }

/**
 * A newsletter with each kind of tracker the rules know, each kind of remote image, and an
 * attribute that pretends to be one of the core's own:
 *   bg.png, hero.jpg, logo@2x.png, stripe.png,   remote images, blocked until shown: a background
 *   poster.jpg, badge.svg                         attribute, src, srcset, CSS, a video poster, an SVG image
 *   a1.gif 1x1, h.png display:none                tiny, hidden
 *   list-manage.com, mailtrack.io, sendgrid       known hosts (mailtrack's URL hides its colon in an entity)
 *   pixel.png in an image input, open.gif         beacons
 */
const NEWSLETTER = [
  '<table><tr><td background="https://cdn.shop.example/bg.png">',
  '<img src="https://cdn.shop.example/hero.jpg" width="600" alt="Winter sale">',
  '<img src="cid:logo" srcset="https://cdn.shop.example/logo@2x.png 2x" alt="Shop">',
  `<p style="background-image:url('https://cdn.shop.example/stripe.png')" data-letterbox-image="7">Everything is on sale.</p>`,
  '<video poster="https://cdn.shop.example/poster.jpg"></video>',
  '<input type="image" src="https://news.shop.example/pixel.png" alt="Shop now">',
  '<svg><image href="https://cdn.shop.example/badge.svg" width="20" height="20"/></svg>',
  '</td></tr></table>',
  '<img src="https://news.shop.example/t/a1.gif" width="1" height="1" alt="">',
  '<img src="https://news.shop.example/h.png" style="display: none">',
  '<img src="https://us1.list-manage.com/track/open.php?u=1">',
  '<img src="https://news.shop.example/e/open.gif?id=9">',
  '<img src="https&#58;//mailtrack.io/trace/mail/x.png">',
  '<div style="background:url(https://ct.sendgrid.net/wf/open?upn=1)">Thanks for reading.</div>',
].join('')

const TRACKERS = [
  { host: 'news.shop.example', reason: 'beacon' },
  { host: 'news.shop.example', reason: 'tiny' },
  { host: 'news.shop.example', reason: 'hidden' },
  { host: 'us1.list-manage.com', reason: 'known-host' },
  { host: 'news.shop.example', reason: 'beacon' },
  { host: 'mailtrack.io', reason: 'known-host' },
  { host: 'ct.sendgrid.net', reason: 'known-host' },
]

const REMOTE = [
  'https://cdn.shop.example/bg.png',
  'https://cdn.shop.example/hero.jpg',
  'https://cdn.shop.example/logo@2x.png',
  'https://cdn.shop.example/stripe.png',
  'https://cdn.shop.example/poster.jpg',
  'https://cdn.shop.example/badge.svg',
]

/** The newsletter with images shown: the trackers and the planted attribute are gone, the rest is as written. */
const SHOWN = [
  '<table><tr><td background="https://cdn.shop.example/bg.png">',
  '<img src="https://cdn.shop.example/hero.jpg" width="600" alt="Winter sale">',
  '<img src="cid:logo" srcset="https://cdn.shop.example/logo@2x.png 2x" alt="Shop">',
  `<p style="background-image:url('https://cdn.shop.example/stripe.png')">Everything is on sale.</p>`,
  '<video poster="https://cdn.shop.example/poster.jpg"></video>',
  '<input type="image" alt="Shop now">',
  '<svg><image href="https://cdn.shop.example/badge.svg" width="20" height="20"/></svg>',
  '</td></tr></table>',
  '<div style="background:none">Thanks for reading.</div>',
].join('')

/** The newsletter with images blocked: each remote image is a placeholder that names its place in REMOTE. */
const BLOCKED = [
  '<table><tr><td data-letterbox-background="0">',
  '<img width="600" alt="Winter sale" data-letterbox-image="1">',
  '<img src="cid:logo" alt="Shop" data-letterbox-image="2">',
  '<p style="background-image:none">Everything is on sale.</p>',
  '<video data-letterbox-image="4"></video>',
  '<input type="image" alt="Shop now">',
  '<svg><image width="20" height="20" data-letterbox-image="5" /></svg>',
  '</td></tr></table>',
  '<div style="background:none">Thanks for reading.</div>',
].join('')

const newsletter = (
  key: string,
  subject: string,
  from: SeedMessage['from'],
  html: string,
  sentAt: string,
): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from,
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
  ],
})

type Ready = Extract<Body, { state: 'ready' }>

/** The first message's body, which must be ready. */
function bodyOf(open: Subscription<'thread'>): { message: Message; body: Ready } {
  const message = open.latest()?.messages[0]
  if (message?.body.state !== 'ready') throw new Error(`the body is not ready: ${JSON.stringify(message?.body)}`)
  return { message, body: message.body }
}

/** Fails unless no tracker's host appears anywhere in the html. */
function noTrackers(t: Scenario, body: Ready, when: string) {
  const found = TRACKERS.map((tracker) => tracker.host).filter((host) => body.html?.includes(host))
  t.equal(found, [], `${when}: no tracker is in the html`)
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

scenario('trackers leave an html body for good, and its remote images wait until the user shows them', async (t) => {
  const { core, box } = await start(t, seed())
  const winter = await openThread(core, (await thread(core, 'Winter sale')).id)
  const first = bodyOf(winter)
  t.equal(
    first.body.images,
    { shown: 'blocked', remote: REMOTE, trackers: TRACKERS },
    'it lists the remote images and the trackers taken out',
  )
  t.equal(first.body.html, BLOCKED, 'while blocked, each remote image is a placeholder and no CSS names one')
  t.check(!first.body.html?.includes('https:'), 'the blocked html names no remote URL at all')
  noTrackers(t, first.body, 'blocked')

  await done(t, core, show(first.message, 'message'), 'show this message')
  const shown = bodyOf(winter).body
  t.equal([shown.images.shown, shown.html], ['message', SHOWN], 'shown, its images are back and its trackers are not')
  noTrackers(t, shown, 'shown for the message')

  await done(t, core, show(first.message, 'blocked'), 'block it again')
  t.equal(bodyOf(winter).body.html, BLOCKED, 'blocked again, it is the placeholders again')
  await done(t, core, show(first.message, 'message'), 'show it once more')

  const spring = await openThread(core, (await thread(core, 'Spring sale')).id)
  const other = bodyOf(spring)
  t.equal(
    [other.body.images.shown, other.body.html],
    ['blocked', '<p>Spring is here.</p><img alt="Spring" data-letterbox-image="0">'],
    "showing one message does not show the sender's next",
  )
  await done(t, core, show(other.message, 'sender'), 'always show this sender')
  t.equal(
    [bodyOf(spring).body.images.shown, bodyOf(spring).body.html],
    ['sender', '<p>Spring is here.</p><img src="https://cdn.shop.example/spring.jpg" alt="Spring">'],
    'the message shows its images for its sender',
  )
  t.equal(bodyOf(winter).body.images.shown, 'sender', "the sender's other message, its address in other case, does too")
  noTrackers(t, bodyOf(winter).body, 'shown for the sender')

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
  t.equal(bodyOf(winterAgain).body.html, SHOWN, 'and the stored html is the same')
  t.equal(box.calls().body, fetched, 'no body was fetched again')

  await done(t, again, show(bodyOf(springAgain).message, 'blocked'), 'block the sender from its newer message')
  t.equal(
    [bodyOf(springAgain).body.images.shown, bodyOf(winterAgain).body.images.shown],
    ['blocked', 'message'],
    'that message and the sender are blocked, and the older message keeps its own choice from before the restart',
  )
  t.equal(bodyOf(winterAgain).body.html, SHOWN, 'which still shows its images')

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
