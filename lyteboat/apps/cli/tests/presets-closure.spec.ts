import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * Every package a shipped agent preset names must resolve from the lyteboat
 * installation: dsh-web-app declares its presets as agent-preset rows in
 * `presets/*.patch.yml`, and the preset registry only reports an unresolvable
 * package as a broken preset, so a missing dependency surfaces as a
 * session-creation failure, not a boot failure.
 */
function presetPackageNames(): Map<string, string[]> {
  const require = createRequire(import.meta.url)
  const presetsDir = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets')
  const names = new Map<string, string[]>()
  for (const preset of readdirSync(presetsDir).filter(file => file.endsWith('.patch.yml'))) {
    const text = readFileSync(join(presetsDir, preset), 'utf8')
    const found = new Set<string>()
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { for (const item of node) visit(item); return }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === 'name' && typeof value === 'string' && value.startsWith('@deepseek-ai/')) {
            const [scope, pkg] = value.split('/')
            found.add(`${scope}/${pkg}`)
          }
          visit(value)
        }
      }
    }
    // Presets use the loader's `!!js` tag (tag:yaml.org,2002:js) for expressions; the values are irrelevant here.
    const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: () => undefined })])
    visit(yaml.load(text, { schema }))
    names.set(preset, [...found].sort())
  }
  return names
}

describe('shipped preset closure', () => {
  it('resolves every package named by the shipped agent presets from @lyteboat/cli', () => {
    const presets = presetPackageNames()
    expect(presets.size).toBeGreaterThan(0)
    const unresolved: string[] = []
    for (const [preset, packages] of presets) {
      for (const name of packages) {
        try {
          import.meta.resolve(name)
        } catch {
          unresolved.push(`${preset}: ${name}`)
        }
      }
    }
    expect(unresolved).toEqual([])
  })
})
