import { fileURLToPath } from 'node:url'
import { LYTEBOAT_HEADLESS_AGENT_BUNDLES, bootComposition, type CompositionRun, type PatchOptions } from '@lyteboat/testing/composition'

/** This package's test fixtures: agent directories, plugin files, history files. */
export const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url))

/** Where a run happens and what it talks to. */
export interface RunTarget {
  cwd: string
  home: string
  env: Record<string, string>
}

/**
 * Boot dsh-base + dsh-headless + @lyteboat/base + @lyteboat/headless in process with
 * `args` as the one-shot app's arguments, as `lyteboat headless <args>` would with an agent.
 * @param args - the arguments after `lyteboat headless`.
 * @param target - working directory, harness home, and environment.
 * @param patches - layers above the bundles (plugin-file rows).
 * @returns the exit code and captured output.
 */
export function headlessComposition(args: readonly string[], target: RunTarget, patches: readonly PatchOptions[] = []): Promise<CompositionRun> {
  return bootComposition({ bundles: LYTEBOAT_HEADLESS_AGENT_BUNDLES, args, cwd: target.cwd, home: target.home, env: target.env, patches })
}
