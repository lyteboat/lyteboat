/**
 * `lyteboat serve` on the built launcher: it boots the serve profile, prints
 * where `/chat` listens, answers one message in a JSON body and one as the
 * enterprise stream, stops cleanly on SIGTERM, takes a `--plugin` file and a
 * `--patch` overlay into the tree, refuses to start without an agent
 * directory, and exits when a row it needs fails instead of waiting.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat, streamChat } from '@lyteboat/testkit/chat-client'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { eventTypes, waitForSessionLog } from '@lyteboat/testkit/session-log'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { runLyteboat, startLyteboat } from './support/lyteboat-process.ts'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))
const ANNOUNCE_PLUGIN = fileURLToPath(new URL('./fixtures/plugins/announce.mjs', import.meta.url))

/** dsh's harness identity, which the business base leaves out of the prompt. */
const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

/** A --patch overlay the smoke proves applied: it brings the harness identity back into the request. */
const IDENTITY_OVERLAY = '- id: system-prompt\n  config:\n    includeHarnessIdentity: true\n'

/** A skill in the shared agent configuration root (`DSH_AGENTS_HOME/skills`), as a person's own `~/.agents` would hold it. */
const STRAY_SKILL = 'shared-root-probe'

describe('lyteboat serve (built bin, scripted model)', () => {
  const scratch = createLyteboatScratch('serve-smoke')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: 'SERVE-SMOKE-OK' })), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('answers /chat in a JSON body and as a stream, and stops cleanly on SIGTERM', async () => {
    const { home, workspace } = scratch.run('serve')
    const lyteboat = startLyteboat(['serve', '--agents', AGENTS, '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })
    try {
      const chat = (await lyteboat.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) \(agents: echo\)$/mu, 90_000))[1] ?? ''

      const reply = await postChat(chat, { agent_id: 'echo', user_id: 'u-1', message: 'hello' })
      const stream = await streamChat(chat, { agent_id: 'echo', user_id: 'u-1', message: 'again', session_id: (reply.body as { session_id: string }).session_id })

      expect(reply).toMatchObject({ status: 200, body: { outcome: 'completed', response: 'SERVE-SMOKE-OK' } })
      expect(stream.frames.map(frame => frame.event).filter(event => event !== 'text_message_content')).toEqual(['run_started', 'text_message_start', 'text_message_end', 'run_finished'])
      expect(stream.frames.at(-1)?.data).toMatchObject({ turn: 2, ui_data: 'SERVE-SMOKE-OK', extra: { run_outcome: 'completed' } })
    } finally {
      const code = await lyteboat.stop('SIGTERM')
      expect(code, lyteboat.output()).toBe(0)
    }
  })

  it('answers through the real tool path when a --plugin file and a --patch join the tree, and reads no shared skill root', async () => {
    const { home, workspace } = scratch.run('plugin')
    const mock = await startMockLlmServer({ port: 0, apiKey: 'mock-key', sequence: ['tool_call_success', 'success'], repeatLast: true, toolName: 'announce_status', toolArguments: '{}', successText: 'SERVE-PLUGIN-OK' })
    const patch = join(workspace, 'identity.patch.yml')
    writeFileSync(patch, IDENTITY_OVERLAY)
    const agentsHome = join(workspace, 'shared-agents')
    mkdirSync(join(agentsHome, 'skills', STRAY_SKILL), { recursive: true })
    writeFileSync(join(agentsHome, 'skills', STRAY_SKILL, 'SKILL.md'), `---\nname: ${STRAY_SKILL}\ndescription: A skill a person keeps in their own agent root.\n---\nPROBE-BODY\n`)
    const lyteboat = startLyteboat(['serve', '--plugin', ANNOUNCE_PLUGIN, '--patch', patch, '--agents', AGENTS, '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_AGENTS_HOME: agentsHome, ...scriptedModelEnv(mock) } })
    try {
      const chat = (await lyteboat.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) /mu, 90_000))[1] ?? ''

      const reply = await postChat(chat, { agent_id: 'echo', user_id: 'u-1', message: 'check the status and report' })

      expect(reply).toMatchObject({ status: 200, body: { outcome: 'completed', response: 'SERVE-PLUGIN-OK', tool_calls: [{ name: 'announce_status' }] } })
      // The plugin file's row was applied once, and no row failed to import or apply.
      expect(lyteboat.stderr().split('\n').filter(line => line === 'fixture-announce: applied')).toHaveLength(1)
      expect(lyteboat.stderr()).not.toContain('did not activate')
      // The world, not the self-report: the persisted log carries the tool round trip.
      const records = await waitForSessionLog(home, (reply.body as { session_id: string }).session_id, log => eventTypes(log).includes('turn/end'))
      expect(eventTypes(records).filter(type => type === 'step/start')).toHaveLength(2)
      expect(JSON.stringify(records.find(record => record['type'] === 'tool/result'))).toContain('fixture-announce: status ok')
      // Two model requests: the tool-call step and the answer, under the agent's persona and the patched identity, without the shared root's skill.
      expect(mock.requests).toHaveLength(2)
      expect(JSON.stringify(mock.requests[0])).toContain('You are SERVE-SMOKE')
      expect(JSON.stringify(mock.requests[0])).toContain(HARNESS_IDENTITY)
      for (const request of mock.requests) expect(JSON.stringify(request)).not.toContain(STRAY_SKILL)
      // The profile's plugins resolved through the installation's runtime resolution; nothing is linked into the profiles tree.
      expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
    } finally {
      const code = await lyteboat.stop('SIGTERM')
      await mock.close()
      expect(code, lyteboat.output()).toBe(0)
    }
  })

  it('exits 1 when a row the service needs fails, instead of waiting with nothing to serve', async () => {
    const { home, workspace } = scratch.run('broken-row')
    const patch = join(workspace, 'unknown-key.patch.yml')
    writeFileSync(patch, '- id: chat-api\n  config:\n    auth: none\n    workspace: /tmp\n')

    const result = await runLyteboat(['serve', '--patch', patch, '--agents', AGENTS, '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1' } })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('chat-api: unknown config key "workspace"')
    expect(result.stderr).toContain('lyteboat: startup failed: lyteboat-serve did not activate (the entries above say why)')
  })

  it('refuses to start without an agent directory', async () => {
    const { home, workspace } = scratch.run('usage')
    const result = await runLyteboat(['serve'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1' } })

    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('error: at least one --agents directory or --release lock is required')
  })
})
