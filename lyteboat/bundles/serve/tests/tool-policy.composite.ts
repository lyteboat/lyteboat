import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { fixturePluginRow, questionOf, serveBaseAgents, type ServedBaseAgents } from './support/base-agents-serve.ts'

const ANSWER = 'TOOL-POLICY-OK'

/** The tool each question calls on its first loop request. */
const CALLS: Readonly<Record<string, { name: string; arguments: unknown }>> = {
  查一下资产: { name: 'lookup_assets', arguments: {} },
  帮我调仓: { name: 'rebalance', arguments: { target: '股债均衡' } },
  'plan the review': { name: 'todo_write', arguments: { todos: [{ content: '整理资产', status: 'pending' }] } },
}

/** One tool call on the first loop request, the answer once a tool result is in the transcript. */
function script(request: RecordedRequest) {
  const call = CALLS[questionOf(request)]
  return call === undefined || request.body.messages.some(message => message.content.some(block => block.type === 'tool_result'))
    ? { text: ANSWER }
    : { toolCall: { ...call, id: `call-${call.name}` } }
}

describe('@lyteboat/tool-policy in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('tool-policy')
  let model: ScriptedModel
  let served: ServedBaseAgents

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
    served = await serveBaseAgents(scratch, model, [fixturePluginRow('tools.mjs')])
  })

  afterAll(async () => {
    const run = await served.serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  const loopSince = (before: number): RecordedRequest[] => model.requests.slice(before).filter(request => request.purpose === 'loop')

  it('shows always tools, hides unactivated auto tools, and folds a state delta into the next request', async () => {
    const before = model.requests.length
    const { body, records } = await served.ask('minimal', '查一下资产')

    expect(body).toMatchObject({ outcome: 'completed', response: ANSWER, tool_calls: [{ name: 'lookup_assets' }] })
    const loop = loopSince(before)
    expect(loop).toHaveLength(2)
    const first = loop[0]!.toolNames
    expect(first).toContain('lookup_assets')
    // The business base composes no coding tools.
    expect(first).not.toContain('bash')
    expect(first).not.toContain('rebalance')
    expect(JSON.stringify(loop[0]!.body.messages)).not.toContain('Session state')
    const second = JSON.stringify(loop[1]!.body.messages)
    expect(second).toContain('Session state, accumulated from tool results')
    expect(second).toContain('1234')
    expect(records.map(record => record.type).filter(type => type.startsWith('lyteboat/'))).toEqual([])
    const toolResult = records.find(record => record.type === 'tool/result')
    expect(toolResult?.data?.['meta']).toEqual({ lyteboat: { stateDelta: { 'assets.total': 1234, 'assets.currency': 'CNY' } } })
    // The delta rides tool/result.meta, a dsh envelope, so dsh's persistence reopens the log.
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('activates an auto tool from lyteboat/pre-assemble for the same step and runs it', async () => {
    const before = model.requests.length
    const { records } = await served.ask('minimal', '帮我调仓')

    const loop = loopSince(before)
    expect(loop).toHaveLength(2)
    expect(loop[0]!.toolNames).toContain('rebalance')
    expect(records.map(record => record.type).filter(type => type.startsWith('approval/'))).toEqual([])
    const toolResult = records.find(record => record.type === 'tool/result')
    expect(JSON.stringify(toolResult)).toContain('已按“股债均衡”调仓')
  })

  it('gives an agent the dsh tool its own composition brings and hides the inherited tools no policy declares', async () => {
    const before = model.requests.length
    await served.ask('policy', 'plan the review')

    const loop = loopSince(before)
    expect(loop).toHaveLength(2)
    expect(loop[0]!.systemText).toContain('POLICY-PRESET-PERSONA')
    // `skill` is the one dsh-base tool the business base leaves; lookup_assets is declared by the host plugin.
    expect([...loop[0]!.toolNames].sort()).toEqual(['lookup_assets', 'todo_write'])
  })
})
