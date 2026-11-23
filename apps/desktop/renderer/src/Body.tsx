// One message's body. Plain text shows as text. HTML is hostile input (protocol.Body), so it
// shows in a sandboxed iframe that cannot run script or reach the network.

import type { Body as MessageBody } from '@letterbox/protocol'
import { useState } from 'react'

/**
 * The iframe's own policy. It loads nothing from the network, in any state: images only from
 * `data:` and `cid:`, fonts only from `data:`, and inline styles. Shown remote images come from
 * the core, which fetches them (protocol `image` request). `base-uri 'none'` keeps a `<base>`
 * from moving where a relative URL points. The sandbox blocks script, forms, popups and meta
 * refresh. `allow-same-origin` without `allow-scripts` only lets this page read the frame's
 * height. Nothing in the frame can run.
 */
const POLICY = "default-src 'none'; img-src data: cid:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'"

/**
 * The document an HTML body renders in. The policy comes first, so nothing in the body loads
 * before it applies, and DNS prefetching is off, so no hostname in it is looked up ahead. Links default to a new window, which the sandbox refuses, so a click
 * leaves the frame on this document. A link that names its own target is stopped by the
 * app page's `frame-src 'none'` (index.html): the frame shows an error page, and nothing loads.
 */
const htmlDocument = (html: string) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><base target="_blank">` +
  // oxlint-disable-next-line letterbox/renderer-design-tokens -- the frame is its own light document, which the app's tokens never reach
  '<style>html{color-scheme:light}body{margin:0;padding:16px;font:15px/23px -apple-system,system-ui,sans-serif;color:#1d1d1f;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>' +
  html

const UNAVAILABLE = {
  offline: 'This message has not downloaded yet. It loads when you are back online.',
  'too-large': 'This message is too large to show here.',
  gone: 'This message is no longer on the server.',
} as const

export function Body({ body }: { body: MessageBody }) {
  if (body.state === 'loading') return <p className="text-row text-muted">Loading the message</p>
  if (body.state === 'unavailable') return <p className="text-row text-muted">{UNAVAILABLE[body.reason]}</p>
  if (body.html !== null) return <HtmlBody html={body.html} />
  return (
    <div data-field="body">
      {body.text
        .split(/\n\s*\n/)
        .filter((paragraph) => paragraph.trim() !== '')
        .map((paragraph, index) => (
          // Paragraphs have no identity beyond their place in a body that never changes.
          // Capped at 62 characters a line at 16/26, a calm measure. HTML bodies set their own widths.
          <p key={index} className="mb-4 max-w-[62ch] text-body whitespace-pre-wrap text-prose last:mb-0">
            {paragraph}
          </p>
        ))}
    </div>
  )
}

function HtmlBody({ html }: { html: string }) {
  const [height, setHeight] = useState(0)
  return (
    <iframe
      title="Message"
      data-field="body"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={htmlDocument(html)}
      onLoad={(event) => setHeight(event.currentTarget.contentDocument?.documentElement.scrollHeight ?? 0)}
      className="block w-full rounded-lg bg-paper"
      style={{ height }}
    />
  )
}
