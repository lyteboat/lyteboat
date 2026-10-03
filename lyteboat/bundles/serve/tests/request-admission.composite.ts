/**
 * A host admission function in the serve composition: it decides at the
 * turn's first step, a reply answers without a model request and is recorded
 * on the request with its card, and a pass is not recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { fixturePluginRow, serveBaseAgents, type BaseLogRecord, type ServedBaseAgents } from './support/base-agents-serve.ts'

/** The sources of the human messages a log holds, in order. */
const humanSources = (records: BaseLogRecord[]): unknown[] =>
  records.filter(record => record.type === 'user/message').map(record => record.data?.['source']).filter(source => (source as { kind?: unknown }).kind === 'user')

describe('@lyteboat/request-admission in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('request-admission')
  let model: ScriptedModel
  let served: ServedBaseAgents

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: 'REQUEST-OK' })), { apiKey: 'mock-key' })
    served = await serveBaseAgents(scratch, model, [fixturePluginRow('admission.mjs')])
  })

  afterAll(async () => {
    const run = await served.serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('answers a reply verdict without a model request, recording it and its card on the request', async () => {
    const before = model.requests.length
    const { body, records } = await served.ask('minimal', '帮我炒股', { message_id: 'm-stock', context: { channel: '本渠道' } })

    expect(body).toMatchObject({ outcome: 'rejected', response: '抱歉，本渠道不提供股票买卖建议。', cards: [{ area: 'scope' }] })
    expect(model.requests.slice(before).filter(request => request.purpose === 'loop')).toEqual([])
    expect(humanSources(records)).toEqual([{
      kind: 'user',
      rpcId: 'm-stock',
      lyteboatRequest: {
        requestId: 'm-stock',
        owner: { kind: 'user', id: 'u-base' },
        agent: { id: 'minimal', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string },
        context: { channel: '本渠道' },
        intake: { by: 'example-admission', decision: 'reply', verdict: 'out_of_scope', text: '抱歉，本渠道不提供股票买卖建议。', cards: [{ surfaceId: 'scope-card', area: 'scope', emission: 'immediate', payload: { rootComponentId: 'root' } }] },
      },
    }])
  })

  it('lets the model answer a pass and records no verdict', async () => {
    const { body, records } = await served.ask('minimal', '看看我的资产', { message_id: 'm-pass' })

    expect(body).toMatchObject({ outcome: 'completed', response: 'REQUEST-OK' })
    expect(humanSources(records)).toEqual([{
      kind: 'user',
      rpcId: 'm-pass',
      lyteboatRequest: { requestId: 'm-pass', owner: { kind: 'user', id: 'u-base' }, agent: { id: 'minimal', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as string } },
    }])
  })
})
