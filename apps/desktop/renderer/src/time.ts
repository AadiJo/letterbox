// How times read in the UI, and when a turn is late. Every function takes "now" from
// the caller, who reads it from clock.ts, so these stay pure.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A turn that has waited longer than this is late, and shows in amber. */
const LATE_AFTER = 7 * DAY

export const isLate = (time: string, now: number) => now - Date.parse(time) > LATE_AFTER

/** How long ago `time` (ISO 8601) was, in its largest whole unit: "now", "5m", "3h", "16d" or "2y". */
export function age(time: string, now: number) {
  const elapsed = now - Date.parse(time)
  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 365 * DAY) return `${Math.floor(elapsed / DAY)}d`
  return `${Math.floor(elapsed / (365 * DAY))}y`
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** The local midnight that starts the day `at` falls in. */
const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0)

/** Whole local days between the day of `time` and the day of `now`. 0 is today, 1 yesterday. */
const daysAgo = (time: number, now: number) => Math.round((midnight(now) - midnight(time)) / DAY)

/** The one time a list row shows: "10:42 AM" today, then "Yesterday", "Mon", "Oct 30" and "Oct 30, 2025". */
export function listTime(time: string, now: number) {
  const at = Date.parse(time)
  const days = daysAgo(at, now)
  if (days <= 0) return clock.format(at)
  if (days === 1) return 'Yesterday'
  if (days < 7) return weekday.format(at)
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? monthDay.format(at) : fullDate.format(at)
}

/** A message's time in the reader: "Today 10:42 AM", "Mon 4:10 PM" or "Oct 30, 4:10 PM". */
export function messageTime(time: string, now: number) {
  const at = Date.parse(time)
  const days = daysAgo(at, now)
  if (days <= 0) return `Today ${clock.format(at)}`
  if (days < 7) return `${weekday.format(at)} ${clock.format(at)}`
  return `${listTime(time, now)}, ${clock.format(at)}`
}
