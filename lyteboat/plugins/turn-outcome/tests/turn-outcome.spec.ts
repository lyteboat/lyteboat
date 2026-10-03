/**
 * The turn outcome on the unit host: a completed turn with its request, counts,
 * and tool calls; the turns the admission answered; cancelled and failed
 * turns; imported history; surface replacements and ignored events; the fold
 * of a stored log against the live projection; and waiting for the turn that
 * answers a request.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { LYTEBOAT_ASSISTANT_PROVIDER, LYTEBOAT_HISTORY_IMPORT_SOURCE, type LyteboatIntakeDecision, type LyteboatRequest, type LyteboatTurnOutcomesState } from '@lyteboat/contracts'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse, toolCallResponse } from '@lyteboat/testkit'
import TurnOutcomeService, { foldTurnOutcomes } from '@lyteboat/turn-outcome'
import { lyteboatTurnOutcomesProjectionDefinition } from '../src/turn-outcome-projection.ts'

const DIGEST = `sha256:${'a'.repeat(64)}`

async function outcomeHost(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(TurnOutcomeService)
  for (const name of ['lookup', 'skill']) {
    ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {}, execute: async () => [{ type: 'text', text: `${name} ran` }] }))
  }
  return ctx
}

function agentOf(ctx: Context, id: string): Promise<Agent> {
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
}

function requestMessage(text: string, request: LyteboatRequest): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', lyteboatRequest: request } })
}

/** A human message the way dsh's session controller writes one: its request id as `rpcId`. */
function controllerMessage(text: string, rpcId: string): UserMessage {
  // The session controller's source fields are not in this package's loaded types; the loop carries them as data.
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } as unknown as UserMessage['source'] })
}

/** An admission in the loop: it calls a side model, then answers every first step itself. */
function answeringAdmission(ctx: Context): void {
  ctx.on('lyteboat/intake', async (payload, next): Promise<LyteboatIntakeDecision> => {
    const decision = await next()
    if (payload.step !== 1) return decision
    payload.agent.session.append('lyteboat/aux-llm-call', {
      purpose: 'intake', route: { provider: 'mock', model: 'mock' }, system: 's', prompt: 'p', maxTokens: 10, temperature: 0, output: 'reply', durationMs: 5,
    }, { ignorable: true })
    return { kind: 'reply', plugin: 'desk-admission', content: [{ type: 'text', text: '请先授权' }] }
  })
}

