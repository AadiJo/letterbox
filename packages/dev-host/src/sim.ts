// The sim a dev page shows: core-sim built, the sim provider holding a seed's mailbox, and the
// dev store signed in to it. `pnpm dev`, `pnpm dev:desktop` and the Electron check share it.

import type { DevSeed } from '@letterbox/sim-provider/seeds'
import type { SimMailbox, SimProvider } from '@letterbox/sim-provider/contract'
import { startSimProvider } from '@letterbox/sim-provider/server'
import { buildCore, type Paths, signIn } from './core.ts'
import type { Sim } from './server.ts'

export type RunningSim = { provider: SimProvider; mailbox: SimMailbox; sim: Sim }

/** Builds core-sim, starts the provider with `seed`'s mailbox, and signs the store at `paths.data` in to it. */
export async function startSim(paths: Paths, seed: DevSeed): Promise<RunningSim> {
  await buildCore(paths)
  const provider = await startSimProvider(paths.socket)
  try {
    const mailbox = provider.createMailbox(seed.dialect, seed.seed)
    await signIn(paths, seed.now, seed.seed.address, seed.seed.password)
    let delivered = 0
    const deliver = (count: number) => {
      for (let index = 0; index < count; index += 1) mailbox.deliver(seed.delivery(delivered++))
    }
    return { provider, mailbox, sim: { now: seed.now, deliver } }
  } catch (error) {
    await provider.close().catch(() => undefined)
    throw error
  }
}
