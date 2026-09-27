/**
 * A block of code or text with a copy button floating at its top right, as the
 * original Studio shows a SKILL.md or a tool's parameters. The button copies
 * `value`, which may differ from what the block shows (an empty file shows a
 * note, and copies nothing). The copy button and the copy itself serve other
 * places that copy an id; the download of a text as a file serves the pages
 * that export one (a session's raw log, a run's detail).
 * @module @lyteboat/studio-web/client/studio-code-body
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CopyIcon } from './studio-icons.tsx'

const STUDIO_COPIED_MS = 1200
/** How long a download's object URL outlives the click that starts it. */
const STUDIO_DOWNLOAD_URL_TTL_MS = 1000

/** Put `value` on the clipboard; rejects when the browser refuses. */
export async function copyStudioText(value: string): Promise<void> {
  // The Clipboard API exists only in a secure context; a Studio served over plain
  // HTTP on an internal host copies through a hidden textarea instead.
  if (window.isSecureContext) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'absolute'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

/**
 * Hand the browser `text` as a file to save.
 * @param filename - the name the browser offers (`<sessionId>.jsonl`).
 * @param text - the file's content.
 * @param mime - its media type (`application/json`).
 */
export function downloadStudioFile(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), STUDIO_DOWNLOAD_URL_TTL_MS)
}

/** An icon button that copies `value`; `title` names it (`Copy session id`). */
export function StudioCopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async (): Promise<void> => {
    try {
      await copyStudioText(value)
    } catch {
      // The browser refused the copy (a permission prompt dismissed): the button keeps saying "Copy".
      setCopied(false)
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), STUDIO_COPIED_MS)
  }

  return (
    <button aria-label={`Copy ${title}`} className="icon-action-button" onClick={() => void copy()} title={copied ? `${title} copied` : `Copy ${title}`} type="button">
      <CopyIcon />
    </button>
  )
}

/** A code block whose copy button copies `value`. */
export function StudioCodeBody({ value, children }: { value: string; children: ReactNode }) {
  return (
    <div className="code-body">
      <div className="code-body-actions">
        <StudioCopyButton title="content" value={value} />
      </div>
      {children}
    </div>
  )
}
