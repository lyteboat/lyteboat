import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { LYTEBOAT_EVAL_BUNDLES, LYTEBOAT_TRY_BUNDLES, LYTEBOAT_SERVE_BUNDLES, LYTEBOAT_STUDIO_BUNDLES, LYTEBOAT_WEB_BUNDLES } from '@lyteboat/testing/composition'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkSkippedProfileBundles, ensureProfileInitialized } from '../src/profile-boot.ts'
import { LYTEBOAT_PROFILE_TEMPLATES } from '../src/templates.ts'

describe('lyteboat profile templates', () => {
  afterEach(() => { vi.restoreAllMocks() })

  test('a new try profile lists dsh-base, the host bundle, and the try bundle', () => {
    const dir = lyteboatTempDir('home')
    ensureProfileInitialized('try', dir)
    const manifest = JSON.parse(readFileSync(join(resolveProfileDir('try', dir), 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    // The layers the composition tests boot as the try profile.
    expect(manifest.dsh.profile.bundles).toEqual(LYTEBOAT_TRY_BUNDLES)
  })

  test('a web profile lists the layers the web composition tests boot', () => {
    expect(LYTEBOAT_PROFILE_TEMPLATES['web']?.bundles).toEqual(LYTEBOAT_WEB_BUNDLES)
  })

  test('a serve profile lists the layers the serve composition tests boot', () => {
    expect(LYTEBOAT_PROFILE_TEMPLATES['serve']?.bundles).toEqual(LYTEBOAT_SERVE_BUNDLES)
  })

  test('an eval profile lists the layers the eval composition tests boot', () => {
    expect(LYTEBOAT_PROFILE_TEMPLATES['eval']?.bundles).toEqual(LYTEBOAT_EVAL_BUNDLES)
  })

  test('a studio profile lists the layers the studio composition tests boot', () => {
    expect(LYTEBOAT_PROFILE_TEMPLATES['studio']?.bundles).toEqual(LYTEBOAT_STUDIO_BUNDLES)
  })

  test('an existing profile whose bundle list predates the template fails loud with the fix', () => {
    const dir = lyteboatTempDir('home')
    initProfile(resolveProfileDir('try', dir), ['@deepseek-ai/dsh-base', '@lyteboat/try'])
    expect(() => { ensureProfileInitialized('try', dir) }).toThrow(/profile "try" .* lists bundles \[@deepseek-ai\/dsh-base, @lyteboat\/try\].*\[@deepseek-ai\/dsh-base, @lyteboat\/host, @lyteboat\/business-base, @lyteboat\/try\]/su)
  })

  test('an existing profile that matches the template boots unchanged', () => {
    const dir = lyteboatTempDir('home')
    ensureProfileInitialized('try', dir)
    const file = join(resolveProfileDir('try', dir), 'cordis.patch.yml')
    writeFileSync(file, '- id: session-title-llm\n  disabled: true\n')
    ensureProfileInitialized('try', dir)
    expect(readFileSync(file, 'utf8')).toBe('- id: session-title-llm\n  disabled: true\n')
  })

  test('a profile that dsh loaded without a bundle its template lists fails with the bundle and the reason', () => {
    const profile = { skippedBundles: [{ packageName: '@lyteboat/host', reason: 'Error: incompatible dsh peers' }] }
    expect(() => { checkSkippedProfileBundles('try', profile) })
      .toThrow('lyteboat: profile "try" cannot boot without the bundles its template lists; skipped: @lyteboat/host (Error: incompatible dsh peers)')
  })

  test('a profile without a lyteboat template reports a skipped bundle and boots on', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    checkSkippedProfileBundles('custom', { skippedBundles: [{ packageName: '@example/extra', reason: 'Error: not installed' }] })
    expect(stderr).toHaveBeenCalledWith('lyteboat: skipping profile bundle "@example/extra": Error: not installed\n')
  })
})
