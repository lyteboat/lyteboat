/**
 * `lyteboat release` and `lyteboat serve --release` on the built launcher:
 * the agent's baseline (a real run against the scripted model) replays into
 * a lock, and the service serves the agent that lock pins.
 */
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat } from '@lyteboat/testkit/chat-client'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testkit/scripted-model'
import { runLyteboat, startLyteboat } from './support/lyteboat-process.ts'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))
const WORKSPACE_MODULES = fileURLToPath(new URL('../../../../node_modules', import.meta.url))

describe('lyteboat release, then lyteboat serve --release (built bin, scripted model)', () => {
  const scratch = createLyteboatScratch('release-smoke')
  let model: ScriptedModel
  let root: string
  let lock: string

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(() => ({ text: 'SMOKE-OK' })), { apiKey: 'mock-key' })
    root = join(scratch.root, 'agents')
    cpSync(AGENTS, root, { recursive: true })
    // A row's package resolves from the agent directory upward; outside the repository, borrow the workspace's.
    symlinkSync(WORKSPACE_MODULES, join(scratch.root, 'node_modules'))
    writeFileSync(join(root, 'echo', 'agent.yml'), 'version: 0.1.0\nmodel: { provider: deepseek-official, model: deepseek-flash }\n')
    lock = join(root, 'echo', 'agent.release.json')
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('writes the release lock once the baseline replays unchanged', async () => {
    const { home, workspace } = scratch.run('release')
    const real = await runLyteboat(['eval', '--agents', root, '--agent', 'echo'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })
    expect(real.code, real.stderr).toBe(0)
    cpSync(/; report: (\S+)\/report\.md$/mu.exec(real.stdout)?.[1] ?? '', join(root, 'echo', 'evals', 'baseline'), { recursive: true })

    const released = await runLyteboat(['release', '--agents', root, '--agent', 'echo'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: undefined, DEEPSEEK_BASE_URL: undefined } })

    expect(released.code, released.stderr).toBe(0)
    expect(released.stdout).toContain(`lyteboat release: echo 0.1.0 (sha256:`)
    expect(existsSync(lock)).toBe(true)
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ agent: { id: 'echo', version: '0.1.0' }, baseline: { cases: 1, turns: 1 } })
  })

  it('exits 1 naming the changed file when the agent differs from its lock, and nothing else fails', async () => {
    const { home, workspace } = scratch.run('changed')
    const composition = join(root, 'echo', 'agent.cordis.yml')
    const original = readFileSync(composition, 'utf8')
    writeFileSync(composition, `${original}# edited after the release\n`)
    try {
      const result = await runLyteboat(['serve', '--release', lock, '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: '1' } })

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('echo: the directory differs from its release 0.1.0')
      expect(result.stderr).toContain('changed agent.cordis.yml')
      expect(result.stderr).not.toContain('fatal')
    } finally {
      writeFileSync(composition, original)
    }
  })

  it('serves the agent its lock pins, with the version on /agents', async () => {
    const { home, workspace } = scratch.run('serve')
    const lyteboat = startLyteboat(['serve', '--release', lock, '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) } })
    try {
      const chat = (await lyteboat.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) \(agents: echo\)$/mu, 90_000))[1] ?? ''

      const reply = await postChat(chat, { agent_id: 'echo', user_id: 'u-1', message: 'hello' })
      const agents = await (await fetch(new URL('/agents', chat))).json() as { agents: unknown[] }

      expect(reply).toMatchObject({ status: 200, body: { outcome: 'completed', response: 'SMOKE-OK' } })
      expect(agents.agents).toEqual([expect.objectContaining({ id: 'echo', version: '0.1.0' })])
    } finally {
      const code = await lyteboat.stop('SIGTERM')
      expect(code, lyteboat.output()).toBe(0)
    }
  })
})
