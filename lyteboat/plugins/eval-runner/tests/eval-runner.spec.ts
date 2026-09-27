/**
 * The eval runner's parts that need no session: reading case files, checking
 * a turn, comparing two runs, rendering the report, and replaying a recorded
 * session's model calls.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LYTEBOAT_AUX_LLM_SOURCE } from '@lyteboat/contracts'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { loadEvalCases } from '../src/eval-case.ts'
import { checkTurn, type EvalObservation } from '../src/eval-check.ts'
import { EvalReplay } from '../src/eval-replay.ts'
import { compareEvalResults, renderEvalReport, writeEvalRun, type EvalRunRecord, type EvalTurnResult } from '../src/eval-report.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const RECORDED = join(FIXTURES, 'recorded', 'session.v4.jsonl')

const observed: EvalObservation = { skill: 'lookup', tools: ['lookup'], cards: ['summary'], outcome: 'completed', text: 'All OK here.', modelRequests: 2 }

function result(evalCase: string, turn: number, checks: [string, boolean][]): EvalTurnResult {
  return { case: evalCase, turn, message: 'm', observed, checks: checks.map(([check, pass]) => ({ check, expected: null, actual: null, pass })), pass: checks.every(([, pass]) => pass) }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** A call as the agent loop or a side call makes it; only the session and the first message's source matter to the replay. */
function call(sessionId: string, side: boolean): GenerateOptions {
  const source = side ? { kind: LYTEBOAT_AUX_LLM_SOURCE } : { kind: 'user' }
  // A request built by hand for the listener; the replay reads only these fields.
  return { provider: 'deepseek-official', model: 'recorded-model', sessionId, messages: [{ role: 'user', id: 'm-1', content: [{ type: 'text', text: 'hi' }], source }] } as unknown as GenerateOptions
}

describe('loadEvalCases', () => {
  it('reads a directory\'s case files in name order, with an empty expectation by default', () => {
    const cases = loadEvalCases([join(FIXTURES, 'cases', 'valid')])

    expect(cases.map(evalCase => evalCase.id)).toEqual(['greeting', 'tool-use'])
    expect(cases[0]).toEqual({
      id: 'greeting',
      context: { channel: 'app' },
      turns: [
        { message: 'hello', expect: { outcome: 'completed', text: { includes: ['OK'] } } },
        { message: 'again', context: { channel: 'web' }, expect: {} },
      ],
    })
  })

  it('refuses an unknown key, a regular expression that does not compile, and an id that is not kebab-case, naming the file', () => {
    const invalid = (name: string): () => unknown => () => loadEvalCases([join(FIXTURES, 'cases', 'invalid', name)])

    expect(invalid('unknown-key.yml')).toThrow(/unknown-key\.yml: cases\.0\.turns\.0\.expect: Unrecognized key: "outcomes"/u)
    expect(invalid('bad-regex.yml')).toThrow(/bad-regex\.yml: cases\.0\.turns\.0\.expect\.text\.matches: is not a regular expression/u)
    expect(invalid('not-kebab.yml')).toThrow(/not-kebab\.yml: cases\.0\.id: must be kebab-case/u)
  })

  it('refuses a case id two files share, and a path that does not exist', () => {
    const file = join(FIXTURES, 'cases', 'valid', 'a-greeting.yml')

    expect(() => loadEvalCases([file, file])).toThrow(`eval-runner: case "greeting" is in both ${file} and ${file}`)
    expect(() => loadEvalCases([join(FIXTURES, 'missing')])).toThrow('eval-runner: no case file or directory at')
  })
})

