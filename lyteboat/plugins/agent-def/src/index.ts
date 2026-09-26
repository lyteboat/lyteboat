/**
 * @lyteboat/agent-def — a business agent's one declaration. An agent module
 * default-exports `lyteboatAgentDef({…})`, which returns the plugin class that
 * is the agent directory's one row, mounted once in the agent's standing scope
 * by dsh's preset registry (not once per session). Mounted, the row checks the
 * definition and that `agentId` names its directory, then hands each
 * declaration to the host service that owns it, in a fixed order: persona,
 * skill routing, tool policy, skills, model request overrides, admission,
 * tools, the render tool, event listeners. Every registration is an effect of
 * the row, withdrawn when the agent unloads, and reaches only the sessions of
 * this agent. The agent loop, compaction, history, and the other runtime rows
 * stay where the host and the bundles put them.
 * @module @lyteboat/agent-def
 */

import { Service, type Context, type Events } from '@deepseek-ai/cordis'
import type { Config as DshPersonaConfig } from '@deepseek-ai/dsh-persona'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { A2uiService, RenderToolOptions } from '@lyteboat/a2ui'
import type { AuxLlmService } from '@lyteboat/aux-llm'
import type { LyteboatAgentDefIdentity, LyteboatInheritedToolVisibility, LyteboatToolMeta } from '@lyteboat/contracts'
import type { LyteboatAdmission } from '@lyteboat/intake-guard'
import type { RequestContextService } from '@lyteboat/request-context'
import type { SkillRouterSettings } from '@lyteboat/skill-router'
import type { LyteboatToolPolicy } from '@lyteboat/tool-policy'
import { mountLyteboatAgent } from './agent-def-mount.ts'

/** The policy for tools other rows register (dsh's `skill`, a dsh tool row), and whether the inherited tools it does not name reach the model. */
export interface LyteboatAgentToolPolicy {
  /** Absent: `visible`. `hidden` keeps every inherited tool not named in `tools` away from the model. */
  inherited?: LyteboatInheritedToolVisibility
  tools?: Record<string, LyteboatToolPolicy>
}

/**
 * Overrides laid over every model request of this agent's loop. The provider,
 * the model, and the reasoning effort stay the model selection's.
 */
