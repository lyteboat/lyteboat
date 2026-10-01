import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { scriptedModelEnv } from '@lyteboat/testing/scripted-model'
import { runLyteboat, startLyteboat } from './support/lyteboat-process.ts'

const SUCCESS_TEXT = 'NATIVE-HEADLESS-OK'
const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

/** A skill in the shared agent configuration root (`DSH_AGENTS_HOME/skills`), as a person's own `~/.agents` would hold it. */
const STRAY_SKILL = 'shared-root-probe'

describe('the native base: dsh\'s own apps on lyteboat\'s kernel (built bin, mock model)', () => {
  const scratch = createLyteboatScratch('native')
  let mock: MockLlmServer
  let agentsHome: string

  beforeAll(async () => {
    mock = await startMockLlmServer({ port: 0, apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: SUCCESS_TEXT })
    agentsHome = join(scratch.root, 'shared-agents')
    mkdirSync(join(agentsHome, 'skills', STRAY_SKILL), { recursive: true })
    writeFileSync(join(agentsHome, 'skills', STRAY_SKILL, 'SKILL.md'), `---\nname: ${STRAY_SKILL}\ndescription: A skill a person keeps in their own agent root.\n---\nPROBE-BODY\n`)
  })

  afterAll(async () => {
    await mock.close()
    scratch.remove()
  })

  it('lyteboat headless answers one task as dsh headless does: dsh\'s coding persona, the shared skill root, and no upload on the request', async () => {
    const { home, workspace } = scratch.run('headless')
    const before = mock.requests.length

    const result = await runLyteboat(['headless', 'say hello'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_AGENTS_HOME: agentsHome, ...scriptedModelEnv(mock) } })

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(`${SUCCESS_TEXT}\n`)
    const sent = mock.requests.slice(before)
    // The loop's request and dsh's session-title side call, as dsh headless sends them (the business base turns titles off).
    const loop = sent.filter(request => JSON.stringify(request.body).includes('You are a coding agent'))
    expect(sent).toHaveLength(2)
    expect(loop).toHaveLength(1)
    expect(sent.some(request => JSON.stringify(request.body).includes('Generate the session title'))).toBe(true)
    // dsh-headless's own persona and the shared skill root reach the model: the native base adds and removes nothing.
    expect(JSON.stringify(loop[0]?.body)).toContain(STRAY_SKILL)
    // The kernel's dsh-base keeps the session uploads off.
    for (const request of sent) {
      expect(request.body).not.toHaveProperty('dsh_session_log')
      expect(request.body).not.toHaveProperty('dsh_plugin_packages')
    }
  })

  it('a business agent reads neither the shared skill root nor dsh-headless\'s coding persona that a native run gets', async () => {
    const { home, workspace } = scratch.run('business')
    const before = mock.requests.length

    const result = await runLyteboat(['headless', '--agents', AGENTS, '--agent', 'echo', 'say hello'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_AGENTS_HOME: agentsHome, ...scriptedModelEnv(mock) } })

    expect(result.code, result.stderr).toBe(0)
    const sent = mock.requests.slice(before)
    expect(sent.length).toBeGreaterThan(0)
    for (const request of sent) {
      expect(JSON.stringify(request)).not.toContain(STRAY_SKILL)
      expect(JSON.stringify(request)).not.toContain('You are a coding agent')
    }
  })

  it('lyteboat web serves dsh\'s web app and accepts its sign-in token', async () => {
    const { home, workspace } = scratch.run('web')
    const lyteboat = startLyteboat(['web', '--no-open', '--port', '0'], { cwd: workspace, env: { LYTEBOAT_HOME: home, DSH_AGENTS_HOME: agentsHome, ...scriptedModelEnv(mock) } })
    try {
      const url = (await lyteboat.waitForStdout(/^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)$/mu, 90_000))[1] ?? ''

      const response = await fetch(url, { redirect: 'manual' })

      expect(response.status).toBe(303)
    } finally {
      await lyteboat.stop('SIGTERM')
    }
  })
})
