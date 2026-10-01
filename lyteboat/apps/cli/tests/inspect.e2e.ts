/**
 * `lyteboat inspect` on the built launcher: the echo agent mounts and prints
 * what it is made of as one result object (exit 0); no root holding the named
 * agent is a usage error (exit 2). No model is called.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { lyteboatInspectResultSchema } from '@lyteboat/contracts/cli'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { runLyteboat } from './support/lyteboat-process.ts'

const AGENTS = fileURLToPath(new URL('./fixtures/agents', import.meta.url))

describe('lyteboat inspect (built bin)', () => {
  const scratch = createLyteboatScratch('inspect-smoke')

  afterAll(() => {
    scratch.remove()
  })

  it('prints a mounted agent as one result object', async () => {
    const { home, workspace } = scratch.run('inspect')
    const run = await runLyteboat(['inspect', '--agents', AGENTS, '--agent', 'echo', '--result', 'json'], { cwd: workspace, env: { LYTEBOAT_HOME: home } })

    expect(run.code, run.stderr).toBe(0)
    const result = lyteboatInspectResultSchema.parse(JSON.parse(run.stdout))
    expect(result).toMatchObject({ agent: 'echo', mounted: true, skills: [], cases: [{ file: 'evals/cases.yml', cases: ['smoke'] }] })
  })

  it('is a usage error when no root holds the agent', async () => {
    const { home, workspace } = scratch.run('unknown')
    const run = await runLyteboat(['inspect', '--agents', AGENTS, '--agent', 'nobody'], { cwd: workspace, env: { LYTEBOAT_HOME: home } })

    expect(run.code).toBe(2)
    expect(run.stderr).toContain('nobody')
  })
})
