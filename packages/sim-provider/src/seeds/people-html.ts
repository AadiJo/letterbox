// The HTML mail in `people-first` (people-first.ts): a newsletter that tries what hostile mail
// tries, a branded issue whose images the dev host's fake web serves, Harbour Lane's statements,
// which try what hostile mail tries on the reader's frame, a list reply quoted 10,000 levels
// deep, and HTML the core withholds. Every name, address and company here is made up.

import type { SeedMessage } from '../contract.ts'
import type { SeedImage } from '../seeds.ts'
import { ago, DAY, HARBOUR_LANE_LOGO, HOUR, ME } from './people-mail.ts'

/**
 * An HTML newsletter that tries what hostile mail tries: a script, an inline handler, two
 * trackers (a pixel and a known tracking host), a remote stylesheet, DNS-prefetch and preconnect hints (one in a noscript, one
 * in an iframe's srcdoc), a remote font and a link to a remote page. The `probe` paragraph keeps its
 * text only if none of it ran, and the dev host's UI check reads it. A preconnect also hides in text
 * around a deleted element, which must never join into a tag. The core takes the pixel out, blocks the
 * cover image until the user shows images, and reads the one-click unsubscribe from its headers.
 */
const htmlNewsletter: SeedMessage = {
  key: 'html-newsletter',
  mailboxes: ['inbox'],
  from: { name: 'The Long Read', address: 'newsletter@longread.example' },
  to: [ME],
  subject: 'Five essays for the weekend',
  text: 'Five essays for the weekend. Read them in your browser.',
  html: [
    '<link rel="stylesheet" href="https://styles.longread.example/mail.css">',
    '<link rel="dns-prefetch" href="//prefetch.longread.example"><link rel="preconnect" href="https://connect.longread.example">',
    '<noscript><link rel="preconnect" href="https://noscript.longread.example"></noscript>',
    '<iframe srcdoc="&lt;link rel=preconnect href=https://srcdoc.longread.example&gt;"></iframe>',
    '<<iframe></iframe>link rel=dns-prefetch href=//joined.longread.example>',
    '<style>@font-face{font-family:Remote;src:url(https://fonts.longread.example/serif.woff2)}h1{font-family:Remote,Georgia,serif}</style>',
    '<h1>Five essays for the weekend</h1>',
    '<img src="https://images.longread.example/cover.jpg" width="560" height="280" alt="This week\'s cover">',
    '<p id="probe">Nothing in this message ran.</p>',
    '<p>On slow mornings, small gardens and the quiet web.</p>',
    '<p><a id="out" href="https://read.longread.example/essays">Read in your browser</a></p>',
    '<p><a href="https://longread.example/unsubscribe?u=1">Unsubscribe</a></p>',
    '<img src="https://pixel.longread.example/open.gif" width="1" height="1" alt="">',
    '<img src="https://ct.sendgrid.net/wf/open?upn=lr5" alt="">',
    '<img src="missing.png" alt="" onerror="document.getElementById(\'probe\').textContent=\'A handler ran.\'">',
    "<script>document.getElementById('probe').textContent='A script ran.';top.postMessage('script ran','*')</script>",
  ].join(''),
  sentAt: ago(40 * 60_000),
  unread: true,
  headers: {
    listUnsubscribe: '<mailto:leave@longread.example>, <https://longread.example/unsubscribe?u=1>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
    listId: true,
    precedence: 'bulk',
  },
  bulk: true,
}

/** Where the issue's images live. The dev host's fake web serves each one (`images` below). */
const ISSUE = 'https://images.longread.example/issue-212'

/** The paper texture Harbour Lane's statements draw, as CSS and as a `background` attribute. */
const PAPER = 'https://brand.harbourlane.example/paper.png'

/**
 * The Long Read's newest issue: branded HTML whose images are all remote, as a real newsletter's
 * are. A masthead (PNG), a hero (JPEG), a CSS background under the masthead, two thumbnails (one
 * with no alt text), and an open tracker the core takes out and never fetches.
 */
