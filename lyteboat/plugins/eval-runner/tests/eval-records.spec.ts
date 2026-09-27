/**
 * The eval records the Studio reads: the run directories with their
 * `run.json`, one run with its results, the checks that changed between two
 * runs, an agent's case files one by one, and removing a run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LyteboatEvalRunRecord } from '@lyteboat/contracts'
import EvalRecordsService from '@lyteboat/eval-runner/records'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import type { EvalTurnResult } from '../src/eval-report.ts'

const RECORD: LyteboatEvalRunRecord = {
  agent: { id: 'teller', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }, mode: 'real',
  cases: [{ id: 'hello', pass: true }], turns: { total: 1, passed: 1 }, checks: { total: 1, passed: 1 },
  startedAt: '2026-09-26T00:00:00.000Z', durationMs: 1000,
}

function result(pass: boolean): EvalTurnResult {
  return {
    case: 'hello', turn: 1, message: 'hi',
    observed: { skill: null, tools: [], cards: [], outcome: pass ? 'completed' : 'errored', text: 'OK', modelRequests: 1 },
    checks: [{ check: 'outcome', expected: 'completed', actual: pass ? 'completed' : 'errored', pass }],
    pass,
  }
}

function writeRun(evalsDir: string, runId: string, parts: { record?: unknown; results?: EvalTurnResult[] }): void {
  mkdirSync(join(evalsDir, runId), { recursive: true })
  if (parts.record !== undefined) writeFileSync(join(evalsDir, runId, 'run.json'), JSON.stringify(parts.record))
  if (parts.results !== undefined) writeFileSync(join(evalsDir, runId, 'results.jsonl'), parts.results.map(line => JSON.stringify(line)).join('\n') + '\n')
}

async function recordsOf(dir: string): Promise<Context> {
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  await ctx.plugin(EvalRecordsService, { dir })
  return ctx
}

describe('the eval records', () => {
  it('lists the run directories with the run.json each has, and none before any run', async () => {
    const evalsDir = join(lyteboatTempDir('eval-records'), 'evals')
    const ctx = await recordsOf(evalsDir)
    expect(ctx.evalRecords.runs()).toEqual([])
    writeRun(evalsDir, 'done-1', { record: RECORD, results: [result(true)] })
    writeRun(evalsDir, 'running-2', {})
    writeRun(evalsDir, 'old-3', { record: { name: 'an older format' } })
    mkdirSync(join(evalsDir, '.hidden'))

    const runs = ctx.evalRecords.runs().sort((a, b) => a.runId.localeCompare(b.runId))

    expect(runs.map(run => [run.runId, run.record?.agent.id])).toEqual([['done-1', 'teller'], ['old-3', undefined], ['running-2', undefined]])
    expect(runs[0]?.modifiedAt).toEqual(expect.any(Number))
  })

  it('reads one run with its results, compares two, and removes one; an id that is not a run names none', async () => {
    const evalsDir = join(lyteboatTempDir('eval-records'), 'evals')
    writeRun(evalsDir, 'before', { record: RECORD, results: [result(true)] })
    writeRun(evalsDir, 'after', { record: RECORD, results: [result(false)] })
    writeRun(evalsDir, 'written-later', { record: RECORD })
    const ctx = await recordsOf(evalsDir)

    expect(ctx.evalRecords.run('before')).toMatchObject({ runId: 'before', record: { mode: 'real' }, results: [{ case: 'hello', pass: true }] })
    expect(ctx.evalRecords.run('written-later')?.results).toEqual([])
    expect(ctx.evalRecords.compare('before', 'after')).toEqual([{ case: 'hello', turn: 1, check: 'outcome', before: 'pass', after: 'fail' }])
    expect(ctx.evalRecords.run('../before')).toBeUndefined()
    expect(ctx.evalRecords.remove('after')).toBe(true)
    expect(existsSync(join(evalsDir, 'after'))).toBe(false)
    expect(ctx.evalRecords.remove('after')).toBe(false)
  })

  it('reads an agent\'s case files one by one, each that does not load with why', async () => {
    const agentDir = lyteboatTempDir('eval-records')
    mkdirSync(join(agentDir, 'evals'))
    writeFileSync(join(agentDir, 'evals', 'a.yml'), 'cases:\n  - id: hello\n    turns:\n      - message: hi\n        expect: { outcome: completed }\n')
    writeFileSync(join(agentDir, 'evals', 'b.yml'), 'cases:\n  - id: Bad_Id\n    turns:\n      - message: hi\n')
    writeFileSync(join(agentDir, 'evals', 'c.yml'), 'cases:\n  - id: hello\n    turns:\n      - message: again\n')
    const ctx = await recordsOf(join(lyteboatTempDir('eval-records'), 'evals'))

    const files = ctx.evalRecords.cases(agentDir)

    expect(files.map(file => [file.file.slice(agentDir.length), file.cases.map(evalCase => evalCase.id)])).toEqual([['/evals/a.yml', ['hello']], ['/evals/b.yml', []], ['/evals/c.yml', ['hello']]])
    expect(files[0]?.error).toBeUndefined()
    expect(files[0]?.cases[0]?.turns[0]?.expect).toEqual({ outcome: 'completed' })
    expect(files[1]?.error).toContain('must be kebab-case')
    expect(files[2]?.error).toContain('case "hello" is in an earlier file too')
    expect(ctx.evalRecords.cases(lyteboatTempDir('eval-records'))).toEqual([])
  })
})
