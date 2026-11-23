// Raw messages for the sim's mailboxes, as `raw` answers them (an unsubscribe's DKIM check,
// crates/core/src/unsubscribe/dkim.rs), and the DKIM signature a seed asks for (RFC 6376).
//
// A seed message with `dkim` is signed with SIM_DKIM_KEY, rsa-sha256 and relaxed/relaxed
// canonicalization, over the headers it names. Its key record is SIM_DKIM_RECORD: a scenario
// serves it from the fake web's DNS at `<selector>._domainkey.<domain>`, or leaves it out, or
// serves another, to make the check fail. The key is a fixed test key, made for this file and
// used nowhere else, so every run signs the same bytes.

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import type { SeedAddress, SeedMessage } from './contract.ts'
import { bareMessageId } from './store.ts'

/** The headers a seed's signature covers unless it names others: both RFC 8058 needs, and the usual ones. */
export const SIGNED_HEADERS = [
  'from',
  'to',
  'subject',
  'date',
  'message-id',
  'list-unsubscribe',
  'list-unsubscribe-post',
] as const

const SIM_DKIM_KEY = createPrivateKey(
  [
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC1Ukl0ZY28qTMn',
    '4860WZ0wbP/D9BLOfHOe9iF1GKQH9TO1iOSNvULigwC9lt0p0SPwv0X8kafUcOQl',
    'FxcyNvt3enDFDOGjITT1Kun/ktIhS3HuNtUVAwK/vCXynUpJoeiVbPF8mGFKzaAj',
    'QwHlA6tv9I7YPK9uENHMHJrqyBZDRkAcgtH2ujXBrYOcRjwEaa0OnM6rO/eeGCLn',
    'ZvDWOnL8TeJbtN6lGmKA63p8+hHikYBUC1VA53iuAcMJien5tF1cqTZ4prQagiqr',
    '182gwkFirpS1pyyIqQRajCjhjxGTbn+/M1IJnCqo9HBhsYPG8abX8lbpDxILgy1R',
    'AsvL4K+dAgMBAAECggEAA2TvyL+GmI5cTaCx7mYHuhqC691Q+s+RRIZcAvqmm3Ay',
    'Jcb9waTWMIeo8bj2GUHNLUUPX4EvMJwPu/KuNaZE19bmxIbktG6Qig8Mbq3bbtHK',
    '512HE0vJTI3jnKKS0O+4ew+dMlVnQNoPkjQUwCpCQSgarR6ZtB2ZfSYt75Dg+yUN',
    '8SX9ugFx7qbbEVfLHJ9cfYsUCqsVxixlpHqk3X4apepDRsA25sgB255KfiJmLQWp',
    'AAXEJDD1W+CVbpybsFtwQmY7CNvrtuHVIm1+R3hnG6i2prlMNyCUYwIiMKwsU0sK',
    '5oJ2bmGVBhhZ6RWcLY5cZfeUK/dZQTdarHULScEtwQKBgQDiBrcfZ6fVfiqiscnP',
    'y6fKUlDBwC0ZNPdTUe/O0QNvYs9DuXVeeEtY2j5uRsn0ALkiBFmvwhkxpkHNho9J',
    'Qjxu7YC8car/9yHkm6PmBfFQ7xjFphsK6EEaE3D5x168oYaCwkYfdXuCeLoWxibt',
    'S5WoH+XORFGRWbETB/7/NbDdYQKBgQDNXed58O+Ko0OkL+WZuo3VnAJE0wjvDNOk',
    'c0nZjK5gjo7j+mCK7BssFvo7PzfOtZtu09RARAuLrmrc0DZZJqlceHImZwyOPJSK',
    'l0nFh69lo9v+0ufIpUhnSTBJm9WhrAe8HckTYXQS/TM4KilCY5kTEKrz7IR9jRKR',
    'rqjxY46fvQKBgHeU1/OMkrYYDxSOfVgrxjT7gfBP7UxFwohZdEd2O5wFqeSJzTfS',
    '6wIyTQ9o8lXewBPoO08KoOusq2nCRDKdEX4at557gN31cQAS/A6pnDeWmAOR0wLd',
    'R/w0xvPPcCbaSmEJybHBJTwtBT8hTN0EvUP6xElxybnduxp3g4igbldhAoGAAt+e',
    'folNgL4aEzEMYGNI2sVNDtN5G4ctau6mCOI8CmPUQgJd2XPGSY6kv7F5wW2vGBTk',
    'smWBV9n/6skLCaJN2lphFoJ4nYDhfzLwuE/Wt3BcgqtGzPrrEW7nuw/wJEv467vq',
    '9Vd2vVFHpzCH1UL5gFfKXJFhpTQVH263NHF1LG0CgYBiDCNveONPhEZmXmOZt6hh',
    'RXIzt+bkPKEVmfCV9bXLaJ61PWApRZo2OHoZ1lLyW7VF0WXYzTPfiWZsEcHINkbZ',
    'JeQ7AQsaiENqIvQ3WlN6/h9Gz4RqzQGNurAuyzQ9LtImfJe07Wmk8pxi2hsX1onP',
    'c6WAVoLAAc22OwpI1SlTZA==',
    '-----END PRIVATE KEY-----',
  ].join('\n'),
)

