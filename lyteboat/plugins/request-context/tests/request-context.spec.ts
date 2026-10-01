/**
 * The request on a human message: written by the service, read back against
 * the contract's schema, and folded into the session's request state.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse } from '@lyteboat/testkit'
import RequestContextService from '@lyteboat/request-context'
import { lyteboatRequestOf, lyteboatRequestProjectionDefinition } from '../src/request-projection.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(RequestContextService)
  return ctx
}

describe('the request on a human message', () => {
  it('rides the source beside kind user, and a request with nothing to record leaves the source as dsh writes it', async () => {
    const ctx = await harness(new MockAdapter([]))

    const carried = ctx.requestContext.message('看看我的资产', { requestId: 'r-1', context: { customer: 'c-1' } })
    const plain = ctx.requestContext.message('你好', {})

    expect(carried.source).toEqual({ kind: 'user', lyteboatRequest: { requestId: 'r-1', context: { customer: 'c-1' } } })
    expect(ctx.requestContext.requestOf(carried)).toEqual({ requestId: 'r-1', context: { customer: 'c-1' } })
    expect(plain.source).toEqual({ kind: 'user' })
    expect(ctx.requestContext.requestOf(plain)).toBeUndefined()
  })

  it('rejects a malformed request and reads nothing from another kind of source', () => {
    const malformed = createUserMessage({ content: [], source: { kind: 'user', lyteboatRequest: { context: 'not an object' } } as never })
    const otherKind = createUserMessage({ content: [], source: { kind: 'runtime-context', lyteboatRequest: { context: {} } } as never })

    expect(() => lyteboatRequestOf(malformed.source)).toThrow()
    expect(lyteboatRequestOf(otherKind.source)).toBeUndefined()
  })

  it('fails the fold on a human message whose request fails its schema, naming the node', () => {
    const fold = lyteboatRequestProjectionDefinition
    const message = createUserMessage({ content: [], source: { kind: 'user', lyteboatRequest: { intake: { by: 'gate', decision: 'maybe' } } } as never })
    const event = { type: 'user/message', seq: 3, time: 0, surfaceOp: 'append', data: message } as never

    expect(() => fold.apply(fold.init(), event)).toThrow('human message at session seq 3 carries an invalid source.lyteboatRequest')
  })

  it('folds the session context: the latest request that carried one wins, and one without keeps it', async () => {
    const ctx = await harness(new MockAdapter([textResponse('一'), textResponse('二'), textResponse('三')]))
    const agent = await ctx.agentLoop.create(SessionId('context'), { provider: 'mock', model: 'mock' })
    const verdict = { by: 'gate', decision: 'pass' as const }

    await send(agent, ctx.requestContext.message('第一句', { context: { customer: 'c-1', channel: 'app' }, intake: verdict }))
    await send(agent, ctx.requestContext.message('第二句', { intake: verdict }))
    expect(ctx.requestContext.contextOf(agent)).toEqual({ customer: 'c-1', channel: 'app' })

    await send(agent, ctx.requestContext.message('第三句', { context: { customer: 'c-2' } }))
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')).toEqual({ requests: 3, context: { customer: 'c-2' }, intake: null, owner: null })
  })

  it('keeps the first owner a request names as the session owner', async () => {
    const ctx = await harness(new MockAdapter([textResponse('一'), textResponse('二'), textResponse('三')]))
    const agent = await ctx.agentLoop.create(SessionId('owner'), { provider: 'mock', model: 'mock' })

    await send(agent, ctx.requestContext.message('第一句', {}))
    await send(agent, ctx.requestContext.message('第二句', { owner: { kind: 'user', id: 'u-1' }, traceId: 't-1' }))
    await send(agent, ctx.requestContext.message('第三句', { owner: { kind: 'user', id: 'u-2' } }))

    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')?.owner).toEqual({ kind: 'user', id: 'u-1' })
  })
})

describe('the request as session-controller source fields', () => {
  it('carries the request as lyteboatRequest, and a request with nothing to record adds no field', async () => {
    const ctx = await harness(new MockAdapter([]))
    const request = { requestId: 'm-1', owner: { kind: 'user' as const, id: 'u-1' }, traceId: 't-1', context: { customer: 'c-1' } }

    expect(ctx.requestContext.sourceFields(request)).toEqual({ lyteboatRequest: request })
    expect(ctx.requestContext.sourceFields({})).toEqual({})
  })

  it('refuses a request that fails the contract', async () => {
    const ctx = await harness(new MockAdapter([]))

    expect(() => ctx.requestContext.sourceFields({ owner: 'u-1' } as never)).toThrow()
    expect(() => ctx.requestContext.sourceFields({ agent: { id: 'finance', digest: 'md5:abc' } })).toThrow('must be sha256: and 64 lowercase hex digits')
  })

  it('carries the agent a request went to', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = { id: 'finance', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` }

    expect(ctx.requestContext.sourceFields({ requestId: 'm-1', agent })).toEqual({ lyteboatRequest: { requestId: 'm-1', agent } })
  })
})