describe('the lyteboatTurnOutcomes projection', () => {
  it('records a completed turn with its request, steps, model requests, and every tool call paired with its result', async () => {
    const ctx = await outcomeHost(new MockAdapter([toolCallResponse('c1', 'skill', {}), toolCallResponse('c2', 'lookup', {}), textResponse('done')]))
    const agent = await agentOf(ctx, 'completed')

    await send(agent, requestMessage('看看我的资产', { requestId: 'r1', owner: { kind: 'user', id: 'alice' }, traceId: 't1', agent: { id: 'finance', digest: DIGEST } }))

    const [turn] = ctx.turnOutcome.of(agent.session)
    expect(ctx.turnOutcome.of(agent.session)).toHaveLength(1)
    expect(turn).toMatchObject({
      turn: 1, imported: false, answeredByAdmission: false, steps: 3, modelRequests: 3, auxCalls: 0, kind: 'completed',
      request: { requestId: 'r1', owner: { kind: 'user', id: 'alice' }, traceId: 't1', agentId: 'finance' },
      tools: [
        { callId: 'c1', name: 'skill', isError: false, durationMs: expect.any(Number) },
        { callId: 'c2', name: 'lookup', isError: false, durationMs: expect.any(Number) },
      ],
    })
    expect(agent.session.eventAt(SessionSeq(turn?.fromSeq ?? -1))?.type).toBe('turn/start')
    expect(agent.session.eventAt(SessionSeq(turn?.toSeq ?? -1))?.type).toBe('turn/end')
    expect(turn?.firstContentAt).toBeGreaterThanOrEqual(turn?.startedAt ?? Infinity)
    expect(turn).not.toHaveProperty('error')
  })

  it('records a turn the admission answered in the loop as rejected, with its side call', async () => {
    const adapter = new MockAdapter([])
    const ctx = await outcomeHost(adapter)
    answeringAdmission(ctx)
    const agent = await agentOf(ctx, 'admitted')

    await send(agent, '看看我的资产')

    expect(adapter.requests).toHaveLength(0)
    expect(ctx.turnOutcome.turn(agent.session, 1)).toMatchObject({ kind: 'rejected', answeredByAdmission: true, steps: 1, modelRequests: 0, auxCalls: 1, request: {} })
  })

  it('records a turn whose message carries a reply verdict as rejected, and one with a pass verdict as completed', async () => {
    const ctx = await outcomeHost(new MockAdapter([textResponse('answered'), textResponse('answered too')]))
    const agent = await agentOf(ctx, 'verdicts')

    await send(agent, requestMessage('看看我的资产', { requestId: 'r1', intake: { by: 'desk-admission', decision: 'reply', verdict: 'unauthorized', text: '请先授权' } }))
    await send(agent, requestMessage('再看看', { requestId: 'r2', intake: { by: 'desk-admission', decision: 'pass' } }))

    expect(ctx.turnOutcome.of(agent.session).map(turn => [turn.request?.intake, turn.kind])).toEqual([['reply', 'rejected'], ['pass', 'completed']])
  })

  it('ends a cancelled turn aborted and a failed one errored with its code', async () => {
    const adapter = new MockAdapter(['hang', [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider 401', code: 'AUTH' } } }]])
    const ctx = await outcomeHost(adapter)
    const held = await agentOf(ctx, 'held')
    const failing = await agentOf(ctx, 'failing')

    held.followup(createUserMessage({ content: [{ type: 'text', text: 'wait' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    expect(ctx.turnOutcome.turn(held.session, 1)).not.toHaveProperty('kind')
    held.cancel({ kind: 'user' })
    await held.whenIdle()
    await send(failing, 'go')

    expect(ctx.turnOutcome.turn(held.session, 1)?.kind).toBe('aborted')
    expect(ctx.turnOutcome.turn(failing.session, 1)).toMatchObject({ kind: 'errored', error: { code: 'AUTH', message: 'provider 401' } })
  })

  it('folds a stored log into the turns the live projection holds', async () => {
    const ctx = await outcomeHost(new MockAdapter([toolCallResponse('c1', 'lookup', {}), textResponse('done')]))
    const agent = await agentOf(ctx, 'stored')
    await send(agent, requestMessage('first', { requestId: 'r1' }))
    answeringAdmission(ctx)
    await send(agent, 'second')

    const stored = ctx.turnOutcome.fold(agent.session.inheritedEventCount, agent.session.snapshotEvents())

    expect(stored.map(turn => turn.kind)).toEqual(['completed', 'rejected'])
    expect(stored).toEqual(ctx.turnOutcome.of(agent.session))
  })
})

describe('the turn outcome fold over a stored log', () => {
  /** A log written by hand: an imported turn the history seed wrote, then a live turn. */
  function seededLog(): { inherited: number; events: SessionEvent[] } {
    const events: SessionEvent[] = []
    const push = (event: Record<string, unknown>): void => {
      // Built by hand at the storage boundary, as the loop and the history seed append them.
      events.push({ ...event, seq: SessionSeq(events.length), time: 1_000 + events.length } as unknown as SessionEvent)
    }
    const answer = (turn: number, text: string, provider: string, stream: unknown[]): Record<string, unknown> => ({
      type: 'assistant/message', surfaceOp: 'append',
      data: { turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider, model: 'm1' } }), stream },
    })
    push({ type: 'turn/start', data: { turn: 1 } })
    push({ type: 'step/start', data: { turn: 1, step: 1 } })
    push({ type: 'user/message', surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: 'earlier question' }], source: { kind: LYTEBOAT_HISTORY_IMPORT_SOURCE } }) })
    push(answer(1, 'earlier answer', LYTEBOAT_ASSISTANT_PROVIDER, []))
    push({ type: 'step/end', data: { turn: 1, step: 1 } })
    push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const inherited = events.length
    push({ type: 'turn/start', data: { turn: 2 } })
    push({ type: 'step/start', data: { turn: 2, step: 1 } })
    push({ type: 'user/message', surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' } }) })
    push(answer(2, 'go', 'mock', [{ type: 'text-chunks', time0: 1_007, index: 0, dt: [0], texts: ['go'] }]))
    push({ type: 'step/end', data: { turn: 2, step: 1 } })
    push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    return { inherited, events }
  }

  it('reads an imported turn answered with the admission provider as completed, not rejected', () => {
    const { inherited, events } = seededLog()

    const turns = foldTurnOutcomes(inherited, events)

    expect(turns.map(turn => [turn.turn, turn.imported, turn.answeredByAdmission, turn.kind])).toEqual([[1, true, false, 'completed'], [2, false, false, 'completed']])
    expect(turns[1]).toMatchObject({ modelRequests: 1, firstContentAt: 1_007, request: {} })
  })

  it('reads a turn whose human message is an imported round\'s question as imported history outside the inherited prefix', () => {
    const { events } = seededLog()

    const turns = foldTurnOutcomes(0, events)

    expect(turns.map(turn => [turn.turn, turn.imported, turn.answeredByAdmission, turn.kind])).toEqual([[1, true, false, 'completed'], [2, false, false, 'completed']])
  })

  it('leaves a surface replacement uncounted and returns the same state for an event it ignores', () => {
    const { inherited, events } = seededLog()
    const definition = lyteboatTurnOutcomesProjectionDefinition
    let state: LyteboatTurnOutcomesState = { importedBelowSeq: inherited, queued: { 'next-turn': [], 'next-step': [] }, turns: [] }
    for (const event of events.slice(0, -1)) state = definition.apply(state, event)
    const replacement = {
      type: 'assistant/message', seq: SessionSeq(events.length), time: 2_000,
      surfaceOp: { op: 'replace', startSeq: SessionSeq(8), endSeq: SessionSeq(9) },
      data: { turn: 2, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'summary' }], source: { provider: 'mock', model: 'm1' } }), stream: [{ type: 'text-chunks', time0: 1_999, index: 0, dt: [0], texts: ['summary'] }] },
    } as unknown as SessionEvent
    const stepEnd = { type: 'step/end', seq: SessionSeq(events.length + 1), time: 2_001, data: { turn: 2, step: 1 } } as unknown as SessionEvent

    expect(definition.apply(state, replacement)).toBe(state)
    expect(definition.apply(state, stepEnd)).toBe(state)
    expect(state.turns.at(-1)?.modelRequests).toBe(1)
  })
})

