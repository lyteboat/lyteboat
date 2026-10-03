import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { serveBaseAgents, type BaseLogRecord, type ServedBaseAgents } from './support/base-agents-serve.ts'

const ANSWER = 'SKILL-ROUTER-OK'

const isSkillInvocation = (record: BaseLogRecord): boolean =>
  record.type === 'user/message' && (record.data?.['source'] as { kind?: unknown } | undefined)?.kind === 'skill-invocation'

// A skill in the project root of every session an agent runs: the business
// base lends no agent a host skill root, so it is never a routing candidate.
const WORKSPACE_SKILL = `---
name: workspace-notes
description: 工作区里的笔记。
---
WORKSPACE-NOTES-BODY
`

describe('@lyteboat/skill-router in the serve composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('skill-router')
  let model: ScriptedModel
  let served: ServedBaseAgents

  beforeAll(async () => {
    model = await startScriptedModel(withTitle((request: RecordedRequest) => request.purpose === 'router'
      ? { text: '{"skill_id": "asset-overview", "reason": "看资产"}' }
      : { text: ANSWER }), { apiKey: 'mock-key' })
    served = await serveBaseAgents(scratch, model)
    for (const agent of ['routed', 'minimal']) {
      const skillDir = join(served.home, 'agent-workdirs', agent, '.dsh', 'skills', 'workspace-notes')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), WORKSPACE_SKILL)
    }
  })

  afterAll(async () => {
    const run = await served.serve.stop()
    await model.close()
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('routes the message through the router model and puts the skill body and its tool into the same request', async () => {
    const before = model.requests.length
    const { body, records } = await served.ask('routed', '看看我的资产')

    expect(body.response).toBe(ANSWER)
    const requests = model.requests.slice(before)
    const router = requests.filter(request => request.purpose === 'router')
    expect(router).toHaveLength(1)
    expect(router[0]!.lastUser).toContain('<available_skills>')
    expect(router[0]!.lastUser).toContain('id: asset-overview')
    expect(router[0]!.lastUser).toContain('id: market-news')
    expect(router[0]!.lastUser).not.toContain('workspace-notes')
    expect(router[0]!.lastUser).toContain('<latest_user_input>看看我的资产</latest_user_input>')
    const loop = requests.filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(loop[0]!.systemText).toContain('ROUTED-PRESET-PERSONA')
    expect(loop[0]!.toolNames).toContain('todo_write')
    const messages = JSON.stringify(loop[0]!.body.messages)
    expect(messages).toContain('ASSET-OVERVIEW-BODY')
    expect(messages).not.toContain('MARKET-NEWS-BODY')
    // The router call is lyteboat's one record of its own: audited, and ignorable for other readers.
    const own = records.filter(record => record.type.startsWith('lyteboat/'))
    expect(own.map(record => [record.type, record.ignorable])).toEqual([['lyteboat/aux-llm-call', true]])
    expect(own[0]?.data).toMatchObject({ purpose: 'skill-router', route: { provider: 'deepseek-official' }, output: '{"skill_id": "asset-overview", "reason": "看资产"}' })
    const invocations = records.filter(isSkillInvocation)
    expect(invocations.map(record => record.data?.['source'])).toEqual([{ kind: 'skill-invocation', name: 'asset-overview', form: 'instructions' }])
    expect(records.indexOf(invocations[0]!)).toBeLessThan(records.findIndex(record => record.type === 'request/header'))
    // The skill arrives on dsh's skill-invocation message and the router call is ignorable, so dsh's persistence reopens the log.
    expect(reopenRefusal(records)).toBeUndefined()
  })

  it('continues a routed session: the next turn derives the first and keeps the skill without injecting it again', async () => {
    const first = await served.ask('routed', '看看我的资产')
    const before = model.requests.length

    const { body, records } = await served.ask('routed', '那总额呢', { session_id: first.body.session_id })

    expect(body).toMatchObject({ session_id: first.body.session_id, response: ANSWER })
    const requests = model.requests.slice(before)
    expect(requests.filter(request => request.purpose === 'router')[0]?.lastUser).toContain('<current_active_skill>asset-overview</current_active_skill>')
    const loop = requests.filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(loop[0]!.toolNames).toContain('todo_write')
    const messages = JSON.stringify(loop[0]!.body.messages)
    expect(messages).toContain('看看我的资产')
    expect(messages.split('ASSET-OVERVIEW-BODY')).toHaveLength(2)
    expect(records.filter(record => record.type === 'turn/start')).toHaveLength(2)
  })

  it('makes no router call and offers no skill to an agent without routing, not even its project root\'s', async () => {
    const before = model.requests.length
    const { records } = await served.ask('minimal', '看看我的资产')

    const requests = model.requests.slice(before)
    expect(requests.filter(request => request.purpose === 'router')).toHaveLength(0)
    const loop = requests.filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(JSON.stringify(loop[0]!.body)).not.toContain('workspace-notes')
    expect(records.map(record => record.type).filter(type => type.startsWith('lyteboat/'))).toEqual([])
    expect(records.filter(isSkillInvocation)).toEqual([])
  })
})