export interface LyteboatAgentModelRequest {
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** The generic `render_a2ui` tool, over a templates directory relative to the agent directory. */
export type LyteboatAgentA2uiRenderTool = Omit<RenderToolOptions, 'templates'> & { templatesDir: string }

/** One of the agent's own tools: the dsh tool definition and its lyteboat metadata (`visibility` defaults to `always`). */
export type LyteboatAgentTool = LyteboatToolMeta & { definition: ToolDefinition }

/**
 * The events dsh delivers per agent: their listeners run with the agent as
 * `this`, so a listener in the agent's scope sees only this agent's events.
 */
export type LyteboatAgentEventName = {
  [EventName in keyof Events]: ThisParameterType<Events[EventName]> extends Scoped<object> ? EventName : never
}[keyof Events]

/** Event name → listener, for the events dsh delivers per agent (`agent/*`, `tools/*`, `lyteboat/intake`, `lyteboat/pre-assemble`, …). */
export type LyteboatAgentEventListeners = { [EventName in LyteboatAgentEventName]?: Events[EventName] }

/**
 * What the framework hands to `tools`, `admission`, and `eventListeners`:
 * paths under the agent directory, to find the agent's assets, and what
 * business code calls on three host services.
 */
export interface LyteboatAgentHost {
  /**
   * @param relativePath - a path under the agent directory, such as `assets/a2ui`.
   * @returns its absolute path.
   */
  agentPath(relativePath: string): string
  /** Renders a card from a templates directory. */
  readonly a2ui: Pick<A2uiService, 'renderCard'>
  /** Side model calls (an admission classifier), each recorded in the session log. */
  readonly auxLlm: Pick<AuxLlmService, 'generate'>
  /** The context of the request a message answers to. */
  readonly requestContext: Pick<RequestContextService, 'contextOf'>
}

/** A business agent's declaration. Relative paths resolve against the agent directory. */
export interface LyteboatAgentDef {
  /** The agent directory's name; mounting fails when they differ. */
  agentId: string
  /** The name the agent catalog, the CLI, and Studio show. */
  agentName: string
  /** dsh-persona's configuration, mounted in the agent's scope. */
  persona?: DshPersonaConfig
  /** Absent: `assets/skills` when that directory exists. A listed directory that does not exist fails. */
  skillDirs?: readonly string[]
  /** Overrides the host's routing defaults (`mode: off`) for this agent. */
  skillRouting?: Partial<SkillRouterSettings>
  toolPolicy?: LyteboatAgentToolPolicy
  /** Its fields win over the same fields an `agent/request` listener in `eventListeners` returns. */
  modelRequest?: LyteboatAgentModelRequest
  /** The agent's own tools, in registration order. */
  tools?: (host: LyteboatAgentHost) => readonly LyteboatAgentTool[]
  /** The admission that answers a request before the loop runs. */
  admission?: (host: LyteboatAgentHost) => LyteboatAdmission
  a2uiRenderTool?: LyteboatAgentA2uiRenderTool
  eventListeners?: (host: LyteboatAgentHost) => LyteboatAgentEventListeners
}

/** The class `lyteboatAgentDef` returns: a Cordis plugin, the agent directory's one row. */
export interface LyteboatAgentPlugin {
  new (ctx: Context, rowConfig?: unknown): object
  /** The host services the definition's fields need. */
  readonly inject: string[]
  /** What the agent catalog reads to name the agent before it mounts. */
  readonly lyteboatAgentDefIdentity: LyteboatAgentDefIdentity
}

/**
 * The services each field reaches through, so a row whose service is missing waits for it where the preset audit sees it.
 * A hook may call any of the host's three, so a definition with a hook waits for all three.
 */
function injectedServicesOf(agentDef: LyteboatAgentDef): string[] {
  const hasHostHook = agentDef.tools !== undefined || agentDef.admission !== undefined || agentDef.eventListeners !== undefined
  const services = new Set<string>()
  if (agentDef.persona !== undefined) services.add('systemPrompt')
  if (agentDef.skillDirs === undefined || agentDef.skillDirs.length > 0) services.add('skills')
  if (agentDef.skillRouting !== undefined) services.add('skillRouter')
  if (agentDef.toolPolicy !== undefined || agentDef.tools !== undefined) services.add('toolPolicy')
  if (agentDef.admission !== undefined) services.add('intakeGuard')
  if (agentDef.a2uiRenderTool !== undefined || hasHostHook) services.add('a2ui')
  if (hasHostHook) {
    services.add('auxLlm')
    services.add('requestContext')
  }
  return [...services]
}

function isEmptyRowConfig(rowConfig: unknown): boolean {
  return rowConfig === undefined || rowConfig === null || (typeof rowConfig === 'object' && Object.keys(rowConfig).length === 0)
}

/**
 * Declare a business agent. The definition is checked when the row mounts, so
 * a mistake is reported against the agent that made it.
 * @param agentDef - the declaration.
 * @returns the plugin class the agent module default-exports.
 */
export function lyteboatAgentDef(agentDef: LyteboatAgentDef): LyteboatAgentPlugin {
  const LyteboatAgent = class {
    static readonly inject: string[] = injectedServicesOf(agentDef)
    static readonly lyteboatAgentDefIdentity: LyteboatAgentDefIdentity = { agentId: agentDef.agentId, agentName: agentDef.agentName }
    readonly #ctx: Context

    constructor(ctx: Context, rowConfig?: unknown) {
      // Everything the agent declares is in its definition; a row config would be dropped without a word.
      if (!isEmptyRowConfig(rowConfig)) throw new Error(`lyteboat agent def ${agentDef.agentId}: its row takes no config; declare it in lyteboatAgentDef({…})`)
      this.#ctx = ctx
    }

    async [Service.init](): Promise<void> {
      await mountLyteboatAgent(this.#ctx, agentDef)
    }
  }
  // Cordis names a plugin's fibers after the class; one name per agent keeps its diagnostics apart.
  Object.defineProperty(LyteboatAgent, 'name', { value: `lyteboat-agent:${agentDef.agentId}` })
  return LyteboatAgent
}
