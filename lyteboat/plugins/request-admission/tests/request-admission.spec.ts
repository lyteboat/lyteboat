/**
 * Admission at a turn's first step: a reply answers without a model request
 * and logs the human message with its verdict and cards, a pass is not
 * recorded, a verdict the request already carries is answered as recorded,
 * and the nearest registration decides.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LyteboatDistroService from '@lyteboat/distro'
import RequestContextService from '@lyteboat/request-context'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait, textResponse } from '@lyteboat/testkit'
import RequestAdmissionService, { type LyteboatAdmission } from '@lyteboat/request-admission'
import type { JsonValue, LyteboatRequest } from '@lyteboat/contracts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(RequestContextService)
  await ctx.plugin(RequestAdmissionService)
  return ctx
}

const CARD = { surfaceId: 'scope-1', area: 'scope', emission: 'immediate' as const, payload: { rootComponentId: 'root' } }
const REPLY = { by: 'stock-gate', decision: 'reply' as const, verdict: 'out_of_scope', text: '这个我帮不了。', cards: [CARD] }

/** Replies to stock questions with a fixed text and card; counts its calls and keeps the contexts it saw. */
function stockGate(): LyteboatAdmission & { calls: number; contexts: { [key: string]: JsonValue }[] } {
  const gate = {
    name: 'stock-gate',
    calls: 0,
    contexts: [] as { [key: string]: JsonValue }[],
    admit: async ({ text, context }: { text: string; context: { [key: string]: JsonValue } }) => {
      gate.calls += 1
      gate.contexts.push(context)
      return /炒股/u.test(text)
        ? { decision: 'reply' as const, verdict: 'out_of_scope', text: '这个我帮不了。', cards: [CARD] }
        : { decision: 'pass' as const }
    },
  }
  return gate
}

/** Follow up one request as a caller records it, and wait until the agent settled it. */
async function sendAndWait(ctx: Context, agent: Agent, text: string, request: LyteboatRequest): Promise<void> {
  agent.followup(ctx.requestContext.message(text, request))
  await agent.whenIdle()
}

const humanSources = (agent: Agent): unknown[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message').map(event => event.data.source)
const replies = (agent: Agent): SessionEvent<'assistant/message'>[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')

describe('admission at the first step of a turn', () => {
  it('answers a reply verdict without a model request and logs the human message with the verdict beside its request', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('reply'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('requestAdmission')!.register(gate)

    await sendAndWait(ctx, agent, '帮我炒股', { requestId: 'r-1', context: { channel: 'app' } })

    expect(adapter.requests).toEqual([])
    expect(gate.calls).toBe(1)
    expect(replies(agent).map(reply => [reply.data.message.source, reply.data.message.content])).toEqual([
      [{ kind: 'model', provider: 'lyteboat', model: 'stock-gate' }, [{ type: 'text', text: '这个我帮不了。' }]],
    ])
    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { requestId: 'r-1', context: { channel: 'app' }, intake: REPLY } }])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')?.intake).toEqual(REPLY)
  })

  it('records a reply on a message that came with no request', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('bare'), { provider: 'mock', model: 'mock' })
    agent.ctx.get('requestAdmission')!.register(stockGate())

    await followUpAndWait(agent, '帮我炒股')

    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { intake: REPLY } }])
  })

  it('lets a pass through to the model and records nothing', async () => {
    const adapter = new MockAdapter([textResponse('好的')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('pass'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('requestAdmission')!.register(gate)

    await sendAndWait(ctx, agent, '看看我的资产', { requestId: 'r-1', context: { customer: 'c-1' } })

    expect(gate.contexts).toEqual([{ customer: 'c-1' }])
    expect(adapter.requests).toHaveLength(1)
    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { requestId: 'r-1', context: { customer: 'c-1' } } }])
  })

  it('admits with the session\'s earlier context when the request carries none', async () => {
    const adapter = new MockAdapter([textResponse('一'), textResponse('二')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('earlier-context'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('requestAdmission')!.register(gate)

    await sendAndWait(ctx, agent, '第一句', { context: { customer: 'c-1' } })
    await sendAndWait(ctx, agent, '第二句', {})

    expect(gate.contexts).toEqual([{ customer: 'c-1' }, { customer: 'c-1' }])
  })

  it('answers a verdict the request already carries as recorded, without admitting again', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('recorded'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('requestAdmission')!.register(gate)

    await sendAndWait(ctx, agent, '随便聊聊', { intake: REPLY })

    expect(gate.calls).toBe(0)
    expect(replies(agent).map(reply => reply.data.message.content)).toEqual([[{ type: 'text', text: '这个我帮不了。' }]])
    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { intake: REPLY } }])
  })

  it('admits everything for an agent whose chain registered nothing, and the nearest registration wins', async () => {
    const adapter = new MockAdapter([textResponse('好的')])
    const ctx = await harness(adapter)
    const plain = await ctx.agentLoop.create(SessionId('plain'), { provider: 'mock', model: 'mock' })
    const scoped = await ctx.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    scoped.ctx.get('requestAdmission')!.register(stockGate())

    await followUpAndWait(plain, '帮我炒股')
    expect(adapter.requests).toHaveLength(1)
    expect(humanSources(plain)).toEqual([{ kind: 'user' }])
    ctx.requestAdmission.register({ name: 'host-gate', admit: async () => ({ decision: 'pass' }) })
    expect(ctx.requestAdmission.admissionFor(plain)?.name).toBe('host-gate')
    expect(ctx.requestAdmission.admissionFor(scoped)?.name).toBe('stock-gate')
  })
})
