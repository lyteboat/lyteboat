/**
 * The skill router at the agent loop's seams: dynamic routing per user input,
 * same-step body and tool visibility, sticky decisions, model-initiated
 * activation, a session continued by a fresh agent, full mode, off, the
 * router's budget, and skill metadata that fails loud.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, buildForkSeed, type SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { defineContentToolFixture, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse, toolCallResponse } from '@lyteboat/testkit'
import AuxLlmService from '@lyteboat/aux-llm'
import LyteboatDistroService from '@lyteboat/distro'
import ToolPolicyService from '@lyteboat/tool-policy'
import type { LyteboatActiveSkillState } from '@lyteboat/contracts'
import SkillRouterService, { lyteboatActiveSkillProjectionDefinition, type Config } from '@lyteboat/skill-router'

async function harness(adapter: MockAdapter, config: Config): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(AuxLlmService)
  await ctx.plugin(SkillRouterService, config)
  ctx.skills.register({ name: 'asset-overview', description: '资产总览与配置诊断', content: 'BODY-ASSET', source: 'custom', metadata: { lyteboat: { requiredTools: ['lookup_assets'] } } })
  ctx.skills.register({ name: 'market-news', description: '市场行情与新闻', content: 'BODY-NEWS', source: 'custom', metadata: { lyteboat: { requiredTools: ['fetch_news'] } } })
  ctx.toolPolicy.register(echo('lookup_assets'), { visibility: 'auto' })
  ctx.toolPolicy.register(echo('fetch_news'), { visibility: 'auto' })
  ctx.toolPolicy.register(echo('always_tool'), { visibility: 'always' })
  return ctx
}

function echo(name: string): ToolDefinition {
  return defineContentToolFixture({ name, description: name, parameters: {}, execute: async () => [{ type: 'text', text: `${name} ran` }] })
}

const isRouter = (request: GenerateOptions): boolean => (request.system ?? '').includes('skill 路由器')
const loopRequests = (adapter: MockAdapter): GenerateOptions[] => adapter.requests.filter(request => !isRouter(request))
const routerRequests = (adapter: MockAdapter): GenerateOptions[] => adapter.requests.filter(isRouter)
const toolNames = (request: GenerateOptions): string[] => (request.tools ?? []).map(tool => tool.name).sort()
const messagesText = (request: GenerateOptions): string => JSON.stringify(request.messages)
/** The skill-invocation messages the session logged, as `[skill, text]`. */
const invocations = (agent: Agent): [string, string][] =>
  agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map(event => event.data)
    .filter((message: UserMessage) => message.source.kind === 'skill-invocation')
    .map(message => [message.source.kind === 'skill-invocation' ? message.source.name : '', message.content.map(block => block.type === 'text' ? block.text : '').join('\n')])
const routerCalls = (agent: Agent): SessionEvent<'lyteboat/aux-llm-call'>[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'lyteboat/aux-llm-call'> => event.type === 'lyteboat/aux-llm-call')
const countOf = (text: string, part: string): number => text.split(part).length - 1
const stepError = (agent: Agent): string => {
  const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end') as SessionEvent<'turn/end'> | undefined
  const reason = turnEnd?.data.reason
  return reason?.kind === 'error' ? reason.error.message : ''
}

