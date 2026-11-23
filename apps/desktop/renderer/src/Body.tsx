// One message's body. Plain text shows as text. HTML is hostile input (protocol.Body), so it
// shows in a sandboxed iframe that cannot run script or reach the network. Remote images wait
// as one-line placeholders until the user shows them (ImagesChip.tsx), and then come from the
// core (images.ts). Quoted history at the end folds behind one line (pick B). Dark, the HTML is
// restyled for the reader with the core's palette, and a person's plain HTML takes the reader's
// type; Original, it shows the sender's own colors on a dimmed card (colors.ts, pick C).

import type { Colors, Body as MessageBody, Images, MessageId, Quote } from '@letterbox/protocol'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { applyScheme } from './colors.ts'
import { cx } from './cx.ts'
import { frameDom } from './frame-dom.ts'
import { bindImages, useImageUrls } from './images.ts'

/**
 * The iframe's own policy. It loads nothing from the network, in any state: images only from
 * `data:` and `cid:`, fonts only from `data:`, and inline styles. Shown remote images come from
 * the core, which fetches them (protocol `image` request). `base-uri 'none'` keeps a `<base>`
 * from moving where a relative URL points. The sandbox blocks script, forms, popups and meta
 * refresh. `allow-same-origin` without `allow-scripts` lets this page read the frame's height
 * and put shown images in. Nothing in the frame can run.
 */
const POLICY = "default-src 'none'; img-src data: cid:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'"

/** Lucide's image-off at 24 px, the mask a blocked image's placeholder draws in its text color. */
const IMAGE_OFF =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 2l20 20M10.41 10.41a2 2 0 1 1-2.83-2.83M13.5 13.5 6 21M18 12l3 3M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59M21 15V5a2 2 0 0 0-2-2H9'/%3E%3C/svg%3E"

/** The selector for the frame's root in a scheme, and in the dark scheme with a look (colors.ts `applyScheme`). */
const IN = {
  original: ':root[data-letterbox-scheme=original]',
  dark: ':root[data-letterbox-scheme=dark]',
  simple: ':root[data-letterbox-scheme=dark][data-letterbox-look=simple]',
  designed: ':root[data-letterbox-scheme=original][data-letterbox-look=branded]',
}

/**
 * The frame's own defaults for what the HTML leaves unset, in each scheme, in an anonymous cascade
 * layer declared before the HTML, as protocol `Colors` asks: every rule of the sender's, and the
 * core's color attribute rules, which come later, win over them. Original is the sender's light
 * page, its text a near black that a `<body text>` still overrides. Dark is the reader's page,
 * text and links (`--color-reader`, `--color-prose`, the mocks' link blue). Designed mail fills
 * its card to the edge in Original, as its page does. Its colors are raw: the frame is its own
 * document, which the app's tokens never reach.
 */
const DEFAULTS =
  '@layer{body{margin:0;font:15px/23px -apple-system,system-ui,sans-serif;overflow-wrap:anywhere}' +
  `${IN.original} body{padding:16px;color:#1d1d1f}${IN.designed} body{padding:0}` +
  `${IN.dark}{background:#1b1b1e}${IN.dark} body{padding:0;color:#e4e4e4}` +
  `${IN.dark} a:link,${IN.dark} a:visited{color:#7aa7f7}}`

/**
 * A blocked image's placeholder, one 30 px line with the image-off mark and the image's alt text,
 * or "Image" when it has none (protocol `Images`). It is the reader's own, so it is no layer's
 * and the sender's rules never reach it. On the dimmed card of Original its label is dark enough
 * to read at 4.5:1 once the card's filter has dimmed it.
 */
const PLACEHOLDER =
  'img{max-width:100%;height:auto}' +
  'span[data-letterbox-image]{display:inline-flex;box-sizing:border-box;max-width:100%;height:30px;align-items:center;gap:8px;overflow:hidden;border-radius:7px;padding:0 12px 0 10px;font:400 12.5px/18px -apple-system,system-ui,sans-serif;letter-spacing:normal;text-transform:none;white-space:nowrap;vertical-align:middle}' +
  `span[data-letterbox-image]::before{content:"";flex:none;width:14px;height:14px;background:currentColor;-webkit-mask:url("${IMAGE_OFF}") center/14px no-repeat;mask:url("${IMAGE_OFF}") center/14px no-repeat}` +
  'span[data-letterbox-image]:empty::after{content:"Image"}' +
  `${IN.original} span[data-letterbox-image]{background:#f1f1f2;box-shadow:inset 0 0 0 1px rgb(0 0 0 / 7%);color:#55555a}` +
  `${IN.dark} span[data-letterbox-image]{background:rgb(255 255 255 / 4%);box-shadow:inset 0 0 0 1px rgb(255 255 255 / 6%);color:#a3a3a3}`

