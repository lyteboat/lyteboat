/**
 * @lyteboat/history-import — external conversation history in a session.
 * dsh derives every model request from the log, so history a caller brings
 * (a list of entries grouped into rounds by trace id) has to become log nodes.
 * This service parses it with the reference round rules and queues each round
 * the session does not hold yet as a turn of its own: the round's question is
 * followed up to the agent, its answer riding the queued message's source,
 * and at that turn's first step the service answers it on the
 * `lyteboat/intake` waterfall (the kernel extension `agent-loop-intake`) with
 * the recorded answer and no model request. The log then holds the question
 * (source `plugin:lyteboat-history-import` with its trace id, the answer
 * removed) and the answer (provider `lyteboat`, model `history-import`). A
 * round is known by its trace id alone: the `lyteboatTraceIds` projection
 * keeps those of the session's requests and imported rounds, and the inbox
 * those still queued.
 * @module @lyteboat/history-import
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { LYTEBOAT_HISTORY_IMPORT_SOURCE } from '@lyteboat/contracts'
import type { LyteboatIntakeDecision, LyteboatStepPayload } from '@lyteboat/contracts'
import { parseHistoryRounds } from './round-history.ts'
import type { HistoryRound } from './round-history.ts'
import { lyteboatTraceIdsProjectionDefinition, traceIdOf } from './trace-ids-projection.ts'

export type { HistoryRound } from './round-history.ts'

/** The model recorded on an imported round's answer. */
const HISTORY_IMPORT_MODEL = 'history-import'

declare module '@deepseek-ai/cordis' {
  interface Context {
    historyImport: HistoryImportService
  }
}

/** Host service: parse history, queue the rounds a session lacks, and answer them. */
export class HistoryImportService extends Service {
  // lyteboatDistro: the answer rides the kernel extension agent-loop-intake.
  static inject = ['sessionProjections', 'lyteboatDistro']

  constructor(ctx: Context) {
    super(ctx, 'historyImport')
    ctx.sessionProjections.register(lyteboatTraceIdsProjectionDefinition)
    // After `next()`: an imported round's answer is the caller's record, so it
    // stands whatever an inner listener decided; the other listeners still run.
    ctx.on('lyteboat/intake', async (payload, next) => answerImportedRound(payload, await next()))
  }

  /**
   * Group a request's history entries into rounds; logs what was dropped.
   * @param entries - the entry list as the caller sent it.
   */
  parse(entries: unknown): HistoryRound[] {
    const parsed = parseHistoryRounds(entries)
    const { malformed, duplicated, half, empty } = parsed.dropped
    if (malformed + duplicated + half + empty > 0) {
      this.ctx.logger.warn(`history import: request history dropped ${String(malformed)} malformed, ${String(duplicated)} duplicate-role, ${String(half)} half, ${String(empty)} empty round(s)`)
    }
    return parsed.rounds
  }

  /**
   * Queue every round the agent's session does not hold yet, in order, each
   * as a turn of its own ahead of whatever is queued after this call. A round
   * is skipped when its trace id is already in the session (a request's or an
   * imported round's), still queued, or earlier in the same list.
   * @param agent - the agent whose session takes the history.
   * @param rounds - complete rounds, already ordered.
   * @returns the rounds it queued.
   */
  enqueue(agent: Agent, rounds: readonly HistoryRound[]): HistoryRound[] {
    const known = new Set(this.ctx.sessionProjections.stateOf(agent.session, 'lyteboatTraceIds')?.traceIds)
    for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      const traceId = traceIdOf(message.source)
      if (traceId !== undefined) known.add(traceId)
    }
    const queued: HistoryRound[] = []
    for (const round of rounds) {
      if (known.has(round.traceId)) continue
      known.add(round.traceId)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: round.user.text }],
        source: { kind: LYTEBOAT_HISTORY_IMPORT_SOURCE, traceId: round.traceId, answer: round.assistant.text },
      }))
      queued.push(round)
    }
    return queued
  }
}

type ImportedQuestion = UserMessage & { source: Extract<MessageSource, { kind: typeof LYTEBOAT_HISTORY_IMPORT_SOURCE }> }

function isImportedQuestion(message: UserMessage): message is ImportedQuestion {
  return message.source.kind === LYTEBOAT_HISTORY_IMPORT_SOURCE
}

/**
 * The decision for a step that claimed an imported round: its recorded
 * answer, the question logged without it. A step that claimed none keeps the
 * decision it had.
 * @throws when the round was claimed with other messages, after a turn's first step, or without its answer.
 */
function answerImportedRound(payload: LyteboatStepPayload, decision: LyteboatIntakeDecision): LyteboatIntakeDecision {
  const questions = payload.messages.filter(isImportedQuestion)
  const [question] = questions
  if (question === undefined) return decision
  const traceIds = questions.map(message => message.source.traceId ?? '(none)').join(', ')
  if (payload.messages.length > 1 || payload.step !== 1) {
    throw new Error(`history import: round ${traceIds} was claimed at step ${String(payload.step)} with ${String(payload.messages.length - 1)} other message(s); an imported round is a turn of its own`)
  }
  const { answer, ...source } = question.source
  if (answer === undefined) throw new Error(`history import: round ${traceIds} carries no answer`)
  return {
    kind: 'reply',
    plugin: HISTORY_IMPORT_MODEL,
    content: [{ type: 'text', text: answer }],
    messages: [{ ...question, source }],
  }
}

export default HistoryImportService
