/**
 * An agent's own card components, which the test window draws beside the
 * default catalog's sixteen. The agent keeps them in one browser ES module
 * (`web/card-components.js` in its directory) that the host serves at
 * `/studio/agents/<id>/card-components.js`; its default export maps a
 * component type to a function `(props, card) => Element`, where `card` reads
 * the card's bindings, applies the props every component takes, and runs an
 * action. A type of the default catalog keeps the Studio's drawing, and an
 * entry that is not a function is left out; each is a problem the window
 * shows in one line, and those components draw as the grey box an unknown
 * type draws as.
 * @module @lyteboat/studio-web/client/studio-agent-card-components
 */

import type { JsonValue } from '@lyteboat/contracts'
import type { StudioA2uiObject } from './studio-a2ui-binding.ts'

/** The default catalog's types, which the Studio draws itself. */
const STUDIO_A2UI_DEFAULT_COMPONENTS: ReadonlySet<string> = new Set([
  'Row', 'Column', 'Card', 'List', 'CollapseList', 'Table', 'Popup', 'Text', 'RichText', 'Image', 'Icon', 'Tag', 'Circle', 'Divider', 'Line', 'Button',
])

/** What an agent's component gets besides its props: the card it is drawn in. */
export interface StudioAgentCardApi {
  /** The card's data. */
  readonly data: StudioA2uiObject
  /** The list row the component is drawn for, or null outside a list. */
  readonly scope: StudioA2uiObject | null
  /** A binding (`{path}`, `{literalString}`, or a plain value) as the text to show. */
  text(binding: JsonValue | undefined): string
  /** A binding as its value, an array or object included; the row's scope first, then the data. */
  value(binding: JsonValue | undefined): JsonValue | undefined
  /** Set the props every component takes (size, spacing, background, radius, flex, border, shadow, `hide`) on an element. */
  applyCommonProps(element: HTMLElement, props: StudioA2uiObject): void
  /** Run an action or a list of them, as a button of the card does. */
  act(action: JsonValue | undefined): void
}

/** One component of an agent: draws its props into a new element. */
export type StudioAgentCardDraw = (props: StudioA2uiObject, card: StudioAgentCardApi) => unknown

/** The components an agent's module provides, and what is wrong with the rest of it. */
export interface StudioAgentCardComponents {
  draws: ReadonlyMap<string, StudioAgentCardDraw>
  problems: string[]
}

/** An agent without a module, or one whose module is not read yet. */
export const STUDIO_AGENT_NO_CARD_COMPONENTS: StudioAgentCardComponents = { draws: new Map(), problems: [] }

const MODULE_NAME = 'card-components.js'

/**
 * Read the components out of an imported module.
 * @param namespace - what `import()` of the module resolved to.
 * @returns the components, and one problem per entry left out.
 */
export function studioAgentCardComponentsOf(namespace: unknown): StudioAgentCardComponents {
  const exported: unknown = typeof namespace === 'object' && namespace !== null ? (namespace as { default?: unknown }).default : undefined
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
    return { draws: new Map(), problems: [`${MODULE_NAME} 的默认导出不是「组件名 → 函数」的对象`] }
  }
  const draws = new Map<string, StudioAgentCardDraw>()
  const problems: string[] = []
  for (const [type, draw] of Object.entries(exported)) {
    if (STUDIO_A2UI_DEFAULT_COMPONENTS.has(type)) problems.push(`${MODULE_NAME}：${type} 和默认组件重名，仍按默认画法`)
    else if (typeof draw !== 'function') problems.push(`${MODULE_NAME}：${type} 不是函数`)
    else draws.set(type, draw as StudioAgentCardDraw)
  }
  return { draws, problems }
}

/**
 * Import an agent's module; `version` changes the URL whenever the file changes, so the browser fetches it again.
 * @param agentId - the agent.
 * @param version - the module's content hash, from the agent radar.
 */
export async function loadStudioAgentCardComponents(agentId: string, version: string): Promise<StudioAgentCardComponents> {
  // The host's route (`@lyteboat/studio-web`, `AGENT_CARD_COMPONENTS_PATH`).
  const url = `/studio/agents/${encodeURIComponent(agentId)}/${MODULE_NAME}?v=${encodeURIComponent(version)}`
  let namespace: unknown
  try {
    namespace = await import(/* @vite-ignore */ url)
  } catch (error: unknown) {
    return { draws: new Map(), problems: [`${MODULE_NAME} 加载失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  return studioAgentCardComponentsOf(namespace)
}
