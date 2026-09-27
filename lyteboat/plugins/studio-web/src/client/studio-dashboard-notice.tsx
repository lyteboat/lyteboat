/**
 * The card a Dashboard view shows in place of its figures while they load or
 * when they cannot be read: the view's heading, a title, and a line of text.
 * @module @lyteboat/studio-web/client/studio-dashboard-notice
 */

/** `heading` names the view (`Agent Health`, `Dashboard`). */
export function StudioDashboardNotice({ heading, title, text }: { heading: string; title: string; text: string }) {
  return (
    <section className="workspace-surface dashboard-loading-state">
      <div className="surface-heading"><span>{heading}</span></div>
      <h1>{title}</h1>
      <p>{text}</p>
    </section>
  )
}
