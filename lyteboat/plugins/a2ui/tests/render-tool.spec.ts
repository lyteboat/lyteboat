/**
 * The render tool at the agent loop's seams: raw data from lyteboatState, the card on
 * tool/result.meta, the lyteboatCards projection (tool results, surfaceUpdate
 * replacement), the digest as model text, terminal cards.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import LyteboatDistroService from '@lyteboat/distro'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse, toolCallResponse } from '@lyteboat/testing'
import ToolPolicyService from '@lyteboat/tool-policy'
import A2uiService from '@lyteboat/a2ui'
import { lyteboatCardsProjectionDefinition } from '../src/cards-projection.ts'
import { collectRawData, parseObjectArgs } from '../src/render-tool-input.ts'
import { REFERENCE_A2UI_COMPONENT_CATALOG } from './fixtures/reference-component-catalog.ts'
import type { LyteboatCard, LyteboatResultCard, JsonValue } from '@lyteboat/contracts'

const TEMPLATES = fileURLToPath(new URL('./fixtures/templates', import.meta.url))
const VARIANTS = fileURLToPath(new URL('./fixtures/templates-variants', import.meta.url))
const FULL = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/baseline/asset_overview-full.json', import.meta.url)), 'utf8')) as {
  raw: Record<string, unknown>; payload: Record<string, unknown>; digest: string
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(A2uiService)
  // The data tool: its result becomes session state through the tool policy's delta.
  ctx.toolPolicy.register(defineTool({
    name: 'query_assets', description: 'query', parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'assets loaded' }] },
    execute: async () => FULL.raw as JsonValue,
  }), { stateDelta: (_args, value) => value as JsonValue })
  await ctx.a2ui.registerRenderTool({
    templates: TEMPLATES, stateKeys: ['assets_view', 'assets_raw'], terminalCards: ['unauthorized'], cardDescriptions: { asset_overview: '资产总览卡' }, components: REFERENCE_A2UI_COMPONENT_CATALOG,
  })
  return ctx
}

const results = (agent: Agent): SessionEvent<'tool/result'>[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')

describe('render_a2ui', () => {
  it('renders from lyteboatState, puts the card on tool/result.meta, folds it into lyteboatCards, and shows the digest to the model', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'query_assets', {}),
      toolCallResponse('c2', 'render_a2ui', { template: 'asset_overview' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('render'), { provider: 'mock', model: 'mock' })
    await send(agent, '看看资产')

    const first = adapter.requests[0] as GenerateOptions
    const render = (first.tools ?? []).find(tool => tool.name === 'render_a2ui')!
    expect(render.description).toContain('asset_overview: 资产总览卡')
    expect(JSON.stringify(render.parameters)).toContain('"enum":["asset_overview","unauthorized"]')
    expect(JSON.stringify(render.parameters)).not.toContain('business_hierarchy')

    const [, rendered] = results(agent)
    expect(rendered).toBeDefined()
    const meta = rendered!.data.meta as unknown as { lyteboat: { cards: LyteboatResultCard[] }; a2ui: { template: string; event: string; warnings: string[] } }
    expect(meta.a2ui).toEqual({ template: 'asset_overview', event: 'beginRendering', warnings: [] })
    expect(meta.lyteboat.cards).toHaveLength(1)
    expect(meta.lyteboat.cards[0]).toMatchObject({ area: 'asset_overview', emission: 'immediate' })
    const payload = meta.lyteboat.cards[0]!.payload as Record<string, unknown>
    expect(payload['surfaceId']).toMatch(/^asset_overview-render-[0-9a-f]{6}$/u)
    const expected = { ...FULL.payload }
    delete expected['surfaceId']
    const actual = { ...payload }
    delete actual['surfaceId']
    expect(actual).toEqual(expected)
    expect(meta.lyteboat).not.toHaveProperty('stateDelta')
    const block = rendered!.data.message.content[0]!
    expect(JSON.stringify(block)).toContain(FULL.digest)
    expect(JSON.stringify(block)).not.toContain('rootComponentId')

    const cards = ctx.a2ui.cardsOf(agent)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ callId: 'c2', surfaceId: payload['surfaceId'] })
    expect(ctx.sessionProjections.snapshot(agent.session).values['lyteboatCards']).toEqual(cards)
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain(FULL.digest)
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatState')).toMatchObject({ assets_view: { auth_state: 'full' } })
  })

  it('replaces a surface in lyteboatCards on surfaceUpdate and concludes the turn on a terminal card', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'render_a2ui', { template: 'unauthorized', surface_id: 'auth-card' }),
      toolCallResponse('c2', 'render_a2ui', { template: 'unauthorized', surface_id: 'auth-card' }),
      textResponse('never'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('terminal'), { provider: 'mock', model: 'mock' })
    await send(agent, '授权')
    // The terminal card concluded the turn after the first result: one model request, no text step.
    expect(adapter.requests).toHaveLength(1)
    const [first] = results(agent)
    const meta = first!.data.meta as unknown as { lyteboat: { cards: LyteboatResultCard[] } }
    expect((meta.lyteboat.cards[0]!.payload as Record<string, unknown>)['event']).toBe('surfaceUpdate')
    expect(ctx.a2ui.cardsOf(agent)).toHaveLength(1)
    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end') as SessionEvent<'turn/end'>
    expect(turnEnd.data.reason.kind).toBe('completed')

    await send(agent, '再来')
    expect(adapter.requests).toHaveLength(2)
    // Same surface updated twice: one card, the latest call.
    const cards = ctx.a2ui.cardsOf(agent)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ callId: 'c2', surfaceId: 'auth-card' })
  })

  it('rejects an unknown card and reports it as a tool error', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'render_a2ui', { template: 'nope' }), textResponse('done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('unknown'), { provider: 'mock', model: 'mock' })
    await send(agent, 'x')
    const [first] = results(agent)
    // The registry validated the enum before execution; either way the model sees an error, no card.
    expect(first!.data.message.isError).toBe(true)
    expect(ctx.a2ui.cardsOf(agent)).toEqual([])
  })
})

describe('render_a2ui over cards with arguments and hierarchies', () => {
  async function variants(adapter: MockAdapter): Promise<Context> {
    const ctx = await harness(adapter)
    await ctx.a2ui.registerRenderTool({ templates: VARIANTS, name: 'render_variant', stateKeys: ['assets_view'] })
    await ctx.a2ui.registerRenderTool({ templates: VARIANTS, name: 'render_strict', validation: 'enforce' })
    return ctx
  }

  const card = (event: SessionEvent<'tool/result'>): Record<string, unknown> =>
    (event.data.meta as unknown as { lyteboat: { cards: LyteboatResultCard[] } }).lyteboat.cards[0]!.payload as Record<string, unknown>
  const componentIds = (payload: Record<string, unknown>): string[] => (payload['components'] as { id: string }[]).map(component => component.id)
  const textOf = (payload: Record<string, unknown>, id: string): unknown =>
    ((payload['components'] as { id: string; component: { Text?: { text?: unknown } } }[]).find(component => component.id === id)?.component.Text?.text)

  it('exposes the hierarchy enum and the argument summary, and renders the chosen variant from template_args', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'render_variant', { template: 'bucket_detail', template_args: '{"bucket":"稳健"}', business_hierarchy: 'full' }),
      toolCallResponse('c2', 'render_variant', { template: 'bucket_detail' }),
      textResponse('done'),
    ])
    const ctx = await variants(adapter)
    const agent = await ctx.agentLoop.create(SessionId('variants'), { provider: 'mock', model: 'mock' })
    await send(agent, '看看稳健')

    const tool = ((adapter.requests[0] as GenerateOptions).tools ?? []).find(candidate => candidate.name === 'render_variant')!
    const parameters = JSON.stringify(tool.parameters)
    expect(parameters).toContain('"enum":["brief","full"]')
    expect(parameters).toContain('bucket_detail: bucket(必填)')

    const [full, brief] = results(agent)
    // The walker emits children before their parent.
    expect(componentIds(card(full!))).toEqual(['title', 'detail', 'root'])
    expect(textOf(card(full!), 'title')).toEqual({ literalString: '稳健' })
    expect(JSON.stringify(full!.data.message.content[0])).toContain('[卡片:bucket] 稳健')
    // No arguments: the default hierarchy and the manifest default, the card still renders.
    expect(componentIds(card(brief!))).toEqual(['title', 'root'])
    expect(textOf(card(brief!), 'title')).toEqual({ literalString: '未指定' })
  })

  it('records a contract violation as a warning by default and fails the call under enforce', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'render_variant', { template: 'broken_binding' }),
      toolCallResponse('c2', 'render_strict', { template: 'broken_binding' }),
      textResponse('done'),
    ])
    const ctx = await variants(adapter)
    const agent = await ctx.agentLoop.create(SessionId('enforce'), { provider: 'mock', model: 'mock' })
    await send(agent, '坏卡')
    const [warned, enforced] = results(agent)
    const meta = warned!.data.meta as unknown as { a2ui: { warnings: string[] } }
    expect(meta.a2ui.warnings).toEqual([expect.stringContaining("[A2UI_BINDING_XOR] Component 'empty-text' field 'text'")])
    expect(ctx.a2ui.cardsOf(agent)).toHaveLength(1)
    expect(enforced!.data.message.isError).toBe(true)
    expect(JSON.stringify(enforced!.data.message.content[0])).toContain('A2UI contract invalid: [A2UI_BINDING_XOR]')
  })
})

describe('a render tool with its own name', () => {
  it('registers under the name its options give', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'render_card', { template: 'unauthorized' }), textResponse('done')])
    const ctx = await createLyteboatUnitHost(adapter)
    await ctx.plugin(LyteboatDistroService)
    await ctx.plugin(ToolPolicyService)
    await ctx.plugin(A2uiService)
    await ctx.a2ui.registerRenderTool({ templates: TEMPLATES, name: 'render_card' })
    const agent = await ctx.agentLoop.create(SessionId('named'), { provider: 'mock', model: 'mock' })
    await send(agent, '授权')
    expect(ctx.a2ui.cardsOf(agent).map(card => card.area)).toEqual(['unauthorized'])
  })
})

describe('helpers', () => {
  it('collectRawData namespaces and flattens each state key, parsing JSON strings', () => {
    expect(collectRawData({ a: { x: 1 }, b: '{"y":2}', c: 'nope', d: 3 }, ['a', 'b', 'c', 'd', 'missing'])).toEqual({ a: { x: 1 }, x: 1, b: { y: 2 }, y: 2 })
  })

  it('parseObjectArgs accepts objects and JSON object strings only', () => {
    expect(parseObjectArgs(undefined)).toBeUndefined()
    expect(parseObjectArgs({ k: 1 })).toEqual({ k: 1 })
    expect(parseObjectArgs('{"k":1}')).toEqual({ k: 1 })
    expect(() => parseObjectArgs('[1]')).toThrow(/JSON 对象/u)
    expect(() => parseObjectArgs('{')).toThrow(/JSON 对象/u)
  })

  it('lyteboatCards projection ignores unrelated events by reference', () => {
    const state: LyteboatCard[] = []
    expect(lyteboatCardsProjectionDefinition.apply(state, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as never)).toBe(state)
  })

  it('lyteboatCards projection folds appended results only: a replacement keeping the card does not show it twice', () => {
    const fold = lyteboatCardsProjectionDefinition
    const result = (surfaceOp: unknown): never => ({
      type: 'tool/result', seq: 1, time: 0, surfaceOp,
      data: { turn: 1, step: 1, message: { toolCallId: 'c1' }, meta: { lyteboat: { cards: [{ surfaceId: 's1', area: 'summary', emission: 'immediate', payload: { rootComponentId: 'root' } }] } } },
    }) as never
    const once = fold.apply([], result('append'))
    expect(fold.apply(once, result({ op: 'replace', startSeq: 1, endSeq: 1 }))).toBe(once)
    expect(once.map(card => card.surfaceId)).toEqual(['s1'])
  })

  it('lyteboatCards projection fails on a tool result whose meta.lyteboat fails its schema, naming the node', () => {
    const fold = lyteboatCardsProjectionDefinition
    const result = {
      type: 'tool/result', seq: 2, time: 0, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { toolCallId: 'c1' }, meta: { lyteboat: { cards: [{ surfaceId: 's1', area: 'summary', emission: 'later', payload: {} }] } } },
    } as never
    expect(() => fold.apply([], result)).toThrow('tool/result at session seq 2 carries an invalid lyteboat envelope')
  })
})
