/**
 * The Studio API on the unit host, over a real listener: the Host allowlist,
 * the headers every answer carries, sign-in and role checks, the Users
 * endpoints and their audit lines, request bodies, the System page, the
 * agent radar with release locks, the agent workspace (skills, tools,
 * diagnostics, and the skill hot-fix), and an agent's sessions. The agent
 * catalog, inspector, and session index, the services they read (a JSONL
 * session store), the web server, and studioAuth are mounted, not stubbed;
 * only the credentials service is a table.
 */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import AgentCatalogService from '@lyteboat/agent-catalog'
import AgentInspectorService from '@lyteboat/agent-inspector'
import AuxLlmService from '@lyteboat/aux-llm'
import type { LyteboatRunMetric } from '@lyteboat/contracts'
import type { StudioSkillDiagnosticsAnswer } from '@lyteboat/contracts/studio'
import LyteboatDistroService from '@lyteboat/distro'
import EvalRecordsService from '@lyteboat/eval-runner/records'
import RunMetricsReaderService from '@lyteboat/run-metrics/reader'
import SessionIndexService from '@lyteboat/session-index'
import SkillRouterService from '@lyteboat/skill-router'
import * as studioApi from '@lyteboat/studio-api'
import StudioAuthService from '@lyteboat/studio-auth'
import { setStudioAccount, setStudioGrant } from '@lyteboat/studio-auth/accounts'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'
import { readJsonLines } from '@lyteboat/testing/json-lines'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import ToolPolicyService from '@lyteboat/tool-policy'
import { studioHostAllowed } from '../src/studio-host-allowlist.ts'

afterEach(() => { vi.unstubAllEnvs() })

interface StudioFixture {
  ctx: Context
  root: string
  studioDir: string
  agentsDir: string
  metricsDir: string
  call(method: string, path: string, options?: { token?: string; body?: unknown; host?: string; contentType?: string; ifMatch?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }>
  login(username: string, password: string): Promise<string>
}

function writeAgent(agentsDir: string, id: string, manifest: string): void {
  mkdirSync(join(agentsDir, id), { recursive: true })
  writeFileSync(join(agentsDir, id, 'agent.cordis.yml'), '[]\n')
  writeFileSync(join(agentsDir, id, 'agent.yml'), manifest)
}

const workspaceAgent = fileURLToPath(new URL('./fixtures/workspace/ledger', import.meta.url))
const repositoryModules = fileURLToPath(new URL('../../../../node_modules', import.meta.url))
const evalProcess = fileURLToPath(new URL('./fixtures/eval-process.mjs', import.meta.url))

async function studioFixture(config: studioApi.Config = {}, setup: { workspace?: boolean; home?: boolean } = {}): Promise<StudioFixture> {
  const root = lyteboatTempDir('studio-api')
  // An eval process runs in the Studio's lyteboat home, where the records read its runs.
  if (setup.home === true) vi.stubEnv('DSH_HOME', root)
  const studioDir = join(root, 'studio')
  const agentsDir = join(root, 'agents')
  const metricsDir = join(root, 'run-metrics')
  writeAgent(agentsDir, 'alpha', 'name: Alpha\ndescription: the first agent\nversion: "1.0.0"\n')
  writeAgent(agentsDir, 'beta', 'version: "0.2.0"\n')
  if (setup.workspace === true) {
    // A copy the hot-fix may rewrite; its row resolves dsh's packages from the repository.
    cpSync(workspaceAgent, join(agentsDir, 'ledger'), { recursive: true })
    symlinkSync(repositoryModules, join(root, 'node_modules'))
  }
  setStudioAccount(studioDir, 'root', { password: 'pw-root', displayName: 'Root' })
  setStudioGrant(studioDir, 'root', 'admin', 'cli')
  setStudioAccount(studioDir, 'vera', { password: 'pw-vera' })
  setStudioGrant(studioDir, 'vera', 'viewer', 'cli')
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  // The registry mounts an agent's rows through a Loader tree of its own.
  await ctx.plugin(Loader)
  ctx.provide('credentials', { resolve: () => Promise.resolve(undefined) } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(AuxLlmService)
  await ctx.plugin(SkillRouterService, {})
  await ctx.plugin(AgentPresetRegistry, { default: 'none' })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-flash' })
  await ctx.plugin(AgentCatalogService, { roots: [agentsDir], strict: false, workdirsDir: join(root, 'workdirs') })
  await ctx.plugin(AgentInspectorService)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(SessionIndexService)
  await ctx.plugin(RunMetricsReaderService, { dir: metricsDir })
  await ctx.plugin(EvalRecordsService, { dir: join(root, 'evals') })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(StudioAuthService, { dir: studioDir })
  await ctx.plugin(studioApi, { dir: studioDir, agentRoots: [agentsDir], ...config })
  await ctx.agentCatalog.whenReady()
  const call: StudioFixture['call'] = (method, path, options = {}) => new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    const request = httpRequest({
      host: '127.0.0.1',
      port: ctx.webServer.port,
      method,
      path: `/api/studio/${path}`,
      headers: {
        host: options.host ?? `127.0.0.1:${String(ctx.webServer.port)}`,
        ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        ...options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch },
        ...payload === undefined ? {} : { 'content-type': options.contentType ?? 'application/json' },
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }) })
    })
    request.on('error', reject)
    request.end(payload)
  })
  const login = async (username: string, password: string): Promise<string> => {
    const answer = await call('POST', 'auth/login', { body: { username, password } })
    return (answer.body as { token: string }).token
  }
  return { ctx, root, studioDir, agentsDir, metricsDir, call, login }
}

