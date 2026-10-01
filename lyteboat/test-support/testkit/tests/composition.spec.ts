/**
 * The composition harness refuses to boot without a bundle the test asked
 * for, instead of running the composition that is left.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { bootComposition } from '../src/composition.ts'
import { createLyteboatScratch } from '../src/scratch.ts'

describe('bootComposition', () => {
  const scratch = createLyteboatScratch('composition-harness')

  afterAll(() => {
    scratch.remove()
  })

  it('bootComposition rejects with the profile\'s reason when a requested bundle cannot be loaded', async () => {
    const { home, workspace } = scratch.run('missing-bundle')

    const boot = bootComposition({ bundles: ['@deepseek-ai/dsh-base', '@lyteboat/no-such-bundle'], args: [], cwd: workspace, home, env: {} })

    await expect(boot).rejects.toThrow(/the profile skipped requested bundles: @lyteboat\/no-such-bundle \(/u)
  })
})