const issueNewsletter: SeedMessage = {
  key: 'html-issue',
  mailboxes: ['inbox'],
  from: { name: 'The Long Read', address: 'newsletter@longread.example' },
  to: [ME],
  subject: 'Issue 212: the quiet web',
  text: 'The quiet web, by Ada Morrow. On slow mornings I read small sites. Read the essay: https://read.longread.example/essays/quiet-web',
  html: [
    '<div style="background:#f4efe6;padding:0 20px"><div style="max-width:600px;margin:0 auto">',
    '<table width="100%" style="padding:14px 0 12px;font:400 11.5px/16px Arial,Helvetica,sans-serif;color:#6b716f"><tr>',
    '<td>Issue 212 · Sunday, March 8</td>',
    '<td align="right"><a href="https://longread.example/issues/212" style="color:#6b716f">View in browser</a></td>',
    '</tr></table>',
    `<img src="${ISSUE}/masthead.png" width="600" height="76" alt="The Long Read" style="display:block;width:100%;height:auto">`,
    `<div style="height:8px;background-image:url(${ISSUE}/rule.png);background-size:8px 4px"></div>`,
    `<img src="${ISSUE}/hillside.jpg" width="600" height="260" alt="A hillside village at dusk" style="display:block;width:100%;height:auto">`,
    '<div style="padding:24px 0 0;font-family:Arial,Helvetica,sans-serif">',
    '<div style="font-weight:600;font-size:12px;letter-spacing:.14em;color:#c8552b">THIS WEEK’S ESSAY</div>',
    '<h1 style="margin:8px 0 0;font:400 32px/38px Georgia,serif;color:#1d2b29">The quiet web</h1>',
    '<div style="margin-top:6px;font-size:13px;color:#6b716f">By Ada Morrow · 6 min read</div>',
    '<p style="margin:14px 0 0;font-size:16px;line-height:26px;color:#2f3a38">On slow mornings I read small sites: a gardener in Porto who posts one photo a week, a man who reviews every bench in his town. None of them ask for my email. This week, a few notes on the web that asks nothing of you, and why it still feels like the best of it.</p>',
    '<p style="margin:18px 0 0"><a href="https://read.longread.example/essays/quiet-web" style="display:inline-block;border-radius:5px;background:#12423d;padding:11px 18px;font-weight:600;font-size:14px;color:#f4efe6;text-decoration:none">Read the essay</a></p>',
    '<div style="margin-top:28px;padding-bottom:4px;font-weight:600;font-size:12px;letter-spacing:.14em;color:#c8552b">ALSO THIS WEEK</div>',
    '<table width="100%" style="border-top:1px solid #e2dacb"><tr>',
    `<td width="112" style="padding:16px 18px 16px 0;vertical-align:top"><img src="${ISSUE}/seeds.jpg" width="112" height="84" alt=""></td>`,
    '<td style="padding:16px 0;vertical-align:top"><div style="font:400 18px/24px Georgia,serif;color:#1d2b29">Seed swaps are back</div>',
    '<div style="margin-top:4px;font-size:14px;line-height:21px;color:#6b716f">Three libraries now lend seeds as well as books. How the one in Leith started.</div></td>',
    '</tr></table>',
    '<table width="100%" style="border-top:1px solid #e2dacb"><tr>',
    `<td width="112" style="padding:16px 18px 16px 0;vertical-align:top"><img src="${ISSUE}/boat.jpg" width="112" height="84" alt="A small boat at sea"></td>`,
    '<td style="padding:16px 0;vertical-align:top"><div style="font:400 18px/24px Georgia,serif;color:#1d2b29">A week without a map</div>',
    '<div style="margin-top:4px;font-size:14px;line-height:21px;color:#6b716f">We sailed the west coast with paper charts only. What we got wrong, mostly.</div></td>',
    '</tr></table>',
    '<div style="margin-top:12px;border-top:1px solid #e2dacb;padding:18px 0 14px;font-size:12px;line-height:18px;color:#6b716f;text-align:center">',
    'You get The Long Read because you signed up at longread.example.<br>',
    '<a href="https://longread.example/unsubscribe?u=1" style="color:#6b716f">Unsubscribe</a></div>',
    '</div></div>',
    '<img src="https://list-manage.com/track/open.php?u=212&amp;id=4f2" width="1" height="1" alt="">',
  ].join(''),
  sentAt: ago(35 * 60_000),
  unread: true,
  headers: {
    listUnsubscribe: '<https://longread.example/unsubscribe?u=1>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
    listId: true,
    precedence: 'bulk',
  },
  bulk: true,
}

/**
 * The images the dev host's fake web serves, real PNG and JPEG bytes from ./images: the issue's,
 * and Ines's logo. The older newsletter's cover is left out, so showing it fails.
 */
export const IMAGES: readonly SeedImage[] = [
  { url: `${ISSUE}/masthead.png`, mime: 'image/png', file: 'masthead.png' },
  { url: `${ISSUE}/rule.png`, mime: 'image/png', file: 'rule.png' },
  { url: `${ISSUE}/hillside.jpg`, mime: 'image/jpeg', file: 'hillside.jpg' },
  { url: `${ISSUE}/seeds.jpg`, mime: 'image/jpeg', file: 'seeds.jpg' },
  { url: `${ISSUE}/boat.jpg`, mime: 'image/jpeg', file: 'boat.jpg' },
  { url: HARBOUR_LANE_LOGO, mime: 'image/png', file: 'harbour-lane.png' },
  { url: PAPER, mime: 'image/png', file: 'rule.png' },
]

/** Harbour Lane's statements: automated mail, one conversation of two. */
const HARBOUR = { name: 'Harbour Lane Accounts', address: 'statements@harbourlane.example' }
const STATEMENT = 'Your Harbour Lane statement'
const STATEMENT_MARKS = {
  headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' },
  bulk: true,
} satisfies Pick<SeedMessage, 'headers' | 'bulk'>

