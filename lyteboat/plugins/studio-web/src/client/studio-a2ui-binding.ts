/**
 * An A2UI card's data, without React: the components of a `beginRendering`
 * payload by id, and the values its bindings name, ported from the reference
 * implementation's renderer (`static/a2ui-renderer.js`). A binding is
 * `{path}` (looked up in the row's scope first, then in the payload's `data`;
 * a found value that is itself a binding is resolved again, three levels at
 * most) or `{literalString}` (which may wrap a binding); `{path}` with a
 * `literalString` beside it falls back to the literal. A list row's scope is
 * its item's own fields plus `item`. Lengths follow the reference: a number is
 * a percentage for width and height and pixels elsewhere, a string passes as
 * written, and the named text sizes take the Studio's type scale.
 * @module @lyteboat/studio-web/client/studio-a2ui-binding
 */

import type { JsonValue } from '@lyteboat/contracts'

/** A JSON object. */
export type StudioA2uiObject = { [key: string]: JsonValue }

/** One `beginRendering` payload, ready to draw. */
export interface StudioA2uiSurface {
  surfaceId: string
  rootId: string
  /** Each component's type and props, by id. */
  components: Map<string, { type: string; props: StudioA2uiObject }>
  data: StudioA2uiObject
}

/** Whether a value is a JSON object. */
export function isStudioA2uiObject(value: JsonValue | undefined): value is StudioA2uiObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The surface a card payload draws; null for any event but `beginRendering`
 * (the default) or a payload without its root.
 * @param payload - the `ui_data` of an A2UI frame.
 */
export function studioA2uiSurface(payload: JsonValue): StudioA2uiSurface | null {
  if (!isStudioA2uiObject(payload)) return null
  const event = payload['event'] ?? 'beginRendering'
  const surfaceId = payload['surfaceId']
  const rootId = payload['rootComponentId']
  if (event !== 'beginRendering' || typeof surfaceId !== 'string' || typeof rootId !== 'string') return null
  const components = new Map<string, { type: string; props: StudioA2uiObject }>()
  for (const entry of Array.isArray(payload['components']) ? payload['components'] : []) {
    if (!isStudioA2uiObject(entry) || typeof entry['id'] !== 'string' || !isStudioA2uiObject(entry['component'])) continue
    const [type, props] = Object.entries(entry['component'])[0] ?? []
    if (type === undefined) continue
    components.set(entry['id'], { type, props: isStudioA2uiObject(props) ? props : {} })
  }
  const data = payload['data']
  return { surfaceId, rootId, components, data: isStudioA2uiObject(data) ? data : {} }
}

function isBinding(value: JsonValue | undefined): value is StudioA2uiObject {
  return isStudioA2uiObject(value) && ('path' in value || 'literalString' in value)
}

/**
 * A dotted path's value.
 * @param source - where the path starts.
 * @param path - `a.b.c`.
 */
function studioA2uiPathValue(source: JsonValue | undefined, path: string): JsonValue | undefined {
  if (path === '') return undefined
  let current = source
  for (const part of path.split('.')) {
    if (!isStudioA2uiObject(current) && !Array.isArray(current)) return undefined
    current = Array.isArray(current) ? current[Number(part)] : current[part]
  }
  return current
}

function shownValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * The text a binding shows.
 * @param binding - a `{path}` / `{literalString}` binding, or nothing.
 * @param scope - the list row's scope, if any.
 * @param data - the payload's data.
 */
export function studioA2uiText(binding: JsonValue | undefined, scope: StudioA2uiObject | null, data: StudioA2uiObject, depth = 0): string {
  if (!isStudioA2uiObject(binding) || depth > 3) return ''
  const path = binding['path']
  const literal = binding['literalString']
  if (path !== undefined) {
    const found = scope === null ? undefined : studioA2uiPathValue(scope, String(path))
    const value = found === undefined ? studioA2uiPathValue(data, String(path)) : found
    if (value !== undefined) return isBinding(value) ? studioA2uiText(value, null, data, depth + 1) : shownValue(value)
    return literal === undefined ? '' : shownValue(literal)
  }
  if (literal === undefined) return ''
  return isBinding(literal) ? studioA2uiText(literal, scope, data, depth + 1) : shownValue(literal)
}

