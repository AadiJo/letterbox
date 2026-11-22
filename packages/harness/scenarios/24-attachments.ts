// Ways opening or saving an attachment can hand the user the wrong file, or none: bytes out
// of order or cut short, one huge line, a file that is gone or offline read as something
// else, or a file too large for the core fetched anyway.

import type { Attachment, BlobId, Requests } from '@letterbox/protocol'
import type { SeedMessage } from '@letterbox/sim-provider/contract'
import type { CoreClient } from '../src/client.ts'
import { fromBen, openWithBody, standardSeed, start, thread } from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'

/** The most bytes one chunk carries (CHUNK_BYTES in crates/core/src/attachments.rs). */
const CHUNK = 64 * 1024

/** A file of a little over three chunks, so it needs four, and a small one beside it. */
const CONTRACT: SeedMessage = fromBen('contract', 'The signed contract', '2025-12-05T09:00:00.000Z', {
  attachments: [
    { name: 'contract.pdf', mime: 'application/pdf', size: 3 * CHUNK + 1234 },
    { name: 'notes.txt', mime: 'text/plain', size: 3000 },
  ],
})

/** A file over the core's limit of 50 MiB. */
const DISK: SeedMessage = fromBen('disk', 'The disk image', '2025-12-06T09:00:00.000Z', {
  attachments: [{ name: 'disk.iso', mime: 'application/x-iso9660-image', size: 60 * 1024 * 1024 }],
})

/** The usual start, with CONTRACT and DISK in the inbox too. */
const startWithFiles = (t: Scenario) => {
  const seed = standardSeed(t.dialect)
  return start(t, { ...seed, messages: [...seed.messages, CONTRACT, DISK] })
}

/** The files the first message of the conversation with this subject lists. */
const filesOf = async (core: CoreClient, subject: string): Promise<Attachment[]> =>
  (await openWithBody(core, (await thread(core, subject)).id)).attachments

type Fetched = {
  answer: Requests['attachment']['result'] | Requests['attachment']['error']
  bytes: Buffer
  /** How many bytes each chunk carried, in order. */
  sizes: number[]
  /** True when every chunk came before the response and named the request. */
  inOrder: boolean
}

/**
 * Asks for one file and takes the chunks the listed size needs, then the response. `inOrder`
 * is false if the response came before the last of them, or a chunk named another request.
 */
async function fetchFile(core: CoreClient, file: Attachment, chunks = Math.ceil(file.size / CHUNK)): Promise<Fetched> {
  const { id, done } = core.begin({ method: 'attachment', blobId: file.blobId })
  let answered = false
  void done.then(
    () => (answered = true),
    () => {},
  )
  const parts: Buffer[] = []
  let inOrder = true
  for (let taken = 0; taken < chunks; taken += 1) {
    const chunk = await core.take('chunk')
    inOrder &&= chunk.id === id && !answered
    parts.push(Buffer.from(chunk.data, 'base64'))
  }
  const response = await done
  return {
    answer: response.ok ? response.result : response.error,
    bytes: Buffer.concat(parts),
    sizes: parts.map((part) => part.length),
    inOrder,
  }
}

scenario('an attachment arrives whole and in order, in chunks no larger than 64 KiB', async (t) => {
  const { core, box } = await startWithFiles(t)
  const [contract, notes] = await filesOf(core, 'The signed contract')
  if (!contract || !notes) throw new Error('the contract lists no files')

  const large = await fetchFile(core, contract)
  t.equal(
    large.answer,
    { name: 'contract.pdf', mime: 'application/pdf', size: 3 * CHUNK + 1234 },
    "the answer gives the file's name, type and size",
  )
  t.equal(
    large.sizes,
    [CHUNK, CHUNK, CHUNK, 1234],
    'a file of three chunks and a bit comes in four, the last one short',
  )
  t.check(large.inOrder, 'every chunk names the request and comes before its response')
  t.check(large.bytes.equals(box.attachmentBytes('contract', 0)), 'the bytes are the ones the provider holds')

  const small = await fetchFile(core, notes)
  t.equal(small.sizes, [3000], 'a small file comes in one chunk')
  t.check(small.bytes.equals(box.attachmentBytes('contract', 1)), 'the second file is its own, not the first again')
})

scenario('an attachment that is gone, or that no message lists, is answered gone', async (t) => {
  const { core, box } = await startWithFiles(t)
  const [contract] = await filesOf(core, 'The signed contract')
  if (!contract) throw new Error('the contract lists no files')
  const made = (blobId: string) => fetchFile(core, { ...contract, blobId: blobId as BlobId }, 0)
  const answers = await Promise.all(
    [
      contract.blobId.replace(/_1$/, '_3'),
      contract.blobId.replace(/_1$/, '_01'),
      contract.blobId.replace(/_1$/, ''),
      'blob_message_999_1',
    ].map(async (blobId) => (await made(blobId)).answer),
  )
  t.equal(answers, ['gone', 'gone', 'gone', 'gone'], 'a place past the list, or an id the core never made, is gone')
  t.equal(box.calls().attachment, 0, 'none of them reached the provider')

  // Removed at the provider since the core last synced, so the core still lists it.
  box.expunge('contract')
  t.equal((await made(contract.blobId)).answer, 'gone', 'a file whose message the provider removed is gone')
})

scenario('an attachment is offline while the provider is, and arrives once it is back', async (t) => {
  const { core, box } = await startWithFiles(t)
  const [, notes] = await filesOf(core, 'The signed contract')
  if (!notes) throw new Error('the contract lists no notes')
  box.setOffline(true)
  t.equal((await fetchFile(core, notes, 0)).answer, 'offline', 'while the provider is offline the answer says so')
  box.setOffline(false)
  const fetched = await fetchFile(core, notes)
  t.check(fetched.bytes.equals(box.attachmentBytes('contract', 1)), 'once it is back the file arrives')
})

scenario('an attachment over 50 MiB is refused without asking the provider', async (t) => {
  const { core, box } = await startWithFiles(t)
  const [disk] = await filesOf(core, 'The disk image')
  if (!disk) throw new Error('the disk image lists no file')
  t.equal(disk.size, 60 * 1024 * 1024, 'the conversation shows its size')
  t.equal((await fetchFile(core, disk, 0)).answer, 'too-large', 'it is refused too-large')
  t.equal(box.calls().attachment, 0, 'the provider was never asked for it')
})

// One run is enough: the check is the core's, whatever adapter brought the bytes, and each
// run moves 50 MiB through the provider's socket.
scenario(
  'an attachment that arrives larger than 50 MiB is refused, though it was listed small',
  async (t) => {
    const seed = standardSeed(t.dialect)
    const liar = fromBen('liar', 'A small file', '2025-12-07T09:00:00.000Z', {
      attachments: [{ name: 'small.txt', mime: 'text/plain', size: 1000, served: 50 * 1024 * 1024 + 1 }],
    })
    const { core, box } = await start(t, { ...seed, messages: [...seed.messages, liar] })
    const [small] = await filesOf(core, 'A small file')
    if (!small) throw new Error('the message lists no file')
    t.equal(small.size, 1000, 'the conversation shows the size the provider listed')
    const fetched = await fetchFile(core, small, 0)
    t.equal(fetched.answer, 'too-large', 'it is refused too-large')
    t.equal(box.calls().attachment, 1, 'the provider was asked, and sent more than it listed')
  },
  ['folders'],
)
