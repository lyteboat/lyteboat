/**
 * The doctor agent behind `/chat` (the serve composition in process, scripted
 * model, an HTTP server standing in for the doctor service): the persona is
 * the system prompt, a tool call reaches the doctor service for the request's
 * doctor with the doctor's page, its UI events stream back as A2UI
 * frames before the answer, and `/chat/history` replays the conversation to
 * its owner. The session reopens.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { streamChat } from '@lyteboat/testkit/chat-client'
import { LYTEBOAT_SERVE_BUNDLES, startComposition, type RunningComposition } from '@lyteboat/testkit/composition'
import { createLyteboatScratch } from '@lyteboat/testkit/scratch'
import { waitForSessionLog, type SessionLogRecord } from '@lyteboat/testkit/session-log'
import { reopenRefusal } from '@lyteboat/testkit/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel, type ScriptedReply } from '@lyteboat/testkit/scripted-model'

const AGENTS = fileURLToPath(new URL('../..', import.meta.url))

function doctorScript(request: RecordedRequest): ScriptedReply {
  if (request.toolNames.includes('explain_pair') && !request.calledTools.includes('explain_pair')) {
    return { toolCall: { name: 'explain_pair', arguments: { patient_name: '患者#P12' }, id: 'call-explain' } }
  }
  return { text: '患者#P12 缺 ECOG，待补后可复评。' }
}

describe('doctor agent behind /chat (in process, scripted model, stand-in doctor service)', () => {
  const scratch = createLyteboatScratch('doctor-chat')
  const toolCalls: { actor: string; tool: string; page: unknown }[] = []
  let doctorService: Server
  let model: ScriptedModel
  let serve: RunningComposition
  let home: string
  let chat: string

  beforeAll(async () => {
    doctorService = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { page: unknown }
        toolCalls.push({ actor: String(request.headers['x-doctor-actor']), tool: (request.url ?? '').split('/').at(-1) ?? '', page: body.page })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          is_error: false,
          digest: '[tool:explain_pair status=ok pair=P12|T1] 预筛评估「信息不足」：缺数据待补：ECOG。',
          events: [{ type: 'doctor.ui.open_pair', payload: { patient_id: 'P12', trial_id: 'T1' } }],
          state_delta: {},
        }))
      })
    })
    await new Promise<void>((resolve) => { doctorService.listen(0, '127.0.0.1', resolve) })
    model = await startScriptedModel(withTitle(doctorScript), { apiKey: 'mock-key' })
    const run = scratch.run('serve')
    home = run.home
    serve = startComposition({
      bundles: LYTEBOAT_SERVE_BUNDLES,
      args: ['--agents', AGENTS, '--port', '0'],
      cwd: run.workspace,
      home,
      env: {
        ...scriptedModelEnv(model),
        DOCTOR_CLINICAL_URL: `http://127.0.0.1:${String((doctorService.address() as AddressInfo).port)}/api/doctor/agent`,
        DOCTOR_AGENT_SECRET: 'composite-secret',
      },
      timeoutMs: 170_000,
    })
    chat = (await serve.waitForStdout(/^lyteboat serve: (http:\/\/\S+\/chat) \(agents: (?:[a-z0-9-]+, )*doctor(?:, [a-z0-9-]+)*\)$/mu))[1] ?? ''
  })

  afterAll(async () => {
    const run = await serve.stop()
    await model.close()
    await new Promise<void>((resolve) => { doctorService.close(() => { resolve() }) })
    scratch.remove()
    expect(run.code, run.stderr).toBe(0)
  })

  it('runs the tool on the doctor service for the request\'s doctor and page, streams the intent card before the answer, and replays the conversation', async () => {
    const before = model.requests.length
    const streamed = await streamChat(chat, {
      agent_id: 'doctor',
      user_id: 'li@ws-clinic',
      message: '患者#P12 那对差在哪',
      context: { actor: 'li', page: { view: 'trial', trial_id: 'T1', patient_id: '' } },
    })

    const loop = model.requests.slice(before).filter(request => request.purpose === 'loop')
    expect(loop[0]?.systemText).toContain('### 红线（最高优先，任何情况下不可违反）')
    expect(toolCalls).toEqual([{ actor: 'li', tool: 'explain_pair', page: { view: 'trial', trial_id: 'T1', patient_id: '' } }])
    const shown = streamed.frames.filter(frame => frame.event === 'text_message_content').map(frame => String(frame.data['ui_protocol']))
    expect(shown.filter((protocol, index) => protocol !== shown[index - 1])).toEqual(['A2UI', 'text'])
    const card = streamed.frames.find(frame => frame.data['ui_protocol'] === 'A2UI')?.data['ui_data'] as { components: { component: Record<string, unknown> }[] }
    expect(card.components[0]?.component).toEqual({ DoctorUiIntent: { kind: 'doctor.ui.open_pair', payload: { patient_id: 'P12', trial_id: 'T1' } } })
    expect(streamed.frames.at(-1)?.data).toMatchObject({ ui_data: '患者#P12 缺 ECOG，待补后可复评。', extra: { run_outcome: 'completed' } })

    const sessionId = String(streamed.frames[0]?.data['conversation_id'])
    const history = await fetch(new URL(`/chat/history?agent_id=doctor&user_id=li@ws-clinic&session_id=${sessionId}`, chat))
    expect(((await history.json()) as { entries: { role: string; text: string }[] }).entries.map(({ role, text }) => `${role}:${text}`))
      .toEqual(['user:患者#P12 那对差在哪', 'assistant:患者#P12 缺 ECOG，待补后可复评。'])
    const records = await waitForSessionLog<SessionLogRecord & { type: string }>(home, sessionId, log => log.some(record => record.type === 'turn/end'))
    expect(reopenRefusal(records)).toBeUndefined()
  })
})
