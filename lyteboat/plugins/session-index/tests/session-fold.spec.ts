/**
 * A stored session folded into its Studio summary and timeline: requests and
 * owners, skill activations, tool calls with their cards and state deltas,
 * side model calls, turn outcomes and the counts they feed, open turns,
 * compaction and pruning, and imported history.
 */
import { describe, expect, it } from 'vitest'
import type { LyteboatRequest } from '@lyteboat/contracts'
import { foldSession, SESSION_SLOW_CALL_MS } from '../src/session-fold.ts'
import { SessionLogBuilder } from './session-log-builder.ts'

const request = (id: string, extra: Partial<LyteboatRequest> = {}): LyteboatRequest => ({ requestId: id, owner: { kind: 'user', id: 'alice' }, traceId: `trace-${id}`, context: { customer: 'c1' }, ...extra })
const CARD = { surfaceId: 's-1', area: 'overview', emission: 'immediate', payload: { title: 'x' } }

describe('foldSession', () => {
  it('folds a routed turn into its request, side call, skill, tool call with cards and state delta, answer, and outcome', () => {
    // The router decides on the queued message before the step records it; the timeline shows the message first.
    const log = new SessionLogBuilder(1_000)
      .turnStart().aux({ purpose: 'skill-router', durationMs: 80 })
      .stepStart().user('看看我的资产', request('r1'))
      .skill('asset-overview')
      .stepStart().toolCall('c1', 'asset_overview', '{"scope":"all"}')
      .after(40).toolResult('c1', 'total 100', { meta: { lyteboat: { cards: [CARD], stateDelta: { 'assets.total': 100 } } } })
      .stepStart().after(200).assistant('您的资产共 100。', { reasoning: 'sum it' })
      .turnEnd()

    const { summary, items } = foldSession(log.header('s1', '/w/finance'), 0, log.events)

    expect(items.map(item => item.kind)).toEqual(['user', 'aux', 'skill', 'tool', 'assistant', 'turn-end'])
    expect(items[0]).toMatchObject({ kind: 'user', turn: 1, text: '看看我的资产', request: { requestId: 'r1', traceId: 'trace-r1' }, imported: false })
    expect(items[1]).toMatchObject({ kind: 'aux', purpose: 'skill-router', durationMs: 80 })
    expect(items[2]).toMatchObject({ kind: 'skill', skill: 'asset-overview' })
    expect(items[3]).toMatchObject({ kind: 'tool', name: 'asset_overview', arguments: { scope: 'all' }, result: 'total 100', isError: false, durationMs: 41, cards: ['overview'], stateDelta: { 'assets.total': 100 }, pruned: false })
    expect(items[4]).toMatchObject({ kind: 'assistant', text: '您的资产共 100。', reasoning: 'sum it', model: 'mock/m1', usage: { inputTokens: 10, outputTokens: 5 }, answeredByAdmission: false })
    expect(items[5]).toMatchObject({ kind: 'turn-end', turn: 1, outcome: 'completed' })
    expect(summary).toEqual({
      sessionId: 's1', owner: { kind: 'user', id: 'alice' }, createdAt: 1_000, updatedAt: log.events.at(-1)?.time,
      messageCount: 2, turnCount: 1, firstMessage: '看看我的资产', lastUserMessage: '看看我的资产',
      errorCount: 0, rejectedCount: 0, abortedCount: 0, slowCount: 0, openTurn: false, seeded: false,
    })
  })

  it('times a model answer from its step\'s start and its first streamed chunk', () => {
    const log = new SessionLogBuilder(1_000).turnStart().stepStart().user('hi').stepStart().after(500).assistant('hello').turnEnd()

    const answer = foldSession(log.header('s1', '/w'), 0, log.events).items.find(item => item.kind === 'assistant')

    expect(answer).toMatchObject({ llmMs: 501, firstTokenMs: 500 })
  })

  it('counts an admission answer as rejected, a cancelled turn as aborted, and a failed turn or tool as errors', () => {
    const log = new SessionLogBuilder(1_000)
      .turnStart().stepStart().user('帮我买股票').assistant('这个我帮不了。', { byAdmission: true }).turnEnd()
      .turnStart().stepStart().user('继续').stepStart().turnEnd('aborted')
      .turnStart().stepStart().user('再来').stepStart().turnEnd('error')
      .turnStart().stepStart().user('查').stepStart().toolCall('c1', 'lookup', '{}').toolResult('c1', 'boom', { isError: true }).assistant('出错了').turnEnd()

    const { summary, items } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(items.filter(item => item.kind === 'turn-end').map(item => item.kind === 'turn-end' ? item.outcome : '')).toEqual(['rejected', 'aborted', 'errored', 'completed'])
    expect(items.find(item => item.kind === 'assistant')).toMatchObject({ answeredByAdmission: true })
    expect(summary).toMatchObject({ rejectedCount: 1, abortedCount: 1, errorCount: 2, turnCount: 4 })
  })

  it('counts a model answer or a tool call of ten seconds or more as slow', () => {
    const log = new SessionLogBuilder(1_000)
      .turnStart().stepStart().user('slow').stepStart().toolCall('c1', 'lookup', 'not json').after(SESSION_SLOW_CALL_MS).toolResult('c1', 'late')
      .stepStart().after(SESSION_SLOW_CALL_MS).assistant('done').turnEnd()

    const { summary, items } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(summary.slowCount).toBe(2)
    expect(items.find(item => item.kind === 'tool')).toMatchObject({ arguments: 'not json' })
  })

  it('marks a turn without its turn/end as open, and a call without its result as pending', () => {
    const log = new SessionLogBuilder(1_000).turnStart().stepStart().user('hi').stepStart().toolCall('c1', 'lookup', '{}')

    const { summary, items } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(summary.openTurn).toBe(true)
    expect(items.at(-1)).toMatchObject({ kind: 'tool', isError: false })
    expect(items.at(-1)).not.toHaveProperty('result')
  })

  it('shows a surface replacement once: a pruned result marks its call, a compaction becomes one entry', () => {
    const log = new SessionLogBuilder(1_000)
      .turnStart().stepStart().user('one').stepStart().toolCall('c1', 'lookup', '{}').toolResult('c1', 'a long result').assistant('ok').turnEnd()
      .turnStart().stepStart().user('two').stepStart().toolResult('c1', '[pruned]', { replaces: [4, 4] }).compaction(1, 5).assistant('again').turnEnd()

    const { summary, items } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(items.filter(item => item.kind === 'tool')).toEqual([expect.objectContaining({ result: 'a long result', pruned: true })])
    expect(items.filter(item => item.kind === 'compaction')).toEqual([expect.objectContaining({ replaced: 5, turn: 2 })])
    expect(summary.messageCount).toBe(4)
  })

  it('marks imported history and leaves it out of the counts', () => {
    const log = new SessionLogBuilder(1_000)
      .turnStart().stepStart().imported('上次的问题').assistant('上次的回答', { byAdmission: true }).turnEnd()
    const inherited = log.events.length
    log.turnStart().stepStart().user('继续', request('r2', { owner: { kind: 'operator', id: 'cli' } })).stepStart().assistant('好的').turnEnd()

    const { summary, items } = foldSession(log.header('s1', '/w', true), inherited, log.events)

    expect(items.filter(item => item.kind === 'user').map(item => item.kind === 'user' && item.imported)).toEqual([true, false])
    expect(items.find(item => item.kind === 'assistant')).toMatchObject({ imported: true, answeredByAdmission: true })
    expect(summary).toMatchObject({ seeded: true, rejectedCount: 0, owner: { kind: 'operator', id: 'cli' }, firstMessage: '上次的问题', lastUserMessage: '继续' })
  })

  it('shows a person\'s late answer to a question as their message, in the counts and the search', () => {
    const log = new SessionLogBuilder(1_000)
      .turnStart().stepStart().user('帮我查一下', request('r1')).stepStart().assistant('要查哪个账户？').turnEnd()
      .turnStart().stepStart().questionReply('call-1', [{ selected: ['储蓄账户'] }]).stepStart().assistant('好的').turnEnd()

    const { summary, items, search } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(items.filter(item => item.kind === 'user').map(item => item.kind === 'user' && item.text)).toEqual(['帮我查一下', '储蓄账户'])
    expect(summary).toMatchObject({ messageCount: 4, lastUserMessage: '储蓄账户' })
    expect(search.questions).toEqual(['帮我查一下', '储蓄账户'])
  })

  it('shows each answer of a late reply on its own line with its free text, and a reply that is not dsh\'s JSON as stored', () => {
    const log = new SessionLogBuilder(1_000)
      .turnStart().stepStart().questionReply('call-1', [{ selected: ['储蓄账户', '信用卡'] }, { selected: [], custom: '上个月' }, { selected: [] }]).turnEnd()
      .turnStart().stepStart().questionReply('call-2', '{"answers":"none"}').turnEnd()

    const { items } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(items.filter(item => item.kind === 'user').map(item => item.kind === 'user' && item.text)).toEqual(['储蓄账户, 信用卡\n上个月', '{"answers":"none"}'])
  })

  it('cuts the first and latest human message to 80 characters, and shows a malformed request as none', () => {
    const long = '长'.repeat(100)
    const log = new SessionLogBuilder(1_000).turnStart().stepStart().user(long, { requestId: 7 } as unknown as LyteboatRequest).turnEnd()

    const { summary, items } = foldSession(log.header('s1', '/w'), 0, log.events)

    expect(summary.firstMessage).toBe(`${'长'.repeat(80)}…`)
    expect(items[0]).not.toHaveProperty('request')
  })
})
