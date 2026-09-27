/**
 * A2UI payload validation: the event-level contract (which top-level fields
 * each event allows and requires), the component level (ids, references,
 * binding shapes) and data coverage. A port of the reference implementation's contract_models.py,
 * validator.py and guard.py.
 * @module @lyteboat/a2ui/contract
 */

import type { A2uiLog } from './transforms.ts'
import { SILENT_LOG } from './transforms.ts'
import { isA2uiRecord } from './a2ui-record.ts'

const SUPPORTED_EVENTS = new Set(['beginRendering', 'surfaceUpdate', 'dataModelUpdate', 'deleteSurface'])

const ALLOWED_BY_EVENT: Record<string, Set<string>> = {
  beginRendering: new Set(['event', 'version', 'surfaceId', 'rootComponentId', 'components', 'catalogId', 'style', 'data', 'showType', 'hideVoteRecorder', 'hideServiceMessage', 'exposureData', 'businessPayload']),
  surfaceUpdate: new Set(['event', 'version', 'surfaceId', 'components', 'rootComponentId', 'exposureData', 'businessPayload']),
  dataModelUpdate: new Set(['event', 'version', 'surfaceId', 'data', 'exposureData']),
  deleteSurface: new Set(['event', 'version', 'surfaceId']),
}

/**
 * What one A2UI client renders: the component types it knows (an unknown type
 * is reported, as in the reference implementation, not rejected) and, per type, the fields whose value
 * is a `{path}` / `{literalString}` binding.
 */
export interface A2uiComponentCatalog {
  types: readonly string[]
  bindingFields: Readonly<Record<string, readonly string[]>>
}

/**
 * The default when a composition names no catalog: the domain-neutral
 * components of the reference client's catalog (validator.py) — layout,
 * text, buttons, images and plain shapes — with their binding fields. A
 * deployment whose client renders more (charts, business widgets) passes its
 * own catalog through `RenderToolOptions.components`.
 */
export const DEFAULT_A2UI_COMPONENT_CATALOG: A2uiComponentCatalog = {
  types: ['Row', 'Column', 'Card', 'List', 'CollapseList', 'Table', 'Popup', 'Text', 'RichText', 'Image', 'Icon', 'Tag', 'Circle', 'Divider', 'Line', 'Button'],
  bindingFields: {
    Text: ['text'], RichText: ['text'], Image: ['url'], Icon: ['name'], Tag: ['text'], Button: ['text'], List: ['dataSource'],
    CollapseList: ['dataSource', 'expandText', 'foldText'],
  },
}
const COMMON_BINDING_FIELDS = ['hide']
const STRICT_BINDING_FIELDS = new Set(['text', 'url', 'name', ...COMMON_BINDING_FIELDS])

