// Reads a message the core sends (RFC 5322 with MIME) into the facts and body the sim
// keeps, so a sent copy looks to the core exactly like any message the provider reports.
// It reads what a mail provider must: folded headers, RFC 2047 encoded words, address
// lists, and a text/plain or multipart/alternative body in base64, quoted-printable or
// plain 7bit and 8bit, in a multipart/mixed one with attachments named in plain or RFC 2231
// parameters.

import type { RemoteAddress, RemoteBody, RemoteFacts } from './adapter.ts'
import type { SentFile } from './contract.ts'
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

/**
 * A parameter that may be written in RFC 2231 pieces: `name*0*=UTF-8''...; name*1*=...`, or
 * as one `name*=` value, or as a plain or quoted one, which may hold RFC 2047 encoded words.
 */
const extended = (value: string, name: string): string | undefined => {
  const pieces = [...value.matchAll(new RegExp(`;\\s*${name}\\*(\\d+)?(\\*)?="?([^";]*)"?`, 'gi'))]
  if (pieces.length === 0) {
    const plain = new RegExp(`;\\s*${name}="([^"]*)"|;\\s*${name}=([^;\\s]+)`, 'i').exec(value)
    const found = plain?.[1] ?? plain?.[2]
    return found === undefined ? undefined : decodeWords(found)
  }
  const ordered = pieces.toSorted((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0))
  const bytes = ordered.map((piece, index) => {
    const text = index === 0 && piece[2] ? (piece[3] ?? '').replace(/^[^']*'[^']*'/, '') : (piece[3] ?? '')
    return piece[2] ? Buffer.from(decodeURIComponent(text), 'utf8') : Buffer.from(text)
  })
  return Buffer.concat(bytes).toString('utf8')
}

/** The decoded content of one part. */
const contentOf = (headers: Headers, body: string): Buffer => {
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase()
  return encoding === 'base64'
    ? Buffer.from(body, 'base64')
    : encoding === 'quoted-printable'
      ? unquote(body, false)
      : Buffer.from(body)
}

/** The decoded text of one part, with CRLF line ends turned into LF. */
const textOf = (headers: Headers, body: string): string =>
  contentOf(headers, body).toString('utf8').replace(/\r\n/g, '\n')

/** The file a part holds, when it names one in Content-Disposition or Content-Type. */
const fileOf = (headers: Headers, body: string): SentFile | null => {
  const type = headers.get('content-type') ?? 'text/plain'
  const disposition = headers.get('content-disposition') ?? ''
  const name = extended(disposition, 'filename') ?? extended(type, 'name')
  if (name === undefined) return null
  const mime = (type.split(';')[0] ?? '').trim().toLowerCase()
  return { name, mime, inline: disposition.toLowerCase().startsWith('inline'), content: contentOf(headers, body) }
}

type Read = { text: string | null; html: string | null; files: SentFile[] }

/** The text, html and files of a body: a single part, or the first text of each kind in a multipart one, and every file. */
const bodyOf = (headers: Headers, body: string): Read => {
  const type = headers.get('content-type') ?? 'text/plain'
  const boundary = parameter(type, 'boundary')
  if (!type.toLowerCase().startsWith('multipart/') || boundary === undefined) {
    const file = fileOf(headers, body)
    if (file !== null) return { text: null, html: null, files: [file] }
    const isHtml = type.toLowerCase().startsWith('text/html')
    const text = textOf(headers, body)
    return isHtml ? { text: null, html: text, files: [] } : { text, html: null, files: [] }
  }
  const found: Read = { text: null, html: null, files: [] }
  const parts = body.split(`--${boundary}`).slice(1)
  for (const raw of parts) {
    if (raw.startsWith('--')) break
    const part = split(raw.replace(/^\r?\n/, ''))
    const inner = bodyOf(part.headers, part.body.replace(/\r?\n$/, ''))
    found.text ??= inner.text
    found.html ??= inner.html
    found.files.push(...inner.files)
  }
  return found
}

/** A sent message as the sim keeps it. `bulk` is the dialect's verdict, as for delivered mail. */
export const readSent = (
  raw: string,
  bulk: boolean | null,
): { facts: RemoteFacts; body: RemoteBody; contents: Buffer[] } => {
  const { headers, body } = split(raw)
  const { text, html, files } = bodyOf(headers, body)
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
      hasAttachments: files.length > 0,
      headers: { listUnsubscribe: false, listId: false, precedence: '', autoSubmitted: '' },
      bulk,
    },
    body: {
      text: text ?? '',
      html,
      attachments: files.map(({ name, mime, inline, content }) => ({ name, mime, size: content.length, inline })),
    },
    contents: files.map((file) => file.content),
  }
}

/** The files a message carries, as the provider reads them. Scenarios check a forward's with it. */
export const filesOf = (raw: string): SentFile[] => {
  const { headers, body } = split(raw)
  return bodyOf(headers, body).files
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
