// The sim a dev page shows: core-sim built, the sim provider holding a seed's mailbox, the
// fake web serving the seed's remote images, DKIM keys and unsubscribe pages, and the dev
// store signed in to the provider.
// `pnpm dev`, `pnpm dev:desktop`, the UI check and the Electron check share it.

import { readFileSync } from 'node:fs'
import { imagePath, type DevSeed } from '@letterbox/sim-provider/seeds'
import type { SimMailbox, SimProvider } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import { type FakeWeb, startFakeWeb } from '@letterbox/sim-provider/web'
import { buildCore, type Paths, signIn } from './core.ts'
import type { Sim } from './server.ts'

export type RunningSim = {
  provider: SimProvider
  mailbox: SimMailbox
  /** The fake web every core of this sim fetches images from. It records each URL asked for. */
  web: FakeWeb
  sim: Sim
  /** Stops the fake web and the provider. */
  close(): Promise<void>
}

/**
 * Builds core-sim, starts the provider with `seed`'s mailbox and the fake web with its images,
 * and signs the store at `paths.data` in to the provider.
 */
export async function startSim(paths: Paths, seed: DevSeed): Promise<RunningSim> {
  await buildCore(paths)
  const provider = await startSimProvider(paths.socket)
  const web = await startFakeWeb()
  const close = async () => {
    await web.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
  }
  try {
    for (const image of seed.images)
      web.serve(image.url, { kind: 'body', mime: image.mime, bytes: readFileSync(imagePath(image)) })
    for (const { name, records } of seed.web.txt) web.txt(name, records)
    for (const { name, addresses } of seed.web.resolve) web.resolve(name, addresses)
    for (const { url, answer } of seed.web.serve) web.serve(url, answer)
    const mailbox = provider.createMailbox(seed.dialect, seed.seed)
    await signIn(paths, seed.now, seed.seed.address, seed.seed.password)
    let delivered = 0
    const deliver = (count: number) => {
      for (let index = 0; index < count; index += 1) mailbox.deliver(seed.delivery(delivered++))
    }
    return { provider, mailbox, web, sim: { now: seed.now, web: web.url, deliver }, close }
  } catch (error) {
    await close()
    throw error
  }
}
