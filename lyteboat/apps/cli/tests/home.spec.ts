import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installLyteboatHome } from '../src/home.ts'

describe('installLyteboatHome', () => {
  it('exports LYTEBOAT_HOME as DSH_HOME over a value already set, and leaves the shared agent root as the user has it', () => {
    const env: Record<string, string | undefined> = { LYTEBOAT_HOME: '/srv/lyteboat', DSH_HOME: '/home/u/.dsh', DSH_AGENTS_HOME: '/home/u/.agents' }

    const home = installLyteboatHome(env)

    expect(home).toBe('/srv/lyteboat')
    expect(env['DSH_HOME']).toBe('/srv/lyteboat')
    expect(env['DSH_AGENTS_HOME']).toBe('/home/u/.agents')
  })

  it('falls back to ~/.lyteboat when LYTEBOAT_HOME is blank, and sets no shared agent root of its own', () => {
    const env: Record<string, string | undefined> = { LYTEBOAT_HOME: '  ' }

    const home = installLyteboatHome(env)

    expect(home).toBe(join(homedir(), '.lyteboat'))
    expect(env['DSH_HOME']).toBe(home)
    expect(env).not.toHaveProperty('DSH_AGENTS_HOME')
  })
})
