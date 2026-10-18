/**
 * Gates that need upstream's own repository: lyteboat's kernel is laid over a
 * checkout of the pinned tag (one with `pnpm install` done), and upstream's
 * tooling runs against it.
 *
 * - `persistence`: upstream's `gen-persistence-catalog` regenerates the
 *   durable-record schema from the overlaid sources; its fingerprint must equal
 *   `dsh-compat/contract/dsh-<version>/persistence.json` except for keys an extension
 *   registers, and the regenerated `known-event-types.ts` must equal lyteboat's.
 * - `g3`: G3, the cross-package gate. The tests of every upstream package that
 *   depends on a kernel package run on the pristine checkout (the baseline,
 *   cached per tag) and on the overlay; a test that passes on the baseline and
 *   fails on the overlay fails the gate.
 * - `typert`: upstream's Typert generator emits, from lyteboat's sources, the
 *   `lib/typert.*` files of every kernel package that publishes them; they must
 *   equal the files lyteboat builds with. `--write` replaces lyteboat's files and records
 *   the source digest in `dsh/typert.json` (scripts/dist/typert.ts).
 *
 *   node --import tsx scripts/dist/overlay.ts <upstream checkout> persistence
 *   node --import tsx scripts/dist/overlay.ts <upstream checkout> g3 [--match <regex on package dir>]
 *   node --import tsx scripts/dist/overlay.ts <upstream checkout> typert [--write]
 *
 * The overlay copies every file lyteboat has under `dsh/<dir>/` onto
 * `packages/<dir>/` and removes the upstream files lyteboat deleted; `package.json`
 * and `tsconfig.json` stay upstream's, because lyteboat's are normalized for its
 * own workspace. The checkout is reset before and after.
 * @module scripts/dist/overlay
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { KEY_SEPARATOR, compareContract, flatten, readExtensions } from './contract-check.ts'
import { WorkspaceTypertGenerator, type WorkspaceEmitResult } from '@deepseek-ai/dsh-typert-generator'
import { git, kernelPackages, readUpstreamPin, repoRoot, stableJson } from './kernel.ts'
import { distCache } from './trees.ts'
import { kernelTypertFiles, publishedTypertFiles, typertSourceDigest, writeTypertStamp } from './typert.ts'

const NORMALIZED = new Set(['package.json', 'tsconfig.json'])

function kernelPaths(): string[] {
  return kernelPackages().map(({ dir }) => `packages/${dir}`)
}

function reset(checkout: string): void {
  git(checkout, ['checkout', '--force', 'HEAD', '--', 'packages', 'docs'])
  git(checkout, ['clean', '-fdq', '--', ...kernelPaths()])
}

function applyOverlay(checkout: string): void {
  const pin = readUpstreamPin()
  const head = git(checkout, ['rev-parse', 'HEAD'])
  if (head !== pin.commit) throw new Error(`${checkout} is at ${head}; dsh.upstream.json pins ${pin.commit} (${pin.tag})`)
  reset(checkout)
  for (const { dir } of kernelPackages()) {
    const lyteboatFiles = new Set(git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '--', `dsh/${dir}`]).split('\n')
      .filter(file => file !== '' && existsSync(join(repoRoot, file)))
      .map(file => relative(`dsh/${dir}`, file)))
    for (const file of git(checkout, ['ls-files', '--', `packages/${dir}`]).split('\n').filter(line => line !== '')) {
      const rel = relative(`packages/${dir}`, file)
      if (!lyteboatFiles.has(rel) && !NORMALIZED.has(rel)) rmSync(join(checkout, file))
    }
    for (const rel of lyteboatFiles) {
      if (NORMALIZED.has(rel)) continue
      const destination = join(checkout, 'packages', dir, rel)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(join(repoRoot, 'dsh', dir, rel), destination)
    }
  }
}

interface PersistenceFingerprint {
  roots: Record<string, { kind: string; digest: string }>
  typeDigests: string[]
}

/** The fingerprint of an upstream `persistence-schema.json`: root digests and the set of type digests. */
export function persistenceFingerprint(schemaText: string): PersistenceFingerprint & { sha256: string; formatVersion: number } {
  const schema = JSON.parse(schemaText) as { formatVersion: number; roots: { key: string; kind: string; digest: string }[]; types: { digest: string }[] }
  return {
    sha256: createHash('sha256').update(schemaText).digest('hex'),
    formatVersion: schema.formatVersion,
    roots: Object.fromEntries(schema.roots.map(root => [root.key, { kind: root.kind, digest: root.digest }])),
    typeDigests: schema.types.map(type => type.digest).sort(),
  }
}

function comparable(fingerprint: PersistenceFingerprint): unknown {
  return { roots: fingerprint.roots, types: Object.fromEntries(fingerprint.typeDigests.map(digest => [digest, true])) }
}

