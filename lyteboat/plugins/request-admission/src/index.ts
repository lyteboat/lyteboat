/**
 * @lyteboat/request-admission — admission at the first step of each turn. An
 * agent registers an admission function in its own scope; on the
 * `lyteboat/intake` waterfall (the kernel extension `agent-loop-intake`) the
 * service runs it on the turn's human message. A `reply` verdict answers the
 * turn with its text and no model request, and the reply logs the human
 * message with the verdict, cards included, on its request
 * (`source.lyteboatRequest.intake`, `@lyteboat/request-context`), so the log
 * keeps the verdict with the words it judged. A pass is not recorded. A
 * message whose request already carries a verdict is answered as recorded,
 * without admitting it again.
 * @module @lyteboat/request-admission
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { JsonValue, LyteboatIntakeDecision, LyteboatIntakeVerdict, LyteboatStepPayload } from '@lyteboat/contracts'
import type {} from '@lyteboat/request-context'

declare module '@deepseek-ai/cordis' {
  interface Context {
    requestAdmission: RequestAdmissionService
  }
}

/** What an admission function sees of one request. */
export interface LyteboatAdmissionInput {
  agent: Agent
  /** What the person wrote. */
  text: string
  /** The request context in force: the request's own, or the session's earlier one. */
  context: { [key: string]: JsonValue }
  signal: AbortSignal
}

/** An agent's admission function. */
export interface LyteboatAdmission {
  /** Recorded as the verdict's `by`, and as the author of its reply. */
  name: string
  admit(input: LyteboatAdmissionInput): Promise<Omit<LyteboatIntakeVerdict, 'by'>>
}

class AdmissionLayer implements ScopeLayer {
  readonly entries = new AnonymousEntries<LyteboatAdmission>()

  isEmpty(): boolean {
    return this.entries.isEmpty()
  }
}

function textOf(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Host service: the admission registry and the reply at a turn's first step. */
export class RequestAdmissionService extends Service {
  // lyteboatDistro: the reply rides the kernel extension agent-loop-intake.
  static inject = ['requestContext', 'lyteboatDistro']

  private readonly layers = new ScopedLayers(() => new AdmissionLayer(), () => {})

  constructor(ctx: Context) {
    super(ctx, 'requestAdmission')
    // After `next()`: a gate registered after this one decides first, and a
    // reply it made stands; admission only runs on a step that would pass.
    ctx.on('lyteboat/intake', async (payload, next): Promise<LyteboatIntakeDecision> => {
      const decision = await next()
      if (decision.kind === 'reply' || payload.step !== 1) return decision
      const human = payload.messages.findLast(message => message.source.kind === 'user')
      if (human === undefined) return decision
      const recorded = this.ctx.requestContext.requestOf(human)?.intake
      const verdict = recorded ?? await this.admit(payload, human)
      if (verdict?.decision !== 'reply') return decision
      return {
        kind: 'reply',
        plugin: verdict.by,
        content: [{ type: 'text', text: verdict.text ?? '' }],
        ...recorded === undefined
          ? { messages: payload.messages.map(message => message === human ? this.ctx.requestContext.withIntake(message, verdict) : message) }
          : {},
      }
    })
  }

  /**
   * Register an admission function in the calling scope (an agent's standing
   * scope): the agents joined to it are admitted by it. Nearest scope wins.
   * @returns the exact disposer that withdraws it.
   */
  register(admission: LyteboatAdmission): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.entries.append(admission),
      { label: 'requestAdmission.register()', notify: false },
    )
  }

  /** The admission function one agent answers to: the nearest registered on its chain, the host's last. */
  admissionFor(agent: Agent): LyteboatAdmission | undefined {
    let nearest: LyteboatAdmission | undefined
    for (const layer of [this.layers.global, ...this.layers.chainLayers(scopeOf(agent.ctx))]) {
      for (const admission of layer.entries.values()) nearest = admission
    }
    return nearest
  }

  /** The verdict on a step's human message: the request's context in force, or the session's when it carries none. */
  private async admit(payload: LyteboatStepPayload, human: UserMessage): Promise<LyteboatIntakeVerdict | undefined> {
    const admission = this.admissionFor(payload.agent)
    if (admission === undefined) return undefined
    const context = this.ctx.requestContext.requestOf(human)?.context ?? this.ctx.requestContext.contextOf(payload.agent)
    const verdict = await admission.admit({ agent: payload.agent, text: textOf(human), context, signal: payload.signal })
    payload.signal.throwIfAborted()
    return { ...verdict, by: admission.name }
  }
}

export default RequestAdmissionService
