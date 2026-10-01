/**
 * The delta report: what lyteboat carries on top of the last imported dsh tag,
 * read from git alone. For every kernel package, the lines lyteboat changed in
 * upstream files (carried hunks) and the lines of lyteboat's own modules
 * (`src/lyteboat/`, `tests/lyteboat/`); for every lyteboat commit under `dsh/`, its
 * `Dist-Change` class, the extension it serves, and its exit condition.
 *
 * It also enforces the commit discipline, so it doubles as a gate:
 *
 * - every non-merge commit that touches a kernel package after the first import carries
 *   a `Dist-Change` trailer with a known class;
 * - an `extend` commit names its `dsh-compat/contract/extensions.yml` entry in
 *   `Dist-Extension`, and every entry is named by at least one commit;
 * - `fix` carries `Dist-Tests`, `backport` carries `Dist-Upstream`, `compat`
 *   and `drop` carry `Dist-Exit`, `policy` carries `Dist-Policy`;
 * - a `policy` commit edits only bundles' `cordis.patch.yml`.
 *
 *   node --import tsx scripts/dist/delta-report.ts [--check]
 *
 * `--check` prints only the violations and exits non-zero on any. A clone too
 * shallow to hold an import commit (CI's default checkout) has nothing to
 * read; the report says so and exits zero.
 * @module scripts/dist/delta-report
 */

import { pathToFileURL } from 'node:url'
import { git, kernelPackages, repoRoot } from './kernel.ts'
import { readExtensions } from './contract-check.ts'
import { IMPORT_TRAILER, lastImport } from './import-upstream.ts'

/** The change classes of the distribution, and the trailer each one requires beyond `Dist-Change`. */
export const CHANGE_CLASSES: Readonly<Record<string, string | undefined>> = {
  backport: 'Dist-Upstream',
  fix: 'Dist-Tests',
  extend: 'Dist-Extension',
  redesign: 'Dist-Tests',
  compat: 'Dist-Exit',
  drop: 'Dist-Exit',
  policy: 'Dist-Policy',
  build: undefined,
}

/** One commit under `dsh/`, as the report reads it. */
export interface DistCommit {
  sha: string
  date: string
  subject: string
  trailers: Map<string, string[]>
  files: string[]
}

/** Non-merge commits in `range` that touch a kernel package (files at `dsh/` itself are the distribution's own). */
function readCommits(range: string): DistCommit[] {
  const paths = kernelPackages().map(({ dir }) => `dsh/${dir}/`)
  const raw = git(repoRoot, ['log', '--no-merges', '--date=short', '--format=%x1e%H%x1f%ad%x1f%s%x1f%(trailers:unfold)%x1f', '--name-only', range, '--', ...paths])
  return raw.split('\x1e').filter(chunk => chunk.trim() !== '').map(chunk => {
    const [sha = '', date = '', subject = '', trailerText = '', fileText = ''] = chunk.split('\x1f')
    const trailers = new Map<string, string[]>()
    for (const line of trailerText.split('\n')) {
      const match = /^([A-Za-z-]+):\s*(.*)$/u.exec(line.trim())
      if (match?.[1] === undefined || match[2] === undefined) continue
      trailers.set(match[1], [...(trailers.get(match[1]) ?? []), match[2]])
    }
    return { sha, date, subject, trailers, files: fileText.split('\n').map(file => file.trim()).filter(file => file !== '') }
  })
}

/** Commits under `dsh/` since the first import that break the discipline, one line each. */
export function violations(commits: readonly DistCommit[]): string[] {
  const extensionIds = new Set(readExtensions().map(extension => extension.id))
  const named = new Set<string>()
  const found: string[] = []
  for (const commit of commits) {
    if (commit.trailers.has(IMPORT_TRAILER)) continue
    const where = `${commit.sha.slice(0, 10)} ${commit.subject}`
    const changeClass = commit.trailers.get('Dist-Change')?.[0]
    if (changeClass === undefined || !(changeClass in CHANGE_CLASSES)) {
      found.push(`${where}: touches dsh/ without a Dist-Change trailer naming one of ${Object.keys(CHANGE_CLASSES).join(', ')}`)
      continue
    }
    const required = CHANGE_CLASSES[changeClass]
    if (required !== undefined && !commit.trailers.has(required)) found.push(`${where}: a ${changeClass} change needs a ${required} trailer`)
    // A distribution policy changes what upstream's default composition turns on, never code.
    const outsidePatches = changeClass === 'policy' ? commit.files.filter(file => !file.endsWith('/cordis.patch.yml')) : []
    if (outsidePatches.length > 0) found.push(`${where}: a policy change edits bundles' cordis.patch.yml only, not ${outsidePatches.join(', ')}`)
    for (const id of commit.trailers.get('Dist-Extension') ?? []) {
      if (!extensionIds.has(id)) found.push(`${where}: Dist-Extension ${id} is not in dsh-compat/contract/extensions.yml`)
      named.add(id)
    }
  }
  for (const id of extensionIds) if (!named.has(id)) found.push(`dsh-compat/contract/extensions.yml: ${id} is named by no Dist-Extension commit`)
  return found
}

