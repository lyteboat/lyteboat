import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { startScriptedModel, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { fixturePluginRow, serveBaseAgents, type ServedBaseAgents } from './support/base-agents-serve.ts'

const { dsh: DSH_BASE } = JSON.parse(readFileSync(new URL('../../../../dsh.upstream.json', import.meta.url), 'utf8')) as { dsh: string }

describe('@lyteboat/distro in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('distro')
  let model: ScriptedModel
  let served: ServedBaseAgents

  beforeAll(async () => {
    model = await startScriptedModel(() => ({ text: 'MODEL' }), { apiKey: 'mock-key' })
    served = await serveBaseAgents(scratch, model, [fixturePluginRow('distro-aware.mjs')])
  })

  afterAll(async () => {
    const run = await served.serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('serves a plugin that injects lyteboatDistro and answers through the intake extension', async () => {
    const { body, records } = await served.ask('minimal', 'which lyteboat is this')

    expect(body.response).toBe(`lyteboat on dsh ${DSH_BASE}: agent-loop-intake, agent-loop-pre-assemble, session-append-ignorable, session-controller-prompt-source, headless-hooks`)
    expect(model.requests).toHaveLength(0)
    // An intake reply is a plain assistant message and nothing of lyteboat's own, so dsh's persistence reopens the log.
    const types = records.map(record => record.type)
    expect(types).toContain('assistant/message')
    expect(types.filter(type => type.startsWith('lyteboat/'))).toEqual([])
    expect(reopenRefusal(records)).toBeUndefined()
  })
})
