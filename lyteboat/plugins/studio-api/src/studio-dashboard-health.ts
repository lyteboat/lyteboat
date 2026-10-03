/**
 * The Dashboard's health figures from run metrics, ported from the original
 * Studio's dashboard (`plugins/studio/api/dashboard.py`) and checked against
 * golden fixtures its own functions generated: nearest-rank percentiles,
 * buckets of the window (the last bucket takes the window's end), a sweep
 * line over each turn's span for the peak of users with a turn running, and
 * the top six tools and skills. Its rounding is Python's, half to even.
 * Deliberate differences: `rejected` turns (the admission answered) count as
 * controlled exits, as the original's intercepted runs did as aborts; the
 * skill load tool is dsh's `skill`; a user is an owner, `kind:id`.
 * @module @lyteboat/studio-api/studio-dashboard-health
 */

import type { LyteboatTurnMetric } from '@lyteboat/contracts'
import type { StudioHealthAggregate, StudioHealthSeriesPoint, StudioHealthWindow, StudioSkillRanking, StudioToolRanking } from '@lyteboat/contracts/studio'

const RANKING_LIMIT = 6
const MAX_BUCKETS = 500
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** dsh's skill load tool; the recorder already leaves it out, and rows from elsewhere must not count it either. */
const SKILL_LOAD_TOOL = 'skill'

/**
 * Python's `round`: to `digits` decimals, half to even, decided on the
 * number's exact binary value (so 2.675, stored as 2.67499…, rounds down).
 */
export function studioRoundHalfEven(value: number, digits = 0): number {
  // toFixed(100) spells out the double's exact decimal value for any magnitude the dashboard meets.
  const [whole = '0', fraction = ''] = Math.abs(value).toFixed(100).split('.')
  const kept = BigInt(whole + fraction.slice(0, digits))
  const rest = fraction.slice(digits)
  const first = rest[0] ?? '0'
  const up = first > '5' || (first === '5' && (/[1-9]/u.test(rest.slice(1)) || kept % 2n === 1n))
  return Math.sign(value || 1) * Number(kept + (up ? 1n : 0n)) / 10 ** digits
}

/** The nearest-rank percentile: the value at rank ⌈p·n⌉; null for no values. */
export function studioPercentile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.max(0, Math.ceil(percentile * ordered.length) - 1)] ?? null
}

/**
 * The bucket size for a window: `requested`, else 30 minutes up to 12 hours,
 * 60 up to 48 hours, a day beyond.
 * @returns undefined when the window would hold more than 500 buckets.
 */
export function studioBucketMinutes(startedAt: number, endedAt: number, requested?: number): number | undefined {
  const hours = (endedAt - startedAt) / HOUR_MS
  const minutes = requested ?? (hours <= 12 ? 30 : hours <= 48 ? 60 : 1440)
  return Math.ceil((endedAt - startedAt) / (minutes * MINUTE_MS)) > MAX_BUCKETS ? undefined : minutes
}

/** Python's string order, by code point, where `localeCompare` would follow a locale. */
function codePointOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function userOf(row: LyteboatTurnMetric): string | undefined {
  return row.owner === undefined || row.owner.id === '' ? undefined : `${row.owner.kind}:${row.owner.id}`
}

function skillsOf(row: LyteboatTurnMetric): string[] {
  return row.activatedSkills.length > 0 ? row.activatedSkills : row.activeSkill === undefined ? [] : [row.activeSkill]
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : studioRoundHalfEven(values.reduce((sum, value) => sum + value, 0) / values.length)
}

type ConcurrencyEvent = { time: number; start: boolean; user: string; run: string }

/** Each turn's span as a start and an end, clipped to the window, in time order (an end before a start at the same time). */
function concurrencyEvents(rows: readonly LyteboatTurnMetric[], startedAt?: number, endedAt?: number): ConcurrencyEvent[] {
  const events: ConcurrencyEvent[] = []
  for (const row of rows) {
    const user = userOf(row)
    if (user === undefined) continue
    const run = `${row.sessionId}:${String(row.turn)}`
    const start = startedAt === undefined ? row.startedAt : Math.max(row.startedAt, startedAt)
    const end = Math.min(row.startedAt + Math.max(row.durationMs, 1), endedAt ?? Infinity)
    if (start >= end) continue
    events.push({ time: start, start: true, user, run }, { time: end, start: false, user, run })
  }
  // The original sorts (time, kind, user, run) tuples with 0 for an end and 1 for a start, strings by code point.
  return events.sort((a, b) => a.time - b.time || Number(a.start) - Number(b.start) || codePointOrder(a.user, b.user) || codePointOrder(a.run, b.run))
}

function applyEvent(active: Map<string, Set<string>>, event: ConcurrencyEvent): void {
  if (event.start) {
    active.set(event.user, (active.get(event.user) ?? new Set()).add(event.run))
    return
  }
  const runs = active.get(event.user)
  runs?.delete(event.run)
  if (runs?.size === 0) active.delete(event.user)
}

function peakConcurrentUsers(rows: readonly LyteboatTurnMetric[]): number {
  const active = new Map<string, Set<string>>()
  let peak = 0
  for (const event of concurrencyEvents(rows)) {
    applyEvent(active, event)
    peak = Math.max(peak, active.size)
  }
  return peak
}

