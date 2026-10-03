/**
 * @lyteboat/turn-outcome — how each turn ended, folded once from the session
 * log for every reader. The plugin registers the `lyteboatTurnOutcomes`
 * projection (host-only: each turn's request, counts, tool calls, and outcome
 * kind; see `turn-outcome-projection.ts`) and publishes `ctx.turnOutcome`,
 * which reads it: a session's turns, one turn, the turn that answers a
 * request, a promise of that turn's end, and the same fold over a stored log
 * for a reader that holds no live session. The chat API, the eval runner, the
 * turn-metrics recorder, and the session index read outcomes here and compute
 * none of their own.
 * @module @lyteboat/turn-outcome
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { LyteboatTurnOutcome } from '@lyteboat/contracts'
import { foldTurnOutcomes, lyteboatTurnOutcomesProjectionDefinition } from './turn-outcome-projection.ts'

export { foldTurnOutcomes } from './turn-outcome-projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    turnOutcome: TurnOutcomeService
  }
}

/** Host service: the turns of a session as `lyteboatTurnOutcomes` folds them. */
export class TurnOutcomeService extends Service {
  static inject = ['sessionProjections']

  constructor(ctx: Context) {
    super(ctx, 'turnOutcome')
    ctx.sessionProjections.register(lyteboatTurnOutcomesProjectionDefinition)
  }

  /** The session's turns in log order, the running one last without `toSeq`. */
  of(session: Session): readonly LyteboatTurnOutcome[] {
    return this.ctx.sessionProjections.stateOf(session, 'lyteboatTurnOutcomes')?.turns ?? []
  }

  /** The turn with this number. */
  turn(session: Session, turn: number): LyteboatTurnOutcome | undefined {
    return this.of(session).findLast(candidate => candidate.turn === turn)
  }

  /** The latest turn whose first human message carries this request id. */
  forRequest(session: Session, requestId: string): LyteboatTurnOutcome | undefined {
    return this.of(session).findLast(candidate => candidate.request?.requestId === requestId)
  }

  /**
   * The turn that answers a request, once it has ended. A turn that already
   * ended resolves at once, so it may be called after the request was sent.
   * @param session - the session the request went to.
   * @param requestId - the request id its human message carries.
   * @param signal - stops waiting; the promise then rejects with its reason.
   */
  async ended(session: Session, requestId: string, signal: AbortSignal): Promise<LyteboatTurnOutcome> {
    const endedTurn = (): LyteboatTurnOutcome | undefined => {
      const turn = this.forRequest(session, requestId)
      return turn?.toSeq === undefined ? undefined : turn
    }
    const already = endedTurn()
    if (already !== undefined) return already
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const stop = (): void => {
        disposeEvents()
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        stop()
        reject(signal.reason)
      }
      const disposeEvents = this.ctx.on('session/event', (subject: Session, event: SessionEvent) => {
        if (subject !== session || event.type !== 'turn/end') return
        const turn = endedTurn()
        if (turn === undefined) return
        stop()
        resolve(turn)
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * The turns of a stored log, folded as the projection folds a live one.
   * @param inheritedEventCount - how many leading events are inherited (imported history).
   * @param events - the log from seq 0.
   */
  fold(inheritedEventCount: number, events: readonly SessionEvent[]): LyteboatTurnOutcome[] {
    return foldTurnOutcomes(inheritedEventCount, events)
  }
}

export default TurnOutcomeService