function numstat(from: string, paths: readonly string[]): { added: number; removed: number; files: number } {
  const out = git(repoRoot, ['diff', '--numstat', from, 'HEAD', '--', ...paths])
  let added = 0
  let removed = 0
  let files = 0
  for (const line of out.split('\n')) {
    const [plus, minus] = line.split('\t')
    if (plus === undefined || minus === undefined || plus === '') continue
    files += 1
    added += plus === '-' ? 0 : Number(plus)
    removed += minus === '-' ? 0 : Number(minus)
  }
  return { added, removed, files }
}

function report(base: string, commits: readonly DistCommit[]): string[] {
  const tag = git(repoRoot, ['log', '-1', '--format=%(trailers:key=Dist-Import,valueonly)', base]).trim()
  const lines = [`# Delta report: lyteboat on ${tag} (import ${base.slice(0, 10)})`, '', '## Per package', '',
    '| package | carried hunks (files, +/−) | lyteboat modules (files, +/−) | commits by class | oldest carry |', '|---|---|---|---|---|']
  const lyteboatCommits = commits.filter(commit => !commit.trailers.has(IMPORT_TRAILER))
  for (const { name, dir } of kernelPackages()) {
    const root = `dsh/${dir}`
    const owned = [`${root}/src/lyteboat`, `${root}/tests/lyteboat`]
    const carried = numstat(base, [root, ...owned.map(path => `:(exclude)${path}`)])
    const own = numstat(base, owned)
    const mine = lyteboatCommits.filter(commit => commit.files.some(file => file.startsWith(`${root}/`)))
    const byClass = new Map<string, number>()
    for (const commit of mine) {
      const changeClass = commit.trailers.get('Dist-Change')?.[0] ?? 'unclassified'
      byClass.set(changeClass, (byClass.get(changeClass) ?? 0) + 1)
    }
    const oldest = mine.map(commit => commit.date).sort()[0] ?? '—'
    const classes = [...byClass].map(([changeClass, count]) => `${changeClass} ${String(count)}`).join(', ') || '—'
    lines.push(`| ${name} | ${String(carried.files)}, +${String(carried.added)}/−${String(carried.removed)} | ${String(own.files)}, +${String(own.added)}/−${String(own.removed)} | ${classes} | ${oldest} |`)
  }
  lines.push('', '## Commits', '', '| commit | date | class | extension | exit | subject |', '|---|---|---|---|---|---|')
  for (const commit of lyteboatCommits) {
    const cell = (key: string): string => (commit.trailers.get(key) ?? []).join('; ') || '—'
    lines.push(`| ${commit.sha.slice(0, 10)} | ${commit.date} | ${cell('Dist-Change')} | ${cell('Dist-Extension')} | ${cell('Dist-Exit')} | ${commit.subject} |`)
  }
  lines.push('', '## Extensions', '', '| id | package | surface | exit |', '|---|---|---|---|')
  for (const extension of readExtensions()) lines.push(`| ${extension.id} | ${extension.package} | ${extension.surface} | ${extension.exit} |`)
  return lines
}

function main(): void {
  const check = process.argv.includes('--check')
  const base = lastImport()
  if (base === undefined) {
    const shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']) === 'true'
    console.log(shallow
      ? 'delta report: no Dist-Import commit in this shallow clone\'s history; skipped (fetch more history to report)'
      : 'delta report: no Dist-Import commit in this history; nothing is taken over yet')
    return
  }
  const first = git(repoRoot, ['log', '--format=%H', `--grep=^${IMPORT_TRAILER}: `, '--reverse', 'HEAD']).split('\n')[0] ?? base
  // Everything on the branch after the first import touches the kernel as lyteboat, whichever sync it follows.
  const commits = readCommits(`${first}..HEAD`)
  const found = violations(commits)
  if (!check) console.log(report(base, commits).join('\n'))
  for (const line of found) console.error(`delta: ${line}`)
  if (found.length > 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
