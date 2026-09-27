/**
 * Studio's sign-in on the unit host: accounts an operator made, tokens, role
 * grants and their two rules, login throttling, anonymous viewers, and
 * gateway mode.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import StudioAuthService, { type Config, type StudioAuthResult } from '@lyteboat/studio-auth'
import { hashStudioPassword, readStudioAccounts, setStudioAccount, setStudioGrant, verifyStudioPassword } from '@lyteboat/studio-auth/accounts'
import { issueStudioToken, studioTokenSecret, verifyStudioToken } from '../src/studio-token.ts'

async function authHost(config: Config, env: Record<string, string> = {}): Promise<Context> {
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  // The credentials service resolves a reference to its value; here, from a fixed table.
  ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(env[ref] === undefined ? undefined : { value: env[ref] }) } as never)
  await ctx.plugin(StudioAuthService, config)
  return ctx
}

function valueOf<T>(result: StudioAuthResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  return result.value
}

describe('Studio accounts', () => {
  it('stores a scrypt hash, never the password, in a file only its owner reads', () => {
    const dir = lyteboatTempDir('studio-auth')

    const account = setStudioAccount(dir, 'alice', { password: 'correct horse', displayName: 'Alice' })

    expect(account).toMatchObject({ userId: 'alice', displayName: 'Alice' })
    expect(account.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/u)
    expect(JSON.stringify(readStudioAccounts(dir))).not.toContain('correct horse')
    expect(verifyStudioPassword('correct horse', account.passwordHash)).toBe(true)
    expect(verifyStudioPassword('wrong', account.passwordHash)).toBe(false)
    expect(statSync(join(dir, 'accounts.json')).mode & 0o777).toBe(0o600)
  })

  it('refuses a username with spaces or slashes, and an empty password', () => {
    const dir = lyteboatTempDir('studio-auth')

    expect(() => setStudioAccount(dir, 'a b', { password: 'x' })).toThrow('is not a username')
    expect(() => setStudioAccount(dir, '../x', { password: 'x' })).toThrow('is not a username')
    expect(() => setStudioAccount(dir, 'alice', { password: '' })).toThrow('the password is empty')
  })
})

describe('Studio tokens', () => {
  it('name their user until they expire, and a changed payload or signature is no token', () => {
    const secret = studioTokenSecret(lyteboatTempDir('studio-auth'))
    const { token } = issueStudioToken(secret, 'alice', 1000, 60_000)
    const [payload, signature] = token.split('.')
    const forged = `${Buffer.from(JSON.stringify({ sub: 'root', iat: 1000, exp: 61_000 })).toString('base64url')}.${signature ?? ''}`

    expect(verifyStudioToken(secret, token, 2000)).toBe('alice')
    expect(verifyStudioToken(secret, token, 61_000)).toBeUndefined()
    expect(verifyStudioToken(secret, forged, 2000)).toBeUndefined()
    expect(verifyStudioToken(secret, `${payload ?? ''}.x`, 2000)).toBeUndefined()
  })
})

describe('the studioAuth service (internal mode)', () => {
  it('signs in an account with a role and answers who its token speaks for', async () => {
    const dir = lyteboatTempDir('studio-auth')
    setStudioAccount(dir, 'alice', { password: 'pw-alice', displayName: 'Alice' })
    setStudioGrant(dir, 'alice', 'editor', 'cli')
    const ctx = await authHost({ dir })

    const login = valueOf(ctx.studioAuth.login('alice', 'pw-alice', '127.0.0.1'))
    const principal = valueOf(await ctx.studioAuth.principal({ authorization: `Bearer ${login.token ?? ''}` }))

    expect(login).toMatchObject({ userId: 'alice', displayName: 'Alice', role: 'editor' })
    expect(principal).toEqual({ userId: 'alice', displayName: 'Alice', role: 'editor' })
    expect(ctx.studioAuth.mode()).toEqual({ mode: 'internal', loginRequired: true, anonymousViewer: false })
  })

  it('answers an unknown user and a wrong password the same way, and locks the pair after five failures', async () => {
    const dir = lyteboatTempDir('studio-auth')
    setStudioAccount(dir, 'alice', { password: 'pw-alice' })
    setStudioGrant(dir, 'alice', 'viewer', 'cli')
    const ctx = await authHost({ dir })

    const unknown = ctx.studioAuth.login('mallory', 'x', '10.0.0.9', 1000)
    const failures = [1, 2, 3, 4, 5].map(n => ctx.studioAuth.login('alice', 'wrong', '10.0.0.9', 1000 + n))
    const locked = ctx.studioAuth.login('alice', 'pw-alice', '10.0.0.9', 2000)
    const otherAddress = ctx.studioAuth.login('alice', 'pw-alice', '10.0.0.8', 2000)
    const later = ctx.studioAuth.login('alice', 'pw-alice', '10.0.0.9', 40_000)

    expect(unknown).toEqual({ ok: false, code: 'unauthorized', message: 'wrong username or password' })
    expect(failures.at(-1)).toEqual(unknown)
    expect(locked).toMatchObject({ ok: false, code: 'too_many_requests' })
    expect(otherAddress.ok).toBe(true)
    expect(later.ok).toBe(true)
  })

  it('refuses a request without a token unless anonymous viewers are allowed, and an account without a role', async () => {
    const dir = lyteboatTempDir('studio-auth')
    setStudioAccount(dir, 'bob', { password: 'pw-bob' })
    const strict = await authHost({ dir })
    const open = await authHost({ dir, anonymousViewer: true })

    expect(await strict.studioAuth.principal({})).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(await open.studioAuth.principal({})).toEqual({ ok: true, value: { userId: 'anonymous', displayName: 'Anonymous', role: 'viewer' } })
    expect(strict.studioAuth.login('bob', 'pw-bob', '127.0.0.1')).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('keeps an admin from changing their own role, and the last admin an admin', async () => {
    const dir = lyteboatTempDir('studio-auth')
    setStudioGrant(dir, 'root', 'admin', 'cli')
    const ctx = await authHost({ dir })

    const self = ctx.studioAuth.grant('root', 'root', 'viewer')
    const promoted = ctx.studioAuth.grant('root', 'ops', 'admin')
    const demoteRoot = ctx.studioAuth.grant('ops', 'root', 'editor')
    const lastAdmin = ctx.studioAuth.revoke('root', 'ops')
    const again = ctx.studioAuth.revoke('ops', 'root')

    expect(self).toMatchObject({ ok: false, code: 'conflict', message: 'you cannot change or revoke your own role' })
    expect(promoted).toMatchObject({ ok: true, value: { userId: 'ops', role: 'admin', createdBy: 'root' } })
    expect(demoteRoot.ok).toBe(true)
    expect(lastAdmin).toMatchObject({ ok: false, code: 'conflict', message: 'the last admin cannot lose the admin role' })
    expect(again).toMatchObject({ ok: true, value: { userId: 'root', role: 'editor' } })
    expect(ctx.studioAuth.grants({ limit: 50, offset: 0 })).toMatchObject({ total: 1, adminCount: 1, users: [{ userId: 'ops', role: 'admin' }] })
  })
})

describe('the studioAuth service (gateway mode)', () => {
  const gateway = { secretRef: 'STUDIO_GATEWAY_SECRET' }

  it('trusts the gateway\'s headers only with its secret, grants a new identity viewer, and makes the configured admins', async () => {
    const dir = lyteboatTempDir('studio-auth')
    const ctx = await authHost({ dir, gateway, admins: ['boss'] }, { STUDIO_GATEWAY_SECRET: 's3cret' })

    const missing = await ctx.studioAuth.principal({ 'x-gateway-user-id': 'eve' })
    const wrong = await ctx.studioAuth.principal({ 'x-gateway-secret': 'guess', 'x-gateway-user-id': 'eve' })
    const newcomer = await ctx.studioAuth.principal({ 'x-gateway-secret': 's3cret', 'x-gateway-user-id': 'carol', 'x-gateway-display-name': 'Carol' })
    const boss = await ctx.studioAuth.principal({ 'x-gateway-secret': 's3cret', 'x-gateway-user-id': 'boss' })

    expect(missing).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(wrong).toMatchObject({ ok: false, code: 'unauthorized' })
    expect(newcomer).toEqual({ ok: true, value: { userId: 'carol', displayName: 'Carol', role: 'viewer' } })
    expect(boss).toMatchObject({ ok: true, value: { role: 'admin' } })
    expect(ctx.studioAuth.login('carol', 'x', '127.0.0.1')).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(ctx.studioAuth.mode()).toEqual({ mode: 'gateway', loginRequired: false, anonymousViewer: false })
  })

  it('refuses anonymous viewers in gateway mode', async () => {
    await expect(authHost({ dir: lyteboatTempDir('studio-auth'), gateway, anonymousViewer: true })).rejects.toThrow('anonymousViewer is for internal mode')
  })
})

describe('hashStudioPassword', () => {
  it('salts every hash', () => {
    expect(hashStudioPassword('same')).not.toBe(hashStudioPassword('same'))
  })
})
