/**
 * @lyteboat/a2ui — A2UI cards for lyteboat agents. One host service, `ctx.a2ui`,
 * owns the template engine (the reference template mode, ported), the `render_a2ui`
 * tool a composition registers over a templates root, the `lyteboatCards`
 * projection that collects every prepared card from `tool/result.meta`, and
 * `liveTurn`, which lays one turn out as a client shows it from that turn's
 * events (`turnOutcome.follow`) and its streamed text.
 *
 * The tool reads its raw data from the session's `lyteboatState` projection (the
 * configured state keys, as the reference `state_keys`), renders the chosen card, and
 * returns the digest as the model-facing text; the cards ride the result's
 * presentation meta (`meta.lyteboat.cards`), never the model transcript. A card's
 * manifest names when it is shown (`emission_mode`): at once, or where the answer
 * writes `[[card:<area>]]`. An agent's own tool composes cards the same way:
 * `renderCard` for each card, `cardsPresentationMeta` for its result's meta, and
 * `cardMarker` for the marker its digest asks the answer to write.
 * @module @lyteboat/a2ui
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { lyteboatResultCardSchema } from '@lyteboat/contracts'
import type { LyteboatCard, LyteboatResultCard } from '@lyteboat/contracts'
import type {} from '@lyteboat/tool-policy'
import { cardsPresentationMeta, lyteboatCardsProjectionDefinition } from './cards-projection.ts'
import { TemplateEngine } from './engine.ts'
import type { TemplateRenderOptions, TemplateRenderResult } from './engine.ts'
import { DEFAULT_A2UI_COMPONENT_CATALOG, validateFullPayload } from './contract.ts'
import type { A2uiComponentCatalog } from './contract.ts'
import { collectRawData, parseObjectArgs } from './render-tool-input.ts'
import type { A2uiLog, RawData } from './transforms.ts'
import { LyteboatLiveTurn } from './live-turn.ts'

export { cardsPresentationMeta } from './cards-projection.ts'
export type { TemplateRenderOptions, TemplateRenderResult } from './engine.ts'
export type { A2uiLog, RawData } from './transforms.ts'
export { validateFullPayload } from './contract.ts'
export type { A2uiComponentCatalog, GuardResult } from './contract.ts'
export { LyteboatTurnComposer, cardMarker } from './turn-parts.ts'
export { LyteboatLiveTurn } from './live-turn.ts'
export type { LyteboatTurnPart } from './turn-parts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    a2ui: A2uiService
  }
}

/** How a `render_a2ui` tool is composed over one templates root. */
export interface RenderToolOptions {
  /** Absolute path of the templates root (one card per directory). */
  templates: string
  /** `lyteboatState` keys collected into the raw namespace: `raw[key] = state[key]` and the key's fields flattened beside it. */
  stateKeys?: string[]
  /** Cards whose successful render concludes the agent's turn (the reference terminal cards). */
  terminalCards?: string[]
  /** Card → one model-facing line for the tool description. */
  cardDescriptions?: Record<string, string>
  /** The tool name; defaults to `render_a2ui`. */
  name?: string
  /** lyteboat tool visibility; defaults to `always`. */
  visibility?: 'always' | 'auto'
  /** Contract violations: `warn` keeps the card and records them (the reference default); `enforce` fails the call. */
  validation?: 'warn' | 'enforce'
  /** The client's component catalog the contract is checked against; the domain-neutral default when absent. */
  components?: A2uiComponentCatalog
}

/**
 * A rendered card as the contract carries it. Parsing is where the payload,
 * built from template files and business data, becomes JSON.
 * @throws naming the card when a raw value JSON cannot carry (NaN, a function, a date) reached its payload.
 */
function resultCardOf(area: string, rendered: TemplateRenderResult): LyteboatResultCard {
  const card = lyteboatResultCardSchema.safeParse({ surfaceId: String(rendered.payload['surfaceId'] ?? ''), area, emission: rendered.emission, payload: rendered.payload })
  if (!card.success) throw new Error(`a2ui: card "${area}" did not render to lossless JSON: its raw data bound a value JSON cannot carry`, { cause: card.error })
  return card.data
}

interface RenderToolCatalog {
  cards: string[]
  variants: string[]
  argSpecs: Map<string, Record<string, Record<string, unknown>>>
}

