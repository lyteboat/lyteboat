/**
 * The serve composition in process (dsh-base, @lyteboat/host, @lyteboat/business-base, @lyteboat/serve)
 * over two fixture agents and the scripted model: `/chat` answers in one JSON
 * body or as the enterprise stream through dsh's session controller, records
 * the request on the human message, continues and queues within a session,
 * cancels the turn of a caller that left, refuses what it cannot answer
 * with the status the protocol names, and records each turn's run metric.
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { postChat, streamChat, type ChatWireFrame } from '@lyteboat/testing/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, bootComposition, startComposition, type RunningComposition } from '@lyteboat/testing/composition'
import { readJsonLines } from '@lyteboat/testing/json-lines'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testing/session-log'
import { reopenRefusal } from '@lyteboat/testing/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel, type ScriptedReply } from '@lyteboat/testing/scripted-model'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

/** Replies the test holds back, by the message they answer. */
const held = new Map<string, Promise<void>>()

/** The loop answers `OK:<the message>`; a held message waits for its release. */
function script(request: RecordedRequest): ScriptedReply | Promise<ScriptedReply> {
  const message = request.latestMessage
  const reply = { text: `OK:${message}` }
  const hold = held.get(message)
  return hold === undefined ? reply : hold.then(() => reply)
}

type LogRecord = SessionLogRecord & { type: string; data?: { [key: string]: unknown } }

const turnEnds = (records: LogRecord[]): LogRecord[] => records.filter(record => record.type === 'turn/end')

/** A frame as the order checks read it: `<id> <event> <ui_protocol>`. */
const frameLine = (frame: ChatWireFrame): string => `${String(frame.id)} ${frame.event} ${String(frame.data['ui_protocol'])}`