function bucketPeaks(rows: readonly LyteboatTurnMetric[], startedAt: number, endedAt: number, bucketMs: number): number[] {
  const events = concurrencyEvents(rows, startedAt, endedAt)
  const active = new Map<string, Set<string>>()
  const peaks: number[] = []
  let next = 0
  for (let index = 0; index < Math.ceil((endedAt - startedAt) / bucketMs); index++) {
    const bucketEnd = Math.min(startedAt + (index + 1) * bucketMs, endedAt)
    let peak = active.size
    for (; next < events.length && (events[next]?.time ?? Infinity) < bucketEnd; next++) {
      const event = events[next]
      if (event !== undefined) applyEvent(active, event)
      peak = Math.max(peak, active.size)
    }
    peaks.push(peak)
  }
  return peaks
}

/** The health of a set of turns. */
export function studioHealthAggregate(rows: readonly LyteboatTurnMetric[]): StudioHealthAggregate {
  const count = rows.length
  const tools = rows.flatMap(row => row.tools).filter(tool => tool.name !== SKILL_LOAD_TOOL)
  const toolDurations = tools.flatMap(tool => tool.durationMs === undefined ? [] : [Math.max(0, studioRoundHalfEven(tool.durationMs))])
  const durations = rows.map(row => row.durationMs)
  const steps = rows.map(row => row.steps)
  const firstContent = rows.map(row => row.firstContentMs)
  return {
    requestCount: count,
    completionRate: count === 0 ? 0 : rows.filter(row => row.outcome === 'completed' || row.outcome === 'tool_stopped').length / count,
    technicalFailureCount: rows.filter(row => row.outcome === 'errored' && row.errorCode !== 'session_busy').length,
    incompleteCount: rows.filter(row => row.outcome === 'stopped_by_limit').length,
    controlledExitCount: rows.filter(row => row.outcome === 'aborted' || row.outcome === 'rejected').length,
    contentionCount: rows.filter(row => row.errorCode === 'session_busy').length,
    firstContentP50Ms: studioPercentile(firstContent, 0.5),
    firstContentP95Ms: studioPercentile(firstContent, 0.95),
    durationP50Ms: studioPercentile(durations, 0.5),
    durationP95Ms: studioPercentile(durations, 0.95),
    averageDurationMs: average(durations),
    averageTurns: count === 0 ? 0 : studioRoundHalfEven(steps.reduce((sum, value) => sum + value, 0) / count, 2),
    turnsP95: studioPercentile(steps, 0.95),
    averageTurnDurationMs: average(rows.filter(row => row.steps > 0).map(row => row.durationMs / row.steps)),
    toolCallCount: tools.length,
    toolErrorCount: tools.filter(tool => tool.isError).length,
    averageToolDurationMs: average(toolDurations),
    skillTriggerCount: rows.reduce((sum, row) => sum + new Set(skillsOf(row)).size, 0),
    activeUsers: new Set(rows.flatMap(row => userOf(row) ?? [])).size,
    peakConcurrentUsers: peakConcurrentUsers(rows),
  }
}

function rankTools(rows: readonly LyteboatTurnMetric[]): StudioToolRanking[] {
  const counts = new Map<string, number>()
  const durations = new Map<string, number[]>()
  for (const tool of rows.flatMap(row => row.tools)) {
    if (tool.name === '' || tool.name === SKILL_LOAD_TOOL) continue
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
    if (tool.durationMs !== undefined) durations.set(tool.name, [...durations.get(tool.name) ?? [], Math.max(0, studioRoundHalfEven(tool.durationMs))])
  }
  return [...counts]
    .sort(([a, countA], [b, countB]) => countB - countA || codePointOrder(a, b))
    .slice(0, RANKING_LIMIT)
    .map(([name, count]) => ({ name, count, averageDurationMs: average(durations.get(name) ?? []) }))
}

function rankSkills(rows: readonly LyteboatTurnMetric[]): StudioSkillRanking[] {
  const steps = new Map<string, number[]>()
  for (const row of rows) {
    for (const skill of new Set(skillsOf(row))) {
      if (skill !== '') steps.set(skill, [...steps.get(skill) ?? [], row.steps])
    }
  }
  return [...steps]
    .sort(([a, stepsA], [b, stepsB]) => stepsB.length - stepsA.length || codePointOrder(a, b))
    .slice(0, RANKING_LIMIT)
    .map(([skillId, turns]) => ({ skillId, count: turns.length, averageTurns: studioRoundHalfEven(turns.reduce((sum, value) => sum + value, 0) / turns.length, 2) }))
}

/**
 * The health of a window: its summary, one point per bucket, and the rankings.
 * @param rows - the turns that started in the window.
 * @param bucketMinutes - from {@link studioBucketMinutes}.
 */
export function studioHealthWindow(rows: readonly LyteboatTurnMetric[], startedAt: number, endedAt: number, bucketMinutes: number): StudioHealthWindow {
  const bucketMs = bucketMinutes * MINUTE_MS
  const count = Math.ceil((endedAt - startedAt) / bucketMs)
  const buckets: LyteboatTurnMetric[][] = Array.from({ length: count }, () => [])
  for (const row of rows) {
    const index = Math.min(Math.floor((row.startedAt - startedAt) / bucketMs), count - 1)
    if (index >= 0) buckets[index]?.push(row)
  }
  const peaks = bucketPeaks(rows, startedAt, endedAt, bucketMs)
  const series: StudioHealthSeriesPoint[] = buckets.map((bucket, index) => ({
    ...studioHealthAggregate(bucket),
    peakConcurrentUsers: peaks[index] ?? 0,
    bucketIndex: index,
    startedAt: startedAt + index * bucketMs,
  }))
  return { startedAt, endedAt, bucketMinutes, summary: studioHealthAggregate(rows), series, toolRankings: rankTools(rows), skillRankings: rankSkills(rows) }
}
