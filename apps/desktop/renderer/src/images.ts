// A message's remote images. The core blocks them until the user shows them for that message
// (`set-images`, protocol `Images`). Shown, the core fetches each one (`image` request) and
// sends its bytes as chunks, and the reader puts them into the message's frame as a data: URL.
// The frame's policy stays `img-src data: cid:`, so nothing in it reaches the network.
//
// Only DOM APIs write into the frame: an element made in its document, an attribute, a
// custom property on its root. No HTML or CSS text is built from what the core sent.

import type { Images, Message, MessageId, ShowImages } from '@letterbox/protocol'
import { useEffect, useEffectEvent, useState } from 'react'
import { command, requestBytes } from './core.ts'
import { frameDom } from './frame-dom.ts'
import { typing } from './Screen.tsx'
import { confirmOpen } from './unsubscribe.ts'

/** The key that shows the images of the open message whose images are off. */
export const SHOW_IMAGES_KEY = 'i'

/** How many of one message's images the core fetches at a time. */
const AT_ONCE = 3

/** The types the core reads from an image's bytes (protocol `ImageFile`). Any other answer counts as a failure. */
const TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

/** Shows or blocks a message's images. The thread view reports the new choice once the core takes it. */
export const setImages = (messageId: MessageId, show: ShowImages) =>
  void command({ kind: 'set-images', messageId, show }).answer.catch(() => {})

/** True when the message has images the user has not shown: the chip says "Images off". */
export const imagesOff = (images: Images) => images.remote.length > 0 && images.shown === 'blocked'

/** What the images menu says about trackers the core took out, or null when it took none. */
export function trackerNote(images: Images) {
  const count = images.trackers.length
  if (count === 0) return null
  return count === 1
    ? '1 tracker removed. Showing images won’t bring it back.'
    : `${count} trackers removed. Showing images won’t bring them back.`
}

/**
 * Asks the core for image `index` of `messageId`. Resolves with a data: URL, or null when the
 * core did not fetch it (gone, blocked, refused, too large, unreachable).
 */
async function fetchImage(messageId: MessageId, index: number): Promise<string | null> {
  const { response, chunks } = await requestBytes({ method: 'image', messageId, index })
  if (!response.ok || !TYPES.has(response.result.mime)) return null
  // Each chunk is base64 of its own bytes, padded on its own, so they are joined as bytes.
  const bytes = chunks.map((chunk) => atob(chunk)).join('')
  return `data:${response.result.mime};base64,${btoa(bytes)}`
}

/**
 * The data: URLs of a message's images, by index into `images.remote`, while they are shown.
 * Fetches them in order, AT_ONCE at a time. When the message closes or its images are blocked
 * again, it starts no more fetches, drops answers still to come and forgets the URLs. An image
 * that failed is left out, so it keeps its placeholder.
 */
export function useImageUrls(messageId: MessageId, images: Images | null): ReadonlyMap<number, string> {
  const [urls, setUrls] = useState<ReadonlyMap<number, string>>(new Map())
  const count = images?.remote.length ?? 0
  const shown = images !== null && images.shown !== 'blocked'
  useEffect(() => {
    if (!shown || count === 0) return
    const run = { stopped: false, next: 0 }
    const work = async () => {
      while (!run.stopped && run.next < count) {
        const index = run.next
        run.next += 1
        // oxlint-disable-next-line no-await-in-loop -- each worker fetches one image at a time; AT_ONCE workers share the queue
        const url = await fetchImage(messageId, index).catch(() => null)
        if (!run.stopped && url !== null) setUrls((current) => new Map(current).set(index, url))
      }
    }
    for (let worker = 0; worker < AT_ONCE; worker += 1) void work()
    return () => {
      run.stopped = true
      setUrls(new Map())
    }
  }, [messageId, count, shown])
  return urls
}

/**
 * Puts each image in `urls` where the core left its placeholder in the frame's document `doc`
 * (protocol `Images`), through `frameDom` only, since the sender's markup can shadow the
 * document's own methods. An `<img>`'s placeholder span becomes an `<img>` made in that
 * document, with the span's alt text and size, and `loaded` runs once it has loaded, as the
 * frame's height may have changed. An image input, a video's poster or an SVG image gets the
 * URL in its own attribute, an old `background` attribute gets it back, and a CSS image is the
 * custom property `<prefix>image-<i>` on the root, where `prefix` is the body's random
 * `cssPrefix`, which the sender's CSS cannot name. Safe to call again as more arrive.
 */
export function bindImages(doc: Document, urls: ReadonlyMap<number, string>, prefix: string, loaded: () => void) {
  if (urls.size === 0) return
  const at = (element: Element, name: string) => urls.get(Number(frameDom.get(element, name)))
  for (const element of frameDom.all(doc, '[data-letterbox-image]')) {
    const url = at(element, 'data-letterbox-image')
    if (url === undefined) continue
    const name = frameDom.localName(element)
    if (name === 'span') {
      const image = frameDom.create(doc, 'img')
      frameDom.set(image, 'src', url)
      frameDom.set(image, 'alt', frameDom.text(element) ?? '')
      for (const side of ['width', 'height']) {
        const size = frameDom.get(element, `data-letterbox-${side}`)
        if (size !== null) frameDom.set(image, side, size)
      }
      // The image is the frame's own, made here, so no sender markup sits on it to shadow this.
      image.addEventListener('load', loaded, { once: true })
      frameDom.replace(element, image)
    } else {
      // The frame's elements come from another document, so their names, not their classes, say what they are.
      const attribute = { video: 'poster', image: 'href' }[name] ?? 'src'
      frameDom.set(element, attribute, url)
      frameDom.unset(element, 'data-letterbox-image')
    }
  }
  for (const element of frameDom.all(doc, '[data-letterbox-background]')) {
    const url = at(element, 'data-letterbox-background')
    if (url === undefined) continue
    frameDom.set(element, 'background', url)
    frameDom.unset(element, 'data-letterbox-background')
  }
  // A data: URL of base64 holds no quote, so it cannot end the url() early.
  for (const [index, url] of urls) frameDom.setProperty(doc, `${prefix}image-${index}`, `url("${url}")`)
}

/** While the reader shows `message`, I shows its images if they are off. */
export function useShowImagesKey(message: Message | undefined) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    // A held key repeats. Only its first press acts, so holding I in a menu shows that menu's
    // message alone, and the repeats do not go on to the newest.
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || confirmOpen()) return
    if (event.key !== SHOW_IMAGES_KEY || message?.body.state !== 'ready' || !imagesOff(message.body.images)) return
    setImages(message.id, 'message')
    event.preventDefault()
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}
