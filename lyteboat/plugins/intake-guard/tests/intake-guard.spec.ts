/**
 * Admission ahead of the loop: a submitted request is admitted and followed
 * up with its verdict, a verdict recorded on the request is answered in the
 * loop without a model request, a pass is not admitted twice, and a message
 * that arrives unadmitted is admitted in the loop.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LyteboatDistroService from '@lyteboat/distro'
import RequestContextService from '@lyteboat/request-context'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as sendAndWait, textResponse } from '@lyteboat/testkit'
import IntakeGuardService, { type LyteboatAdmission } from '@lyteboat/intake-guard'
import type { JsonValue } from '@lyteboat/contracts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(RequestContextService)
  await ctx.plugin(IntakeGuardService)
  return ctx
}

const CARD = { surfaceId: 'scope-1', area: 'scope', emission: 'immediate' as const, payload: { rootComponentId: 'root' } }

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

/** Submit one request and wait until the agent settled it. */
async function submitAndWait(ctx: Context, agent: Agent, request: Parameters<Context['intakeGuard']['submit']>[1]): ReturnType<Context['intakeGuard']['submit']> {
  const intake = await ctx.intakeGuard.submit(agent, request, AbortSignal.timeout(5000))
  await agent.whenIdle()
  return intake
}

const humanSources = (agent: Agent): unknown[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message').map(event => event.data.source)
const replies = (agent: Agent): SessionEvent<'assistant/message'>[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')

describe('admission ahead of the loop', () => {
  it('submit follows a request up with its request id, context, and pass verdict, and the model answers without a second admission', async () => {
    const adapter = new MockAdapter([textResponse('好的')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('pass'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('intakeGuard')!.register(gate)

    const intake = await submitAndWait(ctx, agent, { text: '看看我的资产', context: { customer: 'c-1' }, requestId: 'r-1' })

    expect(intake).toEqual({ by: 'stock-gate', decision: 'pass' })
    expect(gate.contexts).toEqual([{ customer: 'c-1' }])
    expect(adapter.requests).toHaveLength(1)
    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { requestId: 'r-1', context: { customer: 'c-1' }, intake } }])
  })

  it('submit records who sent the request and the agent it went to', async () => {
    const ctx = await harness(new MockAdapter([textResponse('好的')]))
    const agent = await ctx.agentLoop.create(SessionId('identity'), { provider: 'mock', model: 'mock' })
    const identity = { id: 'finance', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }

    await submitAndWait(ctx, agent, { text: '你好', owner: { kind: 'operator', id: 'cli' }, agent: identity })

    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' }, agent: identity } }])
  })

  it('submit records a reply verdict on the request, and the loop answers it without a model request', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('reply'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('intakeGuard')!.register(gate)

    const intake = await submitAndWait(ctx, agent, { text: '帮我炒股', context: { channel: 'app' } })

    expect(intake).toEqual({ by: 'stock-gate', decision: 'reply', verdict: 'out_of_scope', text: '这个我帮不了。', cards: [CARD] })
    expect(adapter.requests).toEqual([])
    expect(gate.calls).toBe(1)
    expect(replies(agent).map(reply => [reply.data.message.source, reply.data.message.content])).toEqual([
      [{ kind: 'model', provider: 'lyteboat', model: 'stock-gate' }, [{ type: 'text', text: '这个我帮不了。' }]],
    ])
    expect(humanSources(agent)).toEqual([{ kind: 'user', lyteboatRequest: { context: { channel: 'app' }, intake } }])
  })

  it('submit treats an empty context as none: admission sees the session\'s earlier context and the message carries none', async () => {
    const adapter = new MockAdapter([textResponse('一'), textResponse('二')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('empty-context'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('intakeGuard')!.register(gate)

    await submitAndWait(ctx, agent, { text: '第一句', context: { customer: 'c-1' } })
    const intake = await submitAndWait(ctx, agent, { text: '第二句', context: {} })

    expect(gate.contexts).toEqual([{ customer: 'c-1' }, { customer: 'c-1' }])
    expect(humanSources(agent).at(-1)).toEqual({ kind: 'user', lyteboatRequest: { intake } })
    expect(ctx.requestContext.contextOf(agent)).toEqual({ customer: 'c-1' })
  })

  it('admits in the loop a message that arrives without a verdict: the same reply, nothing recorded', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('unadmitted'), { provider: 'mock', model: 'mock' })
    const gate = stockGate()
    agent.ctx.get('intakeGuard')!.register(gate)

    await sendAndWait(agent, '帮我炒股')

    expect(adapter.requests).toEqual([])
    expect(gate.calls).toBe(1)
    expect(replies(agent).map(reply => reply.data.message.content)).toEqual([[{ type: 'text', text: '这个我帮不了。' }]])
    expect(humanSources(agent)).toEqual([{ kind: 'user' }])
  })

  it('admits everything for an agent whose chain registered nothing, and the nearest registration wins', async () => {
    const adapter = new MockAdapter([textResponse('好的')])
    const ctx = await harness(adapter)
    const plain = await ctx.agentLoop.create(SessionId('plain'), { provider: 'mock', model: 'mock' })
    const scoped = await ctx.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    const agentGate = stockGate()
    scoped.ctx.get('intakeGuard')!.register(agentGate)

    expect(await submitAndWait(ctx, plain, { text: '帮我炒股' })).toBeUndefined()
    expect(humanSources(plain)).toEqual([{ kind: 'user' }])
    ctx.intakeGuard.register({ name: 'host-gate', admit: async () => ({ decision: 'pass' }) })
    expect(ctx.intakeGuard.admissionFor(plain)?.name).toBe('host-gate')
    expect(ctx.intakeGuard.admissionFor(scoped)?.name).toBe('stock-gate')
  })
})
