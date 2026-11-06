/**
 * The `lyteboatState` projection: the session's accumulated tool state, folded
 * from the `stateDelta` a successful `tool/result` carries on
 * `meta.lyteboat.stateDelta`. A delta is a JSON object whose top-level keys are
 * dot paths (`assets.total`); each path is assigned into the state, nested
 * plain objects deep-merge (the reference `apply_state_delta` overwrites the leaf
 * instead; lyteboat keeps sibling fields a partial refresh did not mention),
 * every other value replaces. The fold is immutable and returns the same
 * reference when nothing changed.
 * @module @lyteboat/tool-policy/state
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { lyteboatResultMetaSchema, lyteboatStateValueSchema } from '@lyteboat/contracts'
import type { JsonValue, LyteboatStateDelta, LyteboatStateValue } from '@lyteboat/contracts'

/** Whether a JSON value is a plain object (the only shape that merges). */
export function isJsonObject(value: JsonValue | undefined): value is LyteboatStateValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-merge two plain objects without splitting keys; returns `target` when nothing changed. */
function deepMerge(target: LyteboatStateValue, source: LyteboatStateValue): LyteboatStateValue {
  let next = target
  for (const [key, value] of Object.entries(source)) {
    const current = next[key]
    const replacement = isJsonObject(value) && isJsonObject(current) ? deepMerge(current, value) : value
    if (Object.is(replacement, current)) continue
    next = { ...next, [key]: replacement }
  }
  return next
}

function assignPath(target: LyteboatStateValue, path: readonly string[], value: JsonValue): LyteboatStateValue {
  const [head, ...rest] = path
  /* v8 ignore next -- mergeStateDelta rejects an empty path before descending */
  if (head === undefined) throw new Error('state delta path must not be empty')
  const current = target[head]
  let replacement: JsonValue
  if (rest.length > 0) replacement = assignPath(isJsonObject(current) ? current : {}, rest, value)
  else if (isJsonObject(value) && isJsonObject(current)) replacement = deepMerge(current, value)
  else replacement = value
  if (Object.is(replacement, current)) return target
  return { ...target, [head]: replacement }
}

/**
 * Fold one delta into the state.
 * @param state - the state before the delta.
 * @param delta - a JSON object keyed by dot paths.
 * @returns the next state, or `state` itself when the delta changed nothing.
 */
export function mergeStateDelta(state: LyteboatStateValue, delta: JsonValue): LyteboatStateValue {
  if (!isJsonObject(delta)) throw new Error('state delta must be a JSON object keyed by dot paths')
  let next = state
  for (const [path, value] of Object.entries(delta)) {
    const segments = path.split('.')
    if (segments.some(segment => segment === '')) throw new Error(`state delta path ${JSON.stringify(path)} has an empty segment`)
    next = assignPath(next, segments, value)
  }
  return next
}

/**
 * The delta a result's presentation meta carries under `lyteboat.stateDelta`.
 * @param meta - a tool result's presentation meta.
 * @returns the delta; undefined when the meta carries no `lyteboat` envelope or it has no delta.
 * @throws when the `lyteboat` envelope fails its schema.
 */
function stateDeltaOfMeta(meta: JsonValue | undefined): LyteboatStateDelta | undefined {
  if (!isJsonObject(meta) || meta['lyteboat'] === undefined) return undefined
  return lyteboatResultMetaSchema.parse(meta['lyteboat']).stateDelta
}

export const lyteboatStateProjectionDefinition = {
  key: 'lyteboatState',
  stateSchema: lyteboatStateValueSchema,
  init: (): LyteboatStateValue => ({}),
  apply(state: LyteboatStateValue, event) {
    // dsh computes no presentation meta for a PTC sub-dispatch (a tool the
    // `run_code` SDK calls, `exec.parent` set), so only model-direct calls carry
    // a delta; an errored result carries no delta worth folding.
    // A surface replacement (compaction pruning, an agent shortening an old
    // result) must keep the original meta, so folding it would apply an old delta
    // over newer state: only the appended result counts.
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return state
    if (event.data.message.isError === true) return state
    try {
      const delta = stateDeltaOfMeta(event.data.meta)
      return delta === undefined ? state : mergeStateDelta(state, delta)
    } catch (error: unknown) {
      throw new Error(`tool result at session seq ${String(event.seq)} carries an invalid meta.lyteboat`, { cause: error })
    }
  },
  wire: { viewSchema: lyteboatStateValueSchema, view: (state: LyteboatStateValue) => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'lyteboatState', LyteboatStateValue>

/** The model-facing rendering of the current state; empty when there is none. */
export function renderLyteboatState(state: LyteboatStateValue): string {
  if (Object.keys(state).length === 0) return ''
  return `Session state, accumulated from tool results (JSON):\n${JSON.stringify(state)}`
}
