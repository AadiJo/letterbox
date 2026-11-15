// Gmail's per-user rate limit, as the fake models it. Each call costs the quota units on
// Google's quota page: https://developers.google.com/workspace/gmail/api/reference/quota
//
// Real Gmail counts units per user per minute. The fake has no clock, so a scenario sets a
// budget per window instead, and a window ends when the fake refuses a call: the client
// was told to wait, and the fake takes it that the minute passed while it waited. A budget
// of 0 refuses every call, however many windows pass.

/** A rate limit a scenario sets on one account. */
export type Quota = {
  /** Units one window allows. */
  units: number
  /** Seconds to name in a Retry-After header on each refusal. Real Gmail's 403 names none. */
  retryAfter?: number
}

/** Formats that make users.messages.get cost 60 units instead of 20. */
const HEAVY_FORMATS = new Set(['full', 'raw', 'html'])

/** What one call costs. Calls the fake does not serve cost nothing, and get a 404. */
export const unitsOf = (method: string, path: string, query: URLSearchParams): number => {
  if (method === 'GET') {
    if (path === 'profile' || path === 'labels') return 1
    if (path === 'history') return 2
    if (path === 'messages') return 5
    // messages.get's format defaults to full.
    if (/^messages\/[^/]+$/.test(path)) return HEAVY_FORMATS.has(query.get('format') ?? 'full') ? 60 : 20
  }
  if (method === 'POST') {
    if (path === 'messages/batchModify') return 50
    if (/^messages\/[^/]+\/modify$/.test(path)) return 5
  }
  return 0
}

const OVER_QUOTA =
  "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'."

/** The 403 Gmail sent a live run that went over its per-user limit. https://developers.google.com/workspace/gmail/api/guides/handle-errors */
export const RATE_LIMITED = {
  error: {
    code: 403,
    message: OVER_QUOTA,
    errors: [{ message: OVER_QUOTA, domain: 'usageLimits', reason: 'rateLimitExceeded' }],
    status: 'PERMISSION_DENIED',
  },
}

/** Every account's limit, what its window has used, and how many calls it refused. */
export const createQuotas = () => {
  const limits = new Map<string, Quota>()
  const used = new Map<string, number>()
  const refused = new Map<string, number>()

  return {
    /** Sets `address`'s limit and starts a new window. None lifts the limit. */
    set: (address: string, quota: Quota | null) => {
      if (quota === null) limits.delete(address)
      else limits.set(address, quota)
      used.set(address, 0)
    },
    /**
     * Charges a call to `address`'s window. Returns null when it fits. Else the call is
     * refused, the window ends, and this returns the Retry-After seconds to send, if any.
     */
    charge: (address: string, units: number): { retryAfter?: number } | null => {
      const quota = limits.get(address)
      if (!quota) return null
      const spent = (used.get(address) ?? 0) + units
      if (spent <= quota.units) {
        used.set(address, spent)
        return null
      }
      used.set(address, 0)
      refused.set(address, (refused.get(address) ?? 0) + 1)
      return quota.retryAfter === undefined ? {} : { retryAfter: quota.retryAfter }
    },
    refusals: (address: string) => refused.get(address) ?? 0,
  }
}
