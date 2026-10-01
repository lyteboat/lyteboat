import { describe, expect, test } from 'vitest'
import { violations, type DistCommit } from './delta-report.ts'

function policyCommit(files: string[], trailers: Record<string, string>): DistCommit {
  return {
    sha: 'a1b2c3d4e5f60718',
    date: '2026-10-01',
    subject: 'dsh-base — policy: uploads off',
    trailers: new Map(Object.entries({ 'Dist-Change': 'policy', ...trailers }).map(([key, value]) => [key, [value]])),
    files,
  }
}

const ofCommit = (lines: string[]): string[] => lines.filter(line => line.startsWith('a1b2c3d4e5'))

describe('delta report: the policy class', () => {
  test('a policy commit that edits a bundle patch and names its policy passes', () => {
    const commit = policyCommit(['dsh/bundle/base/cordis.patch.yml'], { 'Dist-Policy': 'no session upload' })
    expect(ofCommit(violations([commit]))).toEqual([])
  })

  test('a policy commit without Dist-Policy is refused', () => {
    const commit = policyCommit(['dsh/bundle/base/cordis.patch.yml'], {})
    expect(ofCommit(violations([commit]))).toEqual(['a1b2c3d4e5 dsh-base — policy: uploads off: a policy change needs a Dist-Policy trailer'])
  })

  test('a policy commit that edits code is refused, naming the file', () => {
    const commit = policyCommit(['dsh/bundle/base/cordis.patch.yml', 'dsh/bundle/base/src/index.ts'], { 'Dist-Policy': 'no session upload' })
    expect(ofCommit(violations([commit]))).toEqual(['a1b2c3d4e5 dsh-base — policy: uploads off: a policy change edits bundles\' cordis.patch.yml only, not dsh/bundle/base/src/index.ts'])
  })
})
