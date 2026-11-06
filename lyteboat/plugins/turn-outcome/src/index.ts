/**
 * @lyteboat/turn-outcome — how each turn ended, folded once from the session
 * log for every reader. The plugin registers the `lyteboatTurnOutcomes`
 * projection (host-only: each turn's request, counts, tool calls, and outcome
 * kind; see `turn-outcome-projection.ts`) and publishes `ctx.turnOutcome`,
 * which reads it: a session's turns, one turn, the turn that answers a
 * request, a promise of that turn's end, that turn's events as they are
 * committed, and the same fold over a stored log for a reader that holds no
 * live session. The chat API, the eval runner, the
 * turn-metrics recorder, and the session index read outcomes here and compute
 * none of their own.
 * @module @lyteboat/turn-outcome
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { LyteboatTurnOutcome, LyteboatTurnOutcomesState } from '@lyteboat/contracts'
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

  private outcomesHandle!: ProjectionHandle<LyteboatTurnOutcomesState>

  constructor(ctx: Context) {
    super(ctx, 'turnOutcome')
  }

  async [Service.init](): Promise<void> {
    this.outcomesHandle = await this.ctx.sessionProjections.register(lyteboatTurnOutcomesProjectionDefinition)
  }

  /** The session's turns in log order, the running one last without `toSeq`. */
  of(session: Session): readonly LyteboatTurnOutcome[] {
    return this.outcomesHandle.stateOf(session).turns
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
   * Hear the events of the turn that answers a request as they are committed,
   * from its `turn/start` through its `turn/end`. The turn is known only once
   * its first human message is logged, so the events since the latest
   * `turn/start` are held until then and delivered first. Call it before the
   * request is sent; a turn that started earlier is not heard.
   * @param session - the session the request goes to.
   * @param requestId - the request id its human message carries.
   * @param listener - called with each of the turn's events, in log order, and the turn's number.
   * @returns the disposer that stops listening; listening also stops after the turn's `turn/end`.
   */
  follow(session: Session, requestId: string, listener: (event: SessionEvent, turn: number) => void): () => void {
    let held: SessionEvent[] = []
    let turn: number | undefined
    const dispose = this.ctx.on('session/event', (subject: Session, event: SessionEvent) => {
      if (subject !== session) return
      if (turn === undefined) {
        if (event.type === 'turn/start') held = []
        held.push(event)
        const ours = this.forRequest(session, requestId)
        if (ours === undefined) return
        turn = ours.turn
        for (const earlier of held) if (earlier.seq >= ours.fromSeq) listener(earlier, ours.turn)
        held = []
        return
      }
      listener(event, turn)
      if (event.type === 'turn/end' && event.data.turn === turn) dispose()
    })
    return dispose
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
