import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_TEMPLATES as DSH_PROFILE_TEMPLATES, initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { LYTEBOAT_EVAL_BUNDLES, LYTEBOAT_SERVE_BUNDLES, LYTEBOAT_STUDIO_BUNDLES } from '@lyteboat/testkit/composition'
import { lyteboatTempDir } from '@lyteboat/testkit/scratch'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkSkippedProfileBundles, ensureProfileInitialized } from '../src/profile-boot.ts'
import { LYTEBOAT_PROFILE_TEMPLATES } from '../src/templates.ts'

describe('lyteboat profile templates', () => {
  afterEach(() => { vi.restoreAllMocks() })

  test('a new serve profile lists the layers the serve composition tests boot: dsh-base, the business base, and the service bundle', () => {
    const dir = lyteboatTempDir('home')
    ensureProfileInitialized('serve', dir)
    const manifest = JSON.parse(readFileSync(join(resolveProfileDir('serve', dir), 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(LYTEBOAT_SERVE_BUNDLES)
  })

  test('an eval profile lists the layers the eval composition tests boot', () => {
    expect(LYTEBOAT_PROFILE_TEMPLATES['eval']?.bundles).toEqual(LYTEBOAT_EVAL_BUNDLES)
  })

  test('a studio profile lists the layers the studio composition tests boot', () => {
    expect(LYTEBOAT_PROFILE_TEMPLATES['studio']?.bundles).toEqual(LYTEBOAT_STUDIO_BUNDLES)
  })

  test('a native profile is dsh\'s own template of that name, with no lyteboat bundle', () => {
    for (const name of ['web', 'headless']) {
      const bundles = LYTEBOAT_PROFILE_TEMPLATES[name]?.bundles
      expect(bundles, name).toEqual(DSH_PROFILE_TEMPLATES[name]?.bundles)
      expect(bundles?.some(bundle => bundle.startsWith('@lyteboat/')), name).toBe(false)
    }
  })

  test('a business profile is dsh-base, the business base, and one mode bundle', () => {
    const business = Object.entries(LYTEBOAT_PROFILE_TEMPLATES).filter(([, template]) => template.bundles.includes('@lyteboat/base'))
    expect(business.map(([name]) => name).sort()).toEqual(['eval', 'inspect', 'serve', 'studio'])
    for (const [name, { bundles }] of business) {
      expect(bundles, name).toEqual(['@deepseek-ai/dsh-base', '@lyteboat/base', `@lyteboat/${name}`])
    }
  })

  test('an existing profile whose bundle list predates the template fails loud with the fix', () => {
    const dir = lyteboatTempDir('home')
    initProfile(resolveProfileDir('serve', dir), ['@deepseek-ai/dsh-base', '@lyteboat/serve'])
    expect(() => { ensureProfileInitialized('serve', dir) }).toThrow(/profile "serve" .* lists bundles \[@deepseek-ai\/dsh-base, @lyteboat\/serve\].*\[@deepseek-ai\/dsh-base, @lyteboat\/base, @lyteboat\/serve\]/su)
  })

  test('an existing profile whose bundles start with the template boots with the bundles installed after them', () => {
    const dir = lyteboatTempDir('home')
    const installed = [...LYTEBOAT_PROFILE_TEMPLATES['web']?.bundles ?? [], 'dsh-wenmai']
    initProfile(resolveProfileDir('web', dir), installed)
    expect(() => { ensureProfileInitialized('web', dir) }).not.toThrow()
    const manifest = JSON.parse(readFileSync(join(resolveProfileDir('web', dir), 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toEqual(installed)
  })

  test('an existing profile that matches the template boots unchanged', () => {
    const dir = lyteboatTempDir('home')
    ensureProfileInitialized('serve', dir)
    const file = join(resolveProfileDir('serve', dir), 'cordis.patch.yml')
    writeFileSync(file, '- id: session-title-llm\n  disabled: true\n')
    ensureProfileInitialized('serve', dir)
    expect(readFileSync(file, 'utf8')).toBe('- id: session-title-llm\n  disabled: true\n')
  })

  test('a profile that dsh loaded without a bundle its template lists fails with the bundle and the reason', () => {
    const profile = { skippedBundles: [{ packageName: '@lyteboat/base', reason: 'Error: incompatible dsh peers' }] }
    expect(() => { checkSkippedProfileBundles('serve', profile) })
      .toThrow('lyteboat: profile "serve" cannot boot without the bundles its template lists; skipped: @lyteboat/base (Error: incompatible dsh peers)')
  })

  test('a profile without a lyteboat template reports a skipped bundle and boots on', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    checkSkippedProfileBundles('custom', { skippedBundles: [{ packageName: '@example/extra', reason: 'Error: not installed' }] })
    expect(stderr).toHaveBeenCalledWith('lyteboat: skipping profile bundle "@example/extra": Error: not installed\n')
  })
})
