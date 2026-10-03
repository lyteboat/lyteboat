/**
 * History in a session under the agent loop. Queued rounds: each a turn of its
 * own answered without a model request, logged as a seed logs it, known again
 * by trace id alone. A seeded session: the header, the turn numbering, the
 * derived request, the projection, and the invariants.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import LyteboatDistroService from '@lyteboat/distro'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse } from '@lyteboat/testkit'
import HistoryImportService from '@lyteboat/history-import'
import { LYTEBOAT_ASSISTANT_PROVIDER, LYTEBOAT_HISTORY_IMPORT_SOURCE, type LyteboatRequest } from '@lyteboat/contracts'
import { historyEntriesOf, type HistoryRound } from '../src/round-history.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(HistoryImportService)
  return ctx
}

async function agentOf(ctx: Context, id: string): Promise<Agent> {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' } })
  return agent
}

/** A human message carrying a request with this trace id, as a caller writes it. */
const traced = (text: string, traceId: string) => {
  const lyteboatRequest: LyteboatRequest = { traceId }
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', lyteboatRequest } })
}

const userTexts = (request: GenerateOptions): string[] =>
  request.messages.filter(message => message.role !== 'system').map(message => `${message.role}:${JSON.stringify(message.content).match(/"text":"([^"]*)"/u)?.[1] ?? ''}`)

const round = (traceId: string, user: string, assistant: string): HistoryRound => ({ traceId, createTime: undefined, user: { text: user }, assistant: { text: assistant } })

describe('a seeded session', () => {
  it('starts after the imported turns and derives them into the first request', async () => {
    const adapter = new MockAdapter([textResponse('继续')])
    const ctx = await harness(adapter)
    const seed = ctx.historyImport.seed([round('t1', '看看资产', '总额 100'), round('t2', '风险如何', '偏高')])
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('seeded'),
      meta: { isSeeded: true },
      seed: seed.events,
      inheritedEventCount: SessionLogOffset(seed.events.length),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(agent.session.header.isSeeded).toBe(true)
    expect(agent.session.inheritedEventCount).toBe(seed.events.length)
    expect(agent.session.eventAt(agent.session.surface.nodes[0]!)?.type).toBe('system/message')
    expect(seed.events.map(event => event.type).filter(type => type.startsWith('lyteboat/'))).toEqual([])

    await send(agent, '那怎么办')
    const request = adapter.requests[0] as GenerateOptions
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user'])
    expect(JSON.stringify(request.messages[1])).toContain('看看资产')
    expect(JSON.stringify(request.messages[4])).toContain('偏高')
    expect(request.messages.filter(message => message.role === 'system')).toHaveLength(1)
    const events = agent.session.snapshotEvents()
    const starts = events.filter((event): event is SessionEvent<'turn/start'> => event.type === 'turn/start').map(event => event.data.turn)
    expect(starts).toEqual([1, 2, 3])
    expect(events.map(event => event.type)).toContain('session/end-seed')
    expect(events.filter(event => event.type === 'turn/end').at(-1)!.data).toEqual({ turn: 3, reason: { kind: 'completed' } })
    // Only the live turn's prompt replaced node 0: the log still holds one system node per surface head.
    expect(events.filter(event => event.type === 'system/message')).toHaveLength(2)
  })

  it('reads the entry list out of a bare array or an envelope', () => {
    expect(historyEntriesOf([1])).toEqual([1])
    expect(historyEntriesOf({ history: [2] })).toEqual([2])
    expect(historyEntriesOf({ context: { history: [3] } })).toEqual([3])
    expect(historyEntriesOf({ other: [] })).toBeUndefined()
  })
})

