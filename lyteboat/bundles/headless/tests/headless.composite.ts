import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { scriptedModelEnv } from '@lyteboat/testing/scripted-model'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headlessComposition, type RunTarget } from './support/headless-composition.ts'

const SUCCESS_TEXT = 'LYTEBOAT-RUN-COMPOSITE-OK'

/** The title provider's request would consume the scripted mock sequence. */
const NO_TITLE_LLM = [{ id: 'session-title-llm', disabled: true }]

describe('@lyteboat/headless composition (in process, mock model)', () => {
  const scratch = createLyteboatScratch('headless')
  let mock: MockLlmServer

  function fresh(label: string): RunTarget {
    const { home, workspace } = scratch.run(label)
    return { cwd: workspace, home, env: scriptedModelEnv(mock) }
  }

  beforeAll(async () => {
    mock = await startMockLlmServer({
      port: 0,
      apiKey: 'mock-key',
      sequence: ['tool_call_success', 'success', 'success'],
      repeatLast: true,
      toolName: 'read',
      toolArguments: JSON.stringify({ file_path: 'README.md' }),
      successText: SUCCESS_TEXT,
    })
  })

  afterAll(async () => {
    await mock.close()
    scratch.remove()
  })

  it('answers one task through the real tool path, prints the answer, and exits 0', async () => {
    const result = await headlessComposition(['read the readme and report'], fresh('answer'), NO_TITLE_LLM)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(SUCCESS_TEXT)
    const logs = findSessionLogs(result.home)
    expect(logs).toHaveLength(1)
    const types = eventTypes(readSessionLog(logs[0] ?? ''))
    expect(types.filter(type => type === 'step/start')).toHaveLength(2)
    expect(types).toContain('tool/result')
    expect(types.at(-1)).toBe('turn/end')
  })

  it('sends the model no session log: the kernel\'s dsh-base keeps its session-log upload off', async () => {
    const before = mock.requests.length
    const result = await headlessComposition(['read the readme and report'], fresh('no-upload'), NO_TITLE_LLM)
    expect(result.code, result.stderr).toBe(0)
    const sent = mock.requests.slice(before)
    expect(sent.length).toBeGreaterThan(0)
    for (const request of sent) expect(request.body).not.toHaveProperty('dsh_session_log')
    expect(eventTypes(readSessionLog(findSessionLogs(result.home)[0] ?? ''))).not.toContain('session-log-deepseek/delivery-accepted')
  })

  // Without a task the runner reads stdin, as dsh's one-shot does; a blank one is a usage error.
  it('rejects a blank task as a usage error without a model request', async () => {
    const before = mock.requests.length
    const result = await headlessComposition(['  '], fresh('no-task'))
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('a task is required')
    expect(mock.requests.length).toBe(before)
  })
})
