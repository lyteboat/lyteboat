/**
 * Boot a composition in the test process, the way the `lyteboat` launcher boots a
 * profile: bundle patch layers in order, then extra layers, over an empty root,
 * with the invocation's inner arguments on `ctx.cmdlineArgs`. A bundle's or an
 * agent's composition test runs its real rows (loaded from `lib/`, so build
 * first) without spawning the launcher and without depending on an app.
 *
 * A bundle the test asks for that the profile skips (unresolvable, or refused
 * by its dsh peers) fails the boot with the profile's reason; other skipped
 * bundles are reported as the launcher reports them.
 *
 * A one-shot composition runs until the tree requests exit
 * ({@link bootComposition}); a service runs until the test stops it
 * ({@link startComposition}), and the test talks to it meanwhile.
 *
 * One composition runs at a time per process: it sets `DSH_HOME`, the given
 * environment, and the working directory, captures stdout and stderr, and
 * restores all of them when the run settles. vitest's default `forks` pool
 * gives every test file its own process.
 * @module @lyteboat/testing/composition
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, initProfile, loadLayeredEnv, loadProfile, reportSkippedBundles, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { LYTEBOAT_MODE_RUNNER_IDS } from '@lyteboat/contracts/cli'

/** The diagnostic prefix dsh-app-boot puts on its errors; the launcher's own. */
const BIN_NAME = 'lyteboat'

/** The profile directory name compositions boot from, under their own home. */
const PROFILE = 'composition'

/**
 * The workspace root manifest. Bare row names resolve from here, where every
 * `@deepseek-ai/*` and `@lyteboat/*` package is hoisted; resolving from the profile
 * directory instead finds nothing under vitest, whose entry script lives in the store.
 */
const WORKSPACE_ANCHOR = fileURLToPath(new URL('../../../../package.json', import.meta.url))

/** lyteboat's mode runner rows; the launcher fails a startup that leaves one inactive (@lyteboat/cli mode-runners.ts). */
const MODE_RUNNER_IDS = new Set<string>(LYTEBOAT_MODE_RUNNER_IDS)

/** Cordis's active fiber state, spelled out: the const enum does not survive vitest's transform (@lyteboat/cli fiber-state.ts). */
const FIBER_ACTIVE = 2 as FiberState.ACTIVE

/** The launcher's mode runner check, mirrored: the harness cannot import the launcher. */
function inactiveModeRunner(ctx: Context): string | undefined {
  for (const entry of ctx.loader.entries()) {
    if (!MODE_RUNNER_IDS.has(entry.options.id) || entry.disabled) continue
    if (entry.fiber?.state !== FIBER_ACTIVE) return entry.options.id
  }
  return undefined
}

/** The launcher disables telemetry export when `DSH_TELEMETRY_DISABLED` is set, as tests do. */
const QUIET: readonly PatchOptions[] = [{ id: 'session-telemetry-otel', disabled: true }]

/** The `try` profile's bundle layers, in the order the launcher's profile template lists them. */
export const LYTEBOAT_TRY_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/try']

/** The `serve` profile's bundle layers, in the order the launcher's profile template lists them. */
export const LYTEBOAT_SERVE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/serve']

/** The `eval` profile's bundle layers, in the order the launcher's profile template lists them. */
export const LYTEBOAT_EVAL_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/eval']

/** The `web` profile's bundle layers, in the order the launcher's profile template lists them. */
export const LYTEBOAT_WEB_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@lyteboat/host', '@deepseek-ai/dsh-web-app', '@lyteboat/web']

/** The `studio` profile's bundle layers, in the order the launcher's profile template lists them. */
export const LYTEBOAT_STUDIO_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/studio']

/** The `inspect` profile's bundle layers, in the order the launcher's profile template lists them. */
export const LYTEBOAT_INSPECT_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@lyteboat/host', '@lyteboat/business-base', '@lyteboat/inspect']

