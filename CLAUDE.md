# lyteboat

lyteboat is an agent harness for business agents, built as Cordis plugins on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), and a distribution of dsh. It carries the runtime behavior of a Python agent framework (the reference implementation) onto dsh's seams: skill routing, tool visibility, A2UI cards, session state, request context and admission, external history. It owns the source of dsh's kernel packages (`dsh/`) under their published names, so official packages and community plugins run on lyteboat's implementation. It promises them the protocol, interfaces, and behavior of the tracked release (`dsh.upstream.json`, `dsh-compat/COMPAT.md`).

This file holds the rules every session needs. Rules for one part of the repository are in `.claude/rules/` and load when you open matching files: `kernel.md` (`dsh/` and the compatibility contract), `testing.md` (harness, composition, e2e, fixtures), `typescript.md` (code, naming, comments), `agent-design.md` (business agents). The upstream sync procedure is the `dsh-sync` skill.

Read [README.md](README.md) for what lyteboat provides, [docs/04-reference-alignment.md](docs/04-reference-alignment.md) for the forward plan, and [dsh-compat/COMPAT.md](dsh-compat/COMPAT.md) before touching `dsh/`. When a dsh API is unclear, read the kernel's source under `dsh/` or, for other dsh packages, the tracked tag's checkout (`packages/<group>/<pkg>/src`), not the published `lib/`.

## Behavioral guidelines

lyteboat is a framework: teams build business agents on it and serve them to their own users, so every agent built on top pays for a design mistake here. Design comes before code.

