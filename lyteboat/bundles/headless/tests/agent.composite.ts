import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { FIXTURES, headlessComposition } from './support/headless-composition.ts'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'

const AGENTS = join(FIXTURES, 'agents')
const ANSWER = 'PRESET-RUN-OK'

describe('lyteboat headless --agents --agent (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('preset')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: ANSWER })), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('composes the named agent, records it in the session header, and stamps the task with its identity', async () => {
    const { home, workspace } = scratch.run('preset')
    const before = model.requests.length
    const result = await headlessComposition(['--agents', AGENTS, '--agent', 'minimal', 'hello'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(ANSWER)
    const loop = model.requests.slice(before).filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(loop[0]!.systemText).toContain('MINIMAL-PRESET-PERSONA')
    const [log] = findSessionLogs(home)
    const records = readSessionLog(log!)
    expect(records[0]).toMatchObject({ type: 'session', agentPreset: 'minimal' })
    const human = records.find(record => record['type'] === 'user/message') as { data: { source: unknown } } | undefined
    expect(human?.data.source).toEqual({ kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' }, agent: { id: 'minimal', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string } } })
    // A preset chosen at creation is recorded in the header; `agent-preset/selected`
    // is only logged for a switch made while the session was still blank.
    const types = eventTypes(records).filter(type => !type.startsWith('session/title'))
    expect(types).not.toContain('agent-preset/selected')
    expect(types.at(-1)).toBe('turn/end')
  })

  it('runs the business base alone without --agents', async () => {
    const { home, workspace } = scratch.run('plain')
    const before = model.requests.length
    const result = await headlessComposition(['hello'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(ANSWER)
    const loop = model.requests.slice(before).filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(loop[0]!.systemText).not.toContain('MINIMAL-PRESET-PERSONA')
    const [log] = findSessionLogs(home)
    const records = readSessionLog(log!)
    expect(records[0]).not.toHaveProperty('agentPreset')
    expect(eventTypes(records)).not.toContain('agent-preset/selected')
  })

  it('rejects an unknown agent and an agent without roots as usage errors', async () => {
    const { home, workspace } = scratch.run('errors')
    const unknown = await headlessComposition(['--agents', AGENTS, '--agent', 'nope', 'hello'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toMatch(/nope/u)
    const rootless = await headlessComposition(['--agent', 'minimal', 'hello'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(rootless.code).not.toBe(0)
    expect(rootless.stderr).toContain('--agents')
  })

  it('fails with the agent catalog\'s diagnosis when the agent does not mount', async () => {
    const { home, workspace } = scratch.run('unmountable')
    const before = model.requests.length
    const result = await headlessComposition(['--agents', AGENTS, '--agent', 'unmountable', 'hello'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('agent-catalog: 1 agent(s) failed')
    expect(result.stderr).toContain('@lyteboat/no-such-package')
    expect(model.requests.slice(before).filter(request => request.purpose === 'loop')).toHaveLength(0)
  })
})
