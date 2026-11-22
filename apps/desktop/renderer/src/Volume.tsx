// A sender's volume in Updates: its last 14 days of mail as a strip, oldest on the left, one
// bar a day as tall as the day's messages and brighter while the day holds unread mail, and
// the same in words ("about 9 a day"). The core counts the days (SenderSummary.days).

import type { SenderDay } from '@letterbox/protocol'

/** The most messages any of `days` holds, at least 1. Rows drawn against one busiest day compare. */
export const busiest = (days: readonly SenderDay[]) => Math.max(1, ...days.map((day) => day.messages))

/** A day's bar in px: 2 for one message, 14 for the busiest. Square root, so a quiet day shows beside a busy one. */
const height = (messages: number, most: number) => Math.round(2 + 12 * Math.sqrt(messages / most))

/** The strip. A day with no mail is a gap on the baseline, not a bar. */
export function Strip({ days, most }: { days: readonly SenderDay[]; most: number }) {
  return (
    <span
      aria-hidden
      data-field="strip"
      className="relative isolate inline-flex h-3.5 flex-none items-end gap-0.5 after:absolute after:inset-x-0 after:bottom-0 after:-z-10 after:h-px after:bg-baseline after:content-['']"
    >
      {days.map((day, index) => (
        <i
          key={index}
          data-messages={day.messages}
          data-unread={day.unread > 0}
          className={`block w-[3px] rounded-t-[1px] ${day.unread > 0 ? 'bg-muted' : 'bg-sep'}`}
          style={{ height: day.messages === 0 ? 0 : height(day.messages, most) }}
        />
      ))}
    </span>
  )
}

/** How often a sender writes, from its days: "about 9 a day", "about 2 a week" or "now and then". */
export function rate(days: readonly SenderDay[]) {
  const messages = days.reduce((sum, day) => sum + day.messages, 0)
  const perDay = Math.round(messages / days.length)
  if (perDay >= 1) return `about ${perDay} a day`
  const perWeek = (messages * 7) / days.length
  if (perWeek >= 1) return `about ${Math.round(perWeek)} a week`
  return messages > 0 ? 'now and then' : 'none in 2 weeks'
}
