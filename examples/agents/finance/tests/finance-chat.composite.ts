/**
 * The finance agent behind `/chat` (the serve composition in process, scripted
 * model): a message goes through dsh's session controller with its request on
 * the human message, the tool reads the customer from that context, a
 * continued session keeps it, and the session reopens. The enterprise frames of
 * four scenarios are goldens: an overview with its card, a diagnosis with two,
 * education without a card, and a request the admission answers in the loop.
 * A customer with nothing authorized gets the admission's card, its verdict
 * logged on the request. History a request brings reaches the admission's
 * classifier as conversation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat, streamChat, type ChatWireFrame } from '@lyteboat/testkit/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, startComposition, type RunningComposition } from '@lyteboat/testkit/composition'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testkit/session-log'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { AGENTS, isIntake, isLoop, lastToolResult, financeScript } from './support/finance-model.ts'

type LogRecord = SessionLogRecord & { type: string; data?: { [key: string]: unknown } }

/** The frames as a golden file holds them: the clock, the session id, and minted surface ids masked. */
function goldenFrames(frames: readonly ChatWireFrame[]): string {
  const masked = frames.map(frame => ({ ...frame, data: { ...frame.data, timestamp: '<timestamp>', conversation_id: '<session>' } }))
  return `${JSON.stringify(masked, null, 2).replaceAll(/-session--[0-9a-f]{6}\b/gu, '-<surface>')}\n`
}

/** The finance agent as its catalog stamps a request: its manifest's version and its directory's digest. */
const FINANCE = { id: 'finance', version: '1.0.0', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string }

describe('finance agent behind /chat (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('finance-chat')
  let model: ScriptedModel
  let serve: RunningComposition
  let home: string
  let chat: string

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(financeScript), { apiKey: 'mock-key' })
    const run = scratch.run('serve')
    home = run.home
    serve = startComposition({
      bundles: LYTEBOAT_SERVE_BUNDLES,
      args: ['--agents', AGENTS, '--port', '0'],
      cwd: run.workspace,
      home,
      env: scriptedModelEnv(model),
      timeoutMs: 170_000,
    })
    // The root is the repository's examples/agents, which may hold other agents beside finance.
    chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/\S+\/chat) \(agents: (?:[a-z0-9-]+, )*finance(?:, [a-z0-9-]+)*\)$/mu))[1] ?? ''
  })

  afterAll(async () => {
    const run = await serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('records the request on the human message, the tool reads the customer from it, and a continued session keeps it', async () => {
    const before = model.requests.length
    const first = await postChat(chat, { agent_id: 'finance', user_id: 'u-1', message: '看看我的资产', message_id: 'm-1', trace_id: 't-1', context: { customer: 'young-idle-cash' } })
    const sessionId = (first.body as { session_id: string }).session_id
    const second = await postChat(chat, { agent_id: 'finance', user_id: 'u-1', message: '我的配置合理吗', message_id: 'm-2', session_id: sessionId })

    expect(first.body).toMatchObject({ outcome: 'completed', response: 'FINANCE-OK\n', cards: [{ area: 'asset_overview' }], tool_calls: [{ name: 'asset_overview', arguments: {} }] })
    expect(second.body).toMatchObject({ outcome: 'completed', cards: [{ area: 'allocation_diagnosis' }, { area: 'allocation_plan' }] })
    const loop = model.requests.slice(before).filter(isLoop)
    expect(lastToolResult(loop[1]!)).toContain('已授权资产合计 80,000.00 元（约 8.00 万元）')
    expect(lastToolResult(loop[3]!)).toContain('风险资产占 32.0%；按「100 减年龄」，28 岁的建议区间是 62%–82%')
    const records = await waitForSessionLog<LogRecord>(home, sessionId, log => log.filter(record => record.type === 'turn/end').length >= 2)
    const humans = records.filter(record => record.type === 'user/message').map(record => record.data?.['source'] as { kind: string }).filter(source => source.kind === 'user')
    expect(humans).toEqual([
      { kind: 'user', rpcId: 'm-1', lyteboatRequest: { requestId: 'm-1', owner: { kind: 'user', id: 'u-1' }, agent: FINANCE, traceId: 't-1', context: { customer: 'young-idle-cash' } } },
      { kind: 'user', rpcId: 'm-2', lyteboatRequest: { requestId: 'm-2', owner: { kind: 'user', id: 'u-1' }, agent: FINANCE } },
    ])
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('answers a customer with nothing authorized with the unauthorized card, and logs the verdict on the request', async () => {
    const before = model.requests.length
    const reply = await postChat(chat, { agent_id: 'finance', user_id: 'u-2', message: '看看我的资产', message_id: 'm-3', context: { customer: 'none-authorized' } })
    const sessionId = (reply.body as { session_id: string }).session_id

    expect(reply.body).toMatchObject({ outcome: 'rejected', response: '您还没有授权任何账户，授权后我就能帮您看资产了。', cards: [{ area: 'unauthorized' }], tool_calls: [] })
    expect(model.requests.slice(before).filter(isLoop)).toEqual([])
    const records = await waitForSessionLog<LogRecord>(home, sessionId, log => log.some(record => record.type === 'turn/end'))
    const human = records.find(record => record.type === 'user/message' && (record.data?.['source'] as { kind?: unknown } | undefined)?.kind === 'user')
    expect(human?.data?.['source']).toMatchObject({ rpcId: 'm-3', lyteboatRequest: { requestId: 'm-3', context: { customer: 'none-authorized' }, intake: { by: 'finance-admission', decision: 'reply', verdict: 'unauthorized', cards: [{ area: 'unauthorized' }] } } })
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('imports the history a request brings, and the admission classifier sees the imported question beside its answer', async () => {
    const before = model.requests.length
    const history = [
      { channel: 'app', createTime: '2026-09-20 10:00:00', role: 'user', traceId: 'trace-0001', parts: [{ type: 'text', text: '帮我看看我的资产' }] },
      { channel: 'app', createTime: '2026-09-20 10:00:06', role: 'assistant', traceId: 'trace-0001', parts: [{ type: 'text', text: '您的资产合计 8 万元。' }] },
    ]

    const reply = await postChat(chat, { agent_id: 'finance', user_id: 'u-history', message: '我的配置合理吗', trace_id: 'trace-0002', context: { customer: 'young-idle-cash' }, history })

    expect(reply.body).toMatchObject({ outcome: 'completed', cards: [{ area: 'allocation_diagnosis' }, { area: 'allocation_plan' }] })
    expect(model.requests.slice(before).find(isIntake)?.lastUser).toContain('<conversation>\n用户：帮我看看我的资产\n助手：您的资产合计 8 万元。\n</conversation>')
  })

  it.each([
    ['overview', 'young-idle-cash', '看看我的资产'],
    ['diagnosis', 'midlife-moderate', '我的配置合理吗'],
    ['education', 'midlife-moderate', '什么是再平衡'],
    ['out-of-scope', 'midlife-moderate', '帮我写一首诗'],
  ])('streams the %s scenario as its golden frames', async (scenario, customer, message) => {
    const result = await streamChat(chat, { agent_id: 'finance', user_id: 'u-golden', message, message_id: `golden-${scenario}`, context: { customer } })

    expect(result.status).toBe(200)
    await expect(goldenFrames(result.frames)).toMatchFileSnapshot(`./fixtures/frames/${scenario}.json`)
  })
})
