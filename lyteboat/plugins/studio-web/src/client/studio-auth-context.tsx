/**
 * Who is using the pages. On load the context asks how this Studio signs
 * people in: behind a gateway it asks the session; with Studio's own accounts
 * it checks the token kept from the last sign-in against the session, or, when
 * anonymous viewers are allowed, asks the session without one. A sign-in keeps
 * its token in `localStorage`; a sign-out, or any 401, forgets it.
 * @module @lyteboat/studio-web/client/studio-auth-context
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { StudioAuthConfigAnswer, StudioLoginAnswer, StudioPrincipal, StudioRole } from '@lyteboat/contracts/studio'
import { configureStudioApi, studioApi } from './studio-api-client.ts'

const STUDIO_TOKEN_KEY = 'lyteboat-studio-token'

/** What the pages know about the auth state. */
interface StudioAuthValue {
  user: StudioPrincipal | null
  /** Whether the user is an anonymous viewer, who may still sign in with an account. */
  anonymous: boolean
  /** Whether the login page asks for a password; false behind a gateway. */
  loginRequired: boolean
  initializing: boolean
  signIn(answer: StudioLoginAnswer): void
  signOut(): void
}

const StudioAuthContext = createContext<StudioAuthValue | null>(null)

function storedToken(): string | undefined {
  try {
    return localStorage.getItem(STUDIO_TOKEN_KEY) ?? undefined
  } catch {
    // Storage is off (a private window with storage blocked): every load signs in anew.
    return undefined
  }
}

function keepToken(token: string | undefined): void {
  try {
    if (token === undefined) localStorage.removeItem(STUDIO_TOKEN_KEY)
    else localStorage.setItem(STUDIO_TOKEN_KEY, token)
  } catch {
    // Storage is off: the token lives only as long as the page.
  }
}

/** Who the stored token, the gateway, or anonymous access speaks for; null means the login page. */
async function initialPrincipal(config: StudioAuthConfigAnswer, forget: () => void): Promise<StudioPrincipal | null> {
  const token = config.mode === 'internal' ? storedToken() : undefined
  if (config.mode === 'internal' && token === undefined && !config.anonymousViewer) return null
  configureStudioApi(token, forget)
  try {
    return await studioApi.session()
  } catch {
    keepToken(undefined)
    configureStudioApi(undefined, forget)
    return null
  }
}

/** Provide the auth state to the pages. */
export function StudioAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StudioPrincipal | null>(null)
  const [anonymous, setAnonymous] = useState(false)
  const [loginRequired, setLoginRequired] = useState(true)
  const [initializing, setInitializing] = useState(true)

  const forget = useCallback(() => {
    keepToken(undefined)
    configureStudioApi(undefined, () => {})
    setUser(null)
    setAnonymous(false)
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const config = await studioApi.authConfig()
        setLoginRequired(config.loginRequired)
        const principal = await initialPrincipal(config, forget)
        setUser(principal)
        setAnonymous(principal !== null && config.mode === 'internal' && storedToken() === undefined)
      } catch {
        setUser(null)
      } finally {
        setInitializing(false)
      }
    })()
  }, [forget])

  const signIn = useCallback((answer: StudioLoginAnswer) => {
    keepToken(answer.token)
    configureStudioApi(answer.token, forget)
    setUser({ userId: answer.userId, displayName: answer.displayName, role: answer.role })
    setAnonymous(false)
  }, [forget])

  const signOut = useCallback(() => {
    void studioApi.logout().catch(() => undefined)
    forget()
  }, [forget])

  const value = useMemo(() => ({ user, anonymous, loginRequired, initializing, signIn, signOut }), [user, anonymous, loginRequired, initializing, signIn, signOut])
  return <StudioAuthContext.Provider value={value}>{children}</StudioAuthContext.Provider>
}

/** The auth state; only inside {@link StudioAuthProvider}. */
export function useStudioAuth(): StudioAuthValue {
  const value = useContext(StudioAuthContext)
  if (value === null) throw new Error('useStudioAuth must be used inside StudioAuthProvider')
  return value
}

/** Whether a role may manage the Users page. */
export function canManageStudioUsers(role: StudioRole | undefined): boolean {
  return role === 'admin'
}

/** Whether a role may start, stop, and delete eval runs. */
export function canRunStudioEvals(role: StudioRole | undefined): boolean {
  return role === 'admin' || role === 'editor'
}

/** Whether a role may talk to an agent in the test window. */
export function canTestStudioAgents(role: StudioRole | undefined): boolean {
  return role === 'admin' || role === 'editor'
}
