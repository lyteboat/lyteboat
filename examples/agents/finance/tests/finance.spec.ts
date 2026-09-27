/**
 * The finance agent on the unit host: the kernel's agent loop, tool policy, skill
 * router, a2ui, request context and admission services, the agent's own row,
 * and a scripted model that classifies each request, routes it, and calls the
 * routed skill's tool. Each request carries its context and is admitted
 * before it enters the loop, as `lyteboat try` does. What the try composition
 * already shows (finance.composite.ts) is not repeated here: these are the
 * outcomes it does not reach, and the strict validation of the cards.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, createLyteboatUnitHost, mountAgentStandingScope, textResponse, toolCallResponse, type AgentStandingScope } from '@lyteboat/testing'
import ToolPolicyService from '@lyteboat/tool-policy'
import AuxLlmService from '@lyteboat/aux-llm'
import LyteboatDistroService from '@lyteboat/distro'
import SkillRouterService from '@lyteboat/skill-router'
import A2uiService, { validateFullPayload } from '@lyteboat/a2ui'
import RequestContextService from '@lyteboat/request-context'
import IntakeGuardService from '@lyteboat/intake-guard'
import FinanceAgent from '@lyteboat/agent-finance/agent'

interface TurnPlan { skill: string; tool: string; args?: Record<string, unknown> }

function textOf(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

const isRouter = (request: GenerateOptions): boolean => (request.system ?? '').includes('skill 路由器')
const isIntake = (request: GenerateOptions): boolean => (request.system ?? '').includes('准入分类器')
/** A request of the agent's own loop, not a side call. */
const isLoop = (request: GenerateOptions): boolean => !isRouter(request) && !isIntake(request)

/** The human input this loop request answers: the last user message a person wrote. */
function humanIndex(request: GenerateOptions): number {
  return request.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user')
}

function calledSinceHuman(request: GenerateOptions, tool: string): boolean {
  return request.messages.slice(humanIndex(request) + 1).some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' && block.name === tool))
}

/** The final answer writes one marker per card the last tool result prepared. */
function answer(request: GenerateOptions): string {
  const toolResults = request.messages.slice(humanIndex(request) + 1).filter(message => message.role === 'tool')
  const areas = /areas=([^\]\s]+)/u.exec(toolResults.map(textOf).at(-1) ?? '')?.[1] ?? 'none'
  const markers = areas === 'none' ? [] : areas.split(',').map(area => `[[card:${area}]]`)
  return ['好的。', ...markers, '以上。'].join('\n')
}

function scriptFor(plans: ReadonlyMap<string, TurnPlan>, intents: ReadonlyMap<string, string>): (request: GenerateOptions) => StreamChunk[] {
  let calls = 0
  return (request) => {
    if (isIntake(request)) {
      const latest = /<latest>([\s\S]*?)<\/latest>/u.exec(request.messages.map(textOf).join('\n'))?.[1] ?? ''
      const plan = plans.get(latest)
      const intent = intents.get(latest) ?? (plan === undefined ? 'other' : plan.skill === 'investor-education' ? 'education' : 'asset')
      return textResponse(intent === 'garbled' ? '我不确定' : JSON.stringify({ intent, reason: 'test' }))
    }
    if (isRouter(request)) {
      const latest = /<latest_user_input>([\s\S]*?)<\/latest_user_input>/u.exec(request.messages.map(textOf).join('\n'))?.[1] ?? ''
      return textResponse(JSON.stringify({ skill_id: plans.get(latest)?.skill ?? null, reason: 'test' }))
    }
    const human = request.messages[humanIndex(request)]
    const plan = human === undefined ? undefined : plans.get(textOf(human))
    if (plan !== undefined && (request.tools ?? []).some(tool => tool.name === plan.tool) && !calledSinceHuman(request, plan.tool)) {
      calls += 1
      return toolCallResponse(`call-${String(calls)}`, plan.tool, plan.args ?? {})
    }
    return textResponse(answer(request))
  }
}

/** The finance agent's directory, whose assets its definition reads. */
const FINANCE_DIR = fileURLToPath(new URL('..', import.meta.url))

async function harness(plans: ReadonlyMap<string, TurnPlan>, intents: ReadonlyMap<string, string> = new Map()): Promise<{ ctx: Context; adapter: MockAdapter; finance: AgentStandingScope }> {
  const script = scriptFor(plans, intents)
  const adapter = new MockAdapter(Array.from({ length: 80 }, () => script))
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(AuxLlmService)
  await ctx.plugin(SkillRouterService)
  await ctx.plugin(A2uiService)
  await ctx.plugin(RequestContextService)
  await ctx.plugin(IntakeGuardService)
  // The host's skill tool (dsh-tool-skill in a business mode), which finance's tool policy keeps visible.
  ctx.tools.register(defineContentToolFixture({ name: 'skill', description: 'Load a skill.', parameters: { name: { type: 'string', required: true } }, execute: async () => [{ type: 'text', text: 'loaded' }] }))
  const finance = await mountAgentStandingScope(ctx, FINANCE_DIR, FinanceAgent)
  return { ctx, adapter, finance }
}

