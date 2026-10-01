/**
 * Spawn a built lyteboat launcher under plain Node and collect its output. The
 * launcher path comes from the caller, so this package never depends on an app.
 * @module @lyteboat/testkit/process
 */

import { spawn, type ChildProcess } from 'node:child_process'

export interface LyteboatRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface LyteboatSpawnOptions {
  env?: Record<string, string | undefined>
  cwd?: string
  timeoutMs?: number
  /** Written to the child's stdin, which then ends; without it stdin is empty. */
  input?: string
}

function childEnv(overrides: Record<string, string | undefined> | undefined): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...process.env, ...overrides }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/** A running lyteboat child with its accumulated output. */
export interface LyteboatChild {
  child: ChildProcess
  output(): string
  stdout(): string
  stderr(): string
  /** Resolve once a stdout line matches; reject if the process exits first. */
  waitForStdout(pattern: RegExp, timeoutMs?: number): Promise<RegExpExecArray>
  /** Send a signal and wait for exit. */
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<number | null>
  exited: Promise<number | null>
}

function startLyteboat(bin: string, args: readonly string[], options: LyteboatSpawnOptions): LyteboatChild {
  const child = spawn(process.execPath, [bin, ...args], {
    env: childEnv(options.env),
    cwd: options.cwd,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  child.stdin?.end(options.input)
  let out = ''
  let err = ''
  const listeners = new Set<() => void>()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { out += chunk; for (const listener of listeners) listener() })
  child.stderr?.on('data', (chunk: string) => { err += chunk })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { for (const listener of listeners) listener(); resolve(code) })
  })
  const handle: LyteboatChild = {
    child,
    output: () => `stdout:\n${out}\nstderr:\n${err}`,
    stdout: () => out,
    stderr: () => err,
    exited,
    waitForStdout(pattern, timeoutMs = 60_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { done(); reject(new Error(`timed out waiting for ${String(pattern)}\n${handle.output()}`)) }, timeoutMs)
        const check = (): void => {
          const match = pattern.exec(out)
          if (match !== null) { done(); resolve(match); return }
          if (child.exitCode !== null) { done(); reject(new Error(`lyteboat exited with ${String(child.exitCode)} before ${String(pattern)}\n${handle.output()}`)) }
        }
        const done = (): void => { clearTimeout(timer); listeners.delete(check) }
        listeners.add(check)
        check()
      })
    },
    async stop(signal = 'SIGTERM', timeoutMs = 20_000) {
      if (child.exitCode === null) child.kill(signal)
      const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
      try {
        return await exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
  return handle
}

async function runLyteboat(bin: string, args: readonly string[], options: LyteboatSpawnOptions): Promise<LyteboatRunResult> {
  const handle = startLyteboat(bin, args, options)
  const timeoutMs = options.timeoutMs ?? 90_000
  const timer = setTimeout(() => { handle.child.kill('SIGKILL') }, timeoutMs)
  try {
    const code = await handle.exited
    if (code === null) throw new Error(`lyteboat did not exit within ${String(timeoutMs / 1000)}s\n${handle.output()}`)
    return { code, stdout: handle.stdout(), stderr: handle.stderr() }
  } finally {
    clearTimeout(timer)
  }
}

/** Start and run one built launcher. */
export interface LyteboatLauncher {
  /** Start the launcher without waiting for it to exit. */
  startLyteboat(args: readonly string[], options?: LyteboatSpawnOptions): LyteboatChild
  /** Run the launcher to completion. */
  runLyteboat(args: readonly string[], options?: LyteboatSpawnOptions): Promise<LyteboatRunResult>
}

/**
 * Bind the spawn helpers to one built launcher.
 * @param bin - absolute path of the launcher entry (an app's `lib/bin.js`).
 * @returns start and run helpers for that launcher.
 */
export function lyteboatLauncher(bin: string): LyteboatLauncher {
  return {
    startLyteboat: (args, options = {}) => startLyteboat(bin, args, options),
    runLyteboat: (args, options = {}) => runLyteboat(bin, args, options),
  }
}
