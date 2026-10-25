/**
 * The `/chat` request as the endpoint reads it, which sessions are an
 * owner's and archiving them, and the enterprise stream's frame order,
 * numbering, and decorators.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { LyteboatRequestOwner } from '@lyteboat/contracts'
import { chatHistoryOf, checkChatHistoryLimit, parseChatHistoryQuery } from '../src/chat-history.ts'
import { ChatApiError, parseChatRequest } from '../src/chat-request.ts'
import { archiveOwnerChatSessions, isOwnChatSession, type ChatOwnerSessionServices } from '../src/chat-owner-sessions.ts'
import { isChatSessionOwner } from '../src/chat-session-owner.ts'
import { ChatEnterpriseWriter, sseFrame, type ChatEnterpriseFrame, type ChatFrameDecorator } from '../src/enterprise-frames.ts'

const context = { agentId: 'finance', sessionId: 'session-1', messageId: 'm-1', owner: { kind: 'user' as const, id: 'u-1' } }

function writer(decorators: readonly ChatFrameDecorator[] = []): { frames: ChatEnterpriseFrame[]; write: ChatEnterpriseWriter } {
  const frames: ChatEnterpriseFrame[] = []
  return { frames, write: new ChatEnterpriseWriter({ context, decorators, send: frame => { frames.push(frame) }, now: () => new Date(0) }) }
}

describe('isChatSessionOwner', () => {
  const user = { kind: 'user', id: 'u-1' } as const
  const operator = { kind: 'operator', id: 'carol' } as const

  it('lets the owner who started a session continue it: an end user, or a Studio account', () => {
    expect(isChatSessionOwner({ kind: 'user', id: 'u-1' }, user)).toBe(true)
    expect(isChatSessionOwner({ kind: 'operator', id: 'carol' }, operator)).toBe(true)
  })

  it('refuses another owner, the same id under another kind, and a session without an owner', () => {
    expect(isChatSessionOwner({ kind: 'user', id: 'u-2' }, user)).toBe(false)
    expect(isChatSessionOwner({ kind: 'operator', id: 'u-1' }, user)).toBe(false)
    expect(isChatSessionOwner({ kind: 'user', id: 'carol' }, operator)).toBe(false)
    expect(isChatSessionOwner({ kind: 'system', id: 'u-1' }, user)).toBe(false)
    expect(isChatSessionOwner(null, user)).toBe(false)
    expect(isChatSessionOwner(undefined, operator)).toBe(false)
  })
})

describe('chatHistoryOf', () => {
  const event = (seq: number, type: string, data: object, surfaceOp: unknown = 'append'): SessionEvent =>
    ({ seq, time: 1000 + seq, type, data, surfaceOp }) as unknown as SessionEvent

  it('lists the person\'s messages and the agent\'s answers, leaving out tool-calling steps, injected context, and replaced copies', () => {
    const events = [
      event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: ' 查一下 ' }] }),
      event(2, 'user/message', { source: { kind: 'notice' }, content: [{ type: 'text', text: 'reminder' }] }),
      event(3, 'assistant/message', { message: { content: [{ type: 'text', text: '我先查' }, { type: 'tool-call', id: 'c1', name: 'search', arguments: '{}' }] } }),
      event(4, 'tool/result', { message: { content: [{ type: 'text', text: 'found' }] } }),
      event(5, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: '找到 2 位' }] } }),
      event(6, 'assistant/message', { message: { content: [{ type: 'text', text: 'pruned' }] } }, { startSeq: 5, endSeq: 5 }),
    ]

    expect(chatHistoryOf(events, 40)).toEqual([{ role: 'user', text: '查一下', at: 1001 }, { role: 'assistant', text: '找到 2 位', at: 1005 }])
    expect(chatHistoryOf(events, 1)).toEqual([{ role: 'assistant', text: '找到 2 位', at: 1005 }])
  })

  it('lists an imported round\'s question with its answer, in log order before the person\'s own message', () => {
    const imported = { kind: 'plugin:lyteboat-history-import', traceId: 'trace-0001' }
    const events = [
      event(1, 'user/message', { source: imported, content: [{ type: 'text', text: '看看资产' }] }),
      event(2, 'assistant/message', { message: { source: { provider: 'lyteboat', model: 'history-import' }, content: [{ type: 'text', text: '总额 100' }] } }),
      event(3, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }),
    ]

    expect(chatHistoryOf(events, 40).map(({ role, text }) => `${role}:${text}`)).toEqual(['user:看看资产', 'assistant:总额 100', 'user:继续'])
  })
})

describe('checkChatHistoryLimit', () => {
  it('takes 40 when absent and passes 1 and 200', () => {
    expect([checkChatHistoryLimit(undefined), checkChatHistoryLimit(1), checkChatHistoryLimit(200)]).toEqual([40, 1, 200])
  })

  it('refuses 0, 201, and 1.5 as an invalid request', () => {
    for (const limit of [0, 201, 1.5]) {
      let refused: unknown
      try {
        checkChatHistoryLimit(limit)
      } catch (error: unknown) {
        refused = error
      }
      expect(refused).toBeInstanceOf(ChatApiError)
      expect(refused).toMatchObject({ code: 'invalid_request', message: 'limit: an integer from 1 to 200' })
    }
  })
})

/** A stored session as the session controller's projections report it. */
interface StoredChatSession {
  owner?: LyteboatRequestOwner
  agentPreset: string
}

