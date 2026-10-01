import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_TEMPLATES as DSH_PROFILE_TEMPLATES, initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { LYTEBOAT_EVAL_BUNDLES, LYTEBOAT_HEADLESS_AGENT_BUNDLES, LYTEBOAT_SERVE_BUNDLES, LYTEBOAT_STUDIO_BUNDLES } from '@lyteboat/testing/composition'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkSkippedProfileBundles, ensureProfileInitialized } from '../src/profile-boot.ts'
import { LYTEBOAT_PROFILE_TEMPLATES } from '../src/templates.ts'

describe('lyteboat profile templates', () => {
  afterEach(() => { vi.restoreAllMocks() })

  test('a new headless-agent profile lists dsh-base, dsh-headless, the business base, and the business one-shot bundle', () => {
    const dir = lyteboatTempDir('home')
    ensureProfileInitialized('headless-agent', dir)
    const manifest = JSON.parse(readFileSync(join(resolveProfileDir('headless-agent', dir), 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    // The layers the composition tests boot as the headless-agent profile.
    expect(manifest.dsh.profile.bundles).toEqual(LYTEBOAT_HEADLESS_AGENT_BUNDLES)
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

  test('a native profile is dsh\'s own template of that name, with no lyteboat bundle', () => {
    for (const name of ['web', 'headless']) {
      const bundles = LYTEBOAT_PROFILE_TEMPLATES[name]?.bundles
      expect(bundles, name).toEqual(DSH_PROFILE_TEMPLATES[name]?.bundles)
      expect(bundles?.some(bundle => bundle.startsWith('@lyteboat/')), name).toBe(false)
    }
  })

  test('a business profile is dsh-base, any dsh app bundle it runs on, the business base, and one mode bundle last', () => {
    const business = Object.entries(LYTEBOAT_PROFILE_TEMPLATES).filter(([, template]) => template.bundles.includes('@lyteboat/base'))
    expect(business.map(([name]) => name).sort()).toEqual(['eval', 'headless-agent', 'inspect', 'serve', 'studio'])
    for (const [name, { bundles }] of business) {
      const base = bundles.indexOf('@lyteboat/base')
      expect(bundles[0], name).toBe('@deepseek-ai/dsh-base')
      expect(bundles.slice(1, base).every(bundle => bundle.startsWith('@deepseek-ai/')), name).toBe(true)
      expect(bundles.slice(base + 1), name).toHaveLength(1)
      expect(bundles.at(-1), name).toMatch(/^@lyteboat\//u)
    }
  })

  test('an existing profile whose bundle list predates the template fails loud with the fix', () => {
    const dir = lyteboatTempDir('home')
    initProfile(resolveProfileDir('headless-agent', dir), ['@deepseek-ai/dsh-base', '@lyteboat/headless'])
    expect(() => { ensureProfileInitialized('headless-agent', dir) }).toThrow(/profile "headless-agent" .* lists bundles \[@deepseek-ai\/dsh-base, @lyteboat\/headless\].*\[@deepseek-ai\/dsh-base, @deepseek-ai\/dsh-headless, @lyteboat\/base, @lyteboat\/headless\]/su)
  })

  test('an existing profile that matches the template boots unchanged', () => {
    const dir = lyteboatTempDir('home')
    ensureProfileInitialized('headless-agent', dir)
    const file = join(resolveProfileDir('headless-agent', dir), 'cordis.patch.yml')
    writeFileSync(file, '- id: session-title-llm\n  disabled: true\n')
    ensureProfileInitialized('headless-agent', dir)
    expect(readFileSync(file, 'utf8')).toBe('- id: session-title-llm\n  disabled: true\n')
  })

  test('a profile that dsh loaded without a bundle its template lists fails with the bundle and the reason', () => {
    const profile = { skippedBundles: [{ packageName: '@lyteboat/base', reason: 'Error: incompatible dsh peers' }] }
    expect(() => { checkSkippedProfileBundles('headless-agent', profile) })
      .toThrow('lyteboat: profile "headless-agent" cannot boot without the bundles its template lists; skipped: @lyteboat/base (Error: incompatible dsh peers)')
  })

  test('a profile without a lyteboat template reports a skipped bundle and boots on', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    checkSkippedProfileBundles('custom', { skippedBundles: [{ packageName: '@example/extra', reason: 'Error: not installed' }] })
    expect(stderr).toHaveBeenCalledWith('lyteboat: skipping profile bundle "@example/extra": Error: not installed\n')
  })
})
