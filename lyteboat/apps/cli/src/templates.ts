/**
 * lyteboat's shipped profile templates, one per base. The native profiles are
 * dsh's own templates, taken from dsh rather than copied, so they stay dsh's
 * layer for layer across syncs. The business profiles list the business base
 * after dsh-base and the mode's bundle last. A profile directory under
 * `$LYTEBOAT_HOME/profiles/<name>` is initialized from its template on first use;
 * dsh's `loadProfile` only knows dsh's own shipped names, so lyteboat initializes
 * these itself before handing the directory over. Whether the user layers
 * reload live is the composition's call: dsh-base's `hmr` row reloads them,
 * and dsh-headless, `@lyteboat/serve`, `@lyteboat/eval`, `@lyteboat/studio`, and `@lyteboat/inspect` disable it.
 * @module @lyteboat/cli/templates
 */

import { PROFILE_TEMPLATES as DSH_PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

/** One lyteboat profile template: the ordered bundle layers. */
interface LyteboatProfileTemplate {
  bundles: readonly string[]
}

/**
 * dsh's own template of `name`, for a native profile.
 * @param name - a profile name dsh ships.
 * @returns dsh's template, unchanged.
 * @throws when this dsh release ships no such template, so a sync that drops one fails at load.
 */
function dshProfileTemplate(name: string): LyteboatProfileTemplate {
  const template = DSH_PROFILE_TEMPLATES[name]
  if (template === undefined) throw new Error(`lyteboat: dsh ships no "${name}" profile template`)
  return template
}

/** Templates by profile name. */
export const LYTEBOAT_PROFILE_TEMPLATES: Readonly<Record<string, LyteboatProfileTemplate>> = {
  // The native base: dsh's apps on lyteboat's kernel.
  web: dshProfileTemplate('web'),
  headless: dshProfileTemplate('headless'),
  // The business base. The one-shot is dsh's, so its bundle comes before the base.
  'headless-agent': {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@lyteboat/base', '@lyteboat/headless'],
  },
  serve: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/base', '@lyteboat/serve'],
  },
  eval: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/base', '@lyteboat/eval'],
  },
  studio: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/base', '@lyteboat/studio'],
  },
  inspect: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/base', '@lyteboat/inspect'],
  },
}

/** The profile `lyteboat web` boots when `--profile` is absent. */
export const DEFAULT_WEB_PROFILE = 'web'

/** The profile `lyteboat headless` boots when `--profile` is absent. */
export const DEFAULT_HEADLESS_PROFILE = 'headless'

/** The profile `lyteboat headless` boots when its inner arguments name an agent and `--profile` is absent. */
export const DEFAULT_HEADLESS_AGENT_PROFILE = 'headless-agent'

/** The profile `lyteboat serve` boots when `--profile` is absent. */
export const DEFAULT_SERVE_PROFILE = 'serve'

/** The profile `lyteboat eval` boots when `--profile` is absent. */
export const DEFAULT_EVAL_PROFILE = 'eval'

/** The profile `lyteboat studio` boots when `--profile` is absent. */
export const DEFAULT_STUDIO_PROFILE = 'studio'

/** The profile `lyteboat inspect` boots when `--profile` is absent. */
export const DEFAULT_INSPECT_PROFILE = 'inspect'