describe('dynamic mode', () => {
  it('routes each user input, brings the body in as a skill-invocation message with the required tools in the same step, and stays sticky', async () => {
    const adapter = new MockAdapter([
      textResponse('{"skill_id": "asset-overview", "reason": "看资产"}'), textResponse('one'),
      textResponse('{"skill_id": null, "reason": "追问"}'), textResponse('two'),
      textResponse('garbage'), textResponse('three'),
      textResponse('{"skill_id": "market-news", "reason": "切到行情"}'), textResponse('four'),
    ])
    const ctx = await harness(adapter, { mode: 'dynamic', historyWindow: 6 })
    const agent = await ctx.agentLoop.create(SessionId('dynamic'), { provider: 'mock', model: 'mock' })

    await send(agent, '看看我的资产')
    expect(routerRequests(adapter)).toHaveLength(1)
    const router = routerRequests(adapter)[0]!
    expect(router.messages).toHaveLength(1)
    expect(messagesText(router)).toContain('<available_skills>')
    expect(messagesText(router)).toContain('<latest_user_input>看看我的资产</latest_user_input>')
    expect(router.maxTokens).toBe(200)
    expect(router.sessionId).toBe(agent.session.id)
    const first = loopRequests(adapter)[0]!
    expect(toolNames(first)).toEqual(['always_tool', 'lookup_assets'])
    expect(messagesText(first)).toContain('<skill_instructions>')
    expect(messagesText(first)).toContain('BODY-ASSET')
    expect(messagesText(first)).not.toContain('BODY-NEWS')
    expect(invocations(agent).map(([skill]) => skill)).toEqual(['asset-overview'])
    expect(ctx.skillRouter.activeOf(agent)).toBe('asset-overview')
    expect(ctx.sessionProjections.snapshot(agent.session).values['lyteboatActiveSkill']).toBe('asset-overview')
    const [audit] = routerCalls(agent)
    expect(audit?.ignorable).toBe(true)
    expect(audit?.data).toMatchObject({ purpose: 'skill-router', route: { provider: 'mock', model: 'mock' }, maxTokens: 200, temperature: 0, output: '{"skill_id": "asset-overview", "reason": "看资产"}' })
    expect(audit?.data.prompt).toContain('<latest_user_input>看看我的资产</latest_user_input>')

    // Router says null: kept, and the body already in view is not injected again.
    await send(agent, '那总额呢')
    expect(invocations(agent)).toHaveLength(1)
    expect(ctx.skillRouter.activeOf(agent)).toBe('asset-overview')
    expect(messagesText(routerRequests(adapter)[1]!)).toContain('<current_active_skill>asset-overview</current_active_skill>')
    expect(messagesText(routerRequests(adapter)[1]!)).toContain('user: 看看我的资产')
    expect(toolNames(loopRequests(adapter)[1]!)).toEqual(['always_tool', 'lookup_assets'])
    expect(countOf(messagesText(loopRequests(adapter)[1]!), 'BODY-ASSET')).toBe(1)

    // Malformed reply: kept; the record keeps what the router said.
    await send(agent, '再说一遍')
    expect(routerCalls(agent).map(call => call.data.output)).toEqual(['{"skill_id": "asset-overview", "reason": "看资产"}', '{"skill_id": null, "reason": "追问"}', 'garbage'])
    expect(invocations(agent)).toHaveLength(1)
    expect(ctx.skillRouter.activeOf(agent)).toBe('asset-overview')

    // A valid new id switches: new body with a note on what it replaces, the previous skill's tools hidden.
    await send(agent, '今天行情怎么样')
    expect(invocations(agent).map(([skill]) => skill)).toEqual(['asset-overview', 'market-news'])
    expect(invocations(agent)[1]![1]).toContain('Skill "asset-overview" is no longer active; follow the skill below instead.')
    const fourth = loopRequests(adapter)[3]!
    expect(toolNames(fourth)).toEqual(['always_tool', 'fetch_news'])
    expect(messagesText(fourth)).toContain('BODY-NEWS')
    expect(ctx.skillRouter.activeOf(agent)).toBe('market-news')
  })

  it('keeps the current skill when the router call fails, records the failure, and injects nothing', async () => {
    const adapter = new MockAdapter([
      () => { throw new Error('boom') }, textResponse('one'),
    ])
    const ctx = await harness(adapter, { mode: 'dynamic' })
    const agent = await ctx.agentLoop.create(SessionId('failing'), { provider: 'mock', model: 'mock' })
    await send(agent, '看看资产')
    expect(routerCalls(agent).map(call => call.data.failure)).toEqual([{ reason: 'Error', message: 'boom' }])
    expect(ctx.skillRouter.activeOf(agent)).toBeNull()
    expect(invocations(agent)).toHaveLength(0)
    expect(loopRequests(adapter)).toHaveLength(1)
    expect(toolNames(loopRequests(adapter)[0]!)).toEqual(['always_tool'])
  })

  it('folds a model-initiated skill load and brings its tools into the next step; the body the tool returned is not injected again', async () => {
    const adapter = new MockAdapter([
      textResponse('{"skill_id": null, "reason": "闲聊"}'),
      toolCallResponse('c1', 'skill', { name: 'market-news' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { mode: 'dynamic' })
    // Returns the body the way dsh-tool-skill's `skill` tool does.
    ctx.tools.register(defineContentToolFixture({
      name: 'skill', description: 'load a skill', parameters: { name: { type: 'string', required: true } },
      execute: async ({ name }) => [{ type: 'text', text: renderSkillContent((await ctx.skills.get(String(name), {}))!) }],
    }))
    const agent = await ctx.agentLoop.create(SessionId('model-load'), { provider: 'mock', model: 'mock' })
    await send(agent, '你好')
    expect(ctx.skillRouter.activeOf(agent)).toBe('market-news')
    const second = loopRequests(adapter)[1]!
    expect(toolNames(second)).toContain('fetch_news')
    expect(countOf(messagesText(second), 'BODY-NEWS')).toBe(1)
    expect(invocations(agent)).toHaveLength(0)
  })

  it('injects the body of an active skill that is not in view', async () => {
    const adapter = new MockAdapter([
      textResponse('{"skill_id": null, "reason": "闲聊"}'),
      toolCallResponse('c1', 'skill', { name: 'market-news' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter, { mode: 'dynamic' })
    ctx.tools.register(defineContentToolFixture({
      name: 'skill', description: 'load a skill', parameters: { name: { type: 'string', required: true } },
      execute: async ({ name }) => [{ type: 'text', text: `loaded ${String(name)}` }],
    }))
    const agent = await ctx.agentLoop.create(SessionId('not-in-view'), { provider: 'mock', model: 'mock' })
    await send(agent, '你好')
    expect(invocations(agent).map(([skill]) => skill)).toEqual(['market-news'])
    expect(invocations(agent)[0]![1]).not.toContain('no longer active')
    expect(messagesText(loopRequests(adapter)[1]!)).toContain('BODY-NEWS')
  })

  it('restores the active skill\'s tools for a fresh agent over the same log, without injecting the body again', async () => {
    const adapter = new MockAdapter([
      textResponse('{"skill_id": "asset-overview", "reason": "看资产"}'), textResponse('one'),
      textResponse('{"skill_id": null, "reason": "追问"}'), textResponse('two'),
    ])
    const ctx = await harness(adapter, { mode: 'dynamic' })
    const before = await ctx.agentLoop.create(SessionId('before'), { provider: 'mock', model: 'mock' })
    await send(before, '看看我的资产')
    const events = before.session.snapshotEvents()
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('after'),
      meta: { isSeeded: true, parentSession: before.session.id },
      seed: buildForkSeed(events, SessionSeq(events.length - 1)),
      inheritedEventCount: SessionLogOffset(events.length),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.skillRouter.activeOf(agent)).toBe('asset-overview')

    await send(agent, '那总额呢')
    const request = loopRequests(adapter)[1]!
    expect(toolNames(request)).toEqual(['always_tool', 'lookup_assets'])
    expect(countOf(messagesText(request), 'BODY-ASSET')).toBe(1)
    expect(invocations(agent)).toHaveLength(1)
  })
})

describe('the lyteboatActiveSkill fold', () => {
  const fold = (events: object[]): unknown => {
    const definition = lyteboatActiveSkillProjectionDefinition
    return events.reduce((state: LyteboatActiveSkillState, event) => definition.apply(state, event as SessionEvent), definition.init())
  }
  const call = (callId: string, name: string): object => ({ type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'skill', arguments: JSON.stringify({ name }) } })
  const result = (callId: string, isError: boolean): object => ({ type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { toolCallId: callId, isError } } })
  const invocation = (name: string, surfaceOp: unknown): object => ({ type: 'user/message', surfaceOp, data: { source: { kind: 'skill-invocation', name, form: 'instructions' } } })

  it('activates a skill only when its load succeeds', () => {
    expect(fold([call('c1', 'market-news'), result('c1', true)])).toEqual({ active: null, loading: {} })
    expect(fold([call('c1', 'market-news'), result('c1', false)])).toEqual({ active: 'market-news', loading: {} })
  })

  it('folds appended invocations only: a replacement that keeps an old invocation\'s source does not switch back', () => {
    const replaced = { op: 'replace', startSeq: 3, endSeq: 3 }
    expect(fold([invocation('asset-overview', 'append'), invocation('market-news', 'append'), invocation('asset-overview', replaced)]))
      .toEqual({ active: 'market-news', loading: {} })
  })
})

describe('full mode', () => {
  it('renders every skill body as a system prompt section, activates every required tool, and never routes', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter, { mode: 'full' })
    const agent = await ctx.agentLoop.create(SessionId('full'), { provider: 'mock', model: 'mock' })
    await send(agent, '看看资产')
    expect(routerRequests(adapter)).toHaveLength(0)
    const request = loopRequests(adapter)[0]!
    const system = JSON.stringify(request.messages[0])
    expect(request.messages[0]!.role).toBe('system')
    expect(system).toContain('BODY-ASSET')
    expect(system).toContain('BODY-NEWS')
    expect(toolNames(request)).toEqual(['always_tool', 'fetch_news', 'lookup_assets'])
    expect(invocations(agent)).toHaveLength(0)
  })
})

describe('off mode and preset settings', () => {
  it('answers the settings of a standing scope the way it answers its agents', async () => {
    const ctx = await harness(new MockAdapter([]), {})
    const key = {}
    createScope(ctx, key).ctx.get('skillRouter')?.declare({ mode: 'full' })

    expect(ctx.skillRouter.settingsFor(key)).toEqual({ mode: 'full', historyWindow: 6, timeoutMs: 10_000, maxTokens: 200 })
    expect(ctx.skillRouter.settingsFor(undefined).mode).toBe('off')
  })

  it('does nothing when off, and a scoped declaration overrides the host default', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('{"skill_id": "market-news", "reason": "r"}'), textResponse('two')])
    const ctx = await harness(adapter, {})
    const quiet = await ctx.agentLoop.create(SessionId('off'), { provider: 'mock', model: 'mock' })
    await send(quiet, '看看资产')
    expect(routerRequests(adapter)).toHaveLength(0)
    expect(toolNames(loopRequests(adapter)[0]!)).toEqual(['always_tool'])

    const routedAgent = await ctx.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    routedAgent.ctx.get('skillRouter')!.declare({ mode: 'dynamic', historyWindow: 0 })
    expect(ctx.skillRouter.settingsFor(routedAgent)).toEqual({ mode: 'dynamic', historyWindow: 0, timeoutMs: 10_000, maxTokens: 200 })
    expect(ctx.skillRouter.settingsFor(quiet).mode).toBe('off')
    await send(routedAgent, '行情')
    expect(routerRequests(adapter)).toHaveLength(1)
    expect(messagesText(routerRequests(adapter)[0]!)).toContain('(empty)')
    expect(ctx.skillRouter.activeOf(routedAgent)).toBe('market-news')
  })
})