/** January's statement, read: a logo, so the conversation holds two messages with images. */
const januaryStatement: SeedMessage = {
  key: 'html-statement-1',
  mailboxes: ['inbox'],
  from: HARBOUR,
  to: [ME],
  subject: STATEMENT,
  text: 'Your January statement is ready. The balance is €0.00.',
  html: `<p><img src="${HARBOUR_LANE_LOGO}" width="160" height="32" alt="Harbour Lane"></p><p>Your January statement is ready. The balance is €0.00.</p>`,
  sentAt: ago(9 * DAY),
  unread: false,
  ...STATEMENT_MARKS,
}

/**
 * February's statement, which quotes January's in Gmail's markup and tries what hostile mail
 * tries on the reader's frame:
 *   - forms named createElement, documentElement, querySelectorAll, createTreeWalker and body,
 *     which shadow the document's own, and inputs named setAttribute, getAttribute and
 *     removeAttribute in a form whose `background` is a remote image, which shadow the form's,
 *   - CSS that declares the names a shown CSS image would get without the core's random prefix,
 *     plainly and escaped, around the element that draws it, and reads them on two others,
 *   - body margins, which a frame measured by its body alone would cut off,
 *   - a link, a base, an iframe and a script in its new part, and a script and a link in its quote.
 */
const februaryStatement: SeedMessage = {
  key: 'html-statement-2',
  mailboxes: ['inbox'],
  from: HARBOUR,
  to: [ME],
  subject: STATEMENT,
  text: 'Your February statement is ready. The balance is €42.10, due on March 20.',
  html: [
    '<style>body{margin:28px 0}',
    '.claim{--letterbox-image-0:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=);--\\6c etterbox-image-0:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)}',
    `.paper{height:8px;background-image:url(${PAPER})}`,
    '.decoy-plain{height:8px;background-image:var(--letterbox-image-0)}',
    '.decoy-escaped{height:8px;background-image:var(--\\6c etterbox-image-0)}</style>',
    '<link rel="preconnect" href="https://cdn.harbourlane.example"><base href="https://evil.example/">',
    '<iframe src="https://frame.harbourlane.example/"></iframe>',
    "<script>document.title='a script ran'</script>",
    '<form name="createElement"></form><form name="documentElement"></form><form name="querySelectorAll"></form>',
    '<form name="createTreeWalker"></form><form name="body"></form>',
    `<p><img src="${HARBOUR_LANE_LOGO}" width="160" height="32" alt="Harbour Lane"></p>`,
    '<div class="claim"><div class="paper"></div></div><div class="decoy-plain"></div><div class="decoy-escaped"></div>',
    `<form background="${PAPER}"><input name="setAttribute"><input name="getAttribute"><input name="removeAttribute"></form>`,
    '<p>Your February statement is ready. The balance is €42.10, due on March 20.</p>',
    '<div class="gmail_quote"><div class="gmail_attr">On Sat, Feb 28, 2026, Harbour Lane Accounts &lt;statements@harbourlane.example&gt; wrote:<br></div>',
    '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">',
    "<script>document.title='a quoted script ran'</script>",
    '<link rel="stylesheet" href="https://cdn.harbourlane.example/quote.css">',
    '<p>Your January statement is ready. The balance is €0.00.</p></blockquote></div>',
  ].join(''),
  sentAt: ago(2 * HOUR),
  unread: true,
  replyTo: ['html-statement-1'],
  ...STATEMENT_MARKS,
}

/** A list reply that quotes 10,000 levels deep: an opened quote shows at most a few levels. */
const deepQuote: SeedMessage = {
  key: 'deep-quote',
  mailboxes: ['inbox'],
  from: { name: 'Tidepool List', address: 'list@tidepool.example' },
  to: [ME],
  subject: 'The long thread',
  text: `Agreed, ship it.\n\nOn Fri, Mar 6, 2026 at 9:00 AM, Tidepool List <list@tidepool.example> wrote:\n${'>'.repeat(10_000)} The first message in the thread.`,
  sentAt: ago(3 * HOUR),
  unread: false,
  ...STATEMENT_MARKS,
}

/**
 * HTML the core withholds, with no plain part: its one image is an SVG feImage, which the core's
 * rewrite does not placeholder, so the check on its output keeps the HTML from the reader. The
 * reader says so instead of showing nothing.
 */
const withheldNewsletter: SeedMessage = {
  key: 'withheld-newsletter',
  mailboxes: ['inbox'],
  from: { name: 'The Long Read', address: 'newsletter@longread.example' },
  to: [ME],
  subject: 'A layout we could not show',
  text: '',
  html: '<svg><filter><feImage href="https://images.longread.example/f.png"/></filter></svg><p>Hidden.</p>',
  sentAt: ago(41 * 60_000),
  unread: false,
  headers: { listUnsubscribe: true, listId: true, precedence: 'bulk' },
  bulk: true,
}

/** The HTML mail, in no order: the seed sorts its messages by when they were sent. */
export const HTML_MAIL: readonly SeedMessage[] = [
  htmlNewsletter,
  issueNewsletter,
  januaryStatement,
  februaryStatement,
  deepQuote,
  withheldNewsletter,
]