function auditLines(studioDir: string): Record<string, unknown>[] {
  return readJsonLines<Record<string, unknown>>(join(studioDir, 'audit.jsonl'))
}

describe('studioHostAllowed', () => {
  it('accepts the loopback names on any port and a trusted name as configured', () => {
    expect(studioHostAllowed('127.0.0.1:8090', [])).toBe(true)
    expect(studioHostAllowed('LOCALHOST:1', [])).toBe(true)
    expect(studioHostAllowed('[::1]:8090', [])).toBe(true)
    expect(studioHostAllowed('studio.example:443', ['studio.example'])).toBe(true)
    expect(studioHostAllowed('studio.example:443', ['studio.example:8443'])).toBe(false)
    expect(studioHostAllowed('studio.example:8443', ['studio.example:8443'])).toBe(true)
    expect(studioHostAllowed('evil.example', ['studio.example'])).toBe(false)
    expect(studioHostAllowed(undefined, [])).toBe(false)
  })
})

describe('the Studio API', () => {
  it('answers 421 for a Host it was not told about, and carries its security headers on every answer', async () => {
    const studio = await studioFixture({ trustedHosts: ['studio.example'] })

    const rebound = await studio.call('GET', 'auth/config', { host: 'evil.example' })
    const trusted = await studio.call('GET', 'auth/config', { host: 'studio.example' })

    expect(rebound).toMatchObject({ status: 421, body: { error: { code: 'misdirected' } } })
    expect(trusted).toMatchObject({ status: 200, body: { mode: 'internal', loginRequired: true, anonymousViewer: false } })
    for (const answer of [rebound, trusted]) {
      expect(answer.headers).toMatchObject({
        'x-content-type-options': 'nosniff',
        'content-security-policy': 'default-src \'none\'; frame-ancestors \'none\'',
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      })
    }
  })

  it('signs in, answers the session, and refuses a request without a token or a role too low', async () => {
    const studio = await studioFixture()
    const viewer = await studio.login('vera', 'pw-vera')

    const session = await studio.call('GET', 'auth/session', { token: viewer })
    const anonymous = await studio.call('GET', 'agents')
    const users = await studio.call('GET', 'users', { token: viewer })

    expect(session).toMatchObject({ status: 200, body: { userId: 'vera', displayName: 'vera', role: 'viewer' } })
    expect(anonymous).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
    expect(users).toMatchObject({ status: 403, body: { error: { code: 'forbidden', message: 'this needs the admin role; vera is viewer' } } })
  })

  it('audits a failed login under the username it gave', async () => {
    const studio = await studioFixture()

    const answer = await studio.call('POST', 'auth/login', { body: { username: 'root', password: 'guess' } })

    expect(answer).toMatchObject({ status: 401, body: { error: { code: 'unauthorized', message: 'wrong username or password' } } })
    expect(auditLines(studio.studioDir)).toEqual([{ time: expect.any(Number), actor: 'root', action: 'login.failed', from: '127.0.0.1' }])
  })

  it('lets an admin list, grant, and revoke roles, keeps the two grant rules, and audits each change', async () => {
    const studio = await studioFixture()
    const admin = await studio.login('root', 'pw-root')

    const granted = await studio.call('POST', 'users', { token: admin, body: { userId: 'ed', role: 'editor' } })
    const page = await studio.call('GET', 'users?role=editor&limit=10', { token: admin })
    const self = await studio.call('DELETE', 'users/root', { token: admin })
    const revoked = await studio.call('DELETE', 'users/ed', { token: admin })
    const missing = await studio.call('DELETE', 'users/nobody', { token: admin })

    expect(granted).toMatchObject({ status: 200, body: { userId: 'ed', role: 'editor', createdBy: 'root' } })
    expect(page.body).toMatchObject({ total: 1, users: [{ userId: 'ed' }] })
    expect(self).toMatchObject({ status: 409, body: { error: { code: 'conflict', message: 'you cannot change or revoke your own role' } } })
    expect(revoked).toMatchObject({ status: 200, body: { userId: 'ed', role: 'editor' } })
    expect(missing).toMatchObject({ status: 404 })
    expect(auditLines(studio.studioDir).map(({ actor, action, userId, role }) => ({ actor, action, userId, role }))).toEqual([
      { actor: 'root', action: 'grant.set', userId: 'ed', role: 'editor' },
      { actor: 'root', action: 'grant.remove', userId: 'ed', role: 'editor' },
    ])
  })

  it('refuses a body that is not JSON, too large, or carries an unknown key, and a query out of range', async () => {
    const studio = await studioFixture({ maxBodyBytes: 64 })
    const admin = await studio.login('root', 'pw-root')

    const form = await studio.call('POST', 'users', { token: admin, body: 'userId=x', contentType: 'application/x-www-form-urlencoded' })
    const large = await studio.call('POST', 'users', { token: admin, body: { userId: 'x'.repeat(100), role: 'viewer' } })
    const extra = await studio.call('POST', 'users', { token: admin, body: { userId: 'x', role: 'viewer', note: 1 } })
    const limit = await studio.call('GET', 'users?limit=500', { token: admin })

    expect(form).toMatchObject({ status: 400, body: { error: { message: 'send the body as application/json' } } })
    expect(large).toMatchObject({ status: 413, body: { error: { code: 'payload_too_large' } } })
    expect(extra).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } })
    expect(limit).toMatchObject({ status: 400, body: { error: { message: 'limit must be a whole number up to 200' } } })
  })

  it('answers 404 for no endpoint and 405 for a known one called with the wrong method', async () => {
    const studio = await studioFixture()

    expect(await studio.call('GET', 'nowhere')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    expect(await studio.call('GET', 'auth/login')).toMatchObject({ status: 405, body: { error: { message: 'use POST' } } })
  })

  it('shows the system with secrets masked, the configured ones whatever their names', async () => {
    process.env['STUDIO_SPEC_API_KEY'] = 'plain-looking'
    process.env['STUDIO_SPEC_GATEWAY'] = 'also-plain'
    try {
      const studio = await studioFixture({ maskedEnv: ['STUDIO_SPEC_GATEWAY'], lyteboatVersion: '9.9.9', traceLinkTemplate: 'https://trace.example/t/{trace_id}' })
      const viewer = await studio.login('vera', 'pw-vera')

      const system = await studio.call('GET', 'system/properties', { token: viewer })
      const traceLink = await studio.call('GET', 'config/trace-link', { token: viewer })

      const body = system.body as { lyteboat: Record<string, unknown>; env: { name: string; value: string }[] }
      expect(body.lyteboat).toMatchObject({ version: '9.9.9', dshBase: studio.ctx.lyteboatDistro.dsh, agentRoots: [studio.agentsDir] })
      expect(body.env).toContainEqual({ name: 'STUDIO_SPEC_API_KEY', value: '***' })
      expect(body.env).toContainEqual({ name: 'STUDIO_SPEC_GATEWAY', value: '***' })
      expect(traceLink.body).toEqual({ template: 'https://trace.example/t/{trace_id}' })
    } finally {
      delete process.env['STUDIO_SPEC_API_KEY']
      delete process.env['STUDIO_SPEC_GATEWAY']
    }
  })

  it('lists the agents with their release locks, and shows an agent that changed since its release as deviating', async () => {
    const studio = await studioFixture()
    const admin = await studio.login('root', 'pw-root')
    const alpha = studio.ctx.agentCatalog.get('alpha')
    const lock = { agent: { id: 'alpha', version: '1.0.0', digest: alpha?.identity.digest }, model: { provider: 'p', model: 'm' }, dshBase: 'x', files: {}, baseline: { startedAt: 't', cases: 0, turns: 0, checks: 0, results: `sha256:${'0'.repeat(64)}` } }
    writeFileSync(join(studio.agentsDir, 'alpha', 'agent.release.json'), JSON.stringify(lock))
    writeFileSync(join(studio.agentsDir, 'beta', 'agent.release.json'), '{')

    const released = await studio.call('GET', 'agents', { token: admin })
    writeFileSync(join(studio.agentsDir, 'alpha', 'agent.yml'), 'name: Alpha\ndescription: hot-fixed\nversion: "1.0.0"\n')
    const reloaded = await studio.call('POST', 'agents/reload', { token: admin })

    expect(released.body).toMatchObject({
      agents: [
        { id: 'alpha', name: 'Alpha', version: '1.0.0', release: { version: '1.0.0', digest: alpha?.identity.digest }, deviates: false },
        { id: 'beta', version: '0.2.0', deviates: false, releaseProblem: expect.stringContaining('agent.release.json is not JSON') },
      ],
      failures: [],
    })
    expect(reloaded.body).toMatchObject({ agents: [{ id: 'alpha', description: 'hot-fixed', deviates: true }, { id: 'beta' }] })
    expect(auditLines(studio.studioDir)).toEqual([{ time: expect.any(Number), actor: 'root', action: 'agents.reload', agents: 2, failures: 0 }])
  })

  it('refuses a trace link template without the trace id', async () => {
    await expect(studioFixture({ traceLinkTemplate: 'https://trace.example/' })).rejects.toThrow('traceLinkTemplate must hold {trace_id}')
  })
})

