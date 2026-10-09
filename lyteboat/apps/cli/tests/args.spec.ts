import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLyteboatArgs } from '../src/args.ts'
import { pluginRowId } from '../src/plugins.ts'

const INTAKE_PLUGIN = fileURLToPath(new URL('./fixtures/plugins/intake-gate.mjs', import.meta.url))
const ANNOUNCE_PLUGIN = fileURLToPath(new URL('./fixtures/plugins/announce.mjs', import.meta.url))

const parse = (argv: string[]) => parseLyteboatArgs(argv, { lyteboat: '0.0.1', dsh: '0.0.0-test' })

/** Capture the process exit code and what Commander wrote to stderr, muting its output. */
function exitOf(argv: string[]): { code: number; stderr: string } {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  let stderr = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true })
  try {
    parse(argv)
    throw new Error(`expected ${JSON.stringify(argv)} to exit`)
  } catch {
    return { code: exit.mock.calls.at(-1)?.[0] as number, stderr }
  } finally {
    vi.restoreAllMocks()
  }
}

const exitCode = (argv: string[]): number => exitOf(argv).code

afterEach(() => { vi.restoreAllMocks() })

describe('parseLyteboatArgs', () => {
  it('refuses a business agent on the one-shot, pointing to serve, unless a profile is named', () => {
    expect(exitOf(['headless', '--agents', './agents', '--agent', 'finance', 'summarize', 'this'])).toEqual({
      code: 1,
      stderr: 'error: lyteboat headless answers with dsh\'s own agent and runs no business agent; serve one with lyteboat serve --agents <dir> and POST /chat, or run its eval cases with lyteboat eval\n',
    })
    expect(exitCode(['headless', '--patch', 'a.yml', '--agent=finance', 'hello'])).toBe(1)
    expect(parse(['headless', '--profile', 'custom', '--agent', 'finance', 'hello']))
      .toEqual({ mode: 'profile', profile: 'custom', plugins: [], patches: [], args: ['--agent', 'finance', 'hello'] })
  })

  it('boots dsh\'s own one-shot when the agent flag is only task text after the app\'s --', () => {
    expect(parse(['headless', '--json', '--', '--agent', 'is', 'a', 'word']))
      .toEqual({ mode: 'profile', profile: 'headless', plugins: [], patches: [], args: ['--json', '--', '--agent', 'is', 'a', 'word'] })
  })

  it('boots the native profiles, dsh\'s own web and headless apps, with their arguments verbatim', () => {
    expect(parse(['web', '--no-open', '--port', '0']))
      .toEqual({ mode: 'profile', profile: 'web', plugins: [], patches: [], args: ['--no-open', '--port', '0'] })
    expect(parse(['headless', '--json', 'run the tests']))
      .toEqual({ mode: 'profile', profile: 'headless', plugins: [], patches: [], args: ['--json', 'run the tests'] })
    expect(parse(['web', '--help'])).toEqual({ mode: 'profile', profile: 'web', plugins: [], patches: [], args: ['--help'] })
  })

  it('ends the launcher flags at the first token it does not own', () => {
    expect(parse(['headless', '-h'])).toEqual({ mode: 'profile', profile: 'headless', plugins: [], patches: [], args: ['-h'] })
    expect(parse(['studio', '--agents', './agents', '--port', '0']))
      .toEqual({ mode: 'profile', profile: 'studio', plugins: [], patches: [], args: ['--agents', './agents', '--port', '0'] })
    expect(parse(['studio', '--patch', 'st.yml', '--host', '127.0.0.1', '--patch', 'late.yml']))
      .toEqual({ mode: 'profile', profile: 'studio', plugins: [], patches: ['st.yml'], args: ['--host', '127.0.0.1', '--patch', 'late.yml'] })
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
    expect(parse(['headless', '--plugin', INTAKE_PLUGIN, '--plugin', ANNOUNCE_PLUGIN, 'hi']))
      .toEqual({ mode: 'profile', profile: 'headless', plugins: [INTAKE_PLUGIN, ANNOUNCE_PLUGIN], patches: [], args: ['hi'] })
    expect(exitCode(['headless', '--plugin', '', 'hi'])).toBe(1)
    expect(exitCode(['headless', '--plugin', 'missing.mjs', 'hi'])).toBe(1)
    expect(exitCode(['headless', '--plugin', INTAKE_PLUGIN, '--plugin', INTAKE_PLUGIN, 'hi'])).toBe(1)
  })

  it('resolves config dumps', () => {
    expect(parse(['config', 'dump'])).toEqual({ mode: 'dump-config', profile: 'serve', defaultOnly: false, patches: [], plugins: [] })
    expect(parse(['config', 'dump', '--profile', 'studio', '--default']))
      .toEqual({ mode: 'dump-config', profile: 'studio', defaultOnly: true, patches: [], plugins: [] })
    expect(parse(['config', 'dump', '--patch', 'x.yml']))
      .toEqual({ mode: 'dump-config', profile: 'serve', defaultOnly: false, patches: ['x.yml'], plugins: [] })
  })

  it('exits on usage errors, help, and version', () => {
    expect(exitCode(['headless', '--profile', '', 'x'])).toBe(1)
    expect(exitCode(['headless', '--patch', '', 'x'])).toBe(1)
    expect(exitCode(['try', 'x'])).toBe(1)
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
