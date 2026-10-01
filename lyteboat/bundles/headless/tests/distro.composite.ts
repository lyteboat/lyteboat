import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { pluginFileRow } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { scriptedModelEnv } from '@lyteboat/testing/scripted-model'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { reopenRefusal } from '@lyteboat/testing/session-reopen'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURES, headlessComposition } from './support/headless-composition.ts'

const PLUGIN = pluginFileRow(join(FIXTURES, 'plugins', 'distro-aware.mjs'))
const { dsh: DSH_BASE } = JSON.parse(readFileSync(new URL('../../../../dsh.upstream.json', import.meta.url), 'utf8')) as { dsh: string }

describe('@lyteboat/distro in the business one-shot composition (in process, mock model)', () => {
  const scratch = createLyteboatScratch('distro')
  let mock: MockLlmServer

  beforeAll(async () => {
    mock = await startMockLlmServer({ port: 0, apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'MODEL' })
  })

  afterAll(async () => {
    await mock.close()
    scratch.remove()
  })

  it('serves a plugin that injects lyteboatDistro and answers through the intake extension', async () => {
    const { home, workspace } = scratch.run('intake')
    const result = await headlessComposition(['which lyteboat is this'], {
      cwd: workspace,
      home,
      env: scriptedModelEnv(mock),
    }, [{ id: 'session-title-llm', disabled: true }, PLUGIN])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(`lyteboat on dsh ${DSH_BASE}: agent-loop-intake, agent-loop-pre-assemble, session-append-ignorable, session-controller-prompt-source, headless-hooks`)
    expect(mock.requests).toHaveLength(0)
    // An intake reply is a plain assistant message and nothing of lyteboat's own, so dsh's persistence reopens the log.
    const records = readSessionLog(findSessionLogs(home)[0] ?? '')
    expect(eventTypes(records)).toContain('assistant/message')
    expect(eventTypes(records).filter(type => type.startsWith('lyteboat/'))).toEqual([])
    expect(reopenRefusal(records)).toBeUndefined()
  })
})
