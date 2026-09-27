/**
 * An admin's hot-fix of an existing skill: the SKILL.md inside the agent's
 * directory, replaced whole. The file must be the one the skill was read from
 * (its sha256 as `If-Match`), must stay inside the agent directory through any
 * link, and the new text must keep the rules the skill loader and the router
 * enforce: YAML frontmatter between `---` lines (as dsh's filesystem provider
 * finds it), the same name, a description, lyteboat metadata that parses, and
 * required tools the agent registers and declares. A text the loader would
 * silently skip is refused here with the rule it breaks.
 * @module @lyteboat/studio-api/studio-skill-hotfix
 */

import { createHash, randomBytes } from 'node:crypto'
import { realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { load } from 'js-yaml'
import { lyteboatSkillMetaSchema } from '@lyteboat/contracts'
import type { StudioTool } from '@lyteboat/contracts/studio'
import { studioSchemaProblems } from './studio-api-router.ts'

/** A file's sha256, hex: what a hot-fix sends as `If-Match`. */
export function studioFileHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The real path of a skill file Studio may edit: one inside the agent directory.
 * @param file - the skill's file as the loader reports it.
 * @param agentDir - the agent directory.
 * @returns undefined for no file, a missing one, or one outside the directory.
 */
export function editableStudioSkillFile(file: string | undefined, agentDir: string): string | undefined {
  if (file === undefined) return undefined
  let real: string
  let dir: string
  try {
    real = realpathSync(file)
    dir = realpathSync(agentDir)
  } catch {
    // A file or directory that vanished is not editable; the caller answers as for no file.
    return undefined
  }
  return real.startsWith(`${dir}${sep}`) ? real : undefined
}

/** The frontmatter object, found the way dsh's filesystem provider finds it; undefined when there is none. */
function frontmatterOf(text: string): unknown {
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0 || text.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= text.length) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') return load(text.slice(firstLineEnd + 1, lineStart))
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Why a new SKILL.md text would break the skill; undefined when it keeps every rule.
 * @param text - the new text.
 * @param name - the skill's name, which must not change.
 * @param tools - the agent's tools.
 */
export function studioSkillFileProblem(text: string, name: string, tools: readonly StudioTool[]): string | undefined {
  let data: unknown
  try {
    data = frontmatterOf(text)
  } catch (error: unknown) {
    return `the frontmatter is not YAML: ${error instanceof Error ? error.message : String(error)}`
  }
  if (!isFrontmatterRecord(data)) return 'SKILL.md must start with a YAML frontmatter block between --- lines'
  if (data['name'] !== name) return `the name must stay "${name}"; renaming a skill is not a hot-fix`
  if (typeof data['description'] !== 'string' || data['description'].trim() === '') return 'the description must be a non-empty string: the router picks skills by it'
  const metadata = isFrontmatterRecord(data['metadata']) ? data['metadata']['lyteboat'] : undefined
  const parsed = lyteboatSkillMetaSchema.safeParse(metadata ?? {})
  if (!parsed.success) return `metadata.lyteboat is not valid: ${studioSchemaProblems(parsed.error, '(the object)')}`
  const declared = new Set(tools.filter(tool => tool.declared !== 'inherited').map(tool => tool.name))
  const missing = (parsed.data.requiredTools ?? []).filter(tool => !declared.has(tool))
  if (missing.length > 0) return `required tools must be registered and declared by this agent: ${missing.join(', ')}`
  return undefined
}

/** Replace a file whole through a temporary sibling and a rename, keeping its mode. */
export function replaceStudioFile(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporary, text, { mode: statSync(file).mode & 0o777 })
  renameSync(temporary, file)
}
