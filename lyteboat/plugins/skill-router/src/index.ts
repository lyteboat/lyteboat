/**
 * @lyteboat/skill-router — the reference skill loading and routing over the dsh skill
 * registry. One host service, `ctx.skillRouter`, with per-scope settings
 * (host row defaults, overridden by an agent's registrar row):
 *
 * - `off`: nothing.
 * - `full`: every model-invocable skill's body is a system prompt section
 *   (`lyteboat:skills`) and every tool the skills require is activated; no
 *   routing.
 * - `dynamic`: each user input is routed by a side model call (the reference
 *   LLMSkillRouter prompt and rules, sticky on null / errors / timeouts). The
 *   chosen skill's `metadata.lyteboat.requiredTools` are activated through
 *   `ctx.toolPolicy` for the same step, replacing the previous skill's, and
 *   its body enters the step as dsh's own skill-invocation message, the
 *   record dsh-tool-skill writes when a user invokes a skill. The model
 *   loading a skill through the `skill` tool activates it too.
 *
 * Activation is durable in vocabulary every dsh reader knows: the
 * `lyteboatActiveSkill` projection folds skill-invocation messages and
 * successful `skill` tool calls from the log, so a resumed session restores
 * its tools, and a body compaction has shadowed is injected again. The router
 * call goes through `ctx.auxLlm`, which records it (prompt, answer or failure)
 * as an ignorable `lyteboat/aux-llm-call`.
 * @module @lyteboat/skill-router
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { AnonymousEntries, ScopedLayers } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { SkillDefinition, SkillInvocationSource, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { AuxLlmRoute } from '@lyteboat/aux-llm'
import type {} from '@lyteboat/tool-policy'
import { LYTEBOAT_SKILLS_SECTION_ORDER, lyteboatActiveSkillStateSchema, lyteboatSkillMetaSchema } from '@lyteboat/contracts'
import type { LyteboatActiveSkillState, LyteboatSkillMeta, LyteboatStepPayload } from '@lyteboat/contracts'
import { SKILL_ROUTER_SYSTEM_PROMPT, buildRoutePrompt, renderHistory, resolveRouteDecision } from './router.ts'
import type { RouteCandidate, RouteDecision } from './router.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillRouter: SkillRouterService
  }
}

/** The router call's `purpose` in its `lyteboat/aux-llm-call` record. */
const SKILL_ROUTER_PURPOSE = 'skill-router'
/** The dsh tool through which the model loads a skill itself. */
const SKILL_TOOL = 'skill'

export type SkillLoadMode = 'off' | 'full' | 'dynamic'

/** The resolved settings one agent runs under. */
export interface SkillRouterSettings {
  mode: SkillLoadMode
  /** Conversation lines shown to the router; 0 shows none. */
  historyWindow: number
  timeoutMs: number
  /** Output budget of one router call: strict JSON with a ≤30-character reason fits the default, 200. */
  maxTokens: number
  /** Router route; absent uses the agent's own model. Declared together (`declare` rejects one without the other). */
  provider?: string
  model?: string
}

/** Plugin config (the host row): the process-wide defaults. */
export type Config = Partial<SkillRouterSettings>

const Config: z<Config> = z.object({
  mode: z.union(['off', 'full', 'dynamic'] as const).default('off'),
  historyWindow: z.natural().default(6),
  timeoutMs: z.natural().default(10_000),
  maxTokens: z.natural().min(1).default(200),
  provider: z.string(),
  model: z.string(),
})

const DEFAULT_SETTINGS: SkillRouterSettings = { mode: 'off', historyWindow: 6, timeoutMs: 10_000, maxTokens: 200 }

/** Drop undefined fields so a partial declaration never erases an inherited one; a route is declared whole or not at all. */
function compact(settings: Partial<SkillRouterSettings>): Partial<SkillRouterSettings> {
  if ((settings.provider === undefined) !== (settings.model === undefined)) {
    throw new Error(`lyteboat skill router: provider and model are declared together; got provider=${JSON.stringify(settings.provider)} model=${JSON.stringify(settings.model)}`)
  }
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) as Partial<SkillRouterSettings>
}

class SettingsLayer implements ScopeLayer {
  readonly entries = new AnonymousEntries<Partial<SkillRouterSettings>>()

  isEmpty(): boolean {
    return this.entries.isEmpty()
  }
}

