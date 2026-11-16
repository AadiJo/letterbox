// How far a reply the user sent has got, on its message in the conversation. Only messages
// with a `delivery` show anything: the provider holds the rest, and they look like any other.

import type { Delivery, Message, ThreadDetail } from '@letterbox/protocol'
import { CircleAlert, Clock, TriangleAlert } from 'lucide-react'
import { useSecondsUntil } from './clock.ts'
import { editAndSendAgain, REFUSALS } from './sending.ts'

/** Where the time goes on a message still on its way: "Sending in 8 s" in its undo window, then "Sending". */
export function DeliveryMark({ delivery }: { delivery: Exclude<Delivery, { state: 'failed' }> }) {
  return (
    <span
      className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-fg2 tabular-nums"
      data-field="delivery"
    >
      <Clock className="size-3.5" strokeWidth={1.75} aria-hidden />
      {delivery.state === 'held' ? <Held until={delivery.until} /> : 'Sending'}
    </span>
  )
}

function Held({ until }: { until: string }) {
  return <>Sending in {useSecondsUntil(until)} s</>
}

/**
 * A reply that did not go: why, and a way to write it again. "Unconfirmed" is not a refusal.
 * The provider may hold it, so the user is told to look in Sent before sending it twice.
 */
export function NotSent({
  thread,
  message,
  delivery,
}: {
  thread: ThreadDetail
  message: Message
  delivery: Extract<Delivery, { state: 'failed' }>
}) {
  const unsure = delivery.reason === 'unconfirmed'
  const Icon = unsure ? TriangleAlert : CircleAlert
  return (
    <div
      role="alert"
      data-field="not-sent"
      className="mb-3.5 ml-6 flex items-center gap-3 rounded-[10px] border border-red/35 bg-red/[0.07] py-2 pr-2 pl-3"
    >
      <Icon className="size-4 flex-none text-red" strokeWidth={2} aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] leading-[1.4] text-fg2">
        <b className="font-semibold text-fg">{unsure ? 'May not have been sent.' : 'Not sent.'}</b>{' '}
        {unsure ? 'Check Sent before sending again.' : REFUSALS[delivery.reason]}
      </p>
      <button
        type="button"
        onClick={() => editAndSendAgain(thread, message)}
        className="inline-flex h-7 flex-none items-center rounded-[7px] border border-key bg-raised px-2.5 text-[12.5px] font-medium text-fg hover:bg-hover"
      >
        Edit and send again
      </button>
    </div>
  )
}
