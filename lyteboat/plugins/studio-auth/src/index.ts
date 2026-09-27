/**
 * @lyteboat/studio-auth — who a Studio request speaks for. In internal mode
 * people sign in with an account an operator made (`lyteboat studio account
 * add`), get a bearer token, and act with the role their grant gives; a request
 * without a token is refused unless anonymous viewers are allowed. In gateway
 * mode an authorizing gateway puts a shared secret and the user's id on every
 * request; a request without them is refused, and an identity seen for the
 * first time is granted viewer. Roles are admin, editor, and viewer; through
 * Studio nobody changes their own grant and the last admin stays an admin.
 * Every answer is a result, never a thrown refusal, so callers need only this
 * package's types.
 * @module @lyteboat/studio-auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { StudioAuthConfigAnswer, StudioErrorCode, StudioGrant, StudioLoginAnswer, StudioPrincipal, StudioRole, StudioUsersAnswer } from '@lyteboat/contracts/studio'
import { hashStudioPassword, readStudioAccounts, verifyStudioPassword } from './studio-accounts.ts'
import { readStudioGrants, setStudioGrant, studioGrantConflict, writeStudioGrants } from './studio-grants.ts'
import { StudioLoginThrottle } from './studio-login-throttle.ts'
import { issueStudioToken, studioTokenSecret, verifyStudioToken } from './studio-token.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    studioAuth: StudioAuthService
  }
}

/** An answer, or why there is none. */
export type StudioAuthResult<T> = { ok: true; value: T } | { ok: false; code: StudioErrorCode; message: string }

/** The request headers principal() reads, lower-cased as node:http gives them. */
export type StudioAuthHeaders = Readonly<Record<string, string | string[] | undefined>>

/** Gateway mode's settings. */
export interface StudioGatewayConfig {
  /** The credential reference (environment variable) that holds the shared secret. */
  secretRef: string
  secretHeader?: string
  userHeader?: string
  nameHeader?: string
}

export interface Config {
  /** Where accounts, grants, and the token secret live; default `$LYTEBOAT_HOME/studio`. */
  dir?: string
  /** Present: gateway mode. */
  gateway?: StudioGatewayConfig
  /** User ids made admins at startup: the first admin of a gateway-mode Studio. */
  admins?: string[]
  /** Whether a request without a token reads as an anonymous viewer (internal mode only). */
  anonymousViewer?: boolean
  /** How long a token lasts. */
  tokenTtlMs?: number
  /** Failed logins before a username and address pair is locked, and for how long. */
  loginFailureLimit?: number
  loginLockMs?: number
}

const Config: z<Config> = z.object({
  dir: z.string(),
  // A one-member union, so an absent gateway stays absent: a schemastery object defaults to {}.
  gateway: z.union([z.object({
    secretRef: z.string().required(),
    secretHeader: z.string().default('x-gateway-secret'),
    userHeader: z.string().default('x-gateway-user-id'),
    nameHeader: z.string().default('x-gateway-display-name'),
  })]),
  admins: z.array(z.string()).default([]),
  anonymousViewer: z.boolean().default(false),
  tokenTtlMs: z.natural().default(12 * 60 * 60 * 1000),
  loginFailureLimit: z.natural().default(5),
  loginLockMs: z.natural().default(30_000),
})

const ANONYMOUS: StudioPrincipal = { userId: 'anonymous', displayName: 'Anonymous', role: 'viewer' }

// One message for an unknown user and a wrong password, so the answer does not tell which usernames exist.
const WRONG_LOGIN = 'wrong username or password'

// A hash to verify against when the username is unknown, so both paths cost one scrypt.
const DECOY_HASH = hashStudioPassword(randomBytes(16).toString('hex'))

const refuse = <T>(code: StudioErrorCode, message: string): StudioAuthResult<T> => ({ ok: false, code, message })

