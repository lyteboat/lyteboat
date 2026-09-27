/**
 * The one shape check the engine repeats over parsed YAML, JSON, tool
 * arguments, and presentation meta: a plain object, not null and not an array.
 * @module @lyteboat/a2ui/a2ui-record
 */

/** Whether `value` is a plain object (not null, not an array). */
export function isA2uiRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
