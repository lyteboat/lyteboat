/**
 * The Dashboard's health figures against golden fixtures the original
 * Studio's own functions generated (`fixtures/dashboard-health.json`: its
 * rows, and what its dashboard answered for four windows, the bucket sizes,
 * and the percentiles), compared field by field after naming them as it
 * does; and each deliberate difference as a named test.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LyteboatTurnMetric } from '@lyteboat/contracts'
import { studioBucketMinutes, studioHealthAggregate, studioHealthWindow, studioPercentile, studioRoundHalfEven } from '../src/studio-dashboard-health.ts'

interface GoldenRow {
  run_id: string
  session_id: string
  user_id: string
  started_at_ms: number
  duration_ms: number
  first_content_ms: number
  turn_count: number
  active_skill_id: string | null
  outcome: LyteboatTurnMetric['outcome']
  error_type: string | null
  activated_skill_ids: string[]
  tool_calls: { name: string; duration_ms: number; is_error: boolean }[]
}

interface Golden {
  rows: GoldenRow[]
  windows: { name: string; start: number; end: number; bucket: number | null; resolvedBucket: number; health: unknown }[]
  buckets: { span: number; requested: number | null; bucket?: number; error?: number }[]
  percentiles: { values: number[]; p: number; result: number | null }[]
}

const golden = JSON.parse(readFileSync(new URL('./fixtures/dashboard-health.json', import.meta.url), 'utf8')) as Golden

/** A row of the original as the recorder writes it: its skill-reading tool is dsh's `skill`, a user is an owner. */
function metricOf(row: GoldenRow): LyteboatTurnMetric {
  return {
    agentId: 'agent', sessionId: row.session_id, turn: 1,
    ...row.user_id === '' ? {} : { owner: { kind: 'user' as const, id: row.user_id } },
    startedAt: row.started_at_ms, durationMs: row.duration_ms, firstContentMs: row.first_content_ms,
    steps: row.turn_count, modelRequests: row.turn_count, auxCalls: 0,
    tools: row.tool_calls.map(tool => ({ name: tool.name === 'read_skill' ? 'skill' : tool.name, durationMs: tool.duration_ms, isError: tool.is_error })),
    activatedSkills: row.activated_skill_ids,
    ...row.active_skill_id === null ? {} : { activeSkill: row.active_skill_id },
    outcome: row.outcome,
    ...row.error_type === null ? {} : { errorCode: row.error_type },
  }
}

const TIME_KEYS = new Set(['startedAt', 'endedAt'])

/** Our answer named the original's way: snake_case keys, times as its ISO strings. */
function asOriginal(value: unknown, key = ''): unknown {
  if (TIME_KEYS.has(key) && typeof value === 'number') return new Date(value).toISOString().replace('.000Z', '+00:00')
  if (Array.isArray(value)) return value.map(item => asOriginal(item))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`), asOriginal(item, name)]))
}

const rows = golden.rows.map(metricOf)

describe('the Dashboard health figures (golden fixtures of the original Studio)', () => {
  for (const window of golden.windows) {
    it(`answers the window "${window.name}" as the original does`, () => {
      const inWindow = rows.filter(row => row.startedAt >= window.start && row.startedAt <= window.end)

      const bucket = studioBucketMinutes(window.start, window.end, window.bucket ?? undefined)
      const health = studioHealthWindow(inWindow, window.start, window.end, bucket ?? 0)

      expect(bucket).toBe(window.resolvedBucket)
      expect(asOriginal(health)).toEqual(window.health)
    })
  }

  it('picks the bucket size and refuses more than 500 buckets as the original does', () => {
    for (const { span, requested, bucket, error } of golden.buckets) {
      expect(studioBucketMinutes(0, span, requested ?? undefined)).toBe(error === undefined ? bucket : undefined)
    }
  })

  it('takes nearest-rank percentiles as the original does', () => {
    for (const { values, p, result } of golden.percentiles) expect(studioPercentile(values, p)).toBe(result)
  })

  it('rounds half to even, as Python does', () => {
    expect([0.5, 1.5, 2.5, 2.675].map(value => studioRoundHalfEven(value))).toEqual([0, 2, 2, 3])
    expect(studioRoundHalfEven(0.125, 2)).toBe(0.12)
    expect(studioRoundHalfEven(2.675, 2)).toBe(2.67)
  })
})

describe('the Dashboard health figures where lyteboat differs', () => {
  const base = metricOf(golden.rows[0] ?? ({} as GoldenRow))

  it('counts a turn the admission answered as a controlled exit, beside aborted turns', () => {
    const health = studioHealthAggregate([{ ...base, outcome: 'rejected' }, { ...base, sessionId: 's-x', outcome: 'aborted' }])

    expect(health).toMatchObject({ controlledExitCount: 2, completionRate: 0, technicalFailureCount: 0 })
  })

  it('counts users by owner, so an operator and a user of the same id are two', () => {
    const health = studioHealthAggregate([{ ...base, owner: { kind: 'user', id: 'x' } }, { ...base, sessionId: 's-y', owner: { kind: 'operator', id: 'x' } }])

    expect(health.activeUsers).toBe(2)
  })
})
