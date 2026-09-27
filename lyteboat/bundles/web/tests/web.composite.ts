/**
 * The web composition in process (dsh-base, @lyteboat/host, dsh-web-app,
 * @lyteboat/web) over a fixture agent and the scripted model: the web
 * pages' browser face is a loader factory dsh web's page can run (the page's
 * roster is empty in process; the launcher's e2e reads it), the pages'
 * endpoints answer behind dsh web's login, a message sent with a request context runs the session's
 * agent and records the request on the human message, and an agent directory
 * that appears under a root is served without a restart.
 */
import { randomUUID } from 'node:crypto'
import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LYTEBOAT_WEB_BUNDLES, startComposition, type RunningComposition } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testing/session-log'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))

/** The modules dsh web's page supplies to a plugin bundle (dsh-client-web's `PLATFORM_MODULES`). */
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
type LogRecord = SessionLogRecord & { type: string; data?: { [key: string]: unknown } }

describe('lyteboat web (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('web')
  let model: ScriptedModel
  let web: RunningComposition
  let home: string
  let workspace: string
  let later: string
  const printed: string[] = []
  let origin: string
  let cookie: string

  /** A call as dsh web's browser transport makes it: an RPC envelope on the `/api` channel. */
  async function post(method: string, payload: unknown, withCookie = true): Promise<Response> {
    return fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...withCookie ? { cookie } : {} },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    })
  }

  async function call(method: string, payload: unknown): Promise<RpcResult> {
    const response = await post(method, payload)
    expect(response.status).toBe(200)
    return (await response.json() as { result: RpcResult }).result
  }

  async function value(method: string, payload: unknown): Promise<unknown> {
    const result = await call(method, payload)
    if (!result.ok) throw new Error(`${method}: ${result.error.message}`)
    return result.value
  }

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(request => ({ text: `OK:${request.lastUser}` })), { apiKey: 'mock-key' })
    const run = scratch.run('web', { 'later/.keep': '' })
    home = run.home
    workspace = run.workspace
    later = join(workspace, 'later')
    // dsh web prints its launch URL with console.log, which vitest takes over.
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { printed.push(parts.map(String).join(' ')) })
    web = startComposition({
      bundles: LYTEBOAT_WEB_BUNDLES,
      // A row resolves its package from its agent directory, so the served agent stays in the repository.
      args: ['--agents', join(FIXTURES, 'agents'), '--agents', later, '--no-open', '--port', '0'],
      // dsh's directory picker mounts its backend by package name at runtime, which does not
      // activate under the in-process loader; the sessions here are created with their cwd.
      patches: [{ id: 'directory-picker', disabled: true }],
      cwd: workspace,
      home,
      env: scriptedModelEnv(model),
      timeoutMs: 170_000,
    })
    await web.waitForStdout(/^lyteboat web: agents support$/mu)
    const launch = await vi.waitFor(() => {
      const line = printed.find(candidate => candidate.startsWith('dsh web: '))
      if (line === undefined) throw new Error('dsh web has not printed its URL yet')
      return line.slice('dsh web: '.length)
    }, { timeout: 30_000, interval: 50 })
    origin = new URL(launch).origin
    // The launch URL's token sets dsh web's login cookie.
    const exchange = await fetch(launch, { redirect: 'manual' })
    cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    const run = await web.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('builds the web pages\' browser face as one loader factory that needs only the platform modules', () => {
    const bundle = readFileSync(fileURLToPath(import.meta.resolve('@lyteboat/web-pages/client')), 'utf8')

    expect(bundle.startsWith('window.__ModuleLoader__.load({\n\tid: "@lyteboat/web-pages",')).toBe(true)
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1] ?? '')
    expect(required.filter(id => !PLATFORM_MODULES.includes(id))).toEqual([])
  })

  it('answers the pages\' endpoints behind dsh web\'s login only', async () => {
    const anonymous = await post('lyteboat/agents', {}, false)

    expect(anonymous.status).toBe(401)
    expect(await value('lyteboat/agents', {})).toEqual({ agents: [{ id: 'support', name: 'Support', description: '只有人设，用于 lyteboat web 的接线测试。' }], failures: [] })
  })

  it('sends a message with its request context through the session controller, and the session\'s agent answers it', async () => {
    const { sessionId } = await value('session/create', { args: { request: { cwd: workspace, agentPreset: 'support' } } }) as { sessionId: string }

    const { requestId } = await value('lyteboat/session/send', { sessionId, text: 'hello', context: { customer: 'c-1' } }) as { requestId: string }

    const records = await waitForSessionLog<LogRecord>(home, sessionId, log => log.some(record => record.type === 'turn/end'), { timeout: 15_000, interval: 100 })
    const human = records.find(record => record.type === 'user/message')
    expect(human?.data?.['source']).toEqual({ kind: 'user', rpcId: requestId, lyteboatRequest: { requestId, owner: { kind: 'operator', id: 'web' }, context: { customer: 'c-1' } } })
    // dsh appends its runtime context to the human message's text.
    const loop = model.requests.filter(request => request.purpose === 'loop' && request.lastUser.startsWith('hello'))
    expect(loop).toHaveLength(1)
    expect(loop[0]?.systemText).toContain('WEB-SUPPORT')
    // dsh web keeps the agent plane behind its presets; lyteboat web puts dsh-base's back, as serve runs an agent.
    expect(loop[0]?.toolNames).toEqual(expect.arrayContaining(['skill', 'todo_write']))
    // As dsh-base has them: the shell of the platform, and no plugin manager tool.
    expect(loop[0]?.toolNames).not.toContain('plugin_manager')
    expect(loop[0]?.toolNames.includes('pwsh')).toBe(process.platform === 'win32')
    const projections = await value('session/projections', { args: { request: { sessionId } } }) as { values: { [key: string]: unknown } }
    expect(projections.values['lyteboatRequest']).toMatchObject({ requests: 1, context: { customer: 'c-1' }, owner: { kind: 'operator', id: 'web' } })
  })

  it('serves an agent directory that appears under a root, without a restart', async () => {
    cpSync(join(FIXTURES, 'later/helper'), join(later, 'helper'), { recursive: true })

    await vi.waitFor(async () => {
      const answer = await value('lyteboat/agents', {}) as { agents: { id: string }[] }
      expect(answer.agents.map(agent => agent.id)).toEqual(['helper', 'support'])
    }, { timeout: 15_000, interval: 200 })
  })
})
