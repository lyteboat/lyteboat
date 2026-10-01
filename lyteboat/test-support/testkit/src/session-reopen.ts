/**
 * Whether dsh's persistence would reopen a stored session log: the records a
 * test decoded (`@lyteboat/testkit/session-log`) run through the kernel's own
 * validator, the check a reopen makes before it interprets a log. A lyteboat
 * fact that rides a dsh envelope passes; an event type outside dsh's catalog
 * passes only when it is marked ignorable.
 * @module @lyteboat/testkit/session-reopen
 */

import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type { SessionLogRecord } from './session-log.ts'

/**
 * Why dsh's persistence would refuse to reopen a stored log.
 * @param records - decoded records, header first.
 * @returns the refusal message, or undefined when the log reopens.
 */
export function reopenRefusal(records: readonly SessionLogRecord[]): string | undefined {
  const header = records.find(record => record['type'] === 'session')
  const meta: SessionHeader = {
    id: SessionId(typeof header?.['id'] === 'string' ? header['id'] : 'reopen'),
    version: SESSION_FORMAT_VERSION,
    createdAt: typeof header?.['createdAt'] === 'number' ? header['createdAt'] : 0,
    isSeeded: header?.['isSeeded'] === true,
  }
  // A decoded line is untyped JSON until the validator adopts it, and adopting rewrites the array.
  const events = structuredClone(records.filter(record => typeof record['seq'] === 'number')) as unknown as SessionEvent[]
  try {
    validateStoredEvents(meta, events)
  } catch (error: unknown) {
    if (error instanceof SessionFormatUnsupportedError) return error.message
    throw error
  }
  return undefined
}
