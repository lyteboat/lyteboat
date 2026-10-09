/**
 * lyteboat extension `agent-loop-intake` (dsh-compat/contract/extensions.yml): the intake
 * gate between the inbox claim and prompt assembly. Upstream's own suite runs
 * unchanged beside this file; these tests cover only what lyteboat adds.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop, { LYTEBOAT_ASSISTANT_PROVIDER, type LyteboatIntakeDecision } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from '../mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function textOf(messages: readonly { content: readonly { type: string; text?: string }[] }[]): string {
  return messages.map(message => message.content.map(block => block.text ?? '').join('')).join('')
}

/** A gate that answers anything mentioning stocks and passes everything else. */
function stockGate(ctx: Context): void {
  ctx.on('lyteboat/intake', async (payload, next): Promise<LyteboatIntakeDecision> => {
    if (!/股票/u.test(textOf(payload.messages))) return next()
    return { kind: 'reply', plugin: 'test-gate', content: [{ type: 'text', text: '不提供股票建议' }] }
  })
}

function typesOf(events: readonly SessionEvent[]): string[] {
  return events.map(event => event.type).filter(type => !type.startsWith('agent/inbox/'))
}

describe('lyteboat/intake', () => {
  it('answers a step with a fixed reply and no model request, keeping node 0 for the prompt', async () => {
    const adapter = new MockAdapter([textResponse('model answer')])
    const ctx = await harness(adapter)
    stockGate(ctx)
    const agent = await ctx.agentLoop.create(SessionId('intake-reply'), { provider: 'mock', model: 'mock' })

    await send(agent, '帮我买股票')
    expect(adapter.requests).toHaveLength(0)
    const events = agent.session.snapshotEvents()
    expect(typesOf(events)).toEqual(['turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    expect((events.at(-1) as SessionEvent<'turn/end'>).data.reason).toEqual({ kind: 'completed' })
    const reply = events.find((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    expect(reply?.data.message.source).toEqual({ kind: 'model', provider: LYTEBOAT_ASSISTANT_PROVIDER, model: 'test-gate' })
    expect(reply?.data.stream).toEqual([])
    // An empty system head projects to no wire message, but it holds surface node 0.
    expect(agent.session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant'])
    expect(agent.session.eventAt(agent.session.surface.nodes[0] ?? -1)?.type).toBe('system/message')

    // The next admitted step assembles a real prompt: it replaces node 0 instead of trailing the history.
    await send(agent, '看看资产配置')
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0] as GenerateOptions
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('replaces the empty head on an in-history route too: the first request of a session starts its series', async () => {
    const adapter = new MockAdapter([textResponse('model answer')])
    adapter.systemPromptUpdate = 'in-history'
    const ctx = await harness(adapter)
    stockGate(ctx)
    const agent = await ctx.agentLoop.create(SessionId('intake-in-history'), { provider: 'mock', model: 'mock' })

    await send(agent, '帮我买股票')
    await send(agent, '看看资产配置')
    const request = adapter.requests[0] as GenerateOptions
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    const systemNodes = agent.session.snapshotEvents().filter(event => event.type === 'system/message')
    expect(systemNodes).toHaveLength(2)
    expect(systemNodes[1]?.surfaceOp).toEqual({ op: 'replace', startSeq: systemNodes[0]?.seq, endSeq: systemNodes[0]?.seq })
  })

  it('logs the claimed messages as the reply records them when only their source changed', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    ctx.on('lyteboat/intake', async (payload): Promise<LyteboatIntakeDecision> => ({
      kind: 'reply',
      plugin: 'test-gate',
      content: [{ type: 'text', text: '不提供股票建议' }],
      messages: payload.messages.map(message => ({ ...message, source: { ...message.source, verdict: 'reply' } })),
    }))
    const agent = await ctx.agentLoop.create(SessionId('intake-messages'), { provider: 'mock', model: 'mock' })

    await send(agent, '帮我买股票')
    const events = agent.session.snapshotEvents()
    const claimed = events.find((event): event is SessionEvent<'agent/inbox/spliced'> => event.type === 'agent/inbox/spliced')
    const logged = events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    expect(logged?.data.id).toBe(claimed?.data.inserted[0]?.id)
    expect(logged?.data.content).toEqual([{ type: 'text', text: '帮我买股票' }])
    expect(logged?.data.source).toEqual({ kind: 'user', verdict: 'reply' })
    expect((events.at(-1) as SessionEvent<'turn/end'>).data.reason).toEqual({ kind: 'completed' })
  })

  it('fails the turn when a reply rewrites what the user said', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    ctx.on('lyteboat/intake', async (payload): Promise<LyteboatIntakeDecision> => ({
      kind: 'reply',
      plugin: 'test-gate',
      content: [{ type: 'text', text: '好的' }],
      messages: payload.messages.map(message => ({ ...message, content: [{ type: 'text', text: '帮我看看资产' }] })),
    }))
    const agent = await ctx.agentLoop.create(SessionId('intake-rewrite'), { provider: 'mock', model: 'mock' })

    await send(agent, '帮我买股票')
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'user/message' || event.type === 'assistant/message')).toBe(false)
    expect((events.at(-1) as SessionEvent<'turn/end'>).data.reason).toMatchObject({
      kind: 'error',
      error: { message: expect.stringContaining('only its source may change') },
    })
  })

  it('fails the turn when a reply logs other messages than the step claimed', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    ctx.on('lyteboat/intake', async (): Promise<LyteboatIntakeDecision> => ({
      kind: 'reply',
      plugin: 'test-gate',
      content: [{ type: 'text', text: '好的' }],
      messages: [createUserMessage({ content: [{ type: 'text', text: '帮我买股票' }], source: { kind: 'user' } })],
    }))
    const agent = await ctx.agentLoop.create(SessionId('intake-other'), { provider: 'mock', model: 'mock' })

    await send(agent, '帮我买股票')
    const events = agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'user/message')).toBe(false)
    expect((events.at(-1) as SessionEvent<'turn/end'>).data.reason).toMatchObject({
      kind: 'error',
      error: { message: expect.stringContaining('was claimed') },
    })
  })

  it('passes by default, so a loop with no listener behaves as upstream', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('intake-pass'), { provider: 'mock', model: 'mock' })

    await send(agent, 'hello')
    expect(adapter.requests).toHaveLength(1)
    const reply = agent.session.snapshotEvents().find((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    expect(reply?.data.message.source).toEqual({ kind: 'model', provider: 'mock', model: 'mock' })
  })
})
