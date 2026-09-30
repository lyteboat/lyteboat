import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLyteboatArgs } from '../src/args.ts'
import { pluginRowId } from '../src/plugins.ts'

const INTAKE_PLUGIN = fileURLToPath(new URL('./fixtures/plugins/intake-gate.mjs', import.meta.url))
const ANNOUNCE_PLUGIN = fileURLToPath(new URL('./fixtures/plugins/announce.mjs', import.meta.url))

const parse = (argv: string[]) => parseLyteboatArgs(argv, { lyteboat: '0.0.1', dsh: '0.0.0-test' })

/** Capture the process exit code while muting Commander's output. */
function exitCode(argv: string[]): number {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    parse(argv)
    throw new Error(`expected ${JSON.stringify(argv)} to exit`)
  } catch {
    return exit.mock.calls.at(-1)?.[0] as number
  } finally {
    vi.restoreAllMocks()
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('parseLyteboatArgs', () => {
  it('boots the try profile with the task handed to the app verbatim', () => {
    expect(parse(['try', 'summarize', 'this', 'workspace']))
      .toEqual({ mode: 'profile', profile: 'try', plugins: [], patches: [], args: ['summarize', 'this', 'workspace'] })
    expect(parse(['try', '--patch', 'a.yml', '--patch', 'b.yml', 'hello']))
      .toEqual({ mode: 'profile', profile: 'try', plugins: [], patches: ['a.yml', 'b.yml'], args: ['hello'] })
    expect(parse(['try', '--profile', 'custom', 'hello']))
      .toEqual({ mode: 'profile', profile: 'custom', plugins: [], patches: [], args: ['hello'] })
  })

  it('ends the launcher flags at the first token it does not own', () => {
    expect(parse(['try', '-h'])).toEqual({ mode: 'profile', profile: 'try', plugins: [], patches: [], args: ['-h'] })
    expect(parse(['studio', '--no-open', '--port', '0']))
      .toEqual({ mode: 'profile', profile: 'studio', plugins: [], patches: [], args: ['--no-open', '--port', '0'] })
    expect(parse(['studio', '--patch', 'w.yml', '--host', '127.0.0.1', '--patch', 'late.yml']))
      .toEqual({ mode: 'profile', profile: 'studio', plugins: [], patches: ['w.yml'], args: ['--host', '127.0.0.1', '--patch', 'late.yml'] })
    expect(parse(['serve', '--patch', 's.yml', '--agents', './agents', '--port', '0']))
      .toEqual({ mode: 'profile', profile: 'serve', plugins: [], patches: ['s.yml'], args: ['--agents', './agents', '--port', '0'] })
    expect(parse(['eval', 'compare', 'a', 'b']))
      .toEqual({ mode: 'profile', profile: 'eval', plugins: [], patches: [], args: ['compare', 'a', 'b'] })
  })

  it('boots the eval profile with the release command for a release', () => {
    expect(parse(['release', '--agents', './agents', '--agent', 'finance']))
      .toEqual({ mode: 'profile', profile: 'eval', plugins: [], patches: [], args: ['release', '--agents', './agents', '--agent', 'finance'] })
    expect(parse(['release', '--patch', 'm.yml', '-h']))
      .toEqual({ mode: 'profile', profile: 'eval', plugins: [], patches: ['m.yml'], args: ['release', '-h'] })
  })

  it('inserts local plugin files that exist, each once', () => {
    expect(parse(['try', '--plugin', INTAKE_PLUGIN, '--plugin', ANNOUNCE_PLUGIN, 'hi']))
      .toEqual({ mode: 'profile', profile: 'try', plugins: [INTAKE_PLUGIN, ANNOUNCE_PLUGIN], patches: [], args: ['hi'] })
    expect(exitCode(['try', '--plugin', '', 'hi'])).toBe(1)
    expect(exitCode(['try', '--plugin', 'missing.mjs', 'hi'])).toBe(1)
    expect(exitCode(['try', '--plugin', INTAKE_PLUGIN, '--plugin', INTAKE_PLUGIN, 'hi'])).toBe(1)
  })

  it('resolves config dumps', () => {
    expect(parse(['config', 'dump'])).toEqual({ mode: 'dump-config', profile: 'try', defaultOnly: false, patches: [], plugins: [] })
    expect(parse(['config', 'dump', '--profile', 'studio', '--default']))
      .toEqual({ mode: 'dump-config', profile: 'studio', defaultOnly: true, patches: [], plugins: [] })
    expect(parse(['config', 'dump', '--patch', 'x.yml']))
      .toEqual({ mode: 'dump-config', profile: 'try', defaultOnly: false, patches: ['x.yml'], plugins: [] })
  })

  it('exits on usage errors, help, and version', () => {
    expect(exitCode(['try', '--profile', '', 'x'])).toBe(1)
    expect(exitCode(['try', '--patch', '', 'x'])).toBe(1)
    expect(exitCode(['config', 'dump', '--default', '--patch', 'x.yml'])).toBe(1)
    expect(exitCode(['bogus'])).toBe(1)
    expect(exitCode([])).toBe(1)
    expect(exitCode(['--help'])).toBe(0)
    expect(exitCode(['--version'])).toBe(0)
  })
})

describe('pluginRowId', () => {
  it('names the row after the path, so files sharing a basename get distinct rows', () => {
    expect(pluginRowId('tests/fixtures/plugins/intake-gate.mjs', '/repo')).toBe('plugin:tests/fixtures/plugins/intake-gate')
    expect(pluginRowId('/repo/tests/fixtures/plugins/announce.mjs', '/repo')).toBe('plugin:tests/fixtures/plugins/announce')
    expect(pluginRowId('/elsewhere/plugin.mjs', '/repo')).toBe('plugin:/elsewhere/plugin')
  })
})
