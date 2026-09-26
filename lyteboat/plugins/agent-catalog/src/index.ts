/**
 * @lyteboat/agent-catalog — the agents a lyteboat process serves. It scans
 * the configured roots (each direct subdirectory holding `agent.cordis.yml`,
 * `agent.yml`, `lib/agent.js`, or `src/agent.ts` is an agent, its directory
 * name the id; an agent without `agent.cordis.yml` runs `lib/agent.js`, its
 * `lyteboatAgentDef`, which names it), declares every agent to dsh's agent
 * preset registry with its directory as the base URL, and reports the agents
 * that fail to read or mount, using the registry's own diagnostics. It answers
 * only which agents there are and where each one works (its working directory,
 * the `cwd` its sessions are recorded under); driving them is the caller's
 * (`lyteboat try`, `/chat`, eval, and lyteboat web). Before an agent's code runs,
 * its directory's digest is checked against its release pin, when a release
 * lock pins it, and its declared model against this process's, when enforced.
 *
 * The declarations are made once the host tree has settled: the registry's
 * diagnostics wait for that settlement, so they cannot run inside this row's
 * own activation. `whenReady()` resolves when they are made. `reload()`
 * withdraws every declaration and makes them again from what the roots hold
 * now (a session already running keeps the agent it started with), and
 * `watch` reloads whenever a root changes.
 * @module @lyteboat/agent-catalog
 */

import { watch as watchPath } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import type { LyteboatAgentIdentity, LyteboatAgentModel } from '@lyteboat/contracts'
import { agentDigest, type AgentDigest } from './agent-digest.ts'
import { locateAgents, readAgentDefIdentity, readAgentDefinition } from './agent-directory.ts'
import type { AgentCatalogLocation, AgentDirectoryDefinition } from './agent-directory.ts'

export { agentIds } from './agent-directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentCatalog: AgentCatalogService
  }
}

/** One agent the catalog declared and the registry mounted. */
export interface AgentCatalogEntry {
  readonly id: string
  /** The agent directory, the base its rows resolve against. */
  readonly dir: string
  /**
   * The agent's working directory, the `cwd` its sessions are recorded under,
   * wherever the process started; not created until a session needs it, and
   * shown to the model by no prompt of lyteboat's.
   */
  readonly workdir: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  /** Which agent this is: its id, its manifest's version, and its directory's digest; what a request records. */
  readonly identity: LyteboatAgentIdentity
  /** The per-file content hashes the digest is made of (POSIX relative path → sha256). */
  readonly files: Readonly<Record<string, string>>
  /** The model the agent's `agent.yml` declares. */
  readonly model?: LyteboatAgentModel
}

/** What a release lock pins an agent to: its version, its digest, and the per-file hashes behind the digest. */
export interface AgentCatalogPin {
  readonly version: string
  readonly digest: string
  readonly files: Readonly<Record<string, string>>
}

/** One agent the catalog cannot serve, and why. */
export interface AgentCatalogFailure {
  readonly id: string
  readonly dir: string
  readonly reason: string
}

export interface Config {
  /** Directories whose subdirectories are agents; each must exist. */
  roots: string[]
  /** Declare only these ids (in this order); empty or absent declares every agent the roots hold. */
  include?: string[]
  /** A failure fails `whenReady()`; false only reports it through `failures()`. */
  strict?: boolean
  /** Reload whenever a file under a root changes. */
  watch?: boolean
  /** How long a change waits for the next before it reloads. */
  watchDelayMs?: number
  /** Where each agent's working directory is (`<workdirsDir>/<id>`); default `$LYTEBOAT_HOME/agent-workdirs`. */
  workdirsDir?: string
  /** An agent whose `agent.yml` declares a model other than this process's default model fails, before its code runs. */
  enforceDeclaredModel?: boolean
  /** Agents that must be exactly what their release locks say, by id; one that differs fails, before its code runs. */
  pinnedAgents?: Record<string, AgentCatalogPin>
}

