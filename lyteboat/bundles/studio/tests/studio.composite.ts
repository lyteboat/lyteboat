/**
 * The studio composition in process (dsh-base, @lyteboat/host,
 * @lyteboat/business-base, @lyteboat/studio) over fixture agents: an operator's
 * accounts sign in, the radar lists the agents that mounted and the one that
 * failed, roles gate the Users endpoints and a reload, the System page answers,
 * an agent's workspace shows its tools as the business base leaves them, its
 * skills and their diagnostics, the pages are served at /studio, and neither
 * /chat nor dsh's session channel is served. An admin's hot-fix of a released
 * agent's skill (on a copy of it) is saved, audited, and shows the agent
 * deviating from its release. The sessions serve records from /chat are
 * listed, searched, and shown by a Studio on the same home, which leaves them
 * as they were. An admin starts an agent's eval cases from the Studio as a
 * `lyteboat eval` process of the built launcher, replays that run, compares
 * the two, and stops a run. A Studio without accounts refuses to start and
 * names the command that makes one.
 */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setStudioAccount, setStudioGrant } from '@lyteboat/studio-auth/accounts'
import { postChat } from '@lyteboat/testing/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, LYTEBOAT_STUDIO_BUNDLES, bootComposition, startComposition, type RunningComposition } from '@lyteboat/testing/composition'
import { readJsonLines } from '@lyteboat/testing/json-lines'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'
import { findSessionLogs } from '@lyteboat/testing/session-log'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))
const WORKSPACE_MODULES = fileURLToPath(new URL('../../../../node_modules', import.meta.url))
/** The built launcher an eval run the Studio starts runs; `pnpm run test` builds it first. */
const LYTEBOAT_BIN = fileURLToPath(new URL('../../../apps/cli/lib/bin.js', import.meta.url))

interface StudioCallOptions {
  token?: string
  body?: unknown
  ifMatch?: string
}

/** Studio's API at `origin`, answered as status and JSON. */
async function studioCall(origin: string, method: string, path: string, options: StudioCallOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/studio/${path}`, {
    method,
    headers: {
      ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
      ...options.body === undefined ? {} : { 'content-type': 'application/json' },
      ...options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch },
    },
    ...options.body === undefined ? {} : { body: JSON.stringify(options.body) },
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function studioLogin(origin: string, username: string, password: string): Promise<string> {
  const answer = await studioCall(origin, 'POST', 'auth/login', { body: { username, password } })
  expect(answer.status).toBe(200)
  return answer.body['token'] as string
}

function addStudioAccounts(home: string): void {
  setStudioAccount(join(home, 'studio'), 'root', { password: 'pw-root', displayName: 'Root' })
  setStudioGrant(join(home, 'studio'), 'root', 'admin', 'cli')
  setStudioAccount(join(home, 'studio'), 'vera', { password: 'pw-vera' })
  setStudioGrant(join(home, 'studio'), 'vera', 'viewer', 'cli')
}

async function startStudio(agents: string, run: { workspace: string; home: string }, launch: { env: Record<string, string>; lyteboatBin?: string } = { env: {} }): Promise<{ studio: RunningComposition; origin: string }> {
  const studio = startComposition({
    bundles: LYTEBOAT_STUDIO_BUNDLES,
    args: ['--agents', agents, '--port', '0'],
    // No launcher boots the composition, so the test names the bin an eval run starts; a patch replaces the row's config whole.
    ...launch.lyteboatBin === undefined ? {} : { patches: [{ id: 'studio-api', config: { agentRoots: [agents], lyteboatBin: launch.lyteboatBin } }] },
    cwd: run.workspace,
    home: run.home,
    env: launch.env,
    timeoutMs: 170_000,
  })
  const [, port] = await studio.waitForStdout(/^lyteboat studio: http:\/\/127\.0\.0\.1:(\d+)\/studio\/ \(internal sign-in\)$/mu) as unknown as [string, string]
  await studio.waitForStdout(/^lyteboat studio: agents /mu)
  return { studio, origin: `http://127.0.0.1:${port}` }
}