function persistence(checkout: string): number {
  applyOverlay(checkout)
  try {
    execFileSync(join(checkout, 'node_modules/.bin/tsx'), ['scripts/gen-persistence-catalog.ts'], { cwd: checkout, stdio: ['ignore', 'inherit', 'inherit'] })
    const regenerated = persistenceFingerprint(readFileSync(join(checkout, 'docs/persistence-schema.json'), 'utf8'))
    const { dsh } = readUpstreamPin()
    const snapshot = JSON.parse(readFileSync(join(repoRoot, 'dsh-compat/contract', `dsh-${dsh}`, 'persistence.json'), 'utf8')) as PersistenceFingerprint
    const comparison = compareContract(
      flatten(comparable(snapshot), ['persistence']),
      flatten(comparable(regenerated), ['persistence']),
      readExtensions().map(extension => ({ ...extension, contract: extension.contract.filter(entry => entry.startsWith(`persistence${KEY_SEPARATOR}`)) })),
    )
    let failures = comparison.removed.length + comparison.unregistered.length + comparison.stale.length
    for (const key of comparison.removed) console.error(`persistence removed: ${key}`)
    for (const { key } of comparison.unregistered) console.error(`persistence unregistered difference: ${key}`)
    for (const { extension, entry } of comparison.stale) console.error(`persistence stale registration: ${extension} lists ${entry}`)
    const generatedKnown = readFileSync(join(checkout, 'packages/core/session/src/known-event-types.ts'), 'utf8')
    if (generatedKnown !== readFileSync(join(repoRoot, 'dsh/core/session/src/known-event-types.ts'), 'utf8')) {
      console.error('persistence: dsh/core/session/src/known-event-types.ts differs from what upstream generates from lyteboat\'s sources; regenerate it')
      failures += 1
    }
    console.log(`persistence vs dsh ${dsh}: ${String(Object.keys(regenerated.roots).length)} roots, ${String(regenerated.typeDigests.length)} types, `
      + `${String(comparison.registered.length)} registered difference(s), ${String(failures)} failure(s)`)
    return failures
  } finally {
    reset(checkout)
  }
}

/** The spec files under an upstream package's `tests/`, as paths in the checkout. */
function packageSpecFiles(checkout: string, dir: string): string[] {
  const tests = join(checkout, 'packages', dir, 'tests')
  if (!existsSync(tests)) return []
  return readdirSync(tests, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.spec\.tsx?$/u.test(file))
    .map(file => `packages/${dir}/tests/${file}`)
}

/** Dependent spec files G3 does not run: they check upstream's repository, not the dependent package's behavior on the kernel. */
const G3_TEST_EXCLUDES: readonly { file: string; reason: string }[] = [
  { file: 'packages/typert/generator/tests/cordis-catalog.spec.ts', reason: 'regenerates upstream\'s docs/cordis-api pages from the whole workspace and compares them with the committed ones, which list no event a kernel extension declares' },
]

