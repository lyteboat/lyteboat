import { defineConfig } from 'vitest/config'
import { UPSTREAM_TEST_EXCLUDES, upstreamTestsPlugin } from './dsh-compat/tests/upstream-harness/harness.ts'

// Workspace packages resolve to src through the `@lyteboat/source` export condition, never
// through their default export to built lib/, so a stale artifact can never load a second
// copy of a module singleton. The condition applies to every import site, including the
// ones vitest rewrites for hoisted `vi.mock` calls, and vitest hands it to Node as well.
// Composition tests therefore run in a project without it: the cordis loader imports
// plugin rows natively and must get lib/, which Node can load (src uses TypeScript
// parameter properties, which Node's type stripping rejects).
const conditions = ['@lyteboat/source']
const layers = '{lyteboat/{apps,bundles,plugins,core,test-support},examples/*}'

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        resolve: { conditions },
        ssr: { resolve: { conditions } },
        test: {
          name: 'source',
          include: [`${layers}/*/tests/**/*.{spec,e2e}.ts`, 'scripts/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        // G2: upstream's own tests of the kernel packages, unmodified; the harness
        // rebuilds upstream's source-resolution environment (dsh-compat/tests/upstream-harness).
        plugins: [upstreamTestsPlugin()],
        test: {
          name: 'dsh',
          include: ['dsh/*/*/tests/**/*.spec.ts'],
          exclude: UPSTREAM_TEST_EXCLUDES.map(entry => entry.file),
          setupFiles: ['dsh-compat/tests/upstream-harness/setup.ts', 'dsh-compat/tests/upstream-harness/test-invariants.ts'],
          server: { deps: { inline: [/@deepseek-ai\//u] } },
        },
      },
      {
        extends: true,
        test: {
          // G4–G6: the official release against lyteboat's kernel, in install trees outside the
          // repository (scripts/dist/trees.ts); `pnpm run dsh-compat`, not `pnpm run test`.
          name: 'dsh-compat',
          include: ['dsh-compat/tests/{scenarios,roundtrip,canaries}/**/*.spec.ts'],
          testTimeout: 300_000,
          // Every file packs the kernel and installs the same trees; run in parallel, a stale
          // tree is removed and reinstalled under another file's running pnpm.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'composite',
          include: [`${layers}/*/tests/**/*.composite.ts`],
        },
      },
    ],
  },
})
