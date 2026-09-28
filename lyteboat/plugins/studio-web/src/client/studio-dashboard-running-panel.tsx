/**
 * The static view's Running messages panel, as the original Studio's: the
 * turns serve processes are running now, in total and per agent (the agents
 * running none are left out). It reads them on mount and every five seconds
 * after each answer, skipping a reading while the tab is hidden; a failed
 * reading shows the panel as unavailable until one succeeds.
 * @module @lyteboat/studio-web/client/studio-dashboard-running-panel
 */

import { useEffect, useState } from 'react'
import type { StudioDashboardRunning } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'

const STUDIO_RUNNING_POLL_MS = 5000

/** The latest reading, and whether the last one failed. */
function useStudioRunningPoll(): { running: StudioDashboardRunning; failed: boolean } {
  const [running, setRunning] = useState<StudioDashboardRunning>({ total: 0, agents: [] })
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const read = async (): Promise<void> => {
      let next: StudioDashboardRunning
      try {
        next = await studioApi.dashboardRunning()
      } catch {
        // The failure is the panel's state: it says Unavailable until a reading succeeds.
        if (!cancelled) setFailed(true)
        return
      }
      if (cancelled) return
      setRunning(next)
      setFailed(false)
    }
    const tick = async (force: boolean): Promise<void> => {
      if (cancelled) return
      if (force || !document.hidden) await read()
      if (!cancelled) timer = window.setTimeout(() => void tick(false), STUDIO_RUNNING_POLL_MS)
    }
    void tick(true)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  return { running, failed }
}

function StudioRunningBody({ running, failed }: { running: StudioDashboardRunning; failed: boolean }) {
  const busy = running.agents.filter(agent => agent.running > 0)
  if (failed) return <div className="dashboard-chart-empty">Unavailable</div>
  if (busy.length === 0) return <div className="dashboard-chart-empty">No running messages</div>
  return (
    <div className="dashboard-distribution-list">
      {busy.map(agent => (
        <div className="dashboard-distribution-item" key={agent.agentId}>
          <div className="dashboard-distribution-item-head">
            <div className="dashboard-distribution-copy"><span title={agent.agentId}>{agent.agentLabel}</span></div>
            <strong>{agent.running}</strong>
          </div>
        </div>
      ))}
    </div>
  )
}

/** The Running messages panel. */
export function StudioDashboardRunningPanel() {
  const { running, failed } = useStudioRunningPoll()
  return (
    <article className="workspace-surface dashboard-insight-panel">
      <div className="surface-heading dashboard-insight-heading">
        <span>Running messages</span>
        <b>{failed ? '—' : `${String(running.total)} running`}</b>
      </div>
      <StudioRunningBody failed={failed} running={running} />
    </article>
  )
}
