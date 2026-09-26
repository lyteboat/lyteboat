/**
 * The agent catalog: scan the roots, declare each agent to the preset
 * registry, and report the ones that cannot be served. A row that fails to
 * mount needs the host's loader tree; the try composition covers it.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MockAdapter, createLyteboatUnitHost } from '@lyteboat/testing'
import AgentCatalogService from '@lyteboat/agent-catalog'
import { agentDigest } from '../src/agent-digest.ts'
import type { Config } from '@lyteboat/agent-catalog'

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

async function catalogHost(config: Config): Promise<Context> {
  const ctx = await createLyteboatUnitHost(new MockAdapter([]))
  // The unit host has no loader tree; the registry only waits on it to settle, and here it has.
  ctx.provide('loader', { await: () => Promise.resolve() } as never)
  await ctx.plugin(AgentPresetRegistry, { default: 'none' })
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'deepseek-official', model: 'deepseek-flash' })
  await ctx.plugin(AgentCatalogService, config)
  return ctx
}

describe('the agent catalog', () => {
  it('declares every agent the roots hold to the preset registry, with its manifest and working directory', async () => {
    const ctx = await catalogHost({ roots: [fixture('good')], workdirsDir: '/srv/lyteboat/workdirs' })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.list()).toEqual([
      {
        id: 'alpha', dir: fixture('good/alpha'), workdir: '/srv/lyteboat/workdirs/alpha', name: 'Alpha', description: 'the first fixture agent', order: 1,
        identity: { id: 'alpha', version: '0.3.1', digest: agentDigest(fixture('good/alpha')).digest },
        files: agentDigest(fixture('good/alpha')).files,
        model: { provider: 'deepseek-official', model: 'deepseek-flash' },
      },
      { id: 'beta', dir: fixture('good/beta'), workdir: '/srv/lyteboat/workdirs/beta', identity: { id: 'beta', digest: agentDigest(fixture('good/beta')).digest }, files: agentDigest(fixture('good/beta')).files },
    ])
    expect(await ctx.agentPresets.resolve('alpha')).toEqual({ id: 'alpha' })
    expect(ctx.agentCatalog.failures()).toEqual([])
  })

  it('puts an agent\'s working directory under the home\'s agent-workdirs by default, without creating it', async () => {
    const ctx = await catalogHost({ roots: [fixture('good')] })

    await ctx.agentCatalog.whenReady()

    const workdir = ctx.agentCatalog.get('beta')?.workdir
    expect(workdir).toBe(dshHomePath('agent-workdirs', 'beta'))
    expect(existsSync(workdir ?? '')).toBe(false)
  })

  it('declares only the included agents when include names them', async () => {
    const ctx = await catalogHost({ roots: [fixture('good')], include: ['beta'] })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.list().map(agent => agent.id)).toEqual(['beta'])
    expect(ctx.agentCatalog.get('alpha')).toBeUndefined()
  })

  it('fails whenReady naming every agent it cannot serve when strict', async () => {
    const ctx = await catalogHost({ roots: [fixture('good'), fixture('broken')] })

    const failure = await ctx.agentCatalog.whenReady().then(() => undefined, (error: unknown) => error)

    expect(String(failure)).toContain('agent-catalog: 2 agent(s) failed')
    expect(ctx.agentCatalog.failures().map(problem => problem.id).sort()).toEqual(['Not_Kebab', 'bad-yaml'])
  })

  it('reports the failures and serves the rest when not strict', async () => {
    const ctx = await catalogHost({ roots: [fixture('good'), fixture('broken')], strict: false })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.list().map(agent => agent.id)).toEqual(['alpha', 'beta'])
    const reasons = Object.fromEntries(ctx.agentCatalog.failures().map(problem => [problem.id, problem.reason]))
    expect(reasons['Not_Kebab']).toBe('"Not_Kebab" is not a kebab-case id; rename the directory')
    expect(reasons['bad-yaml']).toContain('agent-catalog: cannot read')
  })

  it('fails whenReady when two roots hold the same id, or no root holds an included one', async () => {
    const duplicated = await catalogHost({ roots: [fixture('good'), fixture('dup')], strict: false })
    const unknown = await catalogHost({ roots: [fixture('good')], include: ['gamma'] })

    await expect(duplicated.agentCatalog.whenReady()).rejects.toThrow(`agent-catalog: agent "alpha" is in two roots: ${fixture('good')} and ${fixture('dup')}`)
    await expect(unknown.agentCatalog.whenReady()).rejects.toThrow('agent-catalog: no root holds "gamma" (available: alpha, beta)')
  })

  describe('an agent\'s manifest', () => {
    const roots: string[] = []
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

    /** A root holding a copy of the fixture agent beta with the given files added. */
    function rootWithBeta(files: Record<string, string>): string {
      const root = mkdtempSync(join(tmpdir(), 'agent-catalog-manifest-'))
      roots.push(root)
      cpSync(fixture('good/beta'), join(root, 'beta'), { recursive: true })
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'beta', name), text)
      return root
    }

    async function failureOf(files: Record<string, string>): Promise<string | undefined> {
      const ctx = await catalogHost({ roots: [rootWithBeta(files)], strict: false })
      await ctx.agentCatalog.whenReady()
      expect(ctx.agentCatalog.get('beta')).toBeUndefined()
      return ctx.agentCatalog.failures().find(problem => problem.id === 'beta')?.reason
    }

    it('fails an agent whose manifest has a key it does not know, or a version that is not one', async () => {
      expect(await failureOf({ 'agent.yml': 'name: Beta\nundeclared: hidden\n' })).toMatch(/agent\.yml: .*"undeclared"/u)
      expect(await failureOf({ 'agent.yml': 'version: latest\n' })).toContain('agent.yml: version: must look like 1.2.3 or 1.2.3-rc.1')
      expect(await failureOf({ 'agent.yml': 'version: 1.0\n' })).toContain('agent.yml: version: must be a string such as 1.2.3; quote it in YAML')
      expect(await failureOf({ 'agent.yml': 'model: { provider: deepseek-official }\n' })).toContain('agent.yml: model.model:')
    })

    it('fails an agent whose declared model is not this process\'s when enforced, before registering it', async () => {
      const root = rootWithBeta({ 'agent.yml': 'model: { provider: deepseek-official, model: deepseek-pro }\n' })
      const enforced = await catalogHost({ roots: [root], strict: false, enforceDeclaredModel: true })
      const lax = await catalogHost({ roots: [root], strict: false })
      await enforced.agentCatalog.whenReady()
      await lax.agentCatalog.whenReady()

      expect(enforced.agentCatalog.failures().map(problem => problem.reason)).toEqual([
        'agent.yml declares model deepseek-official/deepseek-pro, but this process runs deepseek-official/deepseek-flash; run it with that default model (the agent-default-model row) or change agent.yml',
      ])
      expect((await enforced.agentPresets.list()).map(preset => preset.id)).not.toContain('beta')
      expect(lax.agentCatalog.get('beta')?.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-pro' })
    })

    it('serves an agent whose declared model is this process\'s, reasoning effort included', async () => {
      const root = rootWithBeta({ 'agent.yml': 'model: { provider: deepseek-official, model: deepseek-flash }\n' })
      const effortful = rootWithBeta({ 'agent.yml': 'model: { provider: deepseek-official, model: deepseek-flash, reasoningEffort: high }\n' })
      const plain = await catalogHost({ roots: [root], enforceDeclaredModel: true })
      const withEffort = await catalogHost({ roots: [effortful], strict: false, enforceDeclaredModel: true })
      await plain.agentCatalog.whenReady()
      await withEffort.agentCatalog.whenReady()

      expect(plain.agentCatalog.get('beta')?.identity.id).toBe('beta')
      expect(withEffort.agentCatalog.failures()[0]?.reason).toContain('declares model deepseek-official/deepseek-flash (reasoningEffort high), but this process runs deepseek-official/deepseek-flash;')
    })

    it('fails an agent that still has preset.yml, naming the rename', async () => {
      expect(await failureOf({ 'preset.yml': 'name: Beta\n' })).toBe(`agent-catalog: ${join(roots[0] ?? '', 'beta', 'preset.yml')} is now agent.yml: rename it (name, description, and order stay; version and model are new)`)
    })
  })

  describe('an agent pinned by a release', () => {
    const roots: string[] = []
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

    /** A root holding a copy of the fixture agent beta at version 1.0.0, and the pin that matches it. */
    function releasedBeta(): { root: string; pin: { version: string; digest: string; files: Record<string, string> } } {
      const root = mkdtempSync(join(tmpdir(), 'agent-catalog-pin-'))
      roots.push(root)
      cpSync(fixture('good/beta'), join(root, 'beta'), { recursive: true })
      writeFileSync(join(root, 'beta', 'agent.yml'), 'version: 1.0.0\n')
      const { digest, files } = agentDigest(join(root, 'beta'))
      return { root, pin: { version: '1.0.0', digest, files: { ...files } } }
    }

    it('serves a pinned agent whose directory is what its release says', async () => {
      const { root, pin } = releasedBeta()

      const ctx = await catalogHost({ roots: [root], pinnedAgents: { beta: pin } })
      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.get('beta')?.identity).toEqual({ id: 'beta', version: '1.0.0', digest: pin.digest })
    })

    it('fails a pinned agent whose files differ from its release, naming each file, before registering it', async () => {
      const { root, pin } = releasedBeta()
      writeFileSync(join(root, 'beta', 'agent.cordis.yml'), '[]\n# edited\n')
      writeFileSync(join(root, 'beta', 'notes.md'), 'new\n')

      const ctx = await catalogHost({ roots: [root], strict: false, pinnedAgents: { beta: { ...pin, files: { ...pin.files, 'gone.md': '0'.repeat(64) } } } })
      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.failures().map(problem => problem.reason)).toEqual([`the directory differs from its release 1.0.0 (${pin.digest}): changed agent.cordis.yml; added notes.md; removed gone.md`])
      expect((await ctx.agentPresets.list()).map(preset => preset.id)).not.toContain('beta')
    })

    it('fails a pinned agent whose manifest declares another version', async () => {
      const { root, pin } = releasedBeta()

      const ctx = await catalogHost({ roots: [root], strict: false, pinnedAgents: { beta: { ...pin, version: '1.0.1' } } })
      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.failures()[0]?.reason).toBe('agent.yml declares version 1.0.0, but its release pins 1.0.1')
    })

    it('fails whenReady when a pin names an agent the catalog does not declare', async () => {
      const { root, pin } = releasedBeta()

      const ctx = await catalogHost({ roots: [root], pinnedAgents: { gamma: pin } })

      await expect(ctx.agentCatalog.whenReady()).rejects.toThrow('agent-catalog: pinned agent(s) "gamma" are not declared; pin only agents the roots and include name')
    })
  })

  describe('when the roots change', () => {
    const roots: string[] = []
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

    /** A root holding copies of the named fixture agents. */
    function rootWith(...ids: string[]): string {
      const root = mkdtempSync(join(tmpdir(), 'agent-catalog-'))
      roots.push(root)
      for (const id of ids) cpSync(fixture(`good/${id}`), join(root, id), { recursive: true })
      return root
    }

    it('reloads what the roots hold now: a new agent is declared, a removed one withdrawn', async () => {
      const root = rootWith('alpha')
      const ctx = await catalogHost({ roots: [root] })
      await ctx.agentCatalog.whenReady()

      cpSync(fixture('good/beta'), join(root, 'beta'), { recursive: true })
      rmSync(join(root, 'alpha'), { recursive: true })
      await ctx.agentCatalog.reload()

      expect(ctx.agentCatalog.list().map(agent => agent.id)).toEqual(['beta'])
      expect(await ctx.agentPresets.resolve('beta')).toEqual({ id: 'beta' })
      expect((await ctx.agentPresets.list()).map(preset => preset.id)).not.toContain('alpha')
    })

    it('reloads by itself when watching and an agent appears under a root', async () => {
      const root = rootWith('alpha')
      const ctx = await catalogHost({ roots: [root], watch: true, watchDelayMs: 20 })
      await ctx.agentCatalog.whenReady()

      cpSync(fixture('good/beta'), join(root, 'beta'), { recursive: true })

      await vi.waitFor(() => { expect(ctx.agentCatalog.list().map(agent => agent.id)).toEqual(['alpha', 'beta']) }, { timeout: 5000 })
    })
  })
})