const Config: z<Config> = z.object({
  roots: z.array(z.string()).required(),
  include: z.array(z.string()),
  strict: z.boolean().default(true),
  watch: z.boolean().default(false),
  watchDelayMs: z.natural().default(300),
  workdirsDir: z.string(),
  enforceDeclaredModel: z.boolean().default(false),
  pinnedAgents: z.dict(z.object({
    version: z.string().required(),
    digest: z.string().required(),
    files: z.dict(z.string()).required(),
  })),
})

/** Host service: the agent roster and its failures. */
export class AgentCatalogService extends Service {
  static inject = ['agentPresets', 'agentDefaultModel']
  // The loader applies a class plugin's static Config, not the module's.
  static Config = Config

  private readonly entries = new Map<string, AgentCatalogEntry>()
  private readonly problems = new Map<string, AgentCatalogFailure>()
  /** The disposers that withdraw each declaration, by id. */
  private readonly declared = new Map<string, () => Promise<void>>()
  private ready: Promise<void>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'agentCatalog')
    this.ready = this.settle(this.ctx.get('loader')?.await().then(() => this.declareAll()) ?? this.declareAll())
    if (config.watch === true) this.watchRoots()
  }

  /**
   * Settles once every agent is declared and its mount diagnosed.
   * @throws when the roots cannot be read, or, in strict mode, when any agent failed.
   */
  whenReady(): Promise<void> {
    return this.ready
  }

  /** The agents that mounted, by id. */
  list(): AgentCatalogEntry[] {
    return [...this.entries.values()]
  }

  /** One mounted agent; undefined for an unknown or failed id. */
  get(id: string): AgentCatalogEntry | undefined {
    return this.entries.get(id)
  }

  /** The agents that failed to read, declare, or mount. */
  failures(): AgentCatalogFailure[] {
    return [...this.problems.values()]
  }

  /**
   * Withdraw every declaration and declare the agents the roots hold now,
   * after any declaration already under way.
   * @returns what `whenReady()` returns from now on.
   */
  reload(): Promise<void> {
    this.ready = this.settle(this.ready.catch(() => {}).then(async () => {
      for (const withdraw of this.declared.values()) await withdraw()
      this.declared.clear()
      this.entries.clear()
      this.problems.clear()
      await this.declareAll()
    }))
    return this.ready
  }

  /** A caller observes the outcome through whenReady(); an unobserved one must not crash the process. */
  private settle(outcome: Promise<void>): Promise<void> {
    outcome.catch(() => {})
    return outcome
  }

  private watchRoots(): void {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        this.reload().catch((error: unknown) => {
          this.ctx.logger.warn(`agent-catalog: reloading after a change failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, this.config.watchDelayMs ?? 300)
    }
    this.ctx.effect(() => {
      const watchers = this.config.roots.map(root => watchPath(resolve(root), { recursive: true }, changed))
      return () => {
        clearTimeout(timer)
        for (const watcher of watchers) watcher.close()
      }
    }, 'agent-catalog: watch the roots')
  }

  private async declareAll(): Promise<void> {
    const locations = locateAgents(this.config.roots.map(root => resolve(root)), this.config.include)
    const unlocated = Object.keys(this.config.pinnedAgents ?? {}).filter(id => !locations.some(location => location.id === id))
    if (unlocated.length > 0) throw new Error(`agent-catalog: pinned agent(s) ${unlocated.map(id => JSON.stringify(id)).join(', ')} are not declared; pin only agents the roots and include name`)
    for (const location of locations) await this.declare(location)
    if (this.config.strict !== false && this.problems.size > 0) {
      const lines = this.failures().map(failure => `  ${failure.id}: ${failure.reason}`)
      throw new Error(`agent-catalog: ${String(this.problems.size)} agent(s) failed:\n${lines.join('\n')}`)
    }
  }

  /** Why an agent differs from its pin; undefined when it matches, or is not pinned. */
  private pinProblem(id: string, version: string | undefined, digest: AgentDigest): string | undefined {
    const pin = this.config.pinnedAgents?.[id]
    if (pin === undefined) return undefined
    if (pin.version !== version) return `agent.yml declares version ${version ?? '(none)'}, but its release pins ${pin.version}`
    if (pin.digest === digest.digest) return undefined
    const changed = Object.keys(digest.files).filter(path => Object.hasOwn(pin.files, path) && pin.files[path] !== digest.files[path])
    const added = Object.keys(digest.files).filter(path => !Object.hasOwn(pin.files, path))
    const removed = Object.keys(pin.files).filter(path => !Object.hasOwn(digest.files, path))
    const lists = [['changed', changed], ['added', added], ['removed', removed]] as const
    const differences = lists.filter(([, paths]) => paths.length > 0).map(([kind, paths]) => `${kind} ${paths.join(', ')}`)
    return `the directory differs from its release ${pin.version} (${pin.digest}): ${differences.join('; ') || 'the release lists other file hashes'}`
  }

  /** Why this process may not serve an agent's declared model; undefined when it may, or nothing is enforced. */
  private modelProblem(declared: LyteboatAgentModel | undefined): string | undefined {
    if (this.config.enforceDeclaredModel !== true || declared === undefined) return undefined
    const current = this.ctx.agentDefaultModel.currentSelection()
    const running: LyteboatAgentModel = {
      provider: current.provider,
      model: current.model,
      ...current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) },
    }
    if (running.provider === declared.provider && running.model === declared.model && running.reasoningEffort === declared.reasoningEffort) return undefined
    return `agent.yml declares model ${modelName(declared)}, but this process runs ${modelName(running)}; run it with that default model (the agent-default-model row) or change agent.yml`
  }

  /** The preset the agent's `lyteboatAgentDef` names, when it has one; the manifest's name, when it gives one, must agree. */
  private async namedPreset(definition: AgentDirectoryDefinition): Promise<AgentDirectoryDefinition['preset']> {
    const identity = await readAgentDefIdentity(definition.agentDefSource)
    if (identity === undefined) return definition.preset
    const { agentName } = identity
    const manifestName = definition.preset.name
    if (manifestName !== undefined && manifestName !== agentName) {
      throw new Error(`agent.yml names the agent "${manifestName}", but its lyteboatAgentDef names it "${agentName}"; keep one of them`)
    }
    return { ...definition.preset, name: agentName }
  }

  // Everything that can refuse an agent runs before its code does: the pin and the model
  // before its lyteboatAgentDef module is read, and all of them before presets.register mounts it.
  private async declare({ id, dir }: AgentCatalogLocation): Promise<void> {
    const fail = (reason: string): void => { this.problems.set(id, { id, dir, reason }) }
    if (!isSkillName(id)) return fail(`"${id}" is not a kebab-case id; rename the directory`)
    let definition: AgentDirectoryDefinition
    let digest: AgentDigest
    try {
      definition = readAgentDefinition(id, dir)
      digest = agentDigest(dir)
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const pinProblem = this.pinProblem(id, definition.version, digest)
    if (pinProblem !== undefined) return fail(pinProblem)
    const modelProblem = this.modelProblem(definition.model)
    if (modelProblem !== undefined) return fail(modelProblem)
    let presetDefinition = definition.preset
    // The registry takes the declaration's base URL from its caller's context.
    const presets = this.ctx.extend({ baseUrl: pathToFileURL(join(dir, sep)).href }).agentPresets
    try {
      presetDefinition = await this.namedPreset(definition)
      const declared = presetDefinition
      this.declared.set(id, this.ctx.effect(() => presets.register(declared), `agent-catalog.declare(${id})`))
    } catch (error: unknown) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    const preset = await this.ctx.agentPresets.resolve(id)
    if (preset.broken !== undefined) return fail(preset.broken)
    const { name, description, order } = presetDefinition
    const { version, model } = definition
    this.entries.set(id, {
      id, dir,
      workdir: join(this.config.workdirsDir ?? dshHomePath('agent-workdirs'), id),
      identity: { id, ...version === undefined ? {} : { version }, digest: digest.digest },
      files: digest.files,
      ...name === undefined ? {} : { name },
      ...description === undefined ? {} : { description },
      ...order === undefined ? {} : { order },
      ...model === undefined ? {} : { model },
    })
  }
}

function modelName(model: LyteboatAgentModel): string {
  return `${model.provider}/${model.model}${model.reasoningEffort === undefined ? '' : ` (reasoningEffort ${model.reasoningEffort})`}`
}

export default AgentCatalogService