describe('the agent workspace', () => {
  const skillFile = (studio: StudioFixture, name: string): string => join(studio.agentsDir, 'ledger', 'skills', name, 'SKILL.md')
  const withDescription = (text: string, description: string): string => text.replace(/^description: .*$/mu, `description: ${description}`)

  it('lists an agent\'s skills with their files and its routing, and shows one skill with its file and digest', async () => {
    const studio = await studioFixture({}, { workspace: true })
    const viewer = await studio.login('vera', 'pw-vera')

    const skills = await studio.call('GET', 'agents/ledger/skills', { token: viewer })
    const skill = await studio.call('GET', 'agents/ledger/skills/balance-lookup', { token: viewer })

    expect(skills).toMatchObject({ status: 200, body: {
      routing: { mode: 'dynamic' },
      skills: [
        { name: 'balance-lookup', description: 'look up an account balance', requiredTools: ['ledger_balance'], modelInvocable: true, path: join('skills', 'balance-lookup', 'SKILL.md'), updatedAt: expect.any(Number) },
        { name: 'ledger-help', requiredTools: ['ledger_clock'] },
      ],
    } })
    const text = readFileSync(skillFile(studio, 'balance-lookup'), 'utf8')
    expect(skill.body).toMatchObject({ name: 'balance-lookup', content: 'Call ledger_balance, then answer with the balance.', file: text, sha256: createHash('sha256').update(text).digest('hex') })
  })

  it('lists an agent\'s tools with how each reaches the model, and answers 404 for an agent or skill it does not have', async () => {
    const studio = await studioFixture({}, { workspace: true })
    const viewer = await studio.login('vera', 'pw-vera')

    const tools = await studio.call('GET', 'agents/ledger/tools', { token: viewer })
    const noAgent = await studio.call('GET', 'agents/nobody/tools', { token: viewer })
    const noSkill = await studio.call('GET', 'agents/ledger/skills/no-such-skill', { token: viewer })

    expect((tools.body as { tools: { name: string; declared: string; reach: string; requiredBy: string[] }[] }).tools.map(({ name, declared, reach, requiredBy }) => ({ name, declared, reach, requiredBy }))).toEqual([
      { name: 'ledger_clock', declared: 'always', reach: 'always', requiredBy: ['ledger-help'] },
      { name: 'ledger_balance', declared: 'auto', reach: 'activated', requiredBy: ['balance-lookup'] },
    ])
    expect(noAgent).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
    expect(noSkill).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } })
  })

  it('diagnoses a skill against its agent\'s tools and routing', async () => {
    const studio = await studioFixture({}, { workspace: true })
    const viewer = await studio.login('vera', 'pw-vera')

    const clean = await studio.call('POST', 'agents/ledger/skills/balance-lookup/diagnostics', { token: viewer })
    const always = await studio.call('POST', 'agents/ledger/skills/ledger-help/diagnostics', { token: viewer })

    const failed = (answer: { body: unknown }): { rule: string; tools: string[] }[] => (answer.body as StudioSkillDiagnosticsAnswer).findings.filter(finding => !finding.passed).map(({ rule, tools }) => ({ rule, tools }))
    expect(clean.body).toMatchObject({ skill: 'balance-lookup', generatedAt: expect.any(Number), routing: 'dynamic' })
    expect(failed(clean)).toEqual([])
    expect(failed(always)).toEqual([{ rule: 'required-tools-auto', tools: (always.body as StudioSkillDiagnosticsAnswer).requiredTools }])
  })

  it('hot-fixes a skill for an admin: replaces the file, audits it, reloads the agent, and answers the new skill and digest', async () => {
    const studio = await studioFixture({}, { workspace: true })
    const admin = await studio.login('root', 'pw-root')
    const before = (await studio.call('GET', 'agents/ledger/skills/balance-lookup', { token: admin })).body as { file: string; sha256: string }
    const digestBefore = studio.ctx.agentCatalog.get('ledger')?.identity.digest
    const text = withDescription(before.file, 'look up the balance of one account')

    const saved = await studio.call('PUT', 'agents/ledger/skills/balance-lookup', { token: admin, ifMatch: before.sha256, body: { file: text } })

    const after = createHash('sha256').update(text).digest('hex')
    expect(saved).toMatchObject({ status: 200, body: {
      skill: { name: 'balance-lookup', description: 'look up the balance of one account', sha256: after },
      agent: { id: 'ledger' },
    } })
    expect((saved.body as { agent: { digest: string } }).agent.digest).not.toBe(digestBefore)
    expect(readFileSync(skillFile(studio, 'balance-lookup'), 'utf8')).toBe(text)
    expect(auditLines(studio.studioDir)).toEqual([{ time: expect.any(Number), actor: 'root', action: 'skill.update', agentId: 'ledger', skill: 'balance-lookup', path: join('skills', 'balance-lookup', 'SKILL.md'), before: before.sha256, after }])
  })

  it('refuses a hot-fix from a viewer, against a stale digest, or that breaks a rule, and leaves the file as it was', async () => {
    const studio = await studioFixture({}, { workspace: true })
    const admin = await studio.login('root', 'pw-root')
    const viewer = await studio.login('vera', 'pw-vera')
    const current = (await studio.call('GET', 'agents/ledger/skills/balance-lookup', { token: admin })).body as { file: string; sha256: string }
    const put = (token: string, ifMatch: string, file: string): ReturnType<StudioFixture['call']> => studio.call('PUT', 'agents/ledger/skills/balance-lookup', { token, ifMatch, body: { file } })

    const byViewer = await put(viewer, current.sha256, withDescription(current.file, 'changed'))
    const stale = await put(admin, '0'.repeat(64), withDescription(current.file, 'changed'))
    const renamed = await put(admin, current.sha256, current.file.replace('name: balance-lookup', 'name: balance-check'))
    const undeclared = await put(admin, current.sha256, current.file.replace('[ledger_balance]', '[ledger_balance, host_shell]'))
    const noFrontmatter = await put(admin, current.sha256, 'just a body\n')

    expect(byViewer.status).toBe(403)
    expect(stale).toMatchObject({ status: 412, body: { error: { code: 'precondition_failed' } } })
    expect(renamed).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('the name must stay "balance-lookup"') } } })
    expect(undeclared).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('host_shell') } } })
    expect(noFrontmatter).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('YAML frontmatter') } } })
    expect(readFileSync(skillFile(studio, 'balance-lookup'), 'utf8')).toBe(current.file)
  })

  it('restores the previous file when the skill loader refuses the new one', async () => {
    const studio = await studioFixture({}, { workspace: true })
    const admin = await studio.login('root', 'pw-root')
    const current = (await studio.call('GET', 'agents/ledger/skills/balance-lookup', { token: admin })).body as { file: string; sha256: string }
    // The loader refuses the retired camel-case invocation key; the hot-fix's own rules do not name it.
    const refused = current.file.replace('description:', 'userInvocable: false\ndescription:')

    const saved = await studio.call('PUT', 'agents/ledger/skills/balance-lookup', { token: admin, ifMatch: current.sha256, body: { file: refused } })
    const reread = await studio.call('GET', 'agents/ledger/skills/balance-lookup', { token: admin })

    expect(saved).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('the previous file is restored') } } })
    expect(readFileSync(skillFile(studio, 'balance-lookup'), 'utf8')).toBe(current.file)
    expect(reread.body).toMatchObject({ sha256: current.sha256 })
  })
})