describe('an agent without agent.cordis.yml', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  /** A root holding one agent directory with the given files; directories are created as needed. */
  function rootWithAgent(id: string, files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'agent-catalog-def-'))
    roots.push(root)
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, id, name)), { recursive: true })
      writeFileSync(join(root, id, name), text)
    }
    return root
  }

  // What lyteboatAgentDef({…}) returns, reduced to what the catalog reads and the registry mounts.
  const agentModule = (identity: string): string => `export default class Agent { static lyteboatAgentDefIdentity = ${identity} }\n`

  it('runs lib/agent.js as its one row and names the agent after its lyteboatAgentDef', async () => {
    const root = rootWithAgent('solo', { 'lib/agent.js': agentModule('{ agentId: \'solo\', agentName: \'Solo\' }') })
    const ctx = await catalogHost({ roots: [root] })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.get('solo')?.name).toBe('Solo')
    // dsh's own preset list shows the same name as the catalog.
    expect((await ctx.agentPresets.list()).find(preset => preset.id === 'solo')?.name).toBe('Solo')
    expect((await ctx.agentPresets.readDocument('solo')).content).toContain('./lib/agent.js')
  })

  it('fails an agent whose agent.yml names it differently from its lyteboatAgentDef', async () => {
    const root = rootWithAgent('named', { 'agent.yml': 'name: Other\n', 'lib/agent.js': agentModule('{ agentId: \'named\', agentName: \'Named\' }') })
    const ctx = await catalogHost({ roots: [root], strict: false })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.failures().map(problem => problem.reason)).toEqual(['agent.yml names the agent "Other", but its lyteboatAgentDef names it "Named"; keep one of them'])
  })

  it('fails an agent whose lib/agent.js is not a lyteboatAgentDef', async () => {
    const root = rootWithAgent('plain', { 'lib/agent.js': 'export default class Agent {}\n' })
    const ctx = await catalogHost({ roots: [root], strict: false })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.failures()[0]?.reason).toMatch(/lib\/agent\.js must default-export lyteboatAgentDef/u)
  })

  it('fails an agent whose lyteboatAgentDef declares a malformed identity, naming the field', async () => {
    const root = rootWithAgent('malformed', { 'lib/agent.js': agentModule('{ agentId: \'Bad_Id\', agentName: \'Malformed\' }') })
    const ctx = await catalogHost({ roots: [root], strict: false })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.failures()[0]?.reason).toMatch(/lib\/agent\.js: its lyteboatAgentDef declares agentId: must be kebab-case/u)
  })

  it('fails an agent whose lib/agent.js cannot be loaded, naming the module', async () => {
    const root = rootWithAgent('broken', { 'lib/agent.js': 'import { lyteboatAgentDef } from \'@lyteboat/no-such-package\'\nexport default lyteboatAgentDef({})\n' })
    const ctx = await catalogHost({ roots: [root], strict: false })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.failures()[0]?.reason).toMatch(/lib\/agent\.js cannot be loaded: Cannot find package '@lyteboat\/no-such-package'/u)
  })

  describe('with agent.cordis.yml', () => {
    const composition = '- id: composed-agent\n  name: ./agent.mjs\n- id: extra\n  name: ./extra.mjs\n'
    const extraRow = 'export function apply() {}\n'

    it('names the agent after the lyteboatAgentDef its composition lists beside other rows', async () => {
      const root = rootWithAgent('composed', { 'agent.cordis.yml': composition, 'agent.mjs': agentModule('{ agentId: \'composed\', agentName: \'Composed\' }'), 'extra.mjs': extraRow })
      const ctx = await catalogHost({ roots: [root] })

      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.get('composed')?.name).toBe('Composed')
    })

    it('fails an agent whose agent.yml names it differently from the lyteboatAgentDef its composition lists', async () => {
      const root = rootWithAgent('composed', { 'agent.cordis.yml': composition, 'agent.yml': 'name: Other\n', 'agent.mjs': agentModule('{ agentId: \'composed\', agentName: \'Composed\' }'), 'extra.mjs': extraRow })
      const ctx = await catalogHost({ roots: [root], strict: false })

      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.failures().map(problem => problem.reason)).toEqual(['agent.yml names the agent "Other", but its lyteboatAgentDef names it "Composed"; keep one of them'])
    })

    it('fails an agent whose composition lists two lyteboatAgentDef rows', async () => {
      const identity = agentModule('{ agentId: \'twice\', agentName: \'Twice\' }')
      const root = rootWithAgent('twice', { 'agent.cordis.yml': '- id: first\n  name: ./first.mjs\n- id: second\n  name: ./second.mjs\n', 'first.mjs': identity, 'second.mjs': identity })
      const ctx = await catalogHost({ roots: [root], strict: false })

      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.failures()[0]?.reason).toMatch(/agent\.cordis\.yml lists 2 lyteboatAgentDef rows \(.*first\.mjs, .*second\.mjs\); an agent has one/u)
    })

    it('fails an agent whose composition lists a module that does not exist, before importing any', async () => {
      const root = rootWithAgent('unbuilt', { 'agent.cordis.yml': '- id: unbuilt-agent\n  name: ./lib/agent.js\n' })
      const ctx = await catalogHost({ roots: [root], strict: false })

      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.failures()[0]?.reason).toMatch(/agent\.cordis\.yml lists \.\/lib\/agent\.js, which does not exist; build the agent/u)
    })

    it('takes the manifest\'s name when its rows hold no lyteboatAgentDef', async () => {
      const root = rootWithAgent('rows', { 'agent.cordis.yml': '- id: extra\n  name: ./extra.mjs\n', 'agent.yml': 'name: Rows\n', 'extra.mjs': extraRow })
      const ctx = await catalogHost({ roots: [root] })

      await ctx.agentCatalog.whenReady()

      expect(ctx.agentCatalog.get('rows')?.name).toBe('Rows')
    })
  })

  it('finds an agent that is not built yet and says to build it', async () => {
    const root = rootWithAgent('unbuilt', { 'src/agent.ts': 'export {}\n' })
    const ctx = await catalogHost({ roots: [root], strict: false })

    await ctx.agentCatalog.whenReady()

    expect(ctx.agentCatalog.failures()[0]?.reason).toMatch(/has no agent\.cordis\.yml and no lib\/agent\.js; build the agent/u)
  })
})
