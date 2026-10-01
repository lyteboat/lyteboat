/**
 * The built launcher boots the finance agent from `--agents ./examples/agents`.
 * The agent's behavior is this package's composition test; this proves the
 * installation closure, the profile, and the agent directory load together from
 * the built artifact: the request context names the customer, the admission lets
 * the request in, and the routed tool's card is placed after the answer.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lyteboatLauncher } from '@lyteboat/testing/process'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testing/scripted-model'

/** The examples/agents root this package lives in, as `--agents ./examples/agents` names it. */
const AGENTS = fileURLToPath(new URL('../..', import.meta.url))
// The published artifact under plain Node, reached through this package's devDependency on the launcher.
const { runLyteboat } = lyteboatLauncher(createRequire(import.meta.url).resolve('@lyteboat/cli/lib/bin.js'))

function script(request: RecordedRequest) {
  if (request.systemText.includes('准入分类器')) return { text: JSON.stringify({ intent: 'asset', reason: '看资产' }) }
  if (request.purpose === 'router') return { text: JSON.stringify({ skill_id: 'asset-overview', reason: '看资产' }) }
  const offered = request.toolNames.includes('asset_overview')
  return offered && !request.calledTools.includes('asset_overview') ? { toolCall: { name: 'asset_overview', arguments: {}, id: 'call-overview' } } : { text: 'FINANCE-SMOKE-OK' }
}

describe('lyteboat headless --agents ./examples/agents --agent finance (built bin, scripted model)', () => {
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
    const result = await runLyteboat(['headless', '--agents', AGENTS, '--agent', 'finance', '--context', '{"customer":"young-idle-cash"}', '看看我的资产'], {
      cwd: workspace,
      env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) },
    })
    expect(result.code, result.stderr).toBe(0)
    // The answer wrote no marker, so the deferred card follows it.
    expect(result.stdout).toBe('FINANCE-SMOKE-OK\n[card asset_overview]\n')
    const records = readSessionLog(findSessionLogs(home)[0] ?? '')
    expect(eventTypes(records)).toContain('tool/result')
    expect(JSON.stringify(records)).toContain('"surfaceId":"asset_overview-')
    expect(eventTypes(records).at(-1)).toBe('turn/end')
  })
})