/** Upstream packages outside the kernel that declare a dependency on a kernel package. */
function dependentTestFiles(checkout: string, match: RegExp): string[] {
  const kernel = new Set(kernelPackages().map(pkg => pkg.name))
  const kernelDirs = new Set(kernelPackages().map(pkg => pkg.dir))
  const files: string[] = []
  for (const group of readdirSync(join(checkout, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(checkout, 'packages', group.name), { withFileTypes: true })) {
      const dir = `${group.name}/${pkg.name}`
      const manifestPath = join(checkout, 'packages', dir, 'package.json')
      if (!pkg.isDirectory() || kernelDirs.has(dir) || !match.test(dir) || !existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, Record<string, string> | undefined>
      const deps = { ...manifest['dependencies'], ...manifest['peerDependencies'], ...manifest['devDependencies'] }
      if (Object.keys(deps).some(name => kernel.has(name))) files.push(...packageSpecFiles(checkout, dir))
    }
  }
  const excluded = new Set(G3_TEST_EXCLUDES.map(entry => entry.file))
  return files.filter(file => !excluded.has(file)).sort()
}

interface VitestReport {
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[]
}

/** Run upstream's vitest on `files`; returns `<file> › <test>` → status. */
function runVitest(checkout: string, files: readonly string[], out: string): Map<string, string> {
  rmSync(out, { force: true })
  spawnSync(join(checkout, 'node_modules/.bin/vitest'), ['run', '--reporter=json', `--outputFile=${out}`, ...files], {
    cwd: checkout,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
  })
  if (!existsSync(out)) throw new Error(`vitest wrote no report to ${out}`)
  const report = JSON.parse(readFileSync(out, 'utf8')) as VitestReport
  const results = new Map<string, string>()
  for (const file of report.testResults) {
    const rel = relative(checkout, file.name)
    for (const test of file.assertionResults) results.set(`${rel}${KEY_SEPARATOR}${test.fullName}`, test.status)
  }
  return results
}

function g3(checkout: string, match: RegExp): number {
  const { dsh } = readUpstreamPin()
  const files = dependentTestFiles(checkout, match)
  const baselinePath = join(distCache, `g3-baseline-${dsh}-${createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12)}.json`)
  let baseline: Map<string, string>
  if (existsSync(baselinePath)) {
    baseline = new Map(Object.entries(JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, string>))
  } else {
    reset(checkout)
    baseline = runVitest(checkout, files, join(distCache, 'g3-baseline-run.json'))
    writeFileSync(baselinePath, stableJson(Object.fromEntries(baseline)))
  }
  applyOverlay(checkout)
  let overlay: Map<string, string>
  try {
    overlay = runVitest(checkout, files, join(distCache, 'g3-overlay-run.json'))
  } finally {
    reset(checkout)
  }
  let regressions = 0
  for (const [test, status] of baseline) {
    if (status !== 'passed') continue
    const now = overlay.get(test)
    if (now === 'passed') continue
    regressions += 1
    console.error(`G3 regression: ${test} (${now ?? 'missing'})`)
  }
  const passed = [...baseline.values()].filter(status => status === 'passed').length
  console.log(`G3 vs dsh ${dsh}: ${String(files.length)} test files of kernel dependents, ${String(passed)} passing on the pristine tag, ${String(regressions)} regression(s) on lyteboat's kernel`)
  return regressions
}

/** The files upstream's tsdown plugin writes for one package's artifacts (its `emitArtifacts`), by path under the package. */
function typertArtifactFiles(artifacts: readonly WorkspaceEmitResult[]): Map<string, string> {
  const files = new Map<string, string>()
  for (const artifact of artifacts) {
    files.set(`lib/typert.${artifact.face}.js`, artifact.js)
    files.set(`lib/typert.${artifact.face}.d.ts`, artifact.dts)
    if (artifact.remote === undefined) continue
    files.set('lib/typert.remote-client.js', artifact.remote.js)
    files.set('lib/typert.remote-client.d.ts', artifact.remote.dts)
  }
  return files
}

/**
 * Compare one kernel package's published Typert files with what upstream's generator
 * emits; with `write`, replace a differing file instead of failing.
 * @returns the number of failures.
 */
function compareTypertFiles(name: string, dir: string, generated: ReadonlyMap<string, string>, write: boolean): number {
  let failures = 0
  for (const file of kernelTypertFiles(dir)) {
    const text = generated.get(file)
    const path = join(repoRoot, 'dsh', dir, file)
    if (text === undefined) {
      console.error(`typert: ${name} publishes ${file}, but upstream's generator emits none from lyteboat's source`)
      failures += 1
      continue
    }
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue
    if (write) {
      writeFileSync(path, text)
      continue
    }
    console.error(`typert: dsh/${dir}/${file} differs from what upstream's generator emits from lyteboat's source`)
    failures += 1
  }
  return failures
}

function typert(checkout: string, write: boolean): number {
  const { dsh } = readUpstreamPin()
  const packages = kernelPackages().filter(({ dir }) => kernelTypertFiles(dir).length > 0)
  if (packages.length === 0) {
    console.log(`typert vs dsh ${dsh}: no kernel package publishes Typert files`)
    return 0
  }
  applyOverlay(checkout)
  try {
    // As upstream's tsdown plugin does in workspace mode: one analysis of every package that
    // publishes Typert files, because a package's Host face also reflects the declarations
    // other packages merge into its types (a MessageSourceMap entry from subagent, …).
    const generator = new WorkspaceTypertGenerator(checkout, { checkDiagnostics: false })
    const contributors = generator.discover(['host'])
      .filter(candidate => publishedTypertFiles(JSON.parse(readFileSync(join(checkout, candidate.root, 'package.json'), 'utf8')) as { exports?: Record<string, unknown>; files?: string[] }).length > 0)
      .map(candidate => candidate.package)
    const artifacts = generator.generate(contributors, ['host'])
    let failures = 0
    for (const { name, dir } of packages) {
      failures += compareTypertFiles(name, dir, typertArtifactFiles(artifacts.filter(artifact => artifact.package === name)), write)
      if (write && failures === 0) writeTypertStamp(name, typertSourceDigest(dir))
    }
    console.log(`typert vs dsh ${dsh}: ${packages.map(({ name }) => name).join(', ')}; ${String(failures)} failure(s)${write ? ', files written' : ''}`)
    return failures
  } finally {
    reset(checkout)
  }
}

function main(): void {
  const [checkout, mode, ...rest] = process.argv.slice(2)
  if (checkout === undefined || (mode !== 'persistence' && mode !== 'g3' && mode !== 'typert')) {
    throw new Error('usage: overlay.ts <upstream checkout> persistence | g3 [--match <regex>] | typert [--write]')
  }
  const matchIndex = rest.indexOf('--match')
  const match = new RegExp(matchIndex === -1 ? '' : rest[matchIndex + 1] ?? '', 'u')
  const failures = mode === 'persistence' ? persistence(checkout) : mode === 'g3' ? g3(checkout, match) : typert(checkout, rest.includes('--write'))
  if (failures > 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
