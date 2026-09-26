/**
 * An agent directory: `<root>/<id>/` holding any of `agent.cordis.yml`, the
 * agent's plugin rows (a Cordis entry list, `!!js` included); `agent.yml`, its
 * manifest (`LyteboatAgentManifest`: display fields, version, model);
 * `lib/agent.js`, its built `lyteboatAgentDef` module; or `src/agent.ts`, that
 * module's source. A directory reads into one dsh agent preset declaration
 * (the id is the directory name, the display fields come from the manifest)
 * and the manifest fields the preset registry has no place for. The rows are
 * `agent.cordis.yml` taken verbatim when it exists, and otherwise the one row
 * `./lib/agent.js`. The `lyteboatAgentDef` among them, that one row or the one
 * module the composition names by a relative path whose default export is a
 * definition, names the agent.
 *
 * The discovery is adapted from deepseek-ai/deepseek-harness
 * packages/preset/agent-presets/src/discovery.ts @ dsh-v0.1.5-alpha.2
 * (b2e3b2a0), MIT — see THIRD_PARTY_NOTICES.md. Differences: a directory's id
 * must be unique across the roots; the manifest is lyteboat's and a malformed
 * one fails loud.
 * @module @lyteboat/agent-catalog/agent-directory
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, type LoadOptions } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { lyteboatAgentDefIdentitySchema, lyteboatAgentManifestSchema, type LyteboatAgentDefIdentity, type LyteboatAgentManifest, type LyteboatAgentModel } from '@lyteboat/contracts'

/** The composition file: the agent's rows, when it lists them itself. */
const AGENT_COMPOSITION_FILE = 'agent.cordis.yml'

/** The optional manifest. */
const AGENT_MANIFEST_FILE = 'agent.yml'

/** The built module an agent without a composition file runs as its one row. */
const AGENT_ENTRY_MODULE = 'lib/agent.js'

/** That module's source: it marks an agent that has not been built yet. */
const AGENT_SOURCE_MODULE = 'src/agent.ts'

/** The files any one of which makes a directory an agent. */
const AGENT_MARKER_FILES = [AGENT_COMPOSITION_FILE, AGENT_MANIFEST_FILE, AGENT_ENTRY_MODULE, AGENT_SOURCE_MODULE]

/** The display-metadata file the manifest replaced; its presence is a stale directory. */
const RETIRED_METADATA_FILE = 'preset.yml'

function isAgentDirectory(root: string, name: string): boolean {
  return AGENT_MARKER_FILES.some(file => existsSync(join(root, name, file)))
}

/**
 * The agent ids a set of roots holds: every direct subdirectory holding an agent's composition, manifest, or module.
 * @param roots - absolute agent root directories.
 * @returns the ids, deduplicated and sorted.
 */
export function agentIds(roots: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && isAgentDirectory(root, entry.name)) ids.add(entry.name)
    }
  }
  return [...ids].sort()
}

/** One agent directory the roots hold. */
export interface AgentCatalogLocation {
  readonly id: string
  readonly dir: string
}

/**
 * The agent directories to declare: every agent the roots hold, or the
 * `include`d ones in that order.
 * @param roots - absolute agent root directories.
 * @param include - the ids to take; empty or absent takes every agent.
 * @returns the locations, sorted by id without `include`.
 * @throws when a root is not a directory, two roots hold the same id, or no root holds an included id.
 */
export function locateAgents(roots: readonly string[], include: readonly string[] | undefined): AgentCatalogLocation[] {
  const found = new Map<string, string>()
  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`agent-catalog: agent root not found: ${root}`)
    for (const id of agentIds([root])) {
      const other = found.get(id)
      if (other !== undefined) throw new Error(`agent-catalog: agent "${id}" is in two roots: ${other} and ${root}`)
      found.set(id, root)
    }
  }
  const ids = include !== undefined && include.length > 0 ? include : [...found.keys()].sort()
  const missing = ids.filter(id => !found.has(id))
  if (missing.length > 0) throw new Error(`agent-catalog: no root holds ${missing.map(id => JSON.stringify(id)).join(', ')} (available: ${[...found.keys()].sort().join(', ') || 'none'})`)
  return ids.map(id => ({ id, dir: join(found.get(id) ?? '', id) }))
}

function readYaml(path: string, options?: LoadOptions): unknown {
  try {
    return load(readFileSync(path, 'utf8'), options)
  } catch (error: unknown) {
    throw new Error(`agent-catalog: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function readManifest(dir: string): LyteboatAgentManifest {
  if (existsSync(join(dir, RETIRED_METADATA_FILE))) {
    throw new Error(`agent-catalog: ${join(dir, RETIRED_METADATA_FILE)} is now ${AGENT_MANIFEST_FILE}: rename it (name, description, and order stay; version and model are new)`)
  }
  const path = join(dir, AGENT_MANIFEST_FILE)
  if (!existsSync(path)) return {}
  const parsed = lyteboatAgentManifestSchema.safeParse(readYaml(path) ?? {})
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.') || '(the file)'}: ${issue.message}`)
    throw new Error(`agent-catalog: ${path}: ${problems.join('; ')}`)
  }
  return parsed.data
}

/**
 * Where an agent's `lyteboatAgentDef` is: the built module that is its one
 * row, or among the modules its composition names by a relative path, where
 * at most one declares it and the others are rows of their own.
 */
export type AgentDefSource =
  | { readonly kind: 'entry-module'; readonly modulePath: string }
  | { readonly kind: 'composition'; readonly compositionPath: string; readonly modulePaths: readonly string[] }

