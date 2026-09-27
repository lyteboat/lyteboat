/**
 * An agent directory's digest: what makes the agent run, as one value. Every
 * regular file of the directory counts except, at the top level, `tests/`,
 * `evals/`, and `agent.release.json`, and, at any depth, `node_modules/`,
 * entries whose name starts with a dot, and `*.tsbuildinfo`. Each file is
 * named by its POSIX path relative to the directory; the paths are sorted by
 * their UTF-8 bytes; the digest is the sha256 of the lines
 * `<path> NUL <sha256 of the content> LF`, as `sha256:<hex>`. A text file's
 * content is read with its CRLF line endings as LF, the form git commits it in,
 * so a checkout or an editor on Windows gives the digest Linux gives; a file
 * with a NUL byte in its first 8000 bytes is binary (git's own test) and counts
 * as it is. File modes and times do not count; a symbolic link outside the
 * excluded entries is an error, so the digest never depends on what a link
 * points to on one machine.
 * @module @lyteboat/agent-catalog/agent-digest
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LYTEBOAT_AGENT_RELEASE_FILE } from '@lyteboat/contracts'

/** Top-level entries the digest leaves out: the agent's tests, its eval runs and baseline, and its release lock. */
const TOP_LEVEL_EXCLUDED = new Set(['tests', 'evals', LYTEBOAT_AGENT_RELEASE_FILE])

/** An agent directory's digest and the per-file content hashes it is made of. */
export interface AgentDigest {
  /** `sha256:` and 64 lowercase hex digits. */
  readonly digest: string
  /** POSIX relative path → the sha256 of the file's content, in digest order. */
  readonly files: Readonly<Record<string, string>>
}

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** A file's content as git commits it: a text file's CRLF read as LF (latin1 maps every byte to one character and back), a binary file as it is. */
function committedContent(file: string): Buffer {
  const bytes = readFileSync(file)
  if (bytes.subarray(0, 8000).includes(0)) return bytes
  return Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')
}

function excluded(name: string, depth: number): boolean {
  return name.startsWith('.') || name === 'node_modules' || name.endsWith('.tsbuildinfo') || (depth === 0 && TOP_LEVEL_EXCLUDED.has(name))
}

function collect(dir: string, prefix: string, depth: number, files: Map<string, string>): void {
  for (const entry of readdirSync(prefix === '' ? dir : join(dir, prefix), { withFileTypes: true })) {
    if (excluded(entry.name, depth)) continue
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`agent-catalog: ${join(dir, path)} is a symbolic link; an agent's digest covers regular files only`)
    if (entry.isDirectory()) collect(dir, path, depth + 1, files)
    else if (entry.isFile()) files.set(path, sha256Hex(committedContent(join(dir, path))))
  }
}

/**
 * Compute an agent directory's digest.
 * @param dir - the agent directory.
 * @returns the digest and the per-file hashes.
 * @throws when the directory holds a symbolic link outside the excluded entries, or a file cannot be read.
 */
export function agentDigest(dir: string): AgentDigest {
  const hashes = new Map<string, string>()
  collect(dir, '', 0, hashes)
  const paths = [...hashes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const digest = createHash('sha256')
  for (const path of paths) digest.update(`${path}\0${hashes.get(path) ?? ''}\n`)
  // fromEntries defines own properties, so a file named like an Object.prototype member stays a plain entry.
  return { digest: `sha256:${digest.digest('hex')}`, files: Object.fromEntries(paths.map(path => [path, hashes.get(path) ?? ''])) }
}
