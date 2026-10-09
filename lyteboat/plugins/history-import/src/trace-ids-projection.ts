/**
 * The `lyteboatTraceIds` projection: every trace id a session already holds,
 * so history a caller brings again is not imported twice. A human message
 * gives its request's trace id (`source.lyteboatRequest.traceId`), an imported
 * round's question its own (`source.traceId`). Only appended surface nodes are
 * folded. A request that fails its schema counts as absent here: its owner
 * (request-context) refuses it.
 * @module @lyteboat/history-import/trace-ids-projection
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { LYTEBOAT_HISTORY_IMPORT_SOURCE, lyteboatRequestSchema, lyteboatTraceIdsStateSchema } from '@lyteboat/contracts'
import type { LyteboatTraceIdsState } from '@lyteboat/contracts'

/**
 * The trace id a user message's source carries: an imported round's, or its request's.
 * @param source - a user message's source.
 */
export function traceIdOf(source: MessageSource): string | undefined {
  if (source.kind === LYTEBOAT_HISTORY_IMPORT_SOURCE) return source.traceId
  if (source.kind !== 'user') return undefined
  // The request rides beside `kind: 'user'` as data.
  const parsed = lyteboatRequestSchema.safeParse((source as { lyteboatRequest?: unknown }).lyteboatRequest)
  return parsed.success ? parsed.data.traceId : undefined
}

export const lyteboatTraceIdsProjectionDefinition = {
  key: 'lyteboatTraceIds',
  stateSchema: lyteboatTraceIdsStateSchema,
  init: (): LyteboatTraceIdsState => ({ traceIds: [] }),
  apply(state: LyteboatTraceIdsState, event) {
    // A surface replacement (compaction, pruning) repeats what was folded when it was appended.
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return state
    const traceId = traceIdOf(event.data.source)
    if (traceId === undefined || state.traceIds.includes(traceId)) return state
    return { traceIds: [...state.traceIds, traceId] }
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'lyteboatTraceIds', LyteboatTraceIdsState>
