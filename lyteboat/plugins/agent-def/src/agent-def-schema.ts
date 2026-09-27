/**
 * The runtime check of a business agent's declaration and of what its hooks
 * return. TypeScript checks a `.ts` agent at compile time; this check covers a
 * JavaScript agent and the values types cannot constrain, and it rejects every
 * key the declaration's own shapes do not have, so a misspelt field fails
 * instead of declaring nothing. Each shape is held to its owner's type by
 * `satisfies`, so an option an owner adds or removes fails this package's
 * build rather than an agent's mount. The persona is dsh-persona's
 * configuration, which that plugin validates when it mounts.
 * @module @lyteboat/agent-def/agent-def-schema
 */

import { z } from 'zod'
import type { A2uiComponentCatalog } from '@lyteboat/a2ui'
import { lyteboatAgentDefIdentitySchema } from '@lyteboat/contracts'
import type { SkillRouterSettings } from '@lyteboat/skill-router'
import type { LyteboatToolPolicy } from '@lyteboat/tool-policy'
import type {
  LyteboatAgentA2uiRenderTool,
  LyteboatAgentDef,
  LyteboatAgentEventListeners,
  LyteboatAgentEventName,
  LyteboatAgentModelRequest,
  LyteboatAgentTool,
  LyteboatAgentToolPolicy,
} from './index.ts'

type LyteboatAgentShape<Owner> = Record<keyof Owner, z.ZodType>

// A boundary check, not a capability probe: a JavaScript agent can put anything in a hook's place.
const functionSchema = (expected: string) => z.custom<unknown>(value => typeof value === 'function', `must be a function ${expected}`)
const personaSchema = z.custom<unknown>()

const toolVisibilitySchema = z.enum(['always', 'auto'])

const toolPolicySchema = z.strictObject({
  inherited: z.enum(['visible', 'hidden']).exactOptional(),
  tools: z.record(z.string(), z.strictObject({
    visibility: toolVisibilitySchema.exactOptional(),
  } satisfies LyteboatAgentShape<LyteboatToolPolicy>)).exactOptional(),
} satisfies LyteboatAgentShape<LyteboatAgentToolPolicy>)

const skillRoutingSchema = z.strictObject({
  mode: z.enum(['off', 'full', 'dynamic']).exactOptional(),
  historyWindow: z.int().nonnegative().exactOptional(),
  timeoutMs: z.int().nonnegative().exactOptional(),
  maxTokens: z.int().positive().exactOptional(),
  provider: z.string().min(1).exactOptional(),
  model: z.string().min(1).exactOptional(),
} satisfies LyteboatAgentShape<SkillRouterSettings>)

const modelRequestSchema = z.strictObject({
  temperature: z.number().finite().exactOptional(),
  maxTokens: z.int().positive().exactOptional(),
  stop: z.array(z.string()).exactOptional(),
} satisfies LyteboatAgentShape<LyteboatAgentModelRequest>)

const a2uiRenderToolSchema = z.strictObject({
  templatesDir: z.string().min(1),
  stateKeys: z.array(z.string()).exactOptional(),
  terminalCards: z.array(z.string()).exactOptional(),
  cardDescriptions: z.record(z.string(), z.string()).exactOptional(),
  name: z.string().min(1).exactOptional(),
  visibility: toolVisibilitySchema.exactOptional(),
  validation: z.enum(['warn', 'enforce']).exactOptional(),
  components: z.strictObject({
    types: z.array(z.string()),
    bindingFields: z.record(z.string(), z.array(z.string())),
  } satisfies LyteboatAgentShape<A2uiComponentCatalog>).exactOptional(),
} satisfies LyteboatAgentShape<LyteboatAgentA2uiRenderTool>)

const lyteboatAgentDefSchema = z.strictObject({
  ...lyteboatAgentDefIdentitySchema.shape,
  persona: personaSchema.exactOptional(),
  skillDirs: z.array(z.string().min(1)).exactOptional(),
  skillRouting: skillRoutingSchema.exactOptional(),
  toolPolicy: toolPolicySchema.exactOptional(),
  modelRequest: modelRequestSchema.exactOptional(),
  tools: functionSchema('(host) => tools').exactOptional(),
  admission: functionSchema('(host) => admission').exactOptional(),
  a2uiRenderTool: a2uiRenderToolSchema.exactOptional(),
  eventListeners: functionSchema('(host) => listeners').exactOptional(),
} satisfies LyteboatAgentShape<LyteboatAgentDef>)

