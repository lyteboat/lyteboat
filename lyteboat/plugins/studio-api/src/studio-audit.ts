/**
 * Studio's audit log, `<studio dir>/audit.jsonl`: one JSON line per change
 * made through Studio and per failed login, `{time, actor, action, …}`, in the
 * order they happened. Lines are appended through one queue, off the request's
 * path; a failed append is logged and the change it records stands.
 * @module @lyteboat/studio-api/studio-audit
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** What a line records. */
type StudioAuditAction = 'login.failed' | 'grant.set' | 'grant.remove' | 'agents.reload' | 'skill.update' | 'eval.start' | 'eval.stop' | 'eval.delete' | 'chat.send'

/** One line of the audit log, beside its time. */
interface StudioAuditEntry {
  /** Who did it: a user id, or the username a failed login gave. */
  actor: string
  action: StudioAuditAction
  [detail: string]: string | number | boolean
}

/** Appends audit lines in order. */
export class StudioAudit {
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param dir - the Studio directory.
   * @param warn - where a failed append is reported.
   */
  constructor(private readonly dir: string, private readonly warn: (message: string) => void) {}

  /** Queue one line; resolves when it is written or its failure reported. */
  record(entry: StudioAuditEntry, now = Date.now()): Promise<void> {
    const line = `${JSON.stringify({ time: now, ...entry })}\n`
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true, mode: 0o700 })
        await appendFile(join(this.dir, 'audit.jsonl'), line, { mode: 0o600 })
      } catch (error: unknown) {
        this.warn(`lyteboat studio api: the audit log did not take ${entry.action} by ${entry.actor}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return this.queue
  }
}
