import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { expect, test } from 'vitest'
import { kernelPackages, readUpstreamPin } from './dist/kernel.ts'

interface Workspace {
  catalogs: { dsh: Record<string, string>; cordis: Record<string, string> }
  overrides: Record<string, string>
}

const upstream = readUpstreamPin()
const workspace = parse(readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')) as Workspace
const kernel = kernelPackages().map(({ name }) => name)

test('the dsh catalog pins every entry to the dsh.upstream.json release', () => {
  for (const [name, version] of Object.entries(workspace.catalogs.dsh)) {
    expect({ name, version }).toEqual({ name, version: upstream.dsh })
  }
})

test('the cordis catalog pins every entry to its dsh.upstream.json version', () => {
  for (const [name, version] of Object.entries(workspace.catalogs.cordis)) {
    expect({ name, version }).toEqual({ name, version: upstream.cordis[name] })
  }
})

test('the overrides route exactly the kernel packages to the workspace', () => {
  const routed = Object.entries(workspace.overrides).filter(([, spec]) => spec === 'workspace:*').map(([name]) => name)
  expect(routed.sort()).toEqual([...kernel].sort())
})

test('the dsh catalog lists no kernel package', () => {
  expect(Object.keys(workspace.catalogs.dsh).filter(name => kernel.includes(name))).toEqual([])
})

// dsh's startup admission reads a row's dsh peers from the manifest on disk, where pnpm leaves
// `catalog:` unresolved, so a lyteboat package writes them as the exact version a publish would.
test('every dsh peer of a lyteboat package is the dsh.upstream.json release, or the workspace kernel', () => {
  const manifests = readdirSync(new URL('../lyteboat', import.meta.url), { withFileTypes: true })
    .filter(layer => layer.isDirectory())
    .flatMap(layer => readdirSync(new URL(`../lyteboat/${layer.name}`, import.meta.url)).map(name => new URL(`../lyteboat/${layer.name}/${name}/package.json`, import.meta.url)))
    .filter(url => existsSync(url))
  for (const url of manifests) {
    const { name, peerDependencies = {} } = JSON.parse(readFileSync(url, 'utf8')) as { name: string; peerDependencies?: Record<string, string> }
    for (const [peer, spec] of Object.entries(peerDependencies)) {
      if (peer !== '@deepseek-ai/dsh' && !peer.startsWith('@deepseek-ai/dsh-')) continue
      expect({ name, peer, spec }).toEqual({ name, peer, spec: kernel.includes(peer) ? 'workspace:*' : upstream.dsh })
    }
  }
})
