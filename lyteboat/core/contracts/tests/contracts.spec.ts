import { describe, expect, it } from 'vitest'
import { LYTEBOAT_ASSISTANT_PROVIDER, lyteboatAgentReleaseSchema, type LyteboatIntakeDecision } from '@lyteboat/contracts'

describe('@lyteboat/contracts', () => {
  it('exports the lyteboat assistant provider name', () => {
    expect(LYTEBOAT_ASSISTANT_PROVIDER).toBe('lyteboat')
  })

  it('types intake decisions', () => {
    const pass: LyteboatIntakeDecision = { kind: 'pass' }
    const reply: LyteboatIntakeDecision = { kind: 'reply', plugin: 'x', content: [{ type: 'text', text: 'no' }] }
    expect([pass.kind, reply.kind]).toEqual(['pass', 'reply'])
  })

  it('reads a release lock only with a version, a digest, and 64-digit file hashes', () => {
    const lock = {
      agent: { id: 'finance', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
      dshBase: '0.2.0-rc.2',
      files: { 'agent.yml': 'b'.repeat(64) },
      baseline: { startedAt: '2026-09-26T00:00:00.000Z', cases: 6, turns: 7, checks: 30, results: `sha256:${'c'.repeat(64)}` },
    }

    expect(lyteboatAgentReleaseSchema.safeParse(lock).success).toBe(true)
    expect(lyteboatAgentReleaseSchema.safeParse({ ...lock, agent: { id: 'finance', digest: lock.agent.digest } }).success).toBe(false)
    expect(lyteboatAgentReleaseSchema.safeParse({ ...lock, files: { 'agent.yml': 'short' } }).success).toBe(false)
    expect(lyteboatAgentReleaseSchema.safeParse({ ...lock, extra: true }).success).toBe(false)
  })
})
