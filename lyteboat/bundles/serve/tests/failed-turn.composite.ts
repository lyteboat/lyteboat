/**
 * A turn that fails after the loop claimed the message and before the message
 * is logged still answers `/chat`: errored, with the failure, and the session
 * answers its next message. The message is not in the log, so a session whose
 * first message failed records no owner, and `/chat` cannot continue it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat } from '@lyteboat/testkit/chat-client'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { waitForSessionLog } from '@lyteboat/testkit/session-log'
import { startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { fixturePluginRow, serveBaseAgents, type BaseLogRecord, type ServedBaseAgents } from './support/base-agents-serve.ts'

describe('a turn that fails before its message is logged, in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('failed-turn')
  let model: ScriptedModel
  let served: ServedBaseAgents

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: 'FAILED-TURN-OK' })), { apiKey: 'mock-key' })
    served = await serveBaseAgents(scratch, model, [fixturePluginRow('failing-pre-assemble.mjs')])
  })

  afterAll(async () => {
    const run = await served.serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('answers errored with the failure, and the session answers its next message', async () => {
    const first = await postChat(served.chat, { agent_id: 'minimal', user_id: 'u-base', message: 'hello' })
    const sessionId = (first.body as { session_id: string }).session_id
    const before = model.requests.length

    const failed = await postChat(served.chat, { agent_id: 'minimal', user_id: 'u-base', message: 'fail before logging', message_id: 'm-fail', session_id: sessionId })

    expect(failed).toMatchObject({ status: 200, body: { session_id: sessionId, message_id: 'm-fail', outcome: 'errored', response: '', cards: [], tool_calls: [] } })
    expect((failed.body as { error?: string }).error).toContain('example-failing-pre-assemble: refused the step')
    expect(model.requests.slice(before).filter(request => request.purpose === 'loop')).toEqual([])

    const next = await postChat(served.chat, { agent_id: 'minimal', user_id: 'u-base', message: 'hello again', session_id: sessionId })

    expect(next).toMatchObject({ status: 200, body: { session_id: sessionId, outcome: 'completed', response: 'FAILED-TURN-OK' } })
    const records = await waitForSessionLog<BaseLogRecord>(served.home, sessionId, log => log.filter(record => record.type === 'turn/end').length >= 3)
    const humans = records.filter(record => record.type === 'user/message' && (record.data?.['source'] as { kind?: unknown } | undefined)?.kind === 'user')
    expect(humans.map(record => (record.data?.['content'] as { text: string }[] | undefined)?.[0]?.text)).toEqual(['hello', 'hello again'])
  })
})
