/**
 * The request a human message's source carries, read back against the
 * contract's schema, and the `lyteboatRequest` projection that folds the
 * session's context, latest verdict, and owner from it: a request that carries
 * no context keeps the earlier one, and the first owner named stays.
 * @module @lyteboat/request-context/request-projection
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { lyteboatRequestSchema, lyteboatRequestStateSchema } from '@lyteboat/contracts'
import type { LyteboatRequest, LyteboatRequestState } from '@lyteboat/contracts'

/**
 * The request a message source carries. The field sits beside `kind: 'user'`
 * (dsh's human-input kind), so it is read as data and validated against the
 * contract's schema; a2ui reads the admission's cards from the same field.
 * @param source - a user message's source.
 * @returns the request; undefined when the source carries none.
 * @throws when the carried request fails its schema.
 */
export function lyteboatRequestOf(source: MessageSource): LyteboatRequest | undefined {
  if (source.kind !== 'user') return undefined
  const carried = (source as { lyteboatRequest?: unknown }).lyteboatRequest
  if (carried === undefined) return undefined
  return lyteboatRequestSchema.parse(carried)
}

export const lyteboatRequestProjectionDefinition = {
  key: 'lyteboatRequest',
  stateSchema: lyteboatRequestStateSchema,
  init: (): LyteboatRequestState => ({ requests: 0, context: {}, intake: null, owner: null }),
  apply(state: LyteboatRequestState, event) {
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return state
    let request: LyteboatRequest | undefined
    try {
      request = lyteboatRequestOf(event.data.source)
    } catch (error: unknown) {
      throw new Error(`human message at session seq ${String(event.seq)} carries an invalid source.lyteboatRequest`, { cause: error })
    }
    if (request === undefined) return state
    return { requests: state.requests + 1, context: request.context ?? state.context, intake: request.intake ?? null, owner: state.owner ?? request.owner ?? null }
  },
  wire: { viewSchema: lyteboatRequestStateSchema, view: (state: LyteboatRequestState) => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'lyteboatRequest', LyteboatRequestState>
