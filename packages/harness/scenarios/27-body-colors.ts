// The colour pass (crates/core/src/body/paint.rs, dark.rs, scheme.rs). The core names every
// color an HTML body sets, so one stored copy shows either restyled for the dark reader or in
// the sender's own colors, and gives each color a dark value that keeps its hue and stays
// readable. It tells designed mail from a person's plain HTML. Which scheme a message shows is
// its sender's choice, kept by From address, so it reaches the sender's other and new mail and
// survives a restart.

import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import { devSeeds } from '@letterbox/sim-provider/seeds'
import type { Body, ColorScheme, Colors, Command, Message } from '@letterbox/protocol'
import { ME, openThread, PASSWORD, start, sync, thread } from '../src/fixtures.ts'
import { scenario, type Scenario } from '../src/scenario.ts'
import type { CoreClient, Subscription } from '../src/client.ts'

const LUMEN = { name: 'Lumen Weekly', address: 'news@lumen.example' }
const HANA = { name: 'Hana Sato', address: 'hana@inkwell.example' }

/**
 * A branded newsletter, built as such mail is: a layout table inside a table, colors in
 * attributes (`<body>`'s, a `bgcolor` with no `#`, a `<font>`), in a `<style>` block (behind a
 * selector with a colon, inside `@media`, beside a remote image) and inline, written as hex,
 * `rgb()`, `hsl()` and names in any case, and a faint footer whose dark value needs more alpha
 * to read. It also tries what the pass must leave: a custom property named like the core's own,
 * color names in a string, a `url()` and an `image-set()`, `inherit`, `transparent`, and hidden
 * text with no alpha.
 */
const LUMEN_HTML = [
  '<body bgcolor="#F4EFE6" text="#2f3a38" link="#c8552b">',
  '<style>:root{--letterbox-color-0:#ff0000}.essay a:hover{color:#a84520}',
  '.button{background:#12423d;color:#f4efe6}@media (max-width:600px){.story{border-top:1px solid #e2dacb}}',
  '.hero{background:url(https://cdn.lumen.example/hero.jpg) #12423d}.mark::before{content:"#ffffff"}</style>',
  '<div style="display:none;color:rgba(0,0,0,0)">The quiet web.</div>',
  '<table role="presentation" width="100%" bgcolor="f4efe6"><tr><td>',
  '<table width="600"><tr><td style="color:#6B716F">Issue 212 <a href="https://lumen.example/web" style="color:inherit">View in browser</a></td></tr>',
  '<tr><td style="background:url(cid:red) #12423d no-repeat;color:WHITE">LUMEN</td></tr>',
  `<tr><td style="background-image:image-set('red.png' 1x)">Spring</td></tr>`,
  '<tr><td class="essay"><font color="#c8552b">THIS WEEK</font>',
  '<h1 style="color:#1d2b29">The quiet web</h1>',
  '<p style="color:rgb(47, 58, 56)">On slow mornings I read small sites.</p>',
  '<p><a class="button" href="https://lumen.example/essay" style="border:1px solid hsl(173, 57%, 17%)">Read the essay</a></p></td></tr>',
  '<tr><td class="story" style="border-top:1px solid #e2dacb;background-color:transparent">Seed swaps are back. <span style="color:var(--accent, #c8552b)">Read</span></td></tr>',
  '</table></td></tr></table>',
  '<p style="color:#6b716f">You get Lumen Weekly because you signed up. <a href="https://lumen.example/unsubscribe">Unsubscribe</a>',
  ' <span style="color:rgba(0,0,0,.35)">Lumen Media, Bristol</span></p>',
  '</body>',
].join('')

