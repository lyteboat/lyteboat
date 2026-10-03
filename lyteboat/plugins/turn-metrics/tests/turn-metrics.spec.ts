/**
 * The turn-metrics recorder at the agent loop's seams, and its reader: one
 * line per turn in the UTC day's file, the heartbeat of the running turns,
 * the turns that are left out, a recorder that cannot write, retention, and
 * what the reader answers from the files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { LyteboatTurnHeartbeat, LyteboatTurnMetric } from '@lyteboat/contracts'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait as send, textResponse, toolCallResponse } from '@lyteboat/testkit'
import { readJsonLines } from '@lyteboat/testkit/json-lines'
import TurnMetricsRecorder from '@lyteboat/turn-metrics'
import TurnMetricsReaderService from '@lyteboat/turn-metrics/reader'
import { lyteboatTempDir } from '@lyteboat/testkit/scratch'
import TurnOutcomeService from '@lyteboat/turn-outcome'
import { turnMetricDayOf } from '../src/turn-metric-files.ts'

async function recorderHost(adapter: MockAdapter, dir: string): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(TurnOutcomeService)
  await ctx.plugin(TurnMetricsRecorder, { dir, heartbeatMs: 60_000 })
  for (const name of ['lookup', 'skill']) {
    ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {}, execute: async () => [{ type: 'text', text: `${name} ran` }] }))
  }
  return ctx
}

/** An agent the way a preset registry makes one: its session header names the preset. */
function agentOf(ctx: Context, id: string, agentPreset?: string): Promise<Agent> {
  // The loop's create takes only `cwd` in its type; the session store keeps the preset id it is given, as the registry's does.
  const meta = { ...agentPreset === undefined ? {} : { agentPreset } } as { cwd?: string }
  return ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, meta)
}

function metricLines(dir: string): LyteboatTurnMetric[] {
  const file = join(dir, `${turnMetricDayOf(Date.now())}.jsonl`)
  return existsSync(file) ? readJsonLines<LyteboatTurnMetric>(file) : []
}

