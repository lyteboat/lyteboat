/**
 * The deterministic checks of one turn: what the case expects against what
 * the turn showed. Each expectation present in the case is one check with
 * its expected and actual values, so a report says why a check failed.
 * @module @lyteboat/eval-runner/eval-check
 */

import { isDeepStrictEqual } from 'node:util'
import type { JsonValue, LyteboatTurnOutcomeKind } from '@lyteboat/contracts'
import type { EvalExpect } from './eval-case.ts'

/** What one turn showed, read from the session after it ended. */
export interface EvalObservation {
  /** The active skill after the turn; null: none. */
  skill: string | null
  /** The tools the model called in the turn, in call order. */
  tools: string[]
  /** The areas of the cards the turn shows, in order. */
  cards: string[]
  outcome: LyteboatTurnOutcomeKind
  /** The answer text, cards left out. */
  text: string
  /** The model calls the loop made in the turn. */
  modelRequests: number
}

/** One check and its result. */
export interface EvalCheck {
  /** The expectation's path in the case file: `tools.called`, `text.matches`, … */
  check: string
  expected: JsonValue
  actual: JsonValue
  pass: boolean
}

/**
 * Check one turn.
 * @param expect - what the case expects of the turn.
 * @param observed - what the turn showed.
 * @returns one check per expectation, in a fixed order.
 */
export function checkTurn(expect: EvalExpect, observed: EvalObservation): EvalCheck[] {
  const checks: EvalCheck[] = []
  const add = (check: string, expected: JsonValue, actual: JsonValue, pass: boolean): void => { checks.push({ check, expected, actual, pass }) }
  if (expect.skill !== undefined) add('skill', expect.skill, observed.skill, expect.skill === observed.skill)
  const { called, not_called: notCalled } = expect.tools ?? {}
  if (called !== undefined) add('tools.called', called, observed.tools, called.every(tool => observed.tools.includes(tool)))
  if (notCalled !== undefined) add('tools.not_called', notCalled, observed.tools, notCalled.every(tool => !observed.tools.includes(tool)))
  const { areas, count } = expect.cards ?? {}
  // Which cards a turn shows is the contract; where the answer places each one is the model's to choose.
  if (areas !== undefined) add('cards.areas', areas, observed.cards, isDeepStrictEqual([...areas].sort(), [...observed.cards].sort()))
  if (count !== undefined) add('cards.count', count, observed.cards.length, count === observed.cards.length)
  if (expect.outcome !== undefined) add('outcome', expect.outcome, observed.outcome, expect.outcome === observed.outcome)
  const { includes, excludes, matches } = expect.text ?? {}
  if (includes !== undefined) add('text.includes', includes, observed.text, includes.every(part => observed.text.includes(part)))
  if (excludes !== undefined) add('text.excludes', excludes, observed.text, excludes.every(part => !observed.text.includes(part)))
  if (matches !== undefined) add('text.matches', matches, observed.text, new RegExp(matches, 'u').test(observed.text))
  const requests = expect.model_requests
  if (requests !== undefined) {
    const expected = { ...requests.min === undefined ? {} : { min: requests.min }, ...requests.max === undefined ? {} : { max: requests.max } }
    add('model_requests', expected, observed.modelRequests, observed.modelRequests >= (requests.min ?? 0) && observed.modelRequests <= (requests.max ?? Infinity))
  }
  return checks
}
