import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { fixturePluginRow, questionOf, serveBaseAgents, type ServedBaseAgents } from './support/base-agents-serve.ts'

const ANSWER = 'A2UI-OK'

/** `wrap up` renders the terminal card; anything else queries the profile, renders the summary, and answers. */
function script(request: RecordedRequest) {
  if (questionOf(request) === 'wrap up') return { toolCall: { name: 'render_a2ui', arguments: { template: 'finish' }, id: 'call-finish' } }
  const calls = request.calledTools
  if (!calls.includes('query_profile')) return { toolCall: { name: 'query_profile', arguments: {}, id: 'call-query' } }
  if (!calls.includes('render_a2ui')) return { toolCall: { name: 'render_a2ui', arguments: { template: 'summary' }, id: 'call-render' } }
  return { text: ANSWER }
}

/** Card fidelity against the reference implementation is plugins/a2ui's job; this fixture only proves the rows are wired. */
describe('@lyteboat/a2ui in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('a2ui')
  let model: ScriptedModel
  let served: ServedBaseAgents

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
    served = await serveBaseAgents(scratch, model, [fixturePluginRow('a2ui/plugin.mjs')])
  })

  afterAll(async () => {
    const run = await served.serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('renders a card from the state a tool folded in, puts it on tool/result.meta, and shows only the digest to the model', async () => {
    const before = model.requests.length
    const { body, records } = await served.ask('minimal', 'show my profile')

    expect(body).toMatchObject({ outcome: 'completed', response: ANSWER, cards: [{ area: 'summary' }] })
    const loop = model.requests.slice(before).filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(3)
    expect(loop[0]?.toolNames).toEqual(expect.arrayContaining(['query_profile', 'render_a2ui']))
    const shown = JSON.stringify(loop[2]?.body.messages)
    expect(shown).toContain('[card:summary] profile summary shown')
    expect(shown).not.toContain('rootComponentId')
    const [queried, rendered] = records.filter(record => record.type === 'tool/result')
    expect(queried?.data?.['meta']).toMatchObject({ lyteboat: { stateDelta: { profile: { name: 'Composite Tester' } } } })
    expect(records.map(record => record.type).filter(type => type.startsWith('lyteboat/'))).toEqual([])
    const meta = rendered?.data?.['meta'] as { lyteboat: { cards: { surfaceId: string; payload: Record<string, unknown> }[] }; a2ui: { warnings: string[] } }
    expect(meta.a2ui.warnings).toEqual([])
    expect(meta.lyteboat.cards[0]?.surfaceId).toMatch(/^summary-/u)
    expect(meta.lyteboat.cards[0]?.payload['rootComponentId']).toBe('root')
    expect(JSON.stringify(meta.lyteboat.cards[0]?.payload)).toContain('Composite Tester')
    // The card and the state delta ride tool/result.meta, so dsh's persistence reopens the log.
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('ends the turn on a terminal card', async () => {
    const before = model.requests.length
    const { body, records } = await served.ask('minimal', 'wrap up')

    expect(body).toMatchObject({ outcome: 'completed', cards: [{ area: 'finish' }] })
    expect(model.requests.slice(before).filter(request => request.purpose === 'loop')).toHaveLength(1)
    const rendered = records.find(record => record.type === 'tool/result')
    const meta = rendered?.data?.['meta'] as { lyteboat: { cards: { payload: Record<string, unknown> }[] } }
    expect(meta.lyteboat.cards[0]?.payload['rootComponentId']).toBe('root')
    expect(records.filter(record => record.type === 'turn/end').at(-1)?.data?.['reason']).toEqual({ kind: 'completed' })
  })
})