describe('checkTurn', () => {
  it('makes one check per expectation, each with what was expected and what the turn showed', () => {
    const checks = checkTurn({
      skill: 'lookup',
      tools: { called: ['lookup'], not_called: ['write'] },
      cards: { areas: ['summary'], count: 1 },
      outcome: 'completed',
      text: { includes: ['OK'], excludes: ['error'], matches: '^All' },
      model_requests: { max: 2 },
    }, observed)

    expect(checks.map(check => [check.check, check.pass])).toEqual([
      ['skill', true], ['tools.called', true], ['tools.not_called', true], ['cards.areas', true], ['cards.count', true],
      ['outcome', true], ['text.includes', true], ['text.excludes', true], ['text.matches', true], ['model_requests', true],
    ])
    expect(checks.at(-1)).toEqual({ check: 'model_requests', expected: { max: 2 }, actual: 2, pass: true })
  })

  it('checks the cards a turn shows in any order, each as often as expected', () => {
    const twoCards = { ...observed, cards: ['plan', 'summary'] }

    expect(checkTurn({ cards: { areas: ['summary', 'plan'] } }, twoCards)[0]?.pass).toBe(true)
    expect(checkTurn({ cards: { areas: ['summary', 'summary'] } }, twoCards)[0]?.pass).toBe(false)
  })

  it('fails a check the turn does not meet, and makes none the case leaves out', () => {
    const checks = checkTurn({ skill: null, cards: { areas: ['summary', 'detail'] }, text: { excludes: ['OK'] }, model_requests: { min: 3 } }, observed)

    expect(checks.map(check => [check.check, check.pass])).toEqual([['skill', false], ['cards.areas', false], ['text.excludes', false], ['model_requests', false]])
    expect(checks[1]).toEqual({ check: 'cards.areas', expected: ['summary', 'detail'], actual: ['summary'], pass: false })
  })
})

describe('eval runs on disk', () => {
  it('compares two runs check by check: a regression, a fix, a check only one run made', () => {
    const before = [result('a', 1, [['outcome', true], ['skill', false]]), result('b', 1, [['outcome', true]])]
    const after = [result('a', 1, [['outcome', false], ['skill', true], ['text.includes', true]]), result('b', 1, [['outcome', true]])]

    expect(compareEvalResults(before, after)).toEqual([
      { case: 'a', turn: 1, check: 'outcome', before: 'pass', after: 'fail' },
      { case: 'a', turn: 1, check: 'skill', before: 'fail', after: 'pass' },
      { case: 'a', turn: 1, check: 'text.includes', before: 'absent', after: 'pass' },
    ])
  })

  it('writes the run, one results line per turn, and a report that says why each failed check failed', () => {
    const dir = lyteboatTempDir('eval-run')
    const failing = { ...result('a', 1, [['outcome', true]]), checks: [{ check: 'cards.count', expected: 2, actual: 1, pass: false }], pass: false }
    const run: EvalRunRecord = { agent: { id: 'demo', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` }, mode: 'replay', from: '/runs/base', cases: [{ id: 'a', pass: false }], turns: { total: 1, passed: 0 }, checks: { total: 1, passed: 0 }, startedAt: '2026-09-25T00:00:00.000Z', durationMs: 1200 }

    writeEvalRun(dir, run, [failing])

    expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))).toEqual(run)
    expect(readFileSync(join(dir, 'results.jsonl'), 'utf8')).toBe(`${JSON.stringify(failing)}\n`)
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe(renderEvalReport(run, [failing]))
    expect(renderEvalReport(run, [failing])).toContain('# Eval demo: 0/1 cases passed\n\n- mode: replay (from /runs/base)')
    expect(renderEvalReport(run, [failing])).toContain('### a, turn 1: m\n\n- `cards.count`: expected 2, got 1\n')
  })
})

describe('EvalReplay', () => {
  it('answers a bound session\'s side calls from its records and its loop calls from its assistant messages, in order', async () => {
    const replay = new EvalReplay()
    replay.bind('live-1', RECORDED)

    const router = await collect(replay.stream(call('live-1', true)))
    const intake = await collect(replay.stream(call('live-1', true)))
    const loop = await collect(replay.stream(call('live-1', false)))

    expect(router.filter(chunk => chunk.type === 'text-delta')).toEqual([{ type: 'text-delta', index: 0, text: '{"skill_id":null}' }])
    expect(intake).toEqual([{ type: 'finish', reason: { kind: 'max-tokens' } }])
    expect(loop.map(chunk => chunk.type === 'text-delta' ? chunk.text : '').join('')).toBe('RECORDED')
    expect(loop.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('fails a call past the recording, and a call from a session no case replays', async () => {
    const replay = new EvalReplay()
    replay.bind('live-1', RECORDED)
    await collect(replay.stream(call('live-1', false)))

    await expect(collect(replay.stream(call('live-1', false)))).rejects.toThrow('recorded 1 loop call(s); the replay asked for call 2')
    await expect(collect(replay.stream(call('live-2', false)))).rejects.toThrow('eval-runner: a model call from session live-2, which no recorded case replays')
    expect(() => { replay.bind('live-3', join(FIXTURES, 'recorded', 'missing.jsonl')) }).toThrow('eval-runner: no recorded session at')
  })
})