/** The DKIM key record (RFC 6376 section 3.6.1) for every signature the sim makes. */
export const SIM_DKIM_RECORD = `v=DKIM1; k=rsa; p=${createPublicKey(SIM_DKIM_KEY).export({ type: 'spki', format: 'der' }).toString('base64')}`

/** Another key's record, which no signature of the sim's verifies against. */
export const OTHER_DKIM_RECORD = `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvLQn28wB93f86TC4YzTakbxFHG4ZzZyxG66qV8alrmwRRHQ+dl5+D83LaP2wEh/JXdJdONITvA69mnsTOuSTJ6d+AoD+mYf6sdWpfAvx2XVd+wC6pleqK/1MT1lvl10qkiGU71/6zkdFiubCvm7QT3fzPBuMBDnRHEZsFPsXJdjKwfbgSsRbGJIe14oBY5Ywp8mv1Gc2OY3llmIaf6Br6RHZYaU/XZp56OdVp7gI48eZOJqm+tXIl5ocilVOf27In/OpzmIIPLvcQ5cXBlmOeWRsd2f3osmOr/3yUt0ePvK8nIn5yffWU6sjYKJG5QpWCypmKRMQWkpYeL0qic7mHwIDAQAB`

/** A seed address as a header writes it. */
const written = (address: SeedAddress): string =>
  typeof address === 'string' ? address : `"${address.name}" <${address.address}>`

/** List-Unsubscribe as a seed gives it: as written, a stock mailto for `true`, or none. */
const listUnsubscribeOf = (seed: SeedMessage): string | null => {
  const given = seed.headers?.listUnsubscribe ?? false
  if (typeof given === 'string') return given
  return given ? '<mailto:unsubscribe@list.example>' : null
}

/** One header field, relaxed (RFC 6376 section 3.4.2): name lowercase, value unfolded, runs of space made one. */
const relaxedHeader = (name: string, value: string): string =>
  `${name.trim().toLowerCase()}:${value
    .replace(/\r\n/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()}`

/** A body, relaxed (RFC 6376 section 3.4.4): runs of space made one, none at line ends, no empty lines at the end. */
const relaxedBody = (body: string): string => {
  const lines = body.split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''))
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`
}

/** The DKIM-Signature value for `headers` and `body`, signed over the headers `signed` names. */
const signature = (headers: [string, string][], body: string, dkim: NonNullable<SeedMessage['dkim']>): string => {
  const signed = dkim.signs ?? SIGNED_HEADERS
  const bh = createHash('sha256').update(relaxedBody(body)).digest('base64')
  const unsigned = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${dkim.domain}; s=${dkim.selector}; h=${signed.join(':')}; bh=${bh}; b=`
  const lines = signed.flatMap((name) => {
    const found = headers.findLast(([field]) => field.toLowerCase() === name)
    return found ? [`${relaxedHeader(...found)}\r\n`] : []
  })
  const data = `${lines.join('')}${relaxedHeader('DKIM-Signature', unsigned)}`
  return `${unsigned}${sign('sha256', Buffer.from(data), SIM_DKIM_KEY).toString('base64')}`
}

/** A seed message as a whole RFC 5322 message: its headers, signed when it asks, and its text. */
export const rawOf = (seed: SeedMessage, references: string[]): string => {
  const headers: [string, string][] = [
    ['From', written(seed.from)],
    ['To', seed.to.map(written).join(', ')],
    ['Subject', seed.subject],
    ['Date', new Date(seed.sentAt).toUTCString()],
    ['Message-ID', `<${bareMessageId(seed)}>`],
  ]
  if (references.length > 0) headers.push(['References', references.map((id) => `<${id}>`).join(' ')])
  const list = listUnsubscribeOf(seed)
  if (list !== null) headers.push(['List-Unsubscribe', list])
  const post = seed.headers?.listUnsubscribePost
  if (post !== undefined) headers.push(['List-Unsubscribe-Post', post])
  headers.push(['MIME-Version', '1.0'], ['Content-Type', 'text/plain; charset=utf-8'])
  const body = `${seed.text.replace(/\r?\n/g, '\r\n').replace(/(?<!\r\n)$/, '\r\n')}`
  if (seed.dkim) headers.unshift(['DKIM-Signature', signature(headers, body, seed.dkim)])
  return `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n${body}`
}