/** A person's mail, as Outlook writes it: inline colors, a data table, a link and a signature. */
const HANA_HTML = [
  '<div style="font:14.5px/21px Arial,sans-serif;color:#222">',
  '<p>Hi Robin,</p><p>The cover lock moved to <b>Thursday at noon</b>.</p>',
  '<table style="border-collapse:collapse"><tr><th style="border:1px solid #c8c8c8;background:#f2f2f2">Step</th>',
  '<th style="border:1px solid #c8c8c8;background:#f2f2f2">Date</th></tr>',
  '<tr><td style="border:1px solid #c8c8c8">Cover file locked</td><td style="border:1px solid #c8c8c8">Thu, noon</td></tr></table>',
  `<p>The quote is on <a href="https://printer.example/portal" style="color:#0563C1">the printer's portal</a>.</p>`,
  '<div style="color:#555"><b style="color:#222">Hana Sato</b><br><span style="color:#888">For the named recipients only.</span></div>',
  '</div>',
].join('')

const ANA = { name: 'Ana', address: 'ana@example.com' }

/** A person's mail that is designed all the same, each for one reason, so it keeps its own type. */
const DESIGNED = [
  ['Nested', '<table><tr><td><table><tr><td>Agenda</td></tr></table></td></tr></table>'],
  ['Presented', '<table role="presentation"><tr><td>Lunch?</td></tr></table>'],
  ['Gradient', '<div style="background:linear-gradient(white, #eee)">Card</div>'],
  ['Hues', '<p style="color:#c00">Red</p><p style="color:#080">Green</p><p style="color:#00c">Blue</p>'],
] as const

/** The rules the core writes for the color attributes, at the start of the html. */
const ATTRIBUTE_RULES = [
  '<style>',
  ':where([data-letterbox-bg="0"]){background-color:var(--letterbox-color-0, #f4efe6)}',
  ':where([data-letterbox-text="1"]){color:var(--letterbox-color-1, #2f3a38)}',
  ':where([data-letterbox-link="2"] :link){color:var(--letterbox-color-2, #c8552b)}',
  ':where([data-letterbox-text="2"]){color:var(--letterbox-color-2, #c8552b)}',
  '</style>',
].join('')

/** LUMEN_HTML as the core passes it on, part for part. */
const LUMEN_SHOWN = [
  ATTRIBUTE_RULES,
  '<body bgcolor="#F4EFE6" text="#2f3a38" link="#c8552b" data-letterbox-bg="0" data-letterbox-text="1" data-letterbox-link="2">',
  '<style>:root{--sender-letterbox-color-0:#ff0000}.essay a:hover{color:var(--letterbox-color-3, #a84520)}',
  '.button{background:var(--letterbox-color-4, #12423d);color:var(--letterbox-color-5, #f4efe6)}@media (max-width:600px){.story{border-top:1px solid var(--letterbox-color-6, #e2dacb)}}',
  '.hero{background:var(--letterbox-image-0, none) var(--letterbox-color-4, #12423d)}.mark::before{content:"#ffffff"}</style>',
  '<div style="display:none;color:rgba(0,0,0,0)">The quiet web.</div>',
  '<table role="presentation" width="100%" bgcolor="f4efe6" data-letterbox-bg="0"><tr><td>',
  '<table width="600"><tr><td style="color:var(--letterbox-color-7, #6B716F)">Issue 212 <a href="https://lumen.example/web" style="color:inherit">View in browser</a></td></tr>',
  '<tr><td style="background:url(cid:red) var(--letterbox-color-4, #12423d) no-repeat;color:var(--letterbox-color-8, WHITE)">LUMEN</td></tr>',
  `<tr><td style="background-image:image-set('red.png' 1x)">Spring</td></tr>`,
  '<tr><td class="essay"><font color="#c8552b" data-letterbox-text="2">THIS WEEK</font>',
  '<h1 style="color:var(--letterbox-color-9, #1d2b29)">The quiet web</h1>',
  '<p style="color:var(--letterbox-color-1, rgb(47, 58, 56))">On slow mornings I read small sites.</p>',
  '<p><a class="button" href="https://lumen.example/essay" style="border:1px solid var(--letterbox-color-10, hsl(173, 57%, 17%))">Read the essay</a></p></td></tr>',
  '<tr><td class="story" style="border-top:1px solid var(--letterbox-color-6, #e2dacb);background-color:transparent">Seed swaps are back. <span style="color:var(--accent, var(--letterbox-color-2, #c8552b))">Read</span></td></tr>',
  '</table></td></tr></table>',
  '<p style="color:var(--letterbox-color-7, #6b716f)">You get Lumen Weekly because you signed up. <a href="https://lumen.example/unsubscribe">Unsubscribe</a>',
  ' <span style="color:var(--letterbox-color-11, rgba(0,0,0,.35))">Lumen Media, Bristol</span></p>',
  '</body>',
].join('')

