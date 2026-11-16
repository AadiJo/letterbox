// Row ages, such as "1h" and "16d".

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * The time ages are measured from. In the dev loop it is the sim's fixed time, so a capture
 * of the same mailbox shows the same ages on any day. Anywhere else it is the clock.
 */
const now = () => {
  const fixed = import.meta.env.VITE_LETTERBOX_NOW
  return fixed === undefined ? Date.now() : Date.parse(fixed)
}

/** How long ago `time` (ISO 8601) was, in its largest whole unit: "now", "5m", "3h", "16d" or "2y". */
export function age(time: string) {
  const elapsed = now() - Date.parse(time)
  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 365 * DAY) return `${Math.floor(elapsed / DAY)}d`
  return `${Math.floor(elapsed / (365 * DAY))}y`
}