/** Host service: the template engine, the render tool composer and the cards projection. */
export class A2uiService extends Service {
  static inject = ['tools', 'toolPolicy', 'sessionProjections']

  private readonly engines = new Map<string, TemplateEngine>()
  private cardsHandle!: ProjectionHandle<LyteboatCard[]>

  constructor(ctx: Context) {
    super(ctx, 'a2ui')
  }

  async [Service.init](): Promise<void> {
    this.cardsHandle = await this.ctx.sessionProjections.register(lyteboatCardsProjectionDefinition)
  }

  /** The log the engines degrade into. */
  private get log(): A2uiLog {
    return { warn: message => { this.ctx.logger.warn(`a2ui: ${message}`) } }
  }

  /** The engine for one templates root (shared per root). */
  private engine(templates: string): TemplateEngine {
    let engine = this.engines.get(templates)
    if (engine === undefined) {
      engine = new TemplateEngine(templates, this.log)
      this.engines.set(templates, engine)
    }
    return engine
  }

  /**
   * Render one card outside the tool: the engine's whole result, digest and
   * warnings included. {@link renderCard} gives the card a result carries.
   */
  render(templates: string, card: string, raw: RawData, options: TemplateRenderOptions = {}): Promise<TemplateRenderResult> {
    return this.engine(templates).render(card, raw, options)
  }

  /**
   * Render one card for an agent, as a tool result carries it beside the
   * tool's own value ({@link cardsPresentationMeta}) or an admission reply
   * does. The engine's degradations go to the log.
   * @param templates - absolute path of the templates root.
   * @param area - the card; its marker ({@link cardMarker}) places it by this name.
   * @param raw - the card's raw data namespace.
   * @param options - `agent`: the agent the card is for, whose session names the surface.
   * @throws when the card is unknown or malformed, or its payload is not lossless JSON.
   */
  async renderCard(templates: string, area: string, raw: RawData, options: { agent: Agent }): Promise<LyteboatResultCard> {
    const rendered = await this.engine(templates).render(area, raw, { sessionId: options.agent.session.id })
    for (const warning of rendered.warnings) this.log.warn(warning)
    return resultCardOf(area, rendered)
  }

  /** The cards one agent's session has prepared, in log order. */
  cardsOf(agent: Agent): LyteboatCard[] {
    return this.cardsHandle.stateOf(agent.session)
  }

  /**
   * One turn as a client shows it: its answer text, step by step, with the
   * cards its results (and an admission reply) prepared, placed by their
   * markers and emission modes. Feed it the turn's events (`turnOutcome.follow`)
   * and, for a caller that streams, the assistant's streamed text; each call
   * returns the parts it adds, and `parts()` gives the whole turn.
   */
  liveTurn(): LyteboatLiveTurn {
    return new LyteboatLiveTurn()
  }

