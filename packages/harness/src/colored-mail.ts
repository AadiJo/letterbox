// Mail for the colour pass's scenarios (27-body-colors*.ts): a branded newsletter, a person's
// plain HTML, HTML that is designed for one reason each, invalid color values, and colors set
// beside their backgrounds. The scenarios check what the core makes of each.

import type { SeedMessage } from '@letterbox/sim-provider/contract'
import { ME } from './fixtures.ts'

export const LUMEN = { name: 'Lumen Weekly', address: 'news@lumen.example' }
export const HANA = { name: 'Hana Sato', address: 'hana@inkwell.example' }

/**
 * A branded newsletter, built as such mail is: a layout table inside a table, colors in
 * attributes (`<body>`'s, a `bgcolor` with no `#`, a `<font>`), in a `<style>` block (behind a
 * selector with a colon, inside `@media`, beside a remote image) and inline, written as hex,
 * `rgb()`, `hsl()` and names in any case, and a faint footer whose dark value needs more alpha
 * to read. It also tries what the pass must leave: a custom property named like the core's own,
 * color names in a string, a `url()` and an `image-set()`, `inherit`, `transparent`, and hidden
 * text with no alpha.
 */
export const LUMEN_HTML = [
  '<body bgcolor="#F4EFE6" text="#2f3a38" link="#c8552b" vlink="#6b716f" alink="#a84520">',
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
export const HANA_HTML = [
  '<div style="font:14.5px/21px Arial,sans-serif;color:#222">',
  '<p>Hi Robin,</p><p>The cover lock moved to <b>Thursday at noon</b>.</p>',
  '<table style="border-collapse:collapse"><tr><th style="border:1px solid #c8c8c8;background:#f2f2f2">Step</th>',
  '<th style="border:1px solid #c8c8c8;background:#f2f2f2">Date</th></tr>',
  '<tr><td style="border:1px solid #c8c8c8">Cover file locked</td><td style="border:1px solid #c8c8c8">Thu, noon</td></tr></table>',
  `<p>The quote is on <a href="https://printer.example/portal" style="color:#0563C1">the printer's portal</a>.</p>`,
  '<div style="color:#555"><b style="color:#222">Hana Sato</b><br><span style="color:#888">For the named recipients only.</span></div>',
  '</div>',
].join('')

export const ANA = { name: 'Ana', address: 'ana@example.com' }

/** A person's mail that is designed all the same, each for one reason, so it keeps its own type. */
export const DESIGNED = [
  ['Nested', '<table><tr><td><table><tr><td>Agenda</td></tr></table></td></tr></table>'],
  ['Presented', '<table role="presentation"><tr><td>Lunch?</td></tr></table>'],
  ['Gradient', '<div style="background:linear-gradient(white, #eee)">Card</div>'],
  ['Hues', '<p style="color:#c00">Red</p><p style="color:#080">Green</p><p style="color:#00c">Blue</p>'],
] as const

/**
 * Invalid color values a browser drops, beside valid ones. The core wraps only what a browser
 * keeps, so a dropped declaration still leaves the one before it in effect, in either scheme.
 */
export const INVALID_HTML = [
  '<p class="kept" style="color:#0563c1;color:rgb(0 0 0 .35)">Blue</p>',
  '<p style="color:red blue">Dropped</p>',
  '<p style="color:hsl(120, 50, 50)">Legacy hsl without percents</p>',
  '<p style="color:rgb(100%, 0, 0)">Mixed legacy rgb</p>',
  '<p style="color:rgba(0, 0, 0, .5) !important">Comma alpha</p>',
  '<p style="color:hsl(120deg 50% 50% / 50%)">Space hsl</p>',
  // A no-break space is not CSS whitespace, and a var() in a comment calls nothing.
  '<p class="kept" style="color:#0563c1;color:rgb(255\u00a0,0,0)">Blue past a no-break space</p>',
  '<p class="kept" style="color:#0563c1;color:red blue /* var(--accent) */">Blue past a commented var</p>',
  // A later shorthand a browser drops: two repeats, or two border styles.
  '<p class="shorthand" style="background:#000038;background:red no-repeat repeat-x">Navy past a bad shorthand</p>',
  '<p style="border:1px solid #cc0000;border:2px solid solid #0000cc">Red border past two styles</p>',
].join('')

/**
 * Color attributes where a browser ignores them and where it honours them, a sender rule in a
 * cascade layer over a bgcolor, and text set beside its own background, which is read on it.
 */
export const PAIRS_HTML = [
  '<style>@layer sender{td.layered{background-color:#00ff00}}.badge{background:#1a1a5e;color:#707070}</style>',
  '<div bgcolor="#ff0000">Ignored</div>',
  '<table bgcolor="#ffffff"><tr><td bgcolor="#000038" style="color:#888888">On navy</td>',
  '<td class="layered" bgcolor="#ff0000">Layered</td></tr></table>',
  '<p style="background:#fff3c4;color:#8a6d00">A note</p>',
  '<p><span class="badge">New</span></p>',
  // The background a browser paints: the important navy over a later white, and the navy past a
  // later background-color it drops.
  '<table><tr><td style="background-color:#000038!important;background:#fff;color:#888888">Important navy</td>',
  '<td style="background:#000038;background-color:red blue;color:#808080">Navy past a dropped one</td></tr></table>',
].join('')

/** One message from `from`, its text its subject. */
export const mail = (
  key: string,
  from: SeedMessage['from'],
  subject: string,
  html: string,
  sentAt: string,
  more: Partial<SeedMessage> = {},
): SeedMessage => ({ key, mailboxes: ['inbox'], from, to: [ME], subject, text: `${subject}.`, html, sentAt, ...more })

/** A newsletter's headers. */
export const LIST = { headers: { listUnsubscribe: true } }
