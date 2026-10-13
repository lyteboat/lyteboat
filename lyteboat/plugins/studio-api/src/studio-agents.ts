/**
 * The agent radar's answer: every agent the catalog serves, with its version,
 * its digest, and the release lock beside it when there is one; an agent
 * whose directory no longer has the digest its lock names deviates from its
 * release (a hot-fix, an edit), and a `lyteboat serve --release` of that lock
 * would refuse it. An agent with a card components module is listed with the
 * module's content hash, so the pages fetch it again once it changes. The
 * agents the catalog could not serve are listed with why.
 * @module @lyteboat/studio-api/studio-agents
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentCatalogEntry, AgentCatalogFailure } from '@lyteboat/agent-catalog'
import { LYTEBOAT_AGENT_RELEASE_FILE, lyteboatAgentReleaseSchema } from '@lyteboat/contracts'
import { STUDIO_AGENT_CARD_COMPONENTS_FILE, type StudioAgent, type StudioAgentsAnswer } from '@lyteboat/contracts/studio'
import { studioSchemaProblems } from './studio-api-router.ts'

// The file `lyteboat release` writes beside the agent.

type StudioReleaseLock =
  | { kind: 'none' }
  | { kind: 'locked'; version: string; digest: string }
  | { kind: 'unreadable'; problem: string }

function releaseLockOf(entry: AgentCatalogEntry): StudioReleaseLock {
  const file = join(entry.dir, LYTEBOAT_AGENT_RELEASE_FILE)
  if (!existsSync(file)) return { kind: 'none' }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error: unknown) {
    return { kind: 'unreadable', problem: `${LYTEBOAT_AGENT_RELEASE_FILE} is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = lyteboatAgentReleaseSchema.safeParse(raw)
  if (!parsed.success) return { kind: 'unreadable', problem: `${LYTEBOAT_AGENT_RELEASE_FILE} is not a release lock: ${studioSchemaProblems(parsed.error, '(the file)')}` }
  return { kind: 'locked', version: parsed.data.agent.version, digest: parsed.data.agent.digest }
}

function studioAgentOf(entry: AgentCatalogEntry): StudioAgent {
  const lock = releaseLockOf(entry)
  // The digest hashes every file of the agent, so the module's hash is already there.
  const cardComponents = entry.files[STUDIO_AGENT_CARD_COMPONENTS_FILE]
  return {
    id: entry.id,
    ...entry.name === undefined ? {} : { name: entry.name },
    ...entry.description === undefined ? {} : { description: entry.description },
    ...entry.order === undefined ? {} : { order: entry.order },
    ...entry.identity.version === undefined ? {} : { version: entry.identity.version },
    digest: entry.identity.digest,
    ...lock.kind === 'locked' ? { release: { version: lock.version, digest: lock.digest } } : {},
    ...lock.kind === 'unreadable' ? { releaseProblem: lock.problem } : {},
    deviates: lock.kind === 'locked' && lock.digest !== entry.identity.digest,
    ...cardComponents === undefined ? {} : { cardComponents: { version: cardComponents } },
  }
}

/**
 * Build the answer of `GET agents`.
 * @param agents - the catalog's agents.
 * @param failures - the catalog's failures.
 */
export function studioAgentsAnswer(agents: readonly AgentCatalogEntry[], failures: readonly AgentCatalogFailure[]): StudioAgentsAnswer {
  return {
    agents: agents.map(studioAgentOf),
    failures: failures.map(failure => ({ id: failure.id, reason: failure.reason })),
  }
}
