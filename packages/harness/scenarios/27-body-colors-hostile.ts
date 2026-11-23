// The colour pass on hostile CSS (crates/core/src/body/css.rs): a sheet nested far deeper than
// it reads, and a declaration with a megabyte of comments. Each must process without running the
// core out of stack or time, and stay as written past what the pass reads.

import type { Body } from '@letterbox/protocol'
import { ANA, mail } from '../src/colored-mail.ts'
import { ME, openThread, PASSWORD, start, thread } from '../src/fixtures.ts'
import { scenario } from '../src/scenario.ts'

type Ready = Extract<Body, { state: 'ready' }>

/** A body's html with its own custom property prefix written `<prefix>`, as the expected html writes it. */
const html = (ready: Ready) => ready.html?.replaceAll(ready.cssPrefix, '<prefix>')

/** How deep the hostile sheets below nest, and the comment run, 1 MB of `/**\/`. */
const DEEP = 100_000
const COMMENTS = '/**/'.repeat(262_144)

scenario(
  'a sheet nested 100,000 blocks deep, and a declaration with a megabyte of comments, process and stay as written',
  async (t) => {
    const sheets = [
      `<style>${'@media all{'.repeat(DEEP)}p{color:#ff0000}${'}'.repeat(DEEP)}</style>`,
      `<style>${'.a{'.repeat(DEEP)}color:#ff0000${'}'.repeat(DEEP)}</style>`,
    ].join('')
    const sent = `${sheets}<p style="color:#0563c1;color:red${COMMENTS} blue">Blue</p>`
    const { core } = await start(t, {
      address: ME,
      password: PASSWORD,
      mailboxes: [{ key: 'inbox', name: 'Inbox', role: 'inbox' }],
      messages: [mail('deep', ANA, 'Deep', sent, '2025-12-10T09:00:00.000Z')],
    })
    const open = await openThread(core, (await thread(core, 'Deep')).id)
    const body = open.latest()?.messages[0]?.body
    if (body?.state !== 'ready' || body.colors === null) throw new Error(`the body is not ready html: ${body?.state}`)
    const { colors } = body
    const expected = `${sheets}<p style="color:var(<prefix>color-0, #0563c1);color:red${COMMENTS} blue">Blue</p>`
    // Compared as a yes or no, so a failure does not print megabytes.
    t.equal(
      [html(body) === expected, body.htmlWithheld, colors.palette.map(({ role, original }) => [role, original])],
      [true, false, [['text', '#0563c1']]],
      'the core reads 8 blocks deep and leaves the rest as written, reads past the comments once, and names only the blue before them',
    )
  },
  ['folders'],
)
