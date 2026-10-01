/**
 * The request a task carries: `--context` (inline or a file) rides the human
 * message's source, a continued session keeps it, and an admission function
 * decides before the loop, its verdict and card recorded on the request and its
 * reply printed without a model request.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pluginFileRow, printedSessionId } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { FIXTURES, headlessComposition, type RunTarget } from './support/headless-composition.ts'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'

const ADMISSION = pluginFileRow(join(FIXTURES, 'plugins', 'admission.mjs'))

interface LogRecord { type: string; data?: Record<string, unknown> }

/** The sources of the human messages the stored log holds, in order. */
function humanSources(home: string): unknown[] {
  const records = readSessionLog(findSessionLogs(home)[0] ?? '') as unknown as LogRecord[]
  return records.filter(record => record.type === 'user/message').map(record => record.data?.['source']).filter(source => (source as { kind?: unknown }).kind === 'user')
}

describe('lyteboat headless --context and admission (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('request')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: 'REQUEST-OK' })), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  function fresh(label: string): RunTarget {
    const { home, workspace } = scratch.run(label)
    return { cwd: workspace, home, env: scriptedModelEnv(model) }
  }

  it('records the context on the human message, and a continued session without one keeps it', async () => {
    const target = fresh('context')
    const file = join(target.cwd, 'context.json')
    writeFileSync(file, JSON.stringify({ customer: 'c-2' }))

    const first = await headlessComposition(['--context', '{"customer":"c-1","channel":"app"}', 'hello'], target)
    expect(first.code, first.stderr).toBe(0)
    const id = printedSessionId(first.stderr)
    const second = await headlessComposition(['--session-id', id, 'again'], target)
    expect(second.code, second.stderr).toBe(0)
    const third = await headlessComposition(['--session-id', id, '--context', file, 'and again'], target)
    expect(third.code, third.stderr).toBe(0)

    expect(humanSources(target.home)).toEqual([
      { kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' }, context: { customer: 'c-1', channel: 'app' } } },
      { kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' } } },
      { kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' }, context: { customer: 'c-2' } } },
    ])
  })

  it('refuses a context that is not a JSON object', async () => {
    const target = fresh('bad-context')
    const result = await headlessComposition(['--context', '[1, 2]', 'hello'], target)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--context file not found')
    const inline = await headlessComposition(['--context', '{"broken"', 'hello'], target)
    expect(inline.code).not.toBe(0)
    expect(inline.stderr).toContain('--context is not JSON')
  })

  it('admits before the loop: a reply verdict and its card are recorded on the request, and printed without a model request', async () => {
    const target = fresh('admission')
    const before = model.requests.length
    const result = await headlessComposition(['--context', '{"channel":"本渠道"}', '帮我炒股'], target, [ADMISSION])
    expect(result.code, result.stderr).toBe(0)
    expect(model.requests.slice(before).filter(request => request.purpose === 'loop')).toEqual([])
    expect(result.stdout).toBe('[card scope]\n抱歉，本渠道不提供股票买卖建议。\n')
    expect(humanSources(target.home)).toEqual([{
      kind: 'user',
      lyteboatRequest: {
        owner: { kind: 'operator', id: 'cli' },
        context: { channel: '本渠道' },
        intake: { by: 'example-admission', decision: 'reply', verdict: 'out_of_scope', text: '抱歉，本渠道不提供股票买卖建议。', cards: [{ surfaceId: 'scope-card', area: 'scope', emission: 'immediate', payload: { rootComponentId: 'root' } }] },
      },
    }])
  })

  it('records a pass verdict and lets the model answer', async () => {
    const target = fresh('admitted')
    const result = await headlessComposition(['看看我的资产'], target, [ADMISSION])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe('REQUEST-OK\n')
    expect(humanSources(target.home)).toEqual([{ kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' }, intake: { by: 'example-admission', decision: 'pass' } } }])
  })
})
