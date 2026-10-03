/**
 * The built launcher serves the finance agent from `--agents ./examples/agents`.
 * The agent's behavior is this package's composition test; this proves the
 * installation closure, the profile, and the agent directory load together from
 * the built artifact: the request context names the customer, the admission lets
 * the request in, and the routed tool's card is placed after the answer.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat } from '@lyteboat/testkit/chat-client'
import { lyteboatLauncher } from '@lyteboat/testkit/process'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { eventTypes, waitForSessionLog } from '@lyteboat/testkit/session-log'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testkit/scripted-model'

/** The examples/agents root this package lives in, as `--agents ./examples/agents` names it. */
const AGENTS = fileURLToPath(new URL('../..', import.meta.url))
// The published artifact under plain Node, reached through this package's devDependency on the launcher.
const { startLyteboat } = lyteboatLauncher(createRequire(import.meta.url).resolve('@lyteboat/cli/lib/bin.js'))

function script(request: RecordedRequest) {
  if (request.systemText.includes('准入分类器')) return { text: JSON.stringify({ intent: 'asset', reason: '看资产' }) }
  if (request.purpose === 'router') return { text: JSON.stringify({ skill_id: 'asset-overview', reason: '看资产' }) }
  const offered = request.toolNames.includes('asset_overview')
  return offered && !request.calledTools.includes('asset_overview') ? { toolCall: { name: 'asset_overview', arguments: {}, id: 'call-overview' } } : { text: 'FINANCE-SMOKE-OK' }
}

describe('lyteboat serve --agents ./examples/agents, the finance agent (built bin, scripted model)', () => {
  const scratch = createLyteboatScratch('finance-smoke')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('routes, calls the overview tool, renders its card, and answers', async () => {
    const { home, workspace } = scratch.run('smoke')
    const lyteboat = startLyteboat(['serve', '--agents', AGENTS, '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })
    try {
      const chat = (await lyteboat.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) /mu, 90_000))[1] ?? ''

      const reply = await postChat(chat, { agent_id: 'finance', user_id: 'u-smoke', message: '看看我的资产', context: { customer: 'young-idle-cash' } })

      // The answer wrote no marker, so the deferred card follows it.
      expect(reply).toMatchObject({ status: 200, body: { outcome: 'completed', response: 'FINANCE-SMOKE-OK', cards: [{ area: 'asset_overview' }] } })
      const records = await waitForSessionLog(home, (reply.body as { session_id: string }).session_id, log => eventTypes(log).includes('turn/end'))
      expect(eventTypes(records)).toContain('tool/result')
      expect(JSON.stringify(records)).toContain('"surfaceId":"asset_overview-')
      expect(eventTypes(records).at(-1)).toBe('turn/end')
    } finally {
      const code = await lyteboat.stop('SIGTERM')
      expect(code, lyteboat.output()).toBe(0)
    }
  })
})