describe('an agent\'s sessions', () => {
  /** One stored turn of `alpha`, as serve would write it: the human message with its request, then the turn's end. */
  async function storeSession(studio: StudioFixture, id: string, text: string, owner: string): Promise<void> {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', lyteboatRequest: { owner: { kind: 'user', id: owner }, traceId: `t-${id}` } } }), surfaceOp: 'append' },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq: SessionSeq(seq), time: 1_000 + seq }) as unknown as SessionEvent)
    const cwd = studio.ctx.agentCatalog.get('alpha')?.workdir
    const handle = await studio.ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, ...cwd === undefined ? {} : { cwd }, isSeeded: false })
    await handle.append(events)
    await handle.close()
  }

  it('lists, finds, and shows an agent\'s sessions to a viewer, and its stored form', async () => {
    const studio = await studioFixture()
    await storeSession(studio, 's-1', '第一个问题', 'alice')
    await storeSession(studio, 's-2', '第二个问题', 'bob')
    const viewer = await studio.login('vera', 'pw-vera')

    const listed = await studio.call('GET', 'agents/alpha/sessions?owner=user%3Abob', { token: viewer })
    const found = await studio.call('GET', `agents/alpha/sessions/find?q=${encodeURIComponent('第一')}`, { token: viewer })
    const detail = await studio.call('GET', 'agents/alpha/sessions/s-1', { token: viewer })
    const raw = await studio.call('GET', 'agents/alpha/sessions/s-1/raw', { token: viewer })

    expect(listed).toMatchObject({ status: 200, body: { total: 1, hasMore: false, sessions: [{ sessionId: 's-2', owner: { kind: 'user', id: 'bob' }, firstMessage: '第二个问题' }] } })
    expect(found.body).toMatchObject({ hasMore: false, sessions: [{ sessionId: 's-1', matchKind: 'question', matchedSnippet: '第一个问题' }] })
    expect(detail.body).toMatchObject({ summary: { sessionId: 's-1' }, items: [{ kind: 'user', text: '第一个问题', request: { traceId: 't-s-1' } }, { kind: 'turn-end', outcome: 'completed' }] })
    expect(raw.body).toMatchObject({ header: { id: 's-1' }, inheritedEventCount: 0 })
    expect((raw.body as { events: unknown[] }).events).toHaveLength(5)
  })

  it('answers 404 for an unknown agent or session, and refuses a malformed query', async () => {
    const studio = await studioFixture()
    const viewer = await studio.login('vera', 'pw-vera')

    const noAgent = await studio.call('GET', 'agents/nobody/sessions', { token: viewer })
    const noSession = await studio.call('GET', 'agents/alpha/sessions/nope', { token: viewer })
    const badOwner = await studio.call('GET', 'agents/alpha/sessions?owner=robot%3Ax', { token: viewer })
    const badLimit = await studio.call('GET', 'agents/alpha/sessions?limit=500', { token: viewer })
    const noText = await studio.call('GET', 'agents/alpha/sessions/find?q=%20', { token: viewer })
    const anonymous = await studio.call('GET', 'agents/alpha/sessions')

    expect(noAgent.status).toBe(404)
    expect(noSession.status).toBe(404)
    expect(badOwner).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('owner must be <kind>:<id>') } } })
    expect(badLimit.status).toBe(400)
    expect(noText.status).toBe(400)
    expect(anonymous.status).toBe(401)
    expect(await studio.call('GET', 'agents/alpha/sessions', { token: viewer })).toMatchObject({ status: 200, body: { sessions: [], total: 0, hasMore: false } })
  })
})

