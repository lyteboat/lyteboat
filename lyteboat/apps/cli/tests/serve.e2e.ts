/**
 * `lyteboat serve` on the built launcher: it boots the serve profile, prints
 * where `/chat` listens, answers one message in a JSON body and one as the
 * enterprise stream, stops cleanly on SIGTERM, refuses to start without an
 * agent directory, and exits when a row it needs fails instead of waiting.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat, streamChat } from '@lyteboat/testing/chat-client'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'
import { runLyteboat, startLyteboat } from './support/lyteboat-process.ts'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

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