/** The session controller and the Workspace registry over `sessions`, recording each archive. */
function ownerSessionServices(sessions: Record<string, StoredChatSession>, archivedBefore: string[] = []): { services: ChatOwnerSessionServices; archives: { sessionId: string; stopActivity: boolean | undefined }[] } {
  const archived = [...archivedBefore]
  const archives: { sessionId: string; stopActivity: boolean | undefined }[] = []
  const services = {
    sessionController: {
      list: () => Promise.resolve({ items: Object.keys(sessions).map(sessionId => ({ sessionId })) }),
      projections: ({ sessionId }: { sessionId: string }) => {
        const stored = sessions[sessionId]
        return Promise.resolve(stored === undefined ? null : { kind: 'sequenced', values: { agentPreset: stored.agentPreset, ...stored.owner === undefined ? {} : { lyteboatRequest: { owner: stored.owner } } } })
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() { return archived },
      archiveSession: (sessionId: string, options?: { stopActivity?: boolean }) => {
        archived.push(sessionId)
        archives.push({ sessionId, stopActivity: options?.stopActivity })
        return Promise.resolve()
      },
    },
  }
  // The two dsh services, reduced to the members the functions call.
  return { services: services as unknown as ChatOwnerSessionServices, archives }
}

describe('archiveOwnerChatSessions', () => {
  const doctor = { kind: 'user', id: '胸外科/li' } as const

  it('archives the owner\'s sessions under the agent, stopping their work, and counts them', async () => {
    const { services, archives } = ownerSessionServices({
      's-1': { owner: doctor, agentPreset: 'doctor' },
      's-2': { owner: doctor, agentPreset: 'doctor' },
    })

    expect(await archiveOwnerChatSessions(services, { agentId: 'doctor', owner: doctor })).toBe(2)
    expect(archives).toEqual([{ sessionId: 's-1', stopActivity: true }, { sessionId: 's-2', stopActivity: true }])
  })

  it('leaves another owner\'s, an operator\'s with the same id, another agent\'s, an unowned, and an archived session, and archives nothing twice', async () => {
    const { services, archives } = ownerSessionServices({
      mine: { owner: doctor, agentPreset: 'doctor' },
      other: { owner: { kind: 'user', id: '心内科/li' }, agentPreset: 'doctor' },
      operator: { owner: { kind: 'operator', id: '胸外科/li' }, agentPreset: 'doctor' },
      finance: { owner: doctor, agentPreset: 'finance' },
      unowned: { agentPreset: 'doctor' },
      gone: { owner: doctor, agentPreset: 'doctor' },
    }, ['gone'])

    expect(await archiveOwnerChatSessions(services, { agentId: 'doctor', owner: doctor })).toBe(1)
    expect(archives.map(({ sessionId }) => sessionId)).toEqual(['mine'])
    expect(await archiveOwnerChatSessions(services, { agentId: 'doctor', owner: doctor })).toBe(0)
  })

  it('archives nothing and answers 0 when there are no sessions', async () => {
    const { services, archives } = ownerSessionServices({})

    expect(await archiveOwnerChatSessions(services, { agentId: 'doctor', owner: doctor })).toBe(0)
    expect(archives).toEqual([])
  })
})

describe('isOwnChatSession', () => {
  it('answers false for the owner\'s own session once it is archived, and for a session that does not exist', async () => {
    const owner = { kind: 'user', id: 'u-1' } as const
    const { services } = ownerSessionServices({ open: { owner, agentPreset: 'alpha' }, archived: { owner, agentPreset: 'alpha' } }, ['archived'])
    const own = (sessionId: string): Promise<boolean> => isOwnChatSession(services, sessionId as SessionId, owner, 'alpha')

    expect([await own('open'), await own('archived'), await own('missing')]).toEqual([true, false, false])
  })
})

describe('parseChatHistoryQuery', () => {
  it('reads the query with a default limit and refuses a missing field or a limit out of range', () => {
    expect(parseChatHistoryQuery(new URLSearchParams('agent_id=a&user_id=u&session_id=s'))).toEqual({ agentId: 'a', userId: 'u', sessionId: 's', limit: 40 })
    expect(() => parseChatHistoryQuery(new URLSearchParams('agent_id=a&session_id=s'))).toThrow('user_id: required')
    expect(() => parseChatHistoryQuery(new URLSearchParams('agent_id=a&user_id=u&session_id=s&limit=0'))).toThrow('limit: an integer from 1 to 200')
  })
})

describe('parseChatRequest', () => {
  it('reads the request fields, with stream off unless asked', () => {
    const request = parseChatRequest(JSON.stringify({ agent_id: 'finance', user_id: 'u-1', message: '看看我的资产', trace_id: 't-1', context: { customer: 'c-1' } }))

    expect(request).toEqual({ agentId: 'finance', owner: { kind: 'user', id: 'u-1' }, message: '看看我的资产', sessionId: undefined, messageId: undefined, traceId: 't-1', stream: false, context: { customer: 'c-1' }, history: undefined })
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
