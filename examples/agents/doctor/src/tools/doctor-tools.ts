/**
 * The fourteen doctor tools, one per manifest entry, all `always` visible (the
 * agent has no skills). Every tool does the same thing: it sends its call to
 * the doctor service with the acting doctor, the page, the doctor's words this
 * turn, and the rule an earlier search accepted; it gives the model the
 * service's digest and nothing else; it renders each UI event as an immediate
 * card (an intent as `doctor_ui_intent`, a jump card as `doctor_jump_card`);
 * and it keeps only the accepted rule of the service's state delta. Tools of
 * risk class C (`prepare_verdict`, `propose_experience`, `draft_feedback`)
 * write nothing here either: their intent opens a prefilled modal, and the
 * doctor submits it through the workbench.
 * @module @lyteboat/agent-doctor/tools/doctor-tools
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { cardsPresentationMeta } from '@lyteboat/a2ui'
import type { LyteboatAgentHost, LyteboatAgentTool } from '@lyteboat/agent-definition'
import type { JsonValue, LyteboatResultCard } from '@lyteboat/contracts'
import { DOCTOR_ACCEPTED_RULE_KEY, acceptedRuleOf, doctorActorOf, doctorPageOf, latestDoctorUtterance } from '../session/doctor-turn-facts.ts'
import { callDoctorClinical, type DoctorClinicalSettings, type DoctorUiEvent } from './doctor-clinical-client.ts'
import type { DoctorToolManifestEntry } from './doctor-tool-manifest.ts'

/** The UI event that is a jump card; every other `doctor.ui.*` event is an intent. */
const DOCTOR_JUMP_CARD_EVENT = 'doctor.ui.card'

/** Everything a doctor tool reads from outside itself. */
interface DoctorToolDeps {
  manifest: readonly DoctorToolManifestEntry[]
  /** Resolved at the first call, so the agent mounts (and `lyteboat inspect` reads it) without the doctor service. */
  settings: () => DoctorClinicalSettings
  /** Absolute path of the agent's a2ui templates root. */
  templates: string
  a2ui: LyteboatAgentHost['a2ui']
  requestContext: LyteboatAgentHost['requestContext']
  toolPolicy: LyteboatAgentHost['toolPolicy']
}

/** The value every doctor tool returns. */
type DoctorToolValue = { digest: string; cards: LyteboatResultCard[]; acceptedRule?: string }

const DOCTOR_TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      digest: { type: 'string', required: true },
      cards: { type: 'array', required: true, items: { type: 'json' } },
      acceptedRule: { type: 'string' },
    },
  },
  render: (_args: unknown, value: { digest: string }) => [{ type: 'text' as const, text: value.digest }],
  presentationMeta: (_args: unknown, value: { cards: JsonValue[] }): JsonValue => cardsPresentationMeta(value.cards),
} as const

function callingAgent(exec: ToolRunContext, tool: string): Agent {
  if (exec.agent === undefined) throw new Error(`doctor: ${tool} needs a calling agent: its request context names the doctor`)
  return exec.agent
}

async function cardOf(deps: DoctorToolDeps, event: DoctorUiEvent, agent: Agent): Promise<LyteboatResultCard> {
  if (event.type === DOCTOR_JUMP_CARD_EVENT) return deps.a2ui.renderCard(deps.templates, 'doctor_jump_card', event.payload, { agent })
  return deps.a2ui.renderCard(deps.templates, 'doctor_ui_intent', { kind: event.type, payload: event.payload }, { agent })
}

function defineDoctorTool(deps: DoctorToolDeps, entry: DoctorToolManifestEntry): LyteboatAgentTool {
  const definition = defineTool({
    name: entry.name,
    description: entry.description,
    parameters: entry.parameters,
    output: DOCTOR_TOOL_OUTPUT,
    execute: async (args, exec): Promise<DoctorToolValue> => {
      const agent = callingAgent(exec, entry.name)
      const context = deps.requestContext.contextOf(agent)
      const answer = await callDoctorClinical(deps.settings(), {
        tool: entry.name,
        actor: doctorActorOf(context),
        // dsh hands the arguments over as frozen lossless JSON.
        arguments: args as JsonValue,
        page: doctorPageOf(context),
        utterance: latestDoctorUtterance(agent),
        acceptedRule: acceptedRuleOf(deps.toolPolicy.sessionState(agent)),
      }, exec.signal)
      // The digest already says what failed in the words the persona expects ("[tool:<name> status=error] …").
      if (answer.isError) throw new Error(answer.digest)
      const cards = await Promise.all(answer.events.map(event => cardOf(deps, event, agent)))
      const accepted = answer.stateDelta[DOCTOR_ACCEPTED_RULE_KEY]
      return { digest: answer.digest, cards, ...accepted === undefined || accepted === null ? {} : { acceptedRule: JSON.stringify(accepted) } }
    },
  })
  return {
    definition,
    visibility: 'always',
    stateDelta: (_args, value) => {
      const accepted = (value as DoctorToolValue).acceptedRule
      return accepted === undefined ? undefined : { [DOCTOR_ACCEPTED_RULE_KEY]: accepted }
    },
  }
}

/**
 * Every doctor tool, in manifest order.
 * @param deps - the doctor tool dependencies.
 * @returns the tools with their visibility and state delta.
 */
export function doctorTools(deps: DoctorToolDeps): LyteboatAgentTool[] {
  return deps.manifest.map(entry => defineDoctorTool(deps, entry))
}
