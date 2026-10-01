/**
 * `lyteboat headless --session-id` continues a stored session: dsh persistence
 * reopens the log, the next turn derives the earlier ones, and the routed
 * skill stays in force without its body being injected again. An id that does
 * not exist, a different agent, and `--history` are refused.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { printedSessionId } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { FIXTURES, headlessComposition, type RunTarget } from './support/headless-composition.ts'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testing/scripted-model'

const AGENTS = join(FIXTURES, 'agents')

describe('lyteboat headless --session-id (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('session')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle((request: RecordedRequest) => request.purpose === 'router'
      ? { text: JSON.stringify({ skill_id: 'asset-overview', reason: '看资产' }) }
      : { text: 'SESSION-OK' }), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  function fresh(label: string): RunTarget {
    const { home, workspace } = scratch.run(label)
    return { cwd: workspace, home, env: scriptedModelEnv(model) }
  }

  it('continues a routed session in place: the next turn derives the first and keeps the skill without injecting it again', async () => {
    const target = fresh('continue')
    const first = await headlessComposition(['--agents', AGENTS, '--agent', 'routed', '看看我的资产'], target)
    expect(first.code, first.stderr).toBe(0)
    const id = printedSessionId(first.stderr)
    const before = model.requests.length

    const second = await headlessComposition(['--agents', AGENTS, '--agent', 'routed', '--session-id', id, '那总额呢'], target)
    expect(second.code, second.stderr).toBe(0)
    expect(second.stdout).toContain('SESSION-OK')
    expect(printedSessionId(second.stderr)).toBe(id)
    const requests = model.requests.slice(before)
    expect(requests.filter(request => request.purpose === 'router')[0]?.lastUser).toContain('<current_active_skill>asset-overview</current_active_skill>')
    const loop = requests.filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(loop[0]!.toolNames).toContain('todo_write')
    const messages = JSON.stringify(loop[0]!.body.messages)
    expect(messages).toContain('看看我的资产')
    expect(messages.split('ASSET-OVERVIEW-BODY')).toHaveLength(2)
    const logs = findSessionLogs(target.home)
    expect(logs).toHaveLength(1)
    const types = eventTypes(readSessionLog(logs[0]!))
    expect(types.filter(type => type === 'turn/start')).toHaveLength(2)
    expect(types.at(-1)).toBe('turn/end')
  })

  it('refuses an id that does not exist, a different agent, and --history', async () => {
    const target = fresh('refused')
    const unknown = await headlessComposition(['--session-id', 'session-nope', 'hello'], target)
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain('session "session-nope" does not exist')

    const first = await headlessComposition(['--agents', AGENTS, '--agent', 'routed', '看看我的资产'], target)
    expect(first.code, first.stderr).toBe(0)
    const id = printedSessionId(first.stderr)
    const plain = await headlessComposition(['--session-id', id, 'hello'], target)
    expect(plain.code).not.toBe(0)
    expect(plain.stderr).toContain(`session "${id}" runs under agent preset "routed", which the one-shot runner does not compose`)

    const seeded = await headlessComposition(['--history', join(FIXTURES, 'history', 'rounds.json'), '--session-id', id, 'hello'], target)
    expect(seeded.code).not.toBe(0)
    expect(seeded.stderr).toContain('cannot be combined with --session-id')
    expect(eventTypes(readSessionLog(findSessionLogs(target.home)[0]!)).filter(type => type === 'turn/start')).toHaveLength(1)
  })
})