describe('lyteboat studio (in process)', () => {
  const scratch = createLyteboatScratch('studio')
  let studio: RunningComposition
  let origin: string

  const call = (method: string, path: string, token?: string, body?: unknown): ReturnType<typeof studioCall> =>
    studioCall(origin, method, path, { ...token === undefined ? {} : { token }, ...body === undefined ? {} : { body } })
  const login = (username: string, password: string): Promise<string> => studioLogin(origin, username, password)

  beforeAll(async () => {
    const run = scratch.run('studio')
    addStudioAccounts(run.home)
    // A row resolves its package from its agent directory, so the inspected agents stay in the repository.
    ;({ studio, origin } = await startStudio(AGENTS, run))
    expect(studio.stdout()).toContain('lyteboat studio: agents desk, helper')
  })

  afterAll(async () => {
    await studio.stop()
    scratch.remove()
  })

  it('signs an operator\'s account in and lists the agents, the failed one with why', async () => {
    const admin = await login('root', 'pw-root')

    const agents = await call('GET', 'agents', admin)

    expect(agents.body).toMatchObject({
      agents: [
        { id: 'desk', name: 'Desk', version: '0.2.0', deviates: false },
        { id: 'helper', name: 'Helper', version: '0.1.0', digest: expect.stringMatching(/^sha256:/u), deviates: false },
      ],
      failures: [{ id: 'broken', reason: expect.stringContaining('@lyteboat/no-such-plugin') }],
    })
    expect(studio.stderr()).toContain('lyteboat studio: agent broken failed:')
  })

  it('keeps the Users endpoints and a reload to admins, and answers the System page for any role', async () => {
    const viewer = await login('vera', 'pw-vera')
    const admin = await login('root', 'pw-root')

    const users = await call('GET', 'users', viewer)
    const reload = await call('POST', 'agents/reload', viewer)
    const system = await call('GET', 'system/properties', viewer)
    const grants = await call('GET', 'users', admin)

    expect(users.status).toBe(403)
    expect(reload.status).toBe(403)
    expect(system.body['lyteboat']).toMatchObject({ agentRoots: [AGENTS] })
    expect(grants.body).toMatchObject({ total: 2, users: [{ userId: 'root', role: 'admin' }, { userId: 'vera', role: 'viewer' }] })
  })

  it('shows an agent\'s tools as the business base and its policy leave them: its own, the skill tool, and every other inherited one hidden', async () => {
    const viewer = await login('vera', 'pw-vera')

    const tools = (await call('GET', 'agents/desk/tools', viewer)).body['tools'] as { name: string; declared: string; reach: string; requiredBy: string[] }[]

    const byName = new Map(tools.map(tool => [tool.name, tool]))
    expect(byName.get('desk_clock')).toMatchObject({ declared: 'always', reach: 'always', requiredBy: [] })
    expect(byName.get('lookup_quote')).toMatchObject({ declared: 'auto', reach: 'activated', requiredBy: ['quote-lookup'] })
    expect(byName.get('skill')).toMatchObject({ declared: 'always', reach: 'always' })
    expect(tools.filter(tool => tool.reach === 'always').map(tool => tool.name).sort()).toEqual(['desk_clock', 'skill'])
    expect(tools.filter(tool => !['desk_clock', 'lookup_quote', 'skill'].includes(tool.name)).every(tool => tool.declared === 'inherited' && tool.reach === 'hidden')).toBe(true)
  })

  it('lists an agent\'s skills with its routing and diagnoses one against its tools', async () => {
    const viewer = await login('vera', 'pw-vera')

    const skills = await call('GET', 'agents/desk/skills', viewer)
    const diagnostics = await call('POST', 'agents/desk/skills/quote-lookup/diagnostics', viewer)

    expect(skills.body).toMatchObject({
      routing: { mode: 'dynamic' },
      skills: [
        { name: 'desk-help', requiredTools: [], path: join('skills', 'desk-help', 'SKILL.md') },
        { name: 'quote-lookup', requiredTools: ['lookup_quote'], path: join('skills', 'quote-lookup', 'SKILL.md') },
      ],
    })
    expect((diagnostics.body['findings'] as { rule: string; passed: boolean }[]).map(({ rule, passed }) => ({ rule, passed }))).toEqual([
      { rule: 'metadata-valid', passed: true },
      { rule: 'required-tools-registered', passed: true },
      { rule: 'required-tools-declared', passed: true },
      { rule: 'required-tools-auto', passed: true },
      { rule: 'routable', passed: true },
    ])
  })

  it('serves the pages at /studio under their CSP, and sends / there', async () => {
    const page = await fetch(`${origin}/studio/users`)
    const root = await fetch(`${origin}/`, { redirect: 'manual' })

    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain('script-src \'self\'')
    expect(await page.text()).toContain('<title>轻舟 Studio</title>')
    expect(root.headers.get('location')).toBe('/studio/')
  })

  it('serves neither /chat nor dsh\'s session channel: Studio never runs a session', async () => {
    expect((await fetch(`${origin}/chat`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${origin}/api/remote.mux`)).status).toBe(404)
  })
})

describe('a skill hot-fix in lyteboat studio (in process)', () => {
  const scratch = createLyteboatScratch('studio-hotfix')
  let studio: RunningComposition
  let origin: string
  let home: string
  let skillFile: string
  let released: string

  beforeAll(async () => {
    const run = scratch.run('hotfix')
    home = run.home
    addStudioAccounts(run.home)
    // A copy the hot-fix may rewrite; its rows resolve their packages from the repository's modules.
    const agents = join(scratch.root, 'agents')
    cpSync(join(AGENTS, 'desk'), join(agents, 'desk'), { recursive: true })
    symlinkSync(WORKSPACE_MODULES, join(scratch.root, 'node_modules'))
    skillFile = join(agents, 'desk', 'skills', 'quote-lookup', 'SKILL.md')
    ;({ studio, origin } = await startStudio(agents, run))
    const admin = await studioLogin(origin, 'root', 'pw-root')
    released = ((await studioCall(origin, 'GET', 'agents', { token: admin })).body['agents'] as { digest: string }[])[0]?.digest ?? ''
    const lock = { agent: { id: 'desk', version: '0.2.0', digest: released }, model: { provider: 'p', model: 'm' }, dshBase: 'x', files: {}, baseline: { startedAt: 't', cases: 0, turns: 0, checks: 0, results: `sha256:${'0'.repeat(64)}` } }
    writeFileSync(join(agents, 'desk', 'agent.release.json'), JSON.stringify(lock))
  })

  afterAll(async () => {
    await studio.stop()
    scratch.remove()
  })

  it('refuses a viewer, then saves an admin\'s fix, audits it, and shows the agent deviating from its release', async () => {
    const viewer = await studioLogin(origin, 'vera', 'pw-vera')
    const admin = await studioLogin(origin, 'root', 'pw-root')
    const before = (await studioCall(origin, 'GET', 'agents/desk/skills/quote-lookup', { token: admin })).body as { file: string; sha256: string }
    const text = before.file.replace('调用 `lookup_quote(code)` 一次，照抄结果。', '调用 `lookup_quote(code)` 一次，照抄结果，并注明时间。')

    const refused = await studioCall(origin, 'PUT', 'agents/desk/skills/quote-lookup', { token: viewer, ifMatch: before.sha256, body: { file: text } })
    const saved = await studioCall(origin, 'PUT', 'agents/desk/skills/quote-lookup', { token: admin, ifMatch: before.sha256, body: { file: text } })
    const stale = await studioCall(origin, 'PUT', 'agents/desk/skills/quote-lookup', { token: admin, ifMatch: before.sha256, body: { file: before.file } })
    const radar = await studioCall(origin, 'GET', 'agents', { token: viewer })

    const after = createHash('sha256').update(text).digest('hex')
    expect(refused.status).toBe(403)
    expect(saved).toMatchObject({ status: 200, body: {
      skill: { name: 'quote-lookup', content: expect.stringContaining('并注明时间'), sha256: after },
      agent: { id: 'desk', release: { version: '0.2.0', digest: released }, deviates: true },
    } })
    expect(stale.status).toBe(412)
    expect(readFileSync(skillFile, 'utf8')).toBe(text)
    expect(radar.body).toMatchObject({ agents: [{ id: 'desk', deviates: true }] })
    const audit = readJsonLines<Record<string, unknown>>(join(home, 'studio', 'audit.jsonl'))
    expect(audit.filter(line => line['action'] === 'skill.update')).toEqual([{ time: expect.any(Number), actor: 'root', action: 'skill.update', agentId: 'desk', skill: 'quote-lookup', path: join('skills', 'quote-lookup', 'SKILL.md'), before: before.sha256, after }])
  })
})

describe('sessions and run metrics serve records, read by lyteboat studio (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('studio-sessions')
  let model: ScriptedModel
  let serve: RunningComposition
  let studio: RunningComposition
  let origin: string
  let home: string
  let servedFrom: number
  let servedTo: number
  const sessionIds: string[] = []

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(request => ({ text: `OK:${request.latestMessage}` })), { apiKey: 'mock-key' })
    const run = scratch.run('shared')
    home = run.home
    addStudioAccounts(run.home)
    const agents = join(scratch.root, 'agents')
    cpSync(join(AGENTS, 'desk'), join(agents, 'desk'), { recursive: true })
    symlinkSync(WORKSPACE_MODULES, join(scratch.root, 'node_modules'))
    serve = startComposition({
      bundles: LYTEBOAT_SERVE_BUNDLES,
      args: ['--agents', agents, '--port', '0'],
      patches: [{ id: 'chat-api', config: { auth: 'none' } }],
      cwd: run.workspace,
      home,
      env: scriptedModelEnv(model),
      timeoutMs: 170_000,
    })
    const chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) \(agents: desk\)$/mu))[1] ?? ''
    servedFrom = Date.now()
    for (const [user, message] of [['u-1', '第一个问题'], ['u-2', '第二个问题']] as const) {
      const reply = await postChat(chat, { agent_id: 'desk', user_id: user, message, trace_id: `trace-${user}` })
      sessionIds.push((reply.body as { session_id: string }).session_id)
    }
    await serve.stop()
    servedTo = Date.now()
    // The harness keeps one profile per home; Studio shares serve's home (its sessions), not serve's bundles.
    rmSync(join(home, 'profiles'), { recursive: true, force: true })
    ;({ studio, origin } = await startStudio(agents, run))
  })

  afterAll(async () => {
    await studio.stop()
    await model.close()
    scratch.remove()
  })

  it('lists the sessions newest first with their owners, finds one by trace id, and shows its timeline', async () => {
    const viewer = await studioLogin(origin, 'vera', 'pw-vera')
    const stored = findSessionLogs(home).map(path => readFileSync(path))

    const listed = await studioCall(origin, 'GET', 'agents/desk/sessions', { token: viewer })
    const found = await studioCall(origin, 'GET', 'agents/desk/sessions/find?q=TRACE-U-1', { token: viewer })
    const detail = await studioCall(origin, 'GET', `agents/desk/sessions/${sessionIds[0] ?? ''}`, { token: viewer })
    const raw = await studioCall(origin, 'GET', `agents/desk/sessions/${sessionIds[0] ?? ''}/raw`, { token: viewer })

    expect(listed.body).toMatchObject({
      total: 2, hasMore: false,
      sessions: [
        { sessionId: sessionIds[1], owner: { kind: 'user', id: 'u-2' }, firstMessage: '第二个问题', turnCount: 1, openTurn: false },
        { sessionId: sessionIds[0], owner: { kind: 'user', id: 'u-1' }, firstMessage: '第一个问题', errorCount: 0, rejectedCount: 0 },
      ],
    })
    expect(found.body).toMatchObject({ sessions: [{ sessionId: sessionIds[0], matchKind: 'trace', matchedSnippet: 'trace-u-1' }] })
    const items = (detail.body['items'] as { kind: string }[])
    expect(items[0]).toMatchObject({ kind: 'user', text: '第一个问题', request: { owner: { kind: 'user', id: 'u-1' }, traceId: 'trace-u-1', agent: { id: 'desk' } } })
    expect(items.find(item => item.kind === 'aux')).toMatchObject({ purpose: 'skill-router' })
    expect(items.find(item => item.kind === 'assistant')).toMatchObject({ text: expect.stringMatching(/^OK:/u), model: expect.any(String), answeredByAdmission: false })
    expect(items.at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'completed' })
    expect(raw.body['header']).toMatchObject({ id: sessionIds[0], agentPreset: 'desk' })
    // Studio reads with read handles only: the stored logs are byte for byte what serve wrote.
    expect(findSessionLogs(home).map(path => readFileSync(path))).toEqual(stored)
  })

  it('draws the Dashboard from the turns serve recorded, and shows none running once serve stopped', async () => {
    const viewer = await studioLogin(origin, 'vera', 'pw-vera')

    const health = await studioCall(origin, 'GET', `dashboard/health?from=${String(servedFrom)}&to=${String(servedTo)}`, { token: viewer })
    const summary = await studioCall(origin, 'GET', 'dashboard/summary', { token: viewer })
    const running = await studioCall(origin, 'GET', 'dashboard/running', { token: viewer })

    expect(health).toMatchObject({ status: 200, body: { agentIds: ['desk'], current: { bucketMinutes: 30, summary: { requestCount: 2, completionRate: 1, technicalFailureCount: 0, activeUsers: 2 } } } })
    expect(summary.body).toMatchObject({ totalAgents: 1, totalUsers: 2, totalSessions: 2, sessions: { agents: [{ label: 'Desk', value: 2 }] } })
    expect(running.body).toEqual({ total: 0, agents: [] })
  })
})

describe('eval runs started from lyteboat studio (in process, built launcher, scripted model)', () => {
  const scratch = createLyteboatScratch('studio-evals')
  let model: ScriptedModel
  let studio: RunningComposition
  let origin: string
  let admin: string

  type EvalRunBody = { run: { runId: string; status: string; mode: string; from?: string; cases: { total?: number; passed: number } }; cases: { caseId: string; pass: boolean }[] }

  const settled = (runId: string, status: string): Promise<EvalRunBody> => vi.waitFor(async () => {
    const answer = await studioCall(origin, 'GET', `evals/runs/${runId}`, { token: admin })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const { run } = answer.body as unknown as EvalRunBody
    // A run that ended otherwise says why (its process's last error line).
    if (run.status !== 'running') expect(run.status, JSON.stringify(run)).toBe(status)
    expect(run.status).toBe(status)
    return answer.body as unknown as EvalRunBody
  }, { timeout: 90_000, interval: 250 })

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(request => ({ text: `OK:${request.latestMessage}` })), { apiKey: 'mock-key' })
    const run = scratch.run('evals')
    addStudioAccounts(run.home)
    const agents = join(scratch.root, 'agents')
    cpSync(join(AGENTS, 'desk'), join(agents, 'desk'), { recursive: true })
    mkdirSync(join(agents, 'desk', 'evals'))
    writeFileSync(join(agents, 'desk', 'evals', 'cases.yml'), 'cases:\n  - id: ask-time\n    turns:\n      - message: 现在几点？\n        expect: { outcome: completed }\n')
    symlinkSync(WORKSPACE_MODULES, join(scratch.root, 'node_modules'))
    ;({ studio, origin } = await startStudio(agents, run, { env: { ...scriptedModelEnv(model), DSH_TELEMETRY_DISABLED: '1' }, lyteboatBin: LYTEBOAT_BIN }))
    admin = await studioLogin(origin, 'root', 'pw-root')
  })

  afterAll(async () => {
    await studio.stop()
    await model.close()
    scratch.remove()
  })

  /** Start a run; a refusal fails the test with the Studio's answer. */
  async function started(body: Record<string, unknown>): Promise<{ runId: string }> {
    const answer = await studioCall(origin, 'POST', 'evals/runs', { token: admin, body })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    return answer.body as unknown as { runId: string }
  }

  it('runs the agent\'s cases against the model, replays that run without it, and compares the two', async () => {
    const real = await started({ agentId: 'desk', mode: 'real' })
    const recorded = await settled(real.runId, 'passed')
    const requests = model.requests.length
    const replay = await started({ agentId: 'desk', mode: 'replay', from: real.runId })
    const replayed = await settled(replay.runId, 'passed')
    const compared = await studioCall(origin, 'GET', `evals/compare?a=${real.runId}&b=${replay.runId}`, { token: admin })

    expect(recorded).toMatchObject({ run: { mode: 'real', cases: { total: 1, passed: 1 } }, cases: [{ caseId: 'ask-time', pass: true }] })
    expect(replayed.run).toMatchObject({ mode: 'replay', from: real.runId })
    expect(model.requests.length).toBe(requests)
    expect(compared.body).toMatchObject({ breakdown: { unchangedPass: 1, regressed: 0 }, changes: [] })
  })

  it('stops a run it started, which ends stopped', async () => {
    const run = await started({ agentId: 'desk', mode: 'real' })

    const stop = await studioCall(origin, 'POST', `evals/runs/${run.runId}/stop`, { token: admin })

    expect(stop.status).toBe(200)
    expect((await settled(run.runId, 'stopped')).cases).toEqual([])
  })
})

describe('lyteboat studio without accounts (in process)', () => {
  const scratch = createLyteboatScratch('studio-empty')

  afterAll(() => { scratch.remove() })

  it('refuses to start in internal mode and names the command that makes the first account', async () => {
    const run = scratch.run('empty')

    const result = await bootComposition({ bundles: LYTEBOAT_STUDIO_BUNDLES, args: ['--agents', AGENTS, '--port', '0'], cwd: run.workspace, home: run.home, env: {}, timeoutMs: 60_000 })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('error: this Studio has no accounts to sign in with; make the first one with: lyteboat studio account add <username> --role admin < password-file')
  })
})
