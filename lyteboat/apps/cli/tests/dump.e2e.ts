import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LYTEBOAT_SERVE_BUNDLES } from '@lyteboat/testkit/composition'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LYTEBOAT_PROFILE_TEMPLATES } from '../src/templates.ts'
import { runLyteboat } from './support/lyteboat-process.ts'

/** The dumped YAML of one row, up to the next row or layer marker. */
function dumpedRow(dump: string, id: string): string {
  const start = dump.indexOf(`- id: ${id}\n`)
  expect(start, `row ${id}`).toBeGreaterThanOrEqual(0)
  const row = dump.slice(start)
  const end = row.slice(1).search(/\n(?:- id: |# == )/u)
  return end < 0 ? row : row.slice(0, end + 1)
}

describe('lyteboat config dump (built bin)', () => {
  let home: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'lyteboat-dump-home-'))
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('initializes the serve profile from lyteboat\'s template and prints its composition by default', async () => {
    const result = await runLyteboat(['config', 'dump'], { env: { LYTEBOAT_HOME: home } })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('@deepseek-ai/dsh-base')
    expect(result.stdout).toContain('@lyteboat/base')
    expect(result.stdout).toContain('@lyteboat/serve')
    expect(result.stdout).toContain('id: agent-loop')
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'serve', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile).toEqual({ bundles: LYTEBOAT_SERVE_BUNDLES })
  })

  it('starts no row that sends a session off the machine, in any lyteboat profile, without DSH_TELEMETRY_DISABLED', async () => {
    for (const profile of Object.keys(LYTEBOAT_PROFILE_TEMPLATES)) {
      const result = await runLyteboat(['config', 'dump', '--profile', profile], { env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: undefined } })
      expect(result.code, `${profile}: ${result.stderr}`).toBe(0)
      for (const id of ['session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel']) {
        expect(dumpedRow(result.stdout, id), `${profile}: ${id}`).toMatch(/^ {2}disabled: true$/mu)
      }
    }
  })

  it('refuses a profile an older lyteboat created with one line naming the fix, and no stack', async () => {
    const dir = join(home, 'profiles', 'serve')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'serve', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/serve'] } } }))

    const result = await runLyteboat(['config', 'dump', '--profile', 'serve'], { env: { LYTEBOAT_HOME: home } })

    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^lyteboat: profile "serve" at .* lists bundles \[@deepseek-ai\/dsh-base, @lyteboat\/host, @lyteboat\/serve\].*\n$/u)
    expect(result.stderr).not.toContain('    at ')
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints the version pair', async () => {
    const result = await runLyteboat(['--version'], { env: { LYTEBOAT_HOME: home } })
    expect(result.code).toBe(0)
    const { dsh } = JSON.parse(readFileSync(new URL('../../../../dsh.upstream.json', import.meta.url), 'utf8')) as { dsh: string }
    expect(result.stdout).toMatch(/^lyteboat \d+\.\d+\.\d+ \(dsh [^)]+\)\n$/u)
    expect(result.stdout).toContain(`(dsh ${dsh})`)
  })
})
