/**
 * The transforms DSL: deterministic declarative data transforms over raw data.
 * A port of the reference implementation's core/a2ui/transforms.py; messages and formatting mirror the
 * original so a manifest behaves the same on either side.
 * @module @lyteboat/a2ui/transforms
 */

import { isA2uiRecord } from './a2ui-record.ts'

/** A transform failure; its message mirrors the reference implementation's. */
export class TransformError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransformError'
  }
}

/** The sink for degraded-but-continuing conditions; the engine wires it to the plugin logger. */
export interface A2uiLog {
  warn(message: string): void
}

export const SILENT_LOG: A2uiLog = { warn: () => {} }

export type RawData = Record<string, unknown>

/** Python's `repr` of a list of strings, as the reference messages print available keys. */
function reprList(values: readonly string[]): string {
  return `[${values.map(value => `'${value}'`).join(', ')}]`
}

/** Python's `f"{value:,.2f}"`. */
function formatFixed2(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatCurrency(value: number): string {
  return `¥ ${formatFixed2(value)}`
}

function formatPercent(value: number): string {
  // Python distinguishes a float below 1 (a ratio) from any other number; JS
  // numbers are one type, so an integer-valued ratio like 0 or 1 renders as
  // `0%` / `1%` here where the reference implementation rendered `0%` / `100%` only for true floats.
  if (!Number.isInteger(value) && value < 1) return `${(value * 100).toFixed(0)}%`
  return `${String(value)}%`
}

function formatInt(value: number): string {
  return String(Math.trunc(value))
}

const FORMATTERS: Record<string, (value: number) => string> = {
  currency: formatCurrency,
  percent: formatPercent,
  int: formatInt,
  raw: value => String(value),
}

function applyFormat(value: unknown, format: string | undefined): unknown {
  if (format === undefined || format === 'raw') return value
  if (value === null || value === undefined || value === '') return ''
  const formatter = FORMATTERS[format]
  if (formatter === undefined) return value
  const numeric = typeof value === 'number' ? value : Number(value)
  if (typeof value === 'boolean' || Number.isNaN(numeric)) return String(value)
  return formatter(numeric)
}

const BRACKET = /^(\w+)\[(\d+)\]$/u

/**
 * Resolve a dot-separated path with `[index]`, numeric segments and array
 * wildcards (a field name applied to every item).
 * @param data - the raw data.
 * @param path - the dotted path.
 */
export function resolvePath(data: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = data
  for (const part of parts) {
    if (isA2uiRecord(current)) {
      let key = part
      let index: number | undefined
      const bracket = BRACKET.exec(part)
      if (bracket !== null) {
        key = bracket[1] as string
        index = Number(bracket[2])
      }
      if (!Object.hasOwn(current, key)) {
        throw new TransformError(`字段 '${path}' 不存在于数据中 (在 '${part}' 处失败, 可用字段: ${reprList(Object.keys(current))})`)
      }
      current = current[key]
      if (index !== undefined) {
        if (!Array.isArray(current)) throw new TransformError(`字段 '${path}' 中 '${key}' 不是数组 (在 '${part}' 处失败)`)
        if (index < 0 || index >= current.length) throw new TransformError(`字段 '${path}' 数组下标越界 '${part}' (长度 ${String(current.length)})`)
        current = current[index]
      }
    } else if (Array.isArray(current)) {
      if (/^\d+$/u.test(part)) {
        const index = Number(part)
        if (index < 0 || index >= current.length) throw new TransformError(`字段 '${path}' 数组下标越界 (在 '${part}' 处失败)`)
        current = current[index]
      } else {
        current = current.filter((item): item is Record<string, unknown> => isA2uiRecord(item) && Object.hasOwn(item, part)).map(item => item[part])
      }
    } else {
      throw new TransformError(`路径 '${path}' 中 '${part}' 不是 dict 或 list`)
    }
  }
  return current
}

const CONDITION = /^(>=|<=|>|<|==|!=)\s*(.+)$/u

function parseRhs(raw: string): unknown {
  if (raw === 'null' || raw === 'None') return null
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.replaceAll(/^'+|'+$/gu, '')
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.replaceAll(/^"+|"+$/gu, '')
  const numeric = raw.includes('.') ? Number.parseFloat(raw) : Number.parseInt(raw, 10)
  return Number.isNaN(numeric) || String(numeric) !== raw && !/^-?\d+(\.\d+)?$/u.test(raw) ? raw : numeric
}

function looselyEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right
  if (left === null || left === undefined) return right === null || right === undefined
  return left === right
}

