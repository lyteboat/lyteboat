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

function commit(sha: string, subject: string, trailers: Record<string, string[]>): DistCommit {
  return { sha, date: '2026-11-05', subject, trailers: new Map(Object.entries(trailers)), files: ['dsh/core/session/src/index.ts'] }
}

describe('delta report: dropping an extension', () => {
  const added = commit('1111111111aa', 'dsh-session — extend: marker', { 'Dist-Change': ['extend'], 'Dist-Extension': ['marker'] })
  const kept = commit('2222222222bb', 'dsh-session — extend: kept', { 'Dist-Change': ['extend'], 'Dist-Extension': ['kept'] })

  test('a drop commit retires the extension, so the commits that added it stay valid', () => {
    const dropped = commit('3333333333cc', 'dsh-session — drop: marker', { 'Dist-Change': ['drop'], 'Dist-Exit': ['upstream API'], 'Dist-Extension': ['marker'] })
    expect(violations([added, kept, dropped], new Set(['kept']))).toEqual([])
  })

  test('an extension removed from the registry without a drop commit is refused', () => {
    expect(violations([added, kept], new Set(['kept']))).toEqual(['1111111111 dsh-session — extend: marker: Dist-Extension marker is not in dsh-compat/contract/extensions.yml'])
  })

  test('a drop commit whose extension is still registered is refused', () => {
    const dropped = commit('3333333333cc', 'dsh-session — drop: marker', { 'Dist-Change': ['drop'], 'Dist-Exit': ['upstream API'], 'Dist-Extension': ['marker'] })
    expect(violations([added, kept, dropped], new Set(['kept', 'marker']))).toEqual([
      '3333333333 dsh-session — drop: marker: drops marker, which is still in dsh-compat/contract/extensions.yml',
    ])
  })
})
