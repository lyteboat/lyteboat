/**
 * An agent released, then served by its lock, in process (the eval and serve
 * compositions, scripted model): `release` replays a real run's baseline and
 * writes the lock; `serve --release` serves that agent alone, pinned, with its
 * identity on every request and its version on /agents; a changed file, a
 * lock beside `--agents`, and a lock released on another dsh are refused
 * before /chat opens.
 */
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postChat } from '@lyteboat/testing/chat-client'
import { LYTEBOAT_EVAL_BUNDLES, LYTEBOAT_SERVE_BUNDLES, bootComposition, startComposition } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testing/session-log'
import { scriptedModelEnv, startScriptedModel, withTitle, type ScriptedModel } from '@lyteboat/testing/scripted-model'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))
const WORKSPACE_MODULES = fileURLToPath(new URL('../../../../node_modules', import.meta.url))

describe('lyteboat release, then lyteboat serve --release (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('serve-release')
  let model: ScriptedModel
  let root: string
  let lock: string
  // The eval and serve compositions each keep their profile in their own home.
  let releasing: { cwd: string; home: string }
  let serving: { cwd: string; home: string }

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(request => ({ text: `OK:${request.latestMessage}` })), { apiKey: 'mock-key' })
    const evalRun = scratch.run('release')
    const serveRun = scratch.run('serve')
    releasing = { cwd: evalRun.workspace, home: evalRun.home }
    serving = { cwd: serveRun.workspace, home: serveRun.home }
    // beta is released; alpha, beside it, is not served by the lock.
    root = join(scratch.root, 'agents')
    cpSync(AGENTS, root, { recursive: true })
    // A row's package resolves from the agent directory upward; outside the repository, borrow the workspace's.
    symlinkSync(WORKSPACE_MODULES, join(scratch.root, 'node_modules'))
    writeFileSync(join(root, 'beta', 'agent.yml'), `${readFileSync(join(root, 'beta', 'agent.yml'), 'utf8')}version: 1.0.0\nmodel: { provider: deepseek-official, model: deepseek-flash }\n`)
    mkdirSync(join(root, 'beta', 'evals'))
    writeFileSync(join(root, 'beta', 'evals', 'cases.yml'), "cases:\n  - id: hello\n    turns:\n      - message: hello\n        expect: { outcome: completed, text: { includes: ['OK:hello'] } }\n")
    const recorded = await bootComposition({ bundles: LYTEBOAT_EVAL_BUNDLES, args: ['--agents', root, '--agent', 'beta'], ...releasing, env: scriptedModelEnv(model) })
    const runDir = /; report: (\S+)\/report\.md$/mu.exec(recorded.stdout)?.[1]
    if (recorded.code !== 0 || runDir === undefined) throw new Error(`the baseline run failed:\n${recorded.stdout}\n${recorded.stderr}`)
    cpSync(runDir, join(root, 'beta', 'evals', 'baseline'), { recursive: true })
    lock = join(root, 'beta', 'agent.release.json')
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('releases the agent: its baseline replays unchanged, and the lock pins its version, digest, files, and model', async () => {
    const released = await bootComposition({ bundles: LYTEBOAT_EVAL_BUNDLES, args: ['release', '--agents', root, '--agent', 'beta'], ...releasing, env: { DSH_TELEMETRY_DISABLED: '1' } })
    const bytes = readFileSync(lock, 'utf8')
    const again = await bootComposition({ bundles: LYTEBOAT_EVAL_BUNDLES, args: ['release', '--agents', root, '--agent', 'beta'], ...releasing, env: { DSH_TELEMETRY_DISABLED: '1' } })

    expect(released.code, released.stderr).toBe(0)
    expect(released.stdout).toMatch(new RegExp(`^lyteboat release: beta 1\\.0\\.0 \\(sha256:[0-9a-f]{64}\\) released; lock: ${lock.replaceAll('.', '\\.')}; replay: `, 'mu'))
    const release = JSON.parse(bytes) as { agent: unknown; model: unknown; dshBase: string; files: Record<string, string>; baseline: unknown }
    expect(release).toMatchObject({ agent: { id: 'beta', version: '1.0.0' }, model: { provider: 'deepseek-official', model: 'deepseek-flash' }, baseline: { cases: 1, turns: 1, checks: 2 } })
    expect(release.dshBase).toMatch(/^\d+\.\d+\.\d+/u)
    expect(Object.keys(release.files)).toEqual(['agent.cordis.yml', 'agent.yml'])
    expect(again.code, again.stderr).toBe(0)
    expect(readFileSync(lock, 'utf8')).toBe(bytes)
  })

  it('serves the released agent alone, with its identity on the request and its version on /agents', async () => {
    const identity = (JSON.parse(readFileSync(lock, 'utf8')) as { agent: { id: string; version: string; digest: string } }).agent
    const serve = startComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--release', lock, '--port', '0'], ...serving, env: scriptedModelEnv(model), timeoutMs: 170_000 })
    try {
      const chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/127\.0\.0\.1:\d+\/chat) \(agents: beta\)$/mu))[1] ?? ''

      const reply = await postChat(chat, { agent_id: 'beta', user_id: 'u-1', message: 'hello' })
      const agents = await (await fetch(new URL('/agents', chat))).json() as { agents: unknown[] }

      expect(reply).toMatchObject({ status: 200, body: { response: 'OK:hello' } })
      const sessionId = (reply.body as { session_id: string }).session_id
      const records = await waitForSessionLog<SessionLogRecord & { type: string; data?: { source?: { lyteboatRequest?: { agent?: unknown } } } }>(serving.home, sessionId, log => log.some(line => line.type === 'user/message'))
      const human = records.find(line => line.type === 'user/message')
      expect(human?.data?.source?.lyteboatRequest?.agent).toEqual(identity)
      expect(agents.agents).toEqual([expect.objectContaining({ id: 'beta', version: '1.0.0' })])
    } finally {
      const stopped = await serve.stop()
      expect(stopped.code, stopped.stderr).toBe(0)
    }
  })

  it('refuses to start when a file of the agent differs from its release, naming the file', async () => {
    const composition = join(root, 'beta', 'agent.cordis.yml')
    const original = readFileSync(composition, 'utf8')
    writeFileSync(composition, `${original}# edited after the release\n`)
    try {
      const result = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--release', lock, '--port', '0'], ...serving, env: { DSH_TELEMETRY_DISABLED: '1' } })

      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/beta: the directory differs from its release 1\.0\.0 \(sha256:[0-9a-f]{64}\): changed agent\.cordis\.yml/u)
    } finally {
      writeFileSync(composition, original)
    }
  })

  it('refuses a lock beside --agents, and a lock released on another dsh, as usage errors', async () => {
    const elsewhere = join(scratch.root, 'other-dsh', 'beta')
    cpSync(join(root, 'beta'), elsewhere, { recursive: true })
    const otherLock = join(elsewhere, 'agent.release.json')
    writeFileSync(otherLock, readFileSync(lock, 'utf8').replace(/"dshBase": "[^"]*"/u, '"dshBase": "0.0.1"'))

    const both = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--release', lock, '--agents', root], ...serving, env: { DSH_TELEMETRY_DISABLED: '1' } })
    const other = await bootComposition({ bundles: LYTEBOAT_SERVE_BUNDLES, args: ['--release', otherLock], ...serving, env: { DSH_TELEMETRY_DISABLED: '1' } })

    expect(both.code).not.toBe(0)
    expect(both.stderr).toContain('error: --release and --agents are exclusive')
    expect(other.code).not.toBe(0)
    expect(other.stderr).toMatch(/error: --release \S+ was released on dsh 0\.0\.1, but this build runs dsh \S+; release the agent again with this build/u)
  })
})
