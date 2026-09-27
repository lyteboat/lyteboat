/**
 * The sign-in and Users endpoints: `auth/config`, `auth/login`,
 * `auth/session`, and `auth/logout` for everyone; `users` (list, grant,
 * revoke) for admins. A failed login and every grant change is audited.
 * @module @lyteboat/studio-api/studio-auth-routes
 */

import { STUDIO_ROLES, studioGrantRequestSchema, studioLoginRequestSchema, type StudioPrincipal, type StudioRole } from '@lyteboat/contracts/studio'
import type { StudioAuthService } from '@lyteboat/studio-auth'
import type { z } from 'zod'
import type { StudioAudit } from './studio-audit.ts'
import { StudioApiError, studioSchemaProblems, studioValueOf, type StudioApiCall, type StudioApiRoute } from './studio-api-router.ts'

const USERS_PAGE_LIMIT = 200

/** Parse a body against its request schema; a failure names every issue. */
export async function studioRequestOf<T>(call: StudioApiCall, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await call.body())
  if (!parsed.success) throw new StudioApiError('invalid_request', studioSchemaProblems(parsed.error, '(the body)'))
  return parsed.data
}

/** The caller of a route that is not public. */
export function studioCallerOf(call: StudioApiCall): StudioPrincipal {
  if (call.principal === undefined) throw new StudioApiError('unauthorized', 'sign in first')
  return call.principal
}

/** A whole-number query parameter up to `max`, or `fallback` when absent. */
export function studioWholeNumberOf(query: URLSearchParams, name: string, fallback: number, max: number): number {
  const text = query.get(name)
  if (text === null) return fallback
  const value = Number(text)
  if (!/^\d+$/u.test(text) || value > max) throw new StudioApiError('invalid_request', `${name} must be a whole number up to ${String(max)}`)
  return value
}

function roleOf(query: URLSearchParams): StudioRole | undefined {
  const role = query.get('role')
  if (role === null || role === '') return undefined
  const known = STUDIO_ROLES.find(candidate => candidate === role)
  if (known === undefined) throw new StudioApiError('invalid_request', `role must be one of ${STUDIO_ROLES.join(', ')}`)
  return known
}

/**
 * The routes.
 * @param auth - the studioAuth service.
 * @param audit - the audit log.
 */
export function studioAuthRoutes(auth: StudioAuthService, audit: StudioAudit): StudioApiRoute[] {
  return [
    { method: 'GET', path: 'auth/config', access: 'public', handle: () => auth.mode() },
    {
      method: 'POST', path: 'auth/login', access: 'public',
      handle: async (call) => {
        const { username, password } = await studioRequestOf(call, studioLoginRequestSchema)
        const result = auth.login(username, password, call.from)
        if (!result.ok && result.code === 'unauthorized') await audit.record({ actor: username, action: 'login.failed', from: call.from })
        return studioValueOf(result)
      },
    },
    { method: 'GET', path: 'auth/session', access: 'viewer', handle: call => studioCallerOf(call) },
    // Tokens are signed, not stored: signing out is the page forgetting its token.
    { method: 'POST', path: 'auth/logout', access: 'public', handle: () => ({}) },
    {
      method: 'GET', path: 'users', access: 'admin',
      handle: (call) => {
        const text = call.query.get('text') ?? ''
        const role = roleOf(call.query)
        return auth.grants({
          ...text === '' ? {} : { text },
          ...role === undefined ? {} : { role },
          limit: studioWholeNumberOf(call.query, 'limit', 50, USERS_PAGE_LIMIT),
          offset: studioWholeNumberOf(call.query, 'offset', 0, Number.MAX_SAFE_INTEGER),
        })
      },
    },
    {
      method: 'POST', path: 'users', access: 'admin',
      handle: async (call) => {
        const actor = studioCallerOf(call).userId
        const { userId, role } = await studioRequestOf(call, studioGrantRequestSchema)
        const grant = studioValueOf(auth.grant(actor, userId, role))
        await audit.record({ actor, action: 'grant.set', userId, role })
        return grant
      },
    },
    {
      method: 'DELETE', path: 'users/:id', access: 'admin',
      handle: async (call) => {
        const actor = studioCallerOf(call).userId
        const revoked = studioValueOf(auth.revoke(actor, call.params['id'] ?? ''))
        await audit.record({ actor, action: 'grant.remove', userId: revoked.userId, role: revoked.role })
        return revoked
      },
    },
  ]
}
