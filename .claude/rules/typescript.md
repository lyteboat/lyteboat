---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/package.json"
---

# TypeScript code

Rules for writing lyteboat's code: line-level conventions, the plugin runtime rules, the boundary protocols, naming, and comments. The design-level conventions (tooling, ESM, plugin shape, configuration) are in CLAUDE.md「Coding conventions」.

## Code

- **No capability probing.** Never test `'x' in obj` or `typeof obj.x === 'function'` to discover what a value can do. Declare the dependency (`static inject`) or narrow on a discriminant field (`block.type === 'tool_result'`, `decision.kind === 'reply'`). Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Types are strict.** No `any`; no non-null assertions in `src/` (oxlint enforces both). An `as unknown as` cast in `src/` is a boundary crossing (cordis's untyped `baseUrl`, a session envelope built by hand, a business object entering `JsonValue`) and carries a one-line comment naming the boundary. Opaque ids that cross a process or wire boundary keep dsh's branded types.
- **Validate at real boundaries only.** Config (schemastery), model/tool JSON (tool parameter specs), files (history JSON, templates, manifests), and the wire are validated; values a static interface already requires are trusted. A tool's `execute` treats its arguments as untrusted.
- **Limits**: functions ≤ 160 lines, nesting ≤ 3, inheritance depth ≤ 2 (`Service` subclasses only; prefer composition). Extract on the third repetition, not the first: a helper used by two packages moves to `contracts` only when it is a contract, otherwise it stays local.
- **Logging**: `this.ctx.logger` / `ctx.logger` from cordis, prefixed with the plugin name (`lyteboat skill router: …`). `warn` for handled degradation, `error` only for aborted operations. No `console.*` in `lyteboat/bundles/*`, `lyteboat/plugins/*`, `lyteboat/core/*`, or `examples/*/*`; the CLI writes to stdout/stderr on purpose and says so. Never log credentials, full model requests, or user history.
- **An empty `catch` names what it swallows** and why nothing else can reach it; keep the `try` to one statement.

## Plugin runtime

- **Registrations are effects.** Every contribution goes through `ctx.effect()` / `ctx.on()` / a registry `register()` that returns the disposer, so an agent scope or a plugin unload leaves nothing behind. Per-agent state lives in a `WeakMap<Agent, …>` or behind the agent scope's disposer, never in a module-level map that outlives the agent.
- **Waterfall listeners MUST call `next()`.** `lyteboat/intake`, `lyteboat/pre-assemble`, `tools/pre-execute`, `tools/post-execute` are waterfalls; returning without `next()` short-circuits every listener behind you. Choose the side of `next()` deliberately: work that must be visible to later listeners in the same step runs before `await next()`, reconciliation runs after.
- **Projections return the same reference when nothing changed.** `apply(state, event)` returns `state` itself for events it ignores; dsh's wire diffing depends on it.
- **Projections fold appended nodes only.** A surface replacement (compaction pruning, an agent shortening an old tool result) must keep the original `tool/result`'s meta, so a fold that reads meta checks `event.surfaceOp === 'append'`; otherwise the replaced result's delta or card is applied a second time.

## Protocols at boundaries (SOLID)

A boundary between packages is a declared contract, never a concrete class: a type in `@lyteboat/contracts`, or the service a plugin declares on cordis's `Context` (`declare module '@deepseek-ai/cordis' { interface Context { … } }`), which consumers receive through `static inject`.

- **SRP**: one reason to change per module and per service. A service that serves two roles (keeping a catalog and answering HTTP) is two services.
- **OCP**: extend through a plugin, a seam provider, a registry (`register()` returning its disposer), or an agent row; never edit the kernel or an existing plugin to add a business case or one more variant. A feature that needs a switch in someone else's code is a missing seam: design the seam.
- **LSP**: every implementation of a contract is substitutable. A seam provider or an alternate service keeps the events, their order, and the failure behavior of the one it replaces, and passes the same contract tests.
- **ISP**: a service's public surface stays small, about seven methods; when a change would push it past that, split the service by role. No god-services: a consumer depends only on the part it uses.
- **DIP**: depend on the contract, not the implementation. A swappable dependency arrives through cordis `inject` or a `Config` field; never construct it with `new` or import another plugin's implementation (between plugins only `import type`, as the layer rule already requires).

## Naming

A name tells the reader what the thing is and whom it belongs to, without reading its body. A name that needs a comment to explain it gets renamed.

- **Owner first.** Types, services, events, projection keys, and exported functions carry their owner: `LyteboatToolMeta` not `Meta`, `SkillRouterSettings` not `Settings`, `lyteboatActiveSkill` not `activeSkill`, `lyteboatAgentDef`. Services publish under an unambiguous key (`toolPolicy`, `skillRouter`, `a2ui`, `historyImport`); log nodes and events are `lyteboat/<noun>`; projection keys are `lyteboat<Noun>`.
- **Functions** are a verb and its object and say what they do or return: `readAgentManifest`, `declareInheritedTools`. A factory that returns a declaration is named for what it declares (`lyteboatAgentDef`, dsh's `defineTool`). A lookup reads `<thing>Of<source>` (`customerOfContext`); a predicate reads as a yes/no question (`isAgentDirectory`, `hasStateDelta`). `handle`, `process`, `run`, `do`, `manage` alone name no action.
- **Classes** are noun phrases for their role: `ToolPolicyService` (publishes `toolPolicy`), `RunMetricsRecorder`, `StudioApiRoutes`. Never a bare `Manager`, `Handler`, `Helper`, `Processor`, or `Base`.
- **Files** are named for what they define (`agent-directory.ts`, `finance-admission.ts`), never `utils.ts`, `helpers.ts`, `types.ts`, `common.ts`, `misc.ts`, `constants.ts`; `index.ts` only as a package entry.
- **Variables and parameters** name what they hold: `customerId`, `templatesDir`, `routerSettings`. Collections are plural, units are in the name (`timeoutMs`, `sizeBytes`), booleans read as statements (`isHidden`, `hasCards`). Single letters only for loop indices and one-line lambdas.
- **Generic words are not names.** `config`, `options`, `settings`, `data`, `info`, `item`, `value`, `result`, `payload`, `params`, `obj`, `tmp`, `res`, `ret` on their own say nothing; qualify them with what they are (`studioWebConfig`, `evalRunRecord`, `renderedCard`).
- **Names another API fixes stay as it spells them**: Cordis's `static Config`, `static inject`, and `ctx`; a waterfall listener's `(payload, next)`; dsh's `execute(args, exec)` and `render(args, value)`; a third-party plugin's `apply`.
- **Scope.** New code follows this section, and so does code a change rewrites; untouched code is renamed only by a change about naming.

## Comments and docstrings

**Default: none. When you write one, it says WHY, not WHAT.**

- **Required**: a module JSDoc (`@module @lyteboat/x`) stating the module's contract in one paragraph; JSDoc on every exported symbol whose contract is not obvious from its signature (`@param` / `@returns` on function-like exports); JSDoc on every event and log node in contracts with its ordering guarantee (which dsh event it precedes or follows).
- **Allowed**: an inline comment for a non-obvious WHY: a dsh quirk (`restrict()` cannot hide a tool registered in the agent's own layer), a Python-semantics emulation kept for golden fidelity, an ordering constraint, a workaround with the upstream reference.
- **Forbidden**: restating the code (`// register the tool`), narrating history or the milestone it came from (that goes in the commit and the design document), review transcripts, `// eslint-disable` / `// oxlint-disable` without a reason on the same line.

```ts
// ❌ // merge the delta into the state
state = mergeStateDelta(state, delta)

// ✅ // dsh computes no presentation meta for a PTC sub-dispatch (a tool the `run_code` SDK
//    // calls, `exec.parent !== undefined`), so only model-direct calls carry a delta or a card.
```