describe('the Dashboard', () => {
  const HOUR = 3_600_000
  const T = Date.UTC(2026, 8, 20, 8)

  function metric(agentId: string, startedAt: number, extra: Partial<LyteboatRunMetric> = {}): LyteboatRunMetric {
    return {
      agentId, sessionId: `s-${String(startedAt)}`, turn: 1, owner: { kind: 'user', id: `u-${agentId}` }, startedAt, durationMs: 2_000, firstContentMs: 400,
      steps: 2, modelRequests: 2, auxCalls: 0, tools: [{ name: 'lookup', durationMs: 120, isError: false }], activatedSkills: [], outcome: 'completed', ...extra,
    }
  }

  function writeMetrics(studio: StudioFixture, rows: LyteboatRunMetric[]): void {
    mkdirSync(studio.metricsDir, { recursive: true })
    // One UTC day file, as the recorder names it.
    writeFileSync(join(studio.metricsDir, `${new Date(T).toISOString().slice(0, 10)}.jsonl`), rows.map(row => `${JSON.stringify(row)}\n`).join(''))
  }

  it('answers the health of every agent the catalog serves, or of one, bucketed, with a comparison window', async () => {
    const studio = await studioFixture()
    writeMetrics(studio, [
      metric('alpha', T + 10 * 60_000),
      metric('alpha', T + 2 * HOUR, { outcome: 'errored', errorCode: 'provider_error' }),
      metric('beta', T + 3 * HOUR, { activatedSkills: ['help'] }),
      metric('ghost', T + 3 * HOUR),
      metric('alpha', T - 2 * HOUR),
    ])
    const viewer = await studio.login('vera', 'pw-vera')

    const all = await studio.call('GET', `dashboard/health?from=${String(T)}&to=${String(T + 4 * HOUR)}`, { token: viewer })
    const alpha = await studio.call('GET', `dashboard/health?from=${String(T)}&to=${String(T + 4 * HOUR)}&agent=alpha&bucket=60&compareFrom=${String(T - 4 * HOUR)}&compareTo=${String(T)}`, { token: viewer })

    expect(all).toMatchObject({ status: 200, body: { agentIds: ['alpha', 'beta'], current: { bucketMinutes: 30, summary: { requestCount: 3, technicalFailureCount: 1, skillTriggerCount: 1, activeUsers: 2 } } } })
    expect((all.body as { current: { series: unknown[] } }).current.series).toHaveLength(8)
    expect(alpha.body).toMatchObject({
      agentIds: ['alpha'],
      current: { bucketMinutes: 60, summary: { requestCount: 2, completionRate: 0.5 }, toolRankings: [{ name: 'lookup', count: 2, averageDurationMs: 120 }] },
      comparison: { bucketMinutes: 60, summary: { requestCount: 1 } },
    })
  })

  it('refuses a health window that is missing, backwards, too finely bucketed, or half a comparison, and an agent it does not serve', async () => {
    const studio = await studioFixture()
    const viewer = await studio.login('vera', 'pw-vera')
    const health = (query: string): ReturnType<StudioFixture['call']> => studio.call('GET', `dashboard/health?${query}`, { token: viewer })

    expect((await health(`to=${String(T)}`)).status).toBe(400)
    expect((await health(`from=${String(T)}&to=${String(T)}`)).status).toBe(400)
    expect(await health(`from=${String(T)}&to=${String(T + 30 * 24 * HOUR)}&bucket=30`)).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('more than 500 buckets') } } })
    expect((await health(`from=${String(T)}&to=${String(T + HOUR)}&compareFrom=${String(T - HOUR)}`)).status).toBe(400)
    expect((await health(`from=${String(T)}&to=${String(T + HOUR)}&agent=nobody`)).status).toBe(404)
    expect((await studio.call('GET', `dashboard/health?from=${String(T)}&to=${String(T + HOUR)}`)).status).toBe(401)
  })

  it('answers the static summary of the agents and the turns serve processes are running now', async () => {
    const studio = await studioFixture()
    mkdirSync(join(studio.metricsDir, 'running'), { recursive: true })
    const turn = { agentId: 'alpha', sessionId: 's-live', turn: 1, startedAt: Date.now() - 1_000 }
    writeFileSync(join(studio.metricsDir, 'running', 'h1-1.json'), JSON.stringify({ host: 'h1', pid: 1, heartbeatAt: Date.now(), turns: [turn, { ...turn, sessionId: 's-other' }] }))
    const viewer = await studio.login('vera', 'pw-vera')

    const summary = await studio.call('GET', 'dashboard/summary', { token: viewer })
    const running = await studio.call('GET', 'dashboard/running', { token: viewer })

    expect(summary).toMatchObject({ status: 200, body: { totalAgents: 2, totalSessions: 0, totalSkills: 0, activity: [] } })
    expect((summary.body as { trends: { sessions: unknown[] } }).trends.sessions).toHaveLength(6)
    expect(running.body).toEqual({ total: 2, agents: [{ agentId: 'alpha', agentLabel: 'Alpha', running: 2 }] })
  })
})