/**
 * LUMEN_HTML's palette: each color once per role, whatever its spelling, in the order the html
 * first sets it. The page goes to the reader, text and the brand's accent lighten with their hue
 * kept, the button's teal lifts a step, and light text on it stays.
 */
const LUMEN_PALETTE = [
  ['background', '#f4efe6', '#1f1b15'],
  ['text', '#2f3a38', '#cfddda'],
  ['text', '#c8552b', '#f17a51'],
  ['text', '#a84520', '#ff936e'],
  ['background', '#12423d', '#285651'],
  ['text', '#f4efe6', '#f4efe6'],
  ['border', '#e2dacb', '#342e22'],
  ['text', '#6b716f', '#a9b0ad'],
  ['text', '#ffffff', '#ffffff'],
  ['text', '#1d2b29', '#d5e7e4'],
  ['border', '#13443e', '#7caca4'],
  ['text', '#00000059', '#ffffff74'],
]

/** HANA_HTML as the core passes it on. */
const HANA_SHOWN = [
  '<div style="font:14.5px/21px Arial,sans-serif;color:var(--letterbox-color-0, #222)">',
  '<p>Hi Robin,</p><p>The cover lock moved to <b>Thursday at noon</b>.</p>',
  '<table style="border-collapse:collapse"><tr><th style="border:1px solid var(--letterbox-color-1, #c8c8c8);background:var(--letterbox-color-2, #f2f2f2)">Step</th>',
  '<th style="border:1px solid var(--letterbox-color-1, #c8c8c8);background:var(--letterbox-color-2, #f2f2f2)">Date</th></tr>',
  '<tr><td style="border:1px solid var(--letterbox-color-1, #c8c8c8)">Cover file locked</td><td style="border:1px solid var(--letterbox-color-1, #c8c8c8)">Thu, noon</td></tr></table>',
  `<p>The quote is on <a href="https://printer.example/portal" style="color:var(--letterbox-color-3, #0563C1)">the printer's portal</a>.</p>`,
  '<div style="color:var(--letterbox-color-4, #555)"><b style="color:var(--letterbox-color-0, #222)">Hana Sato</b><br><span style="color:var(--letterbox-color-5, #888)">For the named recipients only.</span></div>',
  '</div>',
].join('')

/** HANA_HTML's palette: #222 text reads near the reader's own text, and the link keeps its blue. */
const HANA_PALETTE = [
  ['text', '#222222', '#e5e5e5'],
  ['border', '#c8c8c8', '#3a3a3a'],
  ['background', '#f2f2f2', '#1c1c1c'],
  ['text', '#0563c1', '#84baff'],
  ['text', '#555555', '#c4c4c4'],
  ['text', '#888888', '#979797'],
]

const mail = (
  key: string,
  from: SeedMessage['from'],
  subject: string,
  html: string,
  sentAt: string,
  more: Partial<SeedMessage> = {},
): SeedMessage => ({ key, mailboxes: ['inbox'], from, to: [ME], subject, text: `${subject}.`, html, sentAt, ...more })

/** A newsletter's headers. */
const LIST = { headers: { listUnsubscribe: true } }

