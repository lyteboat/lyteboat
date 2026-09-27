/**
 * Temporary directories for one test file: a root under the OS temporary
 * directory, created on first use, and a fresh harness home and workspace per
 * run label. Composition and e2e tests point `DSH_HOME` / `LYTEBOAT_HOME` at the
 * home and run in the workspace, so no run sees another's sessions or files.
 * A test that needs only a directory of its own takes `lyteboatTempDir`, which
 * is removed when that test finishes.
 * @module @lyteboat/testing/scratch
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { onTestFinished } from 'vitest'

/** One run's directories. */
export interface LyteboatScratchRun {
  /** The harness home the run writes its sessions under. */
  readonly home: string
  /** The working directory: a README.md naming the scratch, then the run's own files. */
  readonly workspace: string
}

/** A test file's temporary tree. */
export interface LyteboatScratch {
  /** The root directory, for files the file's runs share; created on first use. */
  readonly root: string
  /**
   * Empty `home-<label>` and `workspace-<label>` under the root, recreated when a label repeats.
   * @param label - names the run's directories.
   * @param files - workspace files by relative path, parent directories created.
   * @returns the run's home and workspace.
   */
  run(label: string, files?: Readonly<Record<string, string>>): LyteboatScratchRun
  /** Remove the root and everything under it; a later use creates a new root. */
  remove(): void
}

/**
 * Create a test file's temporary tree; nothing touches the disk until it is used.
 * @param name - names the root (`lyteboat-<name>-*`) and heads the workspace README.
 * @returns the tree.
 */
export function createLyteboatScratch(name: string): LyteboatScratch {
  let root: string | undefined
  const rootDir = (): string => {
    root ??= mkdtempSync(join(tmpdir(), `lyteboat-${name}-`))
    return root
  }
  return {
    get root() { return rootDir() },
    run(label, files = {}) {
      const home = join(rootDir(), `home-${label}`)
      const workspace = join(rootDir(), `workspace-${label}`)
      for (const dir of [home, workspace]) {
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(join(workspace, 'README.md'), `# ${name} workspace\n`)
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(workspace, path)), { recursive: true })
        writeFileSync(join(workspace, path), text)
      }
      return { home, workspace }
    },
    remove() {
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
      root = undefined
    },
  }
}

/**
 * Create an empty directory for the running test under the OS temporary directory,
 * removed with everything under it when the test finishes, passed or failed. It
 * registers through vitest's `onTestFinished`, which needs a running test: call it
 * from a test body or a function one calls, never from `beforeEach`, `beforeAll`,
 * or a `describe` body.
 * @param name - names the directory (`lyteboat-<name>-*`).
 * @returns the directory's absolute path.
 */
export function lyteboatTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lyteboat-${name}-`))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}