describe('turnOutcome.ended', () => {
  it('resolves once the turn answering a request ends, and at once for a turn that already ended', async () => {
    const ctx = await outcomeHost(new MockAdapter([textResponse('done')]))
    const agent = await agentOf(ctx, 'waited')
    const signal = new AbortController().signal

    const pending = ctx.turnOutcome.ended(agent.session, 'rpc-1', signal)
    agent.followup(controllerMessage('hello', 'rpc-1'))
    const ended = await pending

    expect(ended).toMatchObject({ turn: 1, kind: 'completed', request: { requestId: 'rpc-1' } })
    expect(await ctx.turnOutcome.ended(agent.session, 'rpc-1', signal)).toEqual(ended)
    expect(ctx.turnOutcome.forRequest(agent.session, 'rpc-1')).toEqual(ended)
  })

  it('resolves for a turn that fails after claiming the request and before logging its message', async () => {
    const adapter = new MockAdapter([])
    const ctx = await outcomeHost(adapter)
    ctx.on('lyteboat/pre-assemble', () => Promise.reject(new Error('skill "notes" requires tool "lookup_notes", which the tool policy does not declare')))
    const agent = await agentOf(ctx, 'unlogged')

    const pending = ctx.turnOutcome.ended(agent.session, 'rpc-1', new AbortController().signal)
    agent.followup(controllerMessage('hello', 'rpc-1'))
    const ended = await pending

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().map(event => event.type)).not.toContain('user/message')
    expect(ended).toMatchObject({ turn: 1, kind: 'errored', request: { requestId: 'rpc-1' }, error: { message: expect.stringContaining('requires tool "lookup_notes"') as string } })
    expect(ctx.turnOutcome.fold(agent.session.inheritedEventCount, agent.session.snapshotEvents())).toEqual(ctx.turnOutcome.of(agent.session))
  })

  it('stops waiting when its signal aborts', async () => {
    const ctx = await outcomeHost(new MockAdapter([]))
    const agent = await agentOf(ctx, 'never')
    const stop = new AbortController()

    const pending = ctx.turnOutcome.ended(agent.session, 'missing', stop.signal)
    stop.abort(new Error('caller left'))

    await expect(pending).rejects.toThrow('caller left')
    await expect(ctx.turnOutcome.ended(agent.session, 'missing', stop.signal)).rejects.toThrow('caller left')
  })
})
