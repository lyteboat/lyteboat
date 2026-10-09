/**
 * Pack lyteboat's npm release into a directory of tarballs, one `npm publish` each.
 *
 * Every package under `lyteboat/<layer>/<package>` is packed with `pnpm pack`, which
 * resolves `workspace:` and `catalog:` ranges to exact versions; they all carry one
 * version. The kernel is not published under a name of its own: a consumer installs the
 * official `@deepseek-ai/dsh-*` packages and `@lyteboat/pnpm-plugin-kernel`, a pnpm
 * config dependency whose pnpmfile (`scripts/dist/pnpm-plugin-kernel/pnpmfile.cjs`)
 * applies one patch per kernel package lyteboat's build changes. Each patch is the
 * difference between the official tarball of the tracked release and the same package
 * packed from `dsh/`, so a consumer runs the bytes lyteboat's gates ran.
 *
 * `--check` installs the release outside the repository the way a consumer would (the
 * plugin's pnpmfile as the project's pnpmfile, the packages from the tarballs), copies
 * the finance example in, and runs `lyteboat inspect` and an eval replay of its baseline.
 *
 *   pnpm run build && pnpm run release:pack [-- --out <dir>] [--check]
 * @module scripts/dist/release-pack
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { distCache } from './trees.ts'
import { git, kernelPackages, readUpstreamPin, repoRoot } from './kernel.ts'

const PLUGIN_NAME = '@lyteboat/pnpm-plugin-kernel'
const PLUGIN_TEMPLATE = join(repoRoot, 'scripts/dist/pnpm-plugin-kernel/pnpmfile.cjs')

interface PackageManifest {
  name: string
  version: string
  private?: boolean
  files?: string[]
}

/** One packed lyteboat package. */
interface ReleasePack {
  name: string
  tarball: string
}

function readManifest(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest
}

/** The publishable lyteboat packages: every `lyteboat/<layer>/<package>` with a manifest, all at one version. */
function releasePackageDirs(): { dirs: string[]; version: string } {
  const dirs: string[] = []
  for (const layer of readdirSync(join(repoRoot, 'lyteboat'), { withFileTypes: true })) {
    if (!layer.isDirectory()) continue
    for (const entry of readdirSync(join(repoRoot, 'lyteboat', layer.name), { withFileTypes: true })) {
      const dir = join(repoRoot, 'lyteboat', layer.name, entry.name)
      if (entry.isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir)
    }
  }
  const versions = new Set(dirs.map(dir => readManifest(dir).version))
  if (versions.size !== 1) throw new Error(`release-pack: lyteboat packages carry ${versions.size} versions (${[...versions].join(', ')}); a release has one`)
  for (const dir of dirs) {
    const manifest = readManifest(dir)
    if (manifest.private === true) throw new Error(`release-pack: ${relative(repoRoot, dir)} is private`)
    if (manifest.files?.includes('lib') === true && !existsSync(join(dir, 'lib'))) throw new Error(`release-pack: ${relative(repoRoot, dir)}/lib is missing; run pnpm run build first`)
  }
  const [version] = versions
  if (version === undefined) throw new Error('release-pack: no lyteboat packages found')
  return { dirs, version }
}

