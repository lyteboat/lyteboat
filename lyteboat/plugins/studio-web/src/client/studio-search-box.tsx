/**
 * The filter bar over a Studio list: a search box, and beside it the controls
 * a page adds (the Users page's role filter).
 * @module @lyteboat/studio-web/client/studio-search-box
 */

import type { ReactNode } from 'react'
import { SearchIcon } from './studio-icons.tsx'

/** `label` is the input's accessible name; `onChange` gets the text as typed. */
export function StudioSearchBox({ label, placeholder, value, onChange, maxLength, children }: {
  label: string
  placeholder: string
  value: string
  onChange(value: string): void
  maxLength?: number
  children?: ReactNode
}) {
  return (
    <div className="filter-bar">
      <label className="search">
        <SearchIcon />
        <input aria-label={label} maxLength={maxLength} onChange={event => onChange(event.target.value)} placeholder={placeholder} value={value} />
      </label>
      {children}
    </div>
  )
}