/**
 * The raw value a binding names; a value that is no binding is itself.
 * @param binding - a binding, or a value the server already resolved.
 * @param scope - the list row's scope, if any.
 * @param data - the payload's data.
 */
export function studioA2uiValue(binding: JsonValue | undefined, scope: StudioA2uiObject | null, data: StudioA2uiObject): JsonValue | undefined {
  if (!isBinding(binding)) return binding
  const path = binding['path']
  const literal = binding['literalString']
  if (path !== undefined) {
    const found = scope === null ? undefined : studioA2uiPathValue(scope, String(path))
    const value = found === undefined ? studioA2uiPathValue(data, String(path)) : found
    return value === undefined ? literal : value
  }
  return isBinding(literal) ? studioA2uiValue(literal, scope, data) : literal
}

/**
 * Whether a `hide` binding hides its component; `negate` inverts it.
 * @param binding - the `hide` prop.
 * @param scope - the list row's scope, if any.
 * @param data - the payload's data.
 */
export function studioA2uiHidden(binding: JsonValue | undefined, scope: StudioA2uiObject | null, data: StudioA2uiObject): boolean {
  if (binding === undefined || binding === null || binding === false) return false
  const value = studioA2uiValue(binding, scope, data)
  const truthy = value !== undefined && value !== null && value !== false && value !== 0 && value !== ''
  return isStudioA2uiObject(binding) && binding['negate'] === true ? !truthy : truthy
}

/**
 * The items a list draws: its `dataSource` array, by path or literal.
 * @param dataSource - the list's `dataSource` prop.
 * @param data - the payload's data.
 */
export function studioA2uiListItems(dataSource: JsonValue | undefined, data: StudioA2uiObject): JsonValue[] {
  if (!isStudioA2uiObject(dataSource)) return []
  const items = dataSource['path'] !== undefined ? studioA2uiPathValue(data, String(dataSource['path'])) : dataSource['literalString']
  return Array.isArray(items) ? items : []
}

/**
 * A list row's scope: the item's own fields, and the item as `item`.
 * @param item - one item of the list.
 */
export function studioA2uiRowScope(item: JsonValue): StudioA2uiObject {
  return isStudioA2uiObject(item) ? { ...item, item } : { item }
}

/**
 * The ids a container lists: `children.explicitList`, or `children` as a list.
 * @param props - the container's props.
 */
export function studioA2uiChildIds(props: StudioA2uiObject): string[] {
  const children = props['children']
  const ids = isStudioA2uiObject(children) ? children['explicitList'] : children
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : []
}

/**
 * A CSS length from a prop.
 * @param value - the prop.
 * @param numberUnit - what a number means: `%` for width and height, `px` elsewhere.
 */
export function studioA2uiLength(value: JsonValue | undefined, numberUnit: '%' | 'px' = 'px'): string | undefined {
  if (typeof value === 'number') return `${String(value)}${numberUnit}`
  return typeof value === 'string' ? value : undefined
}

/** The reference's named radii. */
const STUDIO_A2UI_RADII: Readonly<Record<string, string>> = { small: '4px', middle: '8px', big: '12px' }

/**
 * A CSS radius from a prop: a named one, a number of pixels, or as written.
 * @param value - the `borderRadius` prop.
 */
export function studioA2uiRadius(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string' && STUDIO_A2UI_RADII[value] !== undefined) return STUDIO_A2UI_RADII[value]
  return studioA2uiLength(value)
}

/** The reference's named text sizes, on the Studio's six-size scale. */
const STUDIO_A2UI_TEXT_SIZES: Readonly<Record<string, string>> = { xsmall: '11px', small: '12px', normal: '13px', large: '14px', xlarge: '16px', xxlarge: '20px' }

/**
 * The font size a named text size draws at; undefined for a name outside the scale.
 * @param size - the `size` prop of a Text.
 */
export function studioA2uiTextSize(size: JsonValue | undefined): string | undefined {
  return typeof size === 'string' ? STUDIO_A2UI_TEXT_SIZES[size] : undefined
}
