/**
 * The round rules for history a caller brings from an earlier conversation
 * (ported from the reference implementation's history merger): a history
 * document is an entry list, bare or under `history` / `context.history`;
 * entries are `{ role, traceId, parts: [{ type?, text }], createTime? }`; a
 * round is one user and one assistant entry sharing a trace id. Half rounds
 * (the in-flight one), empty-text rounds and malformed entries are dropped; a
 * duplicate role inside a round keeps the first; rounds sort by `createTime`
 * when every round has one, else keep input order.
 * @module @lyteboat/history-import/round-history
 */

interface HistoryMessage {
  text: string
}

export interface HistoryRound {
  traceId: string
  createTime: string | number | undefined
  user: HistoryMessage
  assistant: HistoryMessage
}

export interface HistoryParse {
  rounds: HistoryRound[]
  dropped: { malformed: number; duplicated: number; half: number; empty: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The entry list inside a history document: a bare array, or an object
 * carrying it under `history` (or `context.history`, a request envelope).
 */
export function historyEntriesOf(document: unknown): unknown {
  if (Array.isArray(document)) return document
  if (isRecord(document)) {
    if (Array.isArray(document['history'])) return document['history']
    const context = document['context']
    if (isRecord(context) && Array.isArray(context['history'])) return context['history']
  }
  return undefined
}

function partsText(entry: Record<string, unknown>): string {
  const parts = entry['parts']
  if (!Array.isArray(parts)) return ''
  const texts: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    const text = part['text']
    if (typeof text === 'string' && text.trim() !== '') texts.push(text.trim())
  }
  return texts.join('\n')
}

/**
 * Group raw history entries into complete rounds.
 * @param raw - the entry list as the caller received it.
 */
export function parseHistoryRounds(raw: unknown): HistoryParse {
  const dropped = { malformed: 0, duplicated: 0, half: 0, empty: 0 }
  if (!Array.isArray(raw)) return { rounds: [], dropped: { ...dropped, malformed: 1 } }
  const byTrace = new Map<string, { user?: Record<string, unknown>; assistant?: Record<string, unknown> }>()
  for (const entry of raw) {
    if (!isRecord(entry)) {
      dropped.malformed += 1
      continue
    }
    const role = entry['role']
    const traceId = entry['traceId']
    if ((role !== 'user' && role !== 'assistant') || traceId === undefined || traceId === null || traceId === '') {
      dropped.malformed += 1
      continue
    }
    const key = String(traceId)
    let pair = byTrace.get(key)
    if (pair === undefined) {
      pair = {}
      byTrace.set(key, pair)
    }
    if (pair[role] !== undefined) {
      dropped.duplicated += 1
      continue
    }
    pair[role] = entry
  }
  const rounds: HistoryRound[] = []
  for (const [traceId, pair] of byTrace) {
    if (pair.user === undefined || pair.assistant === undefined) {
      dropped.half += 1
      continue
    }
    const userText = partsText(pair.user)
    const assistantText = partsText(pair.assistant)
    if (userText === '' || assistantText === '') {
      dropped.empty += 1
      continue
    }
    const createTime = pair.user['createTime']
    rounds.push({
      traceId,
      createTime: typeof createTime === 'string' || typeof createTime === 'number' ? createTime : undefined,
      user: { text: userText },
      assistant: { text: assistantText },
    })
  }
  return { rounds: sortRounds(rounds), dropped }
}

function sortRounds(rounds: HistoryRound[]): HistoryRound[] {
  if (rounds.length === 0 || !rounds.every(round => round.createTime !== undefined && round.createTime !== '' && round.createTime !== 0)) return rounds
  return [...rounds].sort((left, right) => {
    const a = String(left.createTime)
    const b = String(right.createTime)
    return a < b ? -1 : a > b ? 1 : 0
  })
}
