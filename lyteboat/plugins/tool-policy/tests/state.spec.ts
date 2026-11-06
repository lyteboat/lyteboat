import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@lyteboat/contracts'
import { lyteboatStateProjectionDefinition, mergeStateDelta, renderLyteboatState } from '../src/state.ts'

describe('mergeStateDelta', () => {
  it('assigns dot paths, creating intermediate objects', () => {
    const next = mergeStateDelta({}, { 'assets.total': 1234, 'assets.currency': 'CNY' })
    expect(next).toEqual({ assets: { total: 1234, currency: 'CNY' } })
  })

  it('deep-merges nested plain objects and replaces every other value', () => {
    const state = { assets: { total: 1, tags: ['a'] }, user: 'x' }
    const next = mergeStateDelta(state, { assets: { total: 2, tags: ['b'] }, user: { name: 'y' } })
    expect(next).toEqual({ assets: { total: 2, tags: ['b'] }, user: { name: 'y' } })
    expect(state).toEqual({ assets: { total: 1, tags: ['a'] }, user: 'x' })
  })

  it('returns the same reference when nothing changed', () => {
    const state = { assets: { total: 1 } }
    expect(mergeStateDelta(state, { 'assets.total': 1 })).toBe(state)
    expect(mergeStateDelta(state, {})).toBe(state)
  })

  it('replaces a scalar on the path with an object', () => {
    expect(mergeStateDelta({ assets: 5 }, { 'assets.total': 1 })).toEqual({ assets: { total: 1 } })
  })

  it('rejects non-object deltas and empty path segments', () => {
    expect(() => mergeStateDelta({}, [1])).toThrow(/JSON object/u)
    expect(() => mergeStateDelta({}, { 'a..b': 1 })).toThrow(/empty segment/u)
  })
})

describe('renderLyteboatState', () => {
  it('renders nothing for an empty state', () => {
    expect(renderLyteboatState({})).toBe('')
  })

  it('renders the JSON state under a fixed heading', () => {
    expect(renderLyteboatState({ a: 1 })).toBe('Session state, accumulated from tool results (JSON):\n{"a":1}')
  })
})

describe('lyteboatStateProjectionDefinition', () => {
  const result = (seq: number, delta: JsonValue, surfaceOp: unknown): SessionEvent =>
    ({ type: 'tool/result', seq, time: 0, surfaceOp, data: { turn: 1, step: 1, message: { toolCallId: `c${String(seq)}` }, meta: { lyteboat: { stateDelta: delta } } } }) as never

  it('folds appended results only: a replacement carrying an old delta leaves newer state alone', () => {
    const fold = lyteboatStateProjectionDefinition
    const newer = fold.apply(fold.apply(fold.init(), result(1, { stage: 'overview' }, 'append')), result(2, { stage: 'diagnosis' }, 'append'))
    expect(fold.apply(newer, result(3, { stage: 'overview' }, { op: 'replace', startSeq: 1, endSeq: 1 }))).toBe(newer)
    expect(newer).toEqual({ stage: 'diagnosis' })
  })

  it('fails the fold on a tool result whose meta.lyteboat fails its schema, naming the node', () => {
    const fold = lyteboatStateProjectionDefinition
    expect(() => fold.apply(fold.init(), result(4, ['not', 'an', 'object'], 'append'))).toThrow('tool result at session seq 4 carries an invalid meta.lyteboat')
  })
})
