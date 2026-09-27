/**
 * The rows that run a lyteboat mode (`lyteboat try`, `serve`, `eval`, `studio`, `inspect`). dsh's
 * startup audit fails startup when one of dsh's own runners does not activate
 * (its headless runner, its web server), but it knows none of lyteboat's, so a
 * mode runner left waiting on a service a failed row never provided would keep
 * the process alive with nothing to do. The launcher checks them after the
 * tree settles and fails the startup instead.
 * @module @lyteboat/cli/mode-runners
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { LYTEBOAT_MODE_RUNNER_IDS } from '@lyteboat/contracts/cli'
import { FIBER_STATE } from './fiber-state.ts'

const MODE_RUNNER_IDS = new Set<string>(LYTEBOAT_MODE_RUNNER_IDS)

/**
 * The mode runner a settled tree failed to activate.
 * @param ctx - the settled root context.
 * @returns the id of an enabled mode runner row that is not active; undefined when every one present is.
 */
export function inactiveModeRunner(ctx: Context): string | undefined {
  for (const entry of ctx.loader.entries()) {
    if (!MODE_RUNNER_IDS.has(entry.options.id) || entry.disabled) continue
    if (entry.fiber?.state !== FIBER_STATE.ACTIVE) return entry.options.id
  }
  return undefined
}
