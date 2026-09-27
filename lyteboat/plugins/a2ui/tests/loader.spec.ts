/**
 * The bundle loader fails loud on authoring mistakes a blank card would hide.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lyteboatTempDir } from '@lyteboat/testing/scratch'
import { loadBundle, type TemplateBundle } from '../src/loader.ts'

const TEMPLATE = '{"rootComponentId":"root","components":[{"id":"root","component":{"Column":{}}}]}'

function card(files: Record<string, string>): { root: string; card: string } {
  const root = lyteboatTempDir('a2ui-loader')
  mkdirSync(join(root, 'card'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'card', name), text)
  return { root, card: 'card' }
}

describe('loadBundle', () => {
  it('loads a card whose manifest is absent or empty', async () => {
    const { root } = card({ 'template.json': TEMPLATE, 'manifest.yaml': '# nothing yet\n' })
    const bundle = await loadBundle(root, 'card', new Map())
    expect(bundle.manifest).toEqual({})
    expect(bundle.argSpecs).toEqual({})
  })

  it('reads each emission mode a manifest may declare', async () => {
    for (const mode of ['immediate', 'deferred', 'deferred_discard'] as const) {
      const { root } = card({ 'template.json': TEMPLATE, 'manifest.yaml': `emission_mode: ${mode}\n` })
      expect((await loadBundle(root, 'card', new Map())).emissionMode).toBe(mode)
    }
  })

  it('rejects an emission mode outside the three, naming the manifest', async () => {
    const { root } = card({ 'template.json': TEMPLATE, 'manifest.yaml': 'emission_mode: later\n' })
    await expect(loadBundle(root, 'card', new Map())).rejects.toThrow(/manifest\.yaml: emission_mode "later" is not one of immediate, deferred, deferred_discard$/u)
  })

  it('rejects a compute.js that exports only its default, naming the file', async () => {
    const { root } = card({ 'template.json': TEMPLATE, 'compute.js': 'export default { digest: () => "d" }\n' })
    await expect(loadBundle(root, 'card', new Map())).rejects.toThrow(/card[/\\]compute\.js is not an ES module with named exports: it exports only its default$/u)
  })

  it('loads a compute.js with named exports, and reloads a card once its files change', async () => {
    const { root } = card({ 'template.json': TEMPLATE, 'compute.js': 'export function digest() { return "first" }\n' })
    const cache = new Map<string, TemplateBundle>()
    const first = await loadBundle(root, 'card', cache)
    expect(first.digest?.({}, {})).toBe('first')
    expect(await loadBundle(root, 'card', cache)).toBe(first)
    writeFileSync(join(root, 'card', 'compute.js'), 'export function digest() { return "second" }\n')
    utimesSync(join(root, 'card', 'compute.js'), new Date(), new Date(Date.now() + 5000))
    expect((await loadBundle(root, 'card', cache)).digest?.({}, {})).toBe('second')
  })

  it('rejects a manifest that is a list instead of a mapping, naming the file', async () => {
    const { root } = card({ 'template.json': TEMPLATE, 'manifest.yaml': '- paths:\n    title:\n      kind: state\n' })
    await expect(loadBundle(root, 'card', new Map())).rejects.toThrow(/manifest\.yaml 必须是 YAML 映射，实际是 list/u)
  })

  it('rejects manifest paths, manifest args and hierarchies that are not mappings', async () => {
    const paths = card({ 'template.json': TEMPLATE, 'manifest.yaml': 'paths:\n  - title\n' })
    await expect(loadBundle(paths.root, 'card', new Map())).rejects.toThrow(/manifest\.yaml 的 paths 必须是映射/u)
    const args = card({ 'template.json': TEMPLATE, 'manifest.yaml': 'args: bucket\n' })
    await expect(loadBundle(args.root, 'card', new Map())).rejects.toThrow(/manifest\.yaml 的 args 必须是映射，实际是 string/u)
    const hierarchies = card({ 'template.json': TEMPLATE, 'business_hierarchy.yaml': 'hierarchies:\n  - brief\n' })
    await expect(loadBundle(hierarchies.root, 'card', new Map())).rejects.toThrow(/business_hierarchy\.yaml 的 hierarchies 必须是映射/u)
  })

  it('rejects a template that is not JSON or has no components list', async () => {
    const broken = card({ 'template.json': '{ not json' })
    await expect(loadBundle(broken.root, 'card', new Map())).rejects.toThrow(/template\.json 不是合法 JSON/u)
    const bare = card({ 'template.json': '{"rootComponentId":"root"}' })
    await expect(loadBundle(bare.root, 'card', new Map())).rejects.toThrow(/template\.json 必须是带 components 列表的对象/u)
  })
})