const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    // The same sender with its address in capitals: a choice for one is a choice for both.
    mail(
      'earlier',
      { ...LUMEN, address: 'News@Lumen.example' },
      'Issue 211',
      '<p style="color:#2f3a38">Last week.</p>',
      '2025-12-01T09:00:00.000Z',
      LIST,
    ),
    mail('lumen', LUMEN, 'Issue 212', LUMEN_HTML, '2025-12-08T09:00:00.000Z', LIST),
    mail('hana', HANA, 'Print schedule', HANA_HTML, '2025-12-08T10:00:00.000Z'),
    // Plain HTML from a machine is still branded: only a person's takes the reader's type.
    mail(
      'receipt',
      { name: 'Shop', address: 'no-reply@shop.example' },
      'Your order shipped',
      '<p>Your order shipped.</p>',
      '2025-12-08T11:00:00.000Z',
    ),
    ...DESIGNED.map(([subject, html], index) => mail(subject, ANA, subject, html, `2025-12-09T0${index}:00:00.000Z`)),
  ],
})

type Ready = Extract<Body, { state: 'ready' }>

/** The first message of an open conversation, whose body must be ready with HTML. */
function opened(open: Subscription<'thread'>): { message: Message; body: Ready; colors: Colors } {
  const message = open.latest()?.messages[0]
  if (message?.body.state !== 'ready' || message.body.colors === null)
    throw new Error(`no colored html: ${JSON.stringify(message?.body)}`)
  return { message, body: message.body, colors: message.body.colors }
}

