/**
 * What the pages under `/evals/:agentId` share, as the original Studio's
 * Evals agent scope: the agent's case files and its runs (newest first), read
 * when the agent is opened, each reloadable on its own, with the error of its
 * last reading. The pages stay mounted while a reading runs, so a dialog or a
 * navigation is never cut off by a refresh; a reading that answers after a
 * newer one is dropped. Each agent mounts its own scope.
 * @module @lyteboat/studio-web/client/studio-evals-agent-scope
 */

import { useCallback, useMemo } from 'react'
import { Navigate, Outlet, useOutletContext, useParams } from 'react-router-dom'
import type { StudioEvalCaseFile, StudioEvalRun } from '@lyteboat/contracts/studio'
import { studioApi } from './studio-api-client.ts'
import { useStudioReading } from './studio-call-state.ts'

/** The agent's eval data; `null` until its first reading answers. */
interface StudioEvalsAgentContext {
  agentId: string
  caseFiles: StudioEvalCaseFile[] | null
  casesError: string | null
  runs: StudioEvalRun[] | null
  runsError: string | null
  reloadCases(): Promise<void>
  reloadRuns(): Promise<void>
}

/** The scope's data, for a page under `/evals/:agentId`. */
export function useStudioEvalsAgent(): StudioEvalsAgentContext {
  return useOutletContext<StudioEvalsAgentContext>()
}

function StudioEvalsAgentData({ agentId }: { agentId: string }) {
  const cases = useStudioReading(useCallback(async () => (await studioApi.evalCases(agentId)).files, [agentId]))
  const runs = useStudioReading(useCallback(async () => (await studioApi.evalRuns(agentId)).runs, [agentId]))
  const { reload: reloadCases } = cases
  const { reload: reloadRuns } = runs

  const context = useMemo((): StudioEvalsAgentContext => ({
    agentId,
    caseFiles: cases.answer,
    casesError: cases.error,
    runs: runs.answer,
    runsError: runs.error,
    reloadCases,
    reloadRuns,
  }), [agentId, cases.answer, cases.error, runs.answer, runs.error, reloadCases, reloadRuns])
  return <Outlet context={context} />
}

/** The element of `/evals/:agentId`; a new agent mounts a new scope, so no page shows the previous agent's data. */
export function StudioEvalsAgentScope() {
  const { agentId } = useParams<{ agentId: string }>()
  if (agentId === undefined) return <Navigate replace to="/evals" />
  return <StudioEvalsAgentData agentId={agentId} key={agentId} />
}