function headerOf(headers: StudioAuthHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Host service: sign-in, the principal of a request, and role grants. */
export class StudioAuthService extends Service {
  static inject = ['credentials']
  // The loader applies a class plugin's static Config, not the module's.
  static Config = Config

  private readonly dir: string
  private readonly throttle: StudioLoginThrottle

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'studioAuth')
    this.dir = config.dir ?? dshHomePath('studio')
    this.throttle = new StudioLoginThrottle(config.loginFailureLimit ?? 5, config.loginLockMs ?? 30_000)
    if (config.gateway !== undefined && config.anonymousViewer === true) throw new Error('studio-auth: anonymousViewer is for internal mode; a gateway authenticates every request')
    for (const admin of config.admins ?? []) {
      if (readStudioGrants(this.dir)[admin]?.role !== 'admin') setStudioGrant(this.dir, admin, 'admin', 'startup')
    }
  }

  /** How this Studio signs people in. */
  mode(): StudioAuthConfigAnswer {
    const gateway = this.config.gateway !== undefined
    return { mode: gateway ? 'gateway' : 'internal', loginRequired: !gateway, anonymousViewer: !gateway && this.config.anonymousViewer === true }
  }

  /**
   * Sign in with an account's username and password (internal mode).
   * @param from - the caller's address, for throttling.
   */
  login(username: string, password: string, from: string, now = Date.now()): StudioAuthResult<StudioLoginAnswer> {
    if (this.config.gateway !== undefined) return refuse('invalid_request', 'this Studio signs people in through its gateway')
    if (this.throttle.locked(username, from, now)) return refuse('too_many_requests', 'too many failed logins; wait and try again')
    const account = readStudioAccounts(this.dir)[username]
    const matches = verifyStudioPassword(password, account?.passwordHash ?? DECOY_HASH)
    if (account === undefined || !matches) {
      this.throttle.fail(username, from, now)
      return refuse('unauthorized', WRONG_LOGIN)
    }
    this.throttle.succeed(username, from)
    const grant = readStudioGrants(this.dir)[account.userId]
    if (grant === undefined) return refuse('forbidden', `${account.userId} has no Studio role; ask an admin to grant one`)
    const { token, expiresAt } = issueStudioToken(studioTokenSecret(this.dir), account.userId, now, this.config.tokenTtlMs ?? 12 * 60 * 60 * 1000)
    return { ok: true, value: { userId: account.userId, displayName: account.displayName, role: grant.role, token, expiresAt } }
  }

  /** Who a request speaks for, from its bearer token or its gateway headers. */
  async principal(headers: StudioAuthHeaders, now = Date.now()): Promise<StudioAuthResult<StudioPrincipal>> {
    if (this.config.gateway !== undefined) return this.gatewayPrincipal(headers, this.config.gateway)
    const token = /^Bearer (.+)$/u.exec(headerOf(headers, 'authorization') ?? '')?.[1]
    if (token === undefined) return this.config.anonymousViewer === true ? { ok: true, value: ANONYMOUS } : refuse('unauthorized', 'sign in first')
    const userId = verifyStudioToken(studioTokenSecret(this.dir), token, now)
    if (userId === undefined) return refuse('unauthorized', 'the sign-in has expired or is not valid; sign in again')
    const grant = readStudioGrants(this.dir)[userId]
    if (grant === undefined) return refuse('forbidden', `${userId} has no Studio role`)
    const displayName = Object.values(readStudioAccounts(this.dir)).find(account => account.userId === userId)?.displayName ?? userId
    return { ok: true, value: { userId, displayName, role: grant.role } }
  }

  /**
   * One page of grants.
   * @param query - a user-id substring, a role, and the page.
   */
  grants(query: { text?: string; role?: StudioRole; limit: number; offset: number }): StudioUsersAnswer {
    const text = query.text?.toLowerCase() ?? ''
    const grants = Object.values(readStudioGrants(this.dir))
    const matching = grants
      .filter(grant => grant.userId.toLowerCase().includes(text) && (query.role === undefined || grant.role === query.role))
      .sort((a, b) => a.userId.localeCompare(b.userId))
    return { users: matching.slice(query.offset, query.offset + query.limit), total: matching.length, adminCount: grants.filter(grant => grant.role === 'admin').length }
  }

  /** Grant a role, or change one, as `actor`. */
  grant(actor: string, userId: string, role: StudioRole): StudioAuthResult<StudioGrant> {
    const grants = readStudioGrants(this.dir)
    const conflict = studioGrantConflict(grants, actor, userId, role)
    if (conflict !== undefined) return refuse('conflict', conflict)
    return { ok: true, value: setStudioGrant(this.dir, userId, role, actor) }
  }

  /** Revoke a grant as `actor`. */
  revoke(actor: string, userId: string): StudioAuthResult<StudioGrant> {
    const grants = readStudioGrants(this.dir)
    const target = grants[userId]
    if (target === undefined) return refuse('not_found', `${userId} has no Studio role`)
    const conflict = studioGrantConflict(grants, actor, userId, undefined)
    if (conflict !== undefined) return refuse('conflict', conflict)
    writeStudioGrants(this.dir, Object.fromEntries(Object.entries(grants).filter(([id]) => id !== userId)))
    return { ok: true, value: target }
  }

  private async gatewayPrincipal(headers: StudioAuthHeaders, gateway: StudioGatewayConfig): Promise<StudioAuthResult<StudioPrincipal>> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(gateway.secretRef))
    if (resolved === undefined) return refuse('internal', 'the gateway secret is not configured')
    const given = Buffer.from(headerOf(headers, gateway.secretHeader ?? 'x-gateway-secret') ?? '')
    const expected = Buffer.from(resolved.value)
    if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) return refuse('unauthorized', 'not signed in through the gateway')
    const userId = headerOf(headers, gateway.userHeader ?? 'x-gateway-user-id') ?? ''
    if (userId === '') return refuse('unauthorized', 'the gateway sent no user id')
    const grant = readStudioGrants(this.dir)[userId] ?? setStudioGrant(this.dir, userId, 'viewer', 'gateway')
    return { ok: true, value: { userId, displayName: headerOf(headers, gateway.nameHeader ?? 'x-gateway-display-name') ?? userId, role: grant.role } }
  }
}

export default StudioAuthService
