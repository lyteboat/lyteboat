/**
 * @lyteboat/tool-policy — lyteboat's tool policy over the dsh tool registry. One host
 * service, `ctx.toolPolicy`, holds lyteboat-side metadata for tools registered in
 * the global layer or a preset's standing layer, and enforces it at two dsh
 * seams:
 *
 * - visibility: an `auto` tool stays out of the model's schemas until a
 *   plugin activates it for the agent (`activate`); a scope can hide every
 *   inherited tool its policy does not declare (`declareInherited('hidden')`),
 *   and such a tool stays hidden: only declared tools are activated. The
 *   agent's restriction is recomputed after every `lyteboat/pre-assemble` and
 *   reissued only when the denied set changed;
 * - state: a tool registered with `stateDelta` carries its delta on the
 *   result's presentation meta (`meta.lyteboat.stateDelta`), and a delta the
 *   state cannot hold fails the call instead; the `lyteboatState` projection
 *   folds it straight from the `tool/result` node (successful, top-level calls
 *   only) and renders it to the model as the `lyteboat:state` runtime context.
 *   No lyteboat node is written: dsh's persistence refuses logs with event
 *   types it does not know.
 *
 * Only inherited tools can be hidden — dsh's `restrict` never filters an
 * agent's own layer — so register and declare through the host or a preset
 * row, never through `agent.ctx`.
 * @module @lyteboat/tool-policy
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NamedEntries, ScopedLayers, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { LYTEBOAT_STATE_CONTEXT_ORDER } from '@lyteboat/contracts'
import type { LyteboatInheritedToolVisibility, LyteboatToolMeta, JsonValue } from '@lyteboat/contracts'
import { lyteboatStateProjectionDefinition, isJsonObject, mergeStateDelta, renderLyteboatState } from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolPolicy: ToolPolicyService
  }
}

/** Metadata a composition file can declare for a tool registered elsewhere: everything but the code-only delta. */
export type LyteboatToolPolicy = Omit<LyteboatToolMeta, 'stateDelta'>

/** One scope's policy contribution. */
class PolicyLayer implements ScopeLayer {
  readonly metas: NamedEntries<LyteboatToolMeta>
  /** The visibility of the inherited tools no declaration on the chain names; one cell, since two answers contradict. */
  inherited: LyteboatInheritedToolVisibility | undefined

  constructor(scope: ScopeKey | undefined) {
    this.metas = new NamedEntries(name => new Error(scope === undefined
      ? `lyteboat tool policy for "${name}" is already declared globally`
      : `lyteboat tool policy for "${name}" is already declared in this scope`))
  }

  isEmpty(): boolean {
    return this.metas.isEmpty() && this.inherited === undefined
  }
}

interface AgentPolicyState {
  readonly activated: Set<string>
  /** The denied names behind the live restriction, sorted; empty when none is issued. */
  deny: string[]
  dispose: (() => void) | undefined
}