const lyteboatAgentToolsSchema = z.array(z.strictObject({
  definition: z.custom<unknown>(value => typeof value === 'object' && value !== null, 'must be a tool definition (defineTool from @deepseek-ai/dsh-tools)'),
  visibility: toolVisibilitySchema.exactOptional(),
  stateDelta: functionSchema('(args, value) => delta').exactOptional(),
} satisfies LyteboatAgentShape<LyteboatAgentTool>))

/**
 * The events dsh delivers per agent, at run time. `satisfies` holds it equal
 * to {@link LyteboatAgentEventName}: an event the type gains or loses fails
 * the build here.
 */
const LYTEBOAT_AGENT_EVENTS = {
  'system-prompt/assemble': true,
  'session/created': true,
  'session/disposed': true,
  'session/event': true,
  'session/flush': true,
  'agent/created': true,
  'agent/disposed': true,
  'agent/status': true,
  'agent/inbox/inserted': true,
  'agent/inbox/claimed': true,
  'agent/inbox/discarded': true,
  'agent/pre-step': true,
  'agent/request': true,
  'agent/request-error': true,
  'agent/assistant-stream': true,
  'agent/turn-stopping': true,
  'agent/error': true,
  'lyteboat/intake': true,
  'lyteboat/pre-assemble': true,
  'approval/request': true,
  'tools/pre-execute': true,
  'tools/execute': true,
  'tools/post-execute': true,
  'tools/ptc-dispatch-log': true,
  'tools/result': true,
} satisfies Record<LyteboatAgentEventName, true>

const lyteboatAgentEventListenersSchema = z.strictObject(
  Object.fromEntries(Object.keys(LYTEBOAT_AGENT_EVENTS).map(eventName => [eventName, functionSchema('(…args) => …').exactOptional()])),
)

function pathOf(path: readonly PropertyKey[]): string {
  return path.map(segment => typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`).join('').replace(/^\./u, '')
}

function problemsOf(schema: z.ZodType, value: unknown, unknownKeyNoun: string): string[] {
  const result = schema.safeParse(value)
  if (result.success) return []
  return result.error.issues.map((issue) => {
    const at = issue.path.length === 0 ? '' : `${pathOf(issue.path)}: `
    if (issue.code === 'unrecognized_keys') return `${at}unknown ${unknownKeyNoun}${issue.keys.length > 1 ? 's' : ''} ${issue.keys.map(key => JSON.stringify(key)).join(', ')}`
    return `${at}${issue.message}`
  })
}

/**
 * Check a declaration's shape and values.
 * @param agentDef - the declaration as written.
 * @throws naming every problem, each with its path.
 */
export function checkLyteboatAgentDef(agentDef: unknown): void {
  const problems = problemsOf(lyteboatAgentDefSchema, agentDef, 'key')
  if (problems.length > 0) throw new Error(`lyteboat agent def: ${problems.join('; ')}`)
}

/**
 * Check what the `tools` hook returned.
 * @param agentTools - the hook's return value.
 * @returns the tools, each a definition with its lyteboat metadata.
 * @throws naming every problem with the tool's index, such as `[0]: unknown key "visiblity"`.
 */
export function checkedLyteboatAgentTools(agentTools: unknown): readonly LyteboatAgentTool[] {
  const problems = problemsOf(lyteboatAgentToolsSchema, agentTools, 'key')
  if (problems.length > 0) throw new Error(problems.join('; '))
  // Checked above; the value itself is kept, since a parsed copy would be a different object than the agent returned.
  return agentTools as readonly LyteboatAgentTool[]
}

/**
 * Check what the `eventListeners` hook returned.
 * @param eventListeners - the hook's return value.
 * @returns the listeners by event name.
 * @throws naming an event dsh does not deliver per agent, with the ones it does, or a listener that is not a function.
 */
export function checkedLyteboatAgentEventListeners(eventListeners: unknown): LyteboatAgentEventListeners {
  const problems = problemsOf(lyteboatAgentEventListenersSchema, eventListeners, 'event')
  if (problems.length > 0) throw new Error(`${problems.join('; ')} (an agent listens to ${Object.keys(LYTEBOAT_AGENT_EVENTS).join(', ')})`)
  // Checked above; see checkedLyteboatAgentTools.
  return eventListeners as LyteboatAgentEventListeners
}
