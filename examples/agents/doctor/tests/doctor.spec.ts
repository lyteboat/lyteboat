/**
 * The doctor agent on the unit host: the kernel's agent loop, tool policy,
 * a2ui and request context services, the agent's own row, a scripted model,
 * and an HTTP server standing in for the doctor service's tool endpoint. Each
 * request carries its context (`actor`, `page`) as the doctor service's chat
 * bridge sends it.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MockAdapter, createLyteboatUnitHost, mountAgentStandingScope, textResponse, toolCallResponse, type AgentStandingScope } from '@lyteboat/testkit'
import ToolPolicyService from '@lyteboat/tool-policy'
import LyteboatDistroService from '@lyteboat/distro'
import ModelSideCallService from '@lyteboat/model-side-call'
import A2uiService from '@lyteboat/a2ui'
import RequestContextService from '@lyteboat/request-context'
import DoctorAgent from '@lyteboat/agent-doctor/agent'
import { readDoctorToolManifest } from '../src/tools/doctor-tool-manifest.ts'

const DOCTOR_DIR = fileURLToPath(new URL('..', import.meta.url))
const SECRET = 'test-secret'

interface RecordedCall { tool: string; authorization: string; actor: string; body: { arguments: unknown; page: unknown; utterance: string; accepted_rule: unknown } }

/** The doctor service's tool endpoint: records each call and answers from `answers`. */
const doctorService = { calls: [] as RecordedCall[], answers: new Map<string, unknown>(), status: 200 }
let server: Server

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((text) => {
      const tool = decodeURIComponent((request.url ?? '').replace(/^\/api\/doctor\/agent\/tools\//u, ''))
      doctorService.calls.push({ tool, authorization: request.headers.authorization ?? '', actor: String(request.headers['x-doctor-actor'] ?? ''), body: JSON.parse(text) as RecordedCall['body'] })
      response.writeHead(doctorService.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(doctorService.answers.get(tool) ?? { is_error: false, digest: `[tool:${tool} status=ok]`, events: [], state_delta: {} }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  process.env['DOCTOR_CLINICAL_URL'] = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/doctor/agent/`
  process.env['DOCTOR_AGENT_SECRET'] = SECRET
})

afterAll(async () => {
  delete process.env['DOCTOR_CLINICAL_URL']
  delete process.env['DOCTOR_AGENT_SECRET']
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
})

beforeEach(() => {
  doctorService.calls = []
  doctorService.answers = new Map()
  doctorService.status = 200
})

function textOf(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

async function harness(adapter: MockAdapter): Promise<{ ctx: Context; doctor: AgentStandingScope }> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(ModelSideCallService)
  await ctx.plugin(A2uiService)
  await ctx.plugin(RequestContextService)
  const doctor = await mountAgentStandingScope(ctx, DOCTOR_DIR, DoctorAgent)
  return { ctx, doctor }
}

const PAGE = { view: 'trial', trial_id: 'NCT05881278', patient_id: '' }

async function send(ctx: Context, agent: Agent, text: string, context: Record<string, unknown> = { actor: 'li', page: PAGE }): Promise<void> {
  agent.followup(ctx.requestContext.message(text, { context: context as never }))
  await agent.whenIdle()
}

type CardMeta = { lyteboat?: { cards?: { area: string; emission: string; payload: { components: { component: Record<string, Record<string, unknown>> }[] } }[] } }

function results(agent: Agent): { text: string; isError: boolean; meta: CardMeta }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result' && event.surfaceOp === 'append')
    .map(event => ({ text: textOf(event.data.message), isError: event.data.message.isError === true, meta: event.data.meta as unknown as CardMeta }))
}

describe('the doctor agent on the unit host (scripted model, stand-in doctor service)', () => {
  it('sends a tool call to the doctor service for the request\'s doctor and page, gives the model only the digest, and renders the UI events as immediate cards', async () => {
    doctorService.answers.set('open_trial', {
      is_error: false,
      digest: '[tool:open_trial status=ok trial=NCT05881278] 待评估 3 位',
      events: [
        { type: 'doctor.ui.open_trial', payload: { trial_id: 'NCT05881278' } },
        { type: 'doctor.ui.card', payload: { icon: '◫', title: '项目详情', sub: '肺癌一线', go: { kind: 'doctor.ui.open_trial', trial_id: 'NCT05881278' } } },
      ],
      state_delta: { doctor_ui_intent: { kind: 'doctor.ui.open_trial', trial_id: 'NCT05881278' } },
    })
    const adapter = new MockAdapter([toolCallResponse('c1', 'open_trial', {}), textResponse('待评估 3 位。')])
    const { ctx, doctor } = await harness(adapter)
    const agent = await doctor.createAgentInstance('doctor-open-trial')

    await send(ctx, agent, '这个项目怎么样')

    expect(doctorService.calls).toEqual([{
      tool: 'open_trial',
      authorization: `Bearer ${SECRET}`,
      actor: 'li',
      body: { arguments: {}, page: PAGE, utterance: '这个项目怎么样', accepted_rule: null },
    }])
    const [result] = results(agent)
    expect(result?.text).toBe('[tool:open_trial status=ok trial=NCT05881278] 待评估 3 位')
    const cards = result?.meta.lyteboat?.cards ?? []
    expect(cards.map(card => [card.area, card.emission])).toEqual([['doctor_ui_intent', 'immediate'], ['doctor_jump_card', 'immediate']])
    expect(cards[0]?.payload.components[0]?.component['DoctorUiIntent']).toEqual({ kind: 'doctor.ui.open_trial', payload: { trial_id: 'NCT05881278' } })
    expect(cards[1]?.payload.components[0]?.component['DoctorJumpCard']).toMatchObject({ title: '项目详情', go: { kind: 'doctor.ui.open_trial' } })
    // Only the accepted rule is session state; the intent the doctor service also returns is not.
    expect(ctx.toolPolicy.sessionState(agent)).toEqual({})
  })

  it('keeps the rule a search accepted and sends it with the next search, replaced rather than merged by a later rule', async () => {
    const first = { all: [{ field_key: 'ecog', op: '<=', value: 1 }] }
    const second = { any: [{ field_key: 'age', op: '>=', value: 70 }] }
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'search_patients', { rule: { predicates: [{ field_key: 'ecog', op: '<=', value: 1 }] } }), textResponse('2 位。'),
      toolCallResponse('c2', 'search_patients', { outcome: 'missing' }), textResponse('1 位。'),
    ])
    const { ctx, doctor } = await harness(adapter)
    const agent = await doctor.createAgentInstance('doctor-rule')

    doctorService.answers.set('search_patients', { is_error: false, digest: '[tool:search_patients status=ok n=2]', events: [], state_delta: { doctor_accepted_rule: first, doctor_patient_ids: ['P1'] } })
    await send(ctx, agent, 'ECOG 0-1 的有谁')
    doctorService.answers.set('search_patients', { is_error: false, digest: '[tool:search_patients status=ok n=1]', events: [], state_delta: { doctor_accepted_rule: second } })
    await send(ctx, agent, '那缺数据的呢')

    expect(doctorService.calls.map(call => [call.body.utterance, call.body.accepted_rule])).toEqual([['ECOG 0-1 的有谁', null], ['那缺数据的呢', first]])
    expect(ctx.toolPolicy.sessionState(agent)).toEqual({ doctor_accepted_rule: JSON.stringify(second) })
  })

  it('reports a refused call to the model as a failed tool result with the doctor service\'s digest', async () => {
    doctorService.answers.set('explain_pair', { is_error: true, digest: '[tool:explain_pair status=error] 档案里没有叫「x」的患者', events: [], state_delta: {} })
    const adapter = new MockAdapter([toolCallResponse('c1', 'explain_pair', { patient_name: 'x' }), textResponse('查不到。')])
    const { ctx, doctor } = await harness(adapter)
    const agent = await doctor.createAgentInstance('doctor-error')

    await send(ctx, agent, 'x 差在哪')

    expect(results(agent)).toEqual([{ text: 'Error: [tool:explain_pair status=error] 档案里没有叫「x」的患者', isError: true, meta: undefined }])
  })

  it('refuses to call the doctor service for a request that names no doctor', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'open_trial', {}), textResponse('不行。')])
    const { ctx, doctor } = await harness(adapter)
    const agent = await doctor.createAgentInstance('doctor-no-actor')

    await send(ctx, agent, '这个项目怎么样', { page: PAGE })

    expect(doctorService.calls).toEqual([])
    expect(results(agent)[0]?.text).toBe('Error: doctor: the request context names no doctor (context.actor)')
  })

  it('offers the model the fourteen tools of the manifest, always visible, and nothing inherited', async () => {
    const adapter = new MockAdapter([textResponse('你好。')])
    const { ctx, doctor } = await harness(adapter)
    const agent = await doctor.createAgentInstance('doctor-tools')

    await send(ctx, agent, '你好')

    expect((adapter.requests[0]?.tools ?? []).map(tool => tool.name).sort()).toEqual([
      'draft_feedback', 'explain_pair', 'list_candidates', 'list_documents', 'list_experiences', 'list_match_runs', 'list_trial_criteria',
      'open_patient', 'open_trial', 'prepare_verdict', 'propose_experience', 'save_patient_field', 'search_patients', 'search_trials',
    ])
    expect(adapter.requests[0]?.temperature).toBe(1)
  })
})

describe('readDoctorToolManifest', () => {
  const manifest = readDoctorToolManifest(fileURLToPath(new URL('../assets/doctor-tools.json', import.meta.url)))

  it('carries a nested nullable field over as a one-of, nested required fields as required, and a top-level field as the doctor service collapsed it', () => {
    const search = manifest.find(entry => entry.name === 'search_patients')

    expect(search?.parameters['archived']).toMatchObject({ type: 'boolean', default: false })
    expect(search?.parameters['rule']).toMatchObject({
      type: 'object',
      additionalProperties: true,
      properties: {
        predicates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field_key: { type: 'string', required: true },
              op: { type: 'string', required: true },
              value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }], default: null },
            },
          },
        },
      },
    })
  })

  it('keeps each tool\'s required parameters and its thinking hint', () => {
    const save = manifest.find(entry => entry.name === 'save_patient_field')

    expect(save?.thinkingHint).toBe('正在补录…')
    expect(Object.entries(save?.parameters ?? {}).filter(([, spec]) => spec.required === true).map(([name]) => name)).toEqual(['field_key', 'value'])
  })
})
