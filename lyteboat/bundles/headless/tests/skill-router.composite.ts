import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { findSessionLogs, readSessionLog } from '@lyteboat/testkit/session-log'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { FIXTURES, headlessComposition } from './support/headless-composition.ts'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'

const AGENTS = join(FIXTURES, 'agents')
const ANSWER = 'SKILL-ROUTER-OK'

type SessionRecord = { type: string; ignorable?: true; data?: Record<string, unknown> }
const isSkillInvocation = (record: SessionRecord): boolean =>
  record.type === 'user/message' && (record.data?.['source'] as { kind?: unknown } | undefined)?.kind === 'skill-invocation'

// A skill in the workspace's project root: the business base lends no agent a
// host skill root, so it is never a routing candidate.
const WORKSPACE_SKILL = `---
name: workspace-notes
description: 工作区里的笔记。
---
WORKSPACE-NOTES-BODY
`

describe('@lyteboat/skill-router in the business one-shot composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('skill-router')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle((request: RecordedRequest) => request.purpose === 'router'
      ? { text: '{"skill_id": "asset-overview", "reason": "看资产"}' }
      : { text: ANSWER }), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  function fresh(label: string): { home: string; workspace: string } {
    return scratch.run(label, { '.dsh/skills/workspace-notes/SKILL.md': WORKSPACE_SKILL })
  }

  it('routes the task through the router model and puts the skill body and its tool into the same request', async () => {
    const { home, workspace } = fresh('dynamic')
    const before = model.requests.length
    const result = await headlessComposition(
      ['--agents', AGENTS, '--agent', 'routed', '看看我的资产'],
      { cwd: workspace, home, env: scriptedModelEnv(model) },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(ANSWER)
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
    const [log] = findSessionLogs(home)
    const records = readSessionLog(log!) as SessionRecord[]
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

  it('leaves the host composition alone without an agent: no router call and no skill, not even the workspace\'s', async () => {
    const { home, workspace } = fresh('off')
    const before = model.requests.length
    const result = await headlessComposition(['看看我的资产'], { cwd: workspace, home, env: scriptedModelEnv(model) })
    expect(result.code, result.stderr).toBe(0)
    const requests = model.requests.slice(before)
    expect(requests.filter(request => request.purpose === 'router')).toHaveLength(0)
    const loop = requests.filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(1)
    expect(JSON.stringify(loop[0]!.body)).not.toContain('workspace-notes')
    const [log] = findSessionLogs(home)
    const records = readSessionLog(log!) as SessionRecord[]
    expect(records.map(record => record.type).filter(type => type.startsWith('lyteboat/'))).toEqual([])
    expect(records.filter(isSkillInvocation)).toEqual([])
  })
})