- **Design first.** A structural change (a feature; a new plugin, service, event, projection key, bundle, or agent; anything that touches a public contract or crosses a layer) starts with its design document, and the user reviews it before any code is written ([Task types](#task-types)). When the implementation has to depart from the approved design, stop, update the design, and confirm again.
- **Think before coding.** State your assumptions; if something is unclear, ask. If a request has more than one reading, surface them; don't pick one silently.
- **Simplicity first.** No abstraction, configurability, or error handling that nobody asked for. A wrong abstraction is worse than duplication: extract on the third repetition, not the first.
- **Surgical changes.** Match the existing style; don't refactor working code outside the task ([Scope of change](#scope-of-change)).
- **Goal-driven.** Each step ends with something that runs from the built CLI, and the tests it needs follow from the task type ([Testing](#testing)).
- **Framework, not application.** lyteboat is a vertical-agnostic foundation for business agents. `lyteboat/bundles/*`, `lyteboat/plugins/*`, and `lyteboat/core/*` stay domain-neutral: no business rules, industry vocabulary, or branches tied to one scenario. Business logic lives only in the agents (`examples/agents/*`), and a capability the framework adds is one any vertical could use.

## 中文写作

用户用中文提问，就用中文回答。本节适用于用户读到的中文：聊天回复、工作中的进度更新、artifact（含设计文档）、中文 PR 描述和评论，以及 `README.md`、`docs/` 里新写或改写的段落。代码、注释和 commit message 照旧用英文。

读者是忙碌的工程师，读你的文字是为了尽快拿到结论、决定下一步。照英文句式写出的中文要读两遍才懂，所以要写得像一位文笔好的中国工程师。本文件其余部分是写给你的英文规格，句子长、括号多。写给用户的中文不要照它的样子写。

### 回答和汇报

- 第一句回答问题或说出结果，理由和细节放在后面。
- 篇幅够回答问题就停。大部分篇幅给主要答案，前提和注意事项一两句带过。解释类问题先给概要，用户要细节再展开。
- 开始一项任务前，用一句话说要做什么。过程中只在发现重要情况或改变方向时更新。
- 任务结束时按这个顺序汇报：做成了什么，改了哪里，跑了哪些命令、结果如何，什么没做、为什么。读过哪些文件、试过哪些路子，只在用户问起或它影响结论时才讲。
- 确定的事直接陈述。不确定的事说一次，写明缺什么依据，比如没跑测试、没读到源码。
- 结尾停在最后一条有用的信息上。只有需要用户决定的事，才在结尾问一个问题。

### 句子

- 一句话讲一件事。20 个汉字以内最好，超过 40 个就拆开。
- 用主动句和肯定句：写"你吓不倒我"，不写"我不会被你吓倒"。
- 用实在的动词：写"详加研究"，不写"进行详细的研究"；写"贡献很大"，不写"作出了重大的贡献"。"实现""完成"后面接名词时同理。
- 用短说法代替抽象名词：写"很有名"，不写"具有很高的知名度"。
- 删掉多余的介词结构，如"关于""对于……来说""通过……的方式""由于……使得"。
- 一个名词前最多挂一个"的"字结构，太长就拆成两句。一个代词只指一个东西。
- 括号只放路径、缩写、英文原词这类短补充，一句最多一个。要解释的内容另起一句。
- 有直白的说法就不用比喻。
- 每句话都要带新信息。删掉后不影响理解的句子，就删掉。

### 格式和用词

- 聊天回复用段落。只有并列、能单独读的项目才用列表或表格，比如步骤、参数、选项对比。
- 加粗只留给读者扫读时必须看到的一两处。标题只在长文档里用，聊天回复不用。
- 聊天回复不用单独一行的加粗短语充当小标题，如 **关系**、**必改**，列表项也不加粗引导词。内容要分块时，用一句话开头点明这一块讲什么。
- 中文和英文、中文和数字之间加空格。数字和单位之间也加空格，如 `10 Gbps`，`%` 和 `°` 除外。中文句子用全角标点。
- 用具体的数和事代替空泛的词：写"响应时间从 800 ms 降到 120 ms"，不写"显著提升"；写清哪里出错，不写"存在一定问题"。
- 代码里的名字原样写在反引号里，不翻译：包名、服务名、事件名、配置字段、命令、路径。专有名词照官方大小写，如 GitHub、TypeScript。
- 概念词沿用 [docs/01-architecture.md §7.3](docs/01-architecture.md#73-术语表) 术语表的写法，如行、投影、信封、准入。表里没有的词保留常用英文原词，如 API、cache、commit、seam。同一个概念全文只用一种写法。
- 不用"赋能""抓手""闭环""助力""打通"这类套话，也不用"值得注意的是""需要指出的是""总的来说""换句话说"这类垫话。

### Artifact 和文档

- 长度按任务需要：讲清实质内容，不加凑数的章节、重复的总结和套话。
- 标题下第一段用三到五句话写清：这是什么，结论是什么，需要读者决定什么。待决定的事单独列出，每条写明选项和你的建议。读者只看这一段就能决定下一步。
- 每节第一句是本节结论，依据放在后面。
- 一张图能说清的，不写成段落。图下用一两句话说明看哪里。
- 同一个事实只写一处，别处链接过去。表格每格放一个短语或一句话。

### 示例

<examples>
<example>
用户问：agent 自己的工具什么时候对模型可见？
差：这是一个很好的问题。关于工具可见性，我们需要先从 tool-policy 插件的整体设计说起……（三段背景）……综上所述，工具是否可见取决于多方面因素。
好：看工具的 `visibility`。`always` 的工具一直可见。`auto` 的工具默认不进模型请求，要等插件为这个 agent 激活它：技能路由会激活当前技能 `requiredTools` 里的工具，agent 也可以在 `lyteboat/pre-assemble` 的监听里调用 `host.toolPolicy.activate`。实现在 `lyteboat/plugins/tool-policy/src/index.ts`。
</example>

<example>
用户问：这个能力放进内核，还是做成插件？
差：值得注意的是，对于这个问题来说，存在多种可能的方案，各有优劣，需要综合考虑多方面因素后再做出决定。
好：做成插件。它只需要监听 `lyteboat/pre-assemble`，现有 seam 够用。"Outside the kernel first" 要求先在内核外做。改内核要走分类提交，以后每次同步上游都要带着这段改动合并。
</example>

<example>
描述一次修复。
差：针对在 `DSH_TOOLS_MODE` 被设置为 `ptc` 的情况下业务 one-shot 无法正常启动的问题，我们通过在 `@lyteboat/base`（业务底座，即 headless-agent、serve、eval 等 profile 在 dsh-base 之后列出的 bundle）中对工具注册表的模式进行固定的方式，实现了对该问题的修复。
好：设了 `DSH_TOOLS_MODE=ptc`，业务 one-shot 就起不来，因为业务底座没有 PTC 运行时。现在 `@lyteboat/base` 把工具注册表固定在 native 模式，同一条命令正常退出。
</example>

<example>
任务做完后的汇报。
差：好的，我已经完成了您要求的修改。首先，我阅读了 CLAUDE.md 和相关源码，了解了项目的整体结构；然后，我对相关文件进行了修改……总的来说，本次修改有效提升了系统的健壮性。如果还有其他需要，请随时告诉我！
好：已推送到 `<branch>`。原来装过插件后，`lyteboat web` 下次启动会被拒绝：dsh 的插件管理器往 profile 的 bundle 列表末尾追加，而启动要求列表和模板完全一致。现在只要求列表以模板开头。加了一条 profile 模板的 e2e。`pnpm run lint` 和 `pnpm run test` 通过。G4–G6 没跑，改动只在 CLI，碰不到兼容性闸门。
</example>
</examples>

## Stack

TypeScript 6 (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM only, Node ^22.19 || >=24 · pnpm 11 workspaces (`lyteboat/*/*`, `examples/*/*`, `dsh/*/*`; `overrides` route the kernel names to `dsh/`) · `tsc -b` with project references, then tsdown for the kernel bundles (upstream's own build) · vitest 4 (unit, composite, e2e, and upstream's kernel tests in one runner) · oxlint (`correctness` = error) · Cordis 4 IoC (`@deepseek-ai/cordis`) · dsh 0.2.0-rc.2: the kernel from `dsh/`, every other dsh package from npm as a peer dependency · `@deepseek-ai/schemastery` for plugin `Config`, zod for the JSON envelopes lyteboat writes and its projection states.

## Repository layout

The layers and what each package does are in README.md「项目结构」; `dsh/kernel.json` lists the kernel. The rules:

- Under `lyteboat/`, one directory per layer, and a package's layer is its directory. `lyteboat/apps/*` owns a process, and only `lyteboat/apps/cli` owns a bin. `lyteboat/bundles/*` are compositions a profile includes by name, with no bin of their own. `lyteboat/plugins/*` are the capabilities the bundles wire together, `lyteboat/core/*` are declarations, and `lyteboat/test-support/*` is test infrastructure no runtime package depends on.
- Business agents are not part of the distribution. They sit beside it in `examples/<kind>/*`, build on `lyteboat/`, and nothing in `lyteboat/` names them. A new runnable mode (an SDK entry, say) is a new `lyteboat/bundles/<name>`, not a second app and not a branch inside `@lyteboat/serve`.
- Each lyteboat package has `src/` (compiled to `lib/`, gitignored), `tests/`, its own `tsconfig.json` with `references` to every workspace package it imports (kernel packages included), and an entry in the root `tsconfig.json`. Its package.json has an `exports` entry per public subpath whose first key is the `@lyteboat/source` condition pointing at `src/*.ts`.
- `exports` is the only resolution table; there is no `paths` table. Typecheck (`customConditions` in `lyteboat/tsconfig.base.json`) and vitest set `@lyteboat/source` and read `src`. Node, the built CLI (`lyteboat/apps/cli/lib/bin.js`), and cordis compositions use the default conditions and load `lib/`.
- Kernel packages keep upstream's layout and manifests. `tsc` emits `lib/types/` and `scripts/dist/bundle-kernel.ts` bundles `lib/index.js` with tsdown. lyteboat's packages load the kernel's built `lib/`, so a kernel change needs `pnpm run build` before lyteboat's unit tests see it.
- `@lyteboat/studio-web` is the one package with a browser side. Its `src/client/` is a React app that `tsconfig.client.json` only type-checks and `scripts/dist/build-studio-web.ts` bundles with Vite into `lib/web/`.

## Architecture boundaries

Dependencies flow downward only:

```
examples/*/*                    ← business agents and their compositions, beside the distribution; may depend on any lyteboat plugin; nothing depends on them
apps/*                          ← processes: they select and boot compositions; they name bundles and rows, they import no plugin
bundles/*                       ← compositions: they wire, they do not implement behavior
plugins/*                       ← lyteboat plugins; depend on core + dsh seams; between plugins only `import type` (a service declaration)
core/contracts                  ← types, constants, declaration merging, and the schemas of the types it declares; no other runtime behavior
test-support/*                  ← tests only (devDependencies); depends on core + dsh
dsh/ (the kernel) + @deepseek-ai/dsh-* from npm
                                ← the seams: tools, skills, llm, sessions, sessionProjections, systemPrompt, agents, presets;
                                  the kernel knows no lyteboat package
```

`pnpm run lint` enforces the direction with `scripts/check-layers.ts` (runtime edges per layer, devDependency edges to `lyteboat/test-support/*`, between bundles, and from `examples/*/*` to `lyteboat/bundles/*` and `lyteboat/apps/*`, no edge into `examples/`, value imports between plugins, no `@lyteboat/*` anywhere in the kernel), and with knip the declarations (every import a package's `src` or `tests` makes resolves through a dependency that package declares) and dead exports (knip's `exports` and `types` checks).

Hard rules:

- **contracts is the only shared declaration home.** It holds types, constants, declaration merging, and the schemas of the types it declares; no other runtime behavior. A new event, log node, projection key, or metadata field is declared once in `@lyteboat/contracts` (declaration merging onto dsh's `Events` / `SessionEventMap` / `SessionProjectionStateMap`). A plugin that needs another plugin's data reads it through a projection or a service `inject`, never through a shared module.
- **Plugins sit on dsh seams; they do not re-implement them.** Tools go through `ctx.tools`, skills through `ctx.skills`, model calls through `ctx.llm`, state through `ctx.sessionProjections`, prompt text through `ctx.systemPrompt`. If a seam is missing, first check whether dsh already has one under a different name.
- **Outside the kernel first.** A new behavior is a lyteboat plugin, a seam provider, or a lyteboat-owned seam before it is a kernel change; the kernel takes only harness-level capabilities, never business vocabulary. A kernel change is a design decision: the design document says why it cannot live outside, and which change class it is.
- **Kernel rules** (`.claude/rules/kernel.md`). The kernel changes only by classified commits: `Dist-Change` and the trailers its class requires, checked by `pnpm run dist:delta -- --check`. A distribution policy changes composition, never code. The contract only grows, by registration in `dsh-compat/contract/extensions.yml`. Upstream's tests (`dsh/*/*/tests` outside `tests/lyteboat/`) are never edited. Promotion moves an npm dsh package into the kernel only on the conditions that file lists.
- **Composition is data.** `lyteboat/bundles/base/cordis.patch.yml` is the business base every business profile lists after dsh-base: lyteboat's service rows (the distro marker first), and every dsh-base capability a business agent has not declared turned off; `lyteboat/bundles/serve/cordis.patch.yml` turns it into the service mode, `lyteboat/bundles/eval/cordis.patch.yml` the eval mode, `lyteboat/bundles/studio/cordis.patch.yml` the Studio workshop, `lyteboat/bundles/inspect/cordis.patch.yml` the inspect mode; an agent's rows are its `lyteboatAgentDef` (`./lib/agent.js`, the default when the agent has no `agent.cordis.yml`) and whatever rows its own `agent.cordis.yml` adds. Host rows publish services (`@lyteboat/distro`, `@lyteboat/tool-policy`, `@lyteboat/model-side-call`, `@lyteboat/request-context`, `@lyteboat/turn-outcome`, `@lyteboat/request-admission`, `@lyteboat/skill-router`, `@lyteboat/a2ui`, `@lyteboat/history-import`); an agent's `lyteboatAgentDef` declares against them in the agent's standing scope. An agent row must never publish a service into the root realm.
- **Framework packages stay domain-neutral.** `lyteboat/bundles/*`, `lyteboat/plugins/*`, and `lyteboat/core/*` know no business vocabulary; asset buckets, personas, and Chinese product copy live under `examples/agents/*`. Strings ported from the reference implementation for golden fidelity (error messages, digest formats) are allowed inside `a2ui` and say so in a comment. One exception: the Studio's pages (`lyteboat/plugins/studio-web/src/client`) keep the original Studio's mixed Chinese and English interface copy; it is the framework's own product interface and names no business domain.
- **Model-visible ⟺ logged** (dsh rule, lyteboat inherits it). Anything that reaches a model request is reconstructable from the session log. lyteboat's facts ride dsh envelopes (`tool/result.meta.lyteboat.{cards,stateDelta}`, the assistant `source` of a reply, dsh's skill-invocation message for a routed skill, the human message's `source.lyteboatRequest` for its request context and admission verdict); lyteboat's one record type of its own is `lyteboat/aux-llm-call`, an ignorable audit of a side model call. A new model-visible input needs the same treatment: an existing envelope first, a new node in contracts only with the persist-and-reopen proof below.
- **A new session event type is proven reopenable before it ships.** dsh's persistence layer refuses a stored log that carries an event type outside its compiled catalog unless the event is marked `ignorable`. The kernel extension `session-append-ignorable` lets `Session.append(type, data, { ignorable: true })` set the mark, and only a purely informational record may use it (a reader that skips it must rebuild the same session, as `lyteboat/aux-llm-call`); a fact a reader needs never rides an ignorable record. Prefer folding a fact into an existing envelope (`tool/result.meta`, the assistant message `source`, a message `source`) over a new node; a new node needs a persist-and-reopen test, and the design document records it.
- **Plugin code rules** (`.claude/rules/typescript.md`): registrations are effects, waterfall listeners call `next()`, projections return the same reference when nothing changed and fold appended nodes only.
- **Prompt orders.** Context `lyteboat:state` 130 (`LYTEBOAT_STATE_CONTEXT_ORDER`); section `lyteboat:skills` 450 (`LYTEBOAT_SKILLS_SECTION_ORDER`). New prompt text picks an order relative to these and to dsh's own (`dsh/core/system-prompt/src/index.ts`: runtime contexts 110–120, sections from -1000; the business base turns off the rows behind dsh's runtime contexts) and records it in contracts.

## Coding conventions

- **Tooling**: `pnpm` only (never `npm install`/`yarn`). New dependencies are added to the owning package; dsh and cordis packages are `peerDependencies` (+ `devDependencies`) written as `catalog:dsh` / `catalog:cordis`, never a literal version, with one exception: a non-kernel dsh peer is the tracked release's exact version, because dsh's startup admission reads a row's dsh peers from the manifest on disk, where pnpm leaves `catalog:` unresolved, and refuses a row it cannot match. The catalogs in `pnpm-workspace.yaml` and those peers mirror `dsh.upstream.json` (`scripts/upstream-pins.spec.ts` enforces both). Third-party packages used by more than one workspace package go through the default `catalog:`. Workspace packages use `workspace:*`.
- **ESM everywhere.** Package names across packages, `.ts` extensions in local relative imports (`rewriteRelativeImportExtensions` turns them into `.js` in `lib/`). No CJS-only exports; `.pnpmfile.cjs` is the one CommonJS file and pnpm requires it.
- **Names carry their owner**: `LyteboatToolMeta` not `Meta`, `lyteboatActiveSkill` not `activeSkill`; events and log nodes are `lyteboat/<noun>`, projection keys `lyteboat<Noun>`. The full naming rules, with the code-level ones (capability probing, strict types, validation, limits, logging, comments), are in `.claude/rules/typescript.md`.
- **The reference implementation stays unnamed.** The Python framework lyteboat is ported from is an internal project: its name, any short form of it, and any translation of it (in Chinese as well as English) never appear in code, identifiers, comments, documents, test titles, fixtures, commit messages, PR descriptions, or explanations to the user. Call it *the reference implementation* (参考实现); when a port needs provenance, cite the file path (`template_engine/walker.py`), not the project.
- **Misconfiguration fails loud.** Unknown tool names in a policy, an unknown agent, a missing template directory, a malformed manifest, a `Config` that fails its schema: throw at load, or at the earliest point the referent can be resolved. Never silently skip a missing referent. Degradations the design accepts (router timeout keeps the current skill, a card binding that fails to resolve renders empty) are logged at `warn` and recorded in the session log where the model would otherwise see a different world.
- **No hardcoded tunables in plugins.** Anything a deployment would change (router timeout, history window, provider/model, template roots, validation strictness) is a validated `Config` field settable from `cordis.yml`. Protocol constants (prompt orders, event names, the reference router prompt, surface-id format) stay fixed constants with a name.
- **A plugin is a class.** Every lyteboat plugin module default-exports one class: a `Service` subclass when it publishes a service, otherwise a plain class named for its role (`TurnMetricsRecorder`, `LyteboatServeStartup`). Its dependencies are `static inject`, its schema `static Config`, its constructor takes `(ctx, <owner>Config)`, and async start-up goes in `async [Service.init]()`. A module with a default export exports no `name`, `inject`, `Config` value, or `apply`: Cordis's loader takes the default and drops them. A business agent's module default-exports `lyteboatAgentDef({…})`, which returns such a class; `@lyteboat/agent-def` itself is a library, not a plugin module. Exempt: the `--plugin` test fixtures and the plain-dsh-row agent fixtures, which stand for third-party code (lyteboat loads any Cordis shape); and the kernel under `dsh/`, which keeps upstream's shapes.
- Files elsewhere adapted from dsh keep the header `Adapted from deepseek-ai/deepseek-harness` and are listed by that header in `THIRD_PARTY_NOTICES.md`.
- Files end with exactly one trailing newline. No `TODO` without an owner and a reason.

## Workflow

### Milestones and steps

Work is delivered one runnable milestone at a time, and a large milestone is split into steps that each end with something you can run from the built CLI. Every step follows the same order, and none of it is skipped for speed:

1. **Think.** Read the dsh seam the step lands on and, for a port, the reference source. Write down what is ported verbatim, what deviates and why, and which dsh rule constrains the design.
2. **Design.** Add the step to the design document (C2 which packages, C3 which services / events / projections, C4 the types and the log nodes) before writing code. When the change touches a public event, a projection key, or the kernel (`dsh/`), stop and confirm with the user.
3. **Review the design** against this file's rules and dsh's AGENTS.md; fix the design, not the code, when a clean test cannot be written.
4. **Implement** with the tests from the [test table](#testing), then run the gates [Done criteria](#done-criteria) names.
5. **Accept.** Run the milestone's acceptance on the built binary with the scripted model, record the result (what was run, what the log showed) in the design document's acceptance log, and only then commit.

### Task types

**Simple** (`bug` / `chore` / docs / config): fix it, add the tests the [test table](#testing) asks for (a regression test for a bug, none for docs), and run the gates the change can affect.

**Structural** (`feature` / `refactor` / a new plugin or agent): design top-down through the C4 layers before code: C1 system context (what lyteboat, dsh, the model, and the client see) → C2 containers (launcher, bundles, kernel, plugins, agents, tests) → C3 components (services, events, projections, prompt sections and their orders) → C4 code (types in contracts, hunks, log nodes, event ordering). The user reviews the design document before any code is written; confirm with them again when the implementation has to depart from it, touches a public contract, or crosses a layer boundary the design did not name.

**Design deliverable** for a structural task: the design document is a self-contained HTML artifact (mermaid inlined, never a CDN), published through the artifact tool, and never committed under the repository. It opens with a few sentences saying what changes, why, and what the user must decide. Then come the C4 diagrams, the step-by-step flow of what the change touches (for a change in the agent loop: one step with intake, pre-assemble, routing, activation, assembly, and one tool call with state delta and card), the changes-and-impact table, and the acceptance log. It follows [中文写作](#中文写作): each part is only as long as the decision needs, and a C4 layer the change leaves alone is one line.

### Scope of change

**Every changed line traces back to the task.** Smaller diff beats tidier diff.

- **Required**: remove imports, helpers, config fields, and events your change orphaned; keep the package table and status of `README.md` and `README.en.md` in step with the code in the same commit.
- **Allowed**: dead-code removal limited to files you already edit, provably unreferenced, not a public export.
- **Forbidden**: drive-by renames or reformatting, refactors of working code outside the task, unclassified edits under `dsh/<group>/<package>/`, edits to upstream's test files, lint fixes in untouched files, changes to `data/`, `.env*`, `.github/`, `dsh.upstream.json`, or `.pnpmfile.cjs` without an explicit instruction.

### Done criteria

Run only the gates the change can affect, and report only the commands you ran.

1. Touched `src/` or `tests/`? `pnpm run lint` and `pnpm run test` (build, G1, spec, composite, e2e, and G2) pass; `pnpm run check` adds the compatibility gates (G4–G6). `pnpm run test:unit` is the fast loop while iterating (the kernel must have been built once).
2. Touched types or a `tsconfig.json`? `pnpm run typecheck` (sources and tests) introduces no new errors.
3. Tests for the new code match the [test table](#testing).
4. Touched anything a user runs (CLI flags, `cordis.patch.yml`, an agent)? Run it once from the built binary (`node lyteboat/apps/cli/lib/bin.js …`) with the scripted model or a real key, and paste the command in the commit or PR.
5. Touched `dsh/`? `pnpm run test` runs G1 and G2, `pnpm run dsh-compat` runs G4–G6; `pnpm run dist:delta -- --check` passes; `pnpm run dist:overlay <upstream checkout> persistence` passes when the change can reach a persisted type, and `… typert` when it touches a package that publishes Typert files; the extension, if any, is in `dsh-compat/contract/extensions.yml` and `pnpm run lint` regenerated nothing stale.
6. Diff is in scope; `README.md` and the design document are current.

## Testing

| Task type | Tests required |
|---|---|
| `feature` / new plugin | Unit: happy path + ≥1 boundary case on the unit host (`createLyteboatUnitHost` + `MockAdapter` from `@lyteboat/testkit`). Composition: one `*.composite.ts` in the bundle (or agent) that wires it, booting the composition in process with the scripted model and asserting on the session log. A new process surface (a flag, a bin, a profile) also gets an `lyteboat/apps/<app>/tests/*.e2e.ts` on the built binary. |
| port from the reference implementation | Golden fixtures generated by the reference implementation's Python code, compared with deep equality; each deliberate deviation is a named test. |
| `bug` | Regression test that fails before and passes after. |
| `refactor` | Existing tests pass before and after; no new tests unless behavior moved. |
| `chore` / docs | Skip; run the existing suite if a touched path could regress. |

Conventions:

- **Tests are type-checked, not only transpiled.** `tsc -b` covers `src/` only and vitest strips types, so `pnpm run typecheck` also runs `tsc -p tsconfig.tests.json`; CI runs it.
- **Tests describe behavior, not implementation.** Name them `test('<subject> <does what> when <condition>')`; assert on session-log nodes, projection state, the model request the scripted server recorded, or the tool result, never on private fields.
- **Mock the boundary, not the unit.** The model (`MockAdapter` in unit tests, the scripted DeepSeek Messages server in e2e), the filesystem for skills and templates (fixtures under `tests/fixtures`), the clock when ordering matters. Never mock a lyteboat service to test another lyteboat service; mount both.
- **Who tests what.** `lyteboat/plugins/*` and `lyteboat/core/*` test their own behavior (`*.spec.ts`, in process, from `src`); `lyteboat/bundles/*` and `examples/agents/*` test their composition (`*.composite.ts`); `lyteboat/apps/*` test only their process surface — flags, help, exit codes, profiles — plus one built-binary smoke per bundle (`*.e2e.ts`); an agent's built-binary smoke is in its own `tests/`. A test never reaches into another package's `tests/` or `src/` by relative path; shared helpers live in `@lyteboat/testkit`.
- One `test.skip` is acceptable only with a reason string; a skipped new test marks the step ⚠️ partial in the design document.
- The unit harness, kernel tests, composition and e2e runs, the scripted model, and where fixtures live: `.claude/rules/testing.md`.

## Unattended runs

- Work only on the branch the task designates. Never push to `main` / `master` / `develop`; never force-push, rebase, or amend a pushed commit without explicit permission; a rewrite that is permitted uses `--force-with-lease`.
- If the designated branch's PR is already merged, restart the branch from `origin/master` and treat the work as a new change.
- One focused fix attempt on a failing new test. Still failing → mark ⚠️ partial, skip the test with a reason, and say so in the commit and the design document.
- State assumptions in the commit message and the PR description instead of guessing silently; never create a PR unless asked.
- Never modify `.github/`, `dsh.upstream.json`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, `.env*`, or anything under `dsh/` outside a classified commit without explicit instruction.
- Commit messages: `<type>: <package> — <what it delivers>` with a conventional type (`feat: @lyteboat/tool-policy — …`, `fix:`, `refactor:`, `test:`, `chore:`, `docs:`), followed by a body that states what runs and what was accepted. End with the attribution trailers the session provides.
- Every commit also carries `Co-authored-by: $GIT_COAUTHOR` in its closing trailers, the value read from the environment, so GitHub credits the person who asked for the change. Each contributor sets `GIT_COAUTHOR` in their own cloud environment as `Name <email>`, the email bound to their GitHub account or their `ID+username@users.noreply.github.com` address. If `GIT_COAUTHOR` is unset, ask the user for it before committing. The import commits `dist:import` writes are the exception: their tree is the tag's and their message is the tool's.
- Never put a model identifier in a commit, PR, code comment, or file.

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install` (CI uses `--frozen-lockfile`) |
| Build | `pnpm run build` (`tsc -b`; emits every package's `lib/`) |
| Lint | `pnpm run lint` |
| Typecheck sources and tests | `pnpm run typecheck` |
| Unit tests (fast loop, no build, no composite or e2e) | `pnpm run test:unit` |
| All tests (spec + composite + e2e, builds first) | `pnpm run test` |
| What CI runs (build, G1, lyteboat's tests, G2) | `pnpm run test` (after `pnpm run lint` and `pnpm run typecheck`) |
| G4–G6 against the official release | `pnpm run dsh-compat` |
| Everything | `pnpm run check` (lint + test + dsh-compat) |
| Show one test's console output | `npx vitest run <file> --silent=false --reporter=verbose` |
| dsh's own web app and one-shot task (the native base) | `node lyteboat/apps/cli/lib/bin.js web --no-open` · `node lyteboat/apps/cli/lib/bin.js headless "task"` (needs `DEEPSEEK_API_KEY` or a scripted model via `DEEPSEEK_BASE_URL`) |
| A plugin file | `node lyteboat/apps/cli/lib/bin.js serve --agents ./examples/agents --plugin ./my-plugin.mjs` (on the business base; `headless --plugin` on the native one-shot) |
| Run an agent's eval cases | `node lyteboat/apps/cli/lib/bin.js eval --agents ./examples/agents --agent finance` (a real run: needs `DEEPSEEK_API_KEY`) |
| Replay a recorded eval run (no key) | `node lyteboat/apps/cli/lib/bin.js eval --agents ./examples/agents --agent finance --model replay --from examples/agents/finance/evals/baseline` |
| Serve agents over HTTP | `node lyteboat/apps/cli/lib/bin.js serve --agents ./examples/agents` (`POST /chat`; `--port`, `--host`, `--auth shared-secret`) |
| Ask a served agent | `curl -s http://127.0.0.1:8080/chat -H 'content-type: application/json' -d '{"agent_id":"finance","user_id":"u1","message":"看看我的资产","context":{"customer":"young-idle-cash"}}'` (`session_id` continues a session; `history` with a `trace_id` imports the caller's earlier rounds) |
| Release an agent (the gate replays its `evals/baseline`, then writes `<agent>/agent.release.json`) | `node lyteboat/apps/cli/lib/bin.js release --agents ./examples/agents --agent finance` (no key; the example agent commits no lock) |
| What an agent is made of (no model) | `node lyteboat/apps/cli/lib/bin.js inspect --agents ./examples/agents --agent finance` (`--result json` for one object; exit 1 when it does not mount) |
| Serve an agent as released | `node lyteboat/apps/cli/lib/bin.js serve --release examples/agents/finance/agent.release.json` (serve with the build that released it) |
| Make a Studio account (password on stdin) | `node lyteboat/apps/cli/lib/bin.js studio account add admin --role admin < pw.txt` |
| Serve the Studio workshop | `node lyteboat/apps/cli/lib/bin.js studio --agents ./examples/agents` (pages at `/studio/`, API at `/api/studio`; `--port`, `--host`, `--trusted-host`, `--gateway-secret-env`) |
| Composed plugin tree | `node lyteboat/apps/cli/lib/bin.js config dump --profile serve` |

All lyteboat data lives under `$LYTEBOAT_HOME` (default `~/.lyteboat`); the launcher exports it as `DSH_HOME` before any dsh package loads, so a user's `~/.dsh` is never touched. The shared agent root (`DSH_AGENTS_HOME`, default `~/.agents`) stays as the user has it: the native profiles read its skills as dsh does, and the business base turns dsh's default skill roots off. Set `DSH_TELEMETRY_DISABLED=1` in tests and CI.

## 写给用户时

第一句给结论。一句只讲一件事。讲结果和依据，不讲过程。细则见「中文写作」。
