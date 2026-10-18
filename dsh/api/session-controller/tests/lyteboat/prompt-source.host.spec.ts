/**
 * lyteboat extension `session-controller-prompt-source` (dsh-compat/contract/extensions.yml): a
 * prompt adds the caller's fields to its user message's source.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../../src/agent.ts'
import { SessionCommandController } from '../../src/commands.ts'
import type { SessionPromptRequest, SessionRequestId } from '../../src/types.ts'

const SESSION = SessionId('prompt-source-session')
// The source the Remote method builds before it hands the prompt to the command controller.
const CONTROLLER_SOURCE = { kind: 'user', rpcId: 'req-1' as SessionRequestId } satisfies MessageSource

async function promptHarness(): Promise<{ controller: SessionCommandController; followup: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  const session = ctx.sessions.create(SESSION, { meta: { cwd: '/workspace' } })
  const followup = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: undefined,
    steer: vi.fn(),
    followup,
    cancel: vi.fn(),
  } as unknown as Agent
  ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  await ctx.agents.register(agent)
  ctx.provide('attachments', Object.setPrototypeOf({
    saveImages: () => Promise.reject(new Error('fixture did not expect image persistence')),
  }, AttachmentStore.prototype) as never)
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  await ctx.plugin(FileUploads)
  const agents = {
    resolveAgent: () => Promise.resolve({ agent }),
    serializeImageAdmission: <Value>(_agent: Agent, operation: () => Promise<Value>) => operation(),
  } as unknown as ApiSessionAgentController
  return { controller: new SessionCommandController(ctx, agents, '/workspace'), followup }
}

function promptRequest(sourceFields?: SessionPromptRequest['sourceFields']): SessionPromptRequest {
  return {
    requestId: 'req-1' as SessionRequestId,
    sessionId: SESSION,
    mode: 'queue',
    content: [{ type: 'text', text: 'hello' }],
    ...(sourceFields === undefined ? {} : { sourceFields }),
  }
}

describe('SessionCommandController.prompt with sourceFields', () => {
  it('adds the fields to the user message source beside the ones the controller writes', async () => {
    const { controller, followup } = await promptHarness()
    const request = { requestId: 'r-9', context: { region: 'north' } }

    await controller.prompt(promptRequest({ lyteboatRequest: request }), CONTROLLER_SOURCE)

    const message = followup.mock.calls[0]?.[0] as UserMessage
    expect(message.source).toEqual({ kind: 'user', rpcId: 'req-1', lyteboatRequest: request })
  })

  it('refuses a field the controller writes, before the message reaches the agent', async () => {
    const { controller, followup } = await promptHarness()

    await expect(controller.prompt(promptRequest({ rpcId: 'forged' }), CONTROLLER_SOURCE))
      .rejects.toMatchObject({ code: 'gateway/bad-request', message: 'sourceFields cannot set rpcId: the controller writes them' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('refuses principal, which the controller writes for a caller other than the owner', async () => {
    const { controller, followup } = await promptHarness()

    await expect(controller.prompt(promptRequest({ principal: 'forged' }), CONTROLLER_SOURCE))
      .rejects.toMatchObject({ code: 'gateway/bad-request', message: 'sourceFields cannot set principal: the controller writes them' })
    expect(followup).not.toHaveBeenCalled()
  })
})
