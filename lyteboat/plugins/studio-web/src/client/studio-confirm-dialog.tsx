/**
 * The pages' confirmation modal, in place of `window.confirm`: mount
 * {@link StudioConfirmProvider} once and await `useStudioConfirm()(…)`, which
 * resolves true when confirmed. Escape cancels, Enter confirms.
 * @module @lyteboat/studio-web/client/studio-confirm-dialog
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertIcon, CheckIcon, CloseIcon } from './studio-icons.tsx'

/** What a confirmation asks. */
interface StudioConfirmOptions {
  title: string
  message?: string
  tone?: 'default' | 'danger'
  confirmLabel?: string
}

type StudioConfirmRequest = (options: StudioConfirmOptions) => Promise<boolean>

const StudioConfirmContext = createContext<StudioConfirmRequest | null>(null)

function StudioConfirmView({ options, settle }: { options: StudioConfirmOptions; settle: (confirmed: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const danger = options.tone === 'danger'

  useEffect(() => { confirmRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); settle(false) }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); settle(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settle])

  return (
    <div className="cf-scrim" onClick={() => settle(false)}>
      <div aria-labelledby="cf-title" aria-modal="true" className="cf-modal" onClick={event => event.stopPropagation()} role={danger ? 'alertdialog' : 'dialog'}>
        <div className="cf-head">
          <span className={`cf-icon ${danger ? 'danger' : ''}`}><AlertIcon /></span>
          <div className="cf-head-copy">
            <h2 id="cf-title">{options.title}</h2>
            {options.message !== undefined && <p className="cf-message">{options.message}</p>}
          </div>
        </div>
        <div className="cf-foot">
          <button className="btn" onClick={() => settle(false)} type="button"><CloseIcon /> Cancel</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-accent'}`} onClick={() => settle(true)} ref={confirmRef} type="button">
            {danger ? <AlertIcon /> : <CheckIcon />} {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Provide the confirmation modal to the pages. */
export function StudioConfirmProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ options: StudioConfirmOptions; resolve: (confirmed: boolean) => void } | null>(null)
  const request = useCallback<StudioConfirmRequest>(options => new Promise(resolve => { setActive({ options, resolve }) }), [])
  const settle = useCallback((confirmed: boolean) => {
    setActive((current) => {
      current?.resolve(confirmed)
      return null
    })
  }, [])
  return (
    <StudioConfirmContext.Provider value={request}>
      {children}
      {active !== null && <StudioConfirmView options={active.options} settle={settle} />}
    </StudioConfirmContext.Provider>
  )
}

/** Ask for a confirmation; only inside {@link StudioConfirmProvider}. */
export function useStudioConfirm(): StudioConfirmRequest {
  const request = useContext(StudioConfirmContext)
  if (request === null) throw new Error('useStudioConfirm must be used inside StudioConfirmProvider')
  return request
}
