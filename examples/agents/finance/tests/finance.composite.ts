/**
 * The finance agent behind `lyteboat serve` (the serve composition in process,
 * scripted DeepSeek Messages server): each request names its customer in its
 * `context` and is admitted at its turn's first step (the unauthorized card and
 * the service scope answer without a loop request); the persona is the whole
 * system prompt, the official tools are narrowed away, the routed skill's tool
 * alone reaches the model at temperature 0, and the cards are placed where the
 * answer marks them. A routed session reopens under dsh's persistence, and a
 * continued session keeps the context it began with.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat } from '@lyteboat/testkit/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, startComposition, type RunningComposition } from '@lyteboat/testkit/composition'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testkit/session-log'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { AGENTS, FINANCE_TOOLS, blockText, financeScript, isIntake, isLoop, lastToolResult } from './support/finance-model.ts'

type LogRecord = SessionLogRecord & { type: string; ignorable?: true; data?: Record<string, unknown> }

/** The fields of a `/chat` JSON reply these tests read. */
interface FinanceReply {
  session_id: string
  outcome: string
  response: string
  cards: { area: string }[]
}

describe('finance agent in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('finance')
  let model: ScriptedModel
  let serve: RunningComposition
  let home: string
  let chat: string

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(financeScript), { apiKey: 'mock-key' })
    const run = scratch.run('serve')
    home = run.home
    serve = startComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--agents', AGENTS, '--port', '0'], cwd: run.workspace, home, env: scriptedModelEnv(model), timeoutMs: 170_000 })
    chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/\S+\/chat) /mu))[1] ?? ''
  })

  afterAll(async () => {
    const run = await serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  /** Ask the finance agent once, in a new session or `sessionId`'s, and read the session's log once the turn ended. */
  async function ask(customer: string | undefined, message: string, sessionId?: string): Promise<{ requests: RecordedRequest[]; records: LogRecord[]; reply: FinanceReply }> {
    const before = model.requests.length
    const response = await postChat(chat, {
      agent_id: 'finance',
      user_id: 'u-finance',
      message,
      ...customer === undefined ? {} : { context: { customer } },
      ...sessionId === undefined ? {} : { session_id: sessionId },
    })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const reply = response.body as FinanceReply
    const records = await waitForSessionLog<LogRecord>(home, reply.session_id, log => log.filter(record => record.type === 'turn/end').length === (sessionId === undefined ? 1 : 2))
    return { requests: model.requests.slice(before), records, reply }
  }

  const resultMeta = (records: LogRecord[]) => records.find(record => record.type === 'tool/result')?.data?.['meta'] as {
    lyteboat?: { cards?: { area: string; emission: string; surfaceId: string }[] }
  } | undefined

  it('"看看我的资产": the persona is the whole system prompt and only the routed tool reaches the model, at temperature 0', async () => {
    const { requests, records, reply } = await ask('young-idle-cash', '看看我的资产')
    // The answer's marker became the card's place: the card follows the text.
    expect(reply).toMatchObject({ outcome: 'completed', response: 'FINANCE-OK\n', cards: [{ area: 'asset_overview' }] })
    const loop = requests.filter(isLoop)
    expect(loop).toHaveLength(2)
    expect(loop[0]!.body.system).toContain('你是「轻舟金融助手」')
    expect(loop[0]!.body.system).not.toContain('coding agent')
    expect(loop[0]!.toolNames.filter(name => FINANCE_TOOLS.includes(name))).toEqual(['asset_overview'])
    expect(loop[0]!.toolNames.filter(name => !FINANCE_TOOLS.includes(name))).toEqual(['skill'])
    expect(loop[0]!.body['temperature']).toBe(0)
    expect(lastToolResult(loop[1]!)).toContain('【事实】\n- 已授权资产合计 80,000.00 元（约 8.00 万元）')
    expect(lastToolResult(loop[1]!)).toContain('稳健资产（存款、货币基金、债券） 54,400.00 元（约 5.44 万元），占 68.0%')
    expect(lastToolResult(loop[1]!)).toContain('【不可答】')
    expect(resultMeta(records)?.lyteboat?.cards).toEqual([expect.objectContaining({ area: 'asset_overview', emission: 'deferred', surfaceId: expect.stringMatching(/^asset_overview-/u) as string })])
  })

  it('"我的配置合理吗": the diagnosis prepares two cards, and the answer places both', async () => {
    const { requests, records, reply } = await ask('midlife-moderate', '我的配置合理吗')
    const digest = lastToolResult(requests.filter(isLoop)[1]!)
    expect(digest).toMatch(/^\[tool:allocation_diagnosis status=ok verdict=balanced areas=allocation_diagnosis,allocation_plan\]/u)
    expect(digest).toContain('风险资产占 45.0%；按「100 减年龄」，45 岁的建议区间是 45%–65%')
    expect(resultMeta(records)?.lyteboat?.cards?.map(card => [card.area, card.emission])).toEqual([['allocation_diagnosis', 'deferred'], ['allocation_plan', 'deferred']])
    expect(reply).toMatchObject({ response: 'FINANCE-OK\n', cards: [{ area: 'allocation_diagnosis' }, { area: 'allocation_plan' }] })
  })

  it('nothing authorized: the admission answers with the unauthorized card at the turn\'s first step', async () => {
    const { requests, records, reply } = await ask('none-authorized', '看看我的资产')
    expect(requests.filter(isIntake)).toHaveLength(1)
    expect(requests.filter(isLoop)).toEqual([])
    expect(requests.filter(request => request.purpose === 'router')).toEqual([])
    expect(reply).toMatchObject({ outcome: 'rejected', response: '您还没有授权任何账户，授权后我就能帮您看资产了。', cards: [{ area: 'unauthorized' }] })
    const human = records.find(record => record.type === 'user/message' && (record.data?.['source'] as { kind?: unknown } | undefined)?.kind === 'user')
    expect(human?.data?.['source']).toMatchObject({ lyteboatRequest: { context: { customer: 'none-authorized' }, intake: { by: 'finance-admission', decision: 'reply', verdict: 'unauthorized' } } })
    expect(records.filter(record => record.type === 'turn/end')).toHaveLength(1)
  })

  it('out of scope: the admission answers with the service scope, no router and no loop request', async () => {
    const { requests, reply } = await ask('midlife-moderate', '帮我写一首诗')
    expect(requests.filter(request => request.purpose === 'router' || isLoop(request))).toEqual([])
    expect(reply).toMatchObject({ outcome: 'rejected', response: '这个问题不在我的服务范围内。我可以帮您看看资产、诊断配置，或者讲讲理财常识。', cards: [] })
  })

  it('no customer in the context: investor education is still admitted, a question about money gets the no-customer reply', async () => {
    const education = await ask(undefined, '什么是再平衡')
    expect(education.reply.response).toBe('FINANCE-OK')
    expect(lastToolResult(education.requests.filter(isLoop)[1]!)).toContain('再平衡是定期把各类资产的比例调回目标')

    const money = await ask(undefined, '看看我的资产')
    expect(money.requests.filter(isLoop)).toEqual([])
    expect(money.reply.response).toBe('暂时没能识别您的身份，请从已登录的入口进来后再试。')
  })

  it('a customer the source does not know gets the no-customer reply instead of a failed run', async () => {
    const { requests, reply } = await ask('nobody-here', '看看我的资产')
    expect(requests.filter(isLoop)).toEqual([])
    expect(reply.response).toBe('暂时没能识别您的身份，请从已登录的入口进来后再试。')
  })

  it('"什么是再平衡": investor education answers from the knowledge base without a card', async () => {
    const { requests, records } = await ask('midlife-moderate', '什么是再平衡')
    expect(lastToolResult(requests.filter(isLoop)[1]!)).toMatch(/^\[tool:lookup_knowledge status=ok topic=再平衡 areas=none\]/u)
    expect(lastToolResult(requests.filter(isLoop)[1]!)).toContain('再平衡是定期把各类资产的比例调回目标')
    expect(resultMeta(records)?.lyteboat).toBeUndefined()
  })

  it('a routed session reopens under dsh persistence: every fact rides a dsh envelope, the side calls ignorable records', async () => {
    const { records } = await ask('young-idle-cash', '看看我的资产')
    expect(reopenRefusal(records)).toBeUndefined()
    const own = records.filter(record => record.type.startsWith('lyteboat/'))
    expect(own.map(record => [record.type, record.ignorable, record.data?.['purpose']])).toEqual([['lyteboat/aux-llm-call', true, 'intake'], ['lyteboat/aux-llm-call', true, 'skill-router']])
  })

  it('a continued session: the diagnosis turn keeps the customer and sees the overview it already gave', async () => {
    // Only the first request names the customer: the continued session keeps its context.
    const first = await ask('young-idle-cash', '看看我的资产')

    const { requests, records } = await ask(undefined, '我的配置合理吗', first.reply.session_id)

    const loop = requests.filter(isLoop)
    expect(loop[0]!.toolNames.filter(name => FINANCE_TOOLS.includes(name))).toEqual(['allocation_diagnosis'])
    // dsh's default DeepSeek route updates tools in history (addition-only): the switched skill's
    // tool is declared deferred and activated by a system update after the new user turn.
    expect(loop[0]!.body.tools?.find(tool => tool.name === 'allocation_diagnosis')).toMatchObject({ defer_loading: true })
    expect(loop[0]!.body.messages.at(-1)).toEqual({ role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'allocation_diagnosis' } }] })
    const earlier = loop[0]!.body.messages.flatMap(message => message.content.filter(block => block.type === 'tool_result')).map(blockText)
    expect(earlier).toHaveLength(1)
    expect(earlier[0]).toMatch(/^\[tool:asset_overview status=ok areas=asset_overview\]/u)
    expect(lastToolResult(loop[1]!)).toMatch(/^\[tool:allocation_diagnosis status=ok verdict=cautious /u)
    expect(lastToolResult(loop[1]!)).toContain('风险资产占 32.0%；按「100 减年龄」，28 岁的建议区间是 62%–82%')
    expect(records.filter(record => record.type === 'turn/start')).toHaveLength(2)
    const toolUpdates = records.filter(record => record.type === 'developer/message').map(record => record.data?.['message'] as { source: unknown; content: unknown })
    expect(toolUpdates.map(message => [message.source, message.content])).toEqual([[
      { kind: 'tool-registry' },
      [{ type: 'tool-addition', toolName: 'allocation_diagnosis' }, { type: 'tool-removal', toolName: 'asset_overview' }],
    ]])
    expect(reopenRefusal(records)).toBeUndefined()
  })
})
