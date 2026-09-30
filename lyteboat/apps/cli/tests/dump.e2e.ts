import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LYTEBOAT_TRY_BUNDLES } from '@lyteboat/testing/composition'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  it('initializes the try profile from lyteboat\'s template and prints its composition', async () => {
    const result = await runLyteboat(['config', 'dump', '--profile', 'try'], { env: { LYTEBOAT_HOME: home } })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('@deepseek-ai/dsh-base')
    expect(result.stdout).toContain('@lyteboat/host')
    expect(result.stdout).toContain('@lyteboat/try')
    expect(result.stdout).toContain('id: agent-loop')
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'try', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile).toEqual({ bundles: LYTEBOAT_TRY_BUNDLES })
  })

  it('keeps dsh-base\'s feedback telemetry export off in both profiles, without DSH_TELEMETRY_DISABLED', async () => {
    for (const profile of ['try', 'web']) {
      const result = await runLyteboat(['config', 'dump', '--profile', profile], { env: { LYTEBOAT_HOME: home, DSH_TELEMETRY_DISABLED: undefined } })
      expect(result.code, result.stderr).toBe(0)
      expect(dumpedRow(result.stdout, 'session-telemetry-otel')).toMatch(/^ {2}disabled: true$/mu)
    }
  })

  it('keeps the session log off the provider in the web profile, with no Settings switch that turns it on', async () => {
    const result = await runLyteboat(['config', 'dump', '--profile', 'web'], { env: { LYTEBOAT_HOME: home } })
    expect(result.code, result.stderr).toBe(0)
    expect(dumpedRow(result.stdout, 'session-log-deepseek')).toMatch(/^ {4}enabled: false$/mu)
    expect(dumpedRow(result.stdout, 'ui-settings-session-log')).toMatch(/^ {2}disabled: true$/mu)
  })

  it('prints the version pair', async () => {
    const result = await runLyteboat(['--version'], { env: { LYTEBOAT_HOME: home } })
    expect(result.code).toBe(0)
    const { dsh } = JSON.parse(readFileSync(new URL('../../../../dsh.upstream.json', import.meta.url), 'utf8')) as { dsh: string }
    expect(result.stdout).toMatch(/^lyteboat \d+\.\d+\.\d+ \(dsh [^)]+\)\n$/u)
    expect(result.stdout).toContain(`(dsh ${dsh})`)
  })
})
