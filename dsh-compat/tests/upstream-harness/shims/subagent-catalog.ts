/**
 * lyteboat adaptation: upstream's session-controller spec `projection-discovery.host.spec.ts`
 * imports `subagentCatalogProjectionDefinition` from the subagent package's source
 * (`@deepseek-ai/dsh-subagent/src/catalog.ts`), which the published package does
 * not ship. The published package carries that module compiled, unexported
 * (`lib/types/catalog.js`); this re-exports it from the hoisted install.
 */
export { subagentCatalogProjectionDefinition } from '../../../../node_modules/@deepseek-ai/dsh-subagent/lib/types/catalog.js'
