import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { reopenRefusal } from '@lyteboat/testing/session-reopen'
import { FIXTURES, headlessComposition } from './support/headless-composition.ts'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'

const HISTORY = join(FIXTURES, 'history', 'rounds.json')
const ANSWER = 'HISTORY-OK'

type LogRecord = { type: string; data?: Record<string, unknown>; isSeeded?: boolean }

describe('lyteboat headless --history (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('history')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: ANSWER })), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('seeds the session from the file: two complete rounds, the task as turn 3, the rounds in the first request', async () => {
    const { home, workspace } = scratch.run('seed')
    const before = model.requests.length
    const result = await headlessComposition(['--history', HISTORY, '继续刚才的话题'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(ANSWER)
    expect(result.stderr).toContain('imported 2 history round(s) from rounds.json')
    const loop = model.requests.slice(before).filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    const roles = loop[0]!.body.messages.map(message => message.role)
    expect(roles.slice(0, 4)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const text = JSON.stringify(loop[0]!.body.messages)
    expect(text).toContain('帮我看看我的资产分布')
    expect(text).toContain('建议把稳健提高到 25% 左右')
    expect(text).not.toContain('那具体怎么调')
    expect(text).toContain('继续刚才的话题')
    const [log] = findSessionLogs(home)
    const records = readSessionLog(log!) as unknown as LogRecord[]
    expect(records[0]).toMatchObject({ type: 'session', isSeeded: true })
    const turns = records.filter(record => record.type === 'turn/start').map(record => record.data?.['turn'])
    expect(turns).toEqual([1, 2, 3])
    const types = records.map(record => record.type)
    expect(types.filter(type => type.startsWith('lyteboat/'))).toEqual([])
    expect(types.indexOf('session/end-seed')).toBeGreaterThan(types.indexOf('turn/end'))
    expect(types.indexOf('session/end-seed')).toBeLessThan(types.lastIndexOf('turn/start'))
    expect(records.filter(record => record.type === 'turn/end').at(-1)?.data).toEqual({ turn: 3, reason: { kind: 'completed' } })
    // Without an agent the business base composes an empty system prompt, the seed's own
    // system head, so the first request continues the seed's series instead of opening one.
    const headers = records.filter(record => record.type === 'request/header').map(record => [record.data?.['reason'], record.data?.['startsSeries']])
    expect(headers).toEqual([['initial', undefined]])
    // The seed is closed turns of dsh nodes, so dsh's persistence reopens the log.
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('rejects a missing history file as a usage error', async () => {
    const { home, workspace } = scratch.run('missing')
    const result = await headlessComposition(['--history', join(workspace, 'nope.json'), 'hi'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('--history file not found')
  })
})
