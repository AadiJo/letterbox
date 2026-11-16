// Gmail's usage limits, as the fake models them. Each call costs the quota units on
// Google's quota page: https://developers.google.com/workspace/gmail/api/reference/quota
//
// Real Gmail counts units per user per minute. The fake has no clock, so a scenario sets a
// budget per window instead, and a window ends when the fake refuses a call: the client
// was told to wait, and the fake takes it that the minute passed while it waited. A budget
// of 0 refuses every call, however many windows pass.

/** A 403 for one limit, in the shape the handle-errors guide shows. https://developers.google.com/workspace/gmail/api/guides/handle-errors */
const refusal = (reason: string, message: string) => ({
  status: 403,
  body: {
    error: { code: 403, message, errors: [{ message, domain: 'usageLimits', reason }], status: 'PERMISSION_DENIED' },
  },
})

/** What Gmail answers a call over each limit. */
const REFUSALS = {
  // The 403 a live run got when it went over its per-user limit.
  rateLimitExceeded: refusal(
    'rateLimitExceeded',
    "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.",
  ),
  // The guide's samples. A per-user limit is waited out. A daily one needs more quota for the project.
  userRateLimitExceeded: refusal('userRateLimitExceeded', 'User Rate Limit Exceeded'),
  dailyLimitExceeded: refusal('dailyLimitExceeded', 'Daily Limit Exceeded'),
  // The guide gives a 429 its message but no body, so this one names no reason and the status alone says it.
  tooManyRequests: {
    status: 429,
    body: {
      error: {
        code: 429,
        message: 'Too many requests: Too many concurrent requests for user',
        status: 'RESOURCE_EXHAUSTED',
      },
    },
  },
}

/** A limit a scenario sets on one account. */
export type Quota = {
  /** Units one window allows. */
  units: number
  /** Seconds to name in a Retry-After header on each refusal. The live 403 named none. */
  retryAfter?: number
  /** Which limit a refusal reports. The per-user rate limit unless set. */
  reason?: keyof typeof REFUSALS
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
     * refused, the window ends, and this returns the status, body and Retry-After seconds to send.
     */
    charge: (address: string, units: number): { status: number; body: unknown; retryAfter?: number } | null => {
      const quota = limits.get(address)
      if (!quota) return null
      const spent = (used.get(address) ?? 0) + units
      if (spent <= quota.units) {
        used.set(address, spent)
        return null
      }
      used.set(address, 0)
      refused.set(address, (refused.get(address) ?? 0) + 1)
      const answer = REFUSALS[quota.reason ?? 'rateLimitExceeded']
      return quota.retryAfter === undefined ? answer : { ...answer, retryAfter: quota.retryAfter }
    },
    refusals: (address: string) => refused.get(address) ?? 0,
  }
}
