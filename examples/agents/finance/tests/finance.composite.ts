/**
 * The finance agent in the business one-shot composition (in process, scripted DeepSeek
 * Messages server): each request names its customer in `--context` and is
 * admitted at its turn's first step (the unauthorized card and the service
 * scope answer without a loop request); the persona is the whole system prompt, the
 * official tools are narrowed away, the routed skill's tool alone reaches the
 * model at temperature 0, and the cards are placed where the answer marks
 * them. A routed session reopens under dsh's persistence, and `--session-id`
 * continues it in a new process with the context it began with.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LYTEBOAT_HEADLESS_AGENT_BUNDLES, bootComposition, printedSessionId } from '@lyteboat/testkit/composition'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { findSessionLogs, readSessionLog } from '@lyteboat/testkit/session-log'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { AGENTS, FINANCE_TOOLS, blockText, financeScript, isIntake, isLoop, lastToolResult } from './support/finance-model.ts'

type LogRecord = { type: string; ignorable?: true; data?: Record<string, unknown> }

describe('finance agent in the business one-shot composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('finance')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(financeScript), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  async function run(label: string, customer: string | undefined, task: string, extra: string[] = []): Promise<{ requests: RecordedRequest[]; records: LogRecord[]; stdout: string; home: string }> {
    const { home, workspace } = scratch.run(label)
    const before = model.requests.length
    const result = await bootComposition({
      bundles: LYTEBOAT_HEADLESS_AGENT_BUNDLES,
      args: ['--agents', AGENTS, '--agent', 'finance', ...customer === undefined ? [] : ['--context', JSON.stringify({ customer })], ...extra, task],
      cwd: workspace,
      home,
      env: scriptedModelEnv(model),
    })
    expect(result.code, result.stderr).toBe(0)
    const [log] = findSessionLogs(home)
    return { requests: model.requests.slice(before), records: readSessionLog(log!) as unknown as LogRecord[], stdout: result.stdout, home }
  }

  const resultMeta = (records: LogRecord[]) => records.find(record => record.type === 'tool/result')?.data?.['meta'] as {
    lyteboat?: { cards?: { area: string; emission: string; surfaceId: string }[] }
  } | undefined

  it('"看看我的资产": the persona is the whole system prompt and only the routed tool reaches the model, at temperature 0', async () => {
    const { requests, records, stdout } = await run('overview', 'young-idle-cash', '看看我的资产')
    // The answer's marker became the card's place: the terminal prints it as a line of its own.
    expect(stdout).toBe('FINANCE-OK\n[card asset_overview]\n')
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
    const { requests, records, stdout } = await run('diagnosis', 'midlife-moderate', '我的配置合理吗')
    const digest = lastToolResult(requests.filter(isLoop)[1]!)
    expect(digest).toMatch(/^\[tool:allocation_diagnosis status=ok verdict=balanced areas=allocation_diagnosis,allocation_plan\]/u)
    expect(digest).toContain('风险资产占 45.0%；按「100 减年龄」，45 岁的建议区间是 45%–65%')
    expect(resultMeta(records)?.lyteboat?.cards?.map(card => [card.area, card.emission])).toEqual([['allocation_diagnosis', 'deferred'], ['allocation_plan', 'deferred']])
    expect(stdout).toBe('FINANCE-OK\n[card allocation_diagnosis]\n[card allocation_plan]\n')
  })

  it('nothing authorized: the admission answers with the unauthorized card at the turn\'s first step', async () => {
    const { requests, records, stdout } = await run('unauthorized', 'none-authorized', '看看我的资产')
    expect(requests.filter(isIntake)).toHaveLength(1)
    expect(requests.filter(isLoop)).toEqual([])
    expect(requests.filter(request => request.purpose === 'router')).toEqual([])
    expect(stdout).toBe('[card unauthorized]\n您还没有授权任何账户，授权后我就能帮您看资产了。\n')
    const human = records.find(record => record.type === 'user/message' && (record.data?.['source'] as { kind?: unknown } | undefined)?.kind === 'user')
    expect(human?.data?.['source']).toMatchObject({ lyteboatRequest: { context: { customer: 'none-authorized' }, intake: { by: 'finance-admission', decision: 'reply', verdict: 'unauthorized' } } })
    expect(records.filter(record => record.type === 'turn/end')).toHaveLength(1)
  })

  it('out of scope: the admission answers with the service scope, no router and no loop request', async () => {
    const { requests, stdout } = await run('scope', 'midlife-moderate', '帮我写一首诗')
    expect(requests.filter(request => request.purpose === 'router' || isLoop(request))).toEqual([])
    expect(stdout).toBe('这个问题不在我的服务范围内。我可以帮您看看资产、诊断配置，或者讲讲理财常识。\n')
  })

  it('no customer in the context: investor education is still admitted, a question about money gets the no-customer reply', async () => {
    const education = await run('education-anonymous', undefined, '什么是再平衡')
    expect(education.stdout).toBe('FINANCE-OK\n')
    expect(lastToolResult(education.requests.filter(isLoop)[1]!)).toContain('再平衡是定期把各类资产的比例调回目标')

    const money = await run('money-anonymous', undefined, '看看我的资产')
    expect(money.requests.filter(isLoop)).toEqual([])
    expect(money.stdout).toBe('暂时没能识别您的身份，请从已登录的入口进来后再试。\n')
  })

  it('a customer the source does not know gets the no-customer reply instead of a failed run', async () => {
    const { requests, stdout } = await run('unknown-customer', 'nobody-here', '看看我的资产')
    expect(requests.filter(isLoop)).toEqual([])
    expect(stdout).toBe('暂时没能识别您的身份，请从已登录的入口进来后再试。\n')
  })

  it('"什么是再平衡": investor education answers from the knowledge base without a card', async () => {
    const { requests, records } = await run('education', 'midlife-moderate', '什么是再平衡')
    expect(lastToolResult(requests.filter(isLoop)[1]!)).toMatch(/^\[tool:lookup_knowledge status=ok topic=再平衡 areas=none\]/u)
    expect(lastToolResult(requests.filter(isLoop)[1]!)).toContain('再平衡是定期把各类资产的比例调回目标')
    expect(resultMeta(records)?.lyteboat).toBeUndefined()
  })

  it('imported history: the admission classifier sees the imported questions beside their answers', async () => {
    const history = join(scratch.root, 'history.json')
    writeFileSync(history, JSON.stringify({ context: { history: [
      { channel: 'app', createTime: '2026-09-20 10:00:00', role: 'user', traceId: 'trace-0001', parts: [{ type: 'text', text: '帮我看看我的资产' }] },
      { channel: 'app', createTime: '2026-09-20 10:00:06', role: 'assistant', traceId: 'trace-0001', parts: [{ type: 'text', text: '您的资产合计 8 万元。' }] },
    ] } }))
    const { requests } = await run('history', 'young-idle-cash', '我的配置合理吗', ['--history', history])
    expect(requests.find(isIntake)?.lastUser).toContain('<conversation>\n用户：帮我看看我的资产\n助手：您的资产合计 8 万元。\n</conversation>')
  })

  it('a routed session reopens under dsh persistence: every fact rides a dsh envelope, the side calls ignorable records', async () => {
    const { records } = await run('reopen', 'young-idle-cash', '看看我的资产')
    expect(reopenRefusal(records)).toBeUndefined()
    const own = records.filter(record => record.type.startsWith('lyteboat/'))
    expect(own.map(record => [record.type, record.ignorable, record.data?.['purpose']])).toEqual([['lyteboat/aux-llm-call', true, 'intake'], ['lyteboat/aux-llm-call', true, 'skill-router']])
  })

  it('--session-id continues in a new process: the diagnosis turn keeps the customer and sees the overview it already gave', async () => {
    const { home, workspace } = scratch.run('continue')
    const boot = (args: string[]) => bootComposition({
      bundles: LYTEBOAT_HEADLESS_AGENT_BUNDLES,
      args: ['--agents', AGENTS, '--agent', 'finance', ...args],
      cwd: workspace,
      home,
      env: scriptedModelEnv(model),
    })
    // Only the first request names the customer: the continued session keeps its context.
    const first = await boot(['--context', '{"customer":"young-idle-cash"}', '看看我的资产'])
    expect(first.code, first.stderr).toBe(0)
    const id = printedSessionId(first.stderr)
    const before = model.requests.length

    const second = await boot(['--session-id', id, '我的配置合理吗'])
    expect(second.code, second.stderr).toBe(0)
    const loop = model.requests.slice(before).filter(isLoop)
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
    const [log] = findSessionLogs(home)
    const records = readSessionLog(log!) as unknown as LogRecord[]
    expect(records.filter(record => record.type === 'turn/start')).toHaveLength(2)
    const toolUpdates = records.filter(record => record.type === 'developer/message').map(record => record.data?.['message'] as { source: unknown; content: unknown })
    expect(toolUpdates.map(message => [message.source, message.content])).toEqual([[
      { kind: 'tool-registry' },
      [{ type: 'tool-addition', toolName: 'allocation_diagnosis' }, { type: 'tool-removal', toolName: 'asset_overview' }],
    ]])
    expect(reopenRefusal(records)).toBeUndefined()
  })
})