  /**
   * Register a `render_a2ui` tool over a templates root in the calling
   * scope's layer (through the tool policy, which declares its visibility; the
   * card rides the result's meta). Loads every card first so the parameter
   * enums are complete.
   * @returns the exact disposer that unregisters the tool.
   */
  async registerRenderTool(options: RenderToolOptions): Promise<() => void> {
    const engine = this.engine(options.templates)
    const catalog = await this.catalogOf(engine)
    if (catalog.cards.length === 0) throw new Error(`a2ui: no card under templates root ${options.templates}`)
    const stateKeys = options.stateKeys ?? []
    const terminal = new Set(options.terminalCards ?? [])
    const validation = options.validation ?? 'warn'
    const components = options.components ?? DEFAULT_A2UI_COMPONENT_CATALOG
    const log = this.log
    const toolPolicy = this.ctx.toolPolicy
    const tool = defineTool({
      name: options.name ?? 'render_a2ui',
      description: describeTool(catalog, options.cardDescriptions ?? {}),
      parameters: {
        template: { type: 'string', required: true, enum: catalog.cards, description: '设计模板卡片类型，server 端解析为前端即用 JSON。' },
        ...catalog.variants.length > 0
          ? { business_hierarchy: { type: 'string', enum: catalog.variants, description: '可选。仅多形态卡片需要：按业务意图选择该卡的内容组合变体；缺省用默认变体。' } }
          : {},
        ...catalog.argSpecs.size > 0
          ? { template_args: { type: 'json', description: `模型抽取的少量入参（落到 args.* 命名空间；大盘工具状态自动注入，无需重复）。按所选 template 填对应字段：\n${argSummary(catalog)}` } }
          : {},
        surface_id: { type: 'string', description: '已有画布 ID。有则原地更新已有画布（surfaceUpdate），无则创建新画布（beginRendering）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            template: { type: 'string', required: true },
            event: { type: 'string', required: true },
            emission: { type: 'string', required: true },
            surfaceId: { type: 'string', required: true },
            digest: { type: 'string', required: true },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
            card: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.digest !== '' ? value.digest : `[卡片:${value.template}] 已渲染` }],
        presentationMeta: (_args, value) => ({
          ...cardsPresentationMeta([{ surfaceId: value.surfaceId, area: value.template, emission: value.emission, payload: value.card }]),
          a2ui: { template: value.template, event: value.event, warnings: value.warnings },
        }),
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error('render_a2ui needs a calling agent: the card data and the rendered cards live on its session')
        const card = args.template
        if (!catalog.cards.includes(card)) throw new Error(`不支持的 template 卡片: ${card}。可选: ${catalog.cards.join(', ')}`)
        const templateArgs = parseObjectArgs(args.template_args)
        const missing = Object.entries(catalog.argSpecs.get(card) ?? {})
          .filter(([name, spec]) => spec['required'] === true && !templateArgs?.[name])
          .map(([name]) => name)
        if (missing.length > 0) log.warn(`template '${card}' 缺少必填 template_args [${missing.map(name => `'${name}'`).join(', ')}]（模型未抽取，卡片可能降级）`)
        const raw = collectRawData(toolPolicy.sessionState(agent.session), stateKeys)
        if (templateArgs !== undefined) raw['args'] = templateArgs
        const result = await engine.render(card, raw, {
          hierarchy: typeof args.business_hierarchy === 'string' && args.business_hierarchy.trim() !== '' ? args.business_hierarchy.trim() : undefined,
          sessionId: agent.session.id,
          surfaceId: typeof args.surface_id === 'string' ? args.surface_id : undefined,
        })
        for (const warning of result.warnings) log.warn(warning)
        const guard = validateFullPayload(result.payload, { strict: validation === 'enforce', log, catalog: components })
        if (validation === 'enforce' && guard.errors.length > 0) throw new Error(`A2UI contract invalid: ${guard.errors[0] ?? ''}`)
        for (const message of [...guard.errors, ...guard.warnings]) log.warn(message)
        const rendered = resultCardOf(card, result)
        if (terminal.has(card)) exec.concludeTurn()
        return {
          template: card,
          event: String(result.payload['event'] ?? 'beginRendering'),
          emission: rendered.emission,
          surfaceId: rendered.surfaceId,
          digest: result.digest,
          warnings: [...result.warnings, ...guard.errors, ...guard.warnings],
          card: rendered.payload,
        }
      },
    })
    return this.ctx.toolPolicy.register(tool, { visibility: options.visibility ?? 'always' })
  }

  private async catalogOf(engine: TemplateEngine): Promise<RenderToolCatalog> {
    const cards = engine.cards()
    const variants = new Set<string>()
    const argSpecs = new Map<string, Record<string, Record<string, unknown>>>()
    for (const card of cards) {
      const hierarchies = await engine.hierarchies(card)
      if (hierarchies.length > 1) for (const name of hierarchies) variants.add(name)
      const specs = await engine.argSpecs(card)
      if (Object.keys(specs).length > 0) argSpecs.set(card, specs)
    }
    return { cards, variants: [...variants].sort(), argSpecs }
  }
}

function describeTool(catalog: RenderToolCatalog, descriptions: Record<string, string>): string {
  const lines = catalog.cards.filter(card => descriptions[card] !== undefined).map(card => `- ${card}: ${descriptions[card] ?? ''}`)
  return `生成A2UI卡片内容,供UI渲染。template 模式（设计模板 server 端解析）。${lines.length > 0 ? `\n卡片说明：\n${lines.join('\n')}` : ''}`
}

function argSummary(catalog: RenderToolCatalog): string {
  return [...catalog.argSpecs].map(([card, specs]) => `- ${card}: ${Object.entries(specs).map(([name, spec]) => `${name}${spec['required'] === true ? '(必填)' : '(可选)'}`).join(', ')}`).join('\n')
}

export default A2uiService
