/**
 * What a doctor tool reads from its session besides its arguments: who the
 * request acts for and which page the doctor is looking at (the request
 * context the doctor service sends with every message: `actor`, `page`), the
 * doctor's words this turn (the last human message), and the filter rule an
 * earlier patient search accepted (`doctor_accepted_rule` in the session
 * state). The doctor service checks a rule's threshold numbers against those
 * words and that rule, never against what the model repeats.
 * @module @lyteboat/agent-doctor/session/doctor-turn-facts
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, LyteboatStateValue } from '@lyteboat/contracts'
import { z } from 'zod'

/** The page the doctor is looking at, as the request context carries it; an empty field is none. */
export interface DoctorPage {
  view: string
  trial_id: string
  patient_id: string
}

/** The session state key the accepted rule is kept under. */
export const DOCTOR_ACCEPTED_RULE_KEY = 'doctor_accepted_rule'

const doctorPageSchema = z.object({
  view: z.string().default(''),
  trial_id: z.string().default(''),
  patient_id: z.string().default(''),
})

/**
 * The page a request context names; none when it carries no `page` or a page that is not an object of strings.
 * @param context - the session's request context.
 */
export function doctorPageOf(context: { readonly [key: string]: JsonValue }): DoctorPage {
  const parsed = doctorPageSchema.safeParse(context['page'] ?? {})
  return parsed.success ? parsed.data : { view: '', trial_id: '', patient_id: '' }
}

/**
 * The doctor account a request acts for.
 * @param context - the session's request context.
 * @throws when the context names none: a tool must not run without the doctor whose department it reads.
 */
export function doctorActorOf(context: { readonly [key: string]: JsonValue }): string {
  const actor = context['actor']
  if (typeof actor !== 'string' || actor === '') throw new Error('doctor: the request context names no doctor (context.actor)')
  return actor
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

/**
 * The doctor's words this turn: the text of the session's last human message.
 * @param agent - the calling agent.
 * @returns the text, empty when the session has none.
 */
export function latestDoctorUtterance(agent: Agent): string {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.surfaceOp !== 'append') continue
    if (event.data.source.kind === 'user') return textOf(event.data.content)
  }
  return ''
}

/**
 * The rule an earlier search accepted, as the session state keeps it.
 * @param state - the session's accumulated tool state.
 * @returns the rule's JSON, undefined before any search accepted one.
 */
export function acceptedRuleOf(state: LyteboatStateValue): JsonValue | undefined {
  const stored = state[DOCTOR_ACCEPTED_RULE_KEY]
  // Kept as JSON text: the state fold deep-merges objects, which would mix an `all` rule into a later `any` one.
  return typeof stored === 'string' ? JSON.parse(stored) as JsonValue : undefined
}
