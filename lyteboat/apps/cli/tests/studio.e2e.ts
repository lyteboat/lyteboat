/**
 * `lyteboat studio` on the built launcher: an operator makes, lists, changes,
 * and removes accounts with the password on stdin; the Studio refuses to start
 * without one, serves `/api/studio` and the built pages once there is one
 * (sign-in, the agent radar, the page's script), and stops cleanly on SIGTERM; it
 * starts an agent's eval run as a process of its own launcher's bin; flags
 * that would widen who can reach it are usage errors.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { scriptedModelEnv, startScriptedModel, withTitle } from '@lyteboat/testkit/scripted-model'
import { runLyteboat, startLyteboat } from './support/lyteboat-process.ts'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

describe('lyteboat studio (built bin)', () => {
  const scratch = createLyteboatScratch('studio-smoke')

  afterAll(() => { scratch.remove() })

  it('manages accounts from stdin, serves the Studio once one exists, and stops cleanly on SIGTERM', async () => {
    const { home, workspace } = scratch.run('studio')
    const env = { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1' }

    const empty = await runLyteboat(['studio', '--agents', AGENTS, '--port', '0'], { cwd: workspace, env })
    const added = await runLyteboat(['studio', 'account', 'add', 'root', '--role', 'admin', '--display-name', 'Root'], { cwd: workspace, env, input: 'first-pw\n' })
    const again = await runLyteboat(['studio', 'account', 'add', 'root', '--role', 'viewer'], { cwd: workspace, env, input: 'x\n' })
    const changed = await runLyteboat(['studio', 'account', 'set-password', 'root'], { cwd: workspace, env, input: 'second-pw\n' })
    const listed = await runLyteboat(['studio', 'account', 'list'], { cwd: workspace, env })

    expect(empty.code).toBe(1)
    expect(empty.stderr).toContain('this Studio has no accounts to sign in with; make the first one with: lyteboat studio account add')
    expect(added).toMatchObject({ code: 0, stdout: 'lyteboat studio: account root (user root) added as admin\n' })
    expect(again.code).toBe(1)
    expect(again.stderr).toContain('error: account root exists; change its password with lyteboat studio account set-password root')
    expect(changed).toMatchObject({ code: 0, stdout: 'lyteboat studio: password of root set\n' })
    expect(listed.stdout).toBe('username\tuser id\tdisplay name\trole\nroot\troot\tRoot\tadmin\n')
    for (const printed of [added.stdout, changed.stdout, listed.stdout]) expect(printed).not.toMatch(/first-pw|second-pw|scrypt/u)

    const studio = startLyteboat(['studio', '--agents', AGENTS, '--port', '0'], { cwd: workspace, env })
    try {
      const origin = (await studio.waitForStdout(/lyteboat studio: (http:\/\/127\.0\.0\.1:\d+)\/studio\/ \(internal sign-in\)/u, 90_000))[1] ?? ''
      await studio.waitForStdout(/^lyteboat studio: agents echo$/mu, 30_000)
      const stale = await fetch(`${origin}/api/studio/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'first-pw' }) })
      const login = await fetch(`${origin}/api/studio/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'second-pw' }) })
      const { token } = await login.json() as { token: string }
      const agents = await fetch(`${origin}/api/studio/agents`, { headers: { authorization: `Bearer ${token}` } })
      const page = await fetch(`${origin}/studio/`)
      const script = /src="(\/studio\/assets\/[^"]+\.js)"/u.exec(await page.text())?.[1] ?? ''
      const bundle = await fetch(`${origin}${script}`)

      expect(stale.status).toBe(401)
      expect(login.status).toBe(200)
      expect(await agents.json()).toMatchObject({ agents: [{ id: 'echo', deviates: false }], failures: [] })
      expect(bundle.status, script).toBe(200)
      expect(bundle.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    } finally {
      const code = await studio.stop('SIGTERM')
      expect(code, studio.output()).toBe(0)
    }

    const removed = await runLyteboat(['studio', 'account', 'remove', 'root'], { cwd: workspace, env })
    expect(removed).toMatchObject({ code: 0, stdout: 'lyteboat studio: account root removed\n' })
  })

  it('starts an agent\'s eval run as a process of its own launcher\'s bin, and shows it passed', async () => {
    const { home, workspace } = scratch.run('evals')
    const model = await startScriptedModel(withTitle(() => ({ text: 'SMOKE-OK' })), { apiKey: 'mock-key' })
    const env = { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...scriptedModelEnv(model) }
    await runLyteboat(['studio', 'account', 'add', 'root', '--role', 'admin'], { cwd: workspace, env, input: 'pw\n' })
    const studio = startLyteboat(['studio', '--agents', AGENTS, '--port', '0'], { cwd: workspace, env })
    try {
      const origin = (await studio.waitForStdout(/lyteboat studio: (http:\/\/127\.0\.0\.1:\d+)\/studio\/ \(internal sign-in\)/u, 90_000))[1] ?? ''
      const login = await fetch(`${origin}/api/studio/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'pw' }) })
      const headers = { authorization: `Bearer ${(await login.json() as { token: string }).token}`, 'content-type': 'application/json' }

      const started = await (await fetch(`${origin}/api/studio/evals/runs`, { method: 'POST', headers, body: JSON.stringify({ agentId: 'echo', mode: 'real' }) })).json() as { runId: string }
      const run = await vi.waitFor(async () => {
        const detail = await (await fetch(`${origin}/api/studio/evals/runs/${started.runId}`, { headers })).json() as { run: { status: string } }
        expect(detail.run.status).not.toBe('running')
        return detail
      }, { timeout: 90_000, interval: 250 })

      expect(run).toMatchObject({ run: { status: 'passed', mode: 'real', startedBy: 'root', cases: { total: 1, passed: 1 } }, cases: [{ caseId: 'smoke', pass: true }] })
    } finally {
      expect(await studio.stop('SIGTERM'), studio.output()).toBe(0)
      await model.close()
    }
  })

  it('refuses flags that would let the wrong people in', async () => {
    const { home, workspace } = scratch.run('usage')
    const env = { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1' }

    const everyInterface = await runLyteboat(['studio', '--agents', AGENTS, '--host', '0.0.0.0'], { cwd: workspace, env })
    const anonymousOut = await runLyteboat(['studio', '--agents', AGENTS, '--host', '0.0.0.0', '--trusted-host', 'studio.example', '--anonymous-viewer'], { cwd: workspace, env })
    const unsetSecret = await runLyteboat(['studio', '--agents', AGENTS, '--gateway-secret-env', 'STUDIO_E2E_UNSET_SECRET'], { cwd: workspace, env })
    const adminWithoutGateway = await runLyteboat(['studio', '--agents', AGENTS, '--admin', 'alice'], { cwd: workspace, env })
    const noPassword = await runLyteboat(['studio', 'account', 'add', 'root', '--role', 'admin'], { cwd: workspace, env })
    const badRole = await runLyteboat(['studio', 'account', 'add', 'root', '--role', 'owner'], { cwd: workspace, env, input: 'pw\n' })

    expect(everyInterface.stderr).toContain('error: --host 0.0.0.0 needs --trusted-host')
    expect(anonymousOut.stderr).toContain('error: --anonymous-viewer serves only 127.0.0.1')
    expect(unsetSecret.stderr).toContain('error: --gateway-secret-env names STUDIO_E2E_UNSET_SECRET, which is not set')
    expect(adminWithoutGateway.stderr).toContain('error: --admin is for gateway mode')
    expect(noPassword.stderr).toContain('error: the password on stdin is empty')
    expect(badRole.stderr).toContain('error: --role must be one of admin, editor, viewer')
    for (const result of [everyInterface, anonymousOut, unsetSecret, adminWithoutGateway, noPassword, badRole]) expect(result.code).toBe(1)
  })

  it('serves behind a gateway without accounts, trusting only requests that carry its secret', async () => {
    const { home, workspace } = scratch.run('gateway')
    const studio = startLyteboat(['studio', '--agents', AGENTS, '--port', '0', '--gateway-secret-env', 'STUDIO_E2E_SECRET', '--admin', 'boss'], {
      cwd: workspace,
      env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1', STUDIO_E2E_SECRET: 'gw-secret' },
    })
    try {
      const origin = (await studio.waitForStdout(/lyteboat studio: (http:\/\/127\.0\.0\.1:\d+)\/studio\/ \(gateway sign-in\)/u, 90_000))[1] ?? ''
      const bare = await fetch(`${origin}/api/studio/auth/session`, { headers: { 'x-gateway-user-id': 'boss' } })
      const boss = await fetch(`${origin}/api/studio/auth/session`, { headers: { 'x-gateway-secret': 'gw-secret', 'x-gateway-user-id': 'boss' } })
      const system = await fetch(`${origin}/api/studio/system/properties`, { headers: { 'x-gateway-secret': 'gw-secret', 'x-gateway-user-id': 'boss' } })

      expect(bare.status).toBe(401)
      expect(await boss.json()).toEqual({ userId: 'boss', displayName: 'boss', role: 'admin' })
      expect((await system.json() as { env: { name: string; value: string }[] }).env).toContainEqual({ name: 'STUDIO_E2E_SECRET', value: '***' })
    } finally {
      const code = await studio.stop('SIGTERM')
      expect(code, studio.output()).toBe(0)
    }
  })
})
