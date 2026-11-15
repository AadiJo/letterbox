// The fake's side of OAuth 2.0 for installed apps: the consent page (played by a
// scenario through approve and deny), the browser's redirect to the app's loopback,
// and the token endpoint. https://developers.google.com/identity/protocols/oauth2/native-app
//
// Consent never loads in a browser. The scenario hands the fake the URL the core told
// the UI to open, and the fake does what Google and the browser would: it checks the
// request, then sends the redirect to `redirect_uri`. A redirect URI names
// 127.0.0.1:<port>, and the app listens for it on the unix socket <redirects>/<port>.sock
// (see Loopback::Unix in crates/gmail), so the port in the URL stays the same every run.

import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { join } from 'node:path'

export const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** A code waiting to be traded for tokens. */
type Grant = {
  clientId: string
  redirectUri: string
  challenge: string
  address: string
  /** What the user granted, which may be less than the app asked for. */
  scope: string
  used: boolean
}

/** A refresh token and the account it opens. */
type Refresh = { address: string; scope: string; revoked: boolean }

/** What the token endpoint answers: a status and a JSON body. */
export type TokenAnswer = { status: number; body: Record<string, unknown> }

const invalidGrant: TokenAnswer = {
  status: 400,
  body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
}

/** Reads the consent request out of a URL the core opened. Throws if the request is one Google would refuse. */
const consentOf = (url: string) => {
  const params = new URL(url).searchParams
  const read = (name: string): string => {
    const value = params.get(name)
    if (!value) throw new Error(`fake gmail: the consent URL has no ${name}: ${url}`)
    return value
  }
  if (read('response_type') !== 'code') throw new Error(`fake gmail: response_type must be "code": ${url}`)
  if (read('code_challenge_method') !== 'S256') throw new Error(`fake gmail: PKCE must use S256: ${url}`)
  const redirectUri = read('redirect_uri')
  const port = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(redirectUri)?.[1]
  if (!port) throw new Error(`fake gmail: redirect_uri must be http://127.0.0.1:<port>: ${redirectUri}`)
  return {
    clientId: read('client_id'),
    redirectUri,
    port,
    challenge: read('code_challenge'),
    state: read('state'),
    scope: read('scope'),
  }
}

/** Builds the fake's OAuth half. `redirects` is the folder of loopback sockets; `remember` records each token handed out. */
export const createOauth = (redirects: string, remember: (value: string) => void) => {
  const grants = new Map<string, Grant>()
  const refreshTokens = new Map<string, Refresh>()
  /** Access token to address. A token missing here is expired or was never issued. */
  const accessTokens = new Map<string, string>()
  const refreshes = new Map<string, number>()
  /** Every refresh and access token issued. They are secrets: none may reach the core's store. */
  const secrets = new Set<string>()
  let minted = 0

  /** Plays the browser: sends the redirect to the app's loopback. An attempt that has stopped listening misses it. */
  const redirect = (port: string, query: Record<string, string>): void => {
    const path = `/?${new URLSearchParams(query).toString()}`
    const call = request({ socketPath: join(redirects, `${port}.sock`), path, method: 'GET' }, (response) =>
      response.resume(),
    )
    call.on('error', () => {})
    call.end()
  }

  const mintAccess = (address: string): string => {
    const token = `fake-access-${++minted}`
    accessTokens.set(token, address)
    remember(token)
    secrets.add(token)
    return token
  }

  return {
    /** The consent page, approved by `address`, whose scope decides what the app may do. */
    approve: (url: string, address: string, scope: string): void => {
      const consent = consentOf(url)
      if (!consent.scope.split(' ').includes(MODIFY_SCOPE))
        throw new Error(`fake gmail: the app asked for ${consent.scope}, not ${MODIFY_SCOPE}`)
      const code = `fake-code-${++minted}`
      grants.set(code, { ...consent, address, scope, used: false })
      redirect(consent.port, { code, state: consent.state })
    },
    deny: (url: string): void => {
      const consent = consentOf(url)
      redirect(consent.port, { error: 'access_denied', state: consent.state })
    },
    /** The address an access token opens, or null if it is expired, revoked or unknown. */
    addressOf: (header: string | undefined): string | null => {
      const token = /^Bearer (.+)$/.exec(header ?? '')?.[1]
      return token === undefined ? null : (accessTokens.get(token) ?? null)
    },
    /** The account a token request is for, so the server can answer offline for it. Null if it names none. */
    accountOf: (form: URLSearchParams): string | null =>
      grants.get(form.get('code') ?? '')?.address ??
      refreshTokens.get(form.get('refresh_token') ?? '')?.address ??
      null,
    /** The token endpoint. */
    token: (form: URLSearchParams): TokenAnswer => {
      const grantType = form.get('grant_type')
      if (grantType === 'authorization_code') {
        const code = form.get('code') ?? ''
        const grant = grants.get(code)
        const verifier = form.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        const matches =
          grant !== undefined &&
          !grant.used &&
          grant.clientId === form.get('client_id') &&
          grant.redirectUri === form.get('redirect_uri') &&
          grant.challenge === challenge
        if (!matches) return invalidGrant
        grant.used = true
        const { scope } = grant
        const refreshToken = `fake-refresh-${++minted}`
        refreshTokens.set(refreshToken, { address: grant.address, scope, revoked: false })
        remember(refreshToken)
        secrets.add(refreshToken)
        const body = { access_token: mintAccess(grant.address), expires_in: 3599, refresh_token: refreshToken, scope }
        return { status: 200, body: { ...body, token_type: 'Bearer' } }
      }
      if (grantType === 'refresh_token') {
        const refresh = refreshTokens.get(form.get('refresh_token') ?? '')
        if (refresh === undefined || refresh.revoked) return invalidGrant
        refreshes.set(refresh.address, (refreshes.get(refresh.address) ?? 0) + 1)
        const body = { access_token: mintAccess(refresh.address), expires_in: 3599, scope: refresh.scope }
        return { status: 200, body: { ...body, token_type: 'Bearer' } }
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } }
    },
    /** Every access token stops working, as if an hour had passed. */
    expireAccessTokens: (): void => accessTokens.clear(),
    /** The user removes the app's access: every token for `address` stops working. */
    revoke: (address: string): void => {
      for (const refresh of refreshTokens.values()) if (refresh.address === address) refresh.revoked = true
      for (const [token, owner] of accessTokens) if (owner === address) accessTokens.delete(token)
    },
    refreshes: (address: string): number => refreshes.get(address) ?? 0,
    secrets: (): ReadonlySet<string> => secrets,
  }
}
