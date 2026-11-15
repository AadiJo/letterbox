// The property every sync engine must keep: whatever mix of changes happens on
// other devices, at the provider and from the user, and whenever the provider is
// unreachable, the core ends up showing exactly what the provider holds once it
// can reach the provider, every change has settled and a sync has run.
//
// Each seed is one random but repeatable sequence of steps. A failing seed is a
// recipe: rerun it with `pnpm scenarios "seed 7"` and read its transcript.
//
// A user action is followed by a sync, which waits for the core to finish pushing.
// That keeps the order of events, and so the transcript, the same on every run.

import type { Dialect, SimMailbox, SeedMessage } from '@letterbox/sim-provider/contract'
import type { ChangeId, Command } from '@letterbox/protocol'
import type { CoreClient } from '../src/client.ts'
import { ME, PASSWORD, start, sync, threads } from '../src/fixtures.ts'
import { type Scenario, scenario } from '../src/scenario.ts'

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]
const STEPS = 40

/** A small, fast generator. The same seed always gives the same numbers. */
const random = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  return {
    below: (count: number) => Math.floor(next() * count),
    chance: (odds: number) => next() < odds,
    pick: <Item>(items: Item[]): Item | undefined => items[Math.floor(next() * items.length)],
  }
}

const NAMES: Record<string, string> = { inbox: 'Inbox', projects: 'Projects', archive: 'Archive', trash: 'Trash' }

/** Mailbox keys for the dialect. Folders need an Archive folder to archive into. */
const mailboxKeys = (dialect: Dialect) =>
  dialect === 'labels' ? ['inbox', 'projects', 'trash'] : ['inbox', 'projects', 'archive', 'trash']

/** One message per conversation: unique subjects and no replies, so the comparison is by subject. */
const message = (key: string, mailbox: string, day: number): SeedMessage => ({
  key,
  mailboxes: [mailbox],
  from: { name: 'Ana', address: 'ana@example.com' },
  to: [ME],
  subject: `Message ${key}`,
  text: `Text of ${key}.`,
  sentAt: `2025-12-${String(day).padStart(2, '0')}T09:00:00.000Z`,
})

/** What the provider holds, as subject, mailbox names, unread and flagged. */
const truthView = (box: SimMailbox) =>
  box
    .truth()
    .map((item) => [
      `Message ${item.key}`,
      item.mailboxes.map((key) => NAMES[key] ?? key).toSorted(),
      item.unread,
      item.flagged,
    ])
    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))

/** What the core shows, in the same shape. */
async function coreView(core: CoreClient) {
  const names = new Map((await core.query({ view: 'mailboxes' })).map((mailbox) => [mailbox.id, mailbox.name]))
  return (await threads(core))
    .map((item) => [
      item.subject,
      item.mailboxIds.map((id) => names.get(id) ?? id).toSorted(),
      item.unread,
      item.flagged,
    ])
    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))
}

/** Runs one random sequence of steps and checks the core converges. */
async function converge(t: Scenario, seed: number) {
  const rng = random(seed * 7919 + (t.dialect === 'labels' ? 1 : 2))
  const keys = mailboxKeys(t.dialect)
  const seedMessages = [1, 2, 3, 4, 5, 6].map((n) => message(`m${n}`, rng.pick(keys.slice(0, 2)) ?? 'inbox', n))
  const { core, box } = await start(t, {
    address: ME,
    password: PASSWORD,
    mailboxes: keys.map((key) => ({
      key,
      name: NAMES[key] ?? key,
      role: key === 'projects' ? null : (key as 'inbox' | 'archive' | 'trash'),
    })),
    messages: seedMessages,
  })

  const alive = new Set(seedMessages.map((item) => item.key))
  const changes: ChangeId[] = []
  let delivered = seedMessages.length
  let offline = false

  /** Sends a user action and lets the core finish pushing it before the next step. */
  const act = async (command: Command) => {
    const answer = await core.command(command)
    if (answer.kind === 'accepted') changes.push(answer.change)
    await core.request({ method: 'sync-now' })
  }

  for (let step = 0; step < STEPS; step += 1) {
    const key = rng.pick([...alive])
    const roll = rng.below(12)
    if (roll === 0 && delivered < 20) {
      delivered += 1
      const fresh = message(`m${delivered}`, 'inbox', delivered)
      box.deliver(fresh)
      alive.add(fresh.key)
    } else if (roll === 1 && key) {
      box.setFlags(key, { unread: rng.chance(0.5), flagged: rng.chance(0.5) })
    } else if (roll === 2 && key) {
      box.move(key, rng.pick(keys) ?? 'inbox')
    } else if (roll === 3 && key && alive.size > 2) {
      box.expunge(key)
      alive.delete(key)
    } else if (roll === 4) {
      box.expireCursors()
    } else if (roll === 5 && key && t.dialect === 'labels') {
      const label = rng.pick(keys) ?? 'projects'
      if (rng.chance(0.5)) box.addToMailbox(key, label)
      else box.removeFromMailbox(key, label)
    } else if (roll === 6) {
      offline = !offline
      box.setOffline(offline)
    } else if (roll >= 7 && roll <= 10) {
      const target = rng.pick(await threads(core))
      if (!target) continue
      const mailboxes = await core.query({ view: 'mailboxes' })
      const id = (name: string) => mailboxes.find((mailbox) => mailbox.name === name)?.id
      const inbox = id('Inbox')
      const projects = id('Projects')
      if (roll === 7)
        await act({ kind: 'set-flags', threadIds: [target.id], unread: rng.chance(0.5), flagged: rng.chance(0.5) })
      if (roll === 8 && inbox) await act({ kind: 'set-mailboxes', threadIds: [target.id], add: [], remove: [inbox] })
      if (roll === 9 && projects)
        await act({ kind: 'set-mailboxes', threadIds: [target.id], add: [projects], remove: target.mailboxIds })
      if (roll === 10) await act({ kind: 'trash', threadIds: [target.id] })
    } else {
      await core.request({ method: 'sync-now' })
    }
  }

  box.setOffline(false)
  await sync(core)
  for (const change of changes) await core.settled(change)
  await sync(core)
  t.note(`${STEPS} steps, ${changes.length} accepted changes, ${alive.size} messages left`)
  t.equal(await coreView(core), truthView(box), 'the core shows exactly what the provider holds')
}

for (const seed of SEEDS) {
  scenario(`after any mix of changes, the core converges on the provider (seed ${seed})`, (t) => converge(t, seed))
}
