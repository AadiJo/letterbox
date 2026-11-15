// Rules every scenario run must keep, checked on its whole transcript after the
// run ends. A scenario does not have to ask for them. The runner fails any run
// that breaks one.

import type { CoreMessage, Refusal } from '@letterbox/protocol'
import type { TranscriptEntry } from './client.ts'

/** Every core message in a transcript, in the order the client handled them. */
const coreMessages = (transcript: TranscriptEntry[]): CoreMessage[] =>
  transcript.flatMap((entry) => (entry.from === 'core' ? [entry.message] : []))

/** Every string anywhere inside a value. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}

/**
 * Protocol guarantee 6: no provider ref, cursor, page token, session or password
 * reaches a client. `secrets` holds every such string the run handed to the core.
 */
export function leaks(transcript: TranscriptEntry[], secrets: ReadonlySet<string>): string[] {
  return coreMessages(transcript).flatMap((message) =>
    stringsIn(message)
      .filter((value) => secrets.has(value))
      .map(
        (value) => `the core's ${message.kind} message carries the provider's opaque string ${JSON.stringify(value)}`,
      ),
  )
}

/** One arrow in the change lifecycle: the state before, the state after, and why. */
export type Edge = { from: string; to: string; label: string }

type Settled = Extract<CoreMessage, { kind: 'settled' }>

const outcome = (result: Settled['result']) => (typeof result === 'string' ? result : 'failed')
const why = (result: Settled['result']): Refusal | '' => (typeof result === 'string' ? '' : result.failed)

/**
 * Protocol guarantees 2 and 4, across the whole run: every accepted change gets
 * exactly one outcome, a repeated send gets the same answers again, and a
 * rejected change is never applied. Also returns each change's path, so the runner
 * can draw what the lifecycle looked like across every run.
 */
export function lifecycle(transcript: TranscriptEntry[]): { problems: string[]; edges: Edge[] } {
  const events = new Map<string, CoreMessage[]>()
  for (const message of coreMessages(transcript)) {
    if (message.kind !== 'accepted' && message.kind !== 'rejected' && message.kind !== 'settled') continue
    events.set(message.change, [...(events.get(message.change) ?? []), message])
  }

  const problems: string[] = []
  const edges: Edge[] = []
  for (const [change, list] of events) {
    const first = list[0]
    if (!first) continue
    if (first.kind === 'rejected') {
      if (list.some((message) => message.kind !== 'rejected'))
        problems.push(`${change} was rejected and then answered otherwise`)
      edges.push({ from: 'Sent', to: 'Rejected', label: first.reason })
      continue
    }
    if (first.kind !== 'accepted') {
      problems.push(`${change} was settled before it was accepted`)
      continue
    }
    const accepted = list.filter((message) => message.kind === 'accepted')
    const settled = list.filter((message): message is Settled => message.kind === 'settled')
    if (list.some((message) => message.kind === 'rejected')) problems.push(`${change} was accepted and then rejected`)
    if (accepted.some((message) => message.rev !== first.rev))
      problems.push(`${change} was accepted twice at different revisions`)
    const outcomeOf = settled[0]
    if (!outcomeOf) {
      problems.push(`${change} was accepted and never settled`)
      continue
    }
    if (
      settled.some(
        (message) =>
          JSON.stringify(message.result) !== JSON.stringify(outcomeOf.result) || message.rev !== outcomeOf.rev,
      )
    ) {
      problems.push(`${change} settled twice with different outcomes`)
    }
    if (outcomeOf.rev < first.rev) problems.push(`${change} settled at a revision before it was accepted`)
    edges.push({ from: 'Sent', to: 'Accepted', label: accepted.length > 1 ? 'sent again with the same id' : '' })
    const end = outcome(outcomeOf.result)
    edges.push({
      from: 'Accepted',
      to: end === 'done' ? 'Done' : end === 'undone' ? 'Undone' : 'Failed',
      label: why(outcomeOf.result),
    })
  }
  return { problems, edges }
}

/** Draws every observed change path as a Mermaid state diagram, with how many changes took each arrow. */
export function lifecycleChart(edges: Edge[]): string {
  const counts = new Map<string, number>()
  for (const edge of edges) {
    const key = `${edge.from}\n${edge.to}\n${edge.label}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const lines = [...counts]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => {
      const [from, to, label] = key.split('\n')
      const text = label ? `${label}, ${count}` : String(count)
      return `  ${from === 'Sent' ? '[*]' : from} --> ${to}: ${text}`
    })
  return [
    'stateDiagram-v2',
    '  %% Every change the scenarios sent, by the path it took. Written by pnpm scenarios.',
    ...lines,
    '',
  ].join('\n')
}