describe('rounds queued into a session', () => {
  it('answers each round in a turn of its own without a model request, logged as the seed logs it, ahead of the next question', async () => {
    const adapter = new MockAdapter([textResponse('继续')])
    const ctx = await harness(adapter)
    const agent = await agentOf(ctx, 'queued')

    const queued = ctx.historyImport.enqueue(agent, [round('t1', '看看资产', '总额 100'), round('t2', '风险如何', '偏高')])
    await send(agent, traced('那怎么办', 't3'))

    expect(queued.map(entry => entry.traceId)).toEqual(['t1', 't2'])
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0] as GenerateOptions
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user'])
    expect(userTexts(request)).toEqual(['user:看看资产', 'assistant:总额 100', 'user:风险如何', 'assistant:偏高', 'user:那怎么办'])
    const events = agent.session.snapshotEvents()
    // The first turn's nodes, the inbox's own records aside, are the seed's.
    const firstTurn = events.slice(0, events.findIndex(event => event.type === 'turn/end') + 1).filter(event => event.type !== 'agent/inbox/spliced')
    expect(firstTurn.map(event => event.type)).toEqual(['turn/start', 'step/start', 'system/message', 'user/message', 'assistant/message', 'step/end', 'turn/end'])
    const questions = events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === LYTEBOAT_HISTORY_IMPORT_SOURCE)
    // The answer rode the queued message only; the log keeps the question with its trace id.
    expect(questions.map(event => event.data.source)).toEqual([{ kind: LYTEBOAT_HISTORY_IMPORT_SOURCE, traceId: 't1' }, { kind: LYTEBOAT_HISTORY_IMPORT_SOURCE, traceId: 't2' }])
    const answers = events.filter((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message').map(event => event.data.message.source)
    expect(answers.slice(0, 2)).toEqual([
      { kind: 'model', provider: LYTEBOAT_ASSISTANT_PROVIDER, model: 'history-import' },
      { kind: 'model', provider: LYTEBOAT_ASSISTANT_PROVIDER, model: 'history-import' },
    ])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([
      { turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } }, { turn: 3, reason: { kind: 'completed' } },
    ])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatTraceIds')).toEqual({ traceIds: ['t1', 't2', 't3'] })
  })

  it('skips a round whose trace id the session holds, one still queued, and one repeated in the list', async () => {
    const ctx = await harness(new MockAdapter([textResponse('好的')]))
    const agent = await agentOf(ctx, 'deduped')
    await send(agent, traced('上一个问题', 't-own'))
    ctx.historyImport.enqueue(agent, [round('t-old', '早先的问题', '早先的回答')])
    await agent.whenIdle()
    agent.send(createUserMessage({ content: [{ type: 'text', text: '排着' }], source: { kind: LYTEBOAT_HISTORY_IMPORT_SOURCE, traceId: 't-queued', answer: '排着的回答' } }), 'next-turn', false)

    const queued = ctx.historyImport.enqueue(agent, [
      round('t-own', '上一个问题', '会话自己答过'), round('t-old', '早先的问题', '早先的回答'), round('t-queued', '排着', '排着的回答'),
      round('t-new', '新问题', '新回答'), round('t-new', '新问题', '新回答'),
    ])
    await agent.whenIdle()

    expect(queued.map(entry => entry.traceId)).toEqual(['t-new'])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatTraceIds')).toEqual({ traceIds: ['t-own', 't-old', 't-queued', 't-new'] })
  })

  it('enqueue imports a round whose text repeats an earlier one when its trace id is new', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = await agentOf(ctx, 'same-text')
    ctx.historyImport.enqueue(agent, [round('t1', '看看资产', '总额 100')])
    await agent.whenIdle()

    const queued = ctx.historyImport.enqueue(agent, [round('t2', '看看资产', '总额 100')])
    await agent.whenIdle()

    expect(queued.map(entry => entry.traceId)).toEqual(['t2'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
  })

  it('enqueue appends a round older than the session\'s own turns after them', async () => {
    const ctx = await harness(new MockAdapter([textResponse('好的')]))
    const agent = await agentOf(ctx, 'late-round')
    await send(agent, traced('现在的问题', 't2'))

    ctx.historyImport.enqueue(agent, [{ ...round('t1', '更早的问题', '更早的回答'), createTime: '2020-01-01 00:00:00' }])
    await agent.whenIdle()

    const humans = agent.session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    expect(humans.map(event => event.data.content)).toEqual([[{ type: 'text', text: '现在的问题' }], [{ type: 'text', text: '更早的问题' }]])
  })

  it('fails the turn that claims a round together with another message, naming the round', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = await agentOf(ctx, 'mixed')
    agent.send(createUserMessage({ content: [{ type: 'text', text: '插话' }], source: { kind: 'user' } }), 'next-step', false)

    ctx.historyImport.enqueue(agent, [round('t1', '看看资产', '总额 100')])
    await agent.whenIdle()

    const end = agent.session.snapshotEvents().find((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    expect(end?.data.reason).toMatchObject({ kind: 'error', error: { message: expect.stringContaining('round t1 was claimed at step 1 with 1 other message(s)') as string } })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
  })
})