/** One request as `lyteboat try` sends it: submitted (admitted, then followed up with its context and verdict), then settled. */
async function send(ctx: Context, agent: Agent, text: string, customer?: string): Promise<void> {
  await ctx.intakeGuard.submit(agent, { text, context: customer === undefined ? undefined : { customer } }, AbortSignal.timeout(5000))
  await agent.whenIdle()
}

type ResultMeta = { lyteboat?: { cards?: { area: string; emission: string; payload: Record<string, unknown> }[] } }

/** Every finance tool result, in order. */
function results(agent: Agent): { text: string; meta: ResultMeta }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result' && event.surfaceOp === 'append')
    .map(event => ({ text: textOf(event.data.message), meta: event.data.meta as unknown as ResultMeta }))
}

/** The surface ids of a result's cards, in answer order. */
function cardsOf(result: { meta: ResultMeta }): string[] {
  return (result.meta.lyteboat?.cards ?? []).map(card => String(card.payload['surfaceId']))
}

function payloadsOf(agent: Agent): Record<string, unknown>[] {
  return results(agent).flatMap(result => (result.meta.lyteboat?.cards ?? []).map(card => card.payload))
}

describe('the finance agent on the unit host (scripted model)', () => {
  async function askOnce(customer: string, text: string, plan?: TurnPlan, intents: ReadonlyMap<string, string> = new Map()): Promise<{ agent: Agent; adapter: MockAdapter; ctx: Context }> {
    const { ctx, adapter, finance } = await harness(new Map(plan === undefined ? [] : [[text, plan]]), intents)
    const agent = await finance.createAgentInstance(`finance-${customer}`)
    await send(ctx, agent, text, customer)
    return { agent, adapter, ctx }
  }

  it('the allocation diagnosis reports an aggressive verdict and points back inside the band when the customer holds too much at market risk for the age', async () => {
    const { agent } = await askOnce('pre-retiree-risky', '诊断一下我的配置', { skill: 'allocation-diagnosis', tool: 'allocation_diagnosis' })
    const [result] = results(agent)
    expect(result?.text).toMatch(/verdict=aggressive areas=allocation_diagnosis,allocation_plan\]/u)
    expect(JSON.stringify(result?.meta.lyteboat?.cards?.[1]?.payload)).toContain('回到 52% 以内')
  })

  it('the asset overview tool falls back to the unauthorized card and concludes the turn when the admission cannot classify a request from a customer with nothing authorized', async () => {
    const { agent, adapter } = await askOnce('none-authorized', '看看我的资产', { skill: 'asset-overview', tool: 'asset_overview' }, new Map([['看看我的资产', 'garbled']]))
    const [result] = results(agent)
    expect(result?.text).toMatch(/^\[tool:asset_overview status=unauthorized areas=unauthorized\]/u)
    expect(cardsOf(result!)).toEqual([expect.stringMatching(/^unauthorized-/u) as string])
    expect(adapter.requests.filter(isLoop)).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
  })

  it('the knowledge tool answers with its topic list and no card when the concept is unknown', async () => {
    const { agent, ctx } = await askOnce('midlife-moderate', '区块链是什么', { skill: 'investor-education', tool: 'lookup_knowledge', args: { topic: '区块链' } })
    expect(results(agent)[0]?.text).toContain('status=fallback')
    expect(payloadsOf(agent)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')?.intake).toEqual({ by: 'finance-admission', decision: 'pass', verdict: 'education' })
  })

  it('every card passes strict A2UI validation when one session renders the overview and the diagnosis', async () => {
    const plans = new Map<string, TurnPlan>([
      ['看看我的资产', { skill: 'asset-overview', tool: 'asset_overview' }],
      ['诊断一下我的配置', { skill: 'allocation-diagnosis', tool: 'allocation_diagnosis' }],
    ])
    const { ctx, finance } = await harness(plans)
    const agent = await finance.createAgentInstance('finance-strict')

    await send(ctx, agent, '看看我的资产', 'young-idle-cash')
    await send(ctx, agent, '诊断一下我的配置')

    expect(results(agent).flatMap(result => (result.meta.lyteboat?.cards ?? []).map(card => card.area))).toEqual(['asset_overview', 'allocation_diagnosis', 'allocation_plan'])
    for (const payload of payloadsOf(agent)) {
      expect(validateFullPayload(payload, { strict: true }).errors, JSON.stringify(payload['surfaceId'])).toEqual([])
    }
  })
})