describe('lyteboat serve (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('serve')
  let model: ScriptedModel
  let serve: RunningComposition
  let home: string
  let chat: string

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
    const run = scratch.run('serve', { 'AGENTS.md': 'SERVE-WORKSPACE-INSTRUCTIONS\n' })
    home = run.home
    serve = startComposition({
      bundles: LYTEBOAT_SERVE_BUNDLES,
      args: ['--agents', AGENTS, '--port', '0'],
      // A short keep-alive, so a held turn shows the stream's heartbeat.
      patches: [{ id: 'chat-api', config: { auth: 'none', keepAliveMs: 50 } }],
      cwd: run.workspace,
      home,
      env: scriptedModelEnv(model),
      timeoutMs: 170_000,
    })
    chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) \(agents: alpha, beta\)$/mu))[1] ?? ''
  })

  afterAll(async () => {
    const run = await serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('answers a message in one JSON body and records its request on the human message, in a session that reopens', async () => {
    const reply = await postChat(chat, { agent_id: 'alpha', user_id: 'u-1', message: 'hello', trace_id: 't-1', context: { channel: 'app' } })

    expect(reply.status).toBe(200)
    const body = reply.body as { session_id: string; message_id: string }
    expect(body).toEqual({ session_id: expect.any(String) as string, message_id: expect.any(String) as string, outcome: 'completed', response: 'OK:hello', cards: [], tool_calls: [] })
    const records = await waitForSessionLog<LogRecord>(home, body.session_id, log => turnEnds(log).length === 1)
    const human = records.find(record => record.type === 'user/message')
    expect(human?.data?.['source']).toEqual({
      kind: 'user',
      rpcId: body.message_id,
      lyteboatRequest: { requestId: body.message_id, owner: { kind: 'user', id: 'u-1' }, agent: { id: 'alpha', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string }, traceId: 't-1', context: { channel: 'app' } },
    })
    // The session works in the agent's own directory under the lyteboat home, and starts without permission events.
    expect(records[0]).toMatchObject({ type: 'session', cwd: join(home, 'agent-workdirs', 'alpha'), agentPreset: 'alpha' })
    expect(records.map(record => record.type).filter(type => type.startsWith('permission/') || type.startsWith('approval/'))).toEqual([])
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('records the turn\'s run metric with its owner and outcome, and lists no running turn once it ended', async () => {
    const reply = await postChat(chat, { agent_id: 'beta', user_id: 'u-metrics', message: 'measure me' })
    const { session_id: sessionId } = reply.body as { session_id: string }
    const metricsDir = join(home, 'run-metrics')

    const metric = await vi.waitFor(() => {
      const rows = readdirSync(metricsDir).filter(name => name.endsWith('.jsonl'))
        .flatMap(name => readJsonLines<{ sessionId: string }>(join(metricsDir, name)))
      const row = rows.find(candidate => candidate.sessionId === sessionId)
      if (row === undefined) throw new Error(`no run metric for ${sessionId} yet`)
      return row
    }, { timeout: 10_000, interval: 50 })

    expect(metric).toMatchObject({ agentId: 'beta', turn: 1, owner: { kind: 'user', id: 'u-metrics' }, outcome: 'completed', steps: 1, tools: [] })
    await vi.waitFor(() => {
      const heartbeats = readdirSync(join(metricsDir, 'running')).map(name => JSON.parse(readFileSync(join(metricsDir, 'running', name), 'utf8')) as { turns: unknown[] })
      expect(heartbeats.map(heartbeat => heartbeat.turns)).toEqual([[]])
    }, { timeout: 10_000, interval: 50 })
  })

  it('gives the model the agent\'s own composition only: its persona, no coding tool, and nothing of the host\'s', async () => {
    const before = model.requests.length
    await postChat(chat, { agent_id: 'beta', user_id: 'u-1', message: 'what do you see' })

    const requests = model.requests.slice(before)
    expect(requests.map(request => request.purpose)).toEqual(['loop'])
    const [loop] = requests
    expect(loop?.systemText).toMatch(/^You are SERVE-BETA/u)
    expect(loop?.systemText).not.toContain('DeepSeek Harness')
    expect(loop?.systemText).not.toContain('SERVE-WORKSPACE-INSTRUCTIONS')
    // `skill` is the one dsh-base tool the business base leaves, and beta declares no policy.
    expect(loop?.toolNames).toEqual(['skill'])
    // No runtime context either: no sandbox or approval policy, no state.
    expect(loop?.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'what do you see' }] }])
    expect(loop?.body['dsh_plugin_packages']).toBeUndefined()
  })

  it('streams the enterprise frames in protocol order, each tagged by the agent\'s frame decorator', async () => {
    const result = await streamChat(chat, { agent_id: 'alpha', user_id: 'u-1', message: 'hi', message_id: 'm-stream' })

    expect(result.status).toBe(200)
    expect(result.frames.map(frameLine)).toEqual([
      '1 run_started text',
      '2 text_message_start text',
      ...Array.from('OK:hi', (_char, index) => `${String(index + 3)} text_message_content text`),
      '8 text_message_end text',
      '9 run_finished text',
    ])
    expect(result.frames.every(frame => frame.protocol === 'AGUI' && frame.data['agent_tag'] === 'alpha' && frame.data['message_id'] === 'm-stream' && frame.data['agent_name'] === 'alpha')).toBe(true)
    expect(result.frames.at(-1)?.data).toMatchObject({ turn: 1, ui_data: 'OK:hi', extra: { run_outcome: 'completed' } })
  })

  it('continues a session with the conversation so far, and refuses the same message id again', async () => {
    const first = await postChat(chat, { agent_id: 'beta', user_id: 'u-2', message: 'one', message_id: 'm-one' })
    const sessionId = (first.body as { session_id: string }).session_id
    const before = model.requests.length

    const second = await streamChat(chat, { agent_id: 'beta', user_id: 'u-2', message: 'two', session_id: sessionId })
    const again = await postChat(chat, { agent_id: 'beta', user_id: 'u-2', message: 'one', message_id: 'm-one', session_id: sessionId })

    expect(second.frames.at(-1)?.data).toMatchObject({ turn: 2, conversation_id: sessionId, ui_data: 'OK:two' })
    const loop = model.requests.slice(before).filter(request => request.purpose === 'loop')
    expect(loop[0]?.body.messages.filter(message => message.role === 'user').map(message => message.content.find(block => block.type === 'text')?.text)).toEqual(['one', 'two'])
    expect(again).toEqual({ status: 409, body: { error: { code: 'message_duplicate', message: 'message "m-one" was already sent in this session', retryable: false } } })
  })

  it('queues a message sent while the session answers another, and answers each with its own turn', async () => {
    let release = (): void => {}
    held.set('first', new Promise<void>((resolve) => { release = resolve }))
    const opened = await postChat(chat, { agent_id: 'alpha', user_id: 'u-3', message: 'opening' })
    const sessionId = (opened.body as { session_id: string }).session_id
    let started = (): void => {}
    const firstStarted = new Promise<void>((resolve) => { started = resolve })

    const first = streamChat(chat, { agent_id: 'alpha', user_id: 'u-3', message: 'first', session_id: sessionId }, { onFrame: (frame) => { if (frame.event === 'run_started') started() } })
    await firstStarted
    const second = streamChat(chat, { agent_id: 'alpha', user_id: 'u-3', message: 'second', session_id: sessionId })
    // The stream opens once the session controller queued the message.
    await vi.waitFor(() => { expect(model.requests.some(request => request.latestMessage === 'first')).toBe(true) })
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.frames.at(-1)?.data).toMatchObject({ turn: 2, ui_data: 'OK:first', extra: { run_outcome: 'completed' } })
    expect(secondResult.frames.at(-1)?.data).toMatchObject({ turn: 3, ui_data: 'OK:second', extra: { run_outcome: 'completed' } })
    expect(firstResult.keepAlives).toBeGreaterThan(0)
  })

  it('cancels the turn of a caller that left, and a message queued behind it still gets its own turn', async () => {
    held.set('never', new Promise<void>(() => {}))
    const opened = await postChat(chat, { agent_id: 'beta', user_id: 'u-4', message: 'opening' })
    const sessionId = (opened.body as { session_id: string }).session_id
    let leaveFirst: (() => void) | undefined

    const left = streamChat(chat, { agent_id: 'beta', user_id: 'u-4', message: 'never', session_id: sessionId }, { onFrame: (frame, leave) => { if (frame.event === 'run_started') leaveFirst = leave } })
    await vi.waitFor(() => { expect(leaveFirst).toBeDefined() })
    // Its stream opens once the message is queued behind the held turn; the first caller leaves then.
    const behind = streamChat(chat, { agent_id: 'beta', user_id: 'u-4', message: 'behind', session_id: sessionId }, { onOpen: () => { leaveFirst?.() } })
    const [leftResult, behindResult] = await Promise.all([left, behind])

    expect(leftResult.frames.map(frame => frame.event)).toEqual(['run_started'])
    expect(behindResult.frames.at(-1)?.data).toMatchObject({ turn: 3, ui_data: 'OK:behind', extra: { run_outcome: 'completed' } })
    const records = await waitForSessionLog<LogRecord>(home, sessionId, log => turnEnds(log).length === 3)
    expect(turnEnds(records).map(record => record.data?.['reason'])).toMatchObject([{ kind: 'completed' }, { kind: 'aborted' }, { kind: 'completed' }])
  })

  it('refuses what it cannot answer with the status and code the protocol names', async () => {
    const opened = await postChat(chat, { agent_id: 'alpha', user_id: 'owner', message: 'mine' })
    const sessionId = (opened.body as { session_id: string }).session_id
    const refusal = async (body: unknown): Promise<[number, string]> => {
      const reply = await postChat(chat, body)
      return [reply.status, (reply.body as { error: { code: string } }).error.code]
    }

    expect(await refusal('{')).toEqual([400, 'invalid_request'])
    expect(await refusal({ agent_id: 'gamma', user_id: 'owner', message: 'hi' })).toEqual([404, 'agent_not_found'])
    expect(await refusal({ agent_id: 'alpha', user_id: 'owner', message: 'hi', session_id: 'no-such-session' })).toEqual([404, 'session_not_found'])
    // Another caller's session answers as one that does not exist.
    expect(await refusal({ agent_id: 'alpha', user_id: 'intruder', message: 'hi', session_id: sessionId })).toEqual([404, 'session_not_found'])
    expect(await refusal({ agent_id: 'beta', user_id: 'owner', message: 'hi', session_id: sessionId })).toEqual([409, 'agent_mismatch'])
    const get = await fetch(chat)
    expect(get.status).toBe(405)
  })

  it('lists the agents it serves, and reports healthy', async () => {
    const agents = await fetch(new URL('/agents', chat))
    const health = await fetch(new URL('/health', chat))

    expect(await agents.json()).toEqual({
      agents: [
        { id: 'alpha', name: 'Alpha', description: '人设加一个帧装饰器，用于 /chat 的接线测试。' },
        { id: 'beta', name: 'Beta', description: '只有人设，用于 /chat 的 agent 不符测试。' },
      ],
      failures: [],
    })
    expect(await health.json()).toEqual({ status: 'ok' })
  })
})