/** What to boot and how. */
export interface CompositionOptions {
  /** Bundle packages in layer order, e.g. {@link LYTEBOAT_TRY_BUNDLES}. */
  bundles: readonly string[]
  /** Layers above the bundles: row overrides and inserted rows (see {@link pluginFileRow}). */
  patches?: readonly PatchOptions[]
  /** The inner arguments, as they would follow `lyteboat try` on a command line. */
  args: readonly string[]
  /** The working directory the tree sees. */
  cwd: string
  /** Environment set for the run (model endpoint and key); restored afterwards. */
  env: Readonly<Record<string, string>>
  /** The harness home (`DSH_HOME`); a fresh temporary directory when absent. */
  home?: string
  /** Give up after this long without an exit request. */
  timeoutMs?: number
}

/** How one composition run ended. */
export interface CompositionRun {
  /** The code the tree requested through `ctx.appExit`, or 1 when boot failed. */
  code: number
  /** The harness home the run wrote its sessions under. */
  home: string
  stdout: string
  stderr: string
}

export type { PatchOptions }

/**
 * The row the launcher's `--plugin <file>` inserts.
 * @param file - an ESM plugin file.
 * @returns an insert patch naming the file by URL.
 */
export function pluginFileRow(file: string): PatchOptions {
  const absolute = resolve(file)
  return { insert: [{ id: `plugin:${absolute}`, name: pathToFileURL(absolute).href }] }
}

/**
 * The session id a `lyteboat try` composition prints to stderr (`lyteboat: session <id>`).
 * @param stderr - the run's captured stderr.
 * @returns the id.
 * @throws when the run printed no id; the message carries the stderr.
 */
export function printedSessionId(stderr: string): string {
  const id = /^lyteboat: session (\S+)$/mu.exec(stderr)?.[1]
  if (id === undefined) throw new Error(`no "lyteboat: session <id>" line in stderr:\n${stderr}`)
  return id
}

interface Capture {
  stdout: string
  stderr: string
  /** Called after every stdout write. */
  readonly written: Set<() => void>
  restore(): void
}

