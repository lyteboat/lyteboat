/**
 * Walk a copied designer template, resolving bindings into a literal-only tree.
 * A port of the reference implementation's template_engine/walker.py: `text` / `url` / `name` keep the
 * `{literalString}` wrapper, `hide` drops a subtree, a binding `dataSource`
 * with a `child` fans the child out once per item (ids suffixed `__i`), a
 * non-binding `dataSource` passes the child subtree through untouched for the
 * client to resolve per row, and every other binding becomes its raw value.
 * Style tokens are never read or written: the copy carries them.
 * @module @lyteboat/a2ui/walker
 */

import type { A2uiLog } from './transforms.ts'
import { SILENT_LOG } from './transforms.ts'
import { isA2uiRecord } from './a2ui-record.ts'

export type ComponentNode = { id: string; component: Record<string, Record<string, unknown>>; [key: string]: unknown }
export interface TemplateDocument { rootComponentId?: string; components?: ComponentNode[]; [key: string]: unknown }
export interface HierarchyShape { root: string | undefined; ui_ids: string[] | undefined | null }

/** The flat data the walker binds from; reads are recorded for the business payload. */
export class BoundPathTracker {
  readonly boundPaths = new Set<string>()

  constructor(private readonly flat: Record<string, unknown>) {}

  has(path: string): boolean {
    return Object.hasOwn(this.flat, path)
  }

  get(path: string): unknown {
    this.boundPaths.add(path)
    return this.flat[path]
  }
}

const BINDING_CONTRACT_FIELDS = new Set(['text', 'url', 'name'])

function typeProps(node: ComponentNode): [string, Record<string, unknown>] {
  const type = Object.keys(node.component)[0] ?? ''
  const props = node.component[type]
  return [type, isA2uiRecord(props) ? props : {}]
}

function isBindingLeaf(value: unknown): value is { path: string; literalString?: unknown } {
  return isA2uiRecord(value) && 'path' in value && Object.keys(value).every(key => key === 'path' || key === 'literalString')
}

type Scope = Record<string, unknown> | undefined

function resolveRef(binding: unknown, flat: BoundPathTracker, scope: Scope): unknown {
  if (!isA2uiRecord(binding)) return binding
  const path = binding['path']
  if (path === undefined || path === null) return binding['literalString'] ?? ''
  const key = String(path)
  if (scope !== undefined) {
    if (Object.hasOwn(scope, key)) return scope[key]
    if (key.startsWith('item.') && Object.hasOwn(scope, key.slice(5))) return scope[key.slice(5)]
  }
  if (flat.has(key)) return flat.get(key)
  if ('literalString' in binding) return binding['literalString']
  return ''
}

function resolveDeep(node: unknown, flat: BoundPathTracker, scope: Scope): unknown {
  if (isBindingLeaf(node)) return resolveRef(node, flat, scope)
  if (isA2uiRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveDeep(value, flat, scope)]))
  if (Array.isArray(node)) return node.map(value => resolveDeep(value, flat, scope))
  return node
}

function resolveProps(props: Record<string, unknown>, flat: BoundPathTracker, scope: Scope): void {
  for (const [field, value] of Object.entries(props)) {
    if (field === 'children') continue
    if (isBindingLeaf(value)) {
      const resolved = resolveRef(value, flat, scope)
      props[field] = BINDING_CONTRACT_FIELDS.has(field) ? { literalString: resolved } : resolved
    } else if (isA2uiRecord(value) || Array.isArray(value)) {
      props[field] = resolveDeep(value, flat, scope)
    }
  }
}

function takeChildren(props: Record<string, unknown>): string[] | undefined {
  const children = props['children']
  if (isA2uiRecord(children) && Array.isArray(children['explicitList'])) return [...children['explicitList'] as string[]]
  return undefined
}

function applyHierarchyFilter(map: Map<string, ComponentNode>, rootId: string, uiIds: string[] | null | undefined): Map<string, ComponentNode> {
  if (uiIds === undefined || uiIds === null || uiIds.length === 0) return map
  const root = map.get(rootId)
  if (root === undefined) return map
  const copy = structuredClone(root)
  const [, props] = typeProps(copy)
  const children = props['children']
  if (isA2uiRecord(children) && Array.isArray(children['explicitList'])) {
    const original = new Set(children['explicitList'] as string[])
    children['explicitList'] = uiIds.filter(id => original.has(id))
  }
  const next = new Map(map)
  next.set(rootId, copy)
  return next
}

interface WalkState {
  readonly map: Map<string, ComponentNode>
  readonly flat: BoundPathTracker
  readonly out: ComponentNode[]
  readonly log: A2uiLog
}