/** Wrap a definition so its presentation meta carries the lyteboat state delta beside the tool's own meta. */
function withStateDelta(definition: ToolDefinition, stateDelta: NonNullable<LyteboatToolMeta['stateDelta']>): ToolDefinition {
  const output = definition.output
  const inner = output.presentationMeta?.bind(output)
  return {
    ...definition,
    output: {
      ...output,
      presentationMeta(args: unknown, value: JsonValue): JsonValue {
        const base = inner?.(args, value)
        const delta = stateDelta(args, value)
        // dsh refuses an undefined presentation meta, so a call with neither a delta
        // nor a meta of the tool's own records an empty object.
        if (delta === undefined) return base ?? {}
        // The lyteboatState fold refuses a delta it cannot merge, and a refused result
        // stops every projection of the session; thrown here, dsh fails the call instead.
        mergeStateDelta({}, delta)
        if (base === undefined) return { lyteboat: { stateDelta: delta } }
        // A tool's own `lyteboat` object (a rendered card) merges with the delta instead of losing it.
        if (isJsonObject(base)) return { ...base, lyteboat: { ...isJsonObject(base['lyteboat']) ? base['lyteboat'] : {}, stateDelta: delta } }
        return { presentation: base, lyteboat: { stateDelta: delta } }
      },
    },
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

/** Host service: lyteboat tool metadata plus its enforcement at the dsh tool seams. */
export class ToolPolicyService extends Service {
  // lyteboatDistro: visibility is reconciled in the kernel extension agent-loop-pre-assemble.
  static inject = ['tools', 'sessionProjections', 'systemPrompt', 'lyteboatDistro']

  private readonly layers = new ScopedLayers(scope => new PolicyLayer(scope), () => {})
  private readonly agents = new WeakMap<Agent, AgentPolicyState>()

  constructor(ctx: Context) {
    super(ctx, 'toolPolicy')
    ctx.sessionProjections.register(lyteboatStateProjectionDefinition)
    ctx.systemPrompt.context({
      name: 'lyteboat:state',
      order: LYTEBOAT_STATE_CONTEXT_ORDER,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        return renderLyteboatState(ctx.sessionProjections.stateOf(agent.session, 'lyteboatState'))
      },
    })
    // After `next()`: listeners registered later (a `--plugin` row, a preset
    // row) activate inside the same waterfall, and the restriction they need
    // is computed once they returned.
    ctx.on('lyteboat/pre-assemble', async (payload, next) => {
      await next()
      this.reconcile(payload.agent)
    })
  }

  /**
   * Register a tool in the calling scope's layer together with its lyteboat
   * metadata. A `stateDelta` is folded into the tool's presentation meta.
   * @param definition - the dsh tool definition.
   * @param meta - lyteboat-side metadata; `visibility` defaults to `always`.
   * @returns the exact disposer that unregisters both.
   */
  register(definition: ToolDefinition, meta: LyteboatToolMeta = {}): () => void {
    const wrapped = meta.stateDelta === undefined ? definition : withStateDelta(definition, meta.stateDelta)
    const disposeTool = this.ctx.tools.register(wrapped)
    let disposeMeta: () => void
    try {
      disposeMeta = this.declare(definition.name, meta)
    } catch (error: unknown) {
      disposeTool()
      throw error
    }
    return () => {
      disposeMeta()
      disposeTool()
    }
  }

  /**
   * Declare metadata for a tool registered elsewhere (an official dsh tool, a
   * agent row's tool), in the calling scope's layer. Nearest scope wins.
   * @param name - the tool name as registered.
   * @param meta - lyteboat-side metadata.
   * @returns the exact disposer that withdraws the declaration.
   */
  declare(name: string, meta: LyteboatToolMeta): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.metas.insert(name, meta),
      { label: 'toolPolicy.declare()', notify: false },
    )
  }

  /**
   * Declare, in the calling scope's layer, whether the tools its agents
   * inherit and no declaration on their chain names reach the model. Nearest
   * scope wins; without one they are `visible`. A hidden inherited tool stays
   * hidden: `activate` names declared tools only.
   * @param visibility - `visible` or `hidden`.
   * @returns the exact disposer that withdraws the declaration.
   * @throws when the scope already declared it.
   */
  declareInherited(visibility: LyteboatInheritedToolVisibility): () => void {
    return this.layers.effect(
      this.ctx,
      (layer) => {
        if (layer.inherited !== undefined) throw new Error(`lyteboat tool policy: the visibility of inherited tools is already declared in this scope (${layer.inherited})`)
        layer.inherited = visibility
        return () => { layer.inherited = undefined }
      },
      { label: 'toolPolicy.declareInherited()', notify: false },
    )
  }

  /**
   * The metadata a scope resolves for a tool: its own chain, nearest scope last.
   * An agent is its own scope key (the agent loop keys each agent's scope by
   * the agent), so an agent and a preset's standing scope resolve alike.
   * @param name - the tool name.
   * @param scope - the viewing agent or scope; omitted for the global view.
   */
  metaOf(name: string, scope?: ScopeKey): LyteboatToolMeta | undefined {
    return this.layers.merge(scope, layer => layer.metas).get(name)
  }

  /**
   * Make `auto` tools visible to one agent from its next assembly on (or this
   * step's, when called inside `lyteboat/pre-assemble`). Names must be declared.
   * @param agent - the agent whose visibility changes.
   * @param names - declared tool names.
   */
  activate(agent: Agent, names: readonly string[]): void {
    const known = this.layers.merge(scopeOf(agent.ctx), layer => layer.metas)
    const unknown = names.filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`lyteboat tool policy: cannot activate undeclared tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => JSON.stringify(name)).join(', ')}; declared: ${[...known.keys()].sort().join(', ') || '(none)'}`)
    }
    const state = this.stateOf(agent)
    for (const name of names) state.activated.add(name)
    this.reconcile(agent)
  }

  /**
   * Withdraw every activation of one agent; its `auto` tools hide again.
   * @param agent - the agent to reset.
   */
  clear(agent: Agent): void {
    const state = this.agents.get(agent)
    if (state === undefined) return
    state.activated.clear()
    this.reconcile(agent)
  }

  /** The names one agent activated, sorted. */
  activated(agent: Agent): string[] {
    return [...this.agents.get(agent)?.activated ?? []].sort()
  }

  /**
   * The tool names an agent started under a scope (a preset's standing scope)
   * sees before anything is activated, in registry order: its `auto` tools and,
   * with inherited tools hidden, every undeclared inherited tool, are left out.
   * A running agent's current view is `ctx.tools.schemas(agent)`.
   * @param scope - the standing scope a new agent inherits from.
   */
  visible(scope: ScopeKey): string[] {
    const denied = new Set(this.deniedFor(scope, scope, new Set()))
    return this.ctx.tools.schemas(scope).map(schema => schema.name).filter(name => !denied.has(name))
  }

  private stateOf(agent: Agent): AgentPolicyState {
    let state = this.agents.get(agent)
    if (state === undefined) {
      state = { activated: new Set(), deny: [], dispose: undefined }
      this.agents.set(agent, state)
    }
    return state
  }

  /** Whether one scope's undeclared inherited tools reach the model: the nearest declaration on its chain, `visible` without one. */
  private inheritedOf(key: ScopeKey): LyteboatInheritedToolVisibility {
    let visibility: LyteboatInheritedToolVisibility = 'visible'
    for (const layer of [this.layers.global, ...this.layers.chainLayers(key)]) visibility = layer.inherited ?? visibility
    return visibility
  }

  /**
   * The names an agent of `scope`, inheriting `inheritedView`, is denied: every
   * declared `auto` tool not activated and, with inherited tools `hidden`, every
   * inherited tool no declaration names. Sorted.
   */
  private deniedFor(scope: ScopeKey, inheritedView: ScopeKey | undefined, activated: ReadonlySet<string>): string[] {
    const declared = [...this.layers.merge(scope, layer => layer.metas)]
    const declaredNames = new Set(declared.map(([name]) => name))
    // The parent's view is what the agent inherits before its own restriction;
    // the PTC transport sits outside every restriction and is never named.
    const hiddenInherited = this.inheritedOf(scope) === 'hidden'
      ? this.ctx.tools.schemas(inheritedView).map(schema => schema.name).filter(name => name !== RUN_CODE_NAME && !declaredNames.has(name))
      : []
    return declared
      .filter(([name, meta]) => meta.visibility === 'auto' && !activated.has(name))
      .map(([name]) => name)
      .concat(hiddenInherited)
      .sort()
  }

  /**
   * Recompute one agent's restriction: every `auto` tool it inherits and has
   * not activated is denied, and with inherited tools `hidden` every inherited
   * tool no declaration names. Reissued only when the set changed.
   * @throws when a declared name reaches the agent registered by no row, or
   * an `auto` tool sits in the agent's own layer, where `restrict` cannot hide
   * it: both are composition mistakes and never silently pass.
   */
  private reconcile(agent: Agent): void {
    const key = scopeOf(agent.ctx)
    if (key === undefined) return
    const state = this.stateOf(agent)
    const inheritedView = scopeParentOf(key)
    const declared = [...this.layers.merge(key, layer => layer.metas)]
    // `get` answers from the visible view, which the agent's own restriction
    // filters; the parent's view is unrestricted, and an own-layer tool is
    // never restricted, so between the two every registered name shows.
    const unregistered = declared
      .filter(([name]) => this.ctx.tools.get(name, inheritedView) === undefined && this.ctx.tools.get(name, key) === undefined)
      .map(([name]) => name)
    if (unregistered.length > 0) {
      throw new Error(`lyteboat tool policy: declared tool${unregistered.length > 1 ? 's' : ''} ${unregistered.map(name => JSON.stringify(name)).join(', ')} registered by no row reachable from agent "${agent.id}"`)
    }
    const unrestrictable = declared
      .filter(([name, meta]) => meta.visibility === 'auto' && this.ctx.tools.get(name, inheritedView) === undefined)
      .map(([name]) => name)
    if (unrestrictable.length > 0) {
      throw new Error(`lyteboat tool policy: auto tool${unrestrictable.length > 1 ? 's' : ''} ${unrestrictable.map(name => JSON.stringify(name)).join(', ')} registered in agent "${agent.id}"'s own layer, which restrict() cannot hide; register through the host or an agent row`)
    }
    const deny = this.deniedFor(key, inheritedView, state.activated)
    if (sameNames(deny, state.deny)) return
    state.dispose?.()
    state.dispose = deny.length === 0 ? undefined : agent.ctx.tools.restrict({ deny })
    state.deny = deny
  }
}

export default ToolPolicyService