/**
 * The `lyteboat` object of a skill's frontmatter metadata.
 * @param skill - the skill whose metadata to read.
 * @returns the metadata, or undefined when the frontmatter has no `lyteboat` object.
 * @throws when `metadata.lyteboat` fails its schema: a misspelt key must not silently drop the skill's tools.
 */
function lyteboatSkillMeta(skill: Pick<SkillDefinition, 'name' | 'metadata'>): LyteboatSkillMeta | undefined {
  const lyteboat = skill.metadata?.['lyteboat']
  if (lyteboat === undefined) return undefined
  const parsed = lyteboatSkillMetaSchema.safeParse(lyteboat)
  if (!parsed.success) throw new Error(`lyteboat skill router: skill "${skill.name}" has an invalid metadata.lyteboat: ${zod.prettifyError(parsed.error)}`)
  return parsed.data
}

/** The skill a `skill` tool call loads, from the call's JSON arguments. */
function loadedSkillOf(argumentsJson: string): string | undefined {
  let args: unknown
  try {
    args = JSON.parse(argumentsJson)
  } catch {
    // Malformed arguments fail the call's own validation; there is no load to fold.
    return undefined
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const name = (args as Record<string, unknown>)['name']
  return typeof name === 'string' ? name : undefined
}

const activeSkillViewSchema = zod.string().nullable()

export const lyteboatActiveSkillProjectionDefinition = {
  key: 'lyteboatActiveSkill',
  stateSchema: lyteboatActiveSkillStateSchema,
  init: (): LyteboatActiveSkillState => ({ active: null, loading: {} }),
  apply(state: LyteboatActiveSkillState, event) {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (event.surfaceOp !== 'append' || source.kind !== 'skill-invocation') return state
        return source.name === state.active ? state : { ...state, active: source.name }
      }
      case 'tool/call': {
        if (event.data.name !== SKILL_TOOL) return state
        const name = loadedSkillOf(event.data.arguments)
        return name === undefined ? state : { ...state, loading: { ...state.loading, [event.data.callId]: name } }
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const name = state.loading[callId]
        if (event.surfaceOp !== 'append' || name === undefined) return state
        const { [callId]: _settled, ...loading } = state.loading
        return { active: event.data.message.isError === true ? state.active : name, loading }
      }
      default:
        return state
    }
  },
  wire: { viewSchema: activeSkillViewSchema, view: (state: LyteboatActiveSkillState) => state.active },
  stateVersion: 1,
} satisfies ProjectionDefinition<'lyteboatActiveSkill', LyteboatActiveSkillState>

/**
 * Whether a rendered skill body is in the model's view: an invocation message
 * or a `skill` tool result, both of which carry `renderSkillContent` verbatim.
 */
function bodyOnSurface(session: Session, rendered: string): boolean {
  return session.deriveMessages().some(message =>
    (message.role === 'user' || message.role === 'tool')
    && message.content.some(block => block.type === 'text' && block.text.includes(rendered)))
}

/** The skill-invocation message that brings a skill's body into the step; a switch says what it replaces. */
function invocationMessage(name: string, rendered: string, replaced: string | undefined): UserMessage {
  const source: SkillInvocationSource = { kind: 'skill-invocation', name, form: 'instructions' }
  const content: ContentBlock[] = [
    ...replaced === undefined ? [] : [{ type: 'text' as const, text: `Skill "${replaced}" is no longer active; follow the skill below instead.` }],
    { type: 'text', text: rendered },
  ]
  return createUserMessage({ content, source })
}

interface AgentSkillState {
  /** Full mode: the rendered bodies of every skill, keyed by the catalog digest that produced them. */
  full: { digest: string; text: string } | undefined
  /** The skill whose required tools this process applied to the agent. */
  toolsFor: string | undefined
  /** A skill body due in this step's messages: set at pre-assembly, taken at pre-step. */
  injection: UserMessage | undefined
}

function userText(messages: LyteboatStepPayload['messages']): string {
  return messages
    .filter(message => message.source.kind === 'user')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    .filter(text => text !== '')
    .join('\n')
}

/** Host service: skill load modes, LLM routing, and the active skill's presence in the conversation. */
export class SkillRouterService extends Service {
  // lyteboatDistro: routing and activation run in the kernel extension agent-loop-pre-assemble.
  static inject = ['skills', 'auxLlm', 'sessionProjections', 'systemPrompt', 'tools', 'toolPolicy', 'lyteboatDistro']
  // The loader applies a class plugin's static Config, not the module's.
  static Config = Config

