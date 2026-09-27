/**
 * The two ways a Studio page holds what it reads. A call ({@link useStudioCall})
 * is made when a section mounts and again whenever the call changes (another
 * agent, another skill), held as its answer or the message of the error that
 * stopped it; both are null while it runs, so a quick switch never shows the
 * previous agent's data. A reading ({@link useStudioReading}) is made on mount,
 * whenever it changes (a new query), and on every reload, and keeps its last
 * answer while the next one runs and when it fails, so a page can stay on
 * screen through a refresh or a poll. Either drops an answer that arrives
 * after a newer one was asked for or the section unmounted.
 * @module @lyteboat/studio-web/client/studio-call-state
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { studioErrorMessage } from './studio-api-client.ts'

/** A call's answer or error, and a setter for a section that changes what it answered (a hot-fix). */
interface StudioCallState<T> {
  answer: T | null
  error: string | null
  setAnswer: Dispatch<SetStateAction<T | null>>
}

/** A reading's last answer, the error of the last reading when it failed, whether one is on its way, and a reload. */
interface StudioReading<T> {
  answer: T | null
  error: string | null
  loading: boolean
  reload(): Promise<void>
}

/**
 * @param call - the call, memoized (`useCallback`) on what it asks for; a new function runs it again.
 * @returns its state.
 */
export function useStudioCall<T>(call: () => Promise<T>): StudioCallState<T> {
  const [answer, setAnswer] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setAnswer(null)
    setError(null)
    const run = async (): Promise<void> => {
      try {
        const next = await call()
        if (!cancelled) setAnswer(next)
      } catch (nextError: unknown) {
        if (!cancelled) setError(studioErrorMessage(nextError))
      }
    }
    void run()
    return () => { cancelled = true }
  }, [call])

  return { answer, error, setAnswer }
}

/**
 * @param read - the reading, memoized (`useCallback`) on what it asks for; a new function reads again.
 * @returns its state; `loading` is true from the first render until the latest reading settles.
 */
export function useStudioReading<T>(read: () => Promise<T>): StudioReading<T> {
  const [answer, setAnswer] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const reload = useCallback(async () => {
    const ticket = ++latest.current
    const current = (): boolean => mounted.current && ticket === latest.current
    setLoading(true)
    try {
      const next = await read()
      if (current()) {
        setAnswer(next)
        setError(null)
      }
    } catch (nextError: unknown) {
      if (current()) setError(studioErrorMessage(nextError))
    } finally {
      if (current()) setLoading(false)
    }
  }, [read])

  useEffect(() => { void reload() }, [reload])

  return { answer, error, loading, reload }
}