function renderSubtree(state: WalkState, cid: string, scope: Scope, suffix: string): string | undefined {
  const source = state.map.get(cid)
  if (source === undefined) return undefined
  const node = structuredClone(source)
  node.id = cid + suffix
  const [, props] = typeProps(node)
  if ('hide' in props) {
    if (pyTruthy(resolveRef(props['hide'], state.flat, scope))) return undefined
    delete props['hide']
  }
  const childrenIds = takeChildren(props)
  const dataSource = props['dataSource']
  const childTemplate = props['child']
  if (typeof childTemplate === 'string' && isBindingLeaf(dataSource)) {
    delete props['dataSource']
    delete props['child']
    resolveProps(props, state.flat, scope)
    props['children'] = { explicitList: fanOut(state, cid, dataSource, childTemplate, scope, suffix) }
  } else if (typeof childTemplate === 'string' && dataSource !== undefined && dataSource !== null) {
    resolveProps(props, state.flat, scope)
    emitRawSubtree(state, childTemplate)
  } else {
    if (childTemplate !== undefined && childTemplate !== null) {
      state.log.warn(`组件 '${cid}' 只有 child、没有可解析 dataSource(dataSource=${dataSource !== undefined && dataSource !== null ? 'True' : 'False'} child=True),按常规 prop 解析`)
    }
    resolveProps(props, state.flat, scope)
    if (childrenIds !== undefined) {
      const kept: string[] = []
      for (const childId of childrenIds) {
        const rendered = renderSubtree(state, childId, scope, suffix)
        if (rendered !== undefined) kept.push(rendered)
      }
      props['children'] = { explicitList: kept }
    }
  }
  state.out.push(node)
  return node.id
}

function emitRawSubtree(state: WalkState, cid: string): void {
  const emitted = new Set(state.out.map(node => node.id))
  const stack = [cid]
  while (stack.length > 0) {
    const id = stack.pop() as string
    const source = state.map.get(id)
    if (emitted.has(id) || source === undefined) continue
    const node = structuredClone(source)
    emitted.add(id)
    state.out.push(node)
    const [, props] = typeProps(node)
    const children = props['children']
    if (isA2uiRecord(children) && Array.isArray(children['explicitList'])) {
      stack.push(...(children['explicitList'] as unknown[]).filter((ref): ref is string => typeof ref === 'string'))
    }
    for (const key of ['child', 'emptyChild']) {
      const ref = props[key]
      if (typeof ref === 'string') stack.push(ref)
    }
  }
}

function fanOut(state: WalkState, cid: string, dataSource: unknown, childTemplate: string, scope: Scope, suffix: string): string[] {
  const array = resolveRef(dataSource, state.flat, scope)
  const ids: string[] = []
  if (!Array.isArray(array)) {
    state.log.warn(`组件 '${cid}' 的 dataSource 解析为非数组(type=${pyTypeName(array)}),无法 fan-out,行被丢弃`)
    return ids
  }
  array.forEach((item, index) => {
    const itemScope: Record<string, unknown> = isA2uiRecord(item) ? item : { item }
    const rendered = renderSubtree(state, childTemplate, itemScope, `${suffix}__${String(index)}`)
    if (rendered !== undefined) ids.push(rendered)
  })
  return ids
}

/** Python's `bool()`: empty strings, arrays and objects are false, as is 0. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType'
  if (typeof value === 'string') return 'str'
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (Array.isArray(value)) return 'list'
  return 'dict'
}

/**
 * Resolve a template into a literal-only payload under one hierarchy.
 * @param template - the designer document.
 * @param flat - the resolved manifest data (reads are recorded).
 * @param hierarchy - the root and the root's child filter.
 * @param log - the degradation sink.
 * @returns the template's top-level fields with `rootComponentId` and the emitted `components`.
 */
export function walk(template: TemplateDocument, flat: BoundPathTracker, hierarchy: HierarchyShape, log: A2uiLog = SILENT_LOG): Record<string, unknown> {
  let map = new Map<string, ComponentNode>((template.components ?? []).map(component => [component.id, component]))
  const rootId = hierarchy.root ?? template.rootComponentId
  if (typeof rootId !== 'string') throw new Error('template missing rootComponentId / hierarchy.root')
  map = applyHierarchyFilter(map, rootId, hierarchy.ui_ids)
  const out: ComponentNode[] = []
  renderSubtree({ map, flat, out, log }, rootId, undefined, '')
  const payload: Record<string, unknown> = Object.fromEntries(Object.entries(template).filter(([key]) => key !== 'components'))
  payload['rootComponentId'] = rootId
  payload['components'] = out
  return payload
}
