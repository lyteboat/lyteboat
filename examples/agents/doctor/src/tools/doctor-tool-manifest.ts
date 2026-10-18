/**
 * The doctor tools as the doctor service declares them (`assets/doctor-tools.json`,
 * written by its `export-agent-tools` command): each tool's name, its
 * description and thinking hint word for word, and its parameters as the JSON
 * Schema the model was given before. The schema is turned into dsh's
 * parameter spec here; keywords the doctor service validates itself (number
 * ranges, item counts) are dropped, and any other keyword fails the mount.
 * @module @lyteboat/agent-doctor/tools/doctor-tool-manifest
 */

import { readFileSync } from 'node:fs'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@lyteboat/contracts'
import { z } from 'zod'

/** One doctor tool as the agent registers it. */
export interface DoctorToolManifestEntry {
  name: string
  description: string
  /** What the doctor workbench shows while the tool runs. */
  thinkingHint: string
  parameters: ParameterSchemaSpec
}

type JsonSchemaNode = { [key: string]: JsonValue }

const manifestSchema = z.array(z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  description: z.string().min(1),
  thinking_hint: z.string(),
  parameters: z.strictObject({
    type: z.literal('object'),
    properties: z.record(z.string(), z.json()),
    required: z.array(z.string()),
  }),
}))

/** Validated by the doctor service, which owns the contract; dsh's spec has no place for them. */
const DROPPED_KEYWORDS = new Set(['title', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'])
const KNOWN_KEYWORDS = new Set(['type', 'description', 'default', 'enum', 'items', 'properties', 'required', 'anyOf', 'additionalProperties'])

function isNode(value: JsonValue | undefined): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function annotationsOf(node: JsonSchemaNode): { description?: string; default?: JsonValue } {
  return {
    ...typeof node['description'] === 'string' && node['description'] !== '' ? { description: node['description'] } : {},
    ...node['default'] !== undefined ? { default: node['default'] } : {},
  }
}

function enumOf<T>(node: JsonSchemaNode, at: string, isMember: (value: JsonValue) => value is T & JsonValue): { enum?: readonly T[] } {
  const values = node['enum']
  if (values === undefined) return {}
  if (!Array.isArray(values) || !values.every(isMember)) throw new Error(`${at}: enum does not match its type`)
  return { enum: values }
}

function propertiesOf(node: JsonSchemaNode, at: string): ParameterSchemaSpec {
  const properties = node['properties'] ?? {}
  if (!isNode(properties)) throw new Error(`${at}: properties must be an object`)
  const required = new Set(Array.isArray(node['required']) ? node['required'] : [])
  const spec: ParameterSchemaSpec = {}
  for (const [name, child] of Object.entries(properties)) {
    if (!isNode(child)) throw new Error(`${at}.${name}: must be a schema object`)
    const value = valueSpecOf(child, `${at}.${name}`)
    spec[name] = required.has(name) ? { ...value, required: true } : value
  }
  return spec
}

/**
 * One JSON Schema node as dsh's value spec.
 * @param node - the node.
 * @param at - its path, for the error.
 * @throws on a keyword or a type the conversion does not know.
 */
function valueSpecOf(node: JsonSchemaNode, at: string): ValueSchemaSpec {
  const unknown = Object.keys(node).filter(key => !KNOWN_KEYWORDS.has(key) && !DROPPED_KEYWORDS.has(key))
  if (unknown.length > 0) throw new Error(`${at}: unsupported JSON Schema keyword ${unknown.map(key => JSON.stringify(key)).join(', ')}`)
  const annotations = annotationsOf(node)
  const branches = node['anyOf']
  if (branches !== undefined) {
    if (!Array.isArray(branches) || branches.length < 2) throw new Error(`${at}: anyOf needs at least two branches`)
    const [first, second, ...rest] = branches.map((branch, index) => {
      if (!isNode(branch)) throw new Error(`${at}.anyOf[${String(index)}]: must be a schema object`)
      return valueSpecOf(branch, `${at}.anyOf[${String(index)}]`)
    })
    // `X | None` on the doctor side: exactly one branch matches any value, so anyOf reads as oneOf.
    return { ...annotations, oneOf: [first as ValueSchemaSpec, second as ValueSchemaSpec, ...rest] }
  }
  switch (node['type']) {
    case 'string': return { type: 'string', ...annotations, ...enumOf(node, at, (value): value is string => typeof value === 'string') }
    case 'number': return { type: 'number', ...annotations, ...enumOf(node, at, (value): value is number => typeof value === 'number') }
    case 'integer': return { type: 'integer', ...annotations, ...enumOf(node, at, (value): value is number => Number.isInteger(value)) }
    case 'boolean': return { type: 'boolean', ...annotations }
    case 'null': return { type: 'null', ...annotations }
    case 'array': {
      const items = node['items']
      if (items !== undefined && !isNode(items)) throw new Error(`${at}.items: must be a schema object`)
      return { type: 'array', ...annotations, ...items === undefined ? {} : { items: valueSpecOf(items, `${at}.items`) } }
    }
    case 'object':
      return { type: 'object', ...annotations, properties: propertiesOf(node, at), additionalProperties: node['additionalProperties'] !== false }
    default:
      throw new Error(`${at}: unsupported type ${JSON.stringify(node['type'] ?? null)}`)
  }
}

/**
 * Read the doctor service's tool manifest.
 * @param path - the manifest file.
 * @returns the tools in manifest order.
 * @throws when the file is not a manifest or a schema cannot be converted, naming the tool and the path.
 */
export function readDoctorToolManifest(path: string): DoctorToolManifestEntry[] {
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) throw new Error(`doctor: ${path} is not a tool manifest: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  return parsed.data.map(entry => ({
    name: entry.name,
    description: entry.description,
    thinkingHint: entry.thinking_hint,
    parameters: propertiesOf(entry.parameters as JsonSchemaNode, `doctor tool ${entry.name}`),
  }))
}
