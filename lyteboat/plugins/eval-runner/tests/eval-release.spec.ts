/**
 * The release gate over files on disk, with the baseline's replay stubbed: it
 * writes a deterministic lock for an agent whose baseline is a real run of it
 * on its declared model and replays unchanged, and names the step that
 * refuses anything else.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentCatalogEntry } from '@lyteboat/agent-catalog'
import type { LyteboatAgentIdentity, LyteboatEvalRunRecord } from '@lyteboat/contracts'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { releaseAgent, type EvalBaselineReplay } from '../src/eval-release.ts'
import type { EvalTurnResult } from '../src/eval-report.ts'

const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`
const IDENTITY: LyteboatAgentIdentity = { id: 'teller', version: '1.0.0', digest: DIGEST }
const MODEL = { provider: 'deepseek-official', model: 'deepseek-flash' }

const RESULT: EvalTurnResult = {
  case: 'hello', turn: 1, message: 'hi',
  observed: { skill: null, tools: [], cards: [], outcome: 'completed', text: 'OK', modelRequests: 1 },
  checks: [{ check: 'outcome', expected: 'completed', actual: 'completed', pass: true }],
  pass: true,
}

const RECORD: LyteboatEvalRunRecord = {
  agent: IDENTITY, model: MODEL, mode: 'real',
  cases: [{ id: 'hello', pass: true }], turns: { total: 1, passed: 1 }, checks: { total: 1, passed: 1 },
  startedAt: '2026-09-26T00:00:00.000Z', durationMs: 1000,
}

interface BaselineParts {
  record?: Partial<LyteboatEvalRunRecord>
  stamp?: LyteboatAgentIdentity
  headerModel?: string
}

/** An agent directory whose `evals/baseline` records the case `hello` as the parts say (by default: a real run of IDENTITY on MODEL). */
function agentWithBaseline(parts: BaselineParts = {}): AgentCatalogEntry {
  const dir = lyteboatTempDir('eval-release')
  const baseline = join(dir, 'evals', 'baseline')
  mkdirSync(join(baseline, 'sessions', 'hello'), { recursive: true })
  writeFileSync(join(baseline, 'run.json'), JSON.stringify({ ...RECORD, ...parts.record }, null, 2) + '\n')
  writeFileSync(join(baseline, 'results.jsonl'), JSON.stringify(RESULT) + '\n')
  const events = [
    { type: 'session-header' },
    { type: 'user/message', data: { content: [], source: { kind: 'user', lyteboatRequest: { agent: parts.stamp ?? IDENTITY } } } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: parts.headerModel ?? 'deepseek-flash' } } } },
  ]
  writeFileSync(join(baseline, 'sessions', 'hello', 'session.v4.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  return { id: 'teller', dir, workdir: join(dir, 'work'), identity: IDENTITY, files: { 'agent.cordis.yml': 'c'.repeat(64), 'agent.yml': 'd'.repeat(64) }, model: MODEL }
}

/** A replay that shows what the baseline recorded, or the given results. */
function replaying(results: EvalTurnResult[] = [RESULT], cases = [{ id: 'hello', pass: true }]): EvalBaselineReplay {
  return () => Promise.resolve({ record: { ...RECORD, mode: 'replay', cases }, results })
}

describe('releaseAgent', () => {
  it('writes the lock with its keys in a fixed order, and the same bytes when released again', async () => {
    const agent = agentWithBaseline()

    const first = await releaseAgent(agent, '0.1.7-rc.2', replaying())
    const bytes = readFileSync(join(agent.dir, 'agent.release.json'), 'utf8')
    const again = await releaseAgent(agent, '0.1.7-rc.2', replaying())

    expect(first).toMatchObject({ released: true, file: join(agent.dir, 'agent.release.json') })
    expect(Object.keys(JSON.parse(bytes) as object)).toEqual(['agent', 'model', 'dshBase', 'files', 'baseline'])
    expect(JSON.parse(bytes)).toEqual({
      agent: IDENTITY,
      model: MODEL,
      dshBase: '0.1.7-rc.2',
      files: agent.files,
      baseline: { startedAt: RECORD.startedAt, cases: 1, turns: 1, checks: 1, results: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string },
    })
    expect(bytes.endsWith('}\n')).toBe(true)
    expect(again.released).toBe(true)
    expect(readFileSync(join(agent.dir, 'agent.release.json'), 'utf8')).toBe(bytes)
  })

  it('reads a baseline checked out with CRLF line endings as its LF form, and writes the same lock', async () => {
    const lf = agentWithBaseline()
    const crlf = agentWithBaseline()
    const baseline = join(crlf.dir, 'evals', 'baseline')
    for (const file of [join(baseline, 'run.json'), join(baseline, 'results.jsonl'), join(baseline, 'sessions', 'hello', 'session.v4.jsonl')]) {
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'))
    }

    await releaseAgent(lf, '0.1.7-rc.2', replaying())
    const outcome = await releaseAgent(crlf, '0.1.7-rc.2', replaying())

    expect(outcome.released).toBe(true)
    expect(readFileSync(join(crlf.dir, 'agent.release.json'), 'utf8')).toBe(readFileSync(join(lf.dir, 'agent.release.json'), 'utf8'))
  })

  it('refuses an agent whose manifest declares no version or no model', async () => {
    const agent = agentWithBaseline()
    const { model: _model, ...modelless } = agent

    const unversioned = await releaseAgent({ ...agent, identity: { id: 'teller', digest: DIGEST } }, '0.1.7', replaying())
    const unmodelled = await releaseAgent(modelless, '0.1.7', replaying())

    expect(unversioned).toEqual({ released: false, step: 'manifest', reason: `${join(agent.dir, 'agent.yml')} must declare a version and a model to be released` })
    expect(unmodelled).toMatchObject({ released: false, step: 'manifest' })
    expect(existsSync(join(agent.dir, 'agent.release.json'))).toBe(false)
  })

  it('refuses a baseline that is a replay', async () => {
    const outcome = await releaseAgent(agentWithBaseline({ record: { mode: 'replay' } }), '0.1.7', replaying())

    expect(outcome).toMatchObject({ released: false, step: 'baseline', reason: expect.stringContaining('is a replay; a release baseline must be a real run') as string })
  })

  it('refuses a baseline whose requests went to another version of the agent', async () => {
    const outcome = await releaseAgent(agentWithBaseline({ stamp: { ...IDENTITY, digest: OTHER_DIGEST } }), '0.1.7', replaying())

    expect(outcome).toMatchObject({ released: false, step: 'stamps', reason: expect.stringContaining(`a request went to teller 1.0.0 (${OTHER_DIGEST}), but the agent is now teller 1.0.0 (${DIGEST})`) as string })
  })

  it('refuses a baseline whose requests used another model than the declared one', async () => {
    const outcome = await releaseAgent(agentWithBaseline({ headerModel: 'deepseek-pro' }), '0.1.7', replaying())

    expect(outcome).toMatchObject({ released: false, step: 'model', reason: expect.stringContaining('a request used deepseek-official/deepseek-pro, but agent.yml declares deepseek-official/deepseek-flash') as string })
  })

  it('refuses when the replay shows a turn differently from the baseline, or fails a case', async () => {
    const differs = await releaseAgent(agentWithBaseline(), '0.1.7', replaying([{ ...RESULT, observed: { ...RESULT.observed, text: 'changed' } }]))
    const fails = await releaseAgent(agentWithBaseline(), '0.1.7', replaying([RESULT], [{ id: 'hello', pass: false }]))

    expect(differs).toEqual({ released: false, step: 'replay', reason: 'replaying the baseline, case hello turn 1 no longer shows what the baseline recorded' })
    expect(fails).toEqual({ released: false, step: 'replay', reason: 'the baseline fails case(s) hello; a release needs every case to pass' })
  })

  it('refuses a replay that runs other cases than the baseline recorded', async () => {
    const outcome = await releaseAgent(agentWithBaseline(), '0.1.7', replaying([RESULT], [{ id: 'hello', pass: true }, { id: 'unrecorded', pass: true }]))

    expect(outcome).toEqual({ released: false, step: 'replay', reason: 'the agent\'s cases are now hello, unrecorded, but the baseline ran hello; record the baseline again' })
  })

  it('refuses a baseline without results.jsonl, or with a recording line that is not JSON, naming the file', async () => {
    const noResults = agentWithBaseline()
    rmSync(join(noResults.dir, 'evals', 'baseline', 'results.jsonl'))
    const torn = agentWithBaseline()
    const recording = join(torn.dir, 'evals', 'baseline', 'sessions', 'hello', 'session.v4.jsonl')
    writeFileSync(recording, `${readFileSync(recording, 'utf8')}{"type":\n`)

    const missing = await releaseAgent(noResults, '0.1.7', replaying())
    const broken = await releaseAgent(torn, '0.1.7', replaying())

    expect(missing).toMatchObject({ released: false, step: 'baseline', reason: expect.stringContaining('the baseline has no results.jsonl') as string })
    expect(broken).toMatchObject({ released: false, step: 'baseline', reason: expect.stringContaining(`${recording}: line 4 is not JSON`) as string })
  })

  it('refuses to release a version an earlier lock released with other content', async () => {
    const agent = agentWithBaseline()
    writeFileSync(join(agent.dir, 'agent.release.json'), JSON.stringify({ agent: { ...IDENTITY, digest: OTHER_DIGEST }, model: MODEL, dshBase: '0.1.7', files: {}, baseline: { startedAt: '', cases: 0, turns: 0, checks: 0, results: DIGEST } }))

    const outcome = await releaseAgent(agent, '0.1.7', replaying())

    expect(outcome).toEqual({ released: false, step: 'version', reason: `${join(agent.dir, 'agent.release.json')} already releases teller 1.0.0 as ${OTHER_DIGEST}; raise the version in agent.yml` })
  })
})
