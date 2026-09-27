/**
 * An agent directory's digest: stable for the same files, sensitive to any
 * counted file, blind to the excluded ones, and never ambiguous.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { agentDigest } from '../src/agent-digest.ts'

describe('agentDigest', () => {
  /** A fresh directory holding the given files (path → content), written in the given order. */
  function tree(files: Record<string, string>): string {
    const dir = lyteboatTempDir('agent-digest')
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    return dir
  }

  it('gives the same files the same digest whatever order they were written in, and lists each file\'s hash', () => {
    const first = agentDigest(tree({ 'agent.cordis.yml': '[]\n', 'lib/agent.js': 'x', 'assets/a.md': 'a' }))
    const second = agentDigest(tree({ 'assets/a.md': 'a', 'lib/agent.js': 'x', 'agent.cordis.yml': '[]\n' }))

    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(second).toEqual(first)
    expect(Object.keys(first.files)).toEqual(['agent.cordis.yml', 'assets/a.md', 'lib/agent.js'])
  })

  it('changes when any counted file changes, and cannot confuse a path with a content', () => {
    const base = agentDigest(tree({ 'agent.cordis.yml': '[]\n', 'lib/agent.js': 'x' })).digest

    expect(agentDigest(tree({ 'agent.cordis.yml': '[]\n', 'lib/agent.js': 'y' })).digest).not.toBe(base)
    expect(agentDigest(tree({ 'x': 'yz' })).digest).not.toBe(agentDigest(tree({ 'xy': 'z' })).digest)
  })

  it('gives a text file checked out with CRLF line endings the hash of its LF form, and hashes a binary file as it is', () => {
    const lf = agentDigest(tree({ 'agent.cordis.yml': '- id: a\n- id: b\n', 'assets/skills/a/SKILL.md': '# A\n\nbody\n' }))
    const crlf = agentDigest(tree({ 'agent.cordis.yml': '- id: a\r\n- id: b\r\n', 'assets/skills/a/SKILL.md': '# A\r\n\r\nbody\r\n' }))

    expect(crlf).toEqual(lf)
    expect(agentDigest(tree({ 'assets/icon.bin': '\0\r\n' })).digest).not.toBe(agentDigest(tree({ 'assets/icon.bin': '\0\n' })).digest)
  })

  it('leaves out top-level tests, evals, and the release lock, and node_modules, dot entries, and build info at any depth', () => {
    const base = agentDigest(tree({ 'agent.cordis.yml': '[]\n', 'src/tests/case.ts': 'kept' }))

    const noisy = agentDigest(tree({
      'agent.cordis.yml': '[]\n',
      'src/tests/case.ts': 'kept',
      'tests/agent.spec.ts': 'left out',
      'evals/baseline/run.json': '{}',
      'agent.release.json': '{}',
      'node_modules/x/index.js': 'left out',
      'lib/node_modules/y.js': 'left out',
      '.env': 'SECRET=1',
      'assets/.cache/z': 'left out',
      'tsconfig.tsbuildinfo': '{}',
    }))

    expect(noisy).toEqual(base)
    expect(Object.keys(base.files)).toEqual(['agent.cordis.yml', 'src/tests/case.ts'])
  })

  it('refuses a symbolic link outside the excluded entries', () => {
    const dir = tree({ 'agent.cordis.yml': '[]\n', 'assets/real.md': 'a' })
    symlinkSync(join(dir, 'assets', 'real.md'), join(dir, 'assets', 'link.md'))

    expect(() => agentDigest(dir)).toThrow(`agent-catalog: ${join(dir, 'assets/link.md')} is a symbolic link; an agent's digest covers regular files only`)
  })
})