function heartbeatOf(dir: string): LyteboatTurnHeartbeat | undefined {
  const file = join(dir, 'running', `${hostname()}-${String(process.pid)}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as LyteboatTurnHeartbeat : undefined
}

describe('the turn-metrics recorder', () => {
  it('appends one line per turn with its steps, model requests, tools without the skill load, and outcome', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    const adapter = new MockAdapter([toolCallResponse('c1', 'skill', {}), toolCallResponse('c2', 'lookup', {}), textResponse('done')])
    const ctx = await recorderHost(adapter, dir)
    const agent = await agentOf(ctx, 'one', 'alpha')

    await send(agent, 'hello')

    await vi.waitFor(() => { expect(metricLines(dir)).toHaveLength(1) })
    const [metric] = metricLines(dir)
    expect(metric).toMatchObject({
      agentId: 'alpha', sessionId: 'one', turn: 1, steps: 3, modelRequests: 3, auxCalls: 0,
      tools: [{ name: 'lookup', isError: false, durationMs: expect.any(Number) }],
      activatedSkills: [], outcome: 'completed',
    })
    expect(metric?.firstContentMs).toBeLessThanOrEqual(metric?.durationMs ?? -1)
    expect(metric).not.toHaveProperty('owner')
  })

  it('lists a held turn in the heartbeat, and records it aborted when it is cancelled', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    const ctx = await recorderHost(new MockAdapter(['hang']), dir)
    const agent = await agentOf(ctx, 'held', 'alpha')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'wait' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(heartbeatOf(dir)?.turns).toEqual([expect.objectContaining({ agentId: 'alpha', sessionId: 'held', turn: 1 })]) })
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    await vi.waitFor(() => { expect(metricLines(dir).map(metric => metric.outcome)).toEqual(['aborted']) })
    await vi.waitFor(() => { expect(heartbeatOf(dir)?.turns).toEqual([]) })
  })

  it('leaves out a session no preset composed', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    const ctx = await recorderHost(new MockAdapter([textResponse('hi')]), dir)
    const agent = await agentOf(ctx, 'bare')

    await send(agent, 'hello')

    await vi.waitFor(() => { expect(heartbeatOf(dir)).toBeDefined() })
    expect(metricLines(dir)).toEqual([])
  })

  it('lets the turn finish when the metrics cannot be written, and says why', async () => {
    const blocked = join(lyteboatTempDir('turn-metrics'), 'not-a-directory')
    writeFileSync(blocked, 'a file where the directory should be')
    const adapter = new MockAdapter([textResponse('still answered')])
    const ctx = await recorderHost(adapter, blocked)
    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
    const agent = await agentOf(ctx, 'blocked', 'alpha')

    await send(agent, 'hello')

    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
    await vi.waitFor(() => { expect(warnings.some(message => message.startsWith('lyteboat turn metrics:'))).toBe(true) })
  })

  it('removes day files older than the retention when it starts', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    mkdirSync(dir, { recursive: true })
    const old = turnMetricDayOf(Date.now() - 91 * 86_400_000)
    const kept = turnMetricDayOf(Date.now() - 89 * 86_400_000)
    writeFileSync(join(dir, `${old}.jsonl`), '')
    writeFileSync(join(dir, `${kept}.jsonl`), '')
    writeFileSync(join(dir, 'notes.txt'), '')

    await recorderHost(new MockAdapter([]), dir)

    await vi.waitFor(() => { expect(existsSync(join(dir, `${old}.jsonl`))).toBe(false) })
    expect(existsSync(join(dir, `${kept}.jsonl`))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })
})

describe('the turn-metrics reader', () => {
  const DAY = 86_400_000
  const T = Date.UTC(2026, 8, 20, 23, 0)
  const metric = (agentId: string, startedAt: number): LyteboatTurnMetric => ({
    agentId, sessionId: `s-${String(startedAt)}`, turn: 1, startedAt, durationMs: 100, firstContentMs: 50,
    steps: 1, modelRequests: 1, auxCalls: 0, tools: [], activatedSkills: [], outcome: 'completed',
  })

  async function readerOf(dir: string): Promise<Context> {
    const ctx = await createLyteboatUnitHost(new MockAdapter([]))
    await ctx.plugin(TurnMetricsReaderService, { dir })
    return ctx
  }

  it('refuses a config its schema rejects instead of reading from it', async () => {
    const ctx = await createLyteboatUnitHost(new MockAdapter([]))
    await expect(ctx.plugin(TurnMetricsReaderService, { dir: 42 } as never)).rejects.toThrow(/dir/u)
  })

  it('answers the turns of a range across day files, of one agent or all, skipping lines that are not metrics', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    writeFileSync(join(dir, `${turnMetricDayOf(T)}.jsonl`), `${JSON.stringify(metric('alpha', T))}\nnot json\n${JSON.stringify({ agentId: 'x' })}\n`)
    writeFileSync(join(dir, `${turnMetricDayOf(T + DAY)}.jsonl`), `${JSON.stringify(metric('beta', T + 2 * 3_600_000))}\n${JSON.stringify(metric('alpha', T + DAY + 1))}\n`)
    const ctx = await readerOf(dir)

    const all = await ctx.turnMetricsReader.records(T, T + DAY)
    const alpha = await ctx.turnMetricsReader.records(T, T + 2 * DAY, 'alpha')
    const later = await ctx.turnMetricsReader.records(T + 1, T + DAY)

    expect(all.map(row => row.agentId)).toEqual(['alpha', 'beta'])
    expect(alpha.map(row => row.startedAt)).toEqual([T, T + DAY + 1])
    expect(later.map(row => row.agentId)).toEqual(['beta'])
  })

  it('refuses a Config its schema refuses', async () => {
    const ctx = await createLyteboatUnitHost(new MockAdapter([]))

    await expect(ctx.plugin(TurnMetricsReaderService, { dir: 42 } as unknown as { dir: string })).rejects.toThrow('expected string but got 42')
  })

  it('reads a day file again once it changes', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    const file = join(dir, `${turnMetricDayOf(T)}.jsonl`)
    writeFileSync(file, `${JSON.stringify(metric('alpha', T))}\n`)
    const ctx = await readerOf(dir)
    expect(await ctx.turnMetricsReader.records(T, T + 1_000)).toHaveLength(1)

    writeFileSync(file, `${JSON.stringify(metric('alpha', T))}\n${JSON.stringify(metric('alpha', T + 1))}\n`)

    expect(await ctx.turnMetricsReader.records(T, T + 1_000)).toHaveLength(2)
  })

  it('answers the running turns of heartbeats from the last 30 seconds only, and none before any serve ran', async () => {
    const dir = lyteboatTempDir('turn-metrics')
    const ctx = await readerOf(dir)
    expect(await ctx.turnMetricsReader.running()).toEqual([])
    mkdirSync(join(dir, 'running'))
    const now = Date.now()
    const turn = { agentId: 'alpha', sessionId: 's-1', turn: 2, startedAt: now - 5_000 }
    writeFileSync(join(dir, 'running', 'h1-1.json'), JSON.stringify({ host: 'h1', pid: 1, heartbeatAt: now - 1_000, turns: [turn] }))
    writeFileSync(join(dir, 'running', 'h2-2.json'), JSON.stringify({ host: 'h2', pid: 2, heartbeatAt: now - 31_000, turns: [{ ...turn, sessionId: 's-2' }] }))
    writeFileSync(join(dir, 'running', 'broken.json'), '{')

    expect(await ctx.turnMetricsReader.running(now)).toEqual([{ ...turn, host: 'h1', pid: 1 }])
  })
})