/** WCAG's relative luminance of a `#rrggbb` or `#rrggbbaa` color laid over the reader (#1b1b1e). */
function luminance(hex: string): number {
  const [r, g, b, a = 255] = (hex.slice(1).match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))
  const reader = [0x1b, 0x1b, 0x1e]
  const channel = (value: number, under: number) => {
    const mixed = ((value * a) / 255 + (under * (255 - a)) / 255) / 255
    return mixed <= 0.04045 ? mixed / 12.92 : ((mixed + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [r, g, b].map((value, index) => channel(value ?? 0, reader[index] ?? 0))
  return 0.2126 * (lr ?? 0) + 0.7152 * (lg ?? 0) + 0.0722 * (lb ?? 0)
}

const contrast = (one: string, other: string) => {
  const [high, low] = [luminance(one), luminance(other)].toSorted((x, y) => y - x)
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05)
}

/**
 * The swatches that miss the floor: text under 4.5:1 on the reader, or a background under which
 * the reader's text (#e4e4e4) falls under 4.5:1. Borders have none.
 */
const underFloor = (colors: Colors) =>
  colors.palette.filter(
    ({ role, dark }) =>
      (role === 'text' && contrast(dark, '#1b1b1e') < 4.5) ||
      (role === 'background' && contrast('#e4e4e4', dark) < 4.5),
  )

/** Sends one command, which must be accepted and settle done. */
async function done(t: Scenario, core: CoreClient, command: Command, what: string) {
  const answer = await core.command(command)
  t.equal(answer.kind, 'accepted', `${what}: accepted`)
  if (answer.kind !== 'accepted') return
  t.equal((await core.settled(answer.change)).result, 'done', `${what}: settles at once`)
}

const choose = (message: Message, scheme: ColorScheme): Command => ({
  kind: 'set-colors',
  messageId: message.id,
  scheme,
})

/** Each open conversation's scheme, in order. */
const schemes = (opens: Subscription<'thread'>[]) => opens.map((open) => opened(open).colors.scheme)

scenario('html colors are named with a readable dark value, and each sender keeps its choice of scheme', async (t) => {
  const { core, box } = await start(t, seed())
  const lumen = await openThread(core, (await thread(core, 'Issue 212')).id)
  const hana = await openThread(core, (await thread(core, 'Print schedule')).id)
  const earlier = await openThread(core, (await thread(core, 'Issue 211')).id)
  const receipt = await openThread(core, (await thread(core, 'Your order shipped')).id)
  const all = [lumen, hana, earlier, receipt]

  const swatches = (open: Subscription<'thread'>) =>
    opened(open).colors.palette.map(({ role, original, dark }) => [role, original, dark])
  t.equal(
    [opened(lumen).body.html, swatches(lumen)],
    [LUMEN_SHOWN, LUMEN_PALETTE],
    "each color the newsletter sets is named, in its attributes, its style block and inline, and the sender's own names are renamed",
  )
  t.equal(
    [opened(hana).body.html, swatches(hana)],
    [HANA_SHOWN, HANA_PALETTE],
    "each color of the person's mail is named",
  )
  t.equal(
    [opened(earlier).body.html, swatches(earlier)],
    ['<p style="color:var(--letterbox-color-0, #2f3a38)">Last week.</p>', [['text', '#2f3a38', '#cfddda']]],
    'the same color has the same dark value in every message',
  )
  t.equal(
    all.map((open) => underFloor(opened(open).colors)),
    [[], [], [], []],
    'every dark value keeps the contrast floor',
  )
  t.equal(
    all.map((open) => opened(open).colors.look),
    ['branded', 'simple', 'branded', 'branded'],
    "the newsletter is branded, the person's plain html simple, and a machine's plain html branded",
  )
  t.equal(schemes(all), ['dark', 'dark', 'dark', 'dark'], 'every sender starts dark')
  const designed = []
  for (const [subject] of DESIGNED) {
    const open = await openThread(core, (await thread(core, subject)).id)
    designed.push([subject, opened(open).colors.look])
    open.close()
  }
  t.equal(
    designed,
    DESIGNED.map(([subject]) => [subject, 'branded']),
    "a person's html with a nested table, a presentation table, a gradient or three hues is branded",
  )

  await done(t, core, choose(opened(lumen).message, 'original'), 'show one newsletter in its own colors')
  t.equal(
    schemes(all),
    ['original', 'dark', 'original', 'dark'],
    "the choice reaches the sender's other mail, whatever the case of its address",
  )

  box.deliver(
    mail('later', LUMEN, 'Issue 213', '<p style="color:#2f3a38">Next week.</p>', '2025-12-15T09:00:00.000Z', LIST),
  )
  await sync(core)
  const later = await openThread(core, (await thread(core, 'Issue 213')).id)
  t.equal(opened(later).colors.scheme, 'original', "the sender's new mail arrives in its own colors")

  await core.stop()
  const again = t.startCore()
  await again.hello()
  const reopened = await Promise.all(
    ['Issue 212', 'Print schedule', 'Issue 213'].map(async (subject) =>
      openThread(again, (await thread(again, subject)).id),
    ),
  )
  t.equal(schemes(reopened), ['original', 'dark', 'original'], 'after a restart each sender keeps its choice')

  const [first] = reopened
  if (first) await done(t, again, choose(opened(first).message, 'dark'), 'back to dark')
  t.equal(schemes(reopened), ['dark', 'dark', 'dark'], 'dark again, for all its mail')

  const unknown = await again.command({
    kind: 'set-colors',
    messageId: 'message_404' as Message['id'],
    scheme: 'original',
  })
  t.equal(
    unknown.kind === 'rejected' ? unknown.reason : unknown.kind,
    'unknown-target',
    'a message that is not there is refused',
  )
})

scenario("every dev seed's html still passes the check on the core's output, with readable dark values", async (t) => {
  const messages = new Map<string, SeedMessage>()
  for (const dev of Object.values(devSeeds))
    for (const message of dev.seed.messages) if (message.html !== undefined) messages.set(message.key, message)
  const { core } = await start(t, {
    address: ME,
    password: PASSWORD,
    mailboxes: seed().mailboxes,
    messages: [...messages.values()],
  })
  const found = []
  for (const message of messages.values()) {
    const open = await openThread(core, (await thread(core, message.subject)).id)
    const body = open.latest()?.messages[0]?.body
    const ready = body?.state === 'ready' ? body : null
    found.push([
      message.key,
      ready?.htmlWithheld,
      ready?.colors === null ? null : underFloor(ready?.colors ?? { scheme: 'dark', look: 'simple', palette: [] }),
    ])
    open.close()
  }
  t.equal(
    found,
    [
      ['withheld-newsletter', true, null],
      ['html-newsletter', false, []],
    ],
    'only the html meant to be withheld is, and every palette keeps the floor',
  )
})
