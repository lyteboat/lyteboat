/**
 * lyteboat's extension `agent-loop-intake` (dsh-compat/contract/extensions.yml):
 * what an intake reply writes to the session, and which version of the
 * claimed messages it writes. The loop opens and closes the step around it and
 * keeps its own locals; this module writes only the step's nodes, so the
 * upstream file carries a single call per hook.
 * @module @deepseek-ai/dsh-agent-loop/lyteboat/intake-reply
 */

import { createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { LYTEBOAT_ASSISTANT_PROVIDER, type LyteboatIntakeReply } from './step-hooks.ts'

/**
 * The messages an intake reply logs: the claimed ones, or the reply's own
 * version of them, which must be the same messages in the same order with
 * nothing but `source` changed. A reply cannot rewrite what the user said.
 * @param claimed - the messages the step claimed.
 * @param reply - the intake listener's decision.
 * @returns the messages to log.
 */
export function lyteboatIntakeMessages(claimed: UserMessage[], reply: LyteboatIntakeReply): UserMessage[] {
  if (reply.messages === undefined) return claimed
  const replaced = reply.messages
  if (replaced.length !== claimed.length) {
    throw new Error(`lyteboat/intake: reply by ${reply.plugin} logs ${replaced.length} messages for ${claimed.length} claimed`)
  }
  replaced.forEach((message, index) => {
    const original = claimed[index]
    if (original === undefined || message.id !== original.id || message.role !== original.role) {
      throw new Error(`lyteboat/intake: reply by ${reply.plugin} logs message ${message.id} where ${original?.id ?? 'none'} was claimed`)
    }
    if (message.content !== original.content && JSON.stringify(message.content) !== JSON.stringify(original.content)) {
      throw new Error(`lyteboat/intake: reply by ${reply.plugin} changes the content of message ${message.id}; only its source may change`)
    }
  })
  return replaced
}

/** Whether the surface already holds a system node (surface node 0 is reserved for the prompt). */
function hasSystemNode(session: Session): boolean {
  for (const seq of session.surface.nodes) {
    if (session.eventAt(seq)?.type === 'system/message') return true
  }
  return false
}

/**
 * Commit an intake reply inside the open step. An empty system head is
 * appended first when none exists, so the next real step's prompt replaces
 * node 0 instead of trailing the history; the claimed messages are admitted
 * as they would be on a model step; the reply is an assistant message whose
 * provider is lyteboat and whose model names the deciding plugin.
 * @param session - the agent's session, inside the step's `step/start`.
 * @param position - the open step.
 * @param messages - the claimed messages the reply answers.
 * @param reply - the intake listener's decision.
 */
export function appendLyteboatIntakeReply(
  session: Session,
  position: { turn: number; step: number },
  messages: readonly UserMessage[],
  reply: LyteboatIntakeReply,
): void {
  const { turn, step } = position
  if (!hasSystemNode(session)) {
    session.append(
      'system/message',
      { turn, step, message: createSystemMessage('') },
      { surfaceOp: 'append' },
    )
  }
  for (const message of messages) {
    session.append('user/message', message, { surfaceOp: 'append' })
  }
  session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content: reply.content,
      source: { provider: LYTEBOAT_ASSISTANT_PROVIDER, model: reply.plugin },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}
