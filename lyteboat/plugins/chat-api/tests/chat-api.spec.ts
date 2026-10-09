/**
 * The `/chat` request as the endpoint reads it, and the enterprise stream's
 * frame order, numbering, and decorators.
 */
import { describe, expect, it } from 'vitest'
import { ChatApiError, parseChatRequest } from '../src/chat-request.ts'
import { isChatSessionOwner } from '../src/chat-session-owner.ts'
import { ChatEnterpriseWriter, sseFrame, type ChatEnterpriseFrame, type ChatFrameDecorator } from '../src/enterprise-frames.ts'

const context = { agentId: 'finance', sessionId: 'session-1', messageId: 'm-1', userId: 'u-1' }

function writer(decorators: readonly ChatFrameDecorator[] = []): { frames: ChatEnterpriseFrame[]; write: ChatEnterpriseWriter } {
  const frames: ChatEnterpriseFrame[] = []
  return { frames, write: new ChatEnterpriseWriter({ context, decorators, send: frame => { frames.push(frame) }, now: () => new Date(0) }) }
}

describe('isChatSessionOwner', () => {
  it('lets the end user who owns a session continue it', () => {
    expect(isChatSessionOwner({ kind: 'user', id: 'u-1' }, 'u-1')).toBe(true)
  })

  it('refuses another user, an operator or system owner of the same id, and a session without an owner', () => {
    expect(isChatSessionOwner({ kind: 'user', id: 'u-2' }, 'u-1')).toBe(false)
    expect(isChatSessionOwner({ kind: 'operator', id: 'u-1' }, 'u-1')).toBe(false)
    expect(isChatSessionOwner({ kind: 'system', id: 'u-1' }, 'u-1')).toBe(false)
    expect(isChatSessionOwner(null, 'u-1')).toBe(false)
    expect(isChatSessionOwner(undefined, 'u-1')).toBe(false)
  })
})

describe('parseChatRequest', () => {
  it('reads the request fields, with stream off unless asked', () => {
    const request = parseChatRequest(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: '看看我的资产', trace_id: 't-1', context: { customer: 'c-1' } }))

    expect(request).toEqual({ agentId: 'finance', userId: 'u-1', message: '看看我的资产', sessionId: undefined, messageId: undefined, traceId: 't-1', stream: false, context: { customer: 'c-1' }, history: undefined })
  })

  it('reads history as the caller sent it when the request has a trace id, and refuses it without one', () => {
    const history = [{ role: 'user', traceId: 'trace-0001', parts: [{ type: 'text', text: '看看资产' }] }, { role: 'assistant', traceId: 'trace-0001', parts: [{ text: '总额 100' }] }]

    const request = parseChatRequest(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: '继续', trace_id: 't-3', history }))

    expect(request.history).toEqual(history)
    expect(() => parseChatRequest(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: '继续', history }))).toThrow(expect.objectContaining({ code: 'invalid_request', status: 400, message: 'trace_id: required with history' }) as Error)
    expect(() => parseChatRequest(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: '继续', trace_id: 't-3', history: { role: 'user' } }))).toThrow(ChatApiError)
  })

  it('refuses a body that is not JSON, a blank message, an unknown field, or another protocol, naming the problem', () => {
    const refusal = (body: string): ChatApiError => {
      try {
        parseChatRequest(body)
      } catch (error: unknown) {
        if (error instanceof ChatApiError) return error
      }
      throw new Error(`accepted ${body}`)
    }

    expect(refusal('{').message).toBe('the body is not JSON')
    expect(refusal(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: '  ' }))).toMatchObject({ code: 'invalid_request', status: 400, message: 'message: message must not be blank' })
    expect(refusal(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: 'hi', channel: 'app' })).code).toBe('invalid_request')
    expect(refusal(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: 'hi', protocol: 'internal' })).code).toBe('invalid_request')
  })
})

describe('ChatEnterpriseWriter', () => {
  it('numbers frames from 1 and closes text before reasoning before run_finished', () => {
    const { frames, write } = writer()

    write.runStarted(2)
    write.reasoning('asset_overview', { customer: 'c-1' })
    write.text('您的资产')
    write.card({ surfaceUpdate: {} })
    write.text('以上。')
    write.finish('completed')

    expect(frames.map(frame => `${String(frame.id)} ${frame.event} ${frame.data.ui_protocol}`)).toEqual([
      '1 run_started text',
      '2 reasoning_start json',
      '3 reasoning_message_content json',
      '4 text_message_start text',
      '5 text_message_content text',
      '6 text_message_content A2UI',
      '7 text_message_content text',
      '8 text_message_end text',
      '9 reasoning_end json',
      '10 run_finished text',
    ])
    expect(frames[7]?.data.ui_data).toBe('您的资产以上。')
    expect(frames.at(-1)?.data).toMatchObject({ turn: 2, conversation_id: 'session-1', message_id: 'm-1', agent_name: 'finance', ui_data: '您的资产以上。', extra: { run_outcome: 'completed' }, timestamp: '1970-01-01T00:00:00.000Z' })
  })

  it('writes one terminal frame, and no reasoning after the reasoning pair closed', () => {
    const { frames, write } = writer()

    write.runStarted(1)
    write.fail('provider unavailable', true)
    write.finish('completed')
    write.reasoning('thinking', 'late')

    expect(frames.map(frame => frame.event)).toEqual(['run_started', 'run_error'])
    expect(frames[1]?.data).toMatchObject({ ui_data: 'provider unavailable', extra: { retryable: true } })
  })

  it('lets a decorator add a data field, and fails a frame whose owned field a decorator changed', () => {
    const tagged = writer([frame => ({ ...frame, data: { ...frame.data, channel: 'app' } })])
    tagged.write.runStarted(1)
    expect(tagged.frames[0]?.data['channel']).toBe('app')

    const forged = writer([frame => ({ ...frame, data: { ...frame.data, agent_name: 'other' } })])
    expect(() => { forged.write.runStarted(1) }).toThrow('chat-api: a frame decorator changed data.agent_name, which the protocol owns')
  })

  it('puts a frame on the wire as its event line and its envelope', () => {
    const { frames, write } = writer()
    write.runStarted(1)

    expect(sseFrame(frames[0]!)).toBe(`event: run_started\ndata: ${JSON.stringify(frames[0])}\n\n`)
  })
})