/** `pnpm pack` one directory into `out` and return the tarball's path. */
function pnpmPack(dir: string, out: string): string {
  const scratch = mkdtempSync(join(out, '.pack-'))
  execFileSync('pnpm', ['pack', '--pack-destination', scratch], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  const [tarball] = readdirSync(scratch).filter(file => file.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`release-pack: pnpm pack wrote no tarball for ${dir}`)
  const target = join(out, tarball)
  cpSync(join(scratch, tarball), target)
  rmSync(scratch, { recursive: true, force: true })
  return target
}

/** Unpack a tarball into a fresh directory and return its `package/` directory. */
function unpack(tarball: string, into: string): string {
  mkdirSync(into, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', into])
  return join(into, 'package')
}

/**
 * The patch that turns each official kernel package of the tracked release into
 * lyteboat's build, for every package whose shipped files differ. The manifest and the
 * LICENSE are left out: lyteboat's manifest is the official one, and the kernel keeps
 * upstream's license.
 * @returns package name → patch text.
 */
function kernelPatches(work: string): Record<string, string> {
  const { dsh } = readUpstreamPin()
  const patches: Record<string, string> = {}
  for (const { name, dir } of kernelPackages()) {
    const packageDir = join(repoRoot, 'dsh', dir)
    if (!existsSync(join(packageDir, 'lib'))) throw new Error(`release-pack: dsh/${dir}/lib is missing; run pnpm run build first`)
    const scratch = mkdtempSync(join(work, 'kernel-'))
    execFileSync('npm', ['pack', `${name}@${dsh}`, '--pack-destination', scratch, '--loglevel=error'], { cwd: scratch, stdio: ['ignore', 'ignore', 'inherit'] })
    const [official] = readdirSync(scratch).filter(file => file.endsWith('.tgz'))
    if (official === undefined) throw new Error(`release-pack: npm pack ${name}@${dsh} wrote no tarball`)
    const tree = unpack(join(scratch, official), join(scratch, 'official'))
    const ours = unpack(pnpmPack(packageDir, scratch), join(scratch, 'ours'))
    git(tree, ['init', '-q'])
    git(tree, ['add', '-A'])
    git(tree, ['-c', 'user.name=release-pack', '-c', 'user.email=release-pack@lyteboat.invalid', 'commit', '-qm', 'official'])
    // pnpm pack adds lyteboat's root LICENSE to a package without one; the kernel keeps upstream's.
    for (const file of ['package.json', 'LICENSE']) rmSync(join(ours, file), { force: true })
    cpSync(ours, tree, { recursive: true })
    git(tree, ['add', '-A'])
    const patch = execFileSync('git', ['-C', tree, 'diff', '--cached', '--binary', '--src-prefix=a/', '--dst-prefix=b/'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (patch !== '') patches[name] = patch
    rmSync(scratch, { recursive: true, force: true })
  }
  return patches
}

/** Write and pack `@lyteboat/pnpm-plugin-kernel` at `version` with `patches`. */
function packKernelPlugin(out: string, work: string, version: string, patches: Record<string, string>): { tarball: string; dir: string } {
  const { dsh, cordis } = readUpstreamPin()
  const dir = join(work, 'pnpm-plugin-kernel')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'patches'), { recursive: true })
  const files: Record<string, string> = {}
  for (const [name, patch] of Object.entries(patches)) {
    const file = `patches/${name.replace('@deepseek-ai/', '')}.patch`
    writeFileSync(join(dir, file), patch)
    files[name] = file
  }
  writeFileSync(join(dir, 'kernel.json'), `${JSON.stringify({ dsh, cordis, patches: files }, null, 2)}\n`)
  cpSync(PLUGIN_TEMPLATE, join(dir, 'pnpmfile.cjs'))
  const manifest = {
    name: PLUGIN_NAME,
    version,
    license: 'MIT',
    description: `lyteboat's kernel for pnpm projects: list it under configDependencies and pnpm installs the official @deepseek-ai/dsh-* ${dsh} packages with lyteboat's patches applied`,
    repository: { type: 'git', url: 'git+https://github.com/lyteboat/lyteboat.git', directory: 'scripts/dist/pnpm-plugin-kernel' },
    homepage: 'https://github.com/lyteboat/lyteboat#readme',
    files: ['pnpmfile.cjs', 'kernel.json', 'patches'],
    publishConfig: { access: 'public' },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'README.md'), pluginReadme(version, dsh, Object.keys(files)))
  return { tarball: pnpmPack(dir, out), dir }
}

function pluginReadme(version: string, dsh: string, patched: readonly string[]): string {
  return `# ${PLUGIN_NAME}

lyteboat's kernel for a pnpm project. lyteboat changes ${patched.length} of the dsh ${dsh} packages (${patched.map(name => `\`${name}\``).join(', ')}) and does not publish them under names of its own: list this package as a config dependency, and pnpm installs the official packages and applies lyteboat's patches. Its pnpmfile also pins every dsh and cordis package to the versions the patches were made against and hoists \`@deepseek-ai/*\` and \`@lyteboat/*\` to the root \`node_modules\`, where an agent directory's rows resolve.

\`\`\`yaml
# pnpm-workspace.yaml; the integrity is \`npm view ${PLUGIN_NAME}@${version} dist.integrity\`
configDependencies:
  "${PLUGIN_NAME}": "${version}+sha512-…"
\`\`\`

Use the version of your \`@lyteboat/*\` packages. See [lyteboat](https://github.com/lyteboat/lyteboat) for the rest.
`
}

