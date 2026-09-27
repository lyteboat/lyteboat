/**
 * The `lyteboatCards` projection and the envelopes it folds: a tool result
 * carries its cards on its presentation meta (`meta.lyteboat.cards`), an
 * admission reply on its human message (`source.lyteboatRequest.intake.cards`).
 * @module @lyteboat/a2ui/cards-projection
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { lyteboatCardSchema, lyteboatRequestSchema, lyteboatResultMetaSchema } from '@lyteboat/contracts'
import type { JsonValue, LyteboatCard, LyteboatResultCard, LyteboatResultMeta } from '@lyteboat/contracts'
import { isA2uiRecord } from './a2ui-record.ts'

const lyteboatCardsSchema = lyteboatCardSchema.array()

/**
 * The cards a tool result's presentation meta carries (`lyteboat.cards`).
 * @throws when the meta's `lyteboat` envelope fails its schema.
 */
function cardsOfMeta(meta: JsonValue | undefined): LyteboatResultCard[] {
  if (!isA2uiRecord(meta) || meta['lyteboat'] === undefined) return []
  return lyteboatResultMetaSchema.parse(meta['lyteboat']).cards ?? []
}

/**
 * The presentation meta that puts a tool's cards where the `lyteboatCards`
 * projection reads them (`meta.lyteboat.cards`); no cards, no envelope.
 * @param cards - the cards the tool's value carries.
 * @throws when a card fails its schema, so the call fails instead of the log keeping an envelope the projection refuses.
 */
export function cardsPresentationMeta(cards: readonly JsonValue[]): { lyteboat?: LyteboatResultMeta } {
  return cards.length === 0 ? {} : { lyteboat: lyteboatResultMetaSchema.parse({ cards }) }
}

/**
 * The cards an admission verdict recorded on a human message carries
 * (`source.lyteboatRequest.intake.cards`, the `@lyteboat/request-context`
 * contract), read from the log as data.
 * @throws when the carried request fails its schema.
 */
function cardsOfRequest(message: UserMessage): LyteboatResultCard[] {
  if (message.source.kind !== 'user') return []
  const carried = (message.source as { lyteboatRequest?: unknown }).lyteboatRequest
  if (carried === undefined) return []
  return lyteboatRequestSchema.parse(carried).intake?.cards ?? []
}

/**
 * The cards one log node prepared, each with what prepared it: an admission
 * reply's human message, or a tool result.
 * @throws naming the node when its lyteboat envelope fails its schema.
 */
export function preparedCardsOf(event: SessionEvent): LyteboatCard[] {
  try {
    if (event.type === 'user/message') return cardsOfRequest(event.data).map(card => ({ callId: event.data.id, ...card }))
    if (event.type === 'tool/result') return cardsOfMeta(event.data.meta).map(card => ({ callId: event.data.message.toolCallId, ...card }))
  } catch (error: unknown) {
    throw new Error(`${event.type} at session seq ${String(event.seq)} carries an invalid lyteboat envelope`, { cause: error })
  }
  return []
}

function appendCard(state: LyteboatCard[], card: LyteboatCard): LyteboatCard[] {
  const event = isA2uiRecord(card.payload) ? card.payload['event'] : undefined
  if (event === 'surfaceUpdate') {
    const index = state.findIndex(existing => existing.surfaceId === card.surfaceId)
    if (index >= 0) return state.map((existing, position) => position === index ? card : existing)
  }
  return [...state, card]
}

/** The `lyteboatCards` projection: every card the session prepared, in log order, a `surfaceUpdate` replacing its surface's card. */
export const lyteboatCardsProjectionDefinition = {
  key: 'lyteboatCards',
  stateSchema: lyteboatCardsSchema,
  init: (): LyteboatCard[] => [],
  apply(state: LyteboatCard[], event) {
    // A surface replacement keeps the original meta; folding it would show the card twice.
    if (event.surfaceOp !== 'append') return state
    return preparedCardsOf(event).reduce(appendCard, state)
  },
  wire: { viewSchema: lyteboatCardsSchema, view: (state: LyteboatCard[]) => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'lyteboatCards', LyteboatCard[]>
