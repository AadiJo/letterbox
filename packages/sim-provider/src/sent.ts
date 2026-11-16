// Reads a message the core sends (RFC 5322 with MIME) into the facts and body the sim
// keeps, so a sent copy looks to the core exactly like any message the provider reports.
// It reads what a mail provider must: folded headers, RFC 2047 encoded words, address
// lists, and a text/plain or multipart/alternative body in base64, quoted-printable or
// plain 7bit and 8bit.

import type { RemoteAddress, RemoteBody, RemoteFacts } from './adapter.ts'
import { previewOf } from './store.ts'

type Headers = Map<string, string>

/** Splits a message or part at its first blank line and unfolds its headers, by lowercase name. */
const split = (text: string): { headers: Headers; body: string } => {
  const end = text.search(/\r?\n\r?\n/)
  const head = end === -1 ? text : text.slice(0, end)
  const body = end === -1 ? '' : text.slice(end).replace(/^\r?\n\r?\n/, '')
  const headers: Headers = new Map()
  for (const line of head.replace(/\r?\n[ \t]/g, (fold) => fold.slice(-1)).split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { headers, body }
}

/** Undoes quoted-printable (RFC 2045 section 6.7). In a Q encoded word `_` is a space too. */
const unquote = (text: string, underscores: boolean): Buffer => {
  const soft = text.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let index = 0; index < soft.length; index += 1) {
    const hex = soft.slice(index + 1, index + 3)
    if (soft[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      index += 2
    } else if (underscores && soft[index] === '_') bytes.push(0x20)
    else bytes.push(...Buffer.from(soft[index] ?? ''))
  }
  return Buffer.from(bytes)
}

/** Decodes RFC 2047 encoded words. Space between two encoded words is not part of the text. */
export const decodeWords = (value: string): string =>
  value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, encoding: string, text: string) =>
      (encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : unquote(text, true)).toString('utf8'),
    )

/** Every address in a list such as "Ana <ana@example.com>, ben@example.com". */
export const addressesOf = (value: string | undefined): RemoteAddress[] =>
  (value ?? '')
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const angled = /^(.*)<([^>]*)>\s*$/.exec(part)
      if (!angled) return { name: null, address: part }
      const name = decodeWords((angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1'))
      return { name: name === '' ? null : name, address: (angled[2] ?? '').trim() }
    })

/** Every Message-ID in a header, without angle brackets. */
const idsOf = (value: string | undefined): string[] => [...(value ?? '').matchAll(/<([^>]+)>/g)].map((m) => m[1] ?? '')

/** A parameter of a Content-Type value, such as its boundary. */
const parameter = (value: string, name: string): string | undefined =>
  new RegExp(`;\\s*${name}="?([^";]+)"?`, 'i').exec(value)?.[1]

/** The decoded text of one part, with CRLF line ends turned into LF. */
const textOf = (headers: Headers, body: string): string => {
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase()
  const bytes =
    encoding === 'base64'
      ? Buffer.from(body, 'base64')
      : encoding === 'quoted-printable'
        ? unquote(body, false)
        : Buffer.from(body)
  return bytes.toString('utf8').replace(/\r\n/g, '\n')
}

/** The text and html of a body: a single text part, or the first of each in a multipart one. */
const bodyOf = (headers: Headers, body: string): { text: string | null; html: string | null } => {
  const type = headers.get('content-type') ?? 'text/plain'
  const boundary = parameter(type, 'boundary')
  if (!type.toLowerCase().startsWith('multipart/') || boundary === undefined) {
    const isHtml = type.toLowerCase().startsWith('text/html')
    return isHtml ? { text: null, html: textOf(headers, body) } : { text: textOf(headers, body), html: null }
  }
  const found: { text: string | null; html: string | null } = { text: null, html: null }
  const parts = body.split(`--${boundary}`).slice(1)
  for (const raw of parts) {
    if (raw.startsWith('--')) break
    const part = split(raw.replace(/^\r?\n/, ''))
    const inner = bodyOf(part.headers, part.body.replace(/\r?\n$/, ''))
    found.text ??= inner.text
    found.html ??= inner.html
  }
  return found
}

/** A sent message as the sim keeps it. `bulk` is the dialect's verdict, as for delivered mail. */
export const readSent = (raw: string, bulk: boolean | null): { facts: RemoteFacts; body: RemoteBody } => {
  const { headers, body } = split(raw)
  const { text, html } = bodyOf(headers, body)
  const references = idsOf(headers.get('references'))
  for (const id of idsOf(headers.get('in-reply-to'))) if (!references.includes(id)) references.push(id)
  const from = addressesOf(headers.get('from'))[0] ?? { name: null, address: '' }
  const date = Date.parse(headers.get('date') ?? '')
  return {
    facts: {
      messageId: idsOf(headers.get('message-id'))[0] ?? null,
      references,
      subject: decodeWords(headers.get('subject') ?? ''),
      from,
      to: addressesOf(headers.get('to')),
      cc: addressesOf(headers.get('cc')),
      sentAt: new Date(Number.isNaN(date) ? 0 : date).toISOString(),
      preview: previewOf(text ?? ''),
      size: Buffer.byteLength(raw),
      hasAttachments: false,
      headers: { listUnsubscribe: false, listId: false, precedence: '', autoSubmitted: '' },
      bulk,
    },
    body: { text: text ?? '', html, attachments: [] },
  }
}

/** Takes the Bcc header out of a message: what the provider delivers, and who it also goes to. */
export const withoutBcc = (raw: string): { raw: string; bcc: string[] } => {
  const { headers } = split(raw)
  const bcc = addressesOf(headers.get('bcc')).map((address) => address.address)
  const end = raw.search(/\r?\n\r?\n/)
  const head = raw.slice(0, end === -1 ? raw.length : end + 2)
  const kept = head.replace(/^Bcc:.*\r?\n(?:[ \t].*\r?\n)*/im, '')
  return { raw: kept + raw.slice(head.length), bcc }
}
