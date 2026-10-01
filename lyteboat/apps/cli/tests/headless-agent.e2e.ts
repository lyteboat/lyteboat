import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { lyteboatHeadlessResultSchema } from '@lyteboat/contracts/cli'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { runLyteboat } from './support/lyteboat-process.ts'

const SUCCESS_TEXT = 'LYTEBOAT-RUN-SMOKE-OK'
const ANNOUNCE_PLUGIN = fileURLToPath(new URL('./fixtures/plugins/announce.mjs', import.meta.url))
const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

/** dsh's harness identity, which the business base leaves out of the prompt. */
const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

/** A --patch overlay the smoke proves applied: it brings the harness identity back into the request. */
const IDENTITY_OVERLAY = '- id: system-prompt\n  config:\n    includeHarnessIdentity: true\n'

describe('lyteboat headless --agent (built bin, mock model)', () => {
  const scratch = createLyteboatScratch('run-smoke')
  let mock: MockLlmServer

  beforeAll(async () => {
    mock = await startMockLlmServer({
      port: 0,
      apiKey: 'mock-key',
      sequence: ['tool_call_success', 'success', 'success'],
      repeatLast: true,
      toolName: 'announce_status',
      toolArguments: '{}',
      successText: SUCCESS_TEXT,
    })
    writeFileSync(join(scratch.root, 'identity.patch.yml'), IDENTITY_OVERLAY)
  })

  afterAll(async () => {
    await mock.close()
    scratch.remove()
  })

  it('answers one task through the real tool path and persists the turn when a --plugin file and a --patch join the tree', async () => {
    const { home, workspace } = scratch.run('smoke')
    const result = await runLyteboat(
      ['headless', '--plugin', ANNOUNCE_PLUGIN, '--patch', join(scratch.root, 'identity.patch.yml'), '--agents', AGENTS, '--agent', 'echo', 'check the status and report'],
      { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(mock) } },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(SUCCESS_TEXT)
    // The plugin file's row was applied once, and no row failed to import or apply.
    expect(result.stderr.split('\n').filter(line => line === 'fixture-announce: applied')).toHaveLength(1)
    expect(result.stderr).not.toContain('did not activate')

    // The world, not the self-report: the persisted log carries the tool round trip.
    const logs = findSessionLogs(home)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/session\.v4\.jsonl\.zstd$/u)
    const records = readSessionLog(logs[0]!)
    expect(records[0]).toMatchObject({ type: 'session', version: 4 })
    const types = eventTypes(records)
    // The business base composes no permission or approval rows, so the session opens on the message.
    expect(types[0]).toBe('agent/inbox/spliced')
    expect(types.filter(type => type.startsWith('permission/') || type.startsWith('approval/'))).toEqual([])
    expect(types).toContain('turn/start')
    expect(types).toContain('request/header')
    expect(types.filter(type => type === 'step/start')).toHaveLength(2)
    expect(types).not.toContain('session/title-llm-request')
    expect(types.at(-1)).toBe('turn/end')
    const toolCall = records.find(record => record['type'] === 'tool/call') as { data: { name: string; arguments: string } } | undefined
    expect(toolCall?.data).toMatchObject({ name: 'announce_status', arguments: '{}' })
    const toolResult = records.find(record => record['type'] === 'tool/result') as { data: { message: { role: string; isError: boolean } } } | undefined
    expect(toolResult?.data.message).toMatchObject({ role: 'tool', isError: false })
    expect(JSON.stringify(toolResult)).toContain('fixture-announce: status ok')
    const turnEnd = records.at(-1) as { data: { reason: { kind: string } } }
    expect(turnEnd.data.reason.kind).toBe('completed')

    // Two model requests reached the mock: the tool-call step and the final answer, under the agent's persona and the patched identity.
    expect(mock.requests).toHaveLength(2)
    expect(JSON.stringify(mock.requests[0])).toContain('You are SERVE-SMOKE')
    expect(JSON.stringify(mock.requests[0])).toContain(HARNESS_IDENTITY)

    // The profile's plugins resolved through the installation's runtime resolution; nothing is linked into the profiles tree.
    expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
  })
})

describe('lyteboat headless --agent output and input (built bin, scripted model)', () => {
  const scratch = createLyteboatScratch('headless-result')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: 'RESULT-OK' })), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('prints the turn as one result object: outcome, text, cards, tools, model, and session id', async () => {
    const { home, workspace } = scratch.run('result')
    const run = await runLyteboat(['headless', '--agents', AGENTS, '--agent', 'echo', '--result', 'json', 'hello'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })

    expect(run.code, run.stderr).toBe(0)
    const result = lyteboatHeadlessResultSchema.parse(JSON.parse(run.stdout))
    expect(result).toMatchObject({ outcome: 'completed', text: 'RESULT-OK', cards: [], tools: [], model: { provider: expect.any(String), model: expect.any(String) } })
    expect(run.stderr).toContain(`lyteboat: session ${result.sessionId}`)
  })

  it('streams dsh\'s run events with --json: the session in the agent\'s working directory, then the turn as the final event', async () => {
    const { home, workspace } = scratch.run('json')
    const run = await runLyteboat(['headless', '--agents', AGENTS, '--agent', 'echo', '--json', 'hello'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })

    expect(run.code, run.stderr).toBe(0)
    const events = run.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; cwd?: string; text?: string })
    expect(events[0]).toMatchObject({ type: 'session', cwd: join(home, 'agent-workdirs', 'echo') })
    expect(events.at(-1)).toEqual({ type: 'final', text: 'RESULT-OK' })
    expect(run.stderr).not.toContain('lyteboat:')
  })

  it('reads the task from stdin when none is given', async () => {
    const { home, workspace } = scratch.run('stdin')
    const before = model.requests.length
    const run = await runLyteboat(['headless', '--agents', AGENTS, '--agent', 'echo'], { cwd: workspace, input: 'STDIN-TASK-PROBE', env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })

    expect(run.code, run.stderr).toBe(0)
    expect(run.stdout).toBe('RESULT-OK\n')
    expect(model.requests.slice(before).some(request => request.lastUser.includes('STDIN-TASK-PROBE'))).toBe(true)
  })

  it.each([
    [['--result', 'json'], '--json streams run events; it cannot be combined with --result json'],
    [['--bogus'], 'unknown option \'--bogus\''],
  ])('answers a --json usage error (%j) with dsh\'s error event and no model request', async (extra, message) => {
    const { home, workspace } = scratch.run(`json-usage${extra.join('')}`)
    const before = model.requests.length
    const run = await runLyteboat(['headless', '--agents', AGENTS, '--agent', 'echo', '--json', ...extra, 'hello'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })

    expect(run.code).toBe(1)
    expect(run.stdout.trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([{ type: 'error', message }])
    expect(run.stderr).not.toContain(message)
    expect(model.requests.length).toBe(before)
  })
})
