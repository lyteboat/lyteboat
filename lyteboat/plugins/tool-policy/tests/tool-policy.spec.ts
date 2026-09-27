/**
 * The tool policy at the agent loop's seams: visibility through restriction,
 * confirmation through `ask`, and state deltas folded from `tool/result.meta`.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import LyteboatDistroService from '@lyteboat/distro'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse, toolCallResponse } from '@lyteboat/testing'
import ToolPolicyService from '@lyteboat/tool-policy'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  return ctx
}

function echo(name: string): ToolDefinition {
  return defineContentToolFixture({
    name, description: name, parameters: {},
    execute: async () => [{ type: 'text', text: `${name} ran` }],
  })
}

function errorMessage(turnEnd: SessionEvent<'turn/end'>): string {
  const reason = turnEnd.data.reason as { kind: string; error?: { message: string } }
  return reason.kind === 'error' ? reason.error?.message ?? '' : ''
}

function toolNames(adapter: MockAdapter, index: number): string[] {
  return (adapter.requests[index]?.tools ?? []).map(tool => tool.name)
}

describe('visibility', () => {
  it('hides auto tools until activated, applies an activation made in lyteboat/pre-assemble to the same step, and reissues only on change', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await harness(adapter)
    ctx.toolPolicy.register(echo('always_tool'), { visibility: 'always' })
    ctx.toolPolicy.register(echo('auto_tool'), { visibility: 'auto' })
    // Declared through the registrar path, registered by an ordinary row.
    ctx.tools.register(echo('official_tool'))
    ctx.toolPolicy.declare('official_tool', { visibility: 'auto' })
    let changes = 0
    ctx.on('tools/change', () => { changes += 1 })
    let activate: string[] = []
    ctx.on('lyteboat/pre-assemble', async (payload, next) => {
      if (activate.length > 0) ctx.toolPolicy.activate(payload.agent, activate)
      return next()
    })
    const agent = await ctx.agentLoop.create(SessionId('visibility'), { provider: 'mock', model: 'mock' })

    await send(agent, 'hello')
    expect(toolNames(adapter, 0)).toEqual(['always_tool'])
    expect(changes).toBe(1)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['always_tool'])

    await send(agent, 'again')
    expect(toolNames(adapter, 1)).toEqual(['always_tool'])
    expect(changes).toBe(1)

    activate = ['auto_tool']
    await send(agent, 'now')
    expect(toolNames(adapter, 2)).toEqual(['always_tool', 'auto_tool'])
    expect(ctx.toolPolicy.activated(agent)).toEqual(['auto_tool'])
    // Lifting the old restriction and issuing the new one: two notifications.
    expect(changes).toBe(3)
  })

  it('fails the step loudly for a declared name no row registered, instead of skipping it', async () => {
    const adapter = new MockAdapter([textResponse('never')])
    const ctx = await harness(adapter)
    ctx.toolPolicy.declare('phantom_tool', { visibility: 'auto' })
    const agent = await ctx.agentLoop.create(SessionId('phantom'), { provider: 'mock', model: 'mock' })
    await send(agent, 'hello')
    expect(adapter.requests).toHaveLength(0)
    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end') as SessionEvent<'turn/end'>
    expect(errorMessage(turnEnd)).toContain('declared tool "phantom_tool" registered by no row')
  })

  it('fails the step loudly for an auto tool in the agent\'s own layer, which restrict() cannot hide', async () => {
    const adapter = new MockAdapter([textResponse('never')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('own-layer'), { provider: 'mock', model: 'mock' })
    agent.ctx.tools.register(echo('own_tool'))
    ctx.toolPolicy.declare('own_tool', { visibility: 'auto' })
    await send(agent, 'hello')
    expect(adapter.requests).toHaveLength(0)
    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end') as SessionEvent<'turn/end'>
    expect(errorMessage(turnEnd)).toContain('registered in agent "own-layer"\'s own layer')
  })

  it('hides every inherited tool the policy does not declare under inherited: hidden, keeps a declared always tool visible, and activates declared tools only', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const ctx = await harness(adapter)
    ctx.tools.register(echo('official_tool'))
    ctx.tools.register(echo('kept_tool'))
    ctx.toolPolicy.register(echo('auto_tool'), { visibility: 'auto' })
    const agent = await ctx.agentLoop.create(SessionId('inherited-hidden'), { provider: 'mock', model: 'mock' })
    const plain = await ctx.agentLoop.create(SessionId('inherited-default'), { provider: 'mock', model: 'mock' })
    await agent.ctx.inject(['toolPolicy'], (agentCtx) => {
      agentCtx.toolPolicy.declareInherited('hidden')
      agentCtx.toolPolicy.declare('kept_tool', { visibility: 'always' })
    })

    await send(agent, 'hello')
    expect(toolNames(adapter, 0)).toEqual(['kept_tool'])
    expect(() => ctx.toolPolicy.activate(agent, ['official_tool'])).toThrow(/undeclared tool "official_tool"/u)
    ctx.toolPolicy.activate(agent, ['auto_tool'])
    await send(agent, 'again')
    expect(toolNames(adapter, 1).sort()).toEqual(['auto_tool', 'kept_tool'])

    await send(plain, 'hello')
    expect(toolNames(adapter, 2).sort()).toEqual(['kept_tool', 'official_tool'])
  })

  it('answers what a new agent under a standing scope sees before anything is activated', async () => {
    const ctx = await harness(new MockAdapter([]))
    ctx.tools.register(echo('official_tool'))
    ctx.tools.register(echo('host_tool'))
    const key = {}
    const standing = createScope(ctx, key)
    // A standing scope's rows register the way a preset's rows do: through the scope's own context.
    standing.ctx.get('tools')?.register(echo('auto_tool'))
    standing.ctx.get('tools')?.register(echo('row_tool'))
    const open = {}
    createScope(ctx, open)

    // Declared from the scope's own context, as an agent row declares them.
    await standing.ctx.inject(['toolPolicy'], (standingCtx) => {
      standingCtx.toolPolicy.declareInherited('hidden')
      standingCtx.toolPolicy.declare('auto_tool', { visibility: 'auto' })
      standingCtx.toolPolicy.declare('official_tool', { visibility: 'always' })
    })

    expect(ctx.toolPolicy.visible(key)).toEqual(['official_tool'])
    expect(ctx.toolPolicy.visible(open)).toEqual(['official_tool', 'host_tool'])
    expect(ctx.toolPolicy.metaOf('auto_tool', key)).toEqual({ visibility: 'auto' })
    expect(ctx.toolPolicy.metaOf('auto_tool')).toBeUndefined()
  })

  it('refuses a second declaration of the inherited visibility in one scope', async () => {
    const ctx = await harness(new MockAdapter([]))
    ctx.toolPolicy.declareInherited('hidden')
    expect(() => ctx.toolPolicy.declareInherited('visible')).toThrow(/already declared in this scope/u)
  })

  it('activate() rejects undeclared names and takes effect at once; clear() hides again', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    ctx.toolPolicy.register(echo('auto_tool'), { visibility: 'auto' })
    const agent = await ctx.agentLoop.create(SessionId('activate'), { provider: 'mock', model: 'mock' })
    expect(() => ctx.toolPolicy.activate(agent, ['nope'])).toThrow(/undeclared tool "nope"/u)

    ctx.toolPolicy.activate(agent, ['auto_tool'])
    await send(agent, 'hello')
    expect(toolNames(adapter, 0)).toEqual(['auto_tool'])

    ctx.toolPolicy.clear(agent)
    await send(agent, 'again')
    expect(toolNames(adapter, 1)).toEqual([])
    expect(ctx.toolPolicy.activated(agent)).toEqual([])
  })
})

describe('tool updates (dsh 0.1.7-rc.2)', () => {
  async function activateOnSecondTurn(adapter: MockAdapter, id: string): Promise<Agent> {
    const ctx = await harness(adapter)
    ctx.toolPolicy.register(echo('always_tool'), { visibility: 'always' })
    ctx.toolPolicy.register(echo('auto_tool'), { visibility: 'auto' })
    let activate: string[] = []
    ctx.on('lyteboat/pre-assemble', async (payload, next) => {
      if (activate.length > 0) ctx.toolPolicy.activate(payload.agent, activate)
      return next()
    })
    const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
    await send(agent, 'hello')
    activate = ['auto_tool']
    await send(agent, 'now')
    return agent
  }

  it('logs an activation after the first request as a tool-registry developer message that names the changed header', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const agent = await activateOnSecondTurn(adapter, 'tool-registry-log')
    const events = agent.session.snapshotEvents()
    const headers = events.filter(event => event.type === 'request/header') as SessionEvent<'request/header'>[]
    expect(headers.map(event => event.data.reason)).toEqual(['initial', 'change'])
    const updates = events.filter(event => event.type === 'developer/message') as SessionEvent<'developer/message'>[]
    expect(updates.map(event => ({ content: event.data.message.content, source: event.data.message.source, headerSeq: event.data.headerSeq, surfaceOp: event.surfaceOp })))
      .toEqual([{ content: [{ type: 'tool-addition', toolName: 'auto_tool' }], source: { kind: 'tool-registry' }, headerSeq: headers[1]!.seq, surfaceOp: 'append' }])
  })

  it('sends a route without tool updates the complete list and no developer message', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    await activateOnSecondTurn(adapter, 'tool-registry-plain')
    expect(adapter.requests[1]?.tools?.map(tool => [tool.name, tool.deferLoading])).toEqual([['always_tool', undefined], ['auto_tool', undefined]])
    expect(adapter.requests[1]?.messages.filter(message => message.role === 'developer')).toEqual([])
  })

  it('sends an addition-only route the activated tool deferred, activated by the logged developer message', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    adapter.toolUpdate = 'addition-only'
    await activateOnSecondTurn(adapter, 'tool-registry-deferred')
    expect(adapter.requests[1]?.tools?.map(tool => [tool.name, tool.deferLoading])).toEqual([['always_tool', undefined], ['auto_tool', true]])
    expect(adapter.requests[1]?.messages.filter(message => message.role === 'developer').map(message => message.content))
      .toEqual([[{ type: 'tool-addition', toolName: 'auto_tool' }]])
  })
})

describe('state', () => {
  it('folds the result meta delta into lyteboatState and shows it to the model next step, writing no lyteboat node', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'lookup', {}), textResponse('done')])
    const ctx = await harness(adapter)
    ctx.toolPolicy.register(defineTool({
      name: 'lookup', description: 'lookup', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { total: { type: 'number', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `sum ${value.total}` }],
        presentationMeta: () => ({ card: 'own' }),
      },
      execute: async () => ({ total: 5 }),
    }), { stateDelta: (_args, value) => ({ 'portfolio.total': (value as { total: number }).total }) })
    const agent = await ctx.agentLoop.create(SessionId('state'), { provider: 'mock', model: 'mock' })

    await send(agent, 'go')
    const events = agent.session.snapshotEvents()
    expect(events.map(event => event.type).filter(type => type.startsWith('lyteboat/'))).toEqual([])
    const result = events.find((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')!
    expect(result.data.meta).toEqual({ card: 'own', lyteboat: { stateDelta: { 'portfolio.total': 5 } } })
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatState')).toEqual({ portfolio: { total: 5 } })
    expect(ctx.sessionProjections.snapshot(agent.session).values['lyteboatState']).toEqual({ portfolio: { total: 5 } })
    // The second request carries the runtime context with the state; the first had none.
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Session state')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Session state, accumulated from tool results')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('portfolio')
  })

  it('records the tool\'s own meta unchanged when the delta hook derives nothing', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'with_meta', {}), toolCallResponse('c2', 'without_meta', {}), textResponse('done')])
    const ctx = await harness(adapter)
    const tool = (name: string, meta: boolean): ToolDefinition => defineTool({
      name, description: name, parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { total: { type: 'number', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `sum ${value.total}` }],
        ...meta ? { presentationMeta: () => ({ card: 'own' }) } : {},
      },
      execute: async () => ({ total: 5 }),
    })
    ctx.toolPolicy.register(tool('with_meta', true), { stateDelta: () => undefined })
    ctx.toolPolicy.register(tool('without_meta', false), { stateDelta: () => undefined })
    const agent = await ctx.agentLoop.create(SessionId('no-delta'), { provider: 'mock', model: 'mock' })

    await send(agent, 'go')
    const metas = agent.session.snapshotEvents()
      .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
      .map(event => event.data.meta)
    expect(metas).toEqual([{ card: 'own' }, {}])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatState')).toEqual({})
  })
})

describe('distribution', () => {
  it('loads only where lyteboatDistro marks the kernel extension it listens to', async () => {
    const ctx = await createLyteboatUnitHost(new MockAdapter([]))
    void ctx.plugin(ToolPolicyService)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('toolPolicy')).toBeUndefined()
    await ctx.plugin(LyteboatDistroService)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('toolPolicy')).toBeDefined()
  })
})
