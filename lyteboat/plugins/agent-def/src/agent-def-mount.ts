/**
 * Mounting a business agent's declaration in its standing scope: the
 * definition is checked, then each field goes to the host service that owns
 * it, in the order the agent's rows ran before they were one declaration, so
 * the model sees the same tools and prompt in the same order. A step that
 * fails names its field.
 * @module @lyteboat/agent-def/agent-def-mount
 */

import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Events } from '@deepseek-ai/cordis'
import * as dshPersona from '@deepseek-ai/dsh-persona'
import * as dshSkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@lyteboat/a2ui'
import type {} from '@lyteboat/aux-llm'
import type {} from '@lyteboat/intake-guard'
import type {} from '@lyteboat/request-context'
import type {} from '@lyteboat/skill-router'
import type {} from '@lyteboat/tool-policy'
import { checkedLyteboatAgentEventListeners, checkedLyteboatAgentTools, checkLyteboatAgentDef } from './agent-def-schema.ts'
import type { LyteboatAgentDef, LyteboatAgentEventListeners, LyteboatAgentEventName, LyteboatAgentHost, LyteboatAgentModelRequest } from './index.ts'

/** Where an agent keeps its skills when its definition names no directory. */
const DEFAULT_SKILL_DIR = 'assets/skills'

/**
 * The agent directory the row was declared from: the agent catalog declares
 * each agent with its directory as the base URL its rows resolve against.
 */
function agentDirOf(ctx: Context): string {
  const { baseUrl } = ctx
  if (baseUrl === undefined || !baseUrl.startsWith('file:')) {
    throw new Error('lyteboat agent def: the row has no agent directory; mount it from an agent directory (the agent catalog does), or give its context the directory as baseUrl')
  }
  return fileURLToPath(new URL('.', baseUrl))
}

/** The skill directories to mount: the listed ones, each of which must exist, or the default one when it exists. */
function skillDirsOf(agentDef: LyteboatAgentDef, agentPath: (relativePath: string) => string): string[] {
  if (agentDef.skillDirs === undefined) {
    const defaultDir = agentPath(DEFAULT_SKILL_DIR)
    return existsSync(defaultDir) ? [defaultDir] : []
  }
  return agentDef.skillDirs.map((relativePath) => {
    const skillDir = agentPath(relativePath)
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) throw new Error(`skill directory not found: ${skillDir}`)
    return skillDir
  })
}

/** The fields a model request override lays over the loop's call config. */
function callConfigOverrideOf(modelRequest: LyteboatAgentModelRequest): Partial<LlmCallConfig> {
  const { temperature, maxTokens, stop } = modelRequest
  return {
    ...temperature === undefined ? {} : { temperature },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...stop === undefined ? {} : { stop: [...stop] },
  }
}

/** Register one listener; generic so an event name and its listener stay paired. */
function listenTo<EventName extends LyteboatAgentEventName>(ctx: Context, eventName: EventName, listener: Events[EventName]): void {
  ctx.on(eventName, listener)
}

function registerEventListeners(ctx: Context, eventListeners: LyteboatAgentEventListeners): void {
  for (const eventName of Object.keys(eventListeners) as LyteboatAgentEventName[]) {
    const listener = eventListeners[eventName]
    if (listener !== undefined) listenTo(ctx, eventName, listener)
  }
}

/**
 * Mount a declaration in the calling row's context, the agent's standing scope.
 * @param ctx - the row's context; its base URL is the agent directory.
 * @param agentDef - the declaration as the agent wrote it.
 * @throws when the definition is malformed, `agentId` is not the directory's name, or a step fails; the message names the field.
 */
export async function mountLyteboatAgent(ctx: Context, agentDef: LyteboatAgentDef): Promise<void> {
  checkLyteboatAgentDef(agentDef)
  const agentDir = agentDirOf(ctx)
  const directoryName = basename(agentDir)
  if (agentDef.agentId !== directoryName) {
    throw new Error(`lyteboat agent def: agentId "${agentDef.agentId}" is declared in the agent directory "${directoryName}"; they must be the same`)
  }
  const step = async (fieldName: string, mount: () => unknown): Promise<void> => {
    try {
      await mount()
    } catch (error: unknown) {
      throw new Error(`lyteboat agent def ${agentDef.agentId}: ${fieldName}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const agentPath = (relativePath: string): string => resolve(agentDir, relativePath)
  const { persona, skillRouting, toolPolicy, modelRequest, admission, tools, a2uiRenderTool, eventListeners } = agentDef
  if (persona !== undefined) await step('persona', () => ctx.plugin(dshPersona, persona))
  if (skillRouting !== undefined) await step('skillRouting', () => ctx.skillRouter.declare(skillRouting))
  if (toolPolicy !== undefined) {
    await step('toolPolicy', () => {
      if (toolPolicy.inherited !== undefined) ctx.toolPolicy.declareInherited(toolPolicy.inherited)
      for (const [toolName, policy] of Object.entries(toolPolicy.tools ?? {})) ctx.toolPolicy.declare(toolName, policy)
    })
  }
  await step('skillDirs', async () => {
    const skillDirs = skillDirsOf(agentDef, agentPath)
    if (skillDirs.length > 0) await ctx.plugin(dshSkillFilesystem, { providerName: agentDef.agentId, includeDefaultRoots: false, customSkillDirs: skillDirs, watch: false })
  })
  if (modelRequest !== undefined) {
    const override = callConfigOverrideOf(modelRequest)
    ctx.on('agent/request', async (_payload, next) => ({ ...await next(), ...override }))
  }
  // Built on first use: the three services are injected only when the definition has a hook. The host
  // holds bound methods, not the services, so a hook reaches nothing beyond what its type names.
  let host: LyteboatAgentHost | undefined
  const hostOfAgent = (): LyteboatAgentHost => host ??= {
    agentPath,
    a2ui: { renderCard: (...cardArgs) => ctx.a2ui.renderCard(...cardArgs) },
    auxLlm: { generate: (...callArgs) => ctx.auxLlm.generate(...callArgs) },
    requestContext: { contextOf: (...contextArgs) => ctx.requestContext.contextOf(...contextArgs) },
  }
  if (admission !== undefined) await step('admission', () => ctx.intakeGuard.register(admission(hostOfAgent())))
  if (tools !== undefined) {
    await step('tools', () => {
      for (const { definition, ...toolMeta } of checkedLyteboatAgentTools(tools(hostOfAgent()))) ctx.toolPolicy.register(definition, toolMeta)
    })
  }
  if (a2uiRenderTool !== undefined) {
    const { templatesDir, ...renderToolOptions } = a2uiRenderTool
    await step('a2uiRenderTool', () => ctx.a2ui.registerRenderTool({ ...renderToolOptions, templates: agentPath(templatesDir) }))
  }
  if (eventListeners !== undefined) await step('eventListeners', () => registerEventListeners(ctx, checkedLyteboatAgentEventListeners(eventListeners(hostOfAgent()))))
}
