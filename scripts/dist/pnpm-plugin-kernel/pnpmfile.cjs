// The pnpmfile of @lyteboat/pnpm-plugin-kernel. A project that lists the package under
// `configDependencies` in pnpm-workspace.yaml gets lyteboat's kernel without a renamed
// package: pnpm installs the official @deepseek-ai/dsh-* packages and applies the patches
// in ./patches, which turn each into lyteboat's build. kernel.json (written by
// scripts/dist/release-pack.ts) names the tracked dsh release, its cordis versions, and
// the patch of every kernel package lyteboat's build changes.
const path = require('node:path')
const kernel = require('./kernel.json')

// The patches apply to exactly one version, so every dsh and cordis package is pinned to
// the release they were made against, as lyteboat's own .pnpmfile.cjs pins its workspace.
function pinned(name) {
  if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) return kernel.dsh
  return kernel.cordis[name]
}

function pin(deps) {
  if (!deps) return
  for (const name of Object.keys(deps)) {
    const version = pinned(name)
    if (version !== undefined) deps[name] = version
  }
}

function union(list, more) {
  return [...new Set([...(list ?? []), ...more])]
}

module.exports = {
  hooks: {
    updateConfig(config) {
      const patchedDependencies = { ...config.patchedDependencies }
      for (const [name, file] of Object.entries(kernel.patches)) patchedDependencies[`${name}@${kernel.dsh}`] = path.join(__dirname, file)
      return {
        ...config,
        patchedDependencies,
        // A project that installs only part of the kernel (no headless runner, no testkit) leaves those patches unused.
        allowUnusedPatches: true,
        // An agent directory names its rows by bare package name and resolves them from the
        // agent directory upward, so dsh's and lyteboat's packages sit at the root node_modules.
        publicHoistPattern: union(config.publicHoistPattern, ['@deepseek-ai/*', '@lyteboat/*']),
        // Only the node-pty helper chmod is needed on Linux/macOS; the rest ship prebuilt binaries or are Windows-only.
        allowBuilds: { '@deepseek-ai/dsh-subprocess-local': true, esbuild: true, 'node-pty': false, koffi: false, '@google/genai': false, protobufjs: false, ...config.allowBuilds },
        // lyteboat releases its packages together, so a release is installable on the day it is published.
        minimumReleaseAgeExclude: union(config.minimumReleaseAgeExclude, ['@lyteboat/*']),
      }
    },
    readPackage(pkg) {
      pin(pkg.dependencies)
      pin(pkg.optionalDependencies)
      pin(pkg.peerDependencies)
      return pkg
    },
  },
}