function capture(): Capture {
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  const state: Capture = {
    stdout: '',
    stderr: '',
    written: new Set(),
    restore: () => {
      process.stdout.write = out
      process.stderr.write = err
    },
  }
  process.stdout.write = ((chunk: string | Uint8Array) => {
    state.stdout += String(chunk)
    for (const listener of [...state.written]) listener()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { state.stderr += String(chunk); return true }) as typeof process.stderr.write
  return state
}

function applyEnvironment(env: Readonly<Record<string, string>>): () => void {
  const saved = new Map(Object.keys(env).map(key => [key, process.env[key]] as const))
  Object.assign(process.env, env)
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function readiness(): { service: AppReady; commit(): void } {
  const listeners = new Set<() => void>()
  let ready = false
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

function composedPatches(home: string, options: CompositionOptions): { root: string; patches: PatchOptions[] } {
  const dir = resolveProfileDir(PROFILE, home)
  initProfile(dir, options.bundles)
  const profile = loadProfile(BIN_NAME, PROFILE, WORKSPACE_ANCHOR, home)
  // A skipped bundle the test asked for would let the test pass without the composition under test.
  const requested = profile.skippedBundles.filter(skipped => options.bundles.includes(skipped.packageName))
  reportSkippedBundles(BIN_NAME, { skippedBundles: profile.skippedBundles.filter(skipped => !requested.includes(skipped)) })
  if (requested.length > 0) {
    throw new Error(`bootComposition: the profile skipped requested bundles: ${requested.map(({ packageName, reason }) => `${packageName} (${reason})`).join('; ')}`)
  }
  const root = join(dir, 'cordis.yml')
  writeFileSync(root, '[]\n')
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...QUIET, ...options.patches ?? []]
  return { root, patches: structuredClone(patches) }
}

/** A composition that runs until the tree requests exit or the test stops it. */
export interface RunningComposition {
  /** The harness home the run writes its sessions under. */
  readonly home: string
  /** Settles with the code of the first exit request. */
  readonly exited: Promise<number>
  /** What the tree has printed so far. */
  stdout(): string
  stderr(): string
  /** Resolve once the printed stdout matches; reject if the tree requests exit first. */
  waitForStdout(pattern: RegExp, timeoutMs?: number): Promise<RegExpExecArray>
  /** Request exit 0 unless the tree already requested one, dispose the tree, and restore the process. */
  stop(): Promise<CompositionRun>
}

/**
 * Boot one composition and return while it runs.
 * @param options - bundles, extra layers, arguments, working directory, and environment.
 * @returns the running composition; `timeoutMs` bounds its life, after which it exits with 1.
 * @throws when the profile skipped a bundle in `options.bundles`.
 */
export function startComposition(options: CompositionOptions): RunningComposition {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'lyteboat-composition-'))
  const restoreEnv = applyEnvironment({ ...options.env, DSH_HOME: home })
  const cwd = process.cwd()
  process.chdir(options.cwd)
  const output = capture()
  let host: Context | undefined
  let requested: number | undefined
  let settle!: (code: number) => void
  const exited = new Promise<number>(resolveExit => { settle = resolveExit })
  const exit = (code: number): void => {
    requested ??= code
    settle(code)
    for (const listener of [...output.written]) listener()
    void host?.fiber.dispose()
  }
  const timer = setTimeout(() => { output.stderr += `bootComposition: no exit request within ${String(options.timeoutMs ?? 90_000)}ms\n`; exit(1) }, options.timeoutMs ?? 90_000)
  const restore = (): void => {
    clearTimeout(timer)
    output.restore()
    process.chdir(cwd)
    restoreEnv()
  }
  let booted: Promise<Context>
  try {
    const { root, patches } = composedPatches(home, options)
    const ready = readiness()
    booted = boot(BIN_NAME, root, patches, (hostCtx) => {
      host = hostCtx
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv(BIN_NAME, options.cwd))
      provideCmdline(hostCtx, { args: options.args, exit, ready: ready.service })
    }, pathToFileURL(WORKSPACE_ANCHOR).href)
    booted.then((ctx) => {
      if (requested !== undefined) return
      const inactiveRunner = inactiveModeRunner(ctx)
      if (inactiveRunner === undefined) {
        ready.commit()
        return
      }
      output.stderr += `${BIN_NAME}: startup failed: ${inactiveRunner} did not activate (the entries above say why)\n`
      exit(1)
    }, (error: unknown) => {
      if (requested !== undefined) return
      output.stderr += `${error instanceof Error ? error.message : String(error)}\n`
      exit(1)
    })
  } catch (error: unknown) {
    restore()
    throw error
  }
  let stopped: Promise<CompositionRun> | undefined
  return {
    home,
    exited,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
    waitForStdout(pattern, timeoutMs = 60_000) {
      return new Promise((resolveMatch, reject) => {
        const wait = setTimeout(() => { done(); reject(new Error(`timed out waiting for ${String(pattern)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)) }, timeoutMs)
        const check = (): void => {
          const match = pattern.exec(output.stdout)
          if (match !== null) { done(); resolveMatch(match); return }
          if (requested !== undefined) { done(); reject(new Error(`the composition requested exit ${String(requested)} before ${String(pattern)}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)) }
        }
        const done = (): void => { clearTimeout(wait); output.written.delete(check) }
        output.written.add(check)
        check()
      })
    },
    stop() {
      stopped ??= (async () => {
        exit(0)
        try {
          const code = await exited
          await booted.catch(() => undefined)
          await host?.fiber.dispose()
          return { code, home, stdout: output.stdout, stderr: output.stderr }
        } finally {
          restore()
        }
      })()
      return stopped
    },
  }
}

/**
 * Boot one composition, wait for the tree to request exit, and dispose it.
 * @param options - bundles, extra layers, arguments, working directory, and environment.
 * @returns the exit code, the harness home, and the captured output.
 * @throws when the profile skipped a bundle in `options.bundles`.
 */
export async function bootComposition(options: CompositionOptions): Promise<CompositionRun> {
  const running = startComposition(options)
  await running.exited
  return running.stop()
}
