/**
 * @lyteboat/request-context — the request a human message answers to: the
 * caller's request id, the request context (who is asking, through which
 * channel, …), and the admission verdict when the admission answered it. It
 * rides the message's own `source` beside `kind: 'user'`, so dsh reads the
 * message as human input as before and the log keeps the request with the
 * words it came with. One host service, `ctx.requestContext`, writes such a
 * message (or the source fields a session-controller prompt carries it in)
 * and reads it back; the `lyteboatRequest` projection keeps the session's
 * context, and a request that carries none keeps the earlier one.
 *
 * The context is logged as the caller passed it and never shown to the model:
 * a tool reads what it needs through `contextOf`. Credentials do not belong in
 * it.
 * @module @lyteboat/request-context
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { lyteboatRequestSchema } from '@lyteboat/contracts'
import type { JsonValue, LyteboatIntakeVerdict, LyteboatRequest } from '@lyteboat/contracts'
import { lyteboatRequestOf, lyteboatRequestProjectionDefinition } from './request-projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    requestContext: RequestContextService
  }
}

/** Host service: write a human message with its request, and read the session's request state. */
export class RequestContextService extends Service {
  static inject = ['sessionProjections']

  constructor(ctx: Context) {
    super(ctx, 'requestContext')
    ctx.sessionProjections.register(lyteboatRequestProjectionDefinition)
  }

  /**
   * The human message for one request: the words as a plain user message, the
   * request on its source. A request with nothing to record leaves the source
   * as dsh writes it.
   * @param text - what the person wrote.
   * @param request - the request id, context, and verdict to record.
   */
  message(text: string, request: LyteboatRequest): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: recordsNothing(request) ? { kind: 'user' } : { kind: 'user', lyteboatRequest: request },
    })
  }

  /**
   * The fields that carry one request on a session-controller prompt
   * (`SessionPromptRequest.sourceFields`, the kernel extension
   * `session-controller-prompt-source`), which puts them on the message's
   * source as {@link message} does. A request with nothing to record adds none.
   * @param request - the request to record.
   * @throws when the request fails the contract's schema.
   */
  sourceFields(request: LyteboatRequest): { readonly [key: string]: JsonValue } {
    return recordsNothing(request) ? {} : { lyteboatRequest: lyteboatRequestSchema.parse(request) }
  }

  /**
   * The request a message carries, beside `kind: 'user'` on its source.
   * @throws when the carried request fails the contract's schema.
   */
  requestOf(message: UserMessage): LyteboatRequest | undefined {
    return lyteboatRequestOf(message.source)
  }

  /**
   * A human message with an admission verdict recorded on its request, beside
   * whatever the request already carries; the words and the id stay.
   * @param message - the human message the verdict judged.
   * @param intake - the verdict to record.
   * @throws when the request the message carries fails the contract's schema.
   */
  withIntake(message: UserMessage, intake: LyteboatIntakeVerdict): UserMessage {
    const request = lyteboatRequestSchema.parse({ ...this.requestOf(message), intake })
    return { ...message, source: { ...message.source, kind: 'user', lyteboatRequest: request } }
  }

  /** The session's request context: the latest a request carried, empty before any. */
  contextOf(agent: Agent): { [key: string]: JsonValue } {
    return this.ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')?.context ?? {}
  }
}

function recordsNothing(request: LyteboatRequest): boolean {
  return Object.values(request).every(value => value === undefined)
}

export default RequestContextService