/**
 * A person's plain HTML, dark (`HtmlLook` `simple`), in the reader's own type and colors: 16/26
 * prose at 62 characters, links in the reader's blue, tables at 14/20 with 12/16 heads and
 * hairlines, and a light plate under images, which the reset of backgrounds leaves, so a
 * transparent logo still shows. It overrides the sender's own type and colors, so it is no
 * layer's and wins with `!important`. The frame cannot load the app's Inter (its policy loads
 * fonts only from `data:`), so it takes the system's face.
 */
const SIMPLE =
  `${IN.simple} body{max-width:62ch;font-family:'Inter Variable',-apple-system,system-ui,sans-serif!important;font-size:16px!important;line-height:26px!important;color:#e4e4e4!important;background:transparent!important}` +
  `${IN.simple} body :where(:not([data-letterbox-image], img)){font-family:inherit!important;font-size:inherit!important;line-height:inherit!important;color:inherit!important;background-color:transparent!important;border-color:rgb(255 255 255 / 6%)!important}` +
  `${IN.simple} body a:link,${IN.simple} body a:visited{color:#7aa7f7!important}` +
  `${IN.simple} body table{border-collapse:collapse;margin:4px 0 20px}` +
  `${IN.simple} body th,${IN.simple} body td{padding:9px 16px 9px 0;border:0 solid!important;border-bottom-width:1px!important;text-align:left;font-size:14px!important;line-height:20px!important;color:#d2d2d2!important}` +
  `${IN.simple} body th{font-size:12px!important;line-height:16px!important;font-weight:600;color:#a3a3a3!important}` +
  `${IN.simple} body img{border-radius:5px;background:#e9e7e1}`

/**
 * The document an HTML body renders in, the same in either scheme: the scheme is set on its root
 * once it loads, and again in place as it changes (colors.ts `applyScheme`). The policy comes
 * first, so nothing in the body loads before it applies, and DNS prefetching is off, so no
 * hostname in it is looked up ahead. Links default to a new window, which the sandbox refuses, so
 * a click leaves the frame on this document. A link that names its own target is stopped by the
 * app page's `frame-src 'none'` (index.html): the frame shows an error page, and nothing loads.
 * Its own styles come before the HTML, so the defaults' layer is declared before any of the
 * sender's and before the core's color attribute rules (protocol `Colors`).
 */
