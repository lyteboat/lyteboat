/**
 * The doctor service's internal tool endpoint: `POST <base>/tools/<name>`
 * with the shared secret as a bearer token and the acting doctor in
 * `x-doctor-actor`. The service re-reads that account on every call, runs the
 * tool against the doctor's department, and answers with the digest for the
 * model, the UI events for the workbench, and the tool's state delta, every
 * string already pseudonymized (patients as 患者#<id>). Where to reach it is
 * deployment input: `DOCTOR_CLINICAL_URL` and `DOCTOR_AGENT_SECRET`, which the
 * doctor service sets when it starts this process.
 * @module @lyteboat/agent-doctor/tools/doctor-clinical-client
 */

import type { JsonValue } from '@lyteboat/contracts'
import { z } from 'zod'
import type { DoctorPage } from '../session/doctor-turn-facts.ts'

/** One tool call, as the doctor service runs it. */
interface DoctorClinicalCall {
  tool: string
  actor: string
  arguments: JsonValue
  page: DoctorPage
  utterance: string
  acceptedRule: JsonValue | undefined
}

/** One UI event a tool sends the workbench: an intent (`doctor.ui.*`) or a jump card (`doctor.ui.card`). */
export interface DoctorUiEvent {
  type: string
  payload: { [key: string]: JsonValue }
}

/** What the doctor service answers for one call. */
interface DoctorClinicalAnswer {
  isError: boolean
  digest: string
  events: DoctorUiEvent[]
  stateDelta: { [key: string]: JsonValue }
}

/** Where the endpoint is and the secret it takes. */
export interface DoctorClinicalSettings {
  baseUrl: string
  secret: string
}

const answerSchema = z.strictObject({
  is_error: z.boolean(),
  digest: z.string(),
  events: z.array(z.strictObject({ type: z.string().startsWith('doctor.ui.'), payload: z.record(z.string(), z.json()) })),
  state_delta: z.record(z.string(), z.json()),
})

/**
 * The settings this process was started with.
 * @param env - the environment.
 * @throws naming the variable that is missing.
 */
export function doctorClinicalSettingsOf(env: NodeJS.ProcessEnv): DoctorClinicalSettings {
  const baseUrl = env['DOCTOR_CLINICAL_URL'] ?? ''
  const secret = env['DOCTOR_AGENT_SECRET'] ?? ''
  if (baseUrl === '') throw new Error('doctor: DOCTOR_CLINICAL_URL is not set (the doctor service sets it when it starts lyteboat)')
  if (secret === '') throw new Error('doctor: DOCTOR_AGENT_SECRET is not set (the doctor service sets it when it starts lyteboat)')
  return { baseUrl: baseUrl.replace(/\/+$/u, ''), secret }
}

/**
 * Run one tool call on the doctor service.
 * @param settings - where the endpoint is.
 * @param call - the call.
 * @param signal - the tool's cancellation signal.
 * @returns the service's answer.
 * @throws when the service refuses the call or answers outside the protocol.
 */
export async function callDoctorClinical(settings: DoctorClinicalSettings, call: DoctorClinicalCall, signal: AbortSignal): Promise<DoctorClinicalAnswer> {
  const response = await fetch(`${settings.baseUrl}/tools/${encodeURIComponent(call.tool)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.secret}`, 'x-doctor-actor': call.actor },
    body: JSON.stringify({
      arguments: call.arguments,
      page: call.page,
      utterance: call.utterance,
      accepted_rule: call.acceptedRule ?? null,
    }),
    signal,
  })
  if (!response.ok) throw new Error(`doctor: the doctor service refused ${call.tool} (HTTP ${String(response.status)})`)
  const parsed = answerSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error(`doctor: the doctor service answered ${call.tool} outside the protocol: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  const answer = parsed.data
  // zod's JSON type is JSON: the casts only name it.
  return { isError: answer.is_error, digest: answer.digest, events: answer.events as DoctorUiEvent[], stateDelta: answer.state_delta as { [key: string]: JsonValue } }
}