function nonEmpty(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

/**
 * Validate the top-level event contract; throws with the reference messages.
 * @param payload - the event payload.
 */
export function validateEventPayload(payload: unknown): void {
  if (!isA2uiRecord(payload)) throw new Error('payload must be a dict')
  const event = payload['event'] ?? 'beginRendering'
  if (typeof event !== 'string' || !SUPPORTED_EVENTS.has(event)) throw new Error(`Unsupported event: ${String(event)}`)
  const allowed = ALLOWED_BY_EVENT[event] as Set<string>
  const illegal = Object.keys(payload).filter(key => !allowed.has(key)).sort()
  if (illegal.length > 0) throw new Error(`${event} contains unsupported fields: [${illegal.map(key => `'${key}'`).join(', ')}]`)
  switch (event) {
    case 'beginRendering': {
      if (!nonEmpty(payload['surfaceId'])) throw new Error('beginRendering requires surfaceId')
      if (!nonEmpty(payload['rootComponentId'])) throw new Error('beginRendering requires rootComponentId')
      if (('components' in payload) === nonEmpty(payload['catalogId'])) throw new Error('beginRendering requires exactly one of components or catalogId')
      return
    }
    case 'surfaceUpdate': {
      if (!nonEmpty(payload['surfaceId'])) throw new Error('surfaceUpdate requires surfaceId')
      if (!('components' in payload) || payload['components'] === null || payload['components'] === undefined) throw new Error('surfaceUpdate requires components')
      if (!Array.isArray(payload['components'])) throw new Error('surfaceUpdate requires components to be a list')
      return
    }
    case 'dataModelUpdate': {
      if (!nonEmpty(payload['surfaceId'])) throw new Error('dataModelUpdate requires surfaceId')
      if (!('data' in payload) || payload['data'] === null || payload['data'] === undefined) throw new Error('dataModelUpdate requires data')
      if (!isA2uiRecord(payload['data'])) throw new Error('dataModelUpdate requires data to be a dict')
      return
    }
    default:
      if (!nonEmpty(payload['surfaceId'])) throw new Error('deleteSurface requires surfaceId')
  }
}

interface ValidationResult {
  ok: boolean
  /** Messages in detection order; `entries` pairs each with its code. */
  errors: string[]
  /** Distinct codes in first-detection order. */
  errorCodes: string[]
  entries: { code: string; message: string }[]
}

function componentReferences(props: Record<string, unknown>): string[] {
  const refs: string[] = []
  const children = props['children']
  if (isA2uiRecord(children)) {
    if (Array.isArray(children['explicitList'])) refs.push(...(children['explicitList'] as unknown[]).filter((ref): ref is string => typeof ref === 'string' && ref !== ''))
  } else if (Array.isArray(children)) {
    refs.push(...(children as unknown[]).filter((ref): ref is string => typeof ref === 'string' && ref !== ''))
  }
  for (const key of ['child', 'emptyChild']) {
    const ref = props[key]
    if (typeof ref === 'string' && ref !== '') refs.push(ref)
  }
  return refs
}

/**
 * Validate the component layer: duplicate ids, entry shapes, dangling
 * references, binding XOR, root reference. An unsupported component type is
 * reported to the log, as in the reference implementation, not counted as an error.
 * @param payload - the rendered payload.
 * @param log - where unsupported types are reported.
 * @param catalog - the client's component catalog; {@link DEFAULT_A2UI_COMPONENT_CATALOG} by default.
 */
export function validatePayload(payload: unknown, log: A2uiLog = SILENT_LOG, catalog: A2uiComponentCatalog = DEFAULT_A2UI_COMPONENT_CATALOG): ValidationResult {
  const entries: { code: string; message: string }[] = []
  const add = (code: string, message: string): void => { entries.push({ code, message }) }
  const done = (): ValidationResult => ({
    ok: entries.length === 0,
    errors: entries.map(entry => entry.message),
    errorCodes: [...new Set(entries.map(entry => entry.code))],
    entries,
  })
  if (!isA2uiRecord(payload)) {
    add('A2UI_PAYLOAD_INVALID', 'payload must be a dict')
    return done()
  }
  const components = payload['components'] ?? []
  if (!Array.isArray(components)) {
    add('A2UI_COMPONENTS_INVALID', 'components must be a list')
    return done()
  }
  const supportedTypes = new Set(catalog.types)
  const ids = new Set<string>()
  for (const entry of components) {
    if (!isA2uiRecord(entry)) continue
    const id = entry['id']
    if (typeof id !== 'string' || id === '') continue
    if (ids.has(id)) add('A2UI_COMPONENT_ID_DUPLICATE', `Duplicate component id: ${id}`)
    ids.add(id)
  }
  components.forEach((entry, index) => {
    if (!isA2uiRecord(entry)) {
      add('A2UI_COMPONENT_ENTRY_INVALID', `components[${String(index)}] must be a dict`)
      return
    }
    const id = typeof entry['id'] === 'string' ? entry['id'] : `<component@${String(index)}>`
    const component = entry['component']
    if (!isA2uiRecord(component) || Object.keys(component).length !== 1) {
      add('A2UI_COMPONENT_OBJECT_INVALID', `Component '${id}' must have a component object that is a dict with exactly one key`)
      return
    }
    const [type, props] = Object.entries(component)[0] as [string, unknown]
    if (!supportedTypes.has(type)) log.warn(`Unsupported A2UI component type: ${type} (component id=${id} index=${String(index)})`)
    if (!isA2uiRecord(props)) {
      add('A2UI_COMPONENT_PROPS_INVALID', `Component '${id}' props for type '${type}' must be a dict`)
      return
    }
    for (const ref of componentReferences(props)) {
      if (!ids.has(ref)) add('A2UI_COMPONENT_REF_MISSING', `Component '${id}' references missing component id: ${ref}`)
    }
    const fields = new Set([...catalog.bindingFields[type] ?? [], ...COMMON_BINDING_FIELDS])
    for (const field of fields) {
      if (!(field in props)) continue
      const binding = props[field]
      const bindingShaped = isA2uiRecord(binding) && ('path' in binding || 'literalString' in binding)
      if (!STRICT_BINDING_FIELDS.has(field) && !bindingShaped) continue
      if (!isA2uiRecord(binding)) {
        add('A2UI_BINDING_INVALID', `Component '${id}' field '${field}' binding must be a dict`)
        continue
      }
      if (nonEmpty(binding['path']) === nonEmpty(binding['literalString'])) {
        add('A2UI_BINDING_XOR', `Component '${id}' field '${field}' must contain exactly one of 'path' or 'literalString'`)
      }
    }
  })
  const rootId = payload['rootComponentId']
  if (typeof rootId === 'string' && rootId !== '' && !ids.has(rootId)) add('A2UI_ROOT_REF_MISSING', `rootComponentId '${rootId}' is not found in components`)
  return done()
}

/** Ids of row-template subtrees: descendants of a `child` whose owner still carries a `dataSource` after the walk. */
export function rowTemplateIds(payload: Record<string, unknown>): Set<string> {
  const components = payload['components']
  const result = new Set<string>()
  if (!Array.isArray(components)) return result
  const propsById = new Map<string, Record<string, unknown>>()
  for (const entry of components) {
    if (!isA2uiRecord(entry) || typeof entry['id'] !== 'string' || !isA2uiRecord(entry['component']) || Object.keys(entry['component']).length !== 1) continue
    const props = Object.values(entry['component'])[0]
    if (isA2uiRecord(props)) propsById.set(entry['id'], props)
  }
  const stack: string[] = []
  for (const props of propsById.values()) {
    if (!('dataSource' in props)) continue
    const child = props['child']
    if (typeof child === 'string' && child !== '') stack.push(child)
  }
  while (stack.length > 0) {
    const id = stack.pop() as string
    const props = propsById.get(id)
    if (result.has(id) || props === undefined) continue
    result.add(id)
    const children = props['children']
    if (isA2uiRecord(children) && Array.isArray(children['explicitList'])) stack.push(...(children['explicitList'] as unknown[]).filter((ref): ref is string => typeof ref === 'string'))
    for (const key of ['child', 'emptyChild']) {
      const ref = props[key]
      if (typeof ref === 'string') stack.push(ref)
    }
  }
  return result
}

/** Warnings for `path` bindings that name keys absent from `payload.data`. */
function validateDataCoverage(payload: Record<string, unknown>): string[] {
  const data = payload['data']
  if (!isA2uiRecord(data)) return []
  const keys = new Set(Object.keys(data))
  const warnings: string[] = []
  const rows = rowTemplateIds(payload)
  const components = payload['components']
  if (!Array.isArray(components)) return []
  for (const entry of components) {
    if (!isA2uiRecord(entry)) continue
    const id = typeof entry['id'] === 'string' ? entry['id'] : '?'
    if (rows.has(id)) continue
    const component = entry['component']
    if (!isA2uiRecord(component)) continue
    for (const props of Object.values(component)) {
      if (!isA2uiRecord(props)) continue
      for (const [field, value] of Object.entries(props)) {
        if (!isA2uiRecord(value)) continue
        const path = value['path']
        if (path === null || path === undefined) continue
        if (value['literalString'] !== null && value['literalString'] !== undefined) continue
        if (typeof path === 'string' && path !== '' && !keys.has(path) && !path.startsWith('item.')) {
          warnings.push(`[DATA_COVERAGE] Component '${id}' field '${field}' references path '${path}' not found in payload.data`)
        }
      }
    }
  }
  return warnings
}

export interface GuardResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Every validation layer over one payload; `strict` turns event-contract
 * violations into errors instead of warnings. Each component error carries
 * its own code (the reference implementation paired codes and messages by index over a deduplicated
 * code list, mislabelling from the third error on).
 */
export function validateFullPayload(payload: Record<string, unknown>, options: { strict?: boolean; log?: A2uiLog; catalog?: A2uiComponentCatalog } = {}): GuardResult {
  const strict = options.strict ?? true
  const errors: string[] = []
  const warnings: string[] = []
  try {
    validateEventPayload(payload)
  } catch (error: unknown) {
    const message = `[EVENT_CONTRACT] ${error instanceof Error ? error.message : String(error)}`
    if (strict) errors.push(message)
    else warnings.push(message)
  }
  const result = validatePayload(payload, options.log, options.catalog)
  for (const { code, message } of result.entries) errors.push(`[${code}] ${message}`)
  warnings.push(...validateDataCoverage(payload))
  return { ok: errors.length === 0, errors, warnings }
}