  private readonly layers = new ScopedLayers(() => new SettingsLayer(), () => {})
  private readonly agents = new WeakMap<Agent, AgentSkillState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skillRouter')
    this.layers.global.entries.append(compact(config))
    ctx.sessionProjections.register(lyteboatActiveSkillProjectionDefinition)
    ctx.systemPrompt.section({
      name: 'lyteboat:skills',
      order: LYTEBOAT_SKILLS_SECTION_ORDER,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        return this.agents.get(agent)?.full?.text ?? ''
      },
    })
    // Before `next()`: routing and activation happen first, so plugins later
    // in the waterfall can still override, and tool-policy's own listener
    // (registered before this one) reconciles the restriction at the end.
    ctx.on('lyteboat/pre-assemble', async (payload, next) => {
      await this.prepare(payload)
      return next()
    })
    // After `next()`, so a rejection still wins and the body follows the step's own messages.
    ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
      const decision = await next()
      const state = this.agents.get(payload.agent)
      const injection = state?.injection
      if (state === undefined || injection === undefined) return decision
      state.injection = undefined
      return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, injection] }
    })
  }

  /**
   * Declare settings in the calling scope's layer; nearer scopes override
   * farther ones, and absent fields keep what they inherit. `provider` and
   * `model` come together or not at all.
   * @param settings - the fields to override.
   * @returns the exact disposer that withdraws the declaration.
   * @throws when only one of `provider` and `model` is given.
   */
  declare(settings: Partial<SkillRouterSettings>): () => void {
    const compacted = compact(settings)
    return this.layers.effect(
      this.ctx,
      layer => layer.entries.append(compacted),
      { label: 'skillRouter.declare()', notify: false },
    )
  }

  /**
   * The settings a scope runs under: defaults, then every layer on its chain,
   * nearest last. An agent is its own scope key (the agent loop keys each
   * agent's scope by the agent), so an agent and a preset's standing scope resolve alike.
   * @param scope - the agent, or a preset's standing scope; omitted for the process defaults.
   */
  settingsFor(scope: ScopeKey | undefined): SkillRouterSettings {
    let settings: SkillRouterSettings = { ...DEFAULT_SETTINGS }
    for (const layer of [this.layers.global, ...this.layers.chainLayers(scope)]) {
      for (const entry of layer.entries.values()) settings = { ...settings, ...entry }
    }
    return settings
  }

  /** The skill active for one agent, as the log records it. */
  activeOf(agent: Agent): string | null {
    return this.ctx.sessionProjections.stateOf(agent.session, 'lyteboatActiveSkill')?.active ?? null
  }

  private stateOf(agent: Agent): AgentSkillState {
    let state = this.agents.get(agent)
    if (state === undefined) {
      state = { full: undefined, toolsFor: undefined, injection: undefined }
      this.agents.set(agent, state)
    }
    return state
  }

  private async prepare(payload: LyteboatStepPayload): Promise<void> {
    const { agent, messages, signal } = payload
    const settings = this.settingsFor(agent)
    if (settings.mode === 'off') return
    // A step aborted between pre-assembly and pre-step leaves its body behind; it is not this step's.
    this.stateOf(agent).injection = undefined
    signal.throwIfAborted()
    const lookup: SkillViewOptions = { cwd: agent.session.header.cwd, signal, scope: agent }
    if (settings.mode === 'full') {
      await this.prepareFull(agent, lookup)
      return
    }
    const previous = this.activeOf(agent)
    const input = userText(messages)
    const chosen = input === '' ? previous : await this.route(agent, settings, lookup, input, signal)
    await this.applyActive(agent, chosen, previous, lookup)
  }

  /** Full mode: every model-invocable skill's body in one section, every required tool activated. */
  private async prepareFull(agent: Agent, lookup: SkillViewOptions): Promise<void> {
    const snapshot = await this.ctx.skills.snapshot(lookup)
    lookup.signal?.throwIfAborted()
    const names = snapshot.skills.filter(isModelInvocable).map(skill => skill.name)
    const digest = names.join('\n')
    const state = this.stateOf(agent)
    if (state.full?.digest === digest) return
    const definitions: SkillDefinition[] = []
    for (const name of names) {
      const definition = await this.ctx.skills.get(name, lookup)
      lookup.signal?.throwIfAborted()
      if (definition !== undefined) definitions.push(definition)
    }
    const text = definitions.length === 0
      ? ''
      : ['The following skills apply to this session. Follow their instructions.', ...definitions.map(renderSkillContent)].join('\n\n')
    // Before the digest is recorded, so a skill that fails to activate fails every step, not only the first.
    this.activateTools(agent, definitions)
    state.full = { digest, text }
  }

  /** Dynamic mode: one router call per user input; sticky on everything but a valid new id. */
  private async route(
    agent: Agent,
    settings: SkillRouterSettings,
    lookup: SkillViewOptions,
    userInput: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const current = this.activeOf(agent)
    const snapshot = await this.ctx.skills.snapshot(lookup)
    signal.throwIfAborted()
    const candidates: RouteCandidate[] = snapshot.skills.filter(isModelInvocable)
      .map(skill => ({ name: skill.name, description: skill.description }))
    if (candidates.length === 0) return current
    const prompt = buildRoutePrompt({
      candidates,
      history: renderHistory(agent.session.deriveMessages(), settings.historyWindow),
      current,
      userInput,
    })
    const route: AuxLlmRoute | undefined = settings.provider !== undefined && settings.model !== undefined
      ? { provider: settings.provider, model: settings.model }
      : undefined
    const decision = await this.decide(agent, route, prompt, candidates.map(candidate => candidate.name), current, settings, signal)
    return decision.skill
  }

  /** One router call through `ctx.auxLlm`; every failure keeps the current skill. */
  private async decide(
    agent: Agent,
    route: AuxLlmRoute | undefined,
    prompt: string,
    candidates: readonly string[],
    current: string | null,
    settings: SkillRouterSettings,
    signal: AbortSignal,
  ): Promise<RouteDecision> {
    const outcome = await this.ctx.auxLlm.generate({
      agent,
      purpose: SKILL_ROUTER_PURPOSE,
      ...route === undefined ? {} : { route },
      system: SKILL_ROUTER_SYSTEM_PROMPT,
      prompt,
      maxTokens: settings.maxTokens,
      temperature: 0,
      timeoutMs: settings.timeoutMs,
      signal,
    })
    if (outcome.kind === 'answer') return resolveRouteDecision(outcome.text, candidates, current)
    this.ctx.logger.warn(`lyteboat skill router: router call failed (${outcome.reason}): ${outcome.message}`)
    return { skill: current, reason: outcome.reason }
  }

  /**
   * Put one skill in force for this step: its required tools replace the
   * previous set, and its body is injected unless it is already on the
   * surface. A switch always injects, so the newest body in view is the
   * active skill's; a body compaction shadowed comes back.
   */
  private async applyActive(agent: Agent, name: string | null, previous: string | null, lookup: SkillViewOptions): Promise<void> {
    if (name === null) return
    const definition = await this.ctx.skills.get(name, lookup)
    lookup.signal?.throwIfAborted()
    if (definition === undefined) {
      this.ctx.logger.warn(`lyteboat skill router: skill "${name}" is not available to this agent; activation skipped`)
      return
    }
    const state = this.stateOf(agent)
    if (state.toolsFor !== name) {
      this.activateTools(agent, [definition])
      state.toolsFor = name
    }
    const rendered = renderSkillContent(definition)
    const switched = name !== previous
    if (switched || !bodyOnSurface(agent.session, rendered)) {
      state.injection = invocationMessage(name, rendered, switched && previous !== null ? previous : undefined)
    }
  }

  /**
   * The reference rule: visible = always + the active skills' required tools, so earlier activations are replaced.
   * @throws when a skill's metadata is malformed or requires a tool the tool policy does not declare for the agent;
   * the activation is left as it was.
   */
  private activateTools(agent: Agent, skills: readonly SkillDefinition[]): void {
    const policy = this.ctx.toolPolicy
    const required = skills.flatMap(skill => {
      const tools = lyteboatSkillMeta(skill)?.requiredTools ?? []
      const unknown = tools.filter(name => policy.metaOf(name, agent) === undefined)
      if (unknown.length > 0) {
        throw new Error(`lyteboat skill router: skill "${skill.name}" requires tool${unknown.length > 1 ? 's' : ''} ${unknown.map(name => JSON.stringify(name)).join(', ')}, which the tool policy does not declare for agent "${agent.id}"`)
      }
      return tools
    })
    policy.clear(agent)
    if (required.length > 0) policy.activate(agent, required)
  }
}

export default SkillRouterService
