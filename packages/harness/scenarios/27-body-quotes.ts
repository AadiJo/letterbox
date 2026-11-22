// Quoted history (crates/core/src/body/quote.rs). The core finds where the quote at the end of
// a body starts, in its text and in its html, as an offset a UI slices at to fold it. The
// body stays whole, replies written between quoted lines stay in view, and the html offset
// follows the html of the state its images are in.

import type { Seed, SeedMessage } from '@letterbox/sim-provider/contract'
import type { Body } from '@letterbox/protocol'
import { ME, openThread, openWithBody, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'
import type { CoreClient } from '../src/client.ts'

const ANA = { name: 'Ana', address: 'ana@example.com' }
const ATTRIBUTION = 'On Mon, Dec 1, 2025 at 9:00 AM Ana &lt;ana@example.com&gt; wrote:'

const reply = (key: string, subject: string, sentAt: string, text: string, html?: string): SeedMessage => ({
  key,
  mailboxes: ['inbox'],
  from: ANA,
  to: [ME],
  subject,
  text,
  ...(html !== undefined && { html }),
  sentAt,
})

const GMAIL_NEW = '<div dir="ltr">Thanks! <img src="https://cdn.example/smile.png" alt=":)"></div><br>'
const GMAIL_QUOTE = `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${ATTRIBUTION}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex">Are you free?</blockquote></div>`

/** One reply per rule, each in a conversation of its own. */
const seed = (): Seed => ({
  address: ME,
  password: PASSWORD,
  mailboxes: [
    { key: 'inbox', name: 'Inbox', role: 'inbox' },
    { key: 'sent', name: 'Sent', role: 'sent' },
  ],
  messages: [
    reply(
      'plain',
      'Plain reply',
      '2025-12-01T10:00:00.000Z',
      'Grüße 👋, see you at noon.\n\nOn Mon, Dec 1, 2025 at 9:00 AM Ana <ana@example.com>\nwrote:\n> Are you free?\n>\n> Lunch on Friday?\n',
    ),
    reply('inline', 'Inline reply', '2025-12-01T11:00:00.000Z', '> Are you free?\nYes.\n> Noon?\nNoon works.'),
    reply('forward', 'All quote', '2025-12-01T12:00:00.000Z', '> Forwarded words.\n> More of them.'),
    reply(
      'outlook-text',
      'Outlook text',
      '2025-12-01T13:00:00.000Z',
      'Done, thanks.\n\n-----Original Message-----\nFrom: Ana\nSent: Monday\n\nPlease file it.',
    ),
    reply('gmail', 'Gmail html', '2025-12-01T14:00:00.000Z', 'Thanks!', GMAIL_NEW + GMAIL_QUOTE),
    reply(
      'apple',
      'Apple html',
      '2025-12-01T15:00:00.000Z',
      'Yes, Friday.',
      '<div>Yes, Friday.</div><div><br><blockquote type="cite">On Dec 1, 2025, at 09:00, Ana &lt;ana@example.com&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div>Are you free?</div></blockquote>',
    ),
    reply(
      'outlook-html',
      'Outlook html',
      '2025-12-01T16:00:00.000Z',
      'Filed it.',
      '<div>Filed it.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Ana<br><b>Sent:</b> Monday</div><div>Please file it.</div>',
    ),
    reply(
      'interleaved',
      'Interleaved html',
      '2025-12-01T17:00:00.000Z',
      'Yes.',
      '<blockquote type="cite">Are you free?</blockquote><div>Yes.</div><blockquote type="cite">Noon?</blockquote><div>Noon works.</div>',
    ),
  ],
})

type Ready = Extract<Body, { state: 'ready' }>

/** The body of the first message in the conversation with this subject. */
async function bodyOf(core: CoreClient, subject: string): Promise<Ready> {
  const { body } = await openWithBody(core, (await thread(core, subject)).id)
  if (body.state !== 'ready') throw new Error('openWithBody returns a ready body')
  return body
}

/** The new part a UI shows folded, in text and in html, or null where nothing folds. */
const folded = (body: Ready) => ({
  text: body.quote.text === null ? null : body.text.slice(0, body.quote.text),
  html: body.quote.html === null || body.html === null ? null : body.html.slice(0, body.quote.html),
})

scenario('the quote at the end of a body is found in its text and its html, and the body stays whole', async (t) => {
  const { core } = await start(t, seed())

  const plain = await bodyOf(core, 'Plain reply')
  t.equal(
    folded(plain),
    { text: 'Grüße 👋, see you at noon.\n\n', html: null },
    'plain text folds at the attribution that wraps onto a second line, counted as JavaScript counts',
  )
  t.check(plain.text.endsWith('> Lunch on Friday?\n'), 'and the text itself is whole')
  t.equal(
    folded(await bodyOf(core, 'Inline reply')),
    { text: null, html: null },
    'replies between quoted lines do not fold',
  )
  t.equal(folded(await bodyOf(core, 'All quote')), { text: null, html: null }, 'a body that is all quote does not fold')
  t.equal(
    folded(await bodyOf(core, 'Outlook text')),
    { text: 'Done, thanks.\n\n', html: null },
    'plain text folds at an Outlook divider',
  )

  const gmail = await openThread(core, (await thread(core, 'Gmail html')).id)
  const blocked = gmail.latest()?.messages[0]
  if (blocked?.body.state !== 'ready') return t.check(false, 'the Gmail reply loads')
  t.equal(
    folded(blocked.body).html,
    '<div dir="ltr">Thanks! <img alt=":)" data-letterbox-image="0"></div><br>',
    'Gmail html folds at gmail_quote, here in the html with images blocked',
  )
  t.check(blocked.body.html?.endsWith(GMAIL_QUOTE) === true, 'and the html still holds the quote')
  const answer = await core.command({ kind: 'set-images', messageId: blocked.id, show: 'message' })
  if (answer.kind === 'accepted') await core.settled(answer.change)
  const shown = gmail.latest()?.messages[0]?.body
  t.equal(shown?.state === 'ready' && folded(shown).html, GMAIL_NEW, 'with images shown, the offset follows that html')

  t.equal(
    folded(await bodyOf(core, 'Apple html')).html,
    '<div>Yes, Friday.</div>',
    'Apple Mail html folds at its attribution',
  )
  t.equal(folded(await bodyOf(core, 'Outlook html')).html, '<div>Filed it.</div>', 'Outlook html folds at its divider')
  t.equal(
    folded(await bodyOf(core, 'Interleaved html')).html,
    null,
    'html with replies between its quotes does not fold',
  )
})
