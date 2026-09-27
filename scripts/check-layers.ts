/**
 * Enforce the layer rule: a lyteboat package's layer is its directory under
 * `lyteboat/`, the packages under `examples/<kind>/` form the outermost layer
 * `examples`, and dependencies point down only. Runtime edges (dependencies,
 * peerDependencies) follow RUNTIME; devDependencies may also reach DEV_ONLY
 * (tests only). Between plugins the only allowed source import is
 * `import type`, the service declaration a plugin merges onto the cordis
 * Context. The kernel under `dsh/` is below every layer and never names a
 * lyteboat package. Exits non-zero with one line per violation.
 *
 *   node --import tsx scripts/check-layers.ts
 * @module scripts/check-layers
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { kernelPackages } from './dist/kernel.ts'

const LAYERS = ['examples', 'apps', 'bundles', 'plugins', 'core', 'tooling'] as const
type Layer = typeof LAYERS[number]

/** Layers a package may reach at runtime, by its own layer. No layer reaches `examples`. */
const RUNTIME: Readonly<Record<Layer, readonly Layer[]>> = {
  examples: ['plugins', 'core'],
  // An app boots compositions: the plugins it runs arrive through the bundles that wire them.
  apps: ['bundles', 'core'],
  bundles: ['plugins', 'core'],
  plugins: ['plugins', 'core'],
  core: ['core'],
  tooling: ['core'],
}

/** Extra layers a package's tests may reach through devDependencies. */
const DEV_ONLY: Readonly<Record<Layer, readonly Layer[]>> = {
  // An agent's composition test boots the bundle that loads it; its smoke runs the built launcher.
  examples: ['apps', 'bundles', 'tooling'],
  apps: ['tooling'],
  // A bundle's composition test boots the bundles its profiles list beside it.
  bundles: ['bundles', 'tooling'],
  plugins: ['tooling'],
  core: ['tooling'],
  tooling: [],
}

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface WorkspacePackage {
  layer: Layer
  dir: string
  manifest: Manifest
}

const root = fileURLToPath(new URL('..', import.meta.url))

/** The directories whose subdirectories are a layer's packages: `lyteboat/<layer>`, or every `examples/<kind>`. */
function layerDirs(layer: Layer): string[] {
  if (layer !== 'examples') return [join(root, 'lyteboat', layer)]
  const examples = join(root, 'examples')
  if (!existsSync(examples)) return []
  return readdirSync(examples, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(examples, entry.name))
}

function workspacePackages(): WorkspacePackage[] {
  const found: WorkspacePackage[] = []
  for (const [layer, layerDir] of LAYERS.flatMap(owner => layerDirs(owner).map(dir => [owner, dir] as const))) {
    if (!existsSync(layerDir)) continue
    for (const entry of readdirSync(layerDir, { withFileTypes: true })) {
      const file = join(layerDir, entry.name, 'package.json')
      if (!entry.isDirectory() || !existsSync(file)) continue
      found.push({ layer, dir: join(layerDir, entry.name), manifest: JSON.parse(readFileSync(file, 'utf8')) as Manifest })
    }
  }
  return found
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(path => path.endsWith('.ts'))
    .map(path => join(dir, path))
}

function checkManifest(pkg: WorkspacePackage, layerOf: ReadonlyMap<string, Layer>): string[] {
  const problems: string[] = []
  const runtime = { ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies }
  for (const name of Object.keys(runtime)) {
    const target = layerOf.get(name)
    if (target !== undefined && !RUNTIME[pkg.layer].includes(target)) {
      problems.push(`${pkg.manifest.name} (${pkg.layer}) depends at runtime on ${name} (${target})`)
    }
  }
  for (const name of Object.keys(pkg.manifest.devDependencies ?? {})) {
    const target = layerOf.get(name)
    if (target !== undefined && !RUNTIME[pkg.layer].includes(target) && !DEV_ONLY[pkg.layer].includes(target)) {
      problems.push(`${pkg.manifest.name} (${pkg.layer}) has a devDependency on ${name} (${target})`)
    }
  }
  return problems
}

const IMPORT = /^import\s+(type\s+)?[^'"]*from\s+'(@lyteboat\/[a-z0-9-]+)(?:\/[a-z0-9/-]+)?'/gmu

function checkPluginImports(pkg: WorkspacePackage, layerOf: ReadonlyMap<string, Layer>): string[] {
  if (pkg.layer !== 'plugins') return []
  const problems: string[] = []
  for (const file of sourceFiles(join(pkg.dir, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const [, typeOnly, name] = match
      if (name === undefined || name === pkg.manifest.name || layerOf.get(name) !== 'plugins') continue
      if (typeOnly === undefined) problems.push(`${relative(root, file)} imports plugin ${name} as a value; only \`import type\` crosses plugins`)
    }
  }
  return problems
}

/**
 * The kernel (dsh/kernel.json) sits below every lyteboat layer: a lyteboat package may
 * depend on it like on any dsh seam, but no kernel package may name a lyteboat
 * package, in its manifest or in any source or test file.
 */
function checkKernel(): string[] {
  const problems: string[] = []
  for (const { name, dir } of kernelPackages()) {
    const packageDir = join(root, 'dsh', dir)
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Manifest
    const deps = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
    for (const dep of Object.keys(deps)) if (dep.startsWith('@lyteboat/')) problems.push(`kernel package ${name} depends on ${dep}`)
    for (const file of [...sourceFiles(join(packageDir, 'src')), ...sourceFiles(join(packageDir, 'tests'))]) {
      if (/from\s+'@lyteboat\/|import\s+'@lyteboat\//u.test(readFileSync(file, 'utf8'))) problems.push(`${relative(root, file)} imports a lyteboat package; the kernel knows no lyteboat package`)
    }
  }
  return problems
}

function main(): void {
  const packages = workspacePackages()
  const layerOf = new Map(packages.map(pkg => [pkg.manifest.name, pkg.layer] as const))
  const problems = [...packages.flatMap(pkg => [...checkManifest(pkg, layerOf), ...checkPluginImports(pkg, layerOf)]), ...checkKernel()]
  if (problems.length === 0) return
  for (const problem of problems) process.stderr.write(`check-layers: ${problem}\n`)
  process.exitCode = 1
}

main()