describe('the Evals endpoints', () => {
  type RunBody = { run: { runId: string; status: string; cases: { total?: number; passed: number; done: number }; error?: string }; cases: { caseId: string; pass: boolean; turns: unknown[] }[] }

  function writeCases(studio: StudioFixture, agentId: string, ids: readonly string[]): void {
    mkdirSync(join(studio.agentsDir, agentId, 'evals'), { recursive: true })
    const cases = ids.map(id => `  - id: ${id}\n    turns:\n      - message: ${id} message\n        expect: { outcome: completed }\n`).join('')
    writeFileSync(join(studio.agentsDir, agentId, 'evals', 'cases.yml'), `cases:\n${cases}`)
  }

  async function settled(studio: StudioFixture, token: string, runId: string, status: string): Promise<RunBody> {
    return vi.waitFor(async () => {
      const answer = await studio.call('GET', `evals/runs/${runId}`, { token })
      expect((answer.body as RunBody).run.status).toBe(status)
      return answer.body as RunBody
    }, { timeout: 15_000, interval: 100 })
  }

  async function evalStudio(): Promise<{ studio: StudioFixture; admin: string; viewer: string }> {
    const studio = await studioFixture({ lyteboatBin: evalProcess }, { home: true })
    writeCases(studio, 'alpha', ['first', 'second', 'hold'])
    return { studio, admin: await studio.login('root', 'pw-root'), viewer: await studio.login('vera', 'pw-vera') }
  }

  it('lists an agent\'s case files, runs its cases for an editor, and shows the run as it ends, audited', async () => {
    const { studio, admin, viewer } = await evalStudio()

    const cases = await studio.call('GET', 'agents/alpha/evals/cases', { token: viewer })
    const refused = await studio.call('POST', 'evals/runs', { token: viewer, body: { agentId: 'alpha', mode: 'real' } })
    const started = await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'real', caseIds: ['first', 'second'] } })
    const runId = (started.body as { runId: string }).runId
    const done = await settled(studio, viewer, runId, 'passed')
    const listed = await studio.call('GET', 'evals/runs?agent=alpha', { token: viewer })

    expect(cases.body).toMatchObject({ files: [{ file: 'evals/cases.yml', cases: [{ id: 'first' }, { id: 'second' }, { id: 'hold' }] }] })
    expect(refused.status).toBe(403)
    expect(started.body).toMatchObject({ agentId: 'alpha', status: 'running', mode: 'real', caseIds: ['first', 'second'], startedBy: 'root', cases: { total: 2, done: 0 } })
    expect(done).toMatchObject({ run: { status: 'passed', cases: { total: 2, passed: 2, done: 2 } }, cases: [{ caseId: 'first', pass: true }, { caseId: 'second', pass: true }] })
    expect(listed.body).toMatchObject({ runs: [{ runId, status: 'passed', startedBy: 'root' }] })
    expect(auditLines(studio.studioDir)).toContainEqual(expect.objectContaining({ actor: 'root', action: 'eval.start', runId, agentId: 'alpha', mode: 'real' }))
  })

  it('replays a real run, compares the two case by case, and refuses a run it cannot start', async () => {
    const { studio, admin } = await evalStudio()
    const real = (await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'real', caseIds: ['first', 'second'] } })).body as { runId: string }
    await settled(studio, admin, real.runId, 'passed')

    const replay = (await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'replay', from: real.runId, caseIds: ['first', 'second'] } })).body as { runId: string }
    const replayed = await settled(studio, admin, replay.runId, 'failed')
    const compared = await studio.call('GET', `evals/compare?a=${real.runId}&b=${replay.runId}`, { token: admin })

    expect(replayed.run).toMatchObject({ cases: { passed: 1, total: 2 } })
    expect(compared.body).toMatchObject({
      breakdown: { regressed: 1, unchangedPass: 1 },
      cases: [{ caseId: 'first', status: 'unchanged_pass' }, { caseId: 'second', status: 'regressed', aPass: true, bPass: false, divergedAtTurn: 1, bFailingChecks: ['outcome'] }],
      changes: [{ case: 'second', turn: 1, check: 'outcome', before: 'pass', after: 'fail' }],
    })
    const start = (body: unknown): ReturnType<StudioFixture['call']> => studio.call('POST', 'evals/runs', { token: admin, body })
    expect((await start({ agentId: 'alpha', mode: 'replay' })).status).toBe(400)
    expect((await start({ agentId: 'alpha', mode: 'replay', from: replay.runId })).status).toBe(400)
    expect(await start({ agentId: 'alpha', mode: 'real', caseIds: ['nope'] })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining('has no case nope') } } })
    expect((await start({ agentId: 'beta', mode: 'real' })).status).toBe(400)
    expect((await start({ agentId: 'nobody', mode: 'real' })).status).toBe(404)
    expect((await studio.call('GET', `evals/compare?a=${real.runId}`, { token: admin })).status).toBe(400)
  })

  it('replays only the cases a run recorded when asked for none, and refuses a case it did not record', async () => {
    const { studio, admin } = await evalStudio()
    const partial = (await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'real', caseIds: ['first'] } })).body as { runId: string }
    await settled(studio, admin, partial.runId, 'passed')

    const replay = await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'replay', from: partial.runId } })
    const unrecorded = await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'replay', from: partial.runId, caseIds: ['second'] } })

    expect(replay.body).toMatchObject({ mode: 'replay', from: partial.runId, caseIds: ['first'], cases: { total: 1 } })
    expect(await settled(studio, admin, (replay.body as { runId: string }).runId, 'passed')).toMatchObject({ cases: [{ caseId: 'first', pass: true }] })
    expect(unrecorded).toMatchObject({ status: 400, body: { error: { message: `run ${partial.runId} recorded no case second` } } })
  })

  it('stops a running run, one run per agent at a time, and deletes a run only once it is not running', async () => {
    const { studio, admin } = await evalStudio()
    const held = (await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'real', caseIds: ['hold'] } })).body as { runId: string }

    const second = await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'real' } })
    const deleteRunning = await studio.call('DELETE', `evals/runs/${held.runId}`, { token: admin })
    await vi.waitFor(() => { expect(readFileSync(join(studio.studioDir, 'eval-jobs', `${held.runId}.log`), 'utf8')).toContain('holding') }, { timeout: 10_000 })
    const stop = await studio.call('POST', `evals/runs/${held.runId}/stop`, { token: admin })
    const stopped = await settled(studio, admin, held.runId, 'stopped')
    const deleted = await studio.call('DELETE', `evals/runs/${held.runId}`, { token: admin })

    expect(second).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('has an eval run running') } } })
    expect(deleteRunning.status).toBe(409)
    expect(stop.status).toBe(200)
    expect(stopped).toMatchObject({ run: { status: 'stopped' }, cases: [] })
    expect(deleted.body).toEqual({ runId: held.runId })
    expect((await studio.call('GET', `evals/runs/${held.runId}`, { token: admin })).status).toBe(404)
    expect(auditLines(studio.studioDir).map(line => line['action'])).toEqual(expect.arrayContaining(['eval.start', 'eval.stop', 'eval.delete']))
  })

  it('shows a run whose process could not run the agent as an error, with its last error line', async () => {
    const { studio, admin } = await evalStudio()
    writeCases(studio, 'broken', ['first'])
    writeFileSync(join(studio.agentsDir, 'broken', 'agent.cordis.yml'), '[]\n')
    await studio.call('POST', 'agents/reload', { token: admin })

    const started = (await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'broken', mode: 'real' } })).body as { runId: string }
    const failed = await settled(studio, admin, started.runId, 'error')

    expect(failed.run.error).toBe('lyteboat: eval-runner: the agent failed to mount')
  })

  it('refuses to start a run in a Studio the launcher did not start', async () => {
    const studio = await studioFixture()
    writeCases(studio, 'alpha', ['first'])
    const admin = await studio.login('root', 'pw-root')

    const refused = await studio.call('POST', 'evals/runs', { token: admin, body: { agentId: 'alpha', mode: 'real' } })

    expect(refused).toMatchObject({ status: 409, body: { error: { message: expect.stringContaining('not started by the lyteboat launcher') } } })
  })
})
