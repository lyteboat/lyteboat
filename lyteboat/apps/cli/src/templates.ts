/**
 * lyteboat's shipped profile templates. A profile directory under
 * `$LYTEBOAT_HOME/profiles/<name>` is initialized from its template on first use;
 * dsh's `loadProfile` only knows dsh's own shipped names, so lyteboat initializes
 * these itself before handing the directory over. Whether the user layers
 * reload live is the composition's call: dsh-base's `hmr` row reloads them,
 * and `@lyteboat/try`, `@lyteboat/serve`, `@lyteboat/eval`, `@lyteboat/studio`, and `@lyteboat/inspect` disable it.
 * @module @lyteboat/cli/templates
 */

/** One lyteboat profile template: the ordered bundle layers. */
interface LyteboatProfileTemplate {
  bundles: readonly string[]
}

/** Templates by profile name. */
export const LYTEBOAT_PROFILE_TEMPLATES: Readonly<Record<string, LyteboatProfileTemplate>> = {
  try: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/try'],
  },
  serve: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/serve'],
  },
  eval: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/eval'],
  },
  studio: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/studio'],
  },
  inspect: {
    bundles: ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/inspect'],
  },
}

/** The profile `lyteboat try` boots when `--profile` is absent. */
export const DEFAULT_TRY_PROFILE = 'try'

/** The profile `lyteboat serve` boots when `--profile` is absent. */
export const DEFAULT_SERVE_PROFILE = 'serve'

/** The profile `lyteboat eval` boots when `--profile` is absent. */
export const DEFAULT_EVAL_PROFILE = 'eval'

/** The profile `lyteboat studio` boots when `--profile` is absent. */
export const DEFAULT_STUDIO_PROFILE = 'studio'

/** The profile `lyteboat inspect` boots when `--profile` is absent. */
export const DEFAULT_INSPECT_PROFILE = 'inspect'
