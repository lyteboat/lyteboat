/**
 * The finance agent behind `/chat` (the serve composition in process, scripted
 * model): a message goes through dsh's session controller with its request on
 * the human message, the tool reads the customer from that context, a
 * continued session keeps it, and the session reopens. The enterprise frames of
 * four scenarios are goldens: an overview with its card, a diagnosis with two,
 * education without a card, and a request the admission answers in the loop.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { postChat, streamChat, type ChatWireFrame } from '@lyteboat/testing/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, startComposition, type RunningComposition } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { findSessionLogs, readSessionLog, type SessionLogRecord } from '@lyteboat/testing/session-log'
import { reopenRefusal } from '@lyteboat/testing/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'
import { AGENTS, isLoop, lastToolResult, financeScript } from './support/finance-model.ts'

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

  /** The stored log of one session once its turns ended (the store batches its writes). */
  function storedLog(sessionId: string, turns: number): Promise<LogRecord[]> {
    return vi.waitFor(() => {
      const path = findSessionLogs(home).find(candidate => candidate.includes(sessionId))
      const records = path === undefined ? [] : readSessionLog(path) as LogRecord[]
      if (records.filter(record => record.type === 'turn/end').length < turns) throw new Error(`the log of ${sessionId} is not there yet`)
      return records
    }, { timeout: 10_000, interval: 50 })
  }

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
    const records = await storedLog(sessionId, 2)
    const humans = records.filter(record => record.type === 'user/message').map(record => record.data?.['source'] as { kind: string }).filter(source => source.kind === 'user')
    expect(humans).toEqual([
      { kind: 'user', rpcId: 'm-1', lyteboatRequest: { requestId: 'm-1', owner: { kind: 'user', id: 'u-1' }, agent: FINANCE, traceId: 't-1', context: { customer: 'young-idle-cash' } } },
      { kind: 'user', rpcId: 'm-2', lyteboatRequest: { requestId: 'm-2', owner: { kind: 'user', id: 'u-1' }, agent: FINANCE } },
    ])
    expect(reopenRefusal(records)).toBeUndefined()
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