describe('lyteboat serve --auth shared-secret (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('serve-auth')
  let model: ScriptedModel
  let serve: RunningComposition
  let chat: string

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
    const run = scratch.run('auth')
    serve = startComposition({
      bundles: LYTEBOAT_SERVE_BUNDLES,
      args: ['--agents', AGENTS, '--port', '0', '--auth', 'shared-secret', '--secret-env', 'SERVE_TEST_SECRET'],
      cwd: run.workspace,
      home: run.home,
      env: { ...scriptedModelEnv(model), SERVE_TEST_SECRET: 'open-sesame' },
    })
    chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/\S+\/chat) /mu))[1] ?? ''
  })

  afterAll(async () => {
    const run = await serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('answers only a caller that presents the secret', async () => {
    const request = { agent_id: 'beta', user_id: 'u-1', message: 'hello' }

    expect(await postChat(chat, request)).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
    expect(await postChat(chat, request, { token: 'wrong' })).toMatchObject({ status: 401 })
    expect(await postChat(chat, request, { token: 'open-sesame' })).toMatchObject({ status: 200, body: { response: 'OK:hello' } })
    expect((await fetch(new URL('/agents', chat))).status).toBe(401)
  })
})

describe('lyteboat serve startup (in process)', () => {
  const scratch = createLyteboatScratch('serve-startup')

  afterAll(() => { scratch.remove() })

  it('refuses to serve every interface without auth, and needs an agent directory', async () => {
    const run = scratch.run('startup')
    const target = { cwd: run.workspace, home: run.home, env: { DSH_TELEMETRY_DISABLED: '1' } }

    const open = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--agents', AGENTS, '--host', '0.0.0.0'], ...target })
    const none = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: [], ...target })

    expect(open.code).not.toBe(0)
    expect(open.stderr).toContain('error: --auth none serves only 127.0.0.1; use --auth shared-secret with --host 0.0.0.0')
    expect(none.code).not.toBe(0)
    expect(none.stderr).toContain('error: at least one --agents directory or --release lock is required')
  })

  it('refuses to serve an agent that declares a model other than the one this process runs', async () => {
    const run = scratch.run('model')
    const roots = mkdtempSync(join(tmpdir(), 'serve-model-'))
    cpSync(join(AGENTS, 'beta'), join(roots, 'beta'), { recursive: true })
    writeFileSync(join(roots, 'beta', 'agent.yml'), 'model: { provider: deepseek-official, model: deepseek-pro }\n')
    const target = { cwd: run.workspace, home: run.home, env: { DSH_TELEMETRY_DISABLED: '1' } }

    const result = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--agents', roots, '--port', '0'], ...target })
    rmSync(roots, { recursive: true, force: true })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('beta: agent.yml declares model deepseek-official/deepseek-pro, but this process runs deepseek-official/deepseek-flash')
  })

  it('refuses a chat-api config key it does not have, such as the retired workspace', async () => {
    const run = scratch.run('retired')
    const target = { cwd: run.workspace, home: run.home, env: { DSH_TELEMETRY_DISABLED: '1' } }

    const result = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--agents', AGENTS, '--port', '0'], patches: [{ id: 'chat-api', config: { auth: 'none', workspace: run.workspace } }], ...target })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('chat-api: unknown config key "workspace"; allowed: auth, credentialRef, maxBodyBytes, keepAliveMs')
    expect(result.stderr).toContain('lyteboat: startup failed: lyteboat-serve did not activate (the entries above say why)')
  })
})
