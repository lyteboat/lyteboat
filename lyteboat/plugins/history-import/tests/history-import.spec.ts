/**
 * A seeded session under the agent loop: the header, the turn numbering, the
 * derived request, the projection, and the invariants.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse } from '@lyteboat/testkit'
import HistoryImportService from '@lyteboat/history-import'
import { historyEntriesOf, type HistoryRound } from '../src/round-history.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(HistoryImportService)
  return ctx
}

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