/** One agent directory read: the preset the registry mounts, and the manifest fields it has no place for. */
export interface AgentDirectoryDefinition {
  readonly preset: PresetDefinition
  readonly version?: string
  readonly model?: LyteboatAgentModel
  readonly agentDefSource: AgentDefSource
}

function isRelativeModule(moduleName: string): boolean {
  return moduleName.startsWith('./') || moduleName.startsWith('../')
}

/** The rows an agent runs: its composition file's, verbatim, or else the one row of its built module. */
function readAgentRows(id: string, dir: string): { rows: PresetDefinition['plugins']; agentDefSource: AgentDefSource } {
  const compositionPath = join(dir, AGENT_COMPOSITION_FILE)
  if (existsSync(compositionPath)) {
    const rows: unknown = readYaml(compositionPath, { schema: entryListSchema })
    const problem = entryListProblem(rows, compositionPath)
    if (problem !== undefined || !Array.isArray(rows)) throw new Error(`agent-catalog: ${problem ?? `${compositionPath} must be a list of plugin rows`}`)
    // Checked by the registry's own entry-list check above.
    const checkedRows = rows as PresetDefinition['plugins']
    const modulePaths = checkedRows.filter(row => isRelativeModule(row.name)).map((row) => {
      const modulePath = resolve(dir, row.name)
      if (!existsSync(modulePath)) throw new Error(`agent-catalog: ${compositionPath} lists ${row.name}, which does not exist; build the agent, or fix the row`)
      return modulePath
    })
    return { rows: checkedRows, agentDefSource: { kind: 'composition', compositionPath, modulePaths } }
  }
  const modulePath = join(dir, AGENT_ENTRY_MODULE)
  if (!existsSync(modulePath)) {
    throw new Error(`agent-catalog: ${dir} has no ${AGENT_COMPOSITION_FILE} and no ${AGENT_ENTRY_MODULE}; build the agent (${AGENT_SOURCE_MODULE} compiles to ${AGENT_ENTRY_MODULE}), or list its rows in ${AGENT_COMPOSITION_FILE}`)
  }
  return { rows: [{ id: `${id}-agent`, name: `./${AGENT_ENTRY_MODULE}` }], agentDefSource: { kind: 'entry-module', modulePath } }
}

/**
 * Read one agent directory into its preset declaration and manifest. The row
 * list is checked for being a list only; the preset registry judges the rows
 * themselves and refuses a composition it cannot mount.
 * @param id - the agent id.
 * @param dir - the agent directory.
 * @returns the declaration to register, with the manifest's version and model.
 * @throws when a file is unreadable or not the shape its role requires, the directory has neither rows nor a built module, or the retired `preset.yml` is still there.
 */
export function readAgentDefinition(id: string, dir: string): AgentDirectoryDefinition {
  const { rows, agentDefSource } = readAgentRows(id, dir)
  const { name, description, order, version, model } = readManifest(dir)
  return {
    preset: {
      id,
      ...name === undefined ? {} : { name },
      ...description === undefined ? {} : { description },
      ...order === undefined ? {} : { order },
      plugins: rows,
    },
    ...version === undefined ? {} : { version },
    ...model === undefined ? {} : { model },
    agentDefSource,
  }
}

/**
 * The identity a module declares, when its default export is the class
 * `lyteboatAgentDef({…})` returns, which carries it as a static.
 * @returns undefined when the default export is no definition.
 * @throws when the module fails to load, or its definition's identity is malformed.
 */
async function agentDefIdentityOf(modulePath: string): Promise<LyteboatAgentDefIdentity | undefined> {
  // A file boundary: whatever the module exports is checked against the identity's schema.
  const agentModule: { default?: { lyteboatAgentDefIdentity?: unknown } } = await import(pathToFileURL(modulePath).href)
  const declared = agentModule.default?.lyteboatAgentDefIdentity
  if (declared === undefined) return undefined
  const identity = lyteboatAgentDefIdentitySchema.safeParse(declared)
  if (!identity.success) {
    throw new Error(`agent-catalog: ${modulePath}: its lyteboatAgentDef declares ${identity.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  return identity.data
}

/**
 * The identity an agent's `lyteboatAgentDef` declares. The modules are
 * imported here, before the registry mounts them, so an error in one is
 * reported with its own message.
 * @param agentDefSource - where the definition is.
 * @returns the declared agent id and name; undefined when a composition's modules hold no definition.
 * @throws when a module fails to load, the one row is no definition, a composition names two, or an identity is malformed.
 */
export async function readAgentDefIdentity(agentDefSource: AgentDefSource): Promise<LyteboatAgentDefIdentity | undefined> {
  switch (agentDefSource.kind) {
    case 'entry-module': {
      const identity = await agentDefIdentityOf(agentDefSource.modulePath)
      if (identity === undefined) {
        throw new Error(`agent-catalog: ${agentDefSource.modulePath} must default-export lyteboatAgentDef({…}) from @lyteboat/agent-def, or its directory must list its rows in ${AGENT_COMPOSITION_FILE}`)
      }
      return identity
    }
    case 'composition': {
      const declaring: { modulePath: string; identity: LyteboatAgentDefIdentity }[] = []
      for (const modulePath of agentDefSource.modulePaths) {
        const identity = await agentDefIdentityOf(modulePath)
        if (identity !== undefined) declaring.push({ modulePath, identity })
      }
      if (declaring.length > 1) {
        throw new Error(`agent-catalog: ${agentDefSource.compositionPath} lists ${String(declaring.length)} lyteboatAgentDef rows (${declaring.map(({ modulePath }) => modulePath).join(', ')}); an agent has one`)
      }
      return declaring[0]?.identity
    }
    default:
      return assertNever(agentDefSource, 'agent-catalog lyteboatAgentDef source')
  }
}