function evalCondition(item: Record<string, unknown>, where: Record<string, unknown>): boolean {
  if ('or' in where) return (where['or'] as Record<string, unknown>[]).some(sub => evalCondition(item, sub))
  if ('and' in where) return (where['and'] as Record<string, unknown>[]).every(sub => evalCondition(item, sub))
  for (const [field, expr] of Object.entries(where)) {
    if (field === 'or' || field === 'and') continue
    const value = item[field]
    const text = String(expr).trim()
    const match = CONDITION.exec(text)
    if (match === null) throw new TransformError(`无效的条件表达式: ${text}`)
    // Both groups are mandatory; the defaults only satisfy noUncheckedIndexedAccess.
    const [, op = '', rhsRaw = ''] = match
    const rhs = parseRhs(rhsRaw.trim())
    switch (op) {
      case '==':
        if (!looselyEqual(value, rhs)) return false
        break
      case '!=':
        if (looselyEqual(value, rhs)) return false
        break
      case '>':
        if (value === null || value === undefined || !(Number(value) > Number(rhs))) return false
        break
      case '>=':
        if (value === null || value === undefined || !(Number(value) >= Number(rhs))) return false
        break
      case '<':
        if (value === null || value === undefined || !(Number(value) < Number(rhs))) return false
        break
      case '<=':
        if (value === null || value === undefined || !(Number(value) <= Number(rhs))) return false
        break
      default:
        break
    }
  }
  return true
}

function filterArray(data: RawData, arrayPath: string, where: Record<string, unknown> | undefined): Record<string, unknown>[] {
  let array = resolvePath(data, arrayPath)
  if (isA2uiRecord(array)) array = [array]
  if (!Array.isArray(array)) throw new TransformError(`'${arrayPath}' 不是数组`)
  const items = array.filter(isA2uiRecord)
  return where === undefined ? items : items.filter(item => evalCondition(item, where))
}

function resolveItemSpec(spec: Record<string, unknown>, item: Record<string, unknown>, log: A2uiLog): Record<string, unknown> {
  const available = Object.keys(item)
  const get = spec['get']
  if (typeof get === 'string' && get.startsWith('$.')) {
    const field = get.slice(2)
    const value = item[field]
    if (value === undefined && !Object.hasOwn(item, field)) log.warn(`select.map: item missing field '${field}' (available: ${reprList(available)})`)
    const format = spec['format']
    const formatted = typeof format === 'string' ? applyFormat(value, format) : value
    return { literal: formatted ?? '' }
  }
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'string' && value.startsWith('$.')) {
      const field = value.slice(2)
      const itemValue = item[field]
      if (itemValue === undefined && !Object.hasOwn(item, field)) log.warn(`select.map: item missing field '${field}' (available: ${reprList(available)})`)
      resolved[key] = { literal: itemValue ?? '' }
    } else if (Array.isArray(value)) {
      resolved[key] = value.map(part => typeof part === 'string' && part.startsWith('$.')
        ? { literal: item[part.slice(2)] ?? '' }
        : part)
    } else if (isA2uiRecord(value)) {
      resolved[key] = resolveItemSpec(value, item, log)
    } else {
      resolved[key] = value
    }
  }
  return resolved
}

/**
 * Execute one transform spec against raw data.
 * @param spec - a bare path (`get`), or an object with one operator key.
 * @param data - the raw data.
 * @param log - the degradation sink.
 */