describe('the router budget', () => {
  it('sends the configured maxTokens with every router call, and rejects a budget below 1', async () => {
    const adapter = new MockAdapter([textResponse('{"skill_id": null, "reason": "闲聊"}'), textResponse('one')])
    const ctx = await harness(adapter, { mode: 'dynamic', maxTokens: 64 })
    const agent = await ctx.agentLoop.create(SessionId('budget'), { provider: 'mock', model: 'mock' })

    await send(agent, '你好')
    expect(routerRequests(adapter).map(request => request.maxTokens)).toEqual([64])
    expect(routerCalls(agent).map(call => call.data.maxTokens)).toEqual([64])
    await expect(ctx.plugin(SkillRouterService, { maxTokens: 0 })).rejects.toThrow(/maxTokens expected number >= 1/u)
  })
})

describe('skill metadata that fails loud', () => {
  it('fails the step when the routed skill requires a tool the tool policy does not declare, instead of skipping it', async () => {
    const adapter = new MockAdapter([textResponse('{"skill_id": "broken-tools", "reason": "r"}'), textResponse('never')])
    const ctx = await harness(adapter, { mode: 'dynamic' })
    ctx.skills.register({ name: 'broken-tools', description: '需要一个没有声明的工具', content: 'BODY-BROKEN', source: 'custom', metadata: { lyteboat: { requiredTools: ['lookup_assets', 'not_a_tool'] } } })
    const agent = await ctx.agentLoop.create(SessionId('unknown-tool'), { provider: 'mock', model: 'mock' })

    await send(agent, '看看')
    expect(loopRequests(adapter)).toHaveLength(0)
    expect(stepError(agent)).toContain('skill "broken-tools" requires tool "not_a_tool", which the tool policy does not declare')
  })

  it('fails the step when a skill\'s metadata.lyteboat fails its schema, instead of dropping it', async () => {
    const adapter = new MockAdapter([textResponse('never')])
    const ctx = await harness(adapter, { mode: 'full' })
    ctx.skills.register({ name: 'misspelt', description: '拼错了字段', content: 'BODY-MISSPELT', source: 'custom', metadata: { lyteboat: { requiredTool: ['fetch_news'] } } })
    const agent = await ctx.agentLoop.create(SessionId('malformed'), { provider: 'mock', model: 'mock' })

    await send(agent, '看看')
    expect(adapter.requests).toHaveLength(0)
    expect(stepError(agent)).toContain('skill "misspelt" has an invalid metadata.lyteboat')
  })
})
