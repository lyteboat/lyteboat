/**
 * lyteboat extension `agent-loop-pre-assemble` (dsh-compat/contract/extensions.yml): the
 * hook between a passed intake and the step's model selection, tool set, and prompt assembly.
 */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from '../mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock', 'routed'], adapter)
  return ctx
}

it('lyteboat/pre-assemble runs before assembly, so a section registered there reaches this step\'s request', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const ctx = await harness(adapter)
  let registered = false
  ctx.on('lyteboat/pre-assemble', async (payload, next) => {
    if (!registered) {
      registered = true
      payload.agent.ctx.systemPrompt.section({ name: 'lyteboat:test-mark', order: 5, text: 'PRE-ASSEMBLE-MARK' })
    }
    return next()
  })
  const agent = await ctx.agentLoop.create(SessionId('pre-assemble'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  const system = adapter.requests[0]?.messages[0]
  expect(system?.role).toBe('system')
  expect(JSON.stringify(system?.content)).toContain('PRE-ASSEMBLE-MARK')
})

it('lyteboat/pre-assemble runs before the step resolves its tool set, so a tool registered there is declared in this step\'s request', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const ctx = await harness(adapter)
  let registered = false
  ctx.on('lyteboat/pre-assemble', async (payload, next) => {
    if (!registered) {
      registered = true
      payload.agent.ctx.tools.register(defineTool({
        name: 'pre_assemble_probe',
        description: 'A tool registered in the pre-assembly hook.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'probed',
      }))
    }
    return next()
  })
  const agent = await ctx.agentLoop.create(SessionId('pre-assemble-tools'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('pre_assemble_probe')
})

it('lyteboat/pre-assemble runs before the step captures its model selection, so a route selected there serves this step', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const ctx = await harness(adapter)
  ctx.on('lyteboat/pre-assemble', async (payload, next) => {
    payload.agent.model.select({ provider: 'routed', model: 'routed' })
    return next()
  })
  const agent = await ctx.agentLoop.create(SessionId('pre-assemble-model'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]).toMatchObject({ provider: 'routed', model: 'routed' })
})