/**
 * Install the release in a directory outside the repository as a consumer would and run
 * the finance example from it: `lyteboat inspect`, then an eval replay of its baseline.
 */
function checkRelease(packs: ReleasePack[], pluginDir: string, version: string): void {
  const tree = join(distCache, `release-check-${version}`)
  rmSync(tree, { recursive: true, force: true })
  mkdirSync(join(tree, 'agents'), { recursive: true })
  const fileOf = (name: string): string => {
    const pack = packs.find(entry => entry.name === name)
    if (pack === undefined) throw new Error(`release-pack: ${name} was not packed`)
    return `file:${pack.tarball}`
  }
  const { dsh } = readUpstreamPin()
  const dependencies = {
    ...Object.fromEntries(['@lyteboat/cli', '@lyteboat/agent-definition', '@lyteboat/a2ui', '@lyteboat/contracts', '@lyteboat/request-admission'].map(name => [name, fileOf(name)])),
    '@deepseek-ai/dsh-agent': dsh,
    '@deepseek-ai/dsh-tools': dsh,
    zod: '^4.6.5',
  }
  const packageManager = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { packageManager: string }).packageManager
  writeFileSync(join(tree, 'package.json'), `${JSON.stringify({ name: 'lyteboat-release-check', private: true, type: 'module', packageManager, dependencies }, null, 2)}\n`)
  // A tarball is not a registry, so the @lyteboat packages' dependencies on each other resolve through overrides.
  const overrides = Object.fromEntries(packs.map(pack => [pack.name, `file:${pack.tarball}`]))
  writeFileSync(join(tree, 'pnpm-workspace.yaml'), `packages: []\noverrides:\n${Object.entries(overrides).map(([name, spec]) => `  "${name}": "${spec}"\n`).join('')}`)
  // A configDependencies entry needs a registry; the project's own pnpmfile runs the same hooks.
  cpSync(pluginDir, join(tree, 'pnpm-plugin-kernel'), { recursive: true })
  writeFileSync(join(tree, '.pnpmfile.cjs'), "module.exports = require('./pnpm-plugin-kernel/pnpmfile.cjs')\n")
  execFileSync('pnpm', ['install', '--reporter=append-only'], { cwd: tree, stdio: ['ignore', 'inherit', 'inherit'] })

  const finance = join(repoRoot, 'examples/agents/finance')
  const agent = join(tree, 'agents/finance')
  for (const entry of ['package.json', 'agent.yml', 'lib', 'assets', 'evals']) cpSync(join(finance, entry), join(agent, entry), { recursive: true })
  const env = { ...process.env, LYTEBOAT_HOME: join(tree, '.lyteboat'), DSH_TELEMETRY_DISABLED: '1' }
  const bin = join(tree, 'node_modules/@lyteboat/cli/lib/bin.js')
  for (const args of [
    ['inspect', '--agents', './agents', '--agent', 'finance'],
    ['eval', '--agents', './agents', '--agent', 'finance', '--model', 'replay', '--from', 'agents/finance/evals/baseline'],
  ]) {
    process.stdout.write(`release-pack: lyteboat ${args.join(' ')}\n`)
    execFileSync(process.execPath, [bin, ...args], { cwd: tree, env, stdio: ['ignore', 'inherit', 'inherit'] })
  }
}

function main(): void {
  // `pnpm run release:pack -- --check` hands the script a literal `--`.
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  const { values } = parseArgs({ args, options: { out: { type: 'string' }, check: { type: 'boolean', default: false } } })
  const { dirs, version } = releasePackageDirs()
  const out = values.out ?? join(distCache, 'release', version)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  mkdirSync(distCache, { recursive: true })
  const work = mkdtempSync(join(distCache, 'release-work-'))
  const packs: ReleasePack[] = dirs.map(dir => ({ name: readManifest(dir).name, tarball: pnpmPack(dir, out) }))
  const patches = kernelPatches(work)
  const plugin = packKernelPlugin(out, work, version, patches)
  process.stdout.write(`release-pack: ${packs.length + 1} tarballs at ${out} (version ${version}); kernel patches: ${Object.keys(patches).join(', ')}\n`)
  if (values.check) checkRelease(packs, plugin.dir, version)
  rmSync(work, { recursive: true, force: true })
}

main()
