/**
 * G2 harness: runs upstream's own tests of the kernel packages
 * (`dsh/<group>/<package>/tests`) unmodified, outside upstream's monorepo.
 * Upstream runs them with a resolution facade that maps every `@deepseek-ai/*`
 * package to its TypeScript source and with the vendored cordis sources; this
 * module rebuilds exactly that environment for the kernel and states every
 * difference (README.md beside it lists them with their reasons).
 *
 * - Kernel package names and export subpaths resolve to the kernel's `src/`,
 *   so a test's relative `../src/x.ts` import and a package-name import of the
 *   same module are one module instance, as in upstream.
 * - Every other `@deepseek-ai/*` package is inlined (processed by vite, not
 *   loaded natively), so its own imports of kernel packages take the same
 *   route instead of loading the published bundles beside the sources.
 * - `@deepseek-ai/cordis` resolves to a module that re-exports the published
 *   build and adds the runtime values of its `declare const enum`s
 *   (`FiberState`, …): upstream compiles against cordis sources, where those
 *   enums exist at runtime; the published build erases them.
 * - Two imports of files no published package ships resolve to shims.
 * - TypeScript sources with standard decorators are lowered before vite parses
 *   them, as upstream's `standardDecoratorPlugin` (vitest.shared.ts) does.
 * - Tests of upstream's repository scripts are excluded.
 * @module dsh-compat/tests/upstream-harness/harness
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Plugin } from 'vitest/config'
import { kernelPackages } from '../../../scripts/dist/kernel.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(repoRoot, 'package.json'))

/**
 * The browser-face specs of every kernel package that carries its browser face
 * as published (scripts/dist/client-face.ts): they run in upstream's DOM lane
 * against the browser build, which lyteboat neither builds nor changes.
 */
function browserFaceSpecs(): { file: string; reason: string }[] {
  return kernelPackages().map(({ dir }) => dir)
    .filter(dir => (JSON.parse(readFileSync(join(repoRoot, 'dsh', dir, 'package.json'), 'utf8')) as { dsh?: { client?: unknown } }).dsh?.client !== undefined)
    .map(dir => ({
      file: `dsh/${dir}/tests/**/*.client.spec.ts`,
      reason: 'browser-face specs run in upstream\'s DOM lane against the browser build, which lyteboat carries as published and does not change',
    }))
}

/** Test files G2 does not run: tests of upstream's repository tooling (`scripts/`), and the browser-face specs of carried browser faces. */
export const UPSTREAM_TEST_EXCLUDES: readonly { file: string; reason: string }[] = [
  { file: 'dsh/core/tools/tests/gen-tool-catalog.spec.ts', reason: 'tests upstream scripts/gen-tool-catalog.ts, which lyteboat does not carry' },
  { file: 'dsh/core/session/tests/gen-persistence-catalog.spec.ts', reason: 'tests upstream scripts/gen-persistence-catalog.ts; the overlay persistence gate runs that script on lyteboat\'s sources' },
  { file: 'dsh/core/agent/tests/verify-export-jsdoc.spec.ts', reason: 'tests upstream scripts/verify-export-jsdoc.ts, a repository lint' },
  ...browserFaceSpecs(),
]

/** Imports of files no published package ships, by the importer-relative or bare specifier upstream writes. */
const SHIMS: Readonly<Record<string, string>> = {
  '../../../settings/settings/tests/live-config.ts': 'shims/live-config.ts',
  '@deepseek-ai/dsh-llm-pi-ai/src/context.ts': 'shims/pi-context.ts',
  '../../../settings/settings/tests/configuration-fixture.ts': 'shims/configuration-fixture.ts',
  '@deepseek-ai/dsh-subagent/src/projection.ts': 'shims/subagent-projection.ts',
}

const CORDIS_SHIM = '\0lyteboat-upstream-tests:cordis'

const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/mu

interface KernelEntry {
  name: string
  dir: string
  /** export subpath (`.`, `./invariant`, …) → source file */
  subpaths: Map<string, string>
}

function kernelEntries(): KernelEntry[] {
  return kernelPackages().map(({ name, dir }) => {
    const packageDir = join(repoRoot, 'dsh', dir)
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { exports: Record<string, unknown> }
    const subpaths = new Map<string, string>()
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (typeof target !== 'object' || target === null) continue
      const types = (target as { types?: string }).types
      // Upstream emits src/X.ts to lib/types/X.d.ts, so the declaration path names the source.
      const match = types === undefined ? null : /^\.\/lib\/types\/(.+)\.d\.ts$/u.exec(types)
      if (match?.[1] !== undefined) subpaths.set(subpath, join(packageDir, 'src', `${match[1]}.ts`))
    }
    return { name, dir: packageDir, subpaths }
  })
}

/** The members of every `declare const enum` in the published cordis declarations, as runtime objects. */
function cordisConstEnums(): string {
  const typesDir = join(dirname(require.resolve('@deepseek-ai/cordis')), 'types')
  const out: string[] = []
  for (const file of ['fiber.d.ts', 'logger.d.ts']) {
    const text = readFileSync(join(typesDir, file), 'utf8')
    for (const match of text.matchAll(/export declare const enum (\w+) \{([^}]*)\}/gu)) {
      const members = [...(match[2] ?? '').matchAll(/(\w+)\s*=\s*(-?\d+)/gu)].map(([, key, value]) => `${String(key)}: ${String(value)}`)
      out.push(`export const ${String(match[1])} = Object.freeze({ ${members.join(', ')} })`)
    }
  }
  return out.join('\n')
}

/** The resolution facade and the cordis module described above. */
export function upstreamTestsPlugin(): Plugin {
  const kernel = kernelEntries()
  const cordisEntry = require.resolve('@deepseek-ai/cordis')
  const shimDir = fileURLToPath(new URL('.', import.meta.url))
  return {
    name: 'lyteboat-upstream-tests',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@deepseek-ai/cordis') return importer === CORDIS_SHIM ? null : CORDIS_SHIM
      const shim = SHIMS[source]
      if (shim !== undefined) return join(shimDir, shim)
      for (const entry of kernel) {
        if (source !== entry.name && !source.startsWith(`${entry.name}/`)) continue
        const subpath = source === entry.name ? '.' : `.${source.slice(entry.name.length)}`
        const file = entry.subpaths.get(subpath) ?? (subpath.startsWith('./src/') ? join(entry.dir, subpath) : undefined)
        if (file !== undefined && existsSync(file)) return file
      }
      return null
    },
    load(id) {
      if (id !== CORDIS_SHIM) return null
      return [`export * from ${JSON.stringify(cordisEntry)}`, cordisConstEnums()].join('\n')
    },
    // dsh-llm's source uses standard decorators (`@Remote`), which vite's parser does not lower.
    transform(code, id) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/u.test(file) || !DECORATOR_SYNTAX.test(code)) return null
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, sourceMap: true },
      })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText ?? null }
    },
  }
}