export function execOne(spec: unknown, data: RawData, log: A2uiLog = SILENT_LOG): unknown {
  if (typeof spec === 'string') return resolvePath(data, spec)
  if (!isA2uiRecord(spec)) return spec
  if ('literal' in spec) return spec['literal']
  if ('select' in spec) {
    const items = filterArray(data, String(spec['select']), isA2uiRecord(spec['where']) ? spec['where'] : undefined)
    const map = spec['map']
    if (!isA2uiRecord(map)) return items
    const valueFormat = isA2uiRecord(spec['value_format']) ? spec['value_format'] : {}
    return items.map((item) => {
      const mapped: Record<string, unknown> = {}
      for (const [outKey, transform] of Object.entries(map)) {
        try {
          if (isA2uiRecord(transform)) {
            mapped[outKey] = execOne(resolveItemSpec(transform, item, log), data, log)
          } else if (typeof transform === 'string' && transform.startsWith('$.')) {
            const value = item[transform.slice(2)] ?? ''
            const format = valueFormat[outKey]
            mapped[outKey] = typeof format === 'string' ? applyFormat(value, format) : value
          } else {
            mapped[outKey] = transform
          }
        } catch (error: unknown) {
          log.warn(`select.map field '${outKey}' failed: ${error instanceof Error ? error.message : String(error)}`)
          mapped[outKey] = null
        }
      }
      return mapped
    })
  }
  if ('sum' in spec) {
    const targets = typeof spec['sum'] === 'string' ? [spec['sum']] : spec['sum'] as string[]
    const where = isA2uiRecord(spec['where']) ? spec['where'] : undefined
    let total = 0
    for (const target of targets) {
      const dot = target.indexOf('.')
      if (dot < 0) throw new TransformError(`sum 路径格式应为 'array.field': ${target}`)
      const arrayPath = target.slice(0, dot)
      const field = target.slice(dot + 1)
      for (const item of filterArray(data, arrayPath, where)) {
        const value = item[field] ?? 0
        if (value !== null) total += Number(value)
      }
    }
    return applyFormat(total, typeof spec['format'] === 'string' ? spec['format'] : undefined)
  }
  if ('count' in spec) {
    const items = filterArray(data, String(spec['count']), isA2uiRecord(spec['where']) ? spec['where'] : undefined)
    return applyFormat(items.length, typeof spec['format'] === 'string' ? spec['format'] : undefined)
  }
  if ('concat' in spec) {
    const parts = spec['concat']
    if (!Array.isArray(parts)) throw new TransformError('concat 参数必须是数组')
    return parts.map((part) => {
      if (typeof part === 'string') return part
      if (isA2uiRecord(part)) {
        const value = execOne(part, data, log)
        return value === null || value === undefined ? '' : pyStr(value)
      }
      return pyStr(part)
    }).join('')
  }
  if ('switch' in spec) {
    const keyRef = spec['switch']
    const cases = isA2uiRecord(spec['cases']) ? spec['cases'] : {}
    const fallback = spec['default'] ?? ''
    let keyValue: string
    if (isA2uiRecord(keyRef)) keyValue = pyStr(execOne(keyRef, data, log))
    else if (typeof keyRef === 'string') {
      try {
        keyValue = pyStr(resolvePath(data, keyRef))
      } catch (error: unknown) {
        if (!(error instanceof TransformError)) throw error
        keyValue = keyRef
      }
    } else keyValue = pyStr(keyRef)
    const matched = Object.hasOwn(cases, keyValue) ? cases[keyValue] : fallback
    if (isA2uiRecord(matched)) return execOne(matched, data, log)
    return matched ?? ''
  }
  if ('get' in spec) {
    const path = spec['get']
    const format = typeof spec['format'] === 'string' ? spec['format'] : undefined
    if (typeof path === 'string' && path.startsWith('$.')) throw new TransformError(`'$.' 引用只能在 select/map 中使用: ${path}`)
    try {
      return applyFormat(resolvePath(data, String(path)), format)
    } catch (error: unknown) {
      if (error instanceof TransformError && spec['default'] !== undefined && spec['default'] !== null) return applyFormat(spec['default'], format)
      throw error
    }
  }
  throw new TransformError(`未知的 transform 操作: ${reprList(Object.keys(spec))}`)
}

/** Python's `str()` for the values a manifest routes through `concat` / `switch`: booleans capitalize, ints stay ints. */
function pyStr(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

/**
 * Execute a table of transform specs; each later key may read earlier results.
 * @returns the computed values and the warnings for failed keys.
 */
export function executeTransforms(transforms: Record<string, unknown>, data: RawData, log: A2uiLog = SILENT_LOG): { computed: Record<string, unknown>; warnings: string[] } {
  const computed: Record<string, unknown> = {}
  const warnings: string[] = []
  for (const [key, spec] of Object.entries(transforms)) {
    try {
      computed[key] = execOne(spec, { ...data, ...computed }, log)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(error instanceof TransformError ? `[TRANSFORM_WARN] ${key}: ${message}` : `[TRANSFORM_ERROR] ${key}: ${message}`)
      log.warn(`Transform failed for key=${key}: ${message}`)
    }
  }
  return { computed, warnings }
}
