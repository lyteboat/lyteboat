/**
 * A card an agent's own tool renders beside its value (`renderCard`),
 * carried on the result's meta (`cardsPresentationMeta`), where the
 * lyteboatCards projection folds it as it does render_a2ui's.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import LyteboatDistroService from '@lyteboat/distro'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse, toolCallResponse } from '@lyteboat/testkit'
import ToolPolicyService from '@lyteboat/tool-policy'
import A2uiService, { cardsPresentationMeta } from '@lyteboat/a2ui'

const TEMPLATES = fileURLToPath(new URL('./fixtures/templates', import.meta.url))
const VARIANTS = fileURLToPath(new URL('./fixtures/templates-variants', import.meta.url))
const FULL = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/baseline/asset_overview-full.json', import.meta.url)), 'utf8')) as {
  raw: Record<string, unknown>; payload: Record<string, unknown>
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(A2uiService)
  return ctx
}

async function agentOf(session: string): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = await harness(new MockAdapter([]))
  return { ctx, agent: await ctx.agentLoop.create(SessionId(session), { provider: 'mock', model: 'mock' }) }
}

describe('renderCard', () => {
  it('renders the card a tool carries beside its own value, which the lyteboatCards projection folds', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'overview', {}), textResponse('done')])
    const ctx = await harness(adapter)
    ctx.toolPolicy.register(defineTool({
      name: 'overview', description: 'overview', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, cards: { type: 'array', required: true, items: { type: 'json' } } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        presentationMeta: (_args, value) => cardsPresentationMeta(value.cards),
      },
      execute: async (_args, exec) => ({ text: 'overview ready', cards: [await ctx.a2ui.renderCard(TEMPLATES, 'asset_overview', FULL.raw, { agent: exec.agent! })] }),
    }))
    const agent = await ctx.agentLoop.create(SessionId('card'), { provider: 'mock', model: 'mock' })
    await send(agent, '看看资产')

    const cards = ctx.a2ui.cardsOf(agent)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ callId: 'c1', area: 'asset_overview', emission: 'immediate', surfaceId: expect.stringMatching(/^asset_overview-card-[0-9a-f]{6}$/u) as string })
    const { surfaceId, ...payload } = cards[0]!.payload as Record<string, unknown>
    const { surfaceId: _reference, ...expected } = FULL.payload
    expect(surfaceId).toBe(cards[0]!.surfaceId)
    expect(payload).toEqual(expected)
  })

  it('rejects an area no card directory answers', async () => {
    const { ctx, agent } = await agentOf('unknown')
    await expect(ctx.a2ui.renderCard(TEMPLATES, 'missing', {}, { agent })).rejects.toThrow(/template 卡目录不存在: missing/u)
  })

  it('fails naming the card when its raw data binds a value JSON cannot carry', async () => {
    const { ctx, agent } = await agentOf('not-json')
    await expect(ctx.a2ui.renderCard(VARIANTS, 'bucket_detail', { args: { bucket: Number.NaN } }, { agent })).rejects.toThrow('a2ui: card "bucket_detail" did not render to lossless JSON')
  })
})

describe('cardsPresentationMeta', () => {
  it('puts no envelope on a result without cards, and refuses a card outside the contract', () => {
    expect(cardsPresentationMeta([])).toEqual({})
    const card = { surfaceId: 's1', area: 'summary', emission: 'immediate', payload: { rootComponentId: 'root' } }
    expect(cardsPresentationMeta([card])).toEqual({ lyteboat: { cards: [card] } })
    expect(() => cardsPresentationMeta([{ ...card, emission: 'later' }])).toThrow(/emission/u)
  })
})
