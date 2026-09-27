/**
 * Read dsh session logs (`session.v4.jsonl`, plain or Zstandard) outside the
 * running harness: every lyteboat test that inspects a stored log, and the
 * compatibility gates' log comparisons, decode logs through this one module.
 *
 * `scanZstdFrames` is adapted from deepseek-ai/deepseek-harness
 * packages/session/session-persistence-jsonl/src/zstd.ts @ dsh-v0.1.7-rc.2
 * (477b4f42), MIT — see THIRD_PARTY_NOTICES.md, without its `maxFrames`
 * limit. The jsonl backend writes one Zstandard frame per flushed batch;
 * Node's `zstdDecompressSync` stops after the first frame, so frames must be
 * located structurally and decoded one by one.
 *
 * `waitForSessionLog` polls a running service's store, which writes in batches,
 * until a session's log holds what a test asserts on.
 * @module @lyteboat/testing/session-log
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { vi } from 'vitest'

const ZSTD_MAGIC = 0xFD2FB528

/** Byte range occupied by one structurally complete Zstandard frame. */
export interface ZstdFrameRange {
  start: number
  end: number
}

/** Structural scan result for a concatenated Zstandard stream. */
export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  /** Start of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number
}

/**
 * Locate complete frames without decompressing their blocks.
 * @param buffer - complete bytes of the session artifact.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** One parsed line of a session log: the header record or an event envelope. */
export type SessionLogRecord = Record<string, unknown>

/**
 * Decode a session artifact's bytes into parsed JSON records.
 * @param bytes - file contents.
 * @param compressed - whether the artifact is the `.zstd` container.
 * @returns records in file order.
 */
export function decodeSessionLog(bytes: Buffer, compressed: boolean): SessionLogRecord[] {
  let text: string
  if (compressed) {
    const { frames, tornStart } = scanZstdFrames(bytes)
    if (tornStart !== undefined) throw new Error(`session log ends inside a Zstandard frame at byte ${tornStart}`)
    text = frames.map(({ start, end }) => zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')).join('')
  } else {
    text = bytes.toString('utf8')
  }
  return text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as SessionLogRecord)
}

/**
 * Read one session artifact by path.
 * @param path - a `session.v4.jsonl` or `session.v4.jsonl.zstd` file.
 * @returns records in file order.
 */
export function readSessionLog(path: string): SessionLogRecord[] {
  return decodeSessionLog(readFileSync(path), path.endsWith('.zstd'))
}

/**
 * Find every session artifact below a harness home's `sessions` directory.
 * @param home - the harness home (`$LYTEBOAT_HOME`).
 * @returns absolute artifact paths, sorted.
 */
export function findSessionLogs(home: string): string[] {
  const root = join(home, 'sessions')
  let entries: string[]
  try {
    entries = readdirSync(root, { recursive: true, encoding: 'utf8' })
  } catch {
    return []
  }
  return entries
    .filter(entry => /session\.v4\.jsonl(?:\.zstd)?$/u.test(entry))
    .map(entry => join(root, entry))
    .sort()
}

/**
 * Wait until one session's stored log satisfies `until`, polling with vitest's `waitFor`.
 * @param home - the harness home the session is stored under.
 * @param sessionId - the session; its log is the artifact whose path names it.
 * @param until - holds once the log has what the test needs.
 * @param options - how long to wait and how often to read (default 10 s, every 50 ms).
 * @returns the log's records, header first, typed as the caller reads them.
 */
export function waitForSessionLog<T extends SessionLogRecord = SessionLogRecord>(
  home: string,
  sessionId: string,
  until: (records: T[]) => boolean,
  options: { timeout?: number; interval?: number } = {},
): Promise<T[]> {
  return vi.waitFor(() => {
    const path = findSessionLogs(home).find(candidate => candidate.includes(sessionId))
    if (path === undefined) throw new Error(`no log for ${sessionId} yet`)
    const records = readSessionLog(path) as T[]
    if (!until(records)) throw new Error(`the log of ${sessionId} is not there yet`)
    return records
  }, { timeout: options.timeout ?? 10_000, interval: options.interval ?? 50 })
}

/** The `type` of every record after the header, in order. */
export function eventTypes(records: readonly SessionLogRecord[]): string[] {
  return records.slice(1).map(record => String(record['type']))
}

/** Values that differ between two otherwise identical runs, replaced during normalization. */
export interface NormalizeOptions {
  /** Workspace directory of the run; every occurrence in strings becomes `<cwd>`. */
  cwd: string
  /** Harness home of the run; every occurrence in strings becomes `<home>`. */
  home: string
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu
const TIMING_KEYS = new Set(['time', 'time0', 'dt', 'createdAt', 'delayMs'])
const DROPPED_EVENT_TYPES = /^session\/title/u
/** Integers in this range read as epoch milliseconds (2001–2103): a plugin's own timestamp, whatever its key. */
const EPOCH_MS_MIN = 1e12
const EPOCH_MS_MAX = 4.2e12

/**
 * Normalize a session log for comparison across runs: timing fields (a retry's
 * jittered `delayMs` among them) go, integers that read as epoch milliseconds
 * (a plugin's own timestamps, under any key) become `<epoch-ms>`, every UUID
 * becomes a placeholder numbered by first appearance, workspace and home
 * paths become `<cwd>` and `<home>`, and the title provider's events (which
 * land at timing-dependent positions) are dropped. `seq` is kept: two runs of
 * the same scenario must agree on event order.
 * @param records - decoded records, header first.
 * @param options - the run's paths.
 * @returns a structurally comparable copy.
 */
export function normalizeSessionLog(records: readonly SessionLogRecord[], options: NormalizeOptions): SessionLogRecord[] {
  const uuids = new Map<string, string>()
  const placeholder = (uuid: string): string => {
    const key = uuid.toLowerCase()
    let name = uuids.get(key)
    if (name === undefined) {
      name = `<uuid-${String(uuids.size + 1)}>`
      uuids.set(key, name)
    }
    return name
  }
  const scrubString = (value: string): string => value
    .replaceAll(options.cwd, '<cwd>')
    .replaceAll(options.home, '<home>')
    .replace(UUID, placeholder)
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return scrubString(node)
    if (typeof node === 'number' && Number.isInteger(node) && node >= EPOCH_MS_MIN && node < EPOCH_MS_MAX) return '<epoch-ms>'
    if (Array.isArray(node)) return node.map(visit)
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node)) {
        if (TIMING_KEYS.has(key)) continue
        out[key] = visit(value)
      }
      return out
    }
    return node
  }
  return records
    .filter(record => !DROPPED_EVENT_TYPES.test(String(record['type'])))
    .map(record => visit(record) as SessionLogRecord)
}