const htmlDocument = (html: string) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><base target="_blank">` +
  `<style>${DEFAULTS}${PLACEHOLDER}${SIMPLE}</style>` +
  html

const UNAVAILABLE = {
  offline: 'This message has not downloaded yet. It loads when you are back online.',
  'too-large': 'This message is too large to show here.',
  gone: 'This message is no longer on the server.',
} as const

/** Shown when the core withheld a message's HTML and the message has no plain text. */
const WITHHELD = "This message's formatting couldn't be shown safely."

/** A comment no sender can have written, which marks where the quote starts in a frame's document. */
const quoteMarker = () =>
  `letterbox-quote-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join('')}`

/** `html` with the comment `marker` at `cut`, where the core says its quote starts, before an element. */
const marked = (html: string, cut: number, marker: string) => `${html.slice(0, cut)}<!--${marker}-->${html.slice(cut)}`

/**
 * One message's body, by its id, which shown images are fetched for. A reader keys it by that
 * id, so nothing in it, the frame, its images or the open quote, carries over to another message.
 */
export function Body({ id, body }: { id: MessageId; body: MessageBody }) {
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [marker] = useState(quoteMarker)
  const urls = useImageUrls(id, body.state === 'ready' ? body.images : null)
  const html = body.state === 'ready' ? body.html : null
  const htmlCut = body.state === 'ready' ? (body.quote?.html ?? null) : null
  // The HTML folds only where its quote frame can find the quote: the marker must land in the
  // body's tree, not in a `<template>`'s content. Read in an inert document, which loads nothing.
  // React Compiler keeps the result while the body and marker stay the same.
  const folds =
    html !== null &&
    htmlCut !== null &&
    frameDom.hasMarker(new DOMParser().parseFromString(marked(html, htmlCut, marker), 'text/html'), marker)
  if (body.state === 'loading') return <p className="text-row text-muted">Loading the message</p>
  if (body.state === 'unavailable') return <p className="text-row text-muted">{UNAVAILABLE[body.reason]}</p>
  const line = (quote: Quote) => <QuoteLine quote={quote} open={quoteOpen} onToggle={() => setQuoteOpen(!quoteOpen)} />
  if (body.html !== null) {
    // The new part is a prefix the core cut before an element, which the browser closes by itself.
    // HTML that cannot fold shows whole, with no line.
    const cut = folds ? htmlCut : null
    const frame = { images: body.images, urls, prefix: body.cssPrefix, colors: body.colors }
    return (
      <>
        <HtmlBody {...frame} title="Message" html={cut === null ? body.html : body.html.slice(0, cut)} />
        {cut !== null && body.quote && line(body.quote)}
        {/* Open, the quote shows under its line in a frame of its own: the whole body, with
            everything before the quote taken out, so it keeps the sender's wrappers and styles. */}
        {cut !== null && quoteOpen && (
          <div className="mt-3.5">
            <HtmlBody
              {...frame}
              title="Quoted history"
              html={marked(body.html, cut, marker)}
              prepare={(doc) => frameDom.keepFrom(doc, marker)}
            />
          </div>
        )}
      </>
    )
  }
  // The core withheld HTML it could not make safe (protocol.Body), and there is no plain part to show instead.
  if (body.htmlWithheld && body.text.trim() === '')
    return (
      <p data-field="body" className="text-row text-muted">
        {WITHHELD}
      </p>
    )
  const cut = body.quote?.text ?? null
  return (
    <div data-field="body">
      {paragraphsOf(cut === null ? body.text : body.text.slice(0, cut)).map((paragraph, index) => (
        // Paragraphs have no identity beyond their place in a body that never changes.
        // Capped at 62 characters a line at 16/26, a calm measure. HTML bodies set their own widths.
        <p key={index} className="mb-4 max-w-[62ch] text-body whitespace-pre-wrap text-prose last:mb-0">
          {paragraph}
        </p>
      ))}
      {cut !== null && body.quote && line(body.quote)}
      {cut !== null && quoteOpen && (
        <div className="mt-3.5" data-field="quoted">
          {quoted(blocksOf(body.text.slice(cut)))}
        </div>
      )}
    </div>
  )
}

const paragraphsOf = (text: string) => text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== '')

type HtmlProps = {
  title: 'Message' | 'Quoted history'
  html: string
  images: Images
  urls: ReadonlyMap<number, string>
  /** The body's `cssPrefix`, which names its CSS images and its colors. */
  prefix: string
  /** How to color the HTML: its sender's scheme, its look and its palette. */
  colors: Colors | null
  /** Runs on each document the frame loads, before it is measured. */
  prepare?: (doc: Document) => void
}

function HtmlBody({ title, html, images, urls, prefix, colors, prepare }: HtmlProps) {
  const [height, setHeight] = useState(0)
  const [frame, setFrame] = useState<Document | null>(null)
  // Each choice of images loads a fresh document in a new frame, numbered here: a frame shows
  // once its own load has set its scheme, and until then stays hidden at the last height. A
  // choice made again gets a new number, so a frame from before can never stand for it.
  const [version, setVersion] = useState({ shown: images.shown, load: 0 })
  if (version.shown !== images.shown) setVersion({ shown: images.shown, load: version.load + 1 })
  const [loaded, setLoaded] = useState<number | null>(null)
  const scheme = colors?.scheme ?? 'dark'
  // The scheme changes in place: its colors and defaults are set on the current document, which
  // is measured again. Shown images go in as they arrive, and again after a new document loads.
  // A document its frame dropped is left alone, so it is never measured as empty.
  useEffect(() => {
    if (!frame || !frameDom.current(frame)) return
    applyScheme(frame, colors, prefix)
    bindImages(frame, urls, prefix, () => {
      if (frameDom.current(frame)) setHeight(frameDom.height(frame))
    })
    setHeight(frameDom.height(frame))
  }, [frame, urls, prefix, colors])
  const original = scheme === 'original'
  return (
    // The card is always there, so a new scheme never replaces the frame: Original dims it to
    // about 86% and draws its ring over the frame, which an inset shadow on the frame itself
    // would sit under.
    <div
      data-field="frame-card"
      data-card={scheme}
      className={cx('relative', original && 'overflow-hidden rounded-[10px] brightness-86 saturate-92')}
    >
      <iframe
        // Blocking again needs the placeholders back, so a new choice loads a fresh document.
        key={version.load}
        title={title}
        data-field={title === 'Message' ? 'body' : 'quoted-body'}
        data-scheme={scheme}
        data-look={colors?.look ?? 'branded'}
        data-palette={colors?.palette.length ?? 0}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={htmlDocument(html)}
        onLoad={(event) => {
          const document = event.currentTarget.contentDocument
          // A document the reader cannot reach shows as it is, rather than stay hidden.
          if (document) {
            prepare?.(document)
            applyScheme(document, colors, prefix)
            setFrame(document)
            setHeight(frameDom.height(document))
          }
          setLoaded(version.load)
        }}
        className={cx('block w-full', original ? 'bg-paper' : 'bg-reader', loaded !== version.load && 'invisible')}
        style={{ height }}
      />
      {original && <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[10px] shadow-card" />}
    </div>
  )
}

type LineProps = { quote: Quote; open: boolean; onToggle: () => void }

/**
 * The line the quoted history folds behind, in the folded rows' style: "Quoted history", that
 * it only repeats this conversation when the core says so, and Show or Hide at the right.
 */
function QuoteLine({ quote, open, onToggle }: LineProps) {
  const chevron = { className: 'size-3.5', strokeWidth: 2, 'aria-hidden': true } as const
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      data-field="quote-line"
      className={cx(
        'mt-5 flex h-9 w-full items-center gap-2.5 border-t border-line text-left text-row',
        open && 'border-b',
      )}
    >
      <span className="flex w-4 flex-none justify-center text-muted">
        {open ? <ChevronDown {...chevron} /> : <ChevronRight {...chevron} />}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap">
        <span className="font-semibold text-fg2">Quoted history</span>
        {quote.inConversation && (
          <>
            <span aria-hidden className="text-sep">
              ·
            </span>
            <span className="truncate text-muted">all in this conversation</span>
          </>
        )}
      </span>
      <span className="flex-none text-meta text-muted">{open ? 'Hide' : 'Show'}</span>
    </button>
  )
}

/** Quoted plain text: lines at one depth, or a deeper quote. */
type Block = { kind: 'text'; text: string } | { kind: 'quote'; blocks: Block[] }

/** The quote markers at a line's start: ">", "> >", ">>". */
const MARKERS = /^(?:[ \t]*>)+[ \t]?/

/** The most levels an opened quote shows. Text quoted deeper shows at the deepest. */
const MAX_DEPTH = 8

/**
 * Plain quoted text as blocks, by how many `>` start each line, at most MAX_DEPTH, so a quote
 * of any depth nests no further than that.
 */
function blocksOf(text: string): Block[] {
  const lines = text.split('\n').map((line) => {
    const markers = MARKERS.exec(line)?.[0] ?? ''
    return { depth: Math.min(markers.split('>').length - 1, MAX_DEPTH), text: line.slice(markers.length) }
  })
  const at = (from: number, to: number, depth: number): Block[] => {
    const blocks: Block[] = []
    let index = from
    while (index < to) {
      const start = index
      const deeper = (lines[index]?.depth ?? 0) > depth
      while (index < to && (lines[index]?.depth ?? 0) > depth === deeper) index += 1
      blocks.push(
        deeper
          ? { kind: 'quote', blocks: at(start, index, depth + 1) }
          : {
              kind: 'text',
              text: lines
                .slice(start, index)
                .map((line) => line.text)
                .join('\n'),
            },
      )
    }
    return blocks
  }
  return at(0, lines.length, 0)
}

/** The last paragraph of `text` when it reads as a quote's attribution: "On … wrote:". */
const attributionOf = (text: string) => {
  const last = paragraphsOf(text).at(-1)?.trim()
  return last?.toLowerCase().endsWith('wrote:') ? last : null
}

/**
 * Quoted history, each level a step in on a 2 px rule, its attribution at the top in muted and
 * its text at 14/22 in the read color, at 62 characters a line.
 */
function quoted(blocks: readonly Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    const next = blocks[index + 1]
    if (block.kind === 'text') {
      const paragraphs = paragraphsOf(block.text)
      // An attribution goes inside the quote it introduces.
      const shown = next?.kind === 'quote' && attributionOf(block.text) ? paragraphs.slice(0, -1) : paragraphs
      return shown.map((paragraph, at) => (
        // Paragraphs have no identity beyond their place in quoted text that never changes.
        <p key={`${index} ${at}`} className="mt-1.5 max-w-[62ch] text-quote whitespace-pre-wrap text-read">
          {paragraph}
        </p>
      ))
    }
    const before = blocks[index - 1]
    const attribution = before?.kind === 'text' ? attributionOf(before.text) : null
    return (
      <div key={index} className="mt-3 border-l-2 border-keycap pl-3.5 first:mt-0" data-field="quote-level">
        {attribution && <p className="text-cite text-muted">{attribution}</p>}
        {quoted(block.blocks)}
      </div>
    )
  })
}
