/**
 * Load a card's template bundle into the caller's cache: `template.json`,
 * `manifest.yaml` (`paths`, `args`, `emission_mode`), `business_hierarchy.yaml`
 * (`default`, `hierarchies`) and the optional `compute.js` ESM module (named
 * exports: the manifest's computed functions, plus the `digest(raw, flat)`
 * hook). A port of the reference implementation's template_engine/loader.py
 * with `compute.py` replaced by an ES module.
 * @module @lyteboat/a2ui/loader
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { ComputeModule, ManifestPaths } from './resolver.ts'
import type { TemplateDocument } from './walker.ts'
import type { LyteboatCardEmission } from '@lyteboat/contracts'
import { isA2uiRecord } from './a2ui-record.ts'

export type ComputeHook = (raw: Record<string, unknown>, flat: Record<string, unknown>) => unknown

/** One card's resolved authoring artifacts. */
export interface TemplateBundle {
  readonly name: string
  readonly template: TemplateDocument
  readonly manifest: ManifestPaths
  readonly hierarchies: Record<string, { root?: string; ui_ids?: string[] }>
  readonly defaultHierarchy: string
  readonly argSpecs: Record<string, Record<string, unknown>>
  readonly compute: ComputeModule | undefined
  readonly digest: ComputeHook | undefined
  readonly emissionMode: LyteboatCardEmission | undefined
  readonly mtimes: string
}

const FILES = ['template.json', 'manifest.yaml', 'business_hierarchy.yaml', 'compute.js'] as const

/** The names Node gives a module's exports object as a whole: `default`, and for a CommonJS file on newer releases `module.exports`. */
const WHOLE_EXPORTS_NAMES: ReadonlySet<string> = new Set(['default', 'module.exports'])

/** Every emission mode; the record type holds it equal to the contract's union in both directions. */
const EMISSION_MODES: Readonly<Record<LyteboatCardEmission, true>> = { immediate: true, deferred: true, deferred_discard: true }

function mtimeOf(path: string): number {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.mtimeMs : 0
  } catch {
    return 0
  }
}

function fileMtimes(cardDir: string): string {
  return FILES.map(name => String(mtimeOf(join(cardDir, name)))).join(',')
}

/** A present YAML file must be a mapping: a mis-indented manifest must not render a blank card. */
function readYaml(path: string): Record<string, unknown> {
  if (mtimeOf(path) === 0) return {}
  const doc: unknown = parseYaml(readFileSync(path, 'utf8'))
  if (doc === null || doc === undefined) return {}
  if (!isA2uiRecord(doc)) throw new Error(`${path} 必须是 YAML 映射，实际是 ${Array.isArray(doc) ? 'list' : typeof doc}`)
  return doc
}

/** A present top-level key must be a mapping, for the same reason. */
function mappingAt(doc: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = doc[key]
  if (value === undefined || value === null) return {}
  if (!isA2uiRecord(value)) throw new Error(`${path} 的 ${key} 必须是映射，实际是 ${Array.isArray(value) ? 'list' : typeof value}`)
  return value
}

function isEmissionMode(value: string): value is LyteboatCardEmission {
  return Object.hasOwn(EMISSION_MODES, value)
}

/** A present `emission_mode` must name a mode: a misspelt one must not show a deferred card at once. */
function emissionModeOf(value: unknown, path: string): LyteboatCardEmission | undefined {
  if (value === undefined || value === null) return undefined
  const mode = String(value).trim()
  if (!isEmissionMode(mode)) throw new Error(`${path}: emission_mode ${JSON.stringify(value)} is not one of ${Object.keys(EMISSION_MODES).join(', ')}`)
  return mode
}

async function loadCompute(cardDir: string): Promise<ComputeModule | undefined> {
  const path = join(cardDir, 'compute.js')
  const mtime = mtimeOf(path)
  if (mtime === 0) return undefined
  // The query defeats the ESM cache when the file changed on disk.
  const url = `${pathToFileURL(path).href}?mtime=${String(mtime)}`
  const namespace: ComputeModule = await import(url)
  const names = Object.keys(namespace)
  // A CommonJS file whose exports Node cannot name, or an object exported as the default, reaches the
  // manifest as no function at all: every computed entry would degrade instead of the card failing.
  if (names.length > 0 && names.every(name => WHOLE_EXPORTS_NAMES.has(name))) {
    throw new Error(`${path} is not an ES module with named exports: it exports only its default`)
  }
  return namespace
}

function hookOf(compute: ComputeModule | undefined, name: string): ComputeHook | undefined {
  const candidate = compute?.[name]
  return typeof candidate === 'function' ? candidate as ComputeHook : undefined
}

/** Whether `root/card/template.json` exists. */
export function isCardDir(root: string, card: string): boolean {
  return mtimeOf(join(root, card, 'template.json')) !== 0
}

/**
 * Load the bundle for `root/card/`, or return the one `cache` holds while its files are unchanged.
 * @param root - the templates root directory.
 * @param card - the card directory name.
 * @param cache - the caller's bundles by card, which this load updates.
 * @throws on a missing card or template, a malformed template, manifest or hierarchy file, an
 * `emission_mode` outside the three modes, and a `compute.js` that exports only its default.
 */
export async function loadBundle(root: string, card: string, cache: Map<string, TemplateBundle>): Promise<TemplateBundle> {
  const cardDir = join(root, card)
  let isDir = false
  try {
    isDir = statSync(cardDir).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new Error(`template 卡目录不存在: ${card} (路径: ${cardDir})`)
  const mtimes = fileMtimes(cardDir)
  const cached = cache.get(card)
  if (cached !== undefined && cached.mtimes === mtimes) return cached
  const templatePath = join(cardDir, 'template.json')
  if (mtimeOf(templatePath) === 0) throw new Error(`template.json 不存在: ${templatePath}`)
  let templateDoc: unknown
  try {
    templateDoc = JSON.parse(readFileSync(templatePath, 'utf8'))
  } catch (error: unknown) {
    throw new Error(`${templatePath} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!isA2uiRecord(templateDoc) || !Array.isArray(templateDoc['components'])) throw new Error(`${templatePath} 必须是带 components 列表的对象`)
  const template = templateDoc as TemplateDocument
  const manifestPath = join(cardDir, 'manifest.yaml')
  const manifestDoc = readYaml(manifestPath)
  const manifest = mappingAt(manifestDoc, 'paths', manifestPath) as ManifestPaths
  const argSpecs = mappingAt(manifestDoc, 'args', manifestPath) as Record<string, Record<string, unknown>>
  const emissionMode = emissionModeOf(manifestDoc['emission_mode'], manifestPath)
  const hierarchyPath = join(cardDir, 'business_hierarchy.yaml')
  const hierarchyDoc = readYaml(hierarchyPath)
  const hierarchies = mappingAt(hierarchyDoc, 'hierarchies', hierarchyPath) as TemplateBundle['hierarchies']
  const declaredDefault = hierarchyDoc['default']
  const defaultHierarchy = typeof declaredDefault === 'string' && declaredDefault !== '' ? declaredDefault : Object.keys(hierarchies)[0] ?? card
  const compute = await loadCompute(cardDir)
  const bundle: TemplateBundle = {
    name: card,
    template,
    manifest,
    hierarchies,
    defaultHierarchy,
    argSpecs,
    compute,
    digest: hookOf(compute, 'digest'),
    emissionMode,
    mtimes,
  }
  cache.set(card, bundle)
  return bundle
}
