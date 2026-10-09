/**
 * One eval turn through dsh's session controller, the way `/chat` sends a
 * message: it is queued with its request on the source, and once the turn
 * that answers it ends (`turnOutcome.ended`, matched by the request id), the
 * session shows what the turn did: its outcome, tools, and model requests as
 * the turn outcome folds them, its text and cards as `a2ui.turnParts` lays
 * them out. A turn that does not end within the deadline is cancelled and
 * ends aborted.
 * @module @lyteboat/eval-runner/eval-turn
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@lyteboat/a2ui'
import type { JsonValue, LyteboatTurnOutcome } from '@lyteboat/contracts'
import type {} from '@lyteboat/turn-outcome'
import type { EvalObservation } from './eval-check.ts'

/** One message to send. */
interface EvalTurnInput {
  agent: Agent
  sessionId: SessionId
  requestId: string
  text: string
  /** The request on the message's source (`requestContext.sourceFields`). */
  sourceFields: { readonly [key: string]: JsonValue }
  timeoutMs: number
}

/** What the session shows of one ended turn. */
async function observe(ctx: Context, agent: Agent, sessionId: SessionId, outcome: LyteboatTurnOutcome): Promise<EvalObservation> {
  const parts = ctx.a2ui.turnParts(agent.session, SessionLogOffset(outcome.fromSeq))
  const projections = await ctx.sessionController.projections({ sessionId }, new AbortController().signal)
  // The projection's wire view is the active skill's name, or null.
  const active = projections?.values['lyteboatActiveSkill']
  const skill = typeof active === 'string' ? active : null
  return {
    skill,
    tools: outcome.tools.map(tool => tool.name),
    cards: parts.flatMap(part => part.kind === 'card' ? [part.card.area] : []),
    outcome: outcome.kind ?? 'errored',
    text: parts.map(part => part.kind === 'text' ? part.text : '').join(''),
    modelRequests: outcome.modelRequests,
  }
}

/**
 * Send one message and observe the turn that answers it.
 * @param ctx - the eval runner's context: the session controller, a2ui, and the turn outcome.
 * @param input - the agent, the session, the message, and the deadline.
 * @returns what the turn showed.
 */
export async function runEvalTurn(ctx: Context, input: EvalTurnInput): Promise<EvalObservation> {
  const { agent, sessionId, requestId } = input
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await ctx.sessionController.prompt({
      requestId: brandString<SessionRequestId>(requestId),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: input.text }],
      sourceFields: input.sourceFields,
    }, new AbortController().signal)
    timer = setTimeout(() => {
      ctx.logger.warn(`eval-runner: the turn answering ${requestId} did not end within ${String(input.timeoutMs)}ms; cancelling it`)
      try {
        ctx.sessionController.cancel({ sessionId })
      } catch (error: unknown) {
        ctx.logger.warn(`eval-runner: cancelling ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, input.timeoutMs)
    // An ended turn resolves at once, so waiting may start after the message was queued.
    const outcome = await ctx.turnOutcome.ended(agent.session, requestId, new AbortController().signal)
    return await observe(ctx, agent, sessionId, outcome)
  } finally {
    clearTimeout(timer)
  }
}
