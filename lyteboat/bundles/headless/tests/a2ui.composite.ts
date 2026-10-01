import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pluginFileRow } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { reopenRefusal } from '@lyteboat/testing/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest } from '@lyteboat/testing/scripted-model'
import { FIXTURES, headlessComposition } from './support/headless-composition.ts'

/** Card fidelity against the reference implementation is plugins/a2ui's job; this fixture only proves the rows are wired. */
const PLUGIN = pluginFileRow(join(FIXTURES, 'plugins', 'a2ui', 'plugin.mjs'))
const ANSWER = 'A2UI-OK'

type LogRecord = { type: string; data?: Record<string, unknown> }

describe('@lyteboat/a2ui in the business one-shot composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('a2ui')

  afterAll(() => {
    scratch.remove()
  })

  it('renders a card from the state a tool folded in, puts it on tool/result.meta, and shows only the digest to the model', async () => {
    const model = await startScriptedModel(withTitle((request: RecordedRequest) => {
      const calls = request.calledTools
      if (!calls.includes('query_profile')) return { toolCall: { name: 'query_profile', arguments: {}, id: 'call-query' } }
      if (!calls.includes('render_a2ui')) return { toolCall: { name: 'render_a2ui', arguments: { template: 'summary' }, id: 'call-render' } }
      return { text: ANSWER }
    }), { apiKey: 'mock-key' })
    try {
      const { home, workspace } = scratch.run('card')
      const result = await headlessComposition(['show my profile'], { cwd: workspace, home, env: scriptedModelEnv(model) }, [PLUGIN])
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain(ANSWER)
      const loop = model.loopRequests()
      expect(loop).toHaveLength(3)
      expect(loop[0]?.toolNames).toEqual(expect.arrayContaining(['query_profile', 'render_a2ui']))
      const shown = JSON.stringify(loop[2]?.body.messages)
      expect(shown).toContain('[card:summary] profile summary shown')
      expect(shown).not.toContain('rootComponentId')
      const records = readSessionLog(findSessionLogs(home)[0] ?? '') as unknown as LogRecord[]
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
    } finally {
      await model.close()
    }
  })

  it('ends the turn on a terminal card', async () => {
    const model = await startScriptedModel(withTitle(() => ({ toolCall: { name: 'render_a2ui', arguments: { template: 'finish' }, id: 'call-finish' } })), { apiKey: 'mock-key' })
    try {
      const { home, workspace } = scratch.run('terminal')
      const result = await headlessComposition(['wrap up'], { cwd: workspace, home, env: scriptedModelEnv(model) }, [PLUGIN])
      expect(result.code, result.stderr).toBe(0)
      expect(model.loopRequests()).toHaveLength(1)
      const records = readSessionLog(findSessionLogs(home)[0] ?? '') as unknown as LogRecord[]
      const rendered = records.find(record => record.type === 'tool/result')
      const meta = rendered?.data?.['meta'] as { lyteboat: { cards: { payload: Record<string, unknown> }[] } }
      expect(meta.lyteboat.cards[0]?.payload['rootComponentId']).toBe('root')
      expect(records.filter(record => record.type === 'turn/end').at(-1)?.data?.['reason']).toEqual({ kind: 'completed' })
    } finally {
      await model.close()
    }
  })
})
