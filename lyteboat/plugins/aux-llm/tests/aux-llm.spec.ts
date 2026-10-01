/**
 * The side-call service: an answered call, a failed one, a timeout, an answer
 * cut off at maxTokens, the configured reasoning effort, the caller's own
 * abort, and an agent without a model; every call that reached a model leaves
 * exactly one ignorable record.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import LyteboatDistroService from '@lyteboat/distro'
import { MockAdapter, createLyteboatUnitHost, maxTokensResponse, textResponse } from '@lyteboat/testkit'
import AuxLlmService, { type AuxLlmCall, type Config } from '@lyteboat/aux-llm'

async function harness(adapter: MockAdapter, config: Config = {}): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(AuxLlmService, config)
  return ctx
}

function call(agent: Agent, signal: AbortSignal): AuxLlmCall {
  return { agent, purpose: 'classify', system: 'CLASSIFIER', prompt: '这句话属于哪一类？', maxTokens: 50, timeoutMs: 1000, signal }
}

const records = (agent: Agent): SessionEvent<'lyteboat/aux-llm-call'>[] =>
  agent.session.snapshotEvents().filter((event): event is SessionEvent<'lyteboat/aux-llm-call'> => event.type === 'lyteboat/aux-llm-call')

describe('ctx.auxLlm.generate', () => {
  it('answers from the agent\'s model and records the call ignorable, prompt and answer included', async () => {
    const adapter = new MockAdapter([textResponse('{"accepted": true}')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('answer'), { provider: 'mock', model: 'mock' })

    const outcome = await ctx.auxLlm.generate(call(agent, AbortSignal.timeout(5000)))

    expect(outcome).toMatchObject({ kind: 'answer', text: '{"accepted": true}', route: { provider: 'mock', model: 'mock' } })
    expect(adapter.requests[0]).toMatchObject({ system: 'CLASSIFIER', maxTokens: 50, temperature: 0, sessionId: agent.session.id })
    const [record] = records(agent)
    expect(record?.ignorable).toBe(true)
    expect(record?.data).toMatchObject({ purpose: 'classify', route: { provider: 'mock', model: 'mock' }, system: 'CLASSIFIER', prompt: '这句话属于哪一类？', maxTokens: 50, temperature: 0, output: '{"accepted": true}' })
    expect(agent.session.surface.nodes).toEqual([])
  })

  it('reports a failed call as an outcome, recorded with its reason', async () => {
    const adapter = new MockAdapter([() => { throw new TypeError('socket hang up') }])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('failed'), { provider: 'mock', model: 'mock' })

    const outcome = await ctx.auxLlm.generate(call(agent, AbortSignal.timeout(5000)))

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'Error', message: 'socket hang up' })
    expect(records(agent).map(record => record.data.failure)).toEqual([{ reason: 'Error', message: 'socket hang up' }])
  })

  it('reports a call that outlives its deadline as a timeout', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('timeout'), { provider: 'mock', model: 'mock' })

    const outcome = await ctx.auxLlm.generate({ ...call(agent, AbortSignal.timeout(5000)), timeoutMs: 20 })

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'timeout' })
    expect(records(agent).map(record => record.data.failure?.reason)).toEqual(['timeout'])
  })

  it('reports an answer cut off at maxTokens as a failure, not as an answer', async () => {
    const adapter = new MockAdapter([maxTokensResponse('{"accepted": tr')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('cut-off'), { provider: 'mock', model: 'mock' })

    const outcome = await ctx.auxLlm.generate(call(agent, AbortSignal.timeout(5000)))

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'max-tokens', message: 'the answer did not finish within maxTokens (50)' })
    expect(records(agent).map(record => [record.data.output, record.data.failure?.reason])).toEqual([[undefined, 'max-tokens']])
  })

  it('requests the configured reasoning effort on every call and records it', async () => {
    const off = ReasoningEffortId('off')
    const adapter = new MockAdapter([textResponse('{"accepted": true}')], { efforts: [{ id: off, name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') })
    const ctx = await harness(adapter, { reasoningEffort: 'off' })
    const agent = await ctx.agentLoop.create(SessionId('effort'), { provider: 'mock', model: 'mock' })

    await ctx.auxLlm.generate(call(agent, AbortSignal.timeout(5000)))

    expect(adapter.requests[0]?.reasoningEffort).toBe(off)
    expect(records(agent)[0]?.data.reasoningEffort).toBe('off')
  })

  it('rejects a host row whose reasoning effort is empty', async () => {
    const ctx = await createLyteboatUnitHost(new MockAdapter([]))
    await ctx.plugin(LyteboatDistroService)
    await expect(ctx.plugin(AuxLlmService, { reasoningEffort: '' })).rejects.toThrow(/reasoningEffort/u)
  })

  it('propagates the caller\'s abort and records nothing', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('aborted'), { provider: 'mock', model: 'mock' })
    const controller = new AbortController()

    const pending = ctx.auxLlm.generate(call(agent, controller.signal))
    setTimeout(() => { controller.abort(new Error('turn cancelled')) }, 10)

    await expect(pending).rejects.toThrow('turn cancelled')
    expect(records(agent)).toEqual([])
  })

  it('sends nothing without a route: no model, no record', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('no-route'), {})

    const outcome = await ctx.auxLlm.generate(call(agent, AbortSignal.timeout(5000)))

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'no-route' })
    expect(adapter.requests).toEqual([])
    expect(records(agent)).toEqual([])
  })
})
