import { expect, test, vi } from 'vitest'
import { typertSourceDigest } from './typert.ts'

// A Windows checkout: path.relative answers with backslashes (win32's does so on any platform), and
// Git for Windows checks text out with CRLF line endings by default (core.autocrlf).
const checkout = vi.hoisted(() => ({ windowsPaths: false, crlf: false }))
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>()
  const relative = (from: string, to: string): string => (checkout.windowsPaths ? path.win32.relative(from, to) : path.relative(from, to))
  return { ...path, relative, default: { ...path, relative } }
})
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const content = fs.readFileSync(...args)
    return checkout.crlf && Buffer.isBuffer(content) ? Buffer.from(content.toString('latin1').replace(/\r?\n/gu, '\r\n'), 'latin1') : content
  }) as typeof fs.readFileSync
  return { ...fs, readFileSync, default: { ...fs, readFileSync } }
})

/** session-controller's src/ has nested directories, so its relative paths carry separators. */
function digestWith(simulated: Partial<typeof checkout>): string {
  Object.assign(checkout, simulated)
  try {
    return typertSourceDigest('api/session-controller')
  } finally {
    Object.assign(checkout, { windowsPaths: false, crlf: false })
  }
}

test('typertSourceDigest is the same when path.relative answers with Windows separators', () => {
  expect(digestWith({ windowsPaths: true })).toBe(digestWith({}))
})

test('typertSourceDigest is the same when the source is checked out with CRLF line endings', () => {
  expect(digestWith({ windowsPaths: true, crlf: true })).toBe(digestWith({}))
})
