/**
 * Keyless replay of recorded eval sessions. While a replay run lasts, an
 * `llm/stream` listener answers every model call of a session bound to its
 * case's recording, and nothing reaches a provider: a side call (its first
 * message from the aux-llm source) gets the next `plugin:lyteboat/aux-llm-call`
 * record's answer, any other call the next entry of the loop script dsh's
 * replay derives from the recording's assistant settlements. A session is
 * bound by id when its case starts, not by the order of first calls, because
 * a case whose turns never reach the loop (a request the admission answers)
 * would shift every later case onto the wrong recording. A call from an
 * unbound session, or past the end of its script, fails the call.
 * @module @lyteboat/eval-runner/eval-replay
 */

import { readFileSync } from 'node:fs'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { LYTEBOAT_AUX_LLM_CALL_RECORD, LYTEBOAT_AUX_LLM_SOURCE, lyteboatAuxLlmCallRecordSchema, type LyteboatAuxLlmCallRecord } from '@lyteboat/contracts'

interface RecordedSession {
  file: string
  loop: ReplayEntry[]
  aux: LyteboatAuxLlmCallRecord[]
  loopCalls: number
  auxCalls: number
}

/** The chunks of one text answer. */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A recorded side call as the stream that produced it. A failure other than
 * `max-tokens` replays as a stream error: its original cause (a deadline, a
 * provider error) is not in the record, and every caller treats a failure the
 * same way.
 */
function auxChunks(record: LyteboatAuxLlmCallRecord): StreamChunk[] {
  if (record.output !== undefined) return textChunks(record.output)
  if (record.failure?.reason === 'max-tokens') return [{ type: 'finish', reason: { kind: 'max-tokens' } }]
  return [{ type: 'finish', reason: { kind: 'error', failure: { message: record.failure?.message ?? 'the recorded side call failed', code: 'UNKNOWN' } } }]
}

function loopChunks(entry: ReplayEntry, file: string): StreamChunk[] {
  if (entry.kind !== 'chunks') throw new Error(`eval-runner: ${file} replays a ${entry.kind} entry, which only an override sidecar writes`)
  return entry.chunks
}

async function* replayChunks(chunks: readonly StreamChunk[], signal: AbortSignal | undefined): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    signal?.throwIfAborted()
    yield chunk
  }
}

/** The recordings of one replay run, bound to the live sessions that replay them. */
export class EvalReplay {
  private readonly bound = new Map<string, RecordedSession>()

  /**
   * Replay `file` for the live session `sessionId`.
   * @throws when the file cannot be read or is not a session dsh can replay.
   */
  bind(sessionId: string, file: string): void {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error: unknown) {
      throw new Error(`eval-runner: no recorded session at ${file}; record the case with --model real first`, { cause: error })
    }
    const events = parseSessionLog(text)
    const aux = events.flatMap((event) => {
      const record = pluginRecordOf(event)
      if (record?.type !== LYTEBOAT_AUX_LLM_CALL_RECORD) return []
      const parsed = lyteboatAuxLlmCallRecordSchema.safeParse(record.data)
      if (!parsed.success) throw new Error(`eval-runner: ${file} holds a side call record (seq ${String(record.seq)}) that is not one lyteboat writes: record the case again`, { cause: parsed.error })
      return [parsed.data]
    })
    this.bound.set(sessionId, { file, loop: deriveReplayScript(events), aux, loopCalls: 0, auxCalls: 0 })
  }

  /**
   * The `llm/stream` listener: answer a bound session's call from its recording.
   * @param options - the call.
   * @returns the recorded stream.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const recorded = options.sessionId === undefined ? undefined : this.bound.get(String(options.sessionId))
    if (recorded === undefined) {
      return (async function* () {
        yield* []
        throw new Error(`eval-runner: a model call from session ${String(options.sessionId ?? '(none)')}, which no recorded case replays`)
      })()
    }
    const first = options.messages[0]
    const side = first?.role === 'user' && first.source?.kind === LYTEBOAT_AUX_LLM_SOURCE
    const index = side ? recorded.auxCalls++ : recorded.loopCalls++
    const record = side ? recorded.aux[index] : undefined
    const entry = side ? undefined : recorded.loop[index]
    const chunks = record !== undefined ? auxChunks(record) : entry !== undefined ? loopChunks(entry, recorded.file) : undefined
    if (chunks === undefined) {
      return (async function* () {
        yield* []
        throw new Error(`eval-runner: ${recorded.file} recorded ${String(side ? recorded.aux.length : recorded.loop.length)} ${side ? 'side' : 'loop'} call(s); the replay asked for call ${String(index + 1)}. The agent now behaves differently from the recording: record the case again`)
      })()
    }
    return replayChunks(chunks, options.signal)
  }
}
