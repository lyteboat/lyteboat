/**
 * The reopen check the composition tests assert with: dsh's validator refuses an
 * unknown event type unless it is marked ignorable.
 */
import { describe, expect, it } from 'vitest'
import { reopenRefusal } from '../src/session-reopen.ts'

const HEADER = { type: 'session', version: 4, id: 'reopen-check', createdAt: 0, isSeeded: false }
const unknownRecord = (ignorable: boolean) => ({ type: 'example/unknown-record', seq: 0, time: 0, data: {}, ...ignorable ? { ignorable: true } : {} })

describe('reopenRefusal', () => {
  it('reopenRefusal names the event type when a stored record outside dsh\'s catalog is not marked ignorable', () => {
    expect(reopenRefusal([HEADER, unknownRecord(false)])).toContain('contains event type "example/unknown-record" (seq 0)')
  })

  it('reopenRefusal reports nothing when the unknown record is marked ignorable', () => {
    expect(reopenRefusal([HEADER, unknownRecord(true)])).toBeUndefined()
  })
})
