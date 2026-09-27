# 基于 lyteboat 开发业务 agent

> 适用范围：lyteboat 当前代码，跟踪 dsh `0.1.7-rc.2`，内核 14 个包（`dsh/kernel.json`）。仓库里现成的示例 agent 只有一个：刻意做到最小的金融智能体 `examples/agents/finance`（三个路由技能、三个工具、四张卡、进入循环之前的准入），文中提到的「金融智能体」都指它。
> 读者：熟悉参考实现（Python 前身）、刚接触 dsh 的工程师。dsh / Cordis 的术语先看 §0.6，完整的架构与启动过程见 [01-architecture.md](01-architecture.md)。
> 贯穿全文的例子是「保单查询助手」（agent id `policy-desk`）。它不在仓库里：照本文逐字建出来之后，`pnpm run lint`、`pnpm run typecheck`、`pnpm run test` 全部通过（§2.17），文中的命令输出和日志片段都来自在构建好的二进制上用脚本模型的运行，过长处注明了裁剪，本机路径和随机的 id、摘要换成了占位符。
> 仓库里的代码按文件加符号名引用，不写行号。路径若不加说明，都相对仓库根（仓库里还有一个同名子目录 `lyteboat/`，放 lyteboat 自己的各层包；业务 agent 不在其中，而在与它并列的 `examples/agents/` 下）。「上游」指 dsh 在 tag `dsh-v0.1.7-rc.2` 上的源码（`packages/<group>/<pkg>/src`），lyteboat 从 npm 安装的 dsh 包以它为准。引用 `CLAUDE.md` 时写它的章节名。

---

## 0. 一页纸总结

### 0.1 agent 就是一个目录

一个业务 agent 是 `examples/agents/<id>/`，目录名就是 id（`CLAUDE.md`「Agent design」）。其中唯一必需的文件是 `agent.cordis.yml`。agent 不属于发行版：它在 `lyteboat/` 旁边，建在 `lyteboat/` 的插件之上，`lyteboat/` 里没有任何东西提到它（`CLAUDE.md`「Repository layout」）。`lyteboat try --agents <根目录> --agent <id>` 读这个目录，把它登记给 dsh 的 `dsh-agent-preset-registry`（dsh 把它叫 preset），然后为这次运行的会话创建一个 `Agent` 实例并挂到这个 preset 上（`lyteboat/plugins/agent-catalog/src/index.ts` `AgentCatalogService.declare`、`lyteboat/bundles/try/src/index.ts` `run`）。「preset」这个词在 lyteboat 里只指这套登记机制；一个 agent 定义可以有很多个运行时实例（同一节）。

### 0.2 和参考实现的对应

参考实现的一个 agent 是 `agent.py` 里的 instructions / callbacks，加上 `skills/`、`tools/`、`capabilities/`。lyteboat 保留了同样的四层（参考实现 `docs/agent_design_principles.md` §1），只换了机制：

| 参考实现 | lyteboat 里写在哪 |
|---|---|
| L1 Agent：身份、红线、节奏 | `agent.cordis.yml` 里的 `persona` 行；硬拒识写成准入函数（`src/intake.ts` 用 `ctx.intakeGuard.register` 登记），请求进入循环之前就判定 |
| L2 Skill：`SKILL.md`，description 是路由信号 | `assets/skills/<name>/SKILL.md`；`metadata.lyteboat.requiredTools` 对应参考实现的 `required_tools`，也是 `metadata.lyteboat` 里唯一的键 |
| L3 Tool：薄工具，digest 回传 | `src/tools.ts` 里 `ctx.toolPolicy.register(defineTool(...), meta)` |
| L4 Capability：纯代码、阈值、数据源 | `src/*.ts` 里的纯函数（例子里的 `src/policies.ts`） |
| `state_delta` | `ctx.toolPolicy.register(def, { stateDelta })` → 日志里的 `tool/result.meta.lyteboat.stateDelta` → `lyteboatState` 投影。参考实现的 `output_state_keys`（声明并校验状态键）没有对应物：`LyteboatToolMeta` 只有 `visibility`、`stateDelta` 两个字段（`lyteboat/core/contracts/src/index.ts`） |
| A2UI 模板卡 | `assets/a2ui/<card>/`。工具用 `ctx.a2ui.renderCard(...)` 渲染一张卡，用 `cardsPresentationMeta(cards)` 把卡放上结果的 `meta.lyteboat.cards`（一个结果可以带多张），digest 里用 `cardMarker(area)` 写出回答放卡用的 `[[card:<区域>]]` 标记 |

### 0.3 框架替你做的事

每个 lyteboat profile 都带 `@lyteboat/host`，它在宿主平面发布这些服务（`lyteboat/bundles/host/cordis.patch.yml`）：`toolPolicy`（工具可见性、状态增量）、`auxLlm`（旁路模型调用，每次在会话日志里留一条审计记录）、`requestContext`（请求上下文）、`intakeGuard`（准入）、`skillRouter`（参考实现的技能路由）、`a2ui`（参考实现的卡片模板引擎，以及一轮回答里卡片的排布）、`historyImport`（外部历史导入）。内核的 agent loop 在每一步组装 prompt 之前多派发两个 waterfall 事件：`lyteboat/intake`（拒识，直接回复且不请求模型）和 `lyteboat/pre-assemble`（路由技能、激活工具，并在同一步生效）（`dsh/core/agent-loop/src/agent.ts` `ReactLoopAgent.preStep`）。你只写业务。

和「一次请求」有关的三件事也由框架做：

- **请求上下文。** `lyteboat try --context <json|文件>` 把一个 JSON 对象（谁在问、从哪个渠道来……）随请求记在人类消息的 `source.lyteboatRequest.context` 上（`lyteboat/bundles/try/src/startup.ts` `readContext`）。`lyteboatRequest` 投影保存会话的上下文：后面的请求不带上下文，就沿用上一次的。上下文只落日志、不发给模型，工具用 `ctx.requestContext.contextOf(exec.agent)` 读；凭据不要放进去（`lyteboat/plugins/request-context/src/index.ts`）。
- **准入。** agent 用 `ctx.intakeGuard.register({ name, admit })` 登记一个准入函数。调用方用 `ctx.intakeGuard.submit(agent, { text, context?, requestId?, owner?, agent? }, signal)` 提交每个请求：`agent` 是 agent 的身份（§4.16），记在同一条消息上；`submit` 先调用这个 agent 的准入函数，再把请求连同判定（`decision: 'pass' | 'reply'`、`verdict`、`text`、`cards`）作为一条人类消息交给 agent，判定记在 `source.lyteboatRequest.intake` 上（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService.submit`、`IntakeGuardService.admit`）。`lyteboat try` 就是这样提交任务的，发起者记成 `{ kind: 'operator', id: 'cli' }`，带上 agent 目录的身份（`lyteboat/bundles/try/src/index.ts` `run`）。判定是 `reply` 时，循环里直接用 `text` 作答，不请求模型（§2.11）。
- **旁路调用。** agent 自己要问模型一个小问题（例如给请求分类）时，用 `ctx.auxLlm.generate({ agent, purpose, system, prompt, maxTokens, timeoutMs, signal })`：它默认用 agent 的模型，带自己的超时，并在会话日志里追加一条标为可忽略的 `lyteboat/aux-llm-call` 记录（`lyteboat/plugins/aux-llm/src/index.ts`）。失败是返回值，不是异常，由调用方决定怎么退路。skill-router 的路由请求也走它；金融智能体的准入分类是现成的例子（`examples/agents/finance/src/intake/finance-admission.ts` `financeAdmission`）。

agent 行要用哪个宿主服务，就在 `inject` 里写它的名字（`toolPolicy`、`a2ui`、`skills`、`requestContext`、`intakeGuard`、`auxLlm`……），在 `src` 里写一行 `import type {} from '<包名>'` 把服务的类型并进 `Context`，在 `package.json` 的 `peerDependencies` 和 `devDependencies` 里各写一次 `"<包名>": "workspace:*"`，在 `tsconfig.json` 的 `references` 里加上它的目录。金融智能体几个服务都用，照它写即可：`examples/agents/finance/src/agent.ts`，以及同目录的 `package.json`、`tsconfig.json`。服务名、包名和目录的对应见 §7.8。

五种基础能力在每个组合里都是现成的，agent 不需要自己初始化：

| 能力 | 谁提供 | agent 里怎么用 |
|---|---|---|
| llm | 内核 `@deepseek-ai/dsh-llm`（`dsh/llm/llm`），服务 `ctx.llm`；loop 用哪个模型由 `agentDefaultModel` 决定（§4.12） | agent 一般不直接调模型；要问模型时走旁路调用 `ctx.auxLlm.generate`（上面第三条），它再用 `ctx.llm.stream` 发出（`lyteboat/plugins/aux-llm/src/index.ts`）。skill-router 的路由请求就是这样一次旁路调用（`lyteboat/plugins/skill-router/src/index.ts` `SkillRouterService.decide`） |
| tool | 内核 `@deepseek-ai/dsh-tools`（`ctx.tools`）+ lyteboat 的 `ctx.toolPolicy` | `ctx.toolPolicy.register(defineTool(...), meta)`（§2.10） |
| skill | 内核 `@deepseek-ai/dsh-skill`（`ctx.skills`）+ npm 上的 `dsh-skill-filesystem` provider + lyteboat 的 `ctx.skillRouter` | `assets/skills/<name>/SKILL.md`，在自己的行里挂 skill-filesystem（§2.6、§2.10） |
| session | 内核 `dsh-session`、`dsh-session-persistence*`、`dsh-session-projection` | 工具里用 `exec.agent.session`；日志落在 `$LYTEBOAT_HOME/sessions/…`（§3.2）；`lyteboat try --session-id <id>` 在已存的会话上续聊（§4.10） |
| memory | 只有会话内的：`lyteboatState`（工具状态增量折成的投影，每步作为 `lyteboat:state` 发给模型，§4.8）、`lyteboatRequest`（请求上下文，不发给模型），加上会话历史本身 | 没有跨会话记忆。上游 `packages/` 下没有 memory 包；最接近的是 session-query（`session_search` 工具，用 SQLite FTS 检索历史会话），但 dsh-base 把它配成 `path: ':memory:'`、`openAt: never`（`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:149-153`），给模型的工具里也没有 `session_search`。`dsh-agent-instructions` 会把 `$LYTEBOAT_HOME/AGENTS.md` 和项目里的 `AGENTS.md` / `CLAUDE.md` 作为指令交给模型（上游 `packages/context/agent-instructions/src/config.ts:12`、`src/files.ts:285`），这是人写的静态说明，不会自动学习；业务模式（try、serve、eval）的业务底座和 `lyteboat web` 的组合都关掉了它，轻舟的哪个模式都不把它交给模型。社区有记忆插件，例如 G5 金丝雀之一 `@zzerx/dsh-plugin-memory` 0.3.1（`dsh-compat/tests/canaries/canaries.yml`），它在官方树和 lyteboat 树上表现相同；但这类插件各自发布自己的服务名，没有公共 seam，多按全局或工作区分区而不按业务用户分区。可以在自己的 agent 行里挂一个试用，先确认它的分区方式和写入内容符合业务要求 |

五个能力的包都在 `dsh/kernel.json` 里（`CLAUDE.md`「Architecture boundaries」的 Promotion 一条：llm 和 skill 是每个组合启动都需要的能力），所以任何 lyteboat 组合都一定带着它们。

### 0.4 agent 能在哪里跑

加载 agent 目录的有这几处：`lyteboat try`、`lyteboat serve`（§4.13）、`lyteboat eval`（§4.14）、`lyteboat web`（§4.15）、`lyteboat studio`（§4.17）、`lyteboat inspect`（§4.18），以及 composite 测试里的 `bootComposition` / `startComposition`（§2.15）。`lyteboat try` 是一次性的：一个任务、一轮；这一轮打到 stdout（回答原文，每张卡片各占一行 `[card <区域>]`），会话 id 打到 stderr（`lyteboat: session <id>`），然后退出（`lyteboat/bundles/try/src/index.ts` `run`）。

- **HTTP 服务用 `lyteboat serve`。** 它是常驻的：`--agents` 目录里的每个 agent 都能经 `POST /chat` 调用，同步返回一个 JSON 或返回 enterprise 事件流（§4.13）。
- **在浏览器里看 agent 用 `lyteboat web`。** 它是 dsh web 加上 lyteboat 的页面：`--agents` 目录里的每个 agent 都能在 dsh web 里开会话，目录一改就重新声明；会话右侧栏的 lyteboat 页签带着请求上下文发消息，实时显示激活的技能、请求、卡片和状态（§4.15）。`lyteboat web` 保留 dsh 自己的能力（编码工具、沙箱、审批），会话不按 `/chat` 的方式跑；要按 `/chat` 的样子调试 agent，用 `lyteboat eval` 或 `lyteboat try --agent`。
- **评测用 `lyteboat eval`。** 它把 agent 目录 `evals/` 里的用例逐个跑成新会话、逐轮检查，真实模型的一次运行录下会话，之后不调模型、不要 key 就能回放（§4.14）。
- **在 Studio 工作台里看 agent 用 `lyteboat studio`。** 它带业务底座，agent 的工具、技能和路由按 serve 的样子挂上，只查看、不跑会话：agent 的组成与诊断、serve 留下的会话和运行指标（看板）、评测运行；editor 及以上从页面起评测运行，admin 能热修已有技能的 SKILL.md。先用 `lyteboat studio account add` 建账户（§4.17）。
- **看 agent 由什么组成用 `lyteboat inspect`。** 它按业务模式的样子挂上 agent，打印工具（怎样到达模型）、技能和每个技能的检查、评测用例文件；挂不上就说明原因。不建 agent 实例，不调模型（§4.18）。
- **交给运维用 `lyteboat release`。** agent 在 `agent.yml` 里声明版本和模型、录好基线之后，`lyteboat release` 检查基线并写下发布锁 `agent.release.json`，运维用 `lyteboat serve --release <锁>` 只服务这个 agent，目录里有一个文件变了就拒绝（§4.16）。
- **多轮靠续会话。** 下一次运行加上 `--session-id <上次打出的 id>`，就在同一个会话上接着聊：dsh 的持久化层重开日志，新的一轮能看到前面的轮次，路由过的技能、它的工具、会话状态和请求上下文都还在（§4.10）。要在 agent 自己的组合下续聊，用的就是这个办法。
- **也可以导入外部历史。** 用 `--history <file>` 把外部系统的几轮对话导入成一个新会话的已结束轮次，再跑一轮，例如 `node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent finance --context '{"customer":"young-idle-cash"}' --history lyteboat/bundles/try/tests/fixtures/history/rounds.json "继续刚才的话题"`（`CLAUDE.md`「Commands」，`lyteboat/bundles/try/src/index.ts` `run`）。`--history` 只能开新会话，不能和 `--session-id` 一起用（`lyteboat/bundles/try/src/startup.ts` `apply`）。

### 0.5 五步走

1. **建包**：`examples/agents/<id>/` 下写 `package.json`、`tsconfig.json`，在根 `tsconfig.json` 加引用，在 `README.md` 和 `README.en.md` 的包表里各加一行，然后从干净的 `node_modules` 重新 `pnpm install`。
2. **写组合**：`agent.cordis.yml`（persona、路由、你自己的行）和可选的清单 `agent.yml`（显示名、版本、模型）。
3. **写业务**：`src/`（L4 纯函数、工具行、准入行），以及运行时读的 `assets/`（`skills/` 技能、`a2ui/` 卡片模板、`sample-data/` 业务数据）。
4. **构建并试跑**：`pnpm run build`，然后在 CLI 上用脚本模型跑一遍，读会话日志。
5. **测试与验收**：在 agent 自己的 `tests/` 里写单元测试、composite 测试、e2e 冒烟，跑 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test`。要交给运维时再录基线、`lyteboat release`（§4.14、§4.16）。

### 0.6 术语速查

完整的术语表在 [01-architecture.md §7.3](01-architecture.md#73-术语表)，Cordis 的依赖注入在 [01-architecture.md §2](01-architecture.md#2-生命周期与依赖注入)。本文用到的：

| 术语 | 意思 | 例子 |
|---|---|---|
| 行（row） | Cordis 插件树里的一项：`{ id, name, config }` | `agent.cordis.yml` 的每一项 |
| `!!js` | 行配置里的 YAML 标签，值是加载时求值的 JS 表达式 | `task: !!js ctx.lyteboatTryStartup.task`（`lyteboat/bundles/try/cordis.patch.yml`） |
| patch / bundle | patch 是对行列表的增删改；bundle 是带一层 patch 的包 | `@lyteboat/host` 的 `cordis.patch.yml` 插入八个宿主行，并关掉 dsh-base 的 `session-telemetry-otel` 行 |
| profile | 按顺序列出的 bundle 层 | `try` = dsh-base + `@lyteboat/host` + `@lyteboat/business-base` + `@lyteboat/try`（`lyteboat/apps/cli/src/templates.ts`）；`serve` 的最后一层换成 `@lyteboat/serve`，`eval` 的换成 `@lyteboat/eval`，`studio` 的换成 `@lyteboat/studio`，`inspect` 的换成 `@lyteboat/inspect`；`web` = dsh-base + `@lyteboat/host` + dsh-web-app + `@lyteboat/web` |
| 服务 / seam | 发布在 Context 上、按名字注入的对象；dsh 的扩展点都是服务 | `ctx.tools`、`ctx.skills`、`ctx.llm`、`ctx.systemPrompt`（`CLAUDE.md`「Architecture boundaries」） |
| 根 realm | 宿主行发布服务的全局命名空间 | `toolPolicy`、`a2ui`、`intakeGuard` 在这里 |
| standing scope | preset 注册表给一个 preset 修订创建的作用域，agent 行挂在这里；每个 Agent 实例是它的子作用域 | `policy-desk-tools` 行 |
| waterfall | 洋葱式派发的事件：先注册的监听在外层，每层调 `next()` 进入里层 | `lyteboat/intake`、`lyteboat/pre-assemble`、dsh 的 `agent/pre-step` |
| 投影（projection） | 对会话日志事件的纯折叠 | `lyteboatState`、`lyteboatCards`、`lyteboatActiveSkill`、`lyteboatRequest` |
| runtime context | 每步以 user 消息形式追加的运行时快照，只在文本变化时追加 | `lyteboat:state` |
| 技能调用消息（skill-invocation） | dsh 自己的一种 user 消息，`source` 为 `{ kind: 'skill-invocation', name, form: 'instructions' }`，正文是 `<skill_content name="…">`。dsh-tool-skill 用它记下用户点名的技能；lyteboat 的路由器也用它把路由到的技能正文放进这一步 | §3.2 的 seq 11 |
| 请求上下文（request context） | 调用方随请求传入的 JSON 对象，记在人类消息的 `source.lyteboatRequest.context` 上，不发给模型 | `lyteboat try --context '{"channel":"app"}' …` |
| 准入（admission） | 请求进入循环之前的判定：`pass` 交给模型，`reply` 不请求模型直接作答；`intakeGuard.submit` 把判定记在人类消息的 `source.lyteboatRequest.intake` 上 | `policy-desk-intake` 行登记的函数（§2.11） |
| 旁路调用（side call） | 插件替 agent 向模型发的、不进入 loop 请求的调用；每次记一条 `lyteboat/aux-llm-call` | 路由请求（§3.2 的 seq 6） |
| 可忽略记录（ignorable） | 带 `ignorable: true` 的日志记录：不认识它类型的读者（包括官方 dsh）跳过它，会话照样能重开 | `lyteboat/aux-llm-call` |
| 清单（manifest） | agent 目录里可选的 `agent.yml`：显示字段、`version`、`model`，未知键加载时报错 | §1.3、§2.5 |
| agent 身份（identity） | `{ id, version?, digest }`：目录名、清单的版本、目录内容的摘要；try、`/chat`、eval 记在每条人类消息的 `source.lyteboatRequest.agent` 上，eval 还写进 `run.json` | §4.16 |
| 发布锁（release lock） | `lyteboat release` 写的 `<agent>/agent.release.json`，`lyteboat serve --release` 按它钉住 agent | §4.16 |

---

## 1. agent 的组成

### 1.1 目录结构

仓库里现成的参照是 `examples/agents/finance`。本文新建的 `policy-desk` 完成后长这样：

```
examples/agents/policy-desk/
├── package.json              包身份、exports、files、依赖
├── tsconfig.json             src → lib，references 列出每个引用的工作区包
├── agent.cordis.yml          必需：Cordis 行列表 = preset 的 plugins
├── agent.yml                 可选：清单，显示名 name / description / order，版本 version，模型 model
├── assets/                   运行时读的文件，与 src/、lib/ 同级
│   ├── skills/
│   │   └── policy-lookup/SKILL.md   技能：frontmatter + 正文
│   ├── a2ui/
│   │   └── policy_card/      一张卡一个目录
│   │       ├── template.json     设计稿：components + rootComponentId
│   │       ├── manifest.yaml     出卡模式，以及每个 {"path": k} 的取值规则
│   │       └── compute.js        manifest 里 computed 取值用的具名导出
│   └── sample-data/
│       └── policies.json     业务数据（示例保单簿）
├── src/                      TypeScript 源码，编译到 lib/（lib 被 gitignore）
│   ├── policies.ts           L4：纯函数
│   ├── tools.ts              行：注册工具、挂载技能目录
│   └── intake.ts             行：登记准入函数
└── tests/
    ├── policies.spec.ts      单元测试：纯逻辑
    ├── intake.spec.ts        单元测试：准入判定
    ├── policy-desk.spec.ts   单元测试：两个行挂在单元宿主上（卡片契约、状态、准入的两条路径）
    ├── policy-desk.composite.ts   组合测试：进程内启动 try 组合 + 脚本模型
    └── policy-desk-smoke.e2e.ts   冒烟：构建好的 lyteboat 可执行文件，经 devDependency @lyteboat/cli 找到
```

agent 的文件全在这个目录里，冒烟测试也在它自己的 `tests/` 里（`CLAUDE.md`「Testing」的 Who tests what）。目录外只有三处要跟着改：根 `tsconfig.json` 的一条引用、两份 README 包表里各一行、`pnpm-lock.yaml` 里新的 importer（§2.3）；`lyteboat/` 下的文件一个都不改。

### 1.2 这些文件在运行时变成什么

```mermaid
flowchart LR
  subgraph DISK["examples/agents/policy-desk（磁盘）"]
    ACY["agent.cordis.yml<br/>行列表"]
    PY["agent.yml<br/>清单：显示字段、版本、模型"]
    SKM["assets/skills/policy-lookup/SKILL.md"]
    LIBT["lib/tools.js"]
    LIBI["lib/intake.js"]
    CARD["assets/a2ui/policy_card/"]
    BOOK["assets/sample-data/policies.json"]
  end
  subgraph RUN["try bundle：agent-catalog 行 + agent-preset-registry 行 + @lyteboat/try 行"]
    RD["agent-catalog（readAgentDefinition）<br/>目录即 baseUrl"]
    REG["dsh-agent-preset-registry<br/>preset policy-desk"]
    ADM["任务进入循环之前<br/>intakeGuard.submit"]
  end
  subgraph STAND["preset 常驻作用域（每个 Agent 实例是它的子作用域）"]
    PER["persona 行"]
    SRA["lyteboat-skill-router 行"]
    TSF["policy-desk-tool-surface 行"]
    TOOLS["policy-desk-tools 行"]
    INT["policy-desk-intake 行"]
  end
  subgraph HOST["@lyteboat/host 宿主服务（根 realm）"]
    TP["toolPolicy"]
    SR["skillRouter"]
    AUX["auxLlm"]
    IG["intakeGuard"]
    A2["a2ui"]
  end
  subgraph KERN["dsh 内核 seam"]
    TREG["tools 注册表"]
    SREG["skills 注册表"]
    SP["systemPrompt"]
    LOOP["agent-loop<br/>lyteboat/intake · lyteboat/pre-assemble · agent/pre-step"]
  end
  ACY --> RD
  PY --> RD
  RD --> REG
  REG -->|"mount：加载、审计各行"| STAND
  LIBT -.->|"name: ./lib/tools.js"| TOOLS
  LIBI -.->|"name: ./lib/intake.js"| INT
  PER -->|"persona-prefix 段"| SP
  SRA -->|"declare mode dynamic"| SR
  TSF -->|"declareInherited hidden, declare skill"| TP
  TOOLS -->|"register query_policy, send_policy_copy"| TP
  TP --> TREG
  TOOLS -->|"挂载 skill-filesystem"| SREG
  SKM --> SREG
  TOOLS -->|"renderCard policy_card"| A2
  A2 --> CARD
  TOOLS --> BOOK
  INT -->|"register 准入函数"| IG
  ADM -->|"submit：准入，判定记在请求上，再交给 Agent"| IG
  IG -->|"监听 lyteboat/intake（next 之后按判定作答）"| LOOP
  SR -->|"路由请求"| AUX
  SR -->|"监听 lyteboat/pre-assemble（next 之前路由）<br/>与 agent/pre-step（追加技能正文）"| LOOP
  TP -->|"监听 lyteboat/pre-assemble（next 之后对账）"| LOOP
```

为什么是这个形状：

- **目录就是 `baseUrl`。** `@lyteboat/agent-catalog` 先用 `readAgentDefinition` 读出行和清单（显示字段、版本、模型），算出目录的摘要，查过发布锁的钉和声明的模型（组合打开了这两项时，§4.16），再以目录的 `file:` URL 作为 `baseUrl` 登记（`lyteboat/plugins/agent-catalog/src/index.ts` `AgentCatalogService.declare`）。登记之前被拒的 agent，它的代码不会运行。所以 `./lib/tools.js` 这样的相对行名、行配置里的相对路径，都相对 agent 目录解析。preset 注册表本身是 try patch 插入的另一个 dsh 行，不属于 `@lyteboat/try`（`lyteboat/bundles/try/cordis.patch.yml`）。
- **所有行跑在 preset 的常驻作用域里。** registry 的 `mount()` 把每个 Agent 实例挂成这个常驻 mount 的子作用域，同一 preset 修订版的所有实例共用一次 mount（上游 `packages/preset/agent-preset-registry/src/mount.ts:258`、`src/index.ts:257`）。所以你的行只影响本 agent 的会话，也所以按实例的状态必须按 `Agent` 分键（`CLAUDE.md`「Architecture boundaries」的 Registrations are effects 一条）。
- **宿主服务在根 realm，agent 行只向它们「声明」。** 宿主行发布服务；agent 行只做声明（`@lyteboat/*/agent`）或注册工具、监听器、准入函数，绝不向根 realm 发布服务（`CLAUDE.md`「Architecture boundaries」的 Composition is data 一条）。mount 时发现泄漏的服务会直接失败：`Preset services require isolate realms: …`（上游 `mount.ts:267`）。
- **准入在循环之外。** `@lyteboat/try` 把任务交给 Agent 时用的是 `ctx.intakeGuard.submit`：它问这个 agent 登记的准入函数（作用域链上最近的那个），把判定和任务写进同一条人类消息，再 `followup` 给 Agent（`lyteboat/bundles/try/src/index.ts` `run`，`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService.submit`、`IntakeGuardService.admit`）。循环里 intake-guard 只按记录作答；一条没有经过 `submit` 就进来的消息（调用方直接 `agent.followup`，或者 `/chat`、`lyteboat web` 经 session-controller 送进来的消息，§4.13、§4.15），它在循环里补做一次准入，回复相同，只是判定和判定里的卡片不记在消息上（同文件 `IntakeGuardService.verdictFor`）。

### 1.3 每个文件、每个字段

**`agent.cordis.yml`（必需）。** 一个 Cordis 行列表，每行是 `id`、`name`、`config`，允许 `!!js` 标签。`@lyteboat/agent-catalog` 用 `entryListSchema` 读它，只检查「是不是列表」，原样交给 registry 作为 preset 的 `plugins`，每一行由 registry 校验（`lyteboat/plugins/agent-catalog/src/agent-directory.ts` `readAgentDefinition`）。目录里有这个文件才算 agent（`agent-directory.ts` `AGENT_COMPOSITION_FILE`、`isAgentDirectory`）。

可用的行：

| `name` | 作用 | 配置 |
|---|---|---|
| `@deepseek-ai/dsh-persona` | 本 agent 的 persona，遮住部署级 persona | `prefix`（必填，模板）、`suffix`（省略即清空部署级后缀）、`complete`、`includeRuntimeContext`（上游 `packages/preset/persona/src/index.ts:30-54`）。它只能挂在作用域里，挂到全局会和 prompt 注册表冲突（同文件 :1-13） |
| `@lyteboat/skill-router/agent` | 打开 / 调整技能路由 | `mode`（`off`/`full`/`dynamic`）、`historyWindow`、`timeoutMs`、`maxTokens`（一次路由调用的输出预算，默认 200）、`provider`+`model`（必须成对，否则抛错）（`lyteboat/plugins/skill-router/src/agent.ts` `Config`，`src/index.ts` `Config`）。宿主默认 `mode: off` |
| `@lyteboat/tool-policy/agent` | 给别的行注册的工具（例如 dsh 官方工具）声明策略，并决定没有声明点名的继承工具是否可见 | `inherited`（`visible` / `hidden`，省略时为 `visible`）、`tools: { <name>: { visibility? } }`，行和工具策略里的未知键（包括去掉了的 `undeclared`、`requiresConfirmation`）加载时直接抛错；`stateDelta` 只能在代码里声明（`lyteboat/plugins/tool-policy/src/agent.ts`）。用法见 §4.11 |
| `@lyteboat/a2ui/agent` | 注册通用的 `render_a2ui` 工具 | `templates`（必填，相对组合文件目录）、`stateKeys`、`terminalCards`、`cardDescriptions`、`name`、`visibility`、`validation`、`components`，未知键直接抛错（`lyteboat/plugins/a2ui/src/agent.ts`） |
| `./lib/<x>.js` | 你自己的代码行：注册工具、监听事件、登记准入函数 | 导出 `name`、可选的 `inject`、`Config`，以及 `apply(ctx, config)` |

**`agent.yml`（可选）。** agent 的清单（contracts 的 `LyteboatAgentManifest`，`lyteboat/core/contracts/src/index.ts`），每个字段都可选：

| 字段 | 类型 | 用途 |
|---|---|---|
| `name`、`description` | 字符串 | 显示：`lyteboat web` 的 Agents 页、Studio 的 agent 雷达与工作台、`GET /agents` |
| `order` | 有限数 | 显示的排序 |
| `version` | 字符串，形如 `1.2.3` 或 `1.2.3-rc.1` | 作者承诺的版本；进入 agent 的身份，`/agents` 列出它；发布要求有它（§4.16） |
| `model` | `{ provider, model, reasoningEffort? }`，都是非空字符串，未知键报错 | agent 评测和发布所用的模型。它不选模型（§4.12），只用来核对：serve 和 eval 里它和进程的默认模型不一致，agent 就不声明；发布要求有它 |

按严格 schema 读：多一个键、版本不是这个形状、字段类型不对，加载就失败并指出键名，例如 `agent-catalog: <目录>/agent.yml: (the file): Unrecognized key: "color"`、`… version: must look like 1.2.3 or 1.2.3-rc.1`。原来的 `preset.yml` 已经换成它：目录里还留着 `preset.yml`，加载就失败，提示改名：`agent-catalog: <目录>/preset.yml is now agent.yml: rename it (name, description, and order stay; version and model are new)`（`agent-directory.ts` `readManifest`）。

**`agent.release.json`（发布后才有）。** `lyteboat release` 写的发布锁，提交进仓库，交给运维（§4.16）。它和 `tests/`、`evals/` 一样不算进目录的摘要。

**`package.json`。** 逐字段说明见 §2.2。要点：`exports` 只放测试要 import 的子路径，第一个键是 `@lyteboat/source` 条件（`CLAUDE.md`「Repository layout」）；loader 按路径加载 `lib/` 里的行，不经过 `exports`；依赖的写法照金融智能体，§2.2 讲它和 `CLAUDE.md` 字面规则的差别。

**`tsconfig.json`。** 继承 `../../../lyteboat/tsconfig.base.json`（strict、`exactOptionalPropertyTypes`、`customConditions: ['@lyteboat/source']`），`rootDir: src`、`outDir: lib`；`references` 列出每个 import 的工作区包，内核包也要列（`CLAUDE.md`「Repository layout」）。从 npm 装的 dsh 包（例如 `dsh-skill-filesystem`）不列。

**`assets/skills/<name>/SKILL.md`。** frontmatter 的 `name`（必填，连字符小写，`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，`dsh/skill/skill/src/index.ts` `SKILL_NAME`）、`description`（必填；路由器对每个候选技能只看到 id 和 description，`lyteboat/plugins/skill-router/src/index.ts` `SkillRouterService.route`）、可选的 `whenToUse` / `disable-model-invocation` / `user-invocable`（上游 `packages/skill/skill-filesystem/src/index.ts:834`、`:1001-1005`），以及 lyteboat 的 `metadata.lyteboat`。`metadata.lyteboat` 只有一个键 `requiredTools`，按严格 schema 校验，多一个键（例如参考实现迁过来的 `group`、`version`、`tags`）就会在路由到这个技能时让运行失败（`lyteboat/core/contracts/src/index.ts` `LyteboatSkillMeta`、`lyteboatSkillMetaSchema`，`lyteboat/plugins/skill-router/src/index.ts` `lyteboatSkillMeta`；§4.9）。

**`assets/a2ui/<card>/`。** `template.json` 必需，`manifest.yaml`、`business_hierarchy.yaml`、`compute.js` 可选（`lyteboat/plugins/a2ui/src/loader.ts` `FILES`、`loadBundle`）。manifest 的出卡模式和三种取值见 §2.9。

**`assets/sample-data/`。** agent 运行时读的业务数据和示例输入。

**为什么这三样放在 `assets/`。** `assets/` 与 `src/`、`lib/` 同级（`CLAUDE.md`「Agent design」）。tsc 只把 `.ts` 编译进 `lib/`，不拷贝其他文件；代码从包根按同一个相对路径去找：单元测试跑的是 `src/tools.ts`，CLI 和组合测试跑的是 `lib/tools.js`，两者往上一级都是包根，所以找到的是同一个 `assets/`，不需要拷贝文件的构建步骤（§2.10 的 `AGENT_DIR`）。`package.json` 的 `files` 写 `assets` 一项即可。

**`src/` → `lib/`。** 行的代码和业务逻辑。行名写 `./lib/x.js`，因为 loader 在 Node 里直接 import 编译产物（`CLAUDE.md`「Agent design」）。部署输入（数据源、persona 选择等）在边缘从 `Config` 或环境变量读，并写进 `package.json` 的 `description`（同一节）。每个请求各不相同的输入（例如用户是谁）不是部署输入，走请求上下文（§0.3）。

**`tests/`。** `*.spec.ts` 测纯逻辑和挂在单元宿主上的行，`*.composite.ts` 测组合，`*-smoke.e2e.ts` 在构建好的可执行文件上跑一次冒烟（§5）。

### 1.4 `lyteboat try --agents … --agent <id> "任务"` 时发生了什么

1. `try` profile 依次加载 `@deepseek-ai/dsh-base`、`@lyteboat/host`、`@lyteboat/business-base`、`@lyteboat/try` 四层（`lyteboat/apps/cli/src/templates.ts`）。profile 跳过了模板列出的任何一个 bundle，启动就失败（`lyteboat/apps/cli/src/profile-boot.ts` `checkSkippedProfileBundles`）。
2. `@lyteboat/host` 把 dsh-base 的 `session-log-deepseek` 行配成 `enabled: false`、关掉 `session-telemetry-otel` 行，在宿主平面依次插入 `@lyteboat/distro`、`@lyteboat/tool-policy`、`@lyteboat/aux-llm`、`@lyteboat/request-context`、`@lyteboat/intake-guard`、`@lyteboat/skill-router`、`@lyteboat/a2ui`、`@lyteboat/history-import`（`lyteboat/bundles/host/cordis.patch.yml`）。同一 waterfall 上的监听顺序由注册先后决定，先注册的在外层（上游 `vendor/cordis/src/events.ts:224-243`）。skill-router 注入了 `toolPolicy`，所以晚于 tool-policy 激活、在它里面；agent 行要等 Agent 创建时才挂载，注册得更晚，在最里层。所以一个 agent 行自己的 `lyteboat/intake` 监听在 intake-guard 里面，先于它作出判定（§2.11）。`@lyteboat/business-base` 再关掉 dsh-base 的编码工具、沙箱与审批、工作目录的 AGENTS.md、插件包清单、会话标题的旁路请求等行，系统提示不加宿主 persona 和 harness 身份段（§4.11）。
3. `@lyteboat/try/startup` 解析参数。没有任务、`--agents` 目录不存在、`--agent` 和 `--agents` 只给了一个、id 找不到、`--session-id` 为空或和 `--history` 同给、`--context` 不是 JSON 对象，都按用法错误退出，找不到 id 时列出可用 id（`lyteboat/bundles/try/src/startup.ts` `apply`）。
4. `agent-catalog` 读目录（行、清单、摘要）、登记 preset，runner 等它就绪，取出这个 agent 的身份，把会话的工作目录定为这个 agent 的 `$LYTEBOAT_HOME/agent-workdirs/<id>`，不存在就建出来（`lyteboat/bundles/try/src/index.ts` `run`），按 `agentDefaultModel` 的当前选择创建 Agent，给了 `--session-id` 时改为从日志恢复那个会话，在 `setup` 里 `presets.mount(agentCtx, id)`。上游 `mountPreset` 加载各行、审计、拒绝失败的行和泄漏到根 realm 的服务（`mount.ts:258-272`）。
5. runner 用 `intakeGuard.submit` 提交任务（准入，再把任务连同发起者 `operator:cli`、agent 的身份、请求上下文和判定写成一条用户消息交给 Agent），等到空闲，`sessions.flush`；然后用 `a2ui.turnParts` 把这一轮排成回答加卡片打到 stdout，把 `lyteboat: session <id>` 打到 stderr；只有本轮以 `completed` 结束才退出 0（`index.ts` `run`）。

---

## 2. 从零开始：保单查询助手 `policy-desk`

它要做三件事：

- 用户问某张保单时，路由到技能 `policy-lookup`，调用 `query_policy`：查保单簿，把保单摘要作为**状态增量**写进会话，并用 **A2UI 渲染一张保单卡**；模型只看到 digest，回答里写 `[[card:policy_card]]` 决定卡片放在哪。
- 用户要电子保单时，调用 `send_policy_copy`。它和 `query_policy` 一样是 `auto` 工具，路由到这个技能才可见；这个 agent 继承来的工具一律隐藏（`inherited: hidden`），模型只看得到它自己声明的工具。
- 用户要荐股时，**准入函数**在请求进入循环之前就给出固定回复，不经过路由器，也不请求模型。

下面每个代码块都是完整文件，照抄即可。

### 2.0 前提

在 **git clone** 出来的仓库里工作。`pnpm run build` 打包内核时要跑 `git rev-parse`（`scripts/dist/bundle-kernel.ts` `importBases`），没有 `.git` 的源码包构建不了。

```sh
node --version        # 22.19+ 或 24
corepack enable       # 用 package.json 里钉住的 pnpm 11.7
pnpm install
pnpm run build        # tsc -b，再打包内核和 lyteboat 的浏览器面；产出每个包的 lib/
```

先确认仓库里的示例 agent（金融智能体）能跑（需要真实 key；没有 key 就跳过，§2.13 有脚本模型的跑法）。它要求请求上下文指明客户，`young-idle-cash` 是它的一个示例客户（`examples/agents/finance/assets/sample-data/customers/`）：

```sh
DEEPSEEK_API_KEY=<你的 key> node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent finance --context '{"customer":"young-idle-cash"}' "看看我的资产"
```

### 2.1 建目录

```bash
mkdir -p examples/agents/policy-desk/{src,tests,assets/sample-data,assets/skills/policy-lookup,assets/a2ui/policy_card}
```

`pnpm-workspace.yaml` 已经用 `examples/*/*` 把 `examples/` 下的每个包收进工作区（`pnpm-workspace.yaml`），不用改它（`CLAUDE.md`「Unattended runs」也不允许无授权改它）。

### 2.2 `package.json`

`examples/agents/policy-desk/package.json`：

```json
{
  "name": "@lyteboat/agent-policy-desk",
  "version": "0.0.1",
  "private": true,
  "license": "MIT",
  "description": "lyteboat's policy-desk agent: one routed skill that looks a policy up (state delta + policy card) and queues an e-policy copy to the registered mailbox, and an admission that answers stock-trading requests before the loop. Deployment input: LYTEBOAT_POLICY_DESK_BOOK, the policy book JSON (defaults to assets/sample-data/policies.json)",
  "type": "module",
  "exports": {
    "./policies": {
      "@lyteboat/source": "./src/policies.ts",
      "types": "./lib/policies.d.ts",
      "default": "./lib/policies.js"
    },
    "./tools": {
      "@lyteboat/source": "./src/tools.ts",
      "types": "./lib/tools.d.ts",
      "default": "./lib/tools.js"
    },
    "./intake": {
      "@lyteboat/source": "./src/intake.ts",
      "types": "./lib/intake.d.ts",
      "default": "./lib/intake.js"
    }
  },
  "files": ["lib", "agent.yml", "agent.cordis.yml", "assets"],
  "dependencies": {
    "@lyteboat/contracts": "workspace:*",
    "@deepseek-ai/dsh-skill-filesystem": "catalog:dsh",
    "@deepseek-ai/dsh-tools": "workspace:*"
  },
  "peerDependencies": {
    "@lyteboat/a2ui": "workspace:*",
    "@lyteboat/intake-guard": "workspace:*",
    "@lyteboat/tool-policy": "workspace:*",
    "@deepseek-ai/cordis": "catalog:cordis"
  },
  "devDependencies": {
    "@lyteboat/a2ui": "workspace:*",
    "@lyteboat/cli": "workspace:*",
    "@lyteboat/distro": "workspace:*",
    "@lyteboat/host": "workspace:*",
    "@lyteboat/business-base": "workspace:*",
    "@lyteboat/intake-guard": "workspace:*",
    "@lyteboat/request-context": "workspace:*",
    "@lyteboat/try": "workspace:*",
    "@lyteboat/testing": "workspace:*",
    "@lyteboat/tool-policy": "workspace:*",
    "@deepseek-ai/cordis": "catalog:cordis",
    "@deepseek-ai/dsh-session": "workspace:*",
    "@deepseek-ai/dsh-skill": "workspace:*"
  }
}
```

| 字段 | 为什么这样写 |
|---|---|
| `name` | `@lyteboat/agent-<id>`，名字带归属（`CLAUDE.md`「Coding conventions」的 Names carry their owner） |
| `license` | 和仓库里其他包一样是 `MIT` |
| `description` | 写明部署输入 `LYTEBOAT_POLICY_DESK_BOOK`（`CLAUDE.md`「Agent design」） |
| `exports` | 只导出测试要 import 的三个子路径：`./policies`、`./intake` 给纯函数测试，`./tools`、`./intake` 给把行挂在单元宿主上的测试（§2.14）。第一个键 `@lyteboat/source` 指向 `src`，所以 vitest 的 `source` 项目和 typecheck 读本包的源码；Node 和 CLI 走 `default`，读 `lib/`（`CLAUDE.md`「Repository layout」，`vitest.config.ts`） |
| `files` | 发布时需要的全部运行时文件：`lib`、两个 yml（`agent.yml`、`agent.cordis.yml`）、`assets`（技能、卡片模板、示例数据都在它下面，§1.3） |
| `dependencies` | 照金融智能体（`examples/agents/finance/package.json`，它另有本例用不到的 `zod`）：代码里当库用的包。`@deepseek-ai/dsh-tools` 提供纯函数 `defineTool`（内核包，所以是 `workspace:*`）；`@deepseek-ai/dsh-skill-filesystem` 由本行自己 `ctx.plugin` 挂载（npm 包，`catalog:dsh`）；`@lyteboat/contracts` 只提供类型 |
| `peerDependencies` | 作为**服务**注入的包：`@lyteboat/tool-policy`、`@lyteboat/a2ui`、`@lyteboat/intake-guard`，以及 cordis。peer 表示「用宿主树里那一份」。工具行还从 `@lyteboat/a2ui` 取两个纯函数 `cardMarker`、`cardsPresentationMeta`，同样经这个 peer 解析。用到 `requestContext`、`auxLlm` 时照同样的写法加 `@lyteboat/request-context`、`@lyteboat/aux-llm`（金融智能体的 `package.json`） |
| `devDependencies` | 测试 import 的包：`@lyteboat/testing`，单元测试挂到宿主上的服务（`@lyteboat/distro`、`@lyteboat/request-context`，以及再列一遍的 peer），`@deepseek-ai/dsh-session`（`SessionId`）、`@deepseek-ai/dsh-skill`（技能注册表）；外加 composite 测试要启动的 bundle（`@lyteboat/host`、`@lyteboat/business-base`、`@lyteboat/try`），以及冒烟要运行的启动器 `@lyteboat/cli`（§2.16）。`examples` 是最外层：运行时（`dependencies`、`peerDependencies`）只能依赖 `plugins` 和 `core`，`apps`、`bundles`、`tooling` 只能经 devDependencies 依赖，反过来没有任何层能依赖 `examples`（`scripts/check-layers.ts` `DEV_ONLY`，`CLAUDE.md`「Architecture boundaries」）。测试 import 了却没列的包，`pnpm run lint` 里的 knip 会报 `Unlisted dependencies` |

**这套分法是金融智能体的做法，不是 `CLAUDE.md` 的字面规则。** `CLAUDE.md`「Coding conventions」的 Tooling 一条说 dsh 和 cordis 包写成 `peerDependencies`（外加 `devDependencies`）。现有的包并不一致：金融智能体把 `dsh-tools`、`dsh-skill-filesystem` 放在 `dependencies`；`@lyteboat/tool-policy` 把 `dsh-scope` 放在 `dependencies`，却把 `dsh-tools` 放在 peer（`lyteboat/plugins/tool-policy/package.json`）。两种写法 knip 和 check-layers 都接受。`scripts/upstream-pins.spec.ts` 只检查 `lyteboat/` 下的包（`scripts/upstream-pins.spec.ts`），`examples/` 下的 agent 不在它的检查范围里，所以写 dsh peer 时要自己守住这条硬约束：内核包写 `workspace:*`，非内核 dsh 包写跟踪版本的精确号 `0.1.7-rc.2`，不能写 `catalog:dsh`。原因是 dsh 启动准入从磁盘上的 manifest 读一行的 dsh peer，而 pnpm 不会解析那里的 `catalog:`（同一条，`scripts/upstream-pins.spec.ts`）。本例照金融智能体写，没有非内核的 dsh peer；把 `dsh-skill-filesystem` 改成 peer 的写法本文没有验证。

### 2.3 `tsconfig.json`、根引用、README、重装依赖

`examples/agents/policy-desk/tsconfig.json`：

```json
{
  "extends": "../../../lyteboat/tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib"
  },
  "include": ["src"],
  "references": [
    { "path": "../../../dsh/core/tools" },
    { "path": "../../../lyteboat/core/contracts" },
    { "path": "../../../lyteboat/plugins/tool-policy" },
    { "path": "../../../lyteboat/plugins/a2ui" },
    { "path": "../../../lyteboat/plugins/intake-guard" }
  ]
}
```

agent 目录在仓库根下三层（`examples/agents/policy-desk`），所以 `extends` 和每条 `references` 都以 `../../../` 回到仓库根，和金融智能体的 `tsconfig.json` 一样。`references` 对应 `src` 里 import 的每个工作区包：内核的 `dsh/core/tools`、`lyteboat/core/contracts`、`lyteboat/plugins/tool-policy`、`lyteboat/plugins/a2ui`、`lyteboat/plugins/intake-guard`。`references` 决定 `tsc -b` 的构建顺序：被引用的包先构建。`CLAUDE.md`「Repository layout」要求每个被 import 的工作区包都列上，内核包也一样。测试文件不在这里编译，由根 `tsconfig.tests.json` 做类型检查。

根 `tsconfig.json` 在 finance 那一项后面加一项（finance 那一项在 `tsconfig.json`）：

```diff
     {
       "path": "./examples/agents/finance"
     },
+    {
+      "path": "./examples/agents/policy-desk"
+    },
     {
       "path": "./lyteboat/tooling/testing"
     }
```

下面三处已经按通配收录 `examples/` 下的包，不用改：`tsconfig.tests.json` 包含 `examples/*/*/tests` 和 `examples/*/*/src`（`tsconfig.tests.json`）；vitest 的 `source` 和 `composite` 两个项目都收录 `examples/*/*/tests`（`vitest.config.ts`）；knip 把 `examples/agents/*` 的 `src/*.ts` 和测试文件当入口（`knip.jsonc`）。

两份 README 的包表要在同一个提交里跟上（`CLAUDE.md`「Workflow」→「Scope of change」）。在 `README.md` 的 `examples/agents/finance` 那一行下面加：

```markdown
| `examples/agents/policy-desk` | `@lyteboat/agent-policy-desk` | 保单查询助手：一个路由技能，查询工具写会话状态并出保单卡，寄送工具把电子保单寄到登记邮箱，荐股类请求在进入循环前由准入函数直接回复 |
```

在 `README.en.md` 的 `examples/agents/finance` 那一行下面加：

```markdown
| `examples/agents/policy-desk` | `@lyteboat/agent-policy-desk` | The policy-desk agent: one routed skill, a lookup tool that fills the session state and renders the policy card, a copy tool that queues the e-policy to the registered mailbox, an admission that answers stock-trading requests before the loop |
```

然后**从干净的 `node_modules`** 重装。README 要求增删工作区包之后这样做，因为增量 `pnpm install` 可能留下过期的提升链接（README「pnpm 设置为什么和常见项目不同」）：

```sh
rm -rf node_modules && pnpm install
ls node_modules/@lyteboat/ | grep policy-desk     # 输出 agent-policy-desk
git status --short                            # pnpm-lock.yaml 多了 examples/agents/policy-desk 这个 importer，要一起提交
```

CI 用 `--frozen-lockfile` 安装（`CLAUDE.md`「Commands」），所以 `pnpm-lock.yaml` 的改动必须提交。

### 2.4 `agent.cordis.yml`

`examples/agents/policy-desk/agent.cordis.yml`：

```yaml
# The policy-desk agent's composition. Every row runs in this agent's standing
# scope: the persona, the router's dynamic mode, the tool surface (every
# inherited tool hidden but `skill`), the tools and skills that ./lib/tools.js
# registers, and the admission that ./lib/intake.js registers reach exactly
# the sessions of this agent.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: 'You are POLICY-DESK-PERSONA, 一名保单查询助手。只回答与用户保单有关的问题，回答用中文，称用户为「您」；不编造工具没有给出的数字。'

- id: lyteboat-skill-router
  name: '@lyteboat/skill-router/agent'
  config:
    mode: dynamic
    historyWindow: 6
    timeoutMs: 10000

- id: policy-desk-tool-surface
  name: '@lyteboat/tool-policy/agent'
  config:
    inherited: hidden
    tools:
      skill: { visibility: always }

- id: policy-desk-tools
  name: ./lib/tools.js

- id: policy-desk-intake
  name: ./lib/intake.js
```

- **`persona`**：只放身份、红线、语气（设计原则的 L1）。prefix 写成一行：YAML 的折叠写法 `>-` 会在换行处插入一个空格，两行中文之间就多出一个空格。
  - `POLICY-DESK-PERSONA` 是给测试断言系统 prompt 用的标记。它会进入真实的系统 prompt，模型看得到。上线用的 persona 要去掉它，测试改为断言 persona 里的一句原文。
  - 业务模式里系统 prompt 就是这一行：业务底座不加宿主 persona，也不加 harness 身份段（`lyteboat/bundles/business-base/cordis.patch.yml` 的 `system-prompt` 行）。`suffix` 按需写；别在 persona 里用 `{{cwd}}`，它渲染成服务器上 agent 工作目录的绝对路径（§4.11）。
- **`lyteboat-skill-router`**：宿主默认 `mode: off`，agent 要用参考实现的动态路由必须在这里打开（`lyteboat/plugins/skill-router/src/agent.ts`）。
- **`policy-desk-tool-surface`：只露出自己声明的工具。** 业务模式（try、serve、eval）本来就只给 agent dsh-base 的 `skill` 工具，编码工具都被业务底座关掉了（§4.11）；可同一个 agent 在 `lyteboat web` 里会继承 dsh 的全套编码工具，一个 `--plugin` 文件也能往宿主上加工具。`inherited: hidden` 让这个 agent 继承来、却没有任何声明点名的工具一律隐藏，而且再也激活不了（`lyteboat/plugins/tool-policy/src/agent.ts`）；`skill` 在 `tools` 里声明成 `always`，留着可见；本 agent 用 `ctx.toolPolicy.register` 注册的两个工具算声明过的，照常由技能激活。金融智能体就这样写（`examples/agents/finance/agent.cordis.yml`）。
- **监听顺序。** agent 行都比宿主服务晚注册，所以如果你的行也监听 `lyteboat/pre-assemble`，它会位于 tool-policy 和 skill-router 之内；监听 `lyteboat/intake` 的话，它位于 intake-guard 之内（§1.4 第 2 步、§4.4）。同一 agent 的几行之间谁先谁后取决于激活的先后，不要依赖它。

### 2.5 `agent.yml`

`examples/agents/policy-desk/agent.yml`：

```yaml
name: 保单查询助手
description: 按保单号查询状态、保额与保障期间并出一张保单卡，可把电子保单寄到登记邮箱；不回答荐股类问题。
order: 2
```

这三个字段只用于显示；`order` 接着金融智能体的 1 往下排（`examples/agents/finance/agent.yml`）。`version` 和 `model` 这里先不写：它们是发布用的，§4.16 讲什么时候加、加了之后要做什么。金融智能体两个都写了（`examples/agents/finance/agent.yml`）：`version: 1.0.0`，`model: { provider: deepseek-official, model: deepseek-flash }`。

### 2.6 技能：`assets/skills/policy-lookup/SKILL.md`

```markdown
---
name: policy-lookup
description: 按保单号查询一张保单的状态、保额、保障期间与下次缴费日并出一张保单卡，或把电子保单寄到登记邮箱。用户给出保单号、问「保单还有效吗 / 保额多少 / 什么时候到期 / 下次什么时候缴费」或要电子保单归此；理赔进度、产品推荐、投资建议不归此。
metadata:
  lyteboat:
    requiredTools: [query_policy, send_policy_copy]
---

# 保单查询

用户问到某张保单时，先调用 `query_policy(policy_no)` 一次：它取数、把保单摘要写进会话状态，并出一张保单卡。用户没给保单号时，先请用户提供保单号，不要猜。

终稿按工具 digest 组稿：卡片前一句，卡片标记单独一行，卡片后一句 ≤25 字的收尾，不复述卡内数字。工具返回 `status=not-found` 时，请用户核对保单号。

用户明确要电子保单时调用 `send_policy_copy(policy_no)`：返回 `status=queued` 时告诉用户电子保单会寄到投保时登记的邮箱；返回 `status=not-found` 时请用户核对保单号。
```

- `name` 用连字符。写成 `policy_lookup` 时，这个技能会被**静默丢弃**，见 §4.3。
- `metadata.lyteboat` 里只写 `requiredTools`。多写别的键，路由到这个技能的那一步运行失败（§1.3、§4.9）。
- 路由器对每个候选技能只看到 id 和 `description`，所以 description 要写 WHAT、WHEN、关键词，以及和相邻技能的边界（设计原则 §3）。
- description 在两个地方出现，长度处理不同。路由器 prompt 发送全文（`lyteboat/plugins/skill-router/src/router.ts` `buildRoutePrompt`）；每个 loop 请求里的技能目录（`skill-catalog` 那条 user 消息）由 dsh-tool-skill 截断到 `catalogDescriptionMaxLength`，默认 500 字符（上游 `packages/skill/tool-skill/src/index.ts:27`、`:50-58`）。参考实现在 `skill_description_max_chars` 处截断，lyteboat 的路由器不截断，所以要靠约定保持简短。
- `requiredTools` 必须和正文实际调用的工具一致（设计原则 §3）：多列会污染工具面，少列会让工具不可见，列了一个 tool-policy 不认识的名字会让运行失败（§4.9）。路由到本技能时，skill-router 先 `clear` 再 `activate` 这两个工具（`lyteboat/plugins/skill-router/src/index.ts` `SkillRouterService.activateTools`），并把正文作为一条 dsh 的技能调用消息放进这一步（§3.1）。
- 正文里的「卡片标记」指 digest 给出的 `[[card:policy_card]]`（§2.10）；卡片标记写不写、写在哪，决定这张卡在回答里的位置。
- 正文不写业务规则和阈值（那些属于 L4），也不描述模型看不见的字段。

### 2.7 业务数据：`assets/sample-data/policies.json`

```json
{
  "policies": [
    {
      "policy_no": "P-1001",
      "product": "安心医疗保险",
      "kind": "医疗险",
      "status": "active",
      "insured": "本人",
      "sum_insured": "2000000.00",
      "premium": "1280.00",
      "start_date": "2026-01-01",
      "end_date": "2026-12-31",
      "next_due": "2026-12-01"
    },
    {
      "policy_no": "P-2002",
      "product": "长青定期人寿保险",
      "kind": "人寿保险",
      "status": "lapsed",
      "insured": "配偶",
      "sum_insured": "500000.00",
      "premium": "3600.00",
      "start_date": "2023-05-10",
      "end_date": "2043-05-09",
      "next_due": "2026-05-10"
    }
  ]
}
```

### 2.8 L4：`src/policies.ts`

纯函数，不依赖任何框架服务，对应参考实现的 capability 层。文件是真实边界，所以要校验，坏文件直接抛错，而不是拿残缺数据回答（`CLAUDE.md`「Coding conventions」的 Validate at real boundaries only 和 Misconfiguration fails loud 两条）。

```ts
/**
 * The policy book behind the policy-desk agent: read and check the JSON
 * export, look one policy up by number, and cut the summary that enters the
 * session state. Pure functions over plain data; the tools row is the only
 * runtime caller.
 * @module @lyteboat/agent-policy-desk/policies
 */

import { readFileSync } from 'node:fs'

export type PolicyStatus = 'active' | 'lapsed' | 'expired'

/** One policy as the book exports it: amounts are decimal strings, dates ISO days. */
export type PolicyRecord = {
  policy_no: string
  product: string
  kind: string
  status: PolicyStatus
  insured: string
  sum_insured: string
  premium: string
  start_date: string
  end_date: string
  next_due: string
}

/** What the session state keeps of a policy: enough for follow-up questions, no one's identity. */
export type PolicySummary = Pick<PolicyRecord, 'policy_no' | 'product' | 'status' | 'sum_insured' | 'end_date' | 'next_due'>

const FIELDS = ['policy_no', 'product', 'kind', 'status', 'insured', 'sum_insured', 'premium', 'start_date', 'end_date', 'next_due'] as const
const STATUSES: readonly string[] = ['active', 'lapsed', 'expired']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the policy book.
 * @param file - a JSON file `{ "policies": [PolicyRecord, …] }`.
 * @returns the policies in file order.
 * @throws when the file is not that shape: a malformed book fails loud instead of answering from partial data.
 */
export function loadPolicies(file: string): PolicyRecord[] {
  const doc: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const list = isRecord(doc) ? doc['policies'] : undefined
  if (!Array.isArray(list)) throw new Error(`policy-desk: ${file} must be an object with a "policies" list`)
  return list.map((entry: unknown, index) => {
    if (!isRecord(entry)) throw new Error(`policy-desk: ${file} policies[${String(index)}] must be an object`)
    for (const field of FIELDS) {
      if (typeof entry[field] !== 'string') throw new Error(`policy-desk: ${file} policies[${String(index)}].${field} must be a string`)
    }
    if (!STATUSES.includes(String(entry['status']))) throw new Error(`policy-desk: ${file} policies[${String(index)}].status must be one of ${STATUSES.join(', ')}`)
    // File boundary: every field was checked above.
    return entry as PolicyRecord
  })
}

/**
 * Find one policy by number, ignoring case and surrounding blanks.
 * @param policies - the book.
 * @param policyNo - the number the model extracted from the user's words.
 */
export function findPolicy(policies: readonly PolicyRecord[], policyNo: string): PolicyRecord | undefined {
  const wanted = policyNo.trim().toUpperCase()
  return policies.find(policy => policy.policy_no.toUpperCase() === wanted)
}

/** The fields of a policy the session state carries. */
export function policySummary(policy: PolicyRecord): PolicySummary {
  const { policy_no, product, status, sum_insured, end_date, next_due } = policy
  return { policy_no, product, status, sum_insured, end_date, next_due }
}
```

`policySummary` 故意去掉了 `insured` 和 `premium`。原因在机制上：状态增量原样持久化在会话日志里（`tool/result.meta.lyteboat.stateDelta`），折成 `lyteboatState` 以后每一步都作为 `lyteboat:state` runtime context 重新发给模型（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService`，§4.8）。所以写进状态的东西要少，也不能带个人信息。

### 2.9 A2UI 卡片：`assets/a2ui/policy_card/`

卡片分三部分：`template.json` 是设计稿，`manifest.yaml` 规定出卡模式和每个绑定怎么取值，`compute.js` 放 manifest 里 `computed` 取值要调用的函数。渲染结果由工具放进结果的 `meta.lyteboat.cards`，模型只看 digest（`CLAUDE.md`「Agent design」）。

`template.json`：

```json
{
  "event": "beginRendering",
  "version": "1.0.0",
  "surfaceId": "policy-card",
  "rootComponentId": "root",
  "showType": "card",
  "components": [
    { "id": "root", "component": { "Column": { "width": 100, "gap": 12, "children": { "explicitList": ["header", "policy-no", "sum-insured", "period", "lapse-tip"] } } } },
    { "id": "header", "component": { "Row": { "distribution": "spaceBetween", "children": { "explicitList": ["product", "status"] } } } },
    { "id": "product", "component": { "Text": { "text": { "path": "product" }, "fontSize": "16px", "fontWeight": 600 } } },
    { "id": "status", "component": { "Tag": { "text": { "path": "status_text" } } } },
    { "id": "policy-no", "component": { "Text": { "text": { "path": "policy_no_text" }, "fontSize": "12px" } } },
    { "id": "sum-insured", "component": { "Text": { "text": { "path": "sum_insured_text" } } } },
    { "id": "period", "component": { "Text": { "text": { "path": "period_text" } } } },
    { "id": "lapse-tip", "component": { "Text": { "hide": { "path": "lapse_tip_hide" }, "text": { "literalString": "该保单已失效，可在复效期内申请恢复。" } } } }
  ]
}
```

- 绑定写成 `{"path": "<key>"}`。`Text.text` 这类契约字段解析成 `{"literalString": …}`，`hide` 为真时整棵子树被丢掉（`lyteboat/plugins/a2ui/src/walker.ts` `resolveProps`、`renderSubtree`）。
- 组件类型要在客户端的组件目录里。不另给目录时，契约校验用 a2ui 的默认目录，它只收领域中立的组件：`Row`、`Column`、`Card`、`List`、`CollapseList`、`Table`、`Popup`、`Text`、`RichText`、`Image`、`Icon`、`Tag`、`Circle`、`Divider`、`Line`、`Button`（`lyteboat/plugins/a2ui/src/contract.ts` `DEFAULT_A2UI_COMPONENT_CATALOG`）。客户端能渲染更多组件（图表、业务控件）时，由部署经 `RenderToolOptions.components` 或 `validateFullPayload(payload, { catalog })` 给出自己的目录（`lyteboat/plugins/a2ui/src/index.ts`、`src/contract.ts`）。
- 顶层的 `surfaceId` 只是占位。渲染时换成 `<card>-<sessionId 前 8 个字符>-<6 位 hex>`（`lyteboat/plugins/a2ui/src/engine.ts` `TemplateEngine.render`、`mintSurfaceId`）。lyteboat 的会话 id 总是 `session-<uuid>`（`lyteboat/bundles/try/src/index.ts` `run`），前 8 个字符恰好是 `session-`，所以实际的 surfaceId 形如 `policy_card-session--747561`，中间是两个连字符。

`manifest.yaml`：

```yaml
# policy_card: one entry per {"path": k} that template.json binds. The raw data
# namespace is what query_policy passes to ctx.a2ui.renderCard: { policy: {...} }.
#   state:     a dotted path into the raw data, with an optional default
#   transform: the transforms DSL (concat, switch, get, ...)
#   computed:  a named export of compute.js; "state:<path>" args are resolved first

# `deferred`: the card sits where the answer writes [[card:policy_card]],
# or follows the answer when it never does.
emission_mode: deferred

paths:
  product:
    kind: state
    path: "policy.product"
    default: "-"

  status_text:
    kind: transform
    spec:
      switch: "policy.status"
      cases:
        active: "有效"
        lapsed: "已失效"
        expired: "已满期"
      default: "未知"

  policy_no_text:
    kind: transform
    spec:
      concat: ["保单号 ", {get: "policy.policy_no"}]

  period_text:
    kind: transform
    spec:
      concat: ["保障期间 ", {get: "policy.start_date"}, " 至 ", {get: "policy.end_date"}]

  sum_insured_text:
    kind: computed
    fn: sum_insured_text
    args: ["state:policy.sum_insured"]

  lapse_tip_hide:
    kind: computed
    fn: lapse_tip_hide
    args: ["state:policy.status"]
```

三种 `kind` 的解析顺序是先 state、再 transform、最后 computed（`lyteboat/plugins/a2ui/src/resolver.ts` `resolveManifest`）。transform 的 DSL 支持 `get`、`concat`、`switch`、`select`、`sum`、`count`、`literal`（`lyteboat/plugins/a2ui/src/transforms.ts` `execOne`）。取值失败不抛错，而是降级成空串并记一条 `[MANIFEST] …` 警告（`resolver.ts` `resolveState`、`resolveComputed`）；`renderCard` 把这些警告打成 a2ui 的 warn（`lyteboat/plugins/a2ui/src/index.ts`）。

顶层的 `emission_mode` 是这张卡的**出卡模式**，决定它在一轮回答里放在哪（`lyteboat/plugins/a2ui/src/loader.ts` `emissionModeOf`、`loadBundle`，排布规则在 `lyteboat/plugins/a2ui/src/turn-parts.ts` `LyteboatTurnComposer`）：

- `immediate`（不写时的默认）：工具结果一到就显示，放在结果到达的位置：调用工具的那一步写的文字（如果有）之后、后面各步的回答之前，按到达的先后。
- `deferred`：放在回答写 `[[card:<区域>]]` 的位置；回答没写这个标记，而本轮正常结束（`completed`），就跟在回答后面。
- `deferred_discard`：只放在标记处，回答没写标记就不显示。

`emission_mode` 只能是这三个值。写成别的值，这张卡加载失败：`renderCard` 抛错，工具调用以错误结束，模型看到的是错误文本（§4.9）。回答里写了标记、这一轮却没有对应的卡（例如没查到保单），标记被删掉；卡片放下以后，标记后面紧跟的空白和收尾标点也一起删掉，因为卡片自成一块（`turn-parts.ts` `ORPHANED_AFTER_CARD`）。本轮没有正常结束时，没被标记放下的延迟卡都不显示。区域（area）名就是 `renderCard` 的第二个参数，本例用卡片名 `policy_card`（§2.10）；标记里的区域名只能是 ASCII 字母、数字、`_`、`-` 或汉字，最多 64 个（`turn-parts.ts` `CARD_MARKER`），`cardMarker` 遇到写不成标记的区域名直接抛错（`turn-parts.ts`）。

`compute.js`：

```js
// compute.js — the policy_card's computed functions: each named export is a
// manifest `computed.fn` entry.

function money(raw) {
  const value = Number(String(raw ?? '0'))
  return (Number.isFinite(value) ? value : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function sum_insured_text(sumInsured) {
  return `保额 ${money(sumInsured)} 元`
}

export function lapse_tip_hide(status) {
  return status !== 'lapsed'
}
```

`compute.js` 是 ES 模块，manifest 按名字取它的具名导出。只导出 `default` 的文件（例如 `export default { … }`）会让这张卡加载失败，而不是让每个 computed 取值都悄悄降级（`lyteboat/plugins/a2ui/src/loader.ts` `loadCompute`）。`compute.js` 还可以导出一个 `digest(raw, flat)` 钩子，它只服务通用的 `render_a2ui` 工具，用来生成那个工具的 digest（`lyteboat/plugins/a2ui/src/index.ts` `A2uiService.registerRenderTool`，`engine.ts`）；`renderCard` 只返回卡片本身，不带 digest，业务工具的 digest 由工具自己写（§2.10）。

`business_hierarchy.yaml` 省略了：没有它时，引擎使用模板自己的 `rootComponentId`、不做过滤（`engine.ts` `TemplateEngine.resolveHierarchy`）。

### 2.10 工具行：`src/tools.ts`

```ts
/**
 * The policy-desk agent's tools and skills row: `query_policy` (look one
 * policy up, fold its summary into the session state, render the policy card
 * in the same call) and `send_policy_copy` (queue an e-policy copy to the
 * mailbox the policy registered), both `auto` tools the routed skill
 * activates; the agent's skills directory, mounted as a scoped
 * skill-filesystem provider.
 * @module @lyteboat/agent-policy-desk/tools
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { cardMarker, cardsPresentationMeta } from '@lyteboat/a2ui'
import type { JsonValue } from '@lyteboat/contracts'
import type {} from '@lyteboat/tool-policy'
import { findPolicy, loadPolicies, policySummary, type PolicyRecord } from './policies.ts'

export const name = 'policy-desk-tools'
export const inject = ['toolPolicy', 'a2ui', 'skills']

/** The agent directory (this file runs as lib/tools.js, or under test as src/tools.ts). */
const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = join(AGENT_DIR, 'assets', 'a2ui')
const SKILLS = join(AGENT_DIR, 'assets', 'skills')

/** The card query_policy renders, and the area the answer's marker places it by. */
const POLICY_CARD = 'policy_card'

/** The policy book; a deployment points LYTEBOAT_POLICY_DESK_BOOK at its own export. */
function policyBook(): string {
  return process.env['LYTEBOAT_POLICY_DESK_BOOK'] ?? join(AGENT_DIR, 'assets', 'sample-data', 'policies.json')
}

/** What the model reads in place of the card: the facts, then where the answer puts the card. */
function lookupDigest(policy: PolicyRecord): string {
  return `[卡片:保单/${policy.status}] ${policy.product} · 保额${policy.sum_insured}元 · 保障至${policy.end_date} · 下次缴费${policy.next_due} · 卡前一句，${cardMarker(POLICY_CARD)} 单独一行，卡后一句简短收尾（≤25字），不复述卡内数字`
}

const POLICY_NO = { type: 'string', required: true, description: '保单号，形如 P-1001' } as const

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(skillFilesystem, { providerName: 'policy-desk', includeDefaultRoots: false, customSkillDirs: [SKILLS], watch: false })

  ctx.toolPolicy.register(defineTool({
    name: 'query_policy',
    description: '按保单号查询一张保单（状态、保额、保障期间、下次缴费日），写入会话状态，并渲染一张保单卡。',
    parameters: { policy_no: POLICY_NO },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          digest: { type: 'string', required: true },
          cards: { type: 'array', required: true, items: { type: 'json' } },
          policy: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `status=${value.status} · ${value.digest}` }],
      presentationMeta: (_args, value) => cardsPresentationMeta(value.cards),
    },
    execute: async (args, exec) => {
      const policy = findPolicy(loadPolicies(policyBook()), args.policy_no)
      if (policy === undefined) return { status: 'not-found', digest: `未找到保单 ${args.policy_no}，请用户核对保单号`, cards: [] }
      if (exec.agent === undefined) throw new Error('query_policy needs a calling agent: its session names the card surface')
      return {
        status: 'ok',
        digest: lookupDigest(policy),
        cards: [await ctx.a2ui.renderCard(TEMPLATES, POLICY_CARD, { policy }, { agent: exec.agent })],
        policy: policySummary(policy),
      }
    },
  }), {
    visibility: 'auto',
    stateDelta: (_args, value) => {
      const policy = (value as { policy?: JsonValue }).policy
      return policy === undefined ? undefined : { 'policy_desk.current': policy }
    },
  })

  ctx.toolPolicy.register(defineTool({
    name: 'send_policy_copy',
    description: '把一张保单的电子保单寄到投保时登记的邮箱。',
    parameters: { policy_no: POLICY_NO },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: { type: 'string', required: true } },
      },
      render: (args, value) => [{ type: 'text', text: `status=${value.status} · 电子保单 ${args.policy_no}` }],
    },
    // A real deployment hands the request to its mail gateway here; the example book only checks the number.
    execute: async (args) => ({ status: findPolicy(loadPolicies(policyBook()), args.policy_no) === undefined ? 'not-found' : 'queued' }),
  }), { visibility: 'auto' })
}
```

逐项解释：

- **`inject`** 声明本行用到的服务，服务齐了 Cordis 才调用 `apply`。`toolPolicy`、`a2ui` 是直接调用的；`skills` 是挂载的 skill-filesystem 子插件要注册 provider 的服务。
- **技能目录挂在本行下面。** `ctx.plugin(skillFilesystem, { includeDefaultRoots: false, customSkillDirs: [SKILLS], watch: false })` 只挂本 agent 的 `assets/skills/`，它跟随 preset 的作用域（照金融智能体的 `examples/agents/finance/src/agent.ts` `apply`）。
- **`ctx.toolPolicy.register(definition, meta)`**：在调用方作用域的层里注册工具，同时登记 lyteboat 元数据，返回一个同时撤销两者的 disposer（`lyteboat/plugins/tool-policy/src/index.ts`）。注册过的工具算声明过的，`inherited: hidden` 不藏它。`meta` 只有两个字段：
  - `visibility: 'auto'`：技能被路由到之前对模型隐藏。每次 `lyteboat/pre-assemble` 结束后，tool-policy 重新计算本 agent 的 `restrict({ deny })`（`index.ts` `ToolPolicyService`、`ToolPolicyService.reconcile`）。
  - `stateDelta: (args, value) => …`：tool-policy 把它包进 `output.presentationMeta`，于是结果 meta 带上 `{ lyteboat: { stateDelta } }`，并和工具自己的 `lyteboat.cards` 合并（`tool-policy/src/index.ts` `withStateDelta`）。
  - **`stateDelta` 的契约**：返回一个以点路径为键的 JSON 对象，或者 `undefined`（不写状态）。点路径展开成嵌套对象，嵌套对象深度合并，其他值直接替换（`lyteboat/plugins/tool-policy/src/state.ts` `deepMerge`、`assignPath`、`mergeStateDelta`）。返回非对象、或者路径里有空段，会在 `lyteboatState` 投影折叠时抛错（`state.ts` `mergeStateDelta`、`lyteboatStateProjectionDefinition.apply`）。这不是 warn，整次运行失败；实测输出见 §6。
- **`defineTool`**（`dsh/core/tools/src/schema.ts` `DefineToolOptions`）：
  - `parameters` 是逐属性的规格。`required` 只能写 `true`（`schema.ts` `runSchemaCompiler`），对象类型必须显式写 `additionalProperties`（`schema.ts` `runSchemaCompiler`）。包装后的 `execute` 先校验参数，不合格就抛 `ToolArgsError`（`schema.ts`）；但 `execute` 仍然要把参数当作不可信输入（`CLAUDE.md`「Coding conventions」的 Validate at real boundaries only）。
  - `output.render(args, value)` 产出**模型看得到**的内容，这里就是 digest。
  - `output.presentationMeta(args, value)` 产出**持久化但模型看不到**的 meta。它只对模型直接发起的调用计算（`dsh/core/tools/src/index.ts` `ToolRuntime.createSuccessResult`）。带 `exec.parent` 的调用不计算：那是 `run_code`（PTC 模式）的 SDK 发出的子调度（`index.ts` `ToolExecutionInput`）。所以在打开 PTC 的组合里，经 `run_code` 调到的 `query_policy` 既不出卡也不写状态；业务底座关掉了 PTC（`ptc-runtime`、`workflow-ptc`），try、serve、eval 里没有这个问题。子 agent 里的工具调用对子 agent 来说是模型直接调用，会计算 meta，但写进子会话自己的日志，不会折进父会话的 `lyteboatState`。
  - 输出 schema 里给字符串写 `enum` 时，`execute` 返回的字面量 `'ok'` 会被推断成 `string`，`tsc -b` 在 `execute` 属性上报 TS2322，错误链的最后一行是 `Type 'string' is not assignable to type '"ok" | "not-found"'`（实测）。所以这里没有写 `enum`；给返回的字面量加 `as const` 也能通过。
- **出卡的三个函数都来自 `@lyteboat/a2ui`：**
  - `ctx.a2ui.renderCard(templates, area, raw, { agent })` 渲染一张卡，返回结果要带的 `LyteboatResultCard`：`{ surfaceId, area, emission, payload }`。`area` 就是卡片目录名，也是回答放卡用的区域名；`emission` 取 manifest 的 `emission_mode`；`surfaceId` 由调用方 agent 的会话 id 生成。manifest 取值的警告打成 a2ui 的 warn。卡片不存在、文件坏了、payload 不是无损 JSON，都抛错（`lyteboat/plugins/a2ui/src/index.ts` `resultCardOf`）。所以工具先确认有调用方 agent。
  - `cardsPresentationMeta(cards)` 把卡片数组放成 `{ lyteboat: { cards } }`；没有卡时返回 `{}`，不留空信封；卡片不合 schema 时抛错，这次调用失败，而不是让日志留下一个投影拒收的信封（`lyteboat/plugins/a2ui/src/cards-projection.ts`）。`lyteboatCards` 投影、`turnParts` 和 `lyteboat try` 的输出都只读 `meta.lyteboat.cards` 这个数组（`cards-projection.ts` `preparedCardsOf`）。
  - `cardMarker(area)` 返回 `[[card:<area>]]`，digest 用它告诉模型把卡放在哪（`lyteboat/plugins/a2ui/src/turn-parts.ts`）。
- **digest 由工具自己写。** `lookupDigest` 沿用参考实现的写法：先给结构化的事实头，再给收尾提示；卡片是 `deferred`，所以提示里写明标记，模型照着把 `[[card:policy_card]]` 单独写一行。这个工具只属于一个技能，所以 digest 里可以带收尾提示；如果工具被多个技能共用，参考实现要求 digest 只报事实（参考实现 §4）。
- **一个结果可以带多张卡**，按数组顺序排进回答：金融智能体的 `allocation_diagnosis` 一次出 `allocation_diagnosis`、`allocation_plan` 两张卡，digest 里各用一个 `cardMarker` 告诉模型放在哪（`examples/agents/finance/src/tools/allocation-diagnosis-tool.ts` `defineAllocationDiagnosisTool`）。
- **查不到保单时不抛错**，返回 `status: 'not-found'` 和一句降级 digest，保持上下文连贯（设计原则 §4「失败必须给降级 digest」）。这时 `presentationMeta` 返回 `{}`、`stateDelta` 返回 `undefined`，结果的 meta 就是 `{}`（`tool-policy/src/index.ts`），不出卡也不写状态。单元测试断言了这一点（§2.14）。

另一种出卡方式是通用的 `render_a2ui`：模型调用 `render_a2ui({ template })`，它从 `lyteboatState[stateKeys]` 取数据，所以要先有数据工具把状态写好。在组合文件里用 `@lyteboat/a2ui/agent` 行注册它，写法见 `lyteboat/plugins/a2ui/src/agent.ts` 的 JSDoc（仓库里没有 agent 用这一行）；在代码里用 `ctx.a2ui.registerRenderTool(...)` 做同样的事，参照 `lyteboat/bundles/try/tests/fixtures/plugins/a2ui/plugin.mjs`。`render_a2ui` 出的卡以模板名为区域，出卡模式同样取 manifest 的 `emission_mode`，还会按 `validation` 做契约校验（`lyteboat/plugins/a2ui/src/index.ts`）。本例选「业务工具里一次查数、写状态、出卡」，是参考实现的超集工具原则：一次调用把场景需要的状态落齐（参考实现 §4），模型少调一次工具、少做一次判断。

### 2.11 准入：`src/intake.ts`

```ts
/**
 * The policy-desk admission, run before a request enters the loop: a request
 * for stock-trading advice is answered with a fixed reply and never reaches
 * the skill router or the model; everything else is admitted.
 * @module @lyteboat/agent-policy-desk/intake
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LyteboatIntakeVerdict } from '@lyteboat/contracts'
import type {} from '@lyteboat/intake-guard'

export const name = 'policy-desk-intake'
export const inject = ['intakeGuard']

const OUT_OF_SCOPE = /炒股|股票|荐股|涨停|买卖点/u

/**
 * The verdict on one request, from its text alone.
 * @param text - what the person wrote.
 */
export function policyDeskVerdict(text: string): Omit<LyteboatIntakeVerdict, 'by'> {
  return OUT_OF_SCOPE.test(text)
    ? { decision: 'reply', verdict: 'out_of_scope', text: '抱歉，我只负责保单查询，不提供股票买卖建议。' }
    : { decision: 'pass' }
}

export function apply(ctx: Context): void {
  ctx.intakeGuard.register({ name, admit: async ({ text }) => policyDeskVerdict(text) })
}
```

- **准入函数在请求进入循环之前运行。** `lyteboat try` 用 `ctx.intakeGuard.submit(agent, { text, context, owner, agent }, signal)` 提交任务（`owner` 是 `{ kind: 'operator', id: 'cli' }`，`agent` 是 agent-catalog 条目里的身份，`lyteboat/bundles/try/src/index.ts` `run`）：`submit` 找到这个 agent 作用域链上最近登记的准入函数，调用 `admit({ agent, text, context, signal })`，给判定补上 `by`（准入函数的 `name`），再用 `requestContext.message(...)` 把任务、发起者、agent 的身份、请求上下文和判定写成一条人类消息 `followup` 给 Agent（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService.admissionFor`，`lyteboat/plugins/request-context/src/index.ts`）。放行的请求也带判定，日志里是 `"lyteboatRequest":{"owner":{"kind":"operator","id":"cli"},"agent":{"id":"policy-desk","digest":"sha256:…"},"intake":{"decision":"pass","by":"policy-desk-intake"}}`（§3.2 的 seq 6；`agent.yml` 声明了版本时 `agent` 里另有 `version`）。`submit` 返回记下的判定；没有登记准入函数时返回 `undefined`，消息上也不带判定。
- **判定的字段**（`lyteboat/core/contracts/src/index.ts` `LyteboatIntakeVerdict`）：`decision` 为 `'pass'`（交给模型）或 `'reply'`（直接作答）；`verdict` 是 agent 自己的标签，例如 `out_of_scope`，只用于审计；`text` 是回复正文；`cards` 是随回复出的卡，每张同样是 `{ surfaceId, area, emission, payload }`，用 `ctx.a2ui.renderCard` 渲染（金融智能体的未授权卡就是这样出的，`examples/agents/finance/src/intake/finance-admission.ts` `financeAdmission`）。`by` 由 intake-guard 填，函数不用返回。
- **`reply` 怎么变成回答。** 循环第一步派发 `lyteboat/intake` 时，intake-guard 的监听先 `await next()`，让排在它里面的 `lyteboat/intake` 监听（例如某个 agent 行自己的拒识门）先判定；它们都放行，它才读人类消息上记录的判定，把 `reply` 变成 `{ kind: 'reply', plugin: by, content: [{ type: 'text', text }] }`（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService`）。内核把这一步写成一条不请求模型的助手消息，`source` 为 `{ kind: 'model', provider: 'lyteboat', model: 'policy-desk-intake' }`（`dsh/core/agent-loop/src/lyteboat/intake-reply.ts` `appendLyteboatIntakeReply`，`src/lyteboat/step-hooks.ts` `LYTEBOAT_ASSISTANT_PROVIDER`）。判定里的卡片不进助手消息：`lyteboatCards` 投影和 `turnParts` 从人类消息上的判定读它们（`lyteboat/plugins/a2ui/src/cards-projection.ts` `cardsOfRequest`、`preparedCardsOf`），`lyteboat try` 把它们和回复一起打出来。
- **只有第一步做准入**，工具之后的续步不做判定（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService`）。
- **没经过 `submit` 的消息**（调用方直接 `agent.followup`）在循环里补做：intake-guard 用消息自己的上下文、或会话沿用的上下文调用同一个函数，回复相同，只是判定不记在消息上（同文件 `IntakeGuardService.verdictFor`）。单元测试的最后两个用例对比了这两条路径（§2.14）。
- **`context`** 是这次请求带的上下文，没带（或带了空对象）就是会话沿用下来的（同文件 `IntakeGuardService.submit`）。本例不看它；按用户、渠道决定放不放行的 agent 从这里读。
- **要问模型的准入**在 `admit` 里用 `ctx.auxLlm.generate(...)`（§0.3），每个请求因此多一次模型调用。分类失败时怎么退由 agent 决定：金融智能体放行，交给 persona 和工具把关（`examples/agents/finance/src/intake/finance-admission.ts` `financeAdmission`）。
- **`name`** 就是判定的 `by`，也是回复那条助手消息的 `model`。本例直接用行名，日志里一眼能看出是哪个行作答的。
- 这个行只 import 类型：`@lyteboat/contracts` 的判定类型，以及 `@lyteboat/intake-guard` 并进 `Context` 的 `ctx.intakeGuard` 声明。

**更底层的钩子：`lyteboat/intake`。** 准入函数下面是内核的 `lyteboat/intake` waterfall，它也可以直接监听。仓库里直接监听它的只有测试：启动器 e2e 的夹具 `lyteboat/apps/cli/tests/fixtures/plugins/intake-gate.mjs` `apply`，以及内核自己的测试 `dsh/core/agent-loop/tests/lyteboat/intake.spec.ts`。监听返回 `{ kind: 'reply', plugin, content }` 时，这一步不请求模型直接作答（签名见 §7.5）。和准入函数比：

- 判定不记在请求上，日志里只有那条助手消息；
- 它在**每一步**都派发，包括工具之后的续步，那时 `messages` 是 `[]`（`dsh/core/agent-loop/src/agent.ts` `ReactLoopAgent.preStep`），所以监听要自己只看 `source.kind === 'user'` 的文本；
- 不命中时**必须** `return next()`，否则会挡住排在它后面的所有监听器（§4.4）；
- 仓库外的插件如果用它，要声明 `inject: ['lyteboatDistro']`，这样在官方 dsh 上不会加载（`dsh-compat/COMPAT.md` §4，`CLAUDE.md`「Architecture boundaries」的 The contract only grows 一条）。intake-guard 自己就这样声明（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService`），上面那个夹具也是。

### 2.12 构建

```sh
pnpm run build
ls examples/agents/policy-desk/lib     # intake.js policies.js tools.js 及其 .d.ts / .map
```

改了 `src/` 就要重新构建，因为 CLI 和 composite 测试加载的是 `lib/`（`CLAUDE.md`「Testing」的 Composition 一条）。

### 2.13 从 CLI 运行

**用真实模型**（`DEEPSEEK_API_KEY` 放在环境或 `$LYTEBOAT_HOME/.env` 里，数据写到 `$LYTEBOAT_HOME`，默认 `~/.lyteboat`，README「配置模型」「数据与会话日志」）：

```sh
DEEPSEEK_API_KEY=<你的 key> node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent policy-desk "保单 P-1001 还有效吗"
LYTEBOAT_POLICY_DESK_BOOK=<保单簿 JSON 的路径> DEEPSEEK_API_KEY=<你的 key> node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent policy-desk "保单 P-1001 还有效吗"
```

**用脚本模型**（不需要 key，结果确定）：把下面这段存到仓库外，例如 `$SCRATCH/policy-desk-try.sh`。它启动 `@lyteboat/testing` 的脚本模型，用 `scriptedModelEnv` 把 DeepSeek 的地址和 key 指过去，在临时 `LYTEBOAT_HOME` 下运行构建好的 CLI，再把会话日志逐条打印出来。模型的回答按请求用途决定：路由请求靠系统文本里的 `skill 路由器` 识别，标题请求靠 `concise title` 识别（`lyteboat/tooling/testing/src/scripted-model.ts` `classify`；业务模式不发标题请求，`withTitle` 留着也无妨）；loop 请求在查完保单之后，照 digest 的要求把卡片标记单独写一行。`ROOT` 和 `SESSION` 两个环境变量留给 §4.10 的续聊用。

```sh
node --input-type=module <<'EOF'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { scriptedModelEnv, startScriptedModel, withTitle } from '@lyteboat/testing/scripted-model'
import { lyteboatLauncher } from '@lyteboat/testing/process'
import { findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'

const task = process.env.TASK ?? '保单 P-1001 还有效吗'
const model = await startScriptedModel(withTitle((request) => {
  if (request.purpose === 'router') {
    const input = /<latest_user_input>([\s\S]*?)<\/latest_user_input>/u.exec(request.lastUser)?.[1] ?? ''
    return { text: JSON.stringify(/保单/u.test(input) ? { skill_id: 'policy-lookup', reason: '保单类' } : { skill_id: null, reason: '寒暄' }) }
  }
  const wanted = task.includes('电子保单') ? 'send_policy_copy' : 'query_policy'
  if (request.toolNames.includes(wanted) && !request.calledTools.includes(wanted)) {
    return { toolCall: { name: wanted, arguments: { policy_no: 'P-1001' }, id: `call-${wanted}` } }
  }
  // Right after the lookup's result, answer the way its digest asks: the card's marker on a line of its own.
  const afterLookup = request.calledTools.at(-1) === 'query_policy' && request.body.messages.at(-1)?.content.some(block => block.type === 'tool_result')
  return { text: afterLookup ? 'SCRIPTED-ANSWER\n[[card:policy_card]]\nSCRIPTED-CLOSING' : 'SCRIPTED-ANSWER' }
}), { apiKey: 'mock-key' })

const root = process.env.ROOT ?? mkdtempSync(join(tmpdir(), 'policy-desk-try-'))
const home = join(root, 'lyteboat-home')
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# try\n')
const { runLyteboat } = lyteboatLauncher(resolve('lyteboat/apps/cli/lib/bin.js'))
const resume = process.env.SESSION === undefined ? [] : ['--session-id', process.env.SESSION]
const result = await runLyteboat(['try', '--agents', resolve('examples/agents'), '--agent', 'policy-desk', ...resume, task], {
  cwd: workspace,
  env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) },
})
await model.close()

const brief = ({ type, data = {}, ignorable }) => {
  switch (type) {
    case 'lyteboat/aux-llm-call': return `ignorable=${ignorable} purpose=${data.purpose} output=${data.output}`
    case 'user/message': return `source=${data.source.kind}${data.source.name ? ` name=${data.source.name}` : ''}${data.source.lyteboatRequest ? ` intake=${data.source.lyteboatRequest.intake?.decision}` : ''}`
    case 'request/header': return `tools=${data.header.tools.length} reason=${data.reason}`
    case 'developer/message': return `source=${data.message.source.kind} ${data.message.content.map(block => `${block.type}:${block.toolName}`).join(' ')}`
    case 'assistant/message': return `provider=${data.message.source.provider} ${data.message.content.map(block => block.type).join(',')}`
    case 'tool/call': return `${data.name} ${data.arguments}`
    case 'tool/result': return `isError=${data.message.isError} meta.lyteboat=[${Object.keys(data.meta?.lyteboat ?? {})}]`
    case 'turn/end': return data.reason.kind
    default: return ''
  }
}
console.log(`exit=${result.code} stdout=${JSON.stringify(result.stdout)}`)
console.log(`stderr=${JSON.stringify(result.stderr)}`)
console.log(`model requests: ${model.requests.map(request => request.purpose).join(', ') || '(none)'}`)
const [log] = findSessionLogs(home)
console.log(`root: ${root}`)
for (const record of readSessionLog(log).slice(1)) console.log(String(record.seq).padStart(3), record.type.padEnd(26), brief(record))
EOF
```

在**仓库根**执行 `bash $SCRATCH/policy-desk-try.sh`（模块从当前目录的 `node_modules` 解析，所以必须在仓库根执行）。换任务：`TASK='把保单 P-1001 的电子保单发给我' bash $SCRATCH/policy-desk-try.sh`，或者 `TASK='帮我推荐几只股票' bash $SCRATCH/policy-desk-try.sh`。三次运行的实际输出（`root:` 那一行和部分中间记录略去，略去处写 `...`）：

```text
# TASK='保单 P-1001 还有效吗'
exit=0 stdout="SCRIPTED-ANSWER\n[card policy_card]\nSCRIPTED-CLOSING\n"
stderr="lyteboat: session session-4310e5d6-d0c7-4bc3-a1cd-ca2c1543c4fb\n"
model requests: router, loop, loop
  0 agent/inbox/spliced
  1 turn/start
  2 agent/inbox/spliced
  3 lyteboat/aux-llm-call      ignorable=true purpose=skill-router output={"skill_id":"policy-lookup","reason":"保单类"}
  4 step/start
  5 system/message
  6 user/message               source=user intake=pass
  7 user/message               source=skill-invocation name=policy-lookup
  8 user/message               source=skill-catalog
  9 request/header             tools=3 reason=initial
 10 request/context
 11 session/title
 12 assistant/message          provider=deepseek-official tool-call
 13 tool/call                  query_policy {"policy_no":"P-1001"}
 14 tool/result                isError=false meta.lyteboat=[cards,stateDelta]
 15 step/end
 16 step/start
 17 user/message               source=runtime-context
 18 assistant/message          provider=deepseek-official text
 19 step/end
 20 turn/end                   completed

# TASK='把保单 P-1001 的电子保单发给我'
exit=0 stdout="SCRIPTED-ANSWER\n"
stderr="lyteboat: session session-28a9945a-6074-46f9-ba83-924c995bc975\n"
model requests: router, loop, loop
 ...
 12 assistant/message          provider=deepseek-official tool-call
 13 tool/call                  send_policy_copy {"policy_no":"P-1001"}
 14 tool/result                isError=false meta.lyteboat=[]
 15 step/end
 16 step/start
 17 assistant/message          provider=deepseek-official text
 18 step/end
 19 turn/end                   completed

# TASK='帮我推荐几只股票'
exit=0 stdout="抱歉，我只负责保单查询，不提供股票买卖建议。\n"
stderr="lyteboat: session session-b67d66e0-c7bd-4f5f-ac98-c332f6d5a5ca\n"
model requests: (none)
 ...
  3 step/start
  4 system/message
  5 user/message               source=user intake=reply
  6 assistant/message          provider=lyteboat text
  7 step/end
  8 session/title
  9 turn/end                   completed
```

怎么读：

- **stdout 是排好的一轮。** 脚本模型的回答是 `SCRIPTED-ANSWER`、`[[card:policy_card]]`、`SCRIPTED-CLOSING` 三行，`lyteboat try` 把标记换成了 `[card policy_card]` 这一行（`lyteboat/bundles/try/src/index.ts` `renderTurn`、`run`）。回答不写标记时，这张 `deferred` 卡跟在回答后面（§3.3 的运行就是这样）；回答写了标记、这一轮却没出卡时，标记被删掉（§6）。
- **stderr 只有会话 id。** 用它续聊（§4.10）。logger 的 warn 默认不打印（§6）。
- **seq 3 是路由请求的审计记录。** 它是可忽略的 `lyteboat/aux-llm-call`，`purpose` 为 `skill-router`，记着路由 prompt 和模型的回答（§3.2）。
- **seq 6 是任务本身。** 它的 `source` 除了 `kind: 'user'`，还带着这次请求的发起者 `lyteboatRequest.owner`（`lyteboat try` 记 `{ kind: 'operator', id: 'cli' }`）、agent 的身份 `lyteboatRequest.agent`（§4.16）和准入判定 `lyteboatRequest.intake`。第三次运行的判定是 `reply`（那里任务是 seq 5），紧接着的 seq 6 就是助手的回复：没有路由、没有 `request/header`、没有模型请求。
- **seq 7 是路由到的技能正文**，一条 `source.kind` 为 `skill-invocation` 的 user 消息，排在任务之后、技能目录之前。第一步没有 runtime-context 消息：会话状态还是空的，业务底座又关掉了 dsh 的沙箱与审批两段。
- **seq 9 的 `reason` 是 `initial`**：会话的第一个请求。续聊那一轮的第一个请求是 `resume`（§4.10），两次请求之间工具集变了是 `change`（§3.3）。
- **seq 11 的 `session/title` 是回退标题**：业务底座关掉了会话标题的旁路请求，所以模型请求里没有 `title`。
- **seq 14 的 meta 带 `cards` 和 `stateDelta`。** 第二次运行里 `send_policy_copy` 的结果是 `status=queued · 电子保单 P-1001`，它不出卡也不写状态，所以没有 meta，下一步也没有新的 runtime context。

`tools=3` 是 dsh-base 留给业务模式的 `skill`，加上本 agent 的两个 `auto` 工具。没有路由到技能时（例如任务是「你好」），`request/header` 里只有 `skill`（§3.3）。业务模式给 agent 的是什么、要用别的 dsh 工具怎么写，见 §4.11。

### 2.14 单元测试

三个 spec 文件都在 vitest 的 `source` 项目里跑，通过 `@lyteboat/source` 条件读本包和其他 lyteboat 包的源码，不需要构建本 agent（`vitest.config.ts`）。但内核至少要用 `pnpm run build` 构建过一次（`CLAUDE.md`「Repository layout」「Done criteria」）：lyteboat 的包经内核包的 `lib/` 加载内核（`dsh/core/tools/package.json`）。

`tests/policies.spec.ts` 测 L4 纯函数，读的就是 agent 自己的保单簿 `assets/sample-data/policies.json`（从 `tests/` 往上一级到包根）：

```ts
/**
 * The policy book's pure functions: lookup, the summary the session state
 * keeps, and a malformed book failing loud.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findPolicy, loadPolicies, policySummary } from '@lyteboat/agent-policy-desk/policies'

const BOOK = fileURLToPath(new URL('../assets/sample-data/policies.json', import.meta.url))

describe('policy book', () => {
  it('finds a policy by number regardless of case and blanks', () => {
    expect(findPolicy(loadPolicies(BOOK), ' p-1001 ')).toMatchObject({ policy_no: 'P-1001', status: 'active' })
  })

  it('keeps the insured person and the premium out of the summary that enters the session state', () => {
    const policy = findPolicy(loadPolicies(BOOK), 'P-2002')
    expect(policy && policySummary(policy)).toEqual({ policy_no: 'P-2002', product: '长青定期人寿保险', status: 'lapsed', sum_insured: '500000.00', end_date: '2043-05-09', next_due: '2026-05-10' })
  })

  it('fails loud on a book with a malformed policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-desk-'))
    const file = join(dir, 'book.json')
    writeFileSync(file, JSON.stringify({ policies: [{ policy_no: 'P-1' }] }))
    try {
      expect(() => loadPolicies(file)).toThrow('policies[0].product must be a string')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

`tests/intake.spec.ts` 只测判定本身，它是纯函数，不用启动任何服务：

```ts
/**
 * The admission's verdict, from the request text alone.
 */
import { describe, expect, it } from 'vitest'
import { policyDeskVerdict } from '@lyteboat/agent-policy-desk/intake'

describe('policyDeskVerdict', () => {
  it('answers a stock-trading request with the fixed reply', () => {
    expect(policyDeskVerdict('帮我推荐几只股票')).toEqual({ decision: 'reply', verdict: 'out_of_scope', text: '抱歉，我只负责保单查询，不提供股票买卖建议。' })
  })

  it('admits a policy question and small talk', () => {
    expect(policyDeskVerdict('保单 P-1001 还有效吗')).toEqual({ decision: 'pass' })
    expect(policyDeskVerdict('你好')).toEqual({ decision: 'pass' })
  })
})
```

`tests/policy-desk.spec.ts` 把两个行挂在**单元宿主**上。`createLyteboatUnitHost(adapter)`（`@lyteboat/testing`）按 `CLAUDE.md`「Testing」的 Unit harness 一条搭好宿主：dsh 的不变量注册表、dsh 服务、内核的 agent loop，`adapter` 作为 `mock` provider 的模型，测试结束时自动释放（`lyteboat/tooling/testing/src/index.ts`）。测试再挂上要测的 lyteboat 服务和本 agent 的两个行。`followUpAndWait(agent, text)` 发一条普通的用户消息并等到 agent 空闲（`index.ts`），它不经过 `submit`；要走 `lyteboat try` 那条路径，就调 `ctx.intakeGuard.submit` 再 `agent.whenIdle()`。

```ts
/**
 * The policy-desk rows on the unit host: the kernel's agent loop with the tool
 * policy, a2ui, request context and admission services, the agent's two rows,
 * and a MockAdapter as the model. No router runs here: a test activates the
 * tools routing to policy-lookup would. What the try composition shows
 * (policy-desk.composite.ts) is not repeated: these are the tool's result, the
 * card under strict validation, and admission with and without `submit`.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { MockAdapter, createLyteboatUnitHost, followUpAndWait, textResponse, toolCallResponse } from '@lyteboat/testing'
import LyteboatDistroService from '@lyteboat/distro'
import ToolPolicyService from '@lyteboat/tool-policy'
import A2uiService, { validateFullPayload } from '@lyteboat/a2ui'
import RequestContextService from '@lyteboat/request-context'
import IntakeGuardService from '@lyteboat/intake-guard'
import * as policyDeskTools from '@lyteboat/agent-policy-desk/tools'
import * as policyDeskIntake from '@lyteboat/agent-policy-desk/intake'

async function host(adapter: MockAdapter): Promise<Context> {
  const ctx = await createLyteboatUnitHost(adapter)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LyteboatDistroService)
  await ctx.plugin(ToolPolicyService)
  await ctx.plugin(A2uiService)
  await ctx.plugin(RequestContextService)
  await ctx.plugin(IntakeGuardService)
  await ctx.plugin(policyDeskTools)
  await ctx.plugin(policyDeskIntake)
  return ctx
}

/** One query_policy call on a fresh agent with the lookup tools activated. */
async function lookUp(policyNo: string) {
  const adapter = new MockAdapter([toolCallResponse('call-1', 'query_policy', { policy_no: policyNo }), textResponse('好的。')])
  const ctx = await host(adapter)
  const agent = await ctx.agentLoop.create(SessionId(`policy-${policyNo}`), { provider: 'mock', model: 'mock' })
  ctx.toolPolicy.activate(agent, ['query_policy', 'send_policy_copy'])
  await followUpAndWait(agent, `保单 ${policyNo} 还有效吗`)
  const result = agent.session.snapshotEvents().find((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
  const text = result?.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')
  return { ctx, agent, text, meta: result?.data.meta }
}

describe('policy-desk rows on the unit host (MockAdapter)', () => {
  it('query_policy renders a strictly valid deferred card, folds the summary into the state, and asks for the marker', async () => {
    const { ctx, agent, text } = await lookUp('P-1001')
    expect(text).toMatch(/^status=ok · \[卡片:保单\/active\] 安心医疗保险 · 保额2000000.00元/u)
    expect(text).toContain('[[card:policy_card]] 单独一行')
    const [card] = ctx.a2ui.cardsOf(agent)
    expect(card).toMatchObject({ callId: 'call-1', area: 'policy_card', emission: 'deferred' })
    const payload = card?.payload as Record<string, unknown>
    expect(validateFullPayload(payload, { strict: true }).errors).toEqual([])
    expect(JSON.stringify(payload)).toContain('保额 2,000,000.00 元')
    expect(JSON.stringify(payload)).not.toContain('该保单已失效')
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatState')).toEqual({
      policy_desk: { current: { policy_no: 'P-1001', product: '安心医疗保险', status: 'active', sum_insured: '2000000.00', end_date: '2026-12-31', next_due: '2026-12-01' } },
    })
  })

  it('query_policy shows the lapse tip when the policy has lapsed', async () => {
    const { ctx, agent } = await lookUp('P-2002')
    expect(JSON.stringify(ctx.a2ui.cardsOf(agent)[0]?.payload)).toContain('该保单已失效')
  })

  it('query_policy answers with a degraded digest, no card and no state when the number is unknown', async () => {
    const { ctx, agent, text, meta } = await lookUp('P-9999')
    expect(text).toBe('status=not-found · 未找到保单 P-9999，请用户核对保单号')
    expect(meta).toEqual({})
    expect(ctx.a2ui.cardsOf(agent)).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatState')).toEqual({})
  })

  it('submit records the verdict on the request when the admission replies', async () => {
    const adapter = new MockAdapter([])
    const ctx = await host(adapter)
    const agent = await ctx.agentLoop.create(SessionId('policy-submit'), { provider: 'mock', model: 'mock' })
    await ctx.intakeGuard.submit(agent, { text: '帮我推荐几只股票' }, AbortSignal.timeout(5000))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')?.intake).toEqual({
      by: 'policy-desk-intake', decision: 'reply', verdict: 'out_of_scope', text: '抱歉，我只负责保单查询，不提供股票买卖建议。',
    })
  })

  it('a message followed up without submit gets the same reply in the loop, with no verdict on the message', async () => {
    const adapter = new MockAdapter([])
    const ctx = await host(adapter)
    const agent = await ctx.agentLoop.create(SessionId('policy-followup'), { provider: 'mock', model: 'mock' })
    await followUpAndWait(agent, '帮我推荐几只股票')
    expect(adapter.requests).toEqual([])
    const events = agent.session.snapshotEvents()
    const human = events.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(human?.data.source).toEqual({ kind: 'user' })
    const reply = events.find((event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message')
    expect(reply?.data.message.source).toMatchObject({ provider: 'lyteboat', model: 'policy-desk-intake' })
    expect(ctx.sessionProjections.stateOf(agent.session, 'lyteboatRequest')?.intake).toBeNull()
  })
})
```

- 宿主上没有路由器，所以测试直接 `ctx.toolPolicy.activate(agent, [...])`，效果和路由到 `policy-lookup` 相同（§4.4）。路由本身由组合测试负责（§2.15）。
- `validateFullPayload(payload, { strict: true })` 按默认的领域中立目录做契约校验，`renderCard` 不做这一步（§2.9、§2.10）。
- 最后两个用例对比准入的两条路径：`submit` 把判定记在请求上，`lyteboatRequest` 投影读得到；`followUpAndWait` 发的消息在循环里补做准入，回复一样，消息的 `source` 只有 `{ kind: 'user' }`，投影里的 `intake` 仍是 `null`。两条路径都不请求模型：`MockAdapter([])` 的脚本是空的，被调用就会报错。

§2.16 的冒烟 `*.e2e.ts` 也在 `source` 项目里（`vitest.config.ts`），它要先构建出启动器，所以只跑单元测试时像 `pnpm run test:unit` 一样用 `--exclude` 去掉它：

```sh
npx vitest run --project source examples/agents/policy-desk --exclude '**/*.e2e.ts'
```

```text
 Test Files  3 passed (3)
      Tests  10 passed (10)
```

### 2.15 组合测试：`tests/policy-desk.composite.ts`

agent 必须有组合测试（`CLAUDE.md`「Testing」的测试表和 Who tests what）。`bootComposition`（`@lyteboat/testing/composition`）在测试进程里按 launcher 的方式启动 `LYTEBOAT_TRY_BUNDLES`（`dsh-base + @lyteboat/host + @lyteboat/business-base + @lyteboat/try`），内部参数放在 `ctx.cmdlineArgs` 上；profile 跳过了要求的 bundle 时启动失败。loader 加载 `lib/`，所以要先构建（`lyteboat/tooling/testing/src/composition.ts`）。`createLyteboatScratch(name)` 给每个测试文件一个临时根目录，`run(label)` 在它下面建一对干净的 home 和工作区（`lyteboat/tooling/testing/src/scratch.ts`）；`scriptedModelEnv(model)` 给出指向脚本模型的环境变量（`scripted-model.ts`）；`printedSessionId(stderr)` 从 stderr 取会话 id（`composition.ts`）；`reopenRefusal(records)` 用 dsh 自己的校验器判断日志能不能重开（`lyteboat/tooling/testing/src/session-reopen.ts`）。

```ts
/**
 * The policy-desk agent in the try composition, booted in process against the
 * scripted model: routing brings the skill's body and tools into the same step,
 * the model sees only `skill` and the tools the agent declares, the lookup puts
 * a card and a state delta on the tool result and the answer's marker places
 * the card, the copy tool queues the e-policy, the admission answers a
 * stock-trading request before the loop without a model request, and
 * `--session-id` continues a routed session that dsh's persistence reopens.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LYTEBOAT_TRY_BUNDLES, bootComposition, printedSessionId } from '@lyteboat/testing/composition'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { reopenRefusal } from '@lyteboat/testing/session-reopen'
import { scriptedModelEnv, startScriptedModel, withTitle, type ChatBlock, type RecordedRequest, type ScriptedModel } from '@lyteboat/testing/scripted-model'

/** The agents root this package lives in, as `--agents ./examples/agents` names it. */
const AGENTS = fileURLToPath(new URL('../..', import.meta.url))
const ANSWER = 'POLICY-DESK-OK'
/** What the lookup's digest asks for: a line, the card's marker on a line of its own, a closing line. */
const PLACED = `${ANSWER}\n[[card:policy_card]]\n以上是您的保单。`

type LogRecord = { type: string; ignorable?: true; data?: Record<string, unknown> }

/** Every text the request carries, tool results included. */
function messageTexts(request: RecordedRequest): string {
  const text = (block: ChatBlock): string => block.text ?? (Array.isArray(block.content) ? (block.content as ChatBlock[]).map(text).join('') : '')
  return request.body.messages.flatMap(message => message.content.map(text)).join('\n')
}

/** The router prompt quotes the skill descriptions; only the latest input decides. */
function latestInput(request: RecordedRequest): string {
  return /<latest_user_input>([\s\S]*?)<\/latest_user_input>/u.exec(request.lastUser)?.[1] ?? ''
}

/** The loop's first user block is the task itself (runtime context, skill body and catalog follow it). */
function task(request: RecordedRequest): string {
  return request.body.messages[0]?.content[0]?.text ?? ''
}

/** The source of every user message in the log, in order. */
function userSources(records: LogRecord[]): Record<string, unknown>[] {
  return records.filter(record => record.type === 'user/message').map(record => record.data?.['source'] as Record<string, unknown>)
}

/** The skills routed into a step: dsh's skill-invocation messages, in order. */
function invokedSkills(records: LogRecord[]): unknown[] {
  return userSources(records).filter(source => source['kind'] === 'skill-invocation').map(source => source['name'])
}

/** Router: policy talk routes to policy-lookup. Loop: call the one tool the task needs, once, then answer. */
function script(request: RecordedRequest) {
  if (request.purpose === 'router') {
    return { text: JSON.stringify(/保单/u.test(latestInput(request)) ? { skill_id: 'policy-lookup', reason: '保单类' } : { skill_id: null, reason: '寒暄' }) }
  }
  const wanted = task(request).includes('电子保单') ? 'send_policy_copy' : 'query_policy'
  if (request.toolNames.includes(wanted) && !request.calledTools.includes(wanted)) {
    return { toolCall: { name: wanted, arguments: { policy_no: 'P-1001' }, id: `call-${wanted}` } }
  }
  const afterLookup = request.calledTools.at(-1) === 'query_policy' && request.body.messages.at(-1)?.content.some(block => block.type === 'tool_result')
  return { text: afterLookup ? PLACED : ANSWER }
}

describe('policy-desk agent in the try composition (in process, scripted model)', () => {
  const scratch = createLyteboatScratch('policy-desk')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  /** One `lyteboat try` in a home and workspace of its own. */
  async function boot(home: string, workspace: string, args: string[]) {
    const before = model.requests.length
    const result = await bootComposition({
      bundles: LYTEBOAT_TRY_BUNDLES,
      args: ['--agents', AGENTS, '--agent', 'policy-desk', ...args],
      cwd: workspace,
      home,
      env: scriptedModelEnv(model),
    })
    expect(result.code, result.stderr).toBe(0)
    const [log] = findSessionLogs(home)
    return { ...result, requests: model.requests.slice(before), records: readSessionLog(log ?? '') as unknown as LogRecord[] }
  }

  async function run(label: string, text: string) {
    const { home, workspace } = scratch.run(label)
    return boot(home, workspace, [text])
  }

  it('"保单 P-1001 还有效吗": routes to policy-lookup, places the card by its marker, and shows the model the digest and the state', async () => {
    const { requests, records, stdout } = await run('lookup', '保单 P-1001 还有效吗')
    expect(stdout).toBe(`${ANSWER}\n[card policy_card]\n以上是您的保单。\n`)
    expect(requests.filter(request => request.purpose === 'router')).toHaveLength(1)
    const loop = requests.filter(request => request.purpose === 'loop')
    expect(loop).toHaveLength(2)
    expect(loop[0]?.systemText).toContain('POLICY-DESK-PERSONA')
    expect([...loop[0]!.toolNames].sort()).toEqual(['query_policy', 'send_policy_copy', 'skill'])
    expect(messageTexts(loop[0]!)).toContain('<skill_content name="policy-lookup">')
    const second = messageTexts(loop[1]!)
    expect(second).toContain('status=ok · [卡片:保单/active]')
    expect(second).toContain('"policy_desk":{"current":{"policy_no":"P-1001"')
    expect(second).not.toContain('rootComponentId')
    expect(invokedSkills(records)).toEqual(['policy-lookup'])
    expect(records.filter(record => record.type.startsWith('lyteboat/')).map(record => [record.type, record.ignorable, record.data?.['purpose']]))
      .toEqual([['lyteboat/aux-llm-call', true, 'skill-router']])
    const meta = records.find(record => record.type === 'tool/result')?.data?.['meta'] as { lyteboat: { cards: { surfaceId: string; area: string; emission: string }[]; stateDelta: unknown } }
    expect(meta.lyteboat.stateDelta).toEqual({ 'policy_desk.current': { policy_no: 'P-1001', product: '安心医疗保险', status: 'active', sum_insured: '2000000.00', end_date: '2026-12-31', next_due: '2026-12-01' } })
    expect(meta.lyteboat.cards).toEqual([expect.objectContaining({ area: 'policy_card', emission: 'deferred', surfaceId: expect.stringMatching(/^policy_card-session--[0-9a-f]{6}$/u) as string })])
  })

  it('"你好": the router keeps no skill and the auto tools stay hidden', async () => {
    const { requests, records } = await run('plain', '你好')
    const [loop] = requests.filter(request => request.purpose === 'loop')
    expect(loop?.toolNames).toEqual(['skill'])
    expect(records.find(record => record.type === 'lyteboat/aux-llm-call')?.data).toMatchObject({ purpose: 'skill-router', output: '{"skill_id":null,"reason":"寒暄"}' })
    expect(invokedSkills(records)).toEqual([])
  })

  it('"把保单 P-1001 的电子保单发给我": the copy tool the routed skill activates queues the copy, with no card and no state', async () => {
    const { records } = await run('copy', '把保单 P-1001 的电子保单发给我')
    const result = records.find(record => record.type === 'tool/result')?.data
    expect(result?.['message']).toMatchObject({ isError: false, content: [{ type: 'text', text: 'status=queued · 电子保单 P-1001' }] })
    expect(result?.['meta']).toBeUndefined()
  })

  it('"帮我推荐几只股票": the admission answers before the loop, with its verdict on the request and zero model requests', async () => {
    const { requests, records, stdout } = await run('gate', '帮我推荐几只股票')
    expect(requests).toEqual([])
    expect(stdout).toBe('抱歉，我只负责保单查询，不提供股票买卖建议。\n')
    expect(userSources(records)).toEqual([{
      kind: 'user',
      lyteboatRequest: {
        owner: { kind: 'operator', id: 'cli' },
        agent: { id: 'policy-desk', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
        intake: { by: 'policy-desk-intake', decision: 'reply', verdict: 'out_of_scope', text: '抱歉，我只负责保单查询，不提供股票买卖建议。' },
      },
    }])
    const types = records.map(record => record.type)
    expect(types).not.toContain('request/header')
    expect(types).not.toContain('lyteboat/aux-llm-call')
    const reply = records.find(record => record.type === 'assistant/message')?.data?.['message'] as { source: Record<string, unknown> }
    expect(reply.source).toMatchObject({ provider: 'lyteboat', model: 'policy-desk-intake' })
  })

  it('--session-id continues the routed session in a new process with the skill, its tools, and the state in force', async () => {
    const { home, workspace } = scratch.run('continue')
    const first = await boot(home, workspace, ['保单 P-1001 还有效吗'])
    const { requests, records } = await boot(home, workspace, ['--session-id', printedSessionId(first.stderr), '那什么时候到期'])
    expect(requests.find(request => request.purpose === 'router')?.lastUser).toContain('<current_active_skill>policy-lookup</current_active_skill>')
    const [loop] = requests.filter(request => request.purpose === 'loop')
    expect(loop?.toolNames).toContain('query_policy')
    expect(messageTexts(loop!)).toContain('"policy_desk":{"current":{"policy_no":"P-1001"')
    expect(invokedSkills(records)).toEqual(['policy-lookup'])
    expect(records.filter(record => record.type === 'turn/start')).toHaveLength(2)
    expect(reopenRefusal(records)).toBeUndefined()
  })
})
```

```sh
pnpm run build && npx vitest run examples/agents/policy-desk/tests/policy-desk.composite.ts
```

```text
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

写脚本的规矩：

- 按**用途**应答，路由请求靠系统文本识别，不要靠调用顺序（`CLAUDE.md`「Testing」的 Unit harness 一条）。`withTitle` 替你回答标题请求（`scripted-model.ts`）；业务模式不发标题请求，留着它是为了同一个脚本在 `lyteboat web` 那样的组合里也能用。脚本模型只认得 loop、title、router 三种用途（`scripted-model.ts` `classify`）：agent 自己的旁路调用（例如用 `ctx.auxLlm` 做准入分类）到这里也是 `loop`，要靠它自己的系统文本认出来（金融智能体的组合测试用 `准入分类器` 这几个字认，`examples/agents/finance/tests/support/finance-model.ts` `isIntake`）。
- 路由器 prompt 里会引用每个技能的 description，所以判断意图只看 `<latest_user_input>` 里的内容（金融智能体的组合测试也是这么做的，`finance-model.ts` `financeScript`）。
- loop 请求里，第一个 user 块就是任务本身，因为 DeepSeek 适配器把连续的 user 节点合并成了一条消息（用户消息、runtime context、技能正文、技能目录）。续聊时它是第一轮的任务，所以续聊用例里 `wanted` 仍是 `query_policy`，而它已经在历史里调用过，脚本直接回答。
- 回答写不写卡片标记，要看这次请求是不是紧跟在 `query_policy` 的结果后面：最后一条消息里有 `tool_result`，最后调用的工具是 `query_policy`。只看「历史里调用过」不够，续聊的那一轮也会满足。
- 路由到的技能用 `invokedSkills` 从日志里认：dsh 的技能调用消息 `source.kind === 'skill-invocation'`，`name` 就是技能 id；路由请求本身是日志里唯一一条 `lyteboat/*` 记录，`ignorable` 为 `true`。
- 请求里的工具顺序不是注册顺序，断言时用 `arrayContaining` 或先排序（`CLAUDE.md`「Testing」的 Scripted model and logs 一条）。第一个用例排序后断言整份工具表：业务模式里 agent 只看得到 `skill` 和它自己声明的工具，多出一个就说明有别的行往宿主上加了工具，而 `inherited: hidden` 没挡住它。
- 第四个用例断言 `reply.source` 用的是 `toMatchObject`，只检查子集：日志里的 `source` 还带着 `kind: 'model'`（§2.11）。人类消息的 `source` 则用 `toEqual` 整个断言，发起者和判定的每个字段都在里面。
- 续聊用例用同一对 home 和工作区跑两次（续聊要求 `LYTEBOAT_HOME` 不变；带 `--agent` 时会话记在 agent 的工作目录里，启动目录换了也行，§4.10），会话 id 用 `printedSessionId` 从第一次的 stderr 里取；`reopenRefusal` 返回 `undefined`，说明这份路由过、续过的日志 dsh 能重开（§4.10）。

### 2.16 e2e 冒烟：`tests/policy-desk-smoke.e2e.ts`

每个 agent 在构建好的可执行文件上跑一次冒烟，冒烟放在 agent 自己的 `tests/` 里（`CLAUDE.md`「Testing」的 Who tests what 和 E2E 两条）。它证明安装闭包、profile 和 agent 目录能在发布产物里一起加载；agent 的行为由上面的测试负责。

```ts
/**
 * The built launcher boots the policy-desk agent from `--agents ./examples/agents`.
 * The agent's behavior is this package's unit and composition tests; this
 * proves the installation closure, the try profile, and the agent directory
 * load together from the built artifact.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lyteboatLauncher } from '@lyteboat/testing/process'
import { createLyteboatScratch } from '@lyteboat/testing/scratch'
import { eventTypes, findSessionLogs, readSessionLog } from '@lyteboat/testing/session-log'
import { scriptedModelEnv, startScriptedModel, withTitle, type RecordedRequest, type ScriptedModel } from '@lyteboat/testing/scripted-model'

/** The examples/agents root this package lives in, as `--agents ./examples/agents` names it. */
const AGENTS = fileURLToPath(new URL('../..', import.meta.url))
// The published artifact under plain Node, reached through this package's devDependency on the launcher.
const { runLyteboat } = lyteboatLauncher(createRequire(import.meta.url).resolve('@lyteboat/cli/lib/bin.js'))

function script(request: RecordedRequest) {
  if (request.purpose === 'router') return { text: JSON.stringify({ skill_id: 'policy-lookup', reason: '保单类' }) }
  const offered = request.toolNames.includes('query_policy')
  return offered && !request.calledTools.includes('query_policy')
    ? { toolCall: { name: 'query_policy', arguments: { policy_no: 'P-1001' }, id: 'call-query' } }
    : { text: 'POLICY-DESK-SMOKE-OK' }
}

describe('lyteboat try --agents ./examples/agents --agent policy-desk (built bin, scripted model)', () => {
  const scratch = createLyteboatScratch('policy-desk-smoke')
  let model: ScriptedModel

  beforeAll(async () => {
    model = await startScriptedModel(withTitle(script), { apiKey: 'mock-key' })
  })

  afterAll(async () => {
    await model.close()
    scratch.remove()
  })

  it('routes, looks the policy up, renders its card, and answers', async () => {
    const { home, workspace } = scratch.run('smoke')
    const result = await runLyteboat(['try', '--agents', AGENTS, '--agent', 'policy-desk', '保单 P-1001 还有效吗'], {
      cwd: workspace,
      env: { LYTEBOAT_HOME: home, ...scriptedModelEnv(model) },
    })
    expect(result.code, result.stderr).toBe(0)
    // The answer wrote no marker, so the deferred card follows it.
    expect(result.stdout).toBe('POLICY-DESK-SMOKE-OK\n[card policy_card]\n')
    const records = readSessionLog(findSessionLogs(home)[0] ?? '')
    expect(JSON.stringify(records)).toContain('"kind":"skill-invocation","name":"policy-lookup"')
    // Not `.at(-1)`: what matters is that the turn ended, not which record dsh wrote last.
    expect(eventTypes(records)).toContain('turn/end')
  })
})
```

```sh
pnpm run build && npx vitest run examples/agents/policy-desk/tests/policy-desk-smoke.e2e.ts
```

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

冒烟和 CLI 自己的 e2e 一样派生构建好的 `lib/bin.js`，但它不在 CLI 包里，也不能伸进 `lyteboat/apps/cli/tests/` 借那里的辅助文件（`CLAUDE.md`「Testing」的 Who tests what）。所以它自己用 `@lyteboat/testing/process` 的 `lyteboatLauncher` 绑定启动器，启动器的路径经本包对 `@lyteboat/cli` 的 devDependency 解析成 `@lyteboat/cli/lib/bin.js`，写法照金融智能体的冒烟（`examples/agents/finance/tests/finance-smoke.e2e.ts`）。`@lyteboat/cli` 在 `apps` 层，`examples` 只能经 devDependencies 依赖它（§2.2）。这一项要自己记得写：`createRequire(...).resolve` 不是 import，knip 不把它当依赖（实测去掉这一项，knip 照样通过），而根 `node_modules` 提升了每个 `@lyteboat/*` 包（`pnpm-workspace.yaml`），解析也能碰巧成功；写上它，这条边才出现在清单里，由 check-layers 检查。stdout 断言的是整轮输出：脚本的回答没写卡片标记，本轮正常结束，所以 `deferred` 的保单卡跟在回答后面，打成一行 `[card policy_card]`，写法和金融智能体的冒烟一样（`finance-smoke.e2e.ts`）。

最后一条断言故意不写 `.at(-1)`：它要证明的是这一轮结束了，不是 `turn/end` 恰好是最后一条。业务模式只写一条回退标题，落在 `turn/end` 之前；在带着标题请求的组合里（`lyteboat web`），模型给出的 `session/title` 是异步到达的，可能排在 `turn/end` 之后，`normalizeSessionLog` 为此专门去掉 `session/title*`（`lyteboat/tooling/testing/src/session-log.ts` `DROPPED_EVENT_TYPES`）。

### 2.17 收尾

```sh
pnpm run lint        # oxlint + knip（未声明的依赖、未用的导出）+ check-layers + distro manifest + check-sensitive
pnpm run typecheck   # tsc -b + tsc -p tsconfig.tests.json（测试也做类型检查）
pnpm run test        # build + G1 + source/dsh/composite 三个项目
```


`pnpm run lint` 最后一步是 `scripts/check-sensitive.ts`：它扫描 git 跟踪的（和将要跟踪的）每个文件的路径和内容，找部署方标为敏感的词。词表不进仓库，由环境变量 `LYTEBOAT_SENSITIVE_WORDS`（逗号分隔）或 `LYTEBOAT_SENSITIVE_WORDS_FILE` 提供；两个都没设时它说明跳过并通过（`scripts/check-sensitive.ts`）。新 agent 的文案、夹具和测试名都在扫描范围里。

新 agent 属于 `CLAUDE.md`「Workflow」→「Task types」里的结构性任务：先按 C4 自顶向下做设计，设计交付物按那一节的形式交付，不提交进仓库。

提交信息写成 `<type>: <package> — <交付了什么>`，type 用 conventional 前缀（`CLAUDE.md`「Unattended runs」）；正文写能跑什么、验收了什么，贴上在构建好的二进制上跑过的命令（`CLAUDE.md`「Workflow」→「Done criteria」第 4 条）；没有 eval 数据的 prompt 文本要写明是 working hypothesis（`CLAUDE.md`「Agent design」）；最后是会话给出的署名尾部和 `Co-authored-by: $GIT_COAUTHOR`（`CLAUDE.md`「Unattended runs」）；任何地方都不写模型标识（同一节）。例如：

```text
feat: @lyteboat/agent-policy-desk — a policy lookup agent: routed skill, policy card, e-policy copy, admission

Runs now: node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent policy-desk "保单 P-1001 还有效吗"
Accepted (scripted model): model requests router, loop, loop; the loop sees skill, query_policy and
send_policy_copy only; tool/result carries meta.lyteboat.cards
and meta.lyteboat.stateDelta, and the answer's marker places the card; "帮我推荐几只股票" is answered by the
admission before the loop with zero model requests; --session-id continues a routed session.
The persona and the SKILL.md description have no eval data yet: working hypothesis.

<会话给出的署名尾部>
Co-authored-by: <GIT_COAUTHOR 的值>
```

---

## 3. 一次请求在你的 agent 里怎么走

### 3.1 时序

下图对应 §2.13 的第一次运行（「保单 P-1001 还有效吗」）。`alt` 分支是准入判定为 `reply` 时的走法（第三次运行）。

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant BR as lyteboat try
    participant IG as intake-guard
    participant KL as 内核 agent loop
    participant TP as tool-policy
    participant SR as skill-router
    participant AUX as aux-llm
    participant M as 模型
    participant TOOL as query_policy
    participant A2 as a2ui
    participant LOG as 会话日志
    U->>BR: 任务 保单 P-1001 还有效吗
    BR->>IG: intakeGuard.submit（任务、发起者、请求上下文）
    IG->>IG: policy-desk-intake 的准入函数给出判定，补上 by
    IG->>KL: agent.followup（用户消息，source 带请求和判定）
    KL->>LOG: agent/inbox/spliced, turn/start, 认领消息
    KL->>IG: lyteboat/intake（waterfall，intake-guard 在 next 之后读判定）
    alt 判定为 reply（荐股）
        IG-->>KL: reply（plugin 为 policy-desk-intake，内容是判定里的 text）
        KL->>LOG: step/start, 空 system/message, user/message（带判定）, assistant/message（provider lyteboat）, step/end
        Note over LOG: 标题插件照常写回退标题 session/title（source.kind 为 fallback）
        KL-->>BR: turn/end completed，零模型请求
    else 判定为 pass
        IG-->>KL: pass
        KL->>TP: lyteboat/pre-assemble（tool-policy 在最外层）
        TP->>SR: await next()
        SR->>AUX: auxLlm.generate（purpose skill-router）
        AUX->>M: 路由旁路调用（skill 路由器 prompt）
        M-->>AUX: skill_id policy-lookup
        AUX->>LOG: lyteboat/aux-llm-call（ignorable）
        AUX-->>SR: answer
        SR->>TP: clear 后 activate(query_policy, send_policy_copy)
        Note over SR: 技能正文先记下，留到 agent/pre-step 再放进这一步
        TP->>TP: next() 返回后 reconcile，重算 restrict(deny)
        KL->>KL: systemPrompt.assemble，runtime context
        KL->>SR: agent/pre-step（next 之后追加技能调用消息）
        KL->>LOG: step/start, system/message, user/message x3, request/header, request/context
        KL->>M: 请求 1（3 个工具）
        M-->>KL: tool-call query_policy
        KL->>LOG: assistant/message, tool/call
        KL->>TOOL: tools/execute
        TOOL->>A2: a2ui.renderCard(policy_card, 保单, agent)
        A2-->>TOOL: surfaceId, area, emission deferred, payload
        TOOL-->>KL: render 出 digest，presentationMeta 出 cards，stateDelta
        KL->>LOG: tool/result（meta.lyteboat.cards, meta.lyteboat.stateDelta）
        Note over LOG: lyteboatState 与 lyteboatCards 投影折叠这条 tool/result
        KL->>LOG: step/end, step/start, user/message（runtime context，只有 lyteboat:state）
        KL->>M: 请求 2
        M-->>KL: 文本回答，单独一行写着 policy_card 的卡片标记
        KL->>LOG: assistant/message, step/end, turn/end completed
    end
    BR->>A2: turnParts（本轮的日志区间）
    BR->>U: stdout 打印回答，卡片标记换成 [card policy_card]；stderr 打印会话 id；exit 0
```

每一步的依据：

- 准入在 `followup` 之前，由 `submit` 完成（`lyteboat/plugins/intake-guard/src/index.ts`）。循环里 `lyteboat/intake` 在 pre-assemble 之前派发，reply 时直接返回（`dsh/core/agent-loop/src/agent.ts` `ReactLoopAgent.preStep`）；intake-guard 的监听在 `next()` 之后读人类消息上的判定（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService`）。所以准入回复的路径上没有路由调用，也没有 prompt 组装。标题插件在用户消息到达时照常写一个回退标题（上游 `packages/session/session-title/src/index.ts:499-523`）；标题的模型请求来自 `session-title-llm` 行，业务底座关掉了它（`lyteboat/bundles/business-base/cordis.patch.yml`），所以哪条路径上都没有标题请求。§2.13 第三次运行的 seq 8 就是那条回退标题，其 `source.kind` 为 `fallback`。
- tool-policy 在 `next()` **之后**重算限制，skill-router 在 `next()` **之前**路由（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService`，`lyteboat/plugins/skill-router/src/index.ts` `SkillRouterService`）。所以同一步里被激活的工具，在本步的请求里就可见。
- 路由调用是一次旁路调用：skill-router 调 `ctx.auxLlm.generate`，`purpose` 为 `skill-router`、`maxTokens` 取设置里的 `maxTokens`（默认 200）、`temperature` 0（`skill-router/src/index.ts` `SkillRouterService.decide`）；aux-llm 带着 `sessionId` 发出请求，再把这次调用追加成可忽略的 `lyteboat/aux-llm-call`（`lyteboat/plugins/aux-llm/src/index.ts` `AuxLlmService.stream`）。它不上会话表面。调用失败（超时、答案在 `maxTokens` 处被截断、出错）时保持当前技能，并打一条 warn（`skill-router/src/index.ts` `SkillRouterService.decide`）。
- 技能正文不是在路由时写进去的：路由只把它记下（`skill-router/src/index.ts` `SkillRouterService.applyActive`），到 dsh 的 `agent/pre-step` 时，skill-router 在 `next()` 之后把它作为技能调用消息追加到这一步的消息里，被拒绝的步骤不追加。只有切换技能、或者正文已经不在模型视野里（例如被压缩掉）时才追加（`bodyOnSurface`），所以续聊的下一轮不会再塞一遍（§4.10）。
- runtime context 不在 system prompt 里，而是作为 `source.kind: 'runtime-context'` 的 user 消息追加，且只在文本变化时追加（`dsh/core/agent-loop/src/runtime-context.ts` `RuntimeContextProjection.project`；它是 `agent/pre-step` 的默认结果，`dsh/core/agent-loop/src/agent.ts` `ReactLoopAgent.preStep`）。这一步的 user 消息依次是：任务、技能调用消息、dsh-tool-skill 在更外层的 `agent/pre-step` 监听里追加的技能目录（上游 `packages/skill/tool-skill/src/index.ts:213-220`、`:272`）。第一步没有 runtime context：业务底座关掉了 dsh 沙箱与审批的那两段，会话状态又还是空的，文本为空。
- 会话表面推导 `tool/result` 时只取 `data.message`（`dsh/core/session/src/surface.ts` `deriveEventMessage`），所以卡片 payload 和 stateDelta 不会出现在 `tool/result` 消息里。stateDelta 折成 `lyteboatState` 之后，以 `lyteboat:state` runtime context 的形式发给模型（seq 17，§4.8）；卡片 payload 模型永远看不到，模型只写卡片标记。
- stdout 由 `a2ui.turnParts` 从这一轮的日志区间排出来：它按日志顺序读区间里人类消息上的判定卡片、`tool/result` 的 `meta.lyteboat.cards` 和每一步的助手文本，按出卡模式和标记排好（`lyteboat/plugins/a2ui/src/index.ts`），`lyteboat try` 再把卡片打成 `[card <区域>]` 行（`lyteboat/bundles/try/src/index.ts` `renderTurn`）。它只读日志，不写任何东西。

### 3.2 对应的会话日志片段

日志在 `$LYTEBOAT_HOME/sessions/<编码后的 cwd>/session-<uuid>/session.v4.jsonl.zstd`（带 `--agent` 时 cwd 是 agent 的工作目录 `$LYTEBOAT_HOME/agent-workdirs/<id>`），每次持久写入追加一个 zstd 帧。`@lyteboat/testing/session-log` 的 `readSessionLog` 读文件并逐帧解码（`lyteboat/tooling/testing/src/session-log.ts` `decodeSessionLog`、`readSessionLog`，帧扫描在 `scanZstdFrames`）。第一行是会话头，其中 `"agentPreset":"policy-desk"`。下面是 §2.13 第一次运行的关键记录，已裁剪（去掉 `time`，长字段和 id 用 `…` 代替；`deepseek-flash` 是 dsh-base 配置的默认模型 id）：

```jsonl
{"type":"lyteboat/aux-llm-call","seq":3,"data":{"purpose":"skill-router","route":{"provider":"deepseek-official","model":"deepseek-flash"},"system":"你是一个 skill 路…","prompt":"<task>…</task>…<latest_user_input>保单 P-1001 还有效吗</latest_user_input>…","maxTokens":200,"temperature":0,"output":"{\"skill_id\":\"policy-lookup\",\"reason\":\"保单类\"}","durationMs":58},"ignorable":true}
{"type":"user/message","seq":6,"data":{"content":[{"type":"text","text":"保单 P-1001 还有效吗"}],"source":{"kind":"user","lyteboatRequest":{"owner":{"kind":"operator","id":"cli"},"agent":{"id":"policy-desk","digest":"sha256:…"},"intake":{"decision":"pass","by":"policy-desk-intake"}}},"role":"user","id":"…"},"surfaceOp":"append"}
{"type":"user/message","seq":7,"data":{"content":[{"type":"text","text":"<skill_content name=\"policy-lookup\">\n…\n</skill_content>"}],"source":{"kind":"skill-invocation","name":"policy-lookup","form":"instructions"},"role":"user","id":"…"},"surfaceOp":"append"}
{"type":"request/header","seq":9,"data":{"header":{"config":{"provider":"deepseek-official","model":"deepseek-flash","maxTokens":256000,"reasoningEffort":"high"},"adapterDefaults":{"reasoningEffort":true,"maxTokens":true},"tools":"<3 tools>"},"reason":"initial"}}
{"type":"tool/call","seq":13,"data":{"turn":1,"step":1,"callId":"call-query_policy","name":"query_policy","arguments":"{\"policy_no\":\"P-1001\"}"}}
{"type":"tool/result","seq":14,"data":{"turn":1,"step":1,"message":{"role":"tool","source":{"kind":"tool","callId":"call-query_policy"},"toolCallId":"call-query_policy","content":[{"type":"text","text":"status=ok · [卡片:保单/active] 安心医疗保险 · 保额2000000.00元 · 保障至2026-12-31 · 下次缴费2026-12-01 · 卡前一句，[[card:policy_card]] 单独一行，卡后一句简短收尾（≤25字），不复述卡内数字"}],"isError":false,"id":"…"},"meta":{"lyteboat":{"cards":[{"surfaceId":"policy_card-session--33e585","area":"policy_card","emission":"deferred","payload":{"event":"beginRendering","version":"1.0.0","surfaceId":"policy_card-session--33e585","rootComponentId":"root","showType":"card","components":"<7 components>","businessPayload":"…"}}],"stateDelta":{"policy_desk.current":{"policy_no":"P-1001","product":"安心医疗保险","status":"active","sum_insured":"2000000.00","end_date":"2026-12-31","next_due":"2026-12-01"}}}}},"sourceEventSeqs":[13],"surfaceOp":"append"}
{"type":"user/message","seq":17,"data":{"content":[{"type":"text","text":"Current runtime context. This …"}],"source":{"kind":"runtime-context","form":"snapshot","sections":[{"name":"lyteboat:state","text":"…"}]},"role":"user","id":"…"},"surfaceOp":"append"}
{"type":"turn/end","seq":20,"data":{"turn":1,"reason":{"kind":"completed"}}}
```


seq 17 里 `lyteboat:state` 那一节的原文是：

```text
Session state, accumulated from tool results (JSON):
{"policy_desk":{"current":{"policy_no":"P-1001","product":"安心医疗保险","status":"active","sum_insured":"2000000.00","end_date":"2026-12-31","next_due":"2026-12-01"}}}
```

delta 的键 `policy_desk.current` 是点路径：它被展开成嵌套对象，嵌套对象深度合并，其他值直接替换（`lyteboat/plugins/tool-policy/src/state.ts` `deepMerge`、`assignPath`、`mergeStateDelta`）。状态键加上 agent 前缀，是因为 `lyteboatState` 由整个会话的所有工具共享。

日志里 lyteboat 自己的节点只有 seq 3 一条 `lyteboat/aux-llm-call`，而且它带 `"ignorable":true`：dsh 的持久化层不认识这个类型，按标记跳过它，照样能重开这个会话（`CLAUDE.md`「Architecture boundaries」的 A new session event type is proven reopenable 一条，§4.10）。准入判定、路由到的技能、卡片、状态增量都骑在 dsh 已有的记录上。

每条记录是谁写的：

| seq | 事件 | 写入方 |
|---|---|---|
| 0–2 | `agent/inbox/spliced`、`turn/start`、`agent/inbox/spliced` | 内核：`followup` 入收件箱、开轮次、认领 |
| 3 | `lyteboat/aux-llm-call` | aux-llm，为 skill-router 的路由调用记账（`lyteboat/plugins/aux-llm/src/index.ts` `AuxLlmService.generate`；调用方 `skill-router/src/index.ts` `SkillRouterService.decide`） |
| 5 | `system/message` | persona 段，本步第一次请求前写入；业务底座不加宿主 persona 和 harness 身份段，本例的系统 prompt 就是 persona 那一行 |
| 6 | `user/message`（任务） | `intakeGuard.submit` 用 `requestContext.message(...)` 写成，`source.lyteboatRequest` 带着发起者 `owner` 和准入判定 `intake`（`lyteboat/plugins/intake-guard/src/index.ts`，`lyteboat/plugins/request-context/src/index.ts`） |
| 7 | `user/message`（skill-invocation） | skill-router 在 `agent/pre-step` 里追加（`skill-router/src/index.ts` `invocationMessage`、`SkillRouterService`） |
| 8 | `user/message`（skill-catalog） | dsh-tool-skill 的技能目录（上游 `packages/skill/tool-skill/src/index.ts:272`） |
| 9–10 | `request/header`、`request/context` | 内核 `buildRequest`；`request/header` 的 `reason` 是 `initial` |
| 11 | `session/title` | dsh 标题插件的回退标题（`source.kind` 为 `fallback`），与本 agent 无关；业务底座关掉了标题的旁路请求，所以后面没有 `session/title-llm-request` |
| 12–13 | `assistant/message`、`tool/call` | 内核 |
| 14 | `tool/result` | 内核写入。文本来自 `render`，`meta.lyteboat.cards` 来自工具的 `presentationMeta`（`cardsPresentationMeta`），`meta.lyteboat.stateDelta` 来自 tool-policy 的包装（`tool-policy/src/index.ts` `withStateDelta`） |
| 17 | `user/message`（runtime-context） | 只有 `lyteboat:state` 一节，由 `lyteboatState` 投影渲染（`tool-policy/src/index.ts` `ToolPolicyService`，`state.ts` `renderLyteboatState`） |
| 20 | `turn/end` | 内核 |

第二次运行（电子保单）里，`send_policy_copy` 照常执行：seq 14 的 `tool/result` 文本是 `status=queued · 电子保单 P-1001`，`isError` 为 `false`，没有 `meta`。它不出卡，也不写状态，所以第 2 步没有追加 runtime-context 消息。

第三次运行（荐股）的人类消息把发起者、agent 的身份和整份判定带在身上：`"source":{"kind":"user","lyteboatRequest":{"owner":{"kind":"operator","id":"cli"},"agent":{"id":"policy-desk","digest":"sha256:…"},"intake":{"decision":"reply","verdict":"out_of_scope","text":"抱歉，我只负责保单查询，不提供股票买卖建议。","by":"policy-desk-intake"}}}`；紧跟着的助手消息 `source` 是 `{"kind":"model","provider":"lyteboat","model":"policy-desk-intake"}`。

### 3.3 `auto` 工具的可见性

```mermaid
stateDiagram-v2
    state "对模型隐藏（在 deny 列表里）" as Hidden
    state "对模型可见" as Visible
    [*] --> Hidden: register 时 visibility auto
    Hidden --> Visible: 路由到 policy-lookup，activate(requiredTools)，本步生效
    Hidden --> Visible: 模型调用 skill 工具加载技能，下一步生效
    Hidden --> Visible: 续聊时从日志折出当前技能，新一轮第一步生效
    Hidden --> Visible: 插件在 lyteboat/pre-assemble 里 activate
    Visible --> Visible: 路由决策为 null、超时或出错，保持当前技能
    Visible --> Hidden: 切到另一个技能，clear 后只激活新技能的工具
```

「当前技能」只有一个来源：`lyteboatActiveSkill` 投影从日志里折出来的值。它认两种记录：路由器放进步骤的技能调用消息，以及一次成功的 `skill` 工具调用（`lyteboat/plugins/skill-router/src/index.ts` `lyteboatActiveSkillProjectionDefinition`）。skill-router 每次组装前都从这个投影读当前技能（`SkillRouterService.activeOf`、`SkillRouterService.prepare`），所以新进程里续聊的会话也能拿回它的技能和工具（§4.10）。技能有两条激活路径：

- **路由器选中**：在 `lyteboat/pre-assemble` 里、`next()` 之前完成，本步的请求就能看到工具，正文在同一步的 `agent/pre-step` 进来（§3.1）。
- **模型自己加载**：dynamic 模式下，业务底座给 agent 留下的 dsh 工具就是 `skill`。路由器没选中时（决策为 `null`、超时或出错），模型可以调用 `skill({ name: 'policy-lookup' })` 读技能正文。投影先记下这次调用要加载的技能，等它的 `tool/result` 成功回来，才把它当成当前技能（`index.ts` `lyteboatActiveSkillProjectionDefinition.apply`）。下一步是工具之后的续步，没有新的用户输入，不做路由，skill-router 直接激活当前技能的 `requiredTools`（`SkillRouterService.applyActive`）；正文已经在那次 `tool/result` 里，不重复追加。所以工具从下一步起可见。只在 `mode: dynamic` 下这样处理。

**两次请求之间工具集变了，dsh 怎么告诉模型。** 模型自己加载技能的这条路径上，第 1 步的请求只有 `skill` 1 个工具，第 2 步有 3 个：同一轮里两次请求之间工具集变了。dsh 为此在第 2 步写一条新的 `request/header`（`reason` 为 `change`），紧跟一条 `developer/message`：`source` 为 `{ kind: 'tool-registry' }`，内容是每个新增工具一块 `tool-addition`（移除的工具是 `tool-removal`），`headerSeq` 指向那条 `request/header`。dsh-base 默认的 `deepseek-flash` 路由声明了 `toolUpdate: 'addition-only'`（上游 `packages/llm/llm-deepseek/src/models.ts:7-14`），在这样的路由上工具变化不另起一个请求系列：新可见的工具在请求里以 `defer_loading` 声明，并由一条 system 消息里的 `tool_addition` 块宣告。续聊时切换技能也走同一套：金融智能体的组合测试断言了它（`examples/agents/finance/tests/finance.composite.ts`）；G4 在官方树和 lyteboat 树上比较了会话中途换工具集的场景（`dsh-compat/tests/scenarios/scenarios.ts`）。

实测：脚本让路由器永远回 `null`，loop 先调 `skill`，再在工具出现后调 `query_policy`（任务「看看 P-1001」；脚本是 §2.13 那份，只换了应答函数，在 `model requests` 里标出每个 loop 请求带几个工具，`tool/result` 一行打印结果文本的开头）。输出（部分记录略去）：

```text
exit=0 stdout="SCRIPTED-ANSWER\n[card policy_card]\n"
stderr="lyteboat: session session-1a2af7a3-c39c-45e0-a55f-d935de2447bb\n"
model requests: router, loop(1), loop(3), loop(3)
 ...
  3 lyteboat/aux-llm-call      ignorable=true purpose=skill-router output={"skill_id":null,"reason":"无"}
 ...
  7 user/message               source=skill-catalog
  8 request/header             tools=1 reason=initial
  9 request/context
 10 session/title
 11 assistant/message          provider=deepseek-official tool-call
 12 tool/call                  skill {"name":"policy-lookup"}
 13 tool/result                isError=false <skill_content name="policy-lookup"> <sk …
 14 step/end
 15 step/start
 16 request/header             tools=3 reason=change
 17 developer/message          source=tool-registry tool-addition:query_policy tool-addition:send_policy_copy
 18 assistant/message          provider=deepseek-official tool-call
 19 tool/call                  query_policy {"policy_no":"P-1001"}
 20 tool/result                isError=false status=ok · [卡片:保单/active] 安心医疗保险 · 保额20 …
 21 step/end
 22 step/start
 23 user/message               source=runtime-context
 24 assistant/message          provider=deepseek-official text
 25 step/end
 26 turn/end                   completed
```

第 2 步请求里的这两件事，从脚本模型记录的请求里读出来是这样（第 3 步的请求相同）：

```text
defer_loading 的工具：["query_policy","send_policy_copy"]
system 消息：[{"role":"system","content":[{"type":"tool_addition","tool":{"type":"tool_reference","name":"query_policy"}},{"type":"tool_addition","tool":{"type":"tool_reference","name":"send_policy_copy"}}]}]
```

`skill` 那一步之后，日志里没有任何 lyteboat 记录，也没有新的技能调用消息。这次的回答没有写卡片标记，所以 `deferred` 的保单卡跟在回答后面（stdout 第二行）。

其他依据：`activate` / `clear` 在 `lyteboat/plugins/tool-policy/src/index.ts`；路由的粘滞规则在 `lyteboat/plugins/skill-router/src/router.ts` `resolveRouteDecision` 和 `src/index.ts` `SkillRouterService.route`、`SkillRouterService.decide`；「替换而不是累加」在 `src/index.ts` `SkillRouterService.activateTools`。「你好」那次运行，路由记录的 `output` 是 `{"skill_id":null,"reason":"寒暄"}`，模型也没加载技能，日志里没有技能调用消息，请求里只有 `skill`（组合测试第二个用例断言了这一点）：

```text
exit=0 stdout="SCRIPTED-ANSWER\n"
stderr="lyteboat: session session-3c81e824-3505-463d-b867-2a0ef7422065\n"
model requests: router, loop
  0 agent/inbox/spliced
  1 turn/start
  2 agent/inbox/spliced
  3 lyteboat/aux-llm-call      ignorable=true purpose=skill-router output={"skill_id":null,"reason":"寒暄"}
  4 step/start
  5 system/message
  6 user/message               source=user intake=pass
  7 user/message               source=skill-catalog
  8 request/header             tools=1 reason=initial
  9 request/context
 10 session/title
 11 assistant/message          provider=deepseek-official text
 12 step/end
 13 turn/end                   completed
```

---

## 4. 设计要点与约束

### 4.1 参考实现的 agent 设计原则同样适用

`CLAUDE.md`「Agent design」要求设计、评审或移植 agent 之前先读参考实现的 `docs/agent_design_principles.md`：原则不变，只是机制换了。

| 设计原则 | 在 policy-desk 里的落点 |
|---|---|
| L1 只放身份、红线、节奏（§2） | persona 只有两句；「不荐股」这种硬红线写成准入函数，在请求进入循环之前确定地执行，不交给模型 |
| description = WHAT + WHEN + 关键词 + 邻居边界（§3） | `policy-lookup` 的 description 写了「理赔进度、产品推荐、投资建议不归此」 |
| `required_tools` 与正文完全一致（§3） | `requiredTools: [query_policy, send_policy_copy]`，正文恰好用到这两个 |
| 工具要薄，digest 是回传信道（§4） | `query_policy` 只做取参、查 L4、组 digest；失败给降级 digest |
| 超集工具，一次把状态落齐（§4） | 一次调用同时写状态、出卡 |
| 业务阈值、常量都在 L4（§5） | 状态文案在 manifest 的 `switch` 里，金额格式在 `compute.js`，数据校验和状态摘要在 `policies.ts`，都不在 SKILL 正文里 |
| 终态工具要 `always`（§4） | lyteboat 的 `render_a2ui` 默认 `always`，`terminalCards` 里的卡调用 `exec.concludeTurn()`（`lyteboat/plugins/a2ui/src/index.ts` `A2uiService.registerRenderTool`）；业务工具自己结束本轮也用 `exec.concludeTurn()`，金融智能体的未授权卡就是这样（`examples/agents/finance/src/tools/finance-tool-support.ts` `unauthorizedResult`） |
| 改 prompt 要有 eval 数据（§8） | `CLAUDE.md`「Agent design」：没有 eval 数据的 prompt 改动是 working hypothesis，提交信息要写明（§2.17 的示例） |

### 4.2 业务词汇只出现在 `examples/agents/`

`lyteboat/bundles/*`、`lyteboat/plugins/*`、`lyteboat/core/*` 必须领域中立：persona、保单、资产分桶、中文产品文案都只能放在 `examples/agents/*`（`CLAUDE.md`「Architecture boundaries」的 Framework packages stay domain-neutral 一条）。a2ui 的默认组件目录也因此只收领域中立的组件（§2.9）。如果你发现需要改插件才能表达某条业务规则，先确认它是不是其实属于 L4，写在 agent 自己的 `src/` 里就行。准入函数也一样：「什么请求不接」是业务规则，写在 agent 里，intake-guard 只负责调用它、记下判定。需要新的框架能力，就按「内核之外优先」走设计流程（同一节的 Outside the kernel first 一条）。

### 4.3 技能命名与元数据

名字必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（`dsh/skill/skill/src/index.ts` `SKILL_NAME`）。从参考实现迁过来的下划线 id 要改名（`CLAUDE.md`「Agent design」）。不合法的名字**不会报错**：skill-filesystem 只打一条 warn，然后忽略这个文件（上游 `packages/skill/skill-filesystem/src/index.ts:820-822`；缺 `name` 或 `description` 时同样只 warn，见 `:816-818`），而 `lyteboat try` 默认不打印 warn（§6）。实测把 `name` 改成 `policy_lookup` 以后：退出码 0，stderr 只有 `lyteboat: session <id>` 那一行，**没有路由请求**（候选集为空），模型请求只有一个 `loop(1)`，工具只剩 `skill`。

元数据正相反：`metadata.lyteboat` 按严格 schema 校验，写错一个键不会被静默忽略，而是在路由到这个技能的那一步让运行失败（§4.9）。参考实现迁过来的 `group`、`version`、`tags` 要删掉，只留 `requiredTools`。

### 4.4 waterfall 监听器必须调用 `next()`

`lyteboat/intake`、`lyteboat/pre-assemble`、`tools/pre-execute`、`tools/post-execute` 都是 waterfall（`CLAUDE.md`「Architecture boundaries」的 Waterfall listeners MUST call `next()` 一条）。先注册的监听器在最外层；不调用 `next()` 的监听器会把后面的全部挡掉，连默认行为也挡掉（上游 `vendor/cordis/src/events.ts:224-243`）。一个行的 `lyteboat/intake` 监听返回 `{kind:'pass'}` 却不调 `next()`，排在它里面的拒识门就永远不会执行；intake-guard 在它外面，`next()` 返回后照样按记录的判定作答（§2.11）。

`next()` 的前后要有意识地选：

- 需要让同一步里后面的监听器看到的工作，放在 `await next()` **之前**。skill-router 就是在之前路由的。
- 对账、收尾放在**之后**。tool-policy 等所有人激活完才重算限制（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService`）。
- 在 `lyteboat/pre-assemble` 里激活工具的写法：`ctx.on('lyteboat/pre-assemble', async (payload, next) => { ctx.toolPolicy.activate(payload.agent, ['x']); return next() })`（参照 `lyteboat/bundles/try/tests/fixtures/plugins/tools.mjs` `apply`；这样的插件要 `inject: ['lyteboatDistro']`，见同文件的 `inject`）。激活一直有效，直到 `clear(agent)`，或者下一次技能激活把它替换掉（`tool-policy/src/index.ts` `ToolPolicyService.activate`、`ToolPolicyService.clear`，`skill-router/src/index.ts` `SkillRouterService.activateTools`）。路由关闭（`mode: off`）时没有人调 `clear`，一次激活管整个会话。

### 4.5 prompt 顺序号

runtime context（每步作为 user 消息追加）和 system prompt 段是**两个独立的序号空间**：

| 类别 | 名字 | 序号 | 出处 |
|---|---|---|---|
| context | `SANDBOX_POLICY` / `APPROVAL_POLICY` / `SUBAGENT_DELEGATION` | 110 / 115 / 120 | `dsh/core/system-prompt/src/index.ts` `CONTEXT_ORDERS`；业务模式里写这三段的行（沙箱、审批、子 agent）都被业务底座关掉了 |
| context | `lyteboat:state` | 130 | `LYTEBOAT_STATE_CONTEXT_ORDER`，`lyteboat/core/contracts/src/index.ts` |
| section | `HARNESS_IDENTITY` / persona 前缀 | -1000 / 0 | `dsh/core/system-prompt/src/index.ts` `SECTION_ORDERS`；业务底座把 `system-prompt` 行配成 `includeHarnessIdentity: false`、`personaPrefix: ''`，业务模式里没有 harness 身份段，persona 前缀只来自 agent 自己的 persona 行 |
| section | `lyteboat:skills`（仅 full 模式） | 450 | `LYTEBOAT_SKILLS_SECTION_ORDER`，`lyteboat/core/contracts/src/index.ts` |
| section | `PLAN_POLICY` … persona 后缀 | 500 … 10200 | `dsh/core/system-prompt/src/index.ts` `SECTION_ORDERS` |

新的 prompt 文本要相对这些值选序号，并在 contracts 里登记成常量（`CLAUDE.md`「Agent design」）。dynamic 模式下路由到的技能正文不占序号：它是一条技能调用消息，不是段，也不是 runtime context（§3.1）。persona 行设 `includeRuntimeContext: false` 会压掉这个作用域里**所有**的 runtime context 快照，`lyteboat:state` 也在内（上游 `packages/preset/persona/src/index.ts:44-45`、`:74`）；技能调用消息不是快照，不受它影响。

### 4.6 agent 行不向根 realm 发布服务

agent 行只能声明、注册（工具、准入函数）、监听。实测一个行调用 `ctx.provide('helloService', …)`，启动时报 `lyteboat: Preset services require isolate realms: helloService`，退出码 1（上游 `packages/preset/agent-preset-registry/src/mount.ts:267`；`CLAUDE.md`「Architecture boundaries」的 Composition is data 一条）。需要跨 agent 共享的能力，应该做成 `lyteboat/plugins/*` 里的宿主服务，由 `@lyteboat/host` 发布。

同理，工具要注册在 preset 的常驻作用域里（也就是你的行里），不能注册到 `agent.ctx` 上：`auto` 工具如果在 agent 自己那一层，`restrict()` 藏不住它，tool-policy 会抛错（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService.reconcile`）。按实例的状态放进 `WeakMap<Agent, …>`，或者挂在作用域的 disposer 上，不要用模块级 Map（`CLAUDE.md`「Architecture boundaries」的 Registrations are effects 一条）。准入函数同理：用 `ctx.intakeGuard.register` 登记在你的行里，它只管这个 agent 的会话，行卸载时一起撤销（`lyteboat/plugins/intake-guard/src/index.ts`）。

### 4.7 模型可见即已记录

凡是进了模型请求的内容，都必须能从会话日志重建（`CLAUDE.md`「Architecture boundaries」的 Model-visible ⟺ logged 一条）。内核为此定义了一条不变式：loop 构建的请求，其 messages 必须等于派发时的 `deriveMessages()`，模型、工具等配置必须等于折叠后的 `request/header`（`dsh/core/agent-loop/src/invariant.ts` `install`）。对 agent 作者来说，这意味着：

- 给模型的东西，只能走日志里有的渠道：工具 `render` 的文本（进 `tool/result.message`）、runtime context（`lyteboatState` 由 `tool/result.meta` 折叠而来）、技能调用消息（路由到的技能正文本身就是日志里的一条 user 消息）、persona 段（进 `system/message`）、准入回复（一条助手消息）、工具集的变化（`request/header` 加 `developer/message`，§3.3）。
- 旁路调用也是一次模型请求，只是不进 loop：它的 system、prompt 和回答都记在那条 `lyteboat/aux-llm-call` 里（§3.2 的 seq 6）。agent 自己的旁路调用走 `ctx.auxLlm`，就自动有这份记录。
- 不要在工具外面偷偷改 prompt，也不要用只存在于进程内存里的数据拼 prompt。
- 想记录新的事实，先用已有的 envelope（`tool/result.meta`、助手消息的 `source`、人类消息的 `source`：请求上下文和准入判定就在这里）。只供审计、读者跳过也不影响重建会话的记录，可以用内核扩展 `session-append-ignorable` 追加成可忽略的（`Session.append(type, data, { ignorable: true })`，`lyteboat/aux-llm-call` 就是这样）；读者需要的事实绝不能放在可忽略的记录上。新的日志节点要登记在 contracts 里，并证明会话能持久化后重开（`CLAUDE.md`「Architecture boundaries」的 A new session event type is proven reopenable 一条）。`@lyteboat/testing/session-reopen` 的 `reopenRefusal` 就是这个证明用的检查（§2.15）。

### 4.8 状态对模型可见

整个 `lyteboatState` 每一步都会作为 `lyteboat:state` 发给模型（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService`），而每条状态增量又原样留在日志的 `tool/result.meta.lyteboat.stateDelta` 里。所以 delta 要小、不带个人信息，这也是 `policySummary` 只保留六个字段的原因。卡片要用的完整数据直接传给 `renderCard`，不必进状态。

请求上下文正相反：它原样记在人类消息的 `source` 上，`lyteboatRequest` 投影保存它，但它不发给模型（`lyteboat/plugins/request-context/src/index.ts`）。工具需要时用 `ctx.requestContext.contextOf(exec.agent)` 读，只把回答需要的那部分写进结果。

### 4.9 失败要响亮，降级要记录

配置错误在加载时或最早能解析的时候就要抛错（`CLAUDE.md`「Coding conventions」的 Misconfiguration fails loud 一条）。lyteboat 里现成的例子，下面每一条都实测过，输出见 §6：

- `@lyteboat/tool-policy/agent` 声明了一个没有任何行注册的工具：第一步就失败退出（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService.reconcile`）。`activate` 一个未声明的名字，同样抛错。这一行或某个工具的策略里写了未知的键（例如去掉了的 `undeclared`、`requiresConfirmation`）：加载时就失败，这个 agent 挂不上（`lyteboat/plugins/tool-policy/src/agent.ts` `apply`）。
- 技能的 `requiredTools` 列了一个 tool-policy 没有为这个 agent 声明的工具，或者 `metadata.lyteboat` 带了未知键：路由到这个技能的那一步失败退出（`lyteboat/plugins/skill-router/src/index.ts` `lyteboatSkillMeta`、`SkillRouterService.activateTools`）。
- `stateDelta` 返回非对象或坏路径：工具调用之后运行失败（§2.10）。
- 卡片的 manifest 写了未知的 `emission_mode`，或者 `compute.js` 只有默认导出：这张卡加载失败，`renderCard` 抛错，工具调用以错误结束（`lyteboat/plugins/a2ui/src/loader.ts` `emissionModeOf`、`loadCompute`）。这一条不让整次运行失败，模型读到错误文本后照常作答。

设计上接受的降级只打 warn：路由调用超时或失败时保持当前技能（原因同时记在那条 `lyteboat/aux-llm-call` 的 `failure` 里，`lyteboat/plugins/aux-llm/src/index.ts` `recordOf`）、manifest 取值失败（`renderCard` 把警告打成 warn）。这些 warn 在 `lyteboat try` 里默认看不到，§6 讲怎么打开。

### 4.10 续聊：`--session-id`

每次 `lyteboat try` 都把 `lyteboat: session <id>` 打到 stderr。下一次运行加上 `--session-id <id>`，就在这个会话上接着聊：

```sh
node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent policy-desk "保单 P-1001 还有效吗"
# stderr：lyteboat: session session-…
node lyteboat/apps/cli/lib/bin.js try --agents ./examples/agents --agent policy-desk --session-id session-… "那什么时候到期"
```

**为什么路由过的会话能重开。** dsh 的持久化层拒绝重开带着它不认识的事件类型的日志，除非那条事件标了 `ignorable`（`CLAUDE.md`「Architecture boundaries」的 A new session event type is proven reopenable 一条）。policy-desk 的日志里，lyteboat 的每个事实都骑在 dsh 已有的记录上：路由到的技能是 dsh 的技能调用消息，请求上下文和准入判定在人类消息的 `source` 上，卡片和状态增量在 `tool/result.meta` 上，准入回复是一条普通的助手消息。lyteboat 自己的类型只有 `lyteboat/aux-llm-call`，它由内核扩展 `session-append-ignorable` 写成可忽略的（`dsh/core/session/src/lyteboat/append-ignorable.ts`，登记在 `dsh-compat/contract/extensions.yml`）。组合测试的续聊用例用 `reopenRefusal` 验证了这一点（§2.15）。

**续上以后发生什么。** runner 不新建会话，而是先核对日志，再用 `agents.resume` 从日志恢复它（`lyteboat/bundles/try/src/index.ts` `resumeAgent`）；dsh 在日志末尾写一条续接标记 `session/end-seed`（`dsh/core/session/src/index.ts` `Session`），新一轮第一次请求的 `request/header` 的 `reason` 是 `resume`。新一轮开始时，各个投影从日志重新折叠：

- `lyteboatActiveSkill` 折出上一轮的技能，路由器把它当作 `<current_active_skill>`；这一轮的输入是没有主语的追问时保持它，`requiredTools` 在第一步就重新激活（§3.3）。
- 技能正文还在上一轮的消息里，所以不重复追加（`lyteboat/plugins/skill-router/src/index.ts` `SkillRouterService.applyActive`）。
- `lyteboatState` 还是上一轮的状态，模型照样看得到；`lyteboatRequest` 保存着上一轮的请求上下文，这一轮不带 `--context` 就沿用它。
- 新的请求照样先过准入。

实测：用 §2.13 的脚本先跑一次「保单 P-1001 还有效吗」，再把 `ROOT` 设为它打出的 `root:`、`SESSION` 设为它 stderr 里的会话 id，跑第二轮：

```sh
ROOT=<第一次打出的 root> SESSION=session-… TASK='那什么时候到期' bash $SCRATCH/policy-desk-try.sh
```

```text
exit=0 stdout="SCRIPTED-ANSWER\n"
stderr="lyteboat: session session-4310e5d6-d0c7-4bc3-a1cd-ca2c1543c4fb\n"
model requests: router, loop
 ...
 20 turn/end                   completed
 21 session/end-seed
 22 agent/inbox/spliced
 23 turn/start
 24 agent/inbox/spliced
 25 lyteboat/aux-llm-call      ignorable=true purpose=skill-router output={"skill_id":null,"reason":"寒暄"}
 26 step/start
 27 user/message               source=user intake=pass
 28 request/header             tools=3 reason=resume
 29 assistant/message          provider=deepseek-official text
 30 step/end
 31 turn/end                   completed
```

同一个会话 id，同一份日志接着往下写。路由器回了 `null`，技能保持 `policy-lookup`，所以 seq 28 的请求带着 3 个工具；这一轮没有新的技能调用消息；状态没变，也没有新的 runtime-context 消息；模型请求里也没有标题请求。组合测试的第五个用例断言了其中的路由、工具、状态和正文不重复（§2.15）。

**续聊的前提**（`lyteboat/bundles/try/src/index.ts` `assertContinuable`、`resumeAgent`，`lyteboat/bundles/try/src/startup.ts` `apply`），每一条都实测过：

- 同一个 `$LYTEBOAT_HOME`，会话就存在它下面。id 不存在时退出 1：`lyteboat: session "session-nope" does not exist; omit --session-id to start a new session`。
- 同一个 agent。换了 `--agent` 时退出 1：`lyteboat: session "<id>" runs under agent "policy-desk"; continue it with --agent policy-desk`。
- 同一个工作目录。会话头记着录制时的 `cwd`，对不上时退出 1：`lyteboat: session "<id>" was recorded in "<录制时的目录>", not "<这次运行的目录>"`。带 `--agent` 时两边都是 agent 在这个 home 下的工作目录（`$LYTEBOAT_HOME/agent-workdirs/<id>`），所以从哪个目录续都行，只有搬了 home 才会碰上；不带 agent 的会话要回到启动它的目录。
- 不和 `--history` 同给，否则按用法错误退出：`error: --history seeds a new session; it cannot be combined with --session-id`。
- 子 agent 或 fork 出来的会话不能直接续（`index.ts` `assertContinuable`）。

`/chat` 和评测的会话也记在 agent 的工作目录下，所以同一个 home 里，`lyteboat try --agent <id> --session-id` 能续这个 agent 的任何会话，包括别人经 `/chat` 建的：命令行是操作者的入口，不核对发起者。只是这个会话正被运行中的 serve 占着时续不了（`session "…" is already owned by an active write handle`，退出 1），要等 serve 停了再续；续上的消息记的发起者是 `operator:cli`，会话的主人仍是第一条消息的。反过来不行：`/chat` 只续同一个 `user_id` 发起的会话（§4.13）。`lyteboat web` 在 dsh web 里建的会话，就在 dsh web 里接着发（§4.15）。

### 4.11 业务模式：要什么就声明什么

`lyteboat try`、`serve`、`eval` 三种业务模式都在 `@lyteboat/host` 之后列业务底座 `@lyteboat/business-base`（`lyteboat/bundles/business-base/cordis.patch.yml`），Studio 工作台（`lyteboat studio`）和 `lyteboat inspect` 也列它，所以它们看到的 agent 和这三种模式里的一样（§4.17、§4.18）。它关掉 dsh-base 的编码工具和只为它们服务的行（bash、文件工具、todo、goal、子 agent、PTC 与 workflow、web 工具等），关掉沙箱与审批、工作目录的 AGENTS.md、本机插件包清单和会话标题的旁路请求；skill-filesystem 不读宿主的默认目录；系统 prompt 不加宿主 persona 和 harness 身份段。所以业务 agent 从 dsh-base 只继承 `skill` 一个工具，别的都要在自己的 `agent.cordis.yml` 里声明。policy-desk 的实测：路由到技能后 loop 请求是 3 个工具（`query_policy send_policy_copy skill`），「你好」只有 `skill`；系统 prompt 就是 persona 那一行；第一步没有 runtime context（§2.13、§3.3）。

**要用 dsh 的工具，就在自己的组合里列它的行。** 行跑在 agent 的常驻作用域里，只管这个 agent 的会话。try 组合测试的夹具 agent 就这样带上 dsh 的 todo 工具（`lyteboat/bundles/try/tests/fixtures/agents/policy/agent.cordis.yml`）：

```yaml
- id: todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: false

- id: lyteboat-tool-policy
  name: '@lyteboat/tool-policy/agent'
  config:
    inherited: hidden
    tools:
      todo_write:
        visibility: always
```

- 自己的行注册的 dsh 工具，对 tool-policy 来说也是继承来的：它不经 `ctx.toolPolicy.register`，不算声明过。所以在 `inherited: hidden` 下它同样要写进 `tools:`，否则会被藏起来（上例写成 `always`）。写成 `auto`，它就要靠技能的 `requiredTools` 或 `lyteboat/pre-assemble` 里的 `activate` 才出现（`lyteboat/bundles/try/tests/fixtures/agents/routed/agent.cordis.yml` 这样写）。
- 要 web 搜索，就在自己的组合里列 `@deepseek-ai/dsh-tool-web` 一行：web 的服务行留在宿主上，模型看不到，工具行由 agent 自己带。
- `tools:` 点名了没有任何行注册的工具，第一步就失败；行或工具策略里写了未知键（例如去掉了的 `undeclared`、`requiresConfirmation`），加载时就失败（§4.9、§6）。dsh 升级时改了工具名，agent 会大声失败，这是有意为之。

**技能由 agent 自己挂。** 业务底座让 skill-filesystem 不读宿主的默认目录，业务模式里没有白来的技能。agent 在自己的行里用 dsh 的 skill-filesystem 挂上自己的 `skills/` 目录：policy-desk 在 `tools.ts` 里这样做（§2.10），`routed` 夹具用一个单独的行（`lyteboat/bundles/try/tests/fixtures/agents/routed/skills.mjs`）。

**`inherited: hidden` 还有什么用。** 业务模式里继承来的工具只有 `skill`，policy-desk 不写 `policy-desk-tool-surface` 这一行，工具面也一样。写上它，是为了别处加进来的工具不会露给这个 agent：同一个 agent 在 `lyteboat web` 里会继承 dsh 的全套编码工具（§4.15），一个 `--plugin` 文件或 `--patch` 也能往宿主上加工具行。

**persona 设 `complete: true`（可选）。** prefix 成为完整的系统 prompt，其余段全部不要（上游 `packages/preset/persona/src/index.ts:42-43`、`:67`；组装逻辑在 `dsh/core/system-prompt/src/index.ts` `SystemPrompt.assemble`）：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    complete: true
    prefix: 'You are POLICY-DESK-PERSONA, 一名保单查询助手。…'
```

业务模式里系统 prompt 本来就只剩 persona，外加 agent 自己带的 dsh 工具可能附上的使用说明；`complete` 把这些说明和 persona 后缀也去掉，在 `lyteboat web` 里还挡住 dsh 的 harness 身份段和编码工具的说明。金融智能体这样写（`examples/agents/finance/agent.cordis.yml`）。`lyteboat:state` 这类 runtime context 和路由进来的技能调用消息都是 user 消息，不是段，不受影响；但 `full` 路由模式靠 `lyteboat:skills` **段**（450）列技能，`complete` 会把它一起去掉，所以 `complete` 只和 `dynamic` 模式搭配。

**模型请求里还剩的宿主痕迹**（之后清掉，见 `docs/04-reference-alignment.md` 6.2）：

- dsh 的技能调用消息写着技能目录的绝对路径（`Base directory for this skill: <agents 根>/policy-desk/assets/skills/policy-lookup`，§3.2 的 seq 7）。
- compaction-basic 的摘要指令是按编码助手写的，会话长到要压缩时，模型会读到它。
- persona 里的 `{{cwd}}` 渲染成服务器上 agent 工作目录的绝对路径，业务 persona 不要用它。

另外，启动器仍会读它启动目录里的 `.env`（留给运维放部署配置）。

**本地试验时打开关掉的行。** 一个 `--plugin` 文件或社区插件如果注入业务底座关掉的服务（`shell`、`subprocess`、`approval`、`sandboxPolicy` 等），在业务模式里一直挂起（PENDING），不报错；本地试验时可以用 `--patch` 把那一行重新打开。上线的 agent 不要依赖这个：它要用的能力写进它自己的组合。

### 4.12 loop 模型从哪来

- **loop 模型不由 agent 决定。** `@lyteboat/try` 创建或恢复 Agent 时读一次 `agentDefaultModel.currentSelection()`，作为 `agentOptions` 的 provider 和 model 传进去（`lyteboat/bundles/try/src/index.ts` `run`）。preset 定义里没有模型字段（上游 `packages/preset/agent-preset-registry/src/types.ts`、`definition.ts` 里没有 `model`），所以一个进程里所有 agent 用同一个 loop 模型。
- **`agent.yml` 的 `model` 只用来核对。** agent 可以在清单里声明它评测和发布所用的模型（§1.3）。serve 和 eval 打开 agent-catalog 的 `enforceDeclaredModel`（`lyteboat/bundles/serve/cordis.patch.yml`、`lyteboat/bundles/eval/cordis.patch.yml`）：声明的 provider、model、`reasoningEffort` 和进程的默认模型有一项不同，这个 agent 就不声明，它的代码不会运行，报 `<id>: agent.yml declares model deepseek-official/deepseek-flash, but this process runs deepseek-official/deepseek-pro; run it with that default model (the agent-default-model row) or change agent.yml`（`lyteboat/plugins/agent-catalog/src/index.ts` `AgentCatalogService.modelProblem`）。serve 因此退出 1，eval 退出 2。try 和 `lyteboat web` 不查，所以在 try 里换一个默认模型试 agent 不会被拦住。没声明 `model` 的 agent 哪里都不查。
- **默认选择来自 dsh-base 的 `agent-default-model` 行。** 它的配置是 provider `deepseek-official` 加模型 id `deepseek-flash`；这些值是 volatile 配置（`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:82-86`，上游 `packages/core/agent-default-model/src/index.ts:23-31`）。业务模式（try、serve、eval）关掉了 settings 和 config-editor，所以要换模型，就在 profile patch 层或用 `--patch` 改这一行，不是在 agent 目录里改；`lyteboat web` 里 dsh settings 保存的选择优先。
- **访问凭据**是 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`（README「配置模型」）。脚本模型就是把 `DEEPSEEK_BASE_URL` 指到本地服务（`scriptedModelEnv`，§2.13）。
- **旁路调用默认用 agent 的模型。** `ctx.auxLlm.generate` 没给 `route` 时用 agent 的 provider 和 model（`lyteboat/plugins/aux-llm/src/index.ts` `routeOf`）。`@lyteboat/skill-router/agent` 的 `provider` + `model`（必须成对）只影响路由的旁路调用，给了才作为 `route` 传过去（`lyteboat/plugins/skill-router/src/index.ts`）。§3.2 的 `lyteboat/aux-llm-call` 记录了这次调用实际用的 `route`。
- **旁路调用的输出预算和推理强度。** 路由调用的 `maxTokens` 由 skill-router 的 `maxTokens` 设置决定，默认 200，宿主行和 agent 行都能改（§1.3）。宿主的 `lyteboat-aux-llm` 行有一个 `reasoningEffort` 配置，所有旁路调用都按它请求推理强度，取值由路由的模型适配器定义；没配时用路由自己的默认强度。DeepSeek 默认先思考再作答，思考同样计入这次调用的 `maxTokens`，而答案在 `maxTokens` 处被截断算失败（`failure.reason` 为 `max-tokens`）。要改就用一层 patch 给这一行配上（`lyteboat/plugins/aux-llm/src/index.ts` `Config`，README「配置模型」）。

### 4.13 经 `/chat` 调用 agent：`lyteboat serve`

`lyteboat serve` 用 `serve` profile（dsh-base + `@lyteboat/host` + `@lyteboat/business-base` + `@lyteboat/serve`，`lyteboat/apps/cli/src/templates.ts`）起一个常驻服务，agent 拿到的和 `lyteboat try` 里一样，只有它声明的（§4.11）：`@lyteboat/agent-catalog` 把每个 `--agents` 目录（可重复）里的 agent 都声明成 preset（或者换成 `--release <锁>`，只声明发布过的 agent 并按锁钉住，§4.16），dsh 的 session-controller 不带 Web 界面挂上，`@lyteboat/chat-api` 在 dsh 的 host-webserver 上提供 `POST /chat`、`GET /agents`、`GET /health`（`lyteboat/bundles/serve/cordis.patch.yml`）。默认监听 `127.0.0.1:8080`、不鉴权；`--host 0.0.0.0` 必须配 `--auth shared-secret`，密钥放在 `--secret-env` 指定的环境变量里（默认 `LYTEBOAT_CHAT_SECRET`），调用方带 `Authorization: Bearer <密钥>`（`lyteboat/bundles/serve/src/startup.ts` `command`、`apply`）。agent 在 `agent.yml` 里声明了模型的，必须和进程的默认模型一致，否则声明失败、服务退出 1（§4.12）。新会话的工作目录是 agent 的工作目录 `$LYTEBOAT_HOME/agent-workdirs/<id>`，和 `lyteboat try --agent`、`lyteboat eval` 的会话在一处，与服务从哪个目录启动无关。有 agent 挂不上时进程退出 1，都挂上了就在 stdout 打一行 `lyteboat serve: http://127.0.0.1:8080/chat (agents: …)`（`lyteboat/bundles/serve/src/index.ts` `apply`）。serve 还挂着运行指标的记录器：每轮结束后往 `$LYTEBOAT_HOME/run-metrics/<UTC 日期>.jsonl` 追加一行（用时、首字时间、步数、工具与技能、结局、发起者），不进模型请求也不进会话日志，Studio 的看板读它（§4.17）。模型的访问方式和 `lyteboat try` 相同（§4.12；不用 key 时照 §2.13 指向脚本模型）。起服务，再发一条消息：

```sh
node lyteboat/apps/cli/lib/bin.js serve --agents ./examples/agents
curl -s http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"agent_id":"finance","user_id":"u-1","message":"看看我的资产","context":{"customer":"young-idle-cash"}}'
```

请求体（`lyteboat/plugins/chat-api/src/chat-request.ts` `chatRequestSchema`，多出的字段直接 400）：

| 字段 | 说明 |
|---|---|
| `agent_id`（必填） | agent 的 id，即目录名；`--agents` 里没有就 404 |
| `user_id`（必填） | 调用方认定的用户，记成请求的发起者 `owner: { kind: 'user', id: <user_id> }`；会话属于第一次创建它的用户 |
| `message`（必填） | 这句话，不能是空白 |
| `session_id` | 续聊已有的会话；不给就为 `agent_id` 新建一个。不是这个 `user_id` 经 `/chat` 发起的会话（别的用户的，操作者在 `lyteboat web` 或命令行建的，评测建的，没记发起者的）一律按不存在处理（404，`lyteboat/plugins/chat-api/src/chat-session-owner.ts`），会话属于另一个 agent 时 409 |
| `message_id` | 这条消息的 id，记成请求的 `requestId`；同一会话里重复就 409，不给就生成一个 |
| `trace_id` | 记成请求的 `traceId` |
| `stream` | `true` 时回 enterprise 事件流，否则回一个 JSON |
| `protocol` | 可省略；给了只能是 `enterprise` |
| `context` | 请求上下文（JSON 对象），和 `--context` 一样记在人类消息上、不给模型看，工具用 `ctx.requestContext.contextOf(agent)` 读；续聊时不带就沿用 |

**消息怎么进会话。** chat-api 不直接驱动 Agent：它经 dsh 的 session-controller 新建会话或核对续聊的会话，再用 `sessionController.prompt`（`queue` 模式）把消息交给 agent，`requestId`、`owner`、agent 的身份 `agent`、`traceId`、`context` 经 `ctx.requestContext.sourceFields(...)` 记在人类消息的 `source.lyteboatRequest` 上（`lyteboat/plugins/chat-api/src/index.ts` `ChatApiService.sessionFor`、`ChatApiService.answer`）。同一会话的消息排队，一条一轮。它不调 `intakeGuard.submit`：你登记的准入函数在循环第 1 步的 `lyteboat/intake` 里补做（§1.2、§2.11），`reply` 的文字照样作答，但判定和判定里的卡片不记在消息上，回答里也没有这些卡；这一轮的 `outcome` 是 `rejected`（`lyteboat/plugins/chat-api/src/chat-turn.ts` `turnOutcome`）。

**两种回答。** 不带 `stream` 时，这一轮结束后返回一个 JSON：`session_id`、`message_id`、`outcome`（`completed`、`rejected`、`tool_stopped`、`stopped_by_limit`、`aborted`、`errored`，即 contracts 的 `LyteboatTurnOutcome`）、`response`（回答文字）、`cards`（每张 `{ area, surface_id, a2ui }`）、`tool_calls`，出错时另有 `error`（`index.ts` `ChatApiService.body`）。`"stream": true` 时返回 enterprise 事件流（SSE，每帧是 `protocol: 'AGUI'` 的信封，`id` 从 1 数起）：`run_started`；至多一对 `reasoning_*`（思考增量和工具调用）；至多一对 `text_message_*`（文字增量，卡片是 `ui_protocol: 'A2UI'` 的帧，插在它在这一轮里的位置）；最后恰好一个 `run_finished`（`data.extra.run_outcome` 就是 `outcome`）或 `run_error`；空闲时发 `: keep-alive` 注释（`lyteboat/plugins/chat-api/src/enterprise-frames.ts`）。两种回答里卡片的位置都由 `ctx.a2ui.liveTurn()` 排出，规则和 `lyteboat try` 的 stdout 相同（§2.9、§7.3）。流式的调用方中途断开，正在跑的这一轮被取消，排在它后面的消息照样各自作答（`index.ts` `ChatApiService.cancelTurn`）。请求没被接受时回 HTTP 状态和 `{ error: { code, message, retryable } }`（`chat-request.ts` `ChatApiError`）。`GET /agents` 列出挂上的 agent（`id`、`name`、`description`，`agent.yml` 声明了版本时还有 `version`，`lyteboat/plugins/chat-api/src/index.ts` `ChatApiService.agents`）和挂不上的原因，鉴权同 `/chat`。

**给自己的帧加字段。** agent 行在 `inject` 里写 `chatApi`，调用 `ctx.chatApi.registerFrameDecorator((frame, context) => …)` 登记一个帧装饰器：它登记在这一行所在的 agent 常驻作用域里，这个 agent 的会话发出的每一帧都经过它，返回 disposer；`context` 是 `{ agentId, sessionId, messageId, userId }`。装饰器只能往 `frame.data` 里**加**字段：改了 `protocol`、`id`、`event`，或协议自己的 `data` 字段（`code`、`conversation_id`、`message_id`、`timestamp`、`ui_protocol`、`ui_data`、`turn`、`agent_name`、`extra`），这一帧就抛错（`lyteboat/plugins/chat-api/src/index.ts`，`enterprise-frames.ts` `decorateFrame`）。serve 的测试夹具就是这样一行（`lyteboat/bundles/serve/tests/fixtures/agents/alpha/frame-tag.mjs`，在 `agent.cordis.yml` 里写成 `name: './frame-tag.mjs'`）：

```js
export const name = 'serve-fixture-frame-tag'
export const inject = ['chatApi']
export function apply(ctx) {
  ctx.chatApi.registerFrameDecorator(frame => ({ ...frame, data: { ...frame.data, agent_tag: 'alpha' } }))
}
```

`chatApi` 只由 serve 组合发布：带这种行的 agent 在 `lyteboat try` 下等不到它，preset 挂载审计会判这个 agent 失效，启动以 `alpha: frame-tag (./frame-tag.mjs): waiting for chatApi` 报错退出（机制同 [01-architecture.md §3.4](01-architecture.md#34-启动保证哪些能力) 缺 `skills` 的例子）。用 TypeScript 写这一行时，照 §7.8 的表为 `@lyteboat/chat-api` 加类型 import、依赖和 `tsconfig.json` 引用。

组合测试用 `startComposition` 和 `LYTEBOAT_SERVE_BUNDLES` 在进程内起服务，用 `@lyteboat/testing/chat-client` 的 `postChat`、`streamChat` 调它（§7.7）；金融智能体的 `examples/agents/finance/tests/finance-chat.composite.ts` 是现成的例子，事件流的金样在同目录的 `fixtures/frames/`。

### 4.14 评测用例：`lyteboat eval`

`lyteboat eval` 用 `eval` profile（dsh-base + `@lyteboat/host` + `@lyteboat/business-base` + `@lyteboat/eval`，`lyteboat/apps/cli/src/templates.ts`）跑一个 agent 的评测用例。每个用例在 agent 的工作目录里开一个新会话，每一轮像 `/chat` 的一条消息那样经 session-controller 交给 agent：请求上下文和 agent 的身份记在人类消息上，发起者是 `{ kind: 'system', id: 'eval' }`（和同一个 agent 的 `/chat` 会话在一处，靠它区分），准入在循环里补做（§4.13）。这一轮结束后，从会话里读出它的表现，按用例的 `expect` 逐项检查（`lyteboat/plugins/eval-runner/src/index.ts` `EvalRunnerService.runCase`）。和 serve 一样，agent 声明的模型必须是进程的默认模型（§4.12）。标题请求、插件包清单和工作目录的 AGENTS.md 由业务底座关掉（§4.11），所以评测看到的就是 `/chat` 后面跑的那套。

**用例怎么写。** 默认读 agent 目录 `evals/` 下的每个 `.yml` / `.yaml`，按文件名排序；`--cases <文件或目录>`（可重复）换成别的。金融智能体的 `examples/agents/finance/evals/cases.yml` 有 6 个用例，节选：

```yaml
cases:
  - id: overview-then-diagnosis
    context: { customer: young-idle-cash }
    turns:
      - message: 看看我的资产
        expect:
          skill: asset-overview
          tools: { called: [asset_overview], not_called: [allocation_diagnosis] }
          cards: { areas: [asset_overview] }
          outcome: completed
      - message: 我的配置合理吗
        expect:
          skill: allocation-diagnosis
          tools: { called: [allocation_diagnosis] }
          cards: { areas: [allocation_diagnosis, allocation_plan] }
          outcome: completed

  - id: out-of-scope
    context: { customer: midlife-moderate }
    turns:
      - message: 帮我写一首诗
        expect:
          outcome: rejected
          tools: { called: [] }
          cards: { count: 0 }
          model_requests: { max: 0 }
          text: { includes: [服务范围] }
```

- 顶层只有 `cases`。用例有 `id`（kebab-case，所有用例文件里不能重复，录音按它命名）、可选的 `context`（第一轮的请求上下文；后面的轮次不带就沿用，和 `--context` 一样）、`turns`（至少一轮）。每一轮是 `message`（不能是空白）、可选的 `context`、`expect`。
- 文件按严格的 schema 读：多出的键、空白的消息、不是 kebab-case 或重复的 id、编译不过的正则，都让加载失败并报出文件名，这次运行以 2 退出（`lyteboat/plugins/eval-runner/src/eval-case.ts` `expectSchema`、`caseFileSchema`、`loadEvalCases`）。
- 检查的是框架层面的行为（路由到哪个技能、调了哪些工具、出了哪些卡、这一轮怎么结束），措辞留给模型，文字检查只挑必须出现的词（`cases.yml` 开头的注释）。

`expect` 里写了哪项才检查哪项（`lyteboat/plugins/eval-runner/src/eval-check.ts` `checkTurn`，读法在 `eval-turn.ts` `observe`）：

| 检查 | 通过的条件 | 读的是什么 |
|---|---|---|
| `skill` | 等于这一轮之后激活的技能；`null` 表示没有 | `lyteboatActiveSkill` 投影 |
| `tools.called` / `tools.not_called` | 列出的工具都调用过（`[]` 总是通过）/ 一个都没调用 | 这一轮 assistant 消息里的工具调用 |
| `cards.areas` / `cards.count` | 卡片的区域与列出的相同，不计顺序 / 卡片张数 | `ctx.a2ui.turnParts` 排出的这一轮 |
| `outcome` | 这一轮的结局，取值同 `/chat` 的 `outcome`（§4.13）；准入 `reply` 作答的一轮是 `rejected` | `turn/end` 的原因，以及有没有 provider 为 `lyteboat` 的 assistant 消息 |
| `text.includes` / `text.excludes` / `text.matches` | 正文包含每一段 / 不含任何一段 / 匹配这个正则（`u` 标志） | `turnParts` 的正文，不含卡片 |
| `model_requests.min` / `model_requests.max` | 循环的模型调用次数在范围内；旁路调用不算 | 这一轮 `stream` 非空的 `assistant/message` 和 `assistant/attempt` |

**跑。**

```sh
# real：调模型并录下每个用例的会话；模型的访问方式同 §4.12
node lyteboat/apps/cli/lib/bin.js eval --agents ./examples/agents --agent finance
# replay：回放一次录下的运行，不调模型、不要 key
node lyteboat/apps/cli/lib/bin.js eval --agents ./examples/agents --agent finance --model replay --from examples/agents/finance/evals/baseline
# 只跑一个用例（--case 可重复），并给运行目录起名
node lyteboat/apps/cli/lib/bin.js eval --agents ./examples/agents --agent finance --case out-of-scope --run-id finance-out-of-scope-1
```

`--agents` 可重复、至少一个，`--agent` 必填；`--from` 是运行目录，或 `$LYTEBOAT_HOME/evals` 下的运行 id；`--case <id>` 可重复，只跑这些 id 的用例，用例文件里没有这个 id 就跑不起来（退出 2）；`--run-id <id>` 是运行目录的名字，只能是一段以字母或数字开头、由字母、数字、点、横线、下划线组成的路径，这个目录已经存在就是用法错误（`lyteboat/bundles/eval/src/startup.ts` `command`、`apply`，`lyteboat/plugins/eval-runner/src/index.ts`）。Studio 的评测界面起运行、试跑单个用例，用的就是这两个参数（§4.17）。每个用例跑完打一行：`✓ <id> (<n> turns)`，或 `✗ <id>: turn <n> <失败的检查>`；最后一行是汇总和报告的路径。全部通过退出 0，有检查失败退出 1，跑不起来（参数不对、用例文件不合法、没有这个 agent、回放缺录音）退出 2（`lyteboat/bundles/eval/src/index.ts` `caseLine`、`runCases`）。

**结果在哪。** 每次运行写进 `$LYTEBOAT_HOME/evals/<运行 id>/`，不给 `--run-id` 时，运行 id 是 UTC 开始时间（精确到秒）加 4 位十六进制（`lyteboat/bundles/eval/src/startup.ts` `newRunId`）。目录里有四样东西（`lyteboat/plugins/eval-runner/src/eval-report.ts` `writeEvalRun`）：

- `run.json`：contracts 的 `LyteboatEvalRunRecord`（`lyteboat/core/contracts/src/index.ts`）。`agent` 是 agent 的身份（id、版本、摘要）；`model` 是录下的循环请求头里的模型，只有 real 运行而且发过循环请求时才有，回放不写，一次运行用了不止一个模型就失败（`lyteboat/plugins/eval-runner/src/index.ts`）；还有模式、回放的来源 `from`、每个用例是否通过、轮次和检查的总数与通过数、开始时间和耗时。`lyteboat web` 的 Evals 页按这个 schema 读，读不了的（身份出现之前录的运行）跳过并记一条 warn（`lyteboat/plugins/web-pages/src/eval-runs.ts` `listEvalRuns`）；Studio 的评测界面（§4.17）也按它读，读不了的运行照样列出，只是没有 `run.json` 里的内容，并记一条 warn（`lyteboat/plugins/eval-runner/src/records.ts`）。
- `results.jsonl`：每轮一行，有消息、读出的表现、每项检查的期望值和实际值。不含耗时，所以同一份录音回放出来逐行相同。
- `sessions/<用例 id>/session.v4.jsonl`：只有 real 有，是会话头加全部事件，dsh 的回放能读。
- `report.md`：汇总表，失败的检查逐条写出期望和实际。

**回放怎么作答。** replay 运行期间，eval-runner 在 `llm/stream` 上接住全部模型调用，没有一个到达 provider。每个会话按会话 id 绑到同名用例的录音：循环调用依次取 `@deepseek-ai/dsh-llm-replay` 从录音推出的回答，旁路调用（路由、准入分类）依次取录音里的 `lyteboat/aux-llm-call` 记录（`lyteboat/plugins/eval-runner/src/eval-replay.ts` `EvalReplay.stream`）。模型的回答是录下的，技能路由、工具、卡片、准入这些代码照常运行；所以回放回答的问题是：同样的模型回答，经过现在的代码，每一轮是不是还和录下时一样。

**回放失败说明什么。** agent 现在的做法和录音不一样了，有两种情形：

- 调模型的次数变了。超出录音的那次调用失败，报 `… recorded N loop call(s); the replay asked for call M. The agent now behaves differently from the recording: record the case again`，这一轮以 `errored` 结束。例如金融智能体的准入不再直接回复归为 `other` 的请求，`out-of-scope` 用例的消息就进了循环，而录音里这一轮没有循环调用，于是它的 `outcome` 是 `errored`，不是 `rejected`。
- 同样的回答经现在的代码出了别的工具、卡片、结局或正文。对应的检查失败，`results.jsonl` 也和基线不再相同。

改动本不该改变这一轮的表现，这就是回归，要修代码；改动就是要改变它，就重录基线。

**录一份基线并提交。**

1. 用固定的 `LYTEBOAT_HOME` 跑一次 real，例如 `LYTEBOAT_HOME=/tmp/<id>-eval-home`：每个会话头的 `cwd` 都是 `/tmp/<id>-eval-home/agent-workdirs/<id>`，每次重录都一样。金融智能体的基线用的是 `LYTEBOAT_HOME=/tmp/finance-eval-home`。
2. 读 `report.md`，确认每一轮都是你要的样子。
3. 把运行目录拷成 `examples/agents/<id>/evals/baseline/`。录音里技能调用消息的 `Base directory for this skill:` 是 agent 根目录的绝对路径，把它换成 `<agents-root>`。回放只取录音里的模型回答和旁路调用记录，不读这些路径。
4. 写一个免 key 回放基线的组合测试，照 `examples/agents/finance/tests/finance-eval.composite.ts` 写：`bootComposition` 起 `LYTEBOAT_EVAL_BUNDLES`，参数 `--agents <根> --agent <id> --model replay --from <基线目录>`，断言这次运行的 `results.jsonl` 与基线的完全相同，退出码与基线的结果一致（`finance-eval.composite.ts`）。`package.json` 的 devDependencies 加 `@lyteboat/eval`（金融智能体的 `package.json`）。之后任何改变了某一轮表现的改动，都会让这个测试失败。
5. 改动就是要改变某一轮的表现时（技能、工具、卡片、准入规则、提示），照 1–3 重录，像审代码一样审 `evals/baseline/` 的 diff 和报告（`CLAUDE.md`「Testing」的 Fixtures 一条）。

基线的 `run.json` 和录音里每条人类消息都记着录制时 agent 的身份，`evals/` 本身不算进摘要，所以把运行目录拷进 `evals/baseline/` 不会改变身份。要发布的 agent，基线得在清单写好 `version` 和 `model` 之后录，而且录完之后 agent 目录不能再改：`lyteboat release` 会逐条核对这些身份（§4.16）。

**比较两次运行。** `lyteboat eval compare <前> <后>`（两个参数都是运行目录或运行 id）逐个用例、轮次、检查比较两次运行的 `results.jsonl`，列出结果变了的检查：`✗` 是回归，即之前通过、现在失败或没有了；`·` 是其它变化。末行是变化数和回归数，有回归就退出 1（`lyteboat/bundles/eval/src/index.ts` `compareRuns`，`lyteboat/plugins/eval-runner/src/eval-report.ts` `compareEvalResults`）。改提示要有 eval 数据（`CLAUDE.md`「Agent design」）：改完用新的一次 real 运行和基线比较，看哪些检查变了。

### 4.15 在浏览器里调试 agent：`lyteboat web`

`lyteboat web` 用 `web` profile（dsh-base + `@lyteboat/host` + dsh-web-app + `@lyteboat/web`，`lyteboat/apps/cli/src/templates.ts`）起 dsh web，再加上 lyteboat 的页面（`@lyteboat/web-pages`）。它读 agent 目录，但不带业务底座：dsh web 自己的编码工具、沙箱、审批、会话标题都在，所以你的 agent 在这里跑的和在 `/chat` 后面跑的不一样（见下面「agent 层不同于业务模式」）。要照 `/chat` 的样子调试 agent，用 `lyteboat eval`（§4.14）或 `lyteboat try --agent`；Studio 工作台（§4.17）按 serve 的样子挂 agent，但只查看、不跑会话。模型的访问方式同 §4.12（不用 key 时照 §2.13 指向脚本模型）。

```sh
node lyteboat/apps/cli/lib/bin.js web --agents ./examples/agents --no-open
```

**参数**（`lyteboat/bundles/web/src/startup.ts` `command`、`apply`）：

- `--agents <目录>`：可重复；目录不存在就按用法错误退出。不给也能起，只是没有 agent。
- `--agent <id>`：新会话默认用的 agent。没有目录装着它就按用法错误退出，并列出可用的 id。不给就用所有目录里按 id 排第一的那个；一个 agent 都没有时是 `none`，新会话建不起来（`startup.ts` `apply`）。默认值在启动时定下，之后目录怎么变都不改它。
- dsh web 的 `--host`（不许 `0.0.0.0`：浏览器界面能在本机执行代码）、`--port`（`0` 让系统挑一个空闲端口）、`--no-open`、`--trusted-host`（`/api` 的浏览器信任围栏额外接受的主机，可重复）。dsh web 自己的 startup 行遇到不认识的参数（比如 `--agents`）就报错，所以 `@lyteboat/web` 关掉它，由自己的 startup 行照 dsh web 的规则把这些参数再解析一遍，替它发布 `webStartup`（`lyteboat/bundles/web/cordis.patch.yml`）。

**启动之后**，stdout 先是 dsh web 打的 `dsh web: http://127.0.0.1:<端口>/?token=…`，再是 `lyteboat web: agents <id>, …`；挂不上的 agent 各在 stderr 上打一行 `lyteboat web: agent <id> failed: <原因>`，其余照常服务（`lyteboat/bundles/web/src/index.ts` `apply`）。在浏览器里打开带 token 的地址：它换出 dsh web 的登录 cookie，页面和 lyteboat 的端点都要这个 cookie（`lyteboat/apps/cli/tests/web.e2e.ts`）。SIGTERM 停下时退出 0。

**agent 目录一改就重新声明。** `@lyteboat/web` 的 agent-catalog 行配 `strict: false`、`watch: true`（`cordis.patch.yml`）：某个 agent 读不了或挂不上，只在 Agents 页上报告（启动时那一次也打到 stderr），不挡别的 agent；根目录下有文件变了，300 ms 内没有新的变化，就 `reload()`：撤销全部声明，再按目录现在的内容重新声明（`lyteboat/plugins/agent-catalog/src/index.ts` `Config`、`AgentCatalogService.watchRoots`）。已经在跑的会话留着它开始时的定义，新会话用新的（[01-architecture.md §2.2](01-architecture.md#22-根-realmstanding-scope-与-agent-scope)）。

**Agents 页和 Evals 页。** dsh web 的左侧栏多出两个入口（`lyteboat/plugins/web-pages/src/client/index.ts` `apply`）：

- Agents：正在服务的 agent（`agent.yml` 的 `name`、`description` 和 id），挂不上的 agent 和原因，一个 Reload 按钮，按一下就是一次 `reload()`（端点 `agents`、`agents/reload`）。
- Evals：`$LYTEBOAT_HOME/evals` 下的运行，新的在前，每行是 agent、通过的用例数和模式；点一行显示它的 `report.md`（端点 `evals`、`evals/report`，`lyteboat/plugins/web-pages/src/eval-runs.ts` `listEvalRuns`、`readJson`、`readEvalReport`）。它只列 `lyteboat eval`（§4.14）写下的运行，自己不跑评测；运行要写在同一个 `$LYTEBOAT_HOME` 下才看得到。

**会话用哪个 agent。** dsh web 新建会话时用 preset 注册表的默认 preset，`@lyteboat/web` 把它设成 `--agent`（或排第一的那个），在 dsh web 里另挑一个也行（`cordis.patch.yml`）。dsh 自带的四个编码 preset（standard、ptc、minimal、cordis）都关掉了，能挑的只有 `--agents` 里的 agent。会话头的 `agentPreset` 记着它。

**lyteboat 页签。** 打开一个会话，右侧栏多一个 `lyteboat` 页签（kind `lyteboat`，`lyteboat/plugins/web-pages/src/client/index.ts` `apply`）。上半部分发下一条消息：

- Context 框里写一个 JSON 对象，打开时预填会话当前的请求上下文；写的不是 JSON 对象，页面报错，不发（`SessionTab.tsx`）。
- 点 Send，页面经 dsh 自己的浏览器传输调端点 `session/send`（`web-pages-client.ts` `webPagesClient`）。Host 面用 `ctx.sessionController.prompt`（`queue` 模式）把消息排进会话，请求经 `ctx.requestContext.sourceFields(...)` 记在人类消息上，发起者是 `{ kind: 'operator', id: 'web' }`（`lyteboat/plugins/web-pages/src/index.ts` `WebPagesService.send`）。这是 `/chat` 送消息的那条路（§4.13）：准入在循环第 1 步补做，`reply` 照样作答，判定不记在消息上。空白的消息、多出的字段以 `invalid_request` 拒绝，什么也不排（`index.ts` `sendPayload`）。

下半部分是会话的 lyteboat 状态，经 dsh 的 `useProjection` 从投影实时读出，一轮还在跑就跟着变（`SessionTab.tsx` `SessionTab`）：激活的技能（`lyteboatActiveSkill`）；带请求的消息数、owner、最近一次的准入判定（`lyteboatRequest`；经页签或 `/chat` 进来的消息判定不记，这一栏是 none）；请求上下文；卡片（`lyteboatCards`）和状态（`lyteboatState`），都是原样的 JSON。

实测（web 组合测试的夹具 agent `support`，只有一行 persona；脚本模型；按 dsh web 浏览器传输的样子带登录 cookie 调端点）：`session/create` 不指定 agent，会话头的 `agentPreset` 是 `support`；页签发送时带 `{"customer":"c-1"}`，人类消息的 `source` 是 `{"kind":"user","rpcId":"<requestId>","lyteboatRequest":{"requestId":"<同一个 id>","owner":{"kind":"operator","id":"web"},"context":{"customer":"c-1"}}}`（组合测试断言的就是这个，`lyteboat/bundles/web/tests/web.composite.ts`）。这里没有 `agent`：`lyteboat web` 的 agent 目录会重新声明，而已经在跑的会话用的是它开始时挂上的代码，此刻目录的摘要说明不了它，所以 `lyteboat web` 不记 agent 的身份（§4.16）。

**agent 层不同于业务模式。** dsh web 把 agent 层（`skill` 工具和技能目录、压缩、文件、shell、子 agent 等工具行）挪进它的编码 preset；`@lyteboat/web` 关掉这些 preset，在宿主上按 dsh-base 的样子把这些行放回来：shell 按平台（非 Windows 上是 `bash`，Windows 上是 `pwsh`），插件管理工具仍然关着（`cordis.patch.yml`）。少了放回这一步，finance 为 `skill` 写的声明找不到注册它的行，第一步就失败（§4.9 第一条）。`lyteboat web` 不列业务底座，所以放回来的是 dsh-base 的全套 agent 层。实测（Linux，上面那个只有 persona 的 `support`，脚本模型）：循环请求在 `lyteboat web` 下有 24 个工具，在 `lyteboat try` 下只有 `skill`。写了 `inherited: hidden` 的 agent（§2.4）在 `lyteboat web` 里仍只露出自己声明的工具，但系统 prompt、沙箱与审批的 runtime context、会话标题的旁路请求都和业务模式不同。工作区的 AGENTS.md 照 dsh web 的样子不进模型请求，插件包清单也关掉（`cordis.patch.yml`）。

**`lyteboat web` 不做的事。**

- 不排版卡片。页签里的卡片是 JSON；dsh 的对话区显示模型的原文，`[[card:<区域>]]` 标记原样留着，不换成卡片。要看一轮排好的样子，看 `lyteboat try` 的 stdout 或 `/chat` 的回答（§2.9）。
- dsh 自己的输入框发的消息不带请求上下文：`source` 上没有 `lyteboatRequest`，工具经 `contextOf` 读到的是会话里此前带来的那份，一次都没带过就是 `{}`（§0.3）。像金融智能体这样靠上下文认客户的 agent，第一条消息用 lyteboat 页签发。
- 没有进入循环之前的准入：页签和输入框都不调 `intakeGuard.submit`（§1.2）。
- 不跑评测：Evals 页只读 `lyteboat eval` 写下的运行。要从页面起评测运行，用 Studio 的评测界面（§4.17）。

**端点。** 页面和 Host 面之间的约定只在一个文件里（`lyteboat/plugins/web-pages/src/web-pages-endpoints.ts`）：五个端点 `agents`、`agents/reload`、`session/send`、`evals`、`evals/report`，每个注册成 dsh 连接上的精确路由 `POST /api/lyteboat/<端点>`，请求和回答都是 dsh 的 RPC 信封（`client-request` / `server-response`），页面用 `connection.rpc.call('/api', 'lyteboat/<端点>', payload)` 调它，和别的 dsh web 请求一样要过浏览器信任围栏和登录（`web-pages-endpoints.ts` `WEB_PAGES_METHOD_PREFIX`、`WEB_PAGES_ENDPOINTS`，`index.ts` `WebPagesService`、`WebPagesService.serve`）。不用 `connection.rpc.handle`，是因为它经连接自己的 web server 挂一个新通道，插件行够不着那个 web server（`index.ts` `WebPagesService`）。拒绝时回答是 `{ ok: false, error: { code, message } }`：`invalid_request`、`not_found`（没有这个评测运行）；其它错误的 code 是 `internal`，并记一条 warn（`index.ts` `WebPagesService.answer`）。Host 面的行有两项配置：`owner`（页签发的消息记下的 `operator` 发起者的 id，默认 `web`）、`evalsDir`（默认 `$LYTEBOAT_HOME/evals`）（`index.ts` `Config`）。

**在测试里调它。** `lyteboat web` 不要求 agent 另写测试。怎么在进程内起它、调它，看 `@lyteboat/web` 自己的组合测试 `lyteboat/bundles/web/tests/web.composite.ts`：`startComposition` 起 `LYTEBOAT_WEB_BUNDLES`，参数 `--agents <根> --no-open --port 0`，patch 关掉 `directory-picker`（它在运行时按包名挂后端，进程内的 loader 挂不上）；等 stdout 出现 `lyteboat web: agents …`，从 dsh web 用 `console.log` 打的地址换出登录 cookie，再按 RPC 信封 POST 端点（`web.composite.ts`）。

### 4.16 版本、身份与发布：`agent.yml`、`lyteboat release`、`serve --release`

agent 交给运维时，运维要知道服务的就是评测过的那一个。lyteboat 用三样东西回答：清单里的版本和模型（§1.3）、目录的摘要，以及把它们和基线钉在一起的发布锁。

**agent 的身份。** `{ id, version?, digest }`（`LyteboatAgentIdentity`，`lyteboat/core/contracts/src/index.ts` `lyteboatAgentIdentitySchema`）：`id` 是目录名，`version` 是 `agent.yml` 声明的，`digest` 是目录内容的摘要，agent-catalog 每次声明 agent 时算（`lyteboat/plugins/agent-catalog/src/agent-digest.ts`）：

- 算进去的：目录里每一个普通文件，除了顶层的 `tests/`、`evals/`、`agent.release.json`，以及任何深度的 `node_modules/`、名字以点开头的条目和 `*.tsbuildinfo`。构建出的 `lib/` 算在里面，所以要在构建之后、用同一份构建录基线和发布。
- 怎么算：每个文件用相对目录的 POSIX 路径命名，路径按 UTF-8 字节排序，对每一行 `<路径> NUL <内容的 sha256> LF` 求 sha256，写成 `sha256:<64 位小写十六进制>`。文本文件的内容按 git 提交它的样子算：CRLF 读作 LF，所以在 Windows 上检出或编辑过的目录和 Linux 上得到同一个摘要；前 8000 字节里有 NUL 字节的文件是二进制文件（git 自己的判断法），按原样算。文件的权限和时间不算。
- 排除项之外有符号链接就报错：`agent-catalog: <路径> is a symbolic link; an agent's digest covers regular files only`，这个 agent 声明失败。摘要因此不会随某台机器上链接指向什么而变。

try（经 `intakeGuard.submit` 的 `agent`）、`/chat`、eval 把身份写进每条人类消息的 `source.lyteboatRequest.agent`（`lyteboat/bundles/try/src/index.ts` `run`、`lyteboat/plugins/chat-api/src/index.ts` `ChatApiService.answer`、`lyteboat/plugins/eval-runner/src/index.ts` `EvalRunnerService.runCase`）；eval 还写进 `run.json`（§4.14），`GET /agents` 列出版本（§4.13）。`lyteboat web` 不写（§4.15）。

**作者的顺序。** 要发布，按这个顺序做：

1. 在 `agent.yml` 里写上（或升高）`version`，写上 `model`。模型要和运行它的进程的默认模型一致，dsh-base 的默认是 `{ provider: deepseek-official, model: deepseek-flash }`；要换就在 profile patch 里改 `agent-default-model` 行（§4.12）。`agent.yml` 在摘要里，所以这一步必须在录基线之前。
2. 构建，用真实模型跑 `lyteboat eval`（§4.14），读 `report.md`。
3. 把运行目录拷成 `evals/baseline/`（§4.14「录一份基线并提交」）。
4. `lyteboat release --agents <根目录> --agent <id>`。
5. 提交 `agent.release.json`（连同基线）。仓库里的示例 agent 不提交锁。

`lyteboat release` 就是 `lyteboat eval release`：同一个 eval profile，跑 eval app 的 `release` 子命令，也接受 `--profile`、`--patch`、`--plugin`（`lyteboat/apps/cli/src/args.ts` `parseLyteboatArgs`，`lyteboat/bundles/eval/src/startup.ts` `apply`）。eval profile 打开了 `enforceDeclaredModel`，所以发布时 `agent.yml` 的模型也必须是进程的默认模型。

**闸门的六步**（`evalRunner.release()`，`lyteboat/plugins/eval-runner/src/index.ts`，逐步在 `eval-release.ts` `releaseAgent`），按顺序，哪一步不过就停在哪一步：

| 步骤 | 查什么 | 不过时 stderr 上的原因 |
|---|---|---|
| `manifest` | `agent.yml` 声明了 `version` 和 `model` | `<目录>/agent.yml must declare a version and a model to be released` |
| `baseline` | `evals/baseline/run.json` 存在、按 schema 读得出、是 real 运行；每个用例都有录音 | `no baseline at <目录>/evals/baseline: run lyteboat eval with the real model and copy its run directory there`；`<目录> is a replay; a release baseline must be a real run`；`<run.json> is not a run this build reads (…); record the baseline again`；`the baseline has no results.jsonl (<文件>); copy the whole run directory`；`<录音>: line <n> is not JSON (…); record the baseline again` |
| `stamps` | `run.json` 的 `agent`，和每份录音里每条人类消息的 `agent`，都等于 agent 现在的身份（id、版本、摘要） | `the baseline ran <id> <版本> (<摘要>), but the agent is now <id> <版本> (<摘要>); record the baseline again`；`<录音>: a request went to …, but the agent is now …; record the baseline again` |
| `model` | 每份录音里每个循环请求头用的都是 `agent.yml` 声明的模型 | `<录音>: a request used <模型>, but agent.yml declares <模型>; record the baseline on the declared model` |
| `replay` | 在这个构建上回放基线：回放跑的用例正是基线录下的那些（所以每个回放的用例都查过录音的戳和模型），每一轮的 `results.jsonl` 行和基线逐字相同（基线的 CRLF 读作 LF），轮数相同，每个用例都通过 | `the agent's cases are now <ids>, but the baseline ran <ids>; record the baseline again`；`replaying the baseline, case <id> turn <n> no longer shows what the baseline recorded`；`replaying the baseline gave N turn(s); the baseline recorded M`；`the baseline fails case(s) <id>; a release needs every case to pass` |
| `version` | 没有已有的锁用同一个版本发布过别的内容 | `<目录>/agent.release.json already releases <id> <版本> as <摘要>; raise the version in agent.yml` |

通过时退出 0，stdout 是 `lyteboat release: <id> <版本> (<摘要>) released; lock: <锁>; replay: <运行目录>/report.md`，回放像普通的 `--model replay` 一样写进 `$LYTEBOAT_HOME/evals/<运行 id>/`。被拒退出 1，stderr 是 `lyteboat release: refused at <步骤>: <原因>`。用法错误或跑不起来退出 2：少了 `--agents` 或 `--agent`（`error: --agent is required`），agent 挂不上（清单不合法、还留着 `preset.yml`、声明的模型不是进程的默认模型）。同一个版本、同样的内容再发布一次照样通过，写出相同的字节。

**实测**（CLI 测试夹具 `echo`：一行 persona、一个用例。照 `lyteboat/apps/cli/tests/release.e2e.ts` 的做法拷到仓库外，在它上一级目录链接工作区的 `node_modules`，行才找得到包；real 运行用脚本模型；`<根>` 是拷过去的 agents 目录，摘要截短了）：

```console
$ lyteboat release --agents <根> --agent echo                   # 还没有 agent.yml
lyteboat release: refused at manifest: <根>/echo/agent.yml must declare a version and a model to be released
$ printf 'version: 0.1.0\nmodel: { provider: deepseek-official, model: deepseek-flash }\n' > <根>/echo/agent.yml
$ lyteboat release --agents <根> --agent echo
lyteboat release: refused at baseline: no baseline at <根>/echo/evals/baseline: run lyteboat eval with the real model and copy its run directory there
$ lyteboat eval --agents <根> --agent echo
✓ smoke (1 turn)
lyteboat eval: 1/1 cases passed (turns 1/1, checks 2/2); report: $LYTEBOAT_HOME/evals/<运行 id>/report.md
$ cp -r $LYTEBOAT_HOME/evals/<运行 id> <根>/echo/evals/baseline
$ lyteboat release --agents <根> --agent echo
lyteboat release: echo 0.1.0 (sha256:06d85e20…) released; lock: <根>/echo/agent.release.json; replay: $LYTEBOAT_HOME/evals/<运行 id>/report.md
$ echo '# edited after the baseline' >> <根>/echo/agent.cordis.yml
$ lyteboat release --agents <根> --agent echo
lyteboat release: refused at stamps: the baseline ran echo 0.1.0 (sha256:06d85e20…), but the agent is now echo 0.1.0 (sha256:ab46a31b…); record the baseline again
```

那次 real 运行的 `run.json`（压成了几行）：

```json
{ "agent": { "id": "echo", "version": "0.1.0", "digest": "sha256:06d85e20…" },
  "model": { "provider": "deepseek-official", "model": "deepseek-flash" },
  "mode": "real", "cases": [{ "id": "smoke", "pass": true }],
  "turns": { "total": 1, "passed": 1 }, "checks": { "total": 2, "passed": 2 },
  "startedAt": "2026-09-26T05:03:42.891Z", "durationMs": 119 }
```

接着重录基线再发布，版本还是 0.1.0，第 6 步拒绝：`refused at version: <根>/echo/agent.release.json already releases echo 0.1.0 as sha256:06d85e20…; raise the version in agent.yml`。只把版本升到 0.1.1、不重录，第 3 步拒绝：版本也在身份里，基线记的还是 0.1.0。所以改了 agent，就从第 1 步重来。金融智能体的基线是带着身份录的，`lyteboat release --agents ./examples/agents --agent finance` 不要 key 就能通过（[02-distribution.md](02-distribution.md) §9.3 有这次的输出）。

**锁里有什么。** `LyteboatAgentRelease`（`lyteboat/core/contracts/src/index.ts` `lyteboatAgentReleaseSchema`）：`agent`（id、版本、摘要）、`model`、`dshBase`（这个构建的内核来自哪个 dsh 版本）、`files`（摘要背后的逐文件哈希）、`baseline`（`startedAt`，用例、轮次、检查的个数，`results.jsonl` 按 LF 读的 sha256）。键的顺序固定、两空格缩进、结尾一个换行，所以同样的发布写出同样的字节，锁的 diff 可以像代码一样审。逐字段的表见 [02-distribution.md](02-distribution.md) §9.3。

**运维怎么用：`lyteboat serve --release <agent>/agent.release.json`。** serve 按锁核对 agent 目录、版本、模型和内核的 dsh 版本，任何一项不对就不起；锁管住什么、管不住什么（例如 lyteboat 框架代码不在锁里，要用发布它的同一个构建去 serve），每一项的原话和实测见 [02-distribution.md](02-distribution.md) §9.3。Studio 的雷达也读 agent 旁边的锁：目录的摘要和锁里的不同，就把这个 agent 标为偏离发布，`serve --release` 这时会拒绝它（§4.17）。

### 4.17 在 Studio 工作台里看 agent：`lyteboat studio`

`lyteboat studio` 用 `studio` profile（dsh-base + `@lyteboat/host` + `@lyteboat/business-base` + `@lyteboat/studio`，`lyteboat/apps/cli/src/templates.ts`）起 Studio 工作台：原 Studio 的页面，数据来自 lyteboat。它和 serve 一样带业务底座，agent 的工具、技能和路由按 serve 的样子挂上，所以这里看到的工具面、技能和诊断，就是 `/chat` 后面那一套（§4.11）。它**不跑会话**：不挂 session-controller，不建也不续会话；会话页、看板和评测界面读的是 serve 和 `lyteboat eval` 在同一个 `$LYTEBOAT_HOME` 里留下的东西（[01-architecture.md §1.5](01-architecture.md#15-studio-工作台另一个进程同一个-lyteboat_home)）。要让 agent 答一轮，仍然用 `lyteboat try --agent`、`/chat` 或 `lyteboat eval`。

**先建账户，再起 Studio。** Studio 用自己的账户登录；一个账户都没有时它不启动，在 stderr 上给出建账户的命令，退出 1。口令只从标准输入读一行，不能是终端，也不能是空行，所以它不会留在 shell 历史和进程列表里（`lyteboat/bundles/studio/src/startup.ts` `passwordFromStdin`）：

```sh
# <口令文件> 只有一行；不要把口令写在命令行上
node lyteboat/apps/cli/lib/bin.js studio account add admin --role admin < <口令文件>
node lyteboat/apps/cli/lib/bin.js studio account add dev --role editor --display-name 开发 < <口令文件>
node lyteboat/apps/cli/lib/bin.js studio account list
node lyteboat/apps/cli/lib/bin.js studio --agents ./examples/agents
```

- `account add <用户名> --role <admin|editor|viewer>` 建账户并授予角色；`--display-name` 是 Studio 显示的名字，`--user-id` 是角色和审计日志记的 id，默认都是用户名。用户名已存在就报错，改口令用 `account set-password <用户名>`；`account remove <用户名>` 删账户，它的角色留着，直到 admin 在 Users 页撤销；`account list` 列出账户和角色（`startup.ts` `accountCommands`）。
- 账户、角色和令牌密钥在 `$LYTEBOAT_HOME/studio/`（`accounts.json`、`grants.json`、`token-secret`），文件 0600。运行中的 Studio 每次登录都重读账户，每个请求都重读角色，改了不用重启。
- 三种角色：viewer 只看；editor 另外能起、停、删评测运行；admin 另外能在 Users 页授予和撤销角色、Reload agent 目录、热修技能。经 Studio 改不了自己的角色，最后一个 admin 降不了级。
- 同一个用户名从同一个来源连续 5 次登录失败，锁 30 秒；登录拿到的令牌默认 12 小时有效。

实测（临时的 `LYTEBOAT_HOME`，`DSH_TELEMETRY_DISABLED=1`）：

```console
$ lyteboat studio --agents ./examples/agents
error: this Studio has no accounts to sign in with; make the first one with: lyteboat studio account add <username> --role admin < password-file
$ lyteboat studio account add admin --role admin < <口令文件>
lyteboat studio: account admin (user admin) added as admin
$ lyteboat studio --agents ./examples/agents --port 0
lyteboat studio: http://127.0.0.1:<端口>/studio/ (internal sign-in)
lyteboat studio: agents finance
```

挂不上的 agent 各在 stderr 上打一行 `lyteboat studio: agent <id> failed: <原因>`，其余照常服务（`lyteboat/bundles/studio/src/index.ts` `apply`）。在浏览器里打开这个地址，用账户登录；`/` 也跳到这里。进程不会自己退出，SIGTERM 停下时退出 0。

**参数**（`lyteboat studio --help`，`startup.ts` `command`、`studioValuesOf`）：

- `--agents <目录>`：可重复，至少一个；目录一改，300 ms 内没有新的变化就重新声明，已经挂上的 agent 按新内容再挂一遍。
- `--host`：`127.0.0.1`（默认）或 `0.0.0.0`；后者必须同时给 `--trusted-host`，人们访问 Studio 用的每个主机名（或 `名字:端口`）一个。回环地址之外，API（`/api/studio`）只认这些 Host 头，其余回 421；页面本身不含数据，对任何 Host 都一样。
- `--port`：默认 8090；`0` 让系统挑一个空闲端口。
- `--gateway-secret-env <变量名>`、`--admin <用户 id>`：网关模式。授权网关在每个请求上带这个变量的值（请求头 `x-gateway-secret`）和用户 id（`x-gateway-user-id`，显示名可以放在 `x-gateway-display-name`），缺了或不对回 401；第一次出现的用户自动是 viewer，`--admin`（可重复）在启动时把这些用户设为 admin。网关模式没有登录页，也用不着 `account` 命令（`lyteboat/plugins/studio-auth/src/index.ts`）。
- `--anonymous-viewer`：账户模式下，不带令牌的请求按匿名 viewer 处理；只能配 `127.0.0.1`。
- `--trace-link <URL>`：追踪界面里一条 trace 的地址，`{trace_id}` 处填 trace id；会话头里的 trace id 就成了链接。
- 用哪个 `LYTEBOAT_HOME` 起它很要紧：要看 serve 的会话和指标，就用 serve 的那一个。

**每个页面看什么。** 左边是 agent 雷达：挂上的 agent（名字、版本、描述，可以搜索），有发布锁而目录已经和锁不同的标为偏离发布，挂不上的列出原因；admin 看得到 Reload。

| 页面 | 地址 | 看什么 |
|---|---|---|
| 看板 | `/studio/` | 两个视图。性能视图：按 agent（默认全部）和时间段（最近 12、24、48 小时，或按日期挑整天），可以和另一段整天比对；请求量与并发用户峰值、首字与总用时 P95、工具调用与失败三条泳道，前六的工具与技能，有请求的时间桶的表。静态指标：总量，agent、用户、技能、工具、会话五张卡和六个月的趋势，技能与会话的覆盖，serve 正在跑的消息（页面可见时每 5 秒读一次），最新动态（会话、技能、评测运行） |
| 概览 | `/studio/agents/<id>/overview` | 技能、工具、会话、发布四个数字，健康状况，最近的技能与工具，发布锁 |
| 技能 | `/studio/agents/<id>/skills?skill=<名字>` | 技能列表（谁能调用、元数据坏了没有），选中技能的 SKILL.md 和确定性诊断：点 Diagnose 查 lyteboat 元数据能不能解析、要求的工具注册并声明了没有、要求的工具是不是 `auto`、路由的 agent 能不能选到它，不问模型。admin 在这里热修（见下） |
| 工具 | `/studio/agents/<id>/tools?tool=<名字>` | agent 够得着的每个工具：怎样声明（`always`、`auto`、继承来的）、怎样到达模型（一直可见、激活后可见、看不到）、哪些技能要求它、描述和参数的 JSON Schema |
| 会话 | `/studio/agents/<id>/sessions?session=<id>` | 见下「读会话」 |
| 评测 | 侧栏的 Evals 在新标签页打开 `/studio/evals/<id>/…` | 见下「用 Studio 跑评测用例」 |
| Users | `/studio/users`（admin） | 角色授予的表：授予、修改、撤销 |
| System | `/studio/system` | 机器、Node.js、lyteboat 构建和它的数据目录、进程属性、环境变量（密钥按名字和值的样子打码） |

实测（金融智能体，以 editor 登录，调 `/api/studio`）：工具页读到 `skill` 声明 `always`、一直可见，`asset_overview`、`allocation_diagnosis`、`lookup_knowledge` 声明 `auto`、激活后可见；技能页是 `allocation-diagnosis`、`asset-overview`、`investor-education` 三个，路由方式 `dynamic`；雷达上 finance 的版本是 `1.0.0`，没有发布锁；editor 调 Users 和 Reload 得到 403。

**读会话。** 会话页列的是 agent 工作目录 `$LYTEBOAT_HOME/agent-workdirs/<id>` 里的会话，也就是 `/chat` 的（发起者 `user:<user_id>`）和 `lyteboat try --agent` 的（`operator:cli`）；评测的会话（`system:eval`）和请求指明别的 agent 的会话不列（`lyteboat/plugins/session-index/src/index.ts` `SessionIndexService.belongs`）。

- 列表默认只看最近两小时里更新过的会话，可以输入起止时间（本地时间），或选全量；「仅看异常」「仅看拦截」（拒识或取消的轮）「按用户分组」三个开关；搜索框按会话 id、用户的问题、trace id 找，范围是时间窗内最新的 500 个会话；往下滚每次再读 50 个。
- 选中一个会话：会话头是发起者、消息与轮数、最近一次请求的 trace id（配了 `--trace-link` 就是链接）、创建与更新时间；下面按轮排出时间线：请求（上下文与准入判定）、旁路调用（路由、准入分类的 prompt 和回答）、激活的技能、模型回答（从这一步开始的用时、token）、工具调用和结果（出的卡片区域、状态增量）、压缩、这一轮怎么结束；导入的历史单独标出。Raw 切到原样的日志（会话头加每个事件一行 JSONL），可以复制，也可以下载成 `<会话 id>.jsonl`。
- Studio 只拿读句柄，和正在写这些会话的 serve 同时跑没有关系；它不改会话，也不写回投影缓存。卡片只列区域，不排版：要看排好的一轮，看 `lyteboat try` 的 stdout 或 `/chat` 的回答（§2.9）。

**看板要 serve 的运行指标。** 看板的性能视图和运行中的消息，读的是 serve 挂的运行指标记录器写的文件：每轮结束后往 `$LYTEBOAT_HOME/run-metrics/<UTC 日期>.jsonl` 追加一行，运行中的轮次在 `run-metrics/running/` 的心跳文件里，30 秒没更新的心跳不算（§4.13）。try 和 eval 不写，所以只用 `lyteboat try` 跑 agent 时，性能视图是空的，运行中的消息是 0；静态指标里的会话、用户数读的是会话本身，照样有。要在看板上看到你的 agent，用同一个 `LYTEBOAT_HOME` 起 serve 和 Studio，再经 `/chat` 发几条消息：

```sh
node lyteboat/apps/cli/lib/bin.js serve --agents ./examples/agents &     # 127.0.0.1:8080
node lyteboat/apps/cli/lib/bin.js studio --agents ./examples/agents &    # 127.0.0.1:8090
curl -s http://127.0.0.1:8080/chat -H 'content-type: application/json' \
  -d '{"agent_id":"finance","user_id":"u-1","message":"看看我的资产","context":{"customer":"young-idle-cash"}}'
```

看板的数字按原 Studio 的算法算（最近秩百分位、按桶统计、同时有一轮在跑的用户峰值），用户就是请求的发起者，准入作答的轮算受控退出（`lyteboat/plugins/studio-api/src/studio-dashboard-health.ts`）。

**用 Studio 跑评测用例。** 侧栏的 Evals 在新标签页打开评测界面，左边是同一个 agent 雷达，选中 agent 看它的：

- Cases：`evals/` 下的用例文件，只读；用例展开是它的每一轮：消息、这一轮带的上下文、`expect` 里的每项检查；读不进来的文件说明原因。editor 及以上可以对一个用例点「试跑」：只跑这一个用例的一次 real 运行，起了就打开它。
- Runs：每次运行的状态、模式（回放的还写着回放哪一次）、通过率、用例·轮·检查的数目、agent 版本、模型、开始时间、用时、谁起的；按状态和文字筛选；勾两次跑完的运行对比，editor 及以上可以批量删除。New Run（editor 及以上）：real，或回放这个 agent 一次跑完的 real 运行，跑全部用例。
- 一次运行的详情：逐用例逐轮的消息、这一轮的表现和每项检查的期望与实际；editor 及以上有 Stop、Rerun（同样的模式、来源和用例）、Delete，谁都能 Export JSON。还在跑的每 2 秒刷新一次。
- Compare：两次运行并排：改善、回退、不变、只在一边的用例，第一次分歧的轮，两边失败的检查，结果变了的每项检查。

Studio 起的每个运行，都是启动器 bin 的一个 `lyteboat eval` 子进程：`--agents <Studio 的每个目录> --agent <id> --run-id <新 id>`，回放加 `--model replay --from <那次运行的目录>`，试跑加 `--case <id>`（`lyteboat/plugins/studio-api/src/studio-eval-jobs.ts` `StudioEvalJobs.start`）。它和你在命令行跑的一样写进 `$LYTEBOAT_HOME/evals/<运行 id>/`，输出记在 `$LYTEBOAT_HOME/studio/eval-jobs/<运行 id>.log`，进度按输出里的 ✓ / ✗ 行数。所以：

- 子进程的环境就是起 Studio 的环境（网关模式下去掉共享密钥所在的那个变量）：real 运行要的模型访问方式（§4.12）要在这个环境里；agent 声明的模型也必须是进程的默认模型，和命令行一样。
- 同一个 agent 同时只能有一个运行，全局两个，多了回 409。Stop 给子进程的进程组发 SIGINT，运行记为 stopped。子进程在自己的进程组里，Studio 重启不会带走它；Studio 启动时还标着 running 的任务记为 interrupted，进程写完的运行照样列出。
- 命令行跑的运行也列在 Runs 里（同一个 home）。只跑一个用例的命令行是 `lyteboat eval --agents ./examples/agents --agent finance --case out-of-scope`（§4.14）。
- 用例要改，就改 `evals/*.yml`：Studio 里没有用例编辑，也没有从会话导入用例。

**热修技能，以及它对已发布 agent 意味着什么。** admin 在技能页打开编辑器，改整份 SKILL.md 保存（`PUT /api/studio/agents/<id>/skills/<名字>`，`lyteboat/plugins/studio-api/src/studio-workspace-routes.ts` `hotFixStudioSkill`）：

- 保存带着读到时文件的 sha256（`If-Match`）；这期间文件被改过就回 412，重新读了再改。
- 新文本要过技能加载器和路由器的规则：保留 `---` 包着的 YAML frontmatter、同一个 `name`、一个 `description`、能解析的 `metadata.lyteboat`、`requiredTools` 里只有 agent 注册并声明了的工具（§4.3）；不合就回 400，说出违反的是哪一条（`studio-skill-hotfix.ts`）。
- 文件经临时文件和 rename 整份替换，写进 `studio/audit.jsonl`（改前改后的 sha256），然后 Studio 重载 agent；技能加载器不认新文件，就还原旧文件，回 400。
- 能改的只是 agent 目录里已有技能的 SKILL.md：不能新建、删除技能，也不能改目录里别的文件。

热修改的就是 agent 目录本身，它是 agent 的一次改动，要像别的改动一样提交或丢弃。对一个有发布锁的 agent，Studio 保存前先弹出警告：`这个 agent 有发布锁（v<版本>）。保存后目录内容与锁不同：雷达显示「偏离发布」，按锁上线的 serve 重启时会拒绝它。技能正文在 serve 里下次调用时生效，名称和描述要等 serve 重启。这次修改会写进审计记录。`（`lyteboat/plugins/studio-web/src/client/studio-agent-skills.tsx` `studioHotFixWarning`）。也就是说：

- 目录的摘要变了，雷达把 agent 标为偏离发布；`lyteboat serve --release <锁>` 下次启动时拒绝它，报出变了的文件（`the directory differs from its release …`，§4.16）。
- 正在跑的 serve 不重新声明 agent（它关掉了目录监视），但技能正文是每次调用时从文件读的，所以新正文下一次调用就生效；技能的名字和描述要等 serve 重启。
- 要把热修留下，就把它当一个新版本：提交改动，升高 `agent.yml` 的 `version`，重录基线，再 `lyteboat release`（§4.16）。不留，就把文件恢复原样，摘要回到锁里的那个，雷达不再标偏离。

**在测试里调它。** Studio 不要求 agent 另写测试。怎么在进程内起它、调它，看 `@lyteboat/studio` 自己的组合测试 `lyteboat/bundles/studio/tests/studio.composite.ts`：`startComposition` 起 `LYTEBOAT_STUDIO_BUNDLES`，账户用 `@lyteboat/studio-auth/accounts` 的 `setStudioAccount`、`setStudioGrant` 直接写进测试的 home，serve 用同一个 home 起在旁边，再用令牌调 `/api/studio`。

### 4.18 看 agent 由什么组成：`lyteboat inspect`

`lyteboat inspect` 用 `inspect` profile（dsh-base + `@lyteboat/host` + `@lyteboat/business-base` + `@lyteboat/inspect`）按业务模式的样子挂上一个 agent，从它的常驻作用域读出它由什么组成，打印出来就退出：不建 agent 实例，不调模型，不要 key。改完 agent 的组合、技能或工具行，先用它看一眼，比跑一轮再读日志快。

```console
$ node lyteboat/apps/cli/lib/bin.js inspect --agents ./examples/agents --agent finance
lyteboat inspect: finance 1.0.0 (sha256:…) mounted
tools (4):
  skill  always
  asset_overview  activated  required by asset-overview
  allocation_diagnosis  activated  required by allocation-diagnosis
  lookup_knowledge  activated  required by investor-education
skills (3), routing dynamic:
  allocation-diagnosis  requires allocation_diagnosis
  asset-overview  requires asset_overview
  investor-education  requires lookup_knowledge
checks: 15 passed, 0 failed
eval case files (1):
  evals/cases.yml (6)
```

- 第一行是 agent 的身份（§4.16）。工具一节是模型能不能看到它：`always` 一直可见，`activated` 要等技能激活或 `lyteboat/pre-assemble` 里的 `activate`，`hidden` 看不到（§4.11）；后面是要求它的技能。
- 检查是 Studio 技能页 Diagnose 的同一组确定性规则：lyteboat 元数据能解析、要求的工具已注册并已声明、要求的工具是 `auto`、路由的 agent 能选到这个技能（`@lyteboat/agent-inspector`）。
- 用例文件是 `evals/` 下的每个文件和它的用例数；读不进来的文件说明原因。
- `--result json` 把同样的内容打成一个 JSON 对象（`@lyteboat/contracts/cli` 的 `LyteboatInspectResult`），给脚本和别的进程读。
- 挂上退出 0；agent 挂不上（组合的行等不到服务、清单不合法、`inherited: hidden` 下声明了没人注册的工具……）打印原因、退出 1；根目录里没有这个 id 或参数不对退出 2，例如 `lyteboat: agent-catalog: no root holds "nope" (available: finance)`。

`lyteboat try --result json` 是同一类输出的另一半：跑完一轮，把这一轮打成一个 JSON 对象（结局、正文、卡片、工具、技能、模型、会话 id，`LyteboatTryResult`），代替默认的文字输出。

---

## 5. 测试与验收

### 5.1 要写哪些测试

| 层 | 文件 | 跑在哪 | 负责什么 |
|---|---|---|---|
| 单元（纯逻辑） | `examples/agents/<id>/tests/*.spec.ts` | vitest `source` 项目，通过 `@lyteboat/source` 读 lyteboat 包的 `src`，不用构建本 agent；内核要至少构建过一次 | L4 纯函数、准入判定 |
| 单元（单元宿主） | 同上 | 同上；`createLyteboatUnitHost` + `MockAdapter` | 行挂上服务之后的行为：工具结果、卡片契约（`validateFullPayload` 严格校验）、状态、准入经 `submit` 和不经 `submit` 两条路径 |
| 组合（agent 必需） | `examples/agents/<id>/tests/<id>.composite.ts` | vitest `composite` 项目，加载 `lib/`，需先构建；`bootComposition` + 脚本模型 | 路由、可见性、状态增量、卡片与排布、准入、续聊与重开，全部在会话日志、模型请求和 stdout 上断言 |
| 评测回放（有评测基线的 agent） | `examples/agents/<id>/tests/<id>-eval.composite.ts` | vitest `composite` 项目，需先构建；`bootComposition` + `LYTEBOAT_EVAL_BUNDLES`，`--model replay`，不要模型和 key | 基线 `evals/baseline` 经现在的代码回放出的 `results.jsonl` 与基线的完全相同；照 `examples/agents/finance/tests/finance-eval.composite.ts` 写（§4.14） |
| e2e 冒烟（每个 agent 一个） | `examples/agents/<id>/tests/<id>-smoke.e2e.ts` | vitest `source` 项目，经 devDependency `@lyteboat/cli` 派生构建好的 `lib/bin.js` 进程，需先构建 | 安装闭包 + profile + agent 目录能一起加载 |

规则（测试表、Who tests what、命名、只 mock 边界）见 `CLAUDE.md`「Testing」；三个 vitest 项目的划分在 `vitest.config.ts`。

### 5.2 怎么断言会话日志

`readSessionLog` 返回的第一条是会话头，其余是 `{type, seq, time, data, …}`。单元宿主上用 `agent.session.snapshotEvents()` 直接拿事件，用 `ctx.sessionProjections.stateOf(agent.session, key)` 读投影。常用写法（大多在 §2.14、§2.15 里出现过）：

| 想证明 | 写法 |
|---|---|
| 路由器选中了哪个技能 | 找 `source.kind === 'skill-invocation'` 的 `user/message`，`source.name` 就是技能 id（§2.15 的 `invokedSkills`）；它排在本步的 `request/header` 之前 |
| 路由请求本身 | `lyteboat/aux-llm-call` 记录：`ignorable === true`，`data.purpose === 'skill-router'`，`data.output` 是模型的原文，`data.route` 是实际用的模型；失败时没有 `output`，有 `failure` |
| 没路由 | 路由记录的 `output` 里 `skill_id` 为 `null`，日志里也没有技能调用消息 |
| 模型自己加载了技能 | 有一次 `name` 为 `skill` 的 `tool/call` 和成功的 `tool/result`，没有技能调用消息；下一个 `request/header`（`reason` 为 `change`）才带上 `requiredTools`，紧跟一条 `developer/message`（§3.3） |
| 状态增量、卡片 | `tool/result` 的 `data.meta.lyteboat.stateDelta`；`data.meta.lyteboat.cards` 是数组，每张卡断言 `area`、`emission` 和 `surfaceId`（匹配 `/^<card>-session--[0-9a-f]{6}$/`，双连字符的来由见 §2.9）。单元宿主上直接读 `ctx.a2ui.cardsOf(agent)` 和 `lyteboatState` 投影 |
| 卡片契约 | `validateFullPayload(payload, { strict: true }).errors` 为 `[]`（§2.14） |
| 卡片排在哪 | 断言 stdout：`lyteboat try` 把这一轮排好，卡片是 `[card <区域>]` 一行（§2.13） |
| 准入判定 | 人类消息的 `data.source` 用 `toEqual({ kind: 'user', lyteboatRequest: { owner: { kind: 'operator', id: 'cli' }, agent: { id: '<id>', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) }, intake: { by, decision, verdict, text } } })` 整个断言（`owner` 是 `lyteboat try` 记下的发起者；`agent` 是 agent 的身份，摘要随构建变化，只断言形状，清单声明了版本时再加 `version`，写法见 `lyteboat/bundles/try/tests/try-agent.composite.ts`）；带了 `--context` 时 `lyteboatRequest` 里还有 `context`。单元宿主上读 `lyteboatRequest` 投影的 `intake` |
| 准入回复 | 零模型请求、没有 `request/header`、没有 `lyteboat/aux-llm-call`（除非准入函数自己做了旁路调用）；`assistant/message` 的 `source` 用 `toMatchObject({ provider: 'lyteboat', model: '<准入函数的 name>' })` 断言（完整的 `source` 还有 `kind: 'model'`） |
| 续聊 | 第二次运行的 stderr 打出同一个会话 id（`printedSessionId`）；只有一份日志，里面两个 `turn/start`；路由请求的 prompt 里 `<current_active_skill>` 是上一轮的技能 |
| 日志能重开 | `reopenRefusal(records)` 为 `undefined` |
| 模型看到了什么 | 看脚本模型记录的请求：`systemText`、`toolNames`、消息文本（包括 `<skill_content name="…">`、digest、`lyteboat:state` 的 JSON），以及**看不到**的东西（例如 `rootComponentId`、请求上下文） |
| 本轮结束了 | `eventTypes(records)` 包含 `'turn/end'`；不要断言它是最后一条（§2.16） |

还有两个小工具：`eventTypes(records)` 返回除会话头以外所有记录的 type；`normalizeSessionLog` 用于跨运行比较，它会去掉 `session/title*`，因为标题结果可能在 `turn/end` 之后才到（`lyteboat/tooling/testing/src/session-log.ts` `DROPPED_EVENT_TYPES`）。

### 5.3 命令

通用的命令（快速循环、提交前的检查、看某个测试的输出）见 `CLAUDE.md`「Commands」。只跑本 agent 的：

| 目的 | 命令 |
|---|---|
| 单元测试 | `npx vitest run --project source examples/agents/policy-desk --exclude '**/*.e2e.ts'` |
| 组合测试 | `pnpm run build && npx vitest run examples/agents/policy-desk/tests/policy-desk.composite.ts` |
| 冒烟 | `pnpm run build && npx vitest run examples/agents/policy-desk/tests/policy-desk-smoke.e2e.ts` |

### 5.4 验收

规则见 `CLAUDE.md`「Workflow」→「Done criteria」第 4 条。§2.13 的 `policy-desk-try.sh` 就是现成的验收脚本：它的输出同时给出 stdout、stderr、模型请求的用途序列和整份会话日志。

---

## 6. 常见问题与排错

**先打开 warn。** `lyteboat try` 默认不打印 logger 的 warn，启动器只收集启动期的 warn / error，用来报告启动失败（上游 `packages/boot/app-boot/src/index.ts:980-989`）。把下面这个文件存到任意位置（它没有 import，放在仓库外也能加载），用 `--plugin` 挂上：

```js
// Debugging aid, never shipped: print the tree's logger warnings and errors to stderr.
export const name = 'log-to-stderr'
export function apply(ctx) {
  ctx.logger.exporter({
    levels: { default: 2 },
    export: ({ name, type, args }) => {
      if (type === 'warn' || type === 'error') process.stderr.write(`[${type}] ${name}: ${args.map(String).join(' ')}\n`)
    },
  })
}
```

```sh
node lyteboat/apps/cli/lib/bin.js try --plugin <log-to-stderr.mjs 的路径> --agents ./examples/agents --agent policy-desk "保单 P-1001 还有效吗"
```

实测输出（技能名写成下划线时；路径用 `…` 缩写）：

```text
[warn] skill-filesystem: skill file …/examples/agents/policy-desk/assets/skills/policy-lookup/SKILL.md ignored: invalid skill name "policy_lookup"
lyteboat: session session-…
```

下表里标「实测」的输出，都来自在一份拷贝上改出对应错误、用 §2.13 的脚本模型在构建好的二进制上跑出来的结果（本机路径换成了占位符）：

| 现象 | 原因 | 处理 |
|---|---|---|
| `pnpm run build` 报 `fatal: not a git repository (or any of the parent directories): .git`（实测） | 在没有 `.git` 的源码包里构建；打包内核时要跑 `git rev-parse`（`scripts/dist/bundle-kernel.ts` `importBases`） | 在 git clone 里工作（§2.0） |
| 把 `lyteboat/` 下各包的 `lib/` 都删了再 `pnpm run build`，构建照常退出 0，却没有重新产出 `lib/`；接着运行 CLI 报 `Error: Cannot find module '…/lyteboat/apps/cli/lib/bin.js'`（实测） | 陈旧的 `*.tsbuildinfo`（被 gitignore，lyteboat 的包把它放在包目录里，不在 `lib/` 里）让 `tsc -b` 以为这些项目都是最新的，什么也不产出 | `find lyteboat examples -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete`，再 `pnpm run build`（实测恢复） |
| 构建报 `Error: @deepseek-ai/dsh-llm: lib/typert.host.js, lib/typert.host.d.ts, lib/typert.remote-client.js, lib/typert.remote-client.d.ts missing; they come with the import (scripts/dist/import-upstream.ts)`（实测） | 删 `lib/` 时连 `dsh/llm/llm/lib/` 下的 Typert 文件一起删了。它们随内核导入提交进仓库，受 git 跟踪，不是构建产物（`scripts/dist/bundle-kernel.ts` `checkTypert`） | `git checkout -- dsh/llm/llm/lib`，再 `pnpm run build`；清 `lib/` 时绕开 `dsh/` |
| `pnpm run lint` 的 knip 报出几十条与本 agent 无关的 `Unused exports` / `Unused exported types`，指向 finance 和各插件（实测） | 仓库克隆在某个名为 `tmp` 的目录之下（系统临时目录常常就是）。`.gitignore` 忽略 `tmp/`（`.gitignore:6`），knip 用绝对路径匹配包的 `exports` 入口，匹配上这条就把所有入口都丢了 | 把仓库克隆到路径里没有 `tmp` 这一段的目录 |
| `error: agent "policy_desk" not found in the --agents directories (available: finance, policy-desk)`，退出 1（实测） | id 写错了（id 就是目录名），或者目录里没有 `agent.cordis.yml` | 用列出来的 id；确认文件存在（`lyteboat/bundles/try/src/startup.ts` `apply`） |
| `lyteboat: policy-desk-tools (./lib/tools.js): never started`，下一行 `policy-desk-intake (./lib/intake.js): never started`，退出 1（实测） | 没有构建，`lib/` 不存在（打开 warn 能看到 `ERR_MODULE_NOT_FOUND`）；或者行的 `inject` 里有服务不可用 | `pnpm run build`；检查 `inject` |
| `lyteboat: persona (@deepseek-ai/dsh-persona): never started`，后面还有 `lyteboat-skill-router (@lyteboat/skill-router/agent)`、`policy-desk-tools (./lib/tools.js)` 两行，退出 1（实测） | agent 目录不在仓库里，行名和工具行 import 的包从目录向上找不到 `node_modules` | agent 放在 `examples/agents/` 下；包按名字解析依赖根目录提升的 `@deepseek-ai/*`、`@lyteboat/*`（README「pnpm 设置为什么和常见项目不同」） |
| 路由器从不调用，`auto` 工具从不出现，退出 0（实测） | 技能名不合法（下划线、大写），文件被静默忽略 | 改成连字符小写；打开 warn 确认（§4.3） |
| 路由之后退出 1，stdout 只有一个空行：`lyteboat: UNKNOWN: lyteboat skill router: skill "policy-lookup" requires tool "query_polcy", which the tool policy does not declare for agent "session-…"`（实测） | `requiredTools` 拼错，或者那个工具没有经 tool-policy 注册或声明 | 修正名字；工具要经 `ctx.toolPolicy.register` 注册，别的行注册的工具用 `@lyteboat/tool-policy/agent` 声明（`lyteboat/plugins/skill-router/src/index.ts` `SkillRouterService.activateTools`） |
| 路由之后退出 1：`lyteboat: UNKNOWN: lyteboat skill router: skill "policy-lookup" has an invalid metadata.lyteboat: ✖ Unrecognized keys: "group", "version"`（实测） | `metadata.lyteboat` 里有 `requiredTools` 以外的键 | 删掉多余的键（§4.3） |
| 第一步就失败，退出 1：`lyteboat: UNKNOWN: lyteboat tool policy: declared tool "no_such_tool" registered by no row reachable from agent "session-…"`（实测） | `@lyteboat/tool-policy/agent` 声明了没有任何行注册的工具；这个检查在每一步的 `lyteboat/pre-assemble` 之后做 | 修正名字，或者把注册工具的行加上（`lyteboat/plugins/tool-policy/src/index.ts` `ToolPolicyService.reconcile`）。dsh 升级改了工具名时，§4.11 里为 dsh 工具写的声明也会触发 |
| 工具调用之后退出 1：`lyteboat: UNKNOWN: tool result at session seq 20 carries an invalid meta.lyteboat: state delta path "policy_desk..current" has an empty segment`（实测） | `stateDelta` 返回了非对象，或者点路径里有空段 | 按 §2.10 的契约返回对象或 `undefined`（`lyteboat/plugins/tool-policy/src/state.ts` `mergeStateDelta`、`lyteboatStateProjectionDefinition.apply`） |
| 启动时退出 1：`lyteboat: agent-catalog: 1 agent(s) failed:`，下一行 `policy-desk: policy-desk-tool-surface (@lyteboat/tool-policy/agent): lyteboat tool policy agent row: unknown key "undeclared"; allowed: inherited, tools`（实测；工具策略里写了 `requiresConfirmation` 时是 `tool "skill" has unknown key "requiresConfirmation"; allowed: visibility`） | `@lyteboat/tool-policy/agent` 行或某个工具的策略里有未知的键，包括去掉了的 `undeclared` 和 `requiresConfirmation` | 行只认 `inherited` 和 `tools`，工具策略只认 `visibility`：`undeclared: auto` 改成 `inherited: hidden`，删掉 `requiresConfirmation`（`lyteboat/plugins/tool-policy/src/agent.ts` `apply`） |
| `lyteboat tool policy: auto tool "x" registered in agent "…"'s own layer, which restrict() cannot hide; register through the host or a preset row` | 在 `agent.ctx` 上注册了 `auto` 工具 | 在 preset 的行里注册（§4.6） |
| `lyteboat: Preset services require isolate realms: helloService`，退出 1（实测） | agent 行调用了 `ctx.provide` | 改成宿主插件，或者只做声明（§4.6） |
| 准入没起作用，荐股问题照样到了路由器和模型 | 看这条人类消息的 `source.lyteboatRequest.intake`：没有这个字段，说明这个 agent 的作用域链上没有登记准入函数，`submit` 没有判定可记（`lyteboat/plugins/intake-guard/src/index.ts` `IntakeGuardService.admit`）；`decision` 是 `pass`，说明函数判了放行 | 确认准入行在 `agent.cordis.yml` 里、`lib/` 已构建、`inject` 里有 `intakeGuard`；再查 `admit` 的判断，单元测试覆盖它（§2.14） |
| 自己监听 `lyteboat/intake` 写的拒识门不生效 | 排在它外面的某个 `lyteboat/intake` 监听器没有调用 `next()`，把里面的监听器全挡掉了 | 让每个 intake 监听器在不处理时都 `return next()`（§4.4） |
| 模型说「会话状态里没有…」 | 工具出错（`isError` 的结果不折叠，`state.ts` `lyteboatStateProjectionDefinition.apply`）；`stateDelta` 返回了 `undefined`；调用发生在 `run_code`（PTC）里，子调度不计算 meta；或者调用发生在子 agent 里，结果写进了子会话的日志 | 看 `tool/result.meta.lyteboat.stateDelta`（§2.10 `presentationMeta` 一条） |
| 卡片字段为空，stderr（打开 warn）有 `[warn] a2ui-service: a2ui: [MANIFEST] computed 'sum_insured_text': compute.js 缺少导出 'sum_insured_txt'`，退出 0（实测） | manifest 的 `path` 解析失败且没有 `default`；或者 computed 函数名不匹配 | 对照 warn 修正 manifest 或 `compute.js`；单元测试里做契约校验，并断言卡片内容（§2.14，`lyteboat/plugins/a2ui/src/resolver.ts` `resolveState`、`resolveComputed`） |
| 工具结果是 `Error: <agent 目录>/assets/a2ui/policy_card/manifest.yaml: emission_mode "later" is not one of immediate, deferred, deferred_discard`，卡片没有出现，退出 0（实测） | manifest 的 `emission_mode` 不是三个值之一 | 改成 `immediate`、`deferred` 或 `deferred_discard`（§2.9） |
| 工具结果是 `Error: <agent 目录>/assets/a2ui/policy_card/compute.js is not an ES module with named exports: it exports only its default`，卡片没有出现，退出 0（实测） | `compute.js` 用 `export default { … }` 导出函数 | 改成具名导出（§2.9） |
| 卡片没有出现在 stdout 里 | 卡片没放进 `meta.lyteboat.cards`（没用 `cardsPresentationMeta`，或者放在了别的键上）；或者它是 `deferred_discard`，回答没写标记；或者本轮没有正常结束，没被标记放下的延迟卡都不显示 | 用 `cardsPresentationMeta(cards)`（§2.10）；对照 manifest 的 `emission_mode` 和回答里的标记（§2.9） |
| stdout 里多出一个空行，却没有卡片：`SCRIPTED-ANSWER\n\nSCRIPTED-CLOSING\n`（实测：保单簿里没有这张保单，脚本照样写了标记） | 回答写了 `[[card:policy_card]]`，这一轮却没有这个区域的卡，标记被删掉，它两边的换行留了下来 | 让模型只在 digest 给出标记时才写标记：本例只有查到保单的 digest 带标记（§2.10） |
| `tsc -b` 在 `execute` 上报 TS2322，最后一行是 `Type 'string' is not assignable to type '"ok" \| "not-found"'`（实测） | 输出 schema 里写了 `enum` | 去掉 `enum`，或者给返回的字面量加 `as const`（§2.10） |
| 新包不在 `node_modules/@lyteboat/` 下，`pnpm install --frozen-lockfile` 失败 | 做的是增量安装，或者锁文件没有提交 | `rm -rf node_modules && pnpm install`，提交 `pnpm-lock.yaml` |
| `tsc -b` 报 `error TS2339: Property 'sessionProjections' does not exist on type 'Context'.`（实测） | 用了某个服务，但没补类型前提 | 按 §7.6、§7.8 补 import、依赖和 tsconfig 引用 |
| `lyteboat: session "session-nope" does not exist; omit --session-id to start a new session`，退出 1（实测） | 会话 id 打错了，或者换了 `$LYTEBOAT_HOME` | 用上一次 stderr 打出的 id，在同一个 `LYTEBOAT_HOME` 下运行（§4.10） |
| `lyteboat: session "…" runs under agent "policy-desk"; continue it with --agent policy-desk`，退出 1（实测） | 续聊时用了别的 `--agent`，或者没给 | 用录制时的 agent |
| `lyteboat: session "…" was recorded in "…", not "…"`，退出 1（实测） | 不带 agent 的会话在别的目录下续聊；带 `--agent` 的会话换了（或搬了）`$LYTEBOAT_HOME`，agent 的工作目录跟着变了 | 回到录制时的目录，或录制时的 home（§4.10） |
| `error: --context file not found: <工作目录>/nosuch.json`、`error: --context is not JSON: Unexpected end of JSON input`（均实测）或 `error: --context must be a JSON object` | `--context` 的值不以 `{` 开头时被当成文件路径（`[1]` 也会被当成文件名）；内联的 JSON 写坏了；或者文件里解析出来不是对象 | 内联写 `'{"channel":"app"}'`，或者给一个装着 JSON 对象的文件（`lyteboat/bundles/try/src/startup.ts` `readContext`） |
| 加载失败：`agent-catalog: <目录>/preset.yml is now agent.yml: rename it (name, description, and order stay; version and model are new)`（实测） | 目录里还是原来的 `preset.yml` | 改名为 `agent.yml`，三个字段照旧；要发布再加 `version`、`model`（§1.3） |
| 加载失败：`agent-catalog: <目录>/agent.yml: (the file): Unrecognized key: "color"`，或 `… version: Invalid input: expected string, received number`（均实测，后者是 `version: 1.0`，YAML 把它读成数），或 `… version: must look like 1.2.3 or 1.2.3-rc.1` | 清单多了键、版本不是字符串或不是这个形状 | 只用 `name`、`description`、`order`、`version`、`model` 五个键；版本写成 `1.2.3` 或 `1.2.3-rc.1`，数字形状的版本要加引号（§1.3） |
| serve 退出 1、eval 退出 2：`<id>: agent.yml declares model deepseek-official/deepseek-flash, but this process runs deepseek-official/deepseek-pro; run it with that default model (the agent-default-model row) or change agent.yml`（实测） | serve 和 eval 要求 agent 声明的模型就是进程的默认模型；try 和 `lyteboat web` 不查 | 用 profile patch 或 `--patch` 把 `agent-default-model` 行改成声明的模型，或者改 `agent.yml`（改了就要重录基线，§4.16） |
| 加载失败：`agent-catalog: <路径> is a symbolic link; an agent's digest covers regular files only` | agent 目录里（排除项之外）有符号链接，摘要不跟随链接 | 换成普通文件；`node_modules/` 和以点开头的条目里的链接不受影响（§4.16） |
| `lyteboat release: refused at <步骤>: <原因>`，退出 1（实测） | 发布闸门的某一步不过；最常见的是 `stamps`：录完基线之后又改了 agent 目录或版本 | 照 §4.16 的表处理；改了 agent 就升版本、重录基线、再发布 |
| `serve --release` 退出 1：`<id>: the directory differs from its release 1.0.0 (sha256:…): changed agent.yml`，或 `agent.yml declares version 1.0.0, but its release pins 1.0.1`（均实测） | 发布之后 agent 目录变了（包括重新构建出不同的 `lib/`），或者清单的版本和锁的不一样 | 服务锁记下的那份内容；要上新内容就重新发布（§4.16） |
| `serve --release` 退出 1：`error: --release <锁> was released on dsh 0.1.6, but this build runs dsh 0.1.7-rc.2; release the agent again with this build`（实测，改了锁的 `dshBase`） | 锁是在别的内核版本的构建上发布的 | 用发布它的那个构建去 serve，或在这个构建上重新发布（[02-distribution.md](02-distribution.md) §9.3） |
| `lyteboat studio` 退出 1：`error: this Studio has no accounts to sign in with; make the first one with: lyteboat studio account add <username> --role admin < password-file`（实测） | 账户模式下 `$LYTEBOAT_HOME/studio/` 里一个账户都没有，或者这次用了别的 `LYTEBOAT_HOME` | 在同一个 home 下 `lyteboat studio account add <用户名> --role admin < <口令文件>`，或者挂在授权网关后面用 `--gateway-secret-env`（§4.17） |
| Studio 看板的性能视图是空的，运行中的消息是 0 | 运行指标只有 serve 写，try 和 eval 不写；或者 Studio 和 serve 用的不是同一个 `LYTEBOAT_HOME` | 用同一个 home 起 serve 和 Studio，经 `/chat` 发消息（§4.17） |
| Studio 里起评测运行被拒（409） | 这个 agent 已经有一个运行在跑，或者全局已经有两个；或者这个 Studio 不是 `lyteboat` 启动器起的，没有可以起 `lyteboat eval` 的 bin | 等它跑完或点 Stop；用 `lyteboat studio` 起 Studio（§4.17） |
| 热修技能之后，`serve --release` 退出 1：`<id>: the directory differs from its release <版本> (sha256:…): changed assets/skills/<名字>/SKILL.md` | 热修改了 agent 目录，摘要和锁不同，雷达上也标着偏离发布 | 把热修当新版本：升版本、重录基线、重新发布；不要就把文件恢复原样（§4.17、§4.16） |
| composite 测试拿到的请求比预期多一个 | agent 自己的旁路调用，脚本模型把它记成 `loop`；在 `lyteboat web` 的组合里还有标题请求（`purpose === 'title'`，业务模式不发） | 按 `purpose` 过滤，`withTitle` 负责应答标题；旁路调用按它的系统文本认（§2.15） |

---

## 7. 附录：API 速查

### 7.1 `ctx.toolPolicy`（`@lyteboat/tool-policy`，`lyteboat/plugins/tool-policy/src/index.ts`）

| 成员 | 说明 |
|---|---|
| `register(definition, meta = {})` | 在调用方作用域的层里注册工具并登记 meta（注册过的工具就算声明过）；带 `stateDelta` 时包装 `presentationMeta`；返回 disposer |
| `declare(name, meta)` | 给别的行注册的工具登记 meta，近的作用域优先；返回 disposer |
| `declareInherited(visibility)` | 在调用方作用域声明「没有任何声明点名的继承工具」是否可见：`visible` 或 `hidden`，近的作用域优先，没有声明时为 `visible`；一个作用域只能声明一次；`hidden` 隐藏的工具无法激活；返回 disposer。agent 行的 `inherited` 配置就是调用它 |
| `metaOf(name, scope?)` | 按作用域解析到的 meta，近的作用域优先；agent 本身就是一个作用域键 |
| `activate(agent, names)` | 让 `auto` 工具对该 agent 可见，名字必须已声明，否则抛错；一直有效，直到 `clear` |
| `clear(agent)` | 撤销该 agent 的所有激活 |
| `activated(agent)` | 已激活的名字（排序后） |
| `visible(scope)` | 一个新 agent 在这个常驻作用域下、激活任何工具之前看得到的工具：`auto` 工具不在里面，`inherited: hidden` 时没声明的继承工具也不在；一个运行中的 agent 此刻看到的是 `ctx.tools.schemas(agent)` |

`LyteboatToolMeta`（`lyteboat/core/contracts/src/index.ts`）：`visibility?: 'always' | 'auto'`（默认 `always`）、`stateDelta?: (args, value) => JsonValue | undefined`。`stateDelta` 必须返回以点路径为键的 JSON 对象或 `undefined`；非对象或有空段的路径会让投影折叠抛错、运行失败（`lyteboat/plugins/tool-policy/src/state.ts` `mergeStateDelta`，§2.10）。agent 行里声明的策略是去掉 `stateDelta` 的 `LyteboatToolPolicy`（`lyteboat/plugins/tool-policy/src/index.ts`）。

### 7.2 `defineTool`（`@deepseek-ai/dsh-tools`，`dsh/core/tools/src/schema.ts` `DefineToolOptions`）

`name`、`description`、`parameters`（逐属性：`type`、`required: true`、`description`、`enum`；对象要显式 `additionalProperties`；`execute` 前校验，`schema.ts`）、`output.schema`、`output.render(args, value) → ContentBlock[]`（模型可见）、`output.presentationMeta?(args, value) → JsonValue`（持久化，模型看不到；只对模型直接发起的调用计算，`run_code` 的子调度不计算，`dsh/core/tools/src/index.ts` `ToolExecutionInput`、`ToolRuntime.createSuccessResult`）、`execute(args, exec)`（`exec.agent` 是调用方 Agent，`exec.concludeTurn()` 结束本轮，`dsh/core/tools/src/index.ts`）、可选 `timeoutMs`、`isConcurrencySafe`、`deferLoading`。

### 7.3 `@lyteboat/a2ui`（`lyteboat/plugins/a2ui/src/index.ts`）

服务 `ctx.a2ui`：

| 成员 | 说明 |
|---|---|
| `renderCard(templates, area, raw, { agent })` | 渲染一张卡给一个 agent 的工具结果或准入回复用，返回 `LyteboatResultCard`（`{ surfaceId, area, emission, payload }`）；manifest 取值的警告打成 warn；卡片不存在、文件坏了、payload 不是无损 JSON 时抛错 |
| `render(templates, card, raw, { sessionId?, hierarchy?, surfaceId? })` | 引擎的完整结果 `{ payload, warnings, digest, emission }`；给了 `surfaceId` 时产出原地更新的 `surfaceUpdate`；不打印 `warnings`，不做契约校验（`engine.ts` `TemplateEngine.render`） |
| `registerRenderTool(options)` | 注册 `render_a2ui`：从 `lyteboatState[stateKeys]` 取原始数据，打印 `warnings`，按 `validation` 做契约校验（`enforce` 时抛错），`terminalCards` 里的卡调用 `concludeTurn`；digest 为空时回退成 `[卡片:<template>] 已渲染`；出的卡以模板名为区域；默认 `always`、`validation: 'warn'`、默认组件目录 |
| `cardsOf(agent)` | 本会话准备过的卡片（`lyteboatCards` 投影），工具结果的和准入回复的都在内，按日志顺序 |
| `turnParts(session, fromSeq)` | 把从 `fromSeq` 开始的一轮排成 `LyteboatTurnPart[]`（`{ kind: 'text', text }` 或 `{ kind: 'card', card }`）：每一步的回答文字按写出的顺序保留，immediate 卡放在它的结果到达的位置，回答里的 `[[card:<区域>]]` 换成这个区域的延迟卡，本轮正常结束时没放下的 `deferred` 卡跟在后面、`deferred_discard` 卡丢掉；只读日志，不写（`turn-parts.ts` `LyteboatTurnComposer`）。`lyteboat try` 的 stdout 就是它的结果 |
| `liveTurn()` | 一个 `LyteboatLiveTurn`，给边跑边出结果的调用方：按日志顺序喂会话事件（`event(event)`），中间喂流式的回答增量（`delta(text, step)`），每次返回新增的 part；`parts()` 是到目前为止的全部。同一段日志喂完，和 `turnParts` 的结果相同；例外是模型请求重试时，被放弃的那次已经流出的文字会留下（`live-turn.ts`）。`/chat` 用它出流（§4.13） |

包导出的纯函数（`lyteboat/plugins/a2ui/src/index.ts`）：`cardsPresentationMeta(cards)`（`cards-projection.ts`）、`cardMarker(area)`（`turn-parts.ts`）、`validateFullPayload(payload, { strict?, log?, catalog? })`（`contract.ts`，默认目录见 §2.9）。

一个工具结果的卡片放在 `meta.lyteboat.cards`，每张是 `LyteboatResultCard`，`emission` 为 `'immediate' | 'deferred' | 'deferred_discard'`（`lyteboat/core/contracts/src/index.ts` `LyteboatCardEmission`、`LyteboatResultCard`）；准入判定的卡片形状相同，放在人类消息的 `source.lyteboatRequest.intake.cards`。两处都按 contracts 的 zod schema 读，信封不合 schema 时投影抛错（`cards-projection.ts` `preparedCardsOf`）。

卡片目录：`template.json`（必需）、`manifest.yaml`（`emission_mode`，只能是三个值之一；`paths.<key>`：`kind: state`，带 `path` 和 `default`；`kind: transform`，带 `spec`；`kind: computed`，带 `fn` 和 `args`，`"state:<path>"` 形式的参数先解析；另有 `args`，给 `render_a2ui` 的 `template_args`）、`business_hierarchy.yaml`（`default`、`hierarchies.<name>: { root, ui_ids }`）、`compute.js`（ES 模块：computed 函数的具名导出，以及只给 `render_a2ui` 用的 `digest(raw, flat)` 钩子；只有默认导出时加载失败）（`loader.ts` `loadBundle`）。

### 7.4 技能 frontmatter

```yaml
---
name: kebab-case-name          # 必填，/^[a-z0-9]+(?:-[a-z0-9]+)*$/
description: WHAT + WHEN + 关键词 + 邻居边界   # 必填，路由器选技能的依据；技能目录里截到 500 字符
whenToUse: …                   # 可选
disable-model-invocation: false  # 可选，true 时路由器看不到它
user-invocable: true           # 可选
metadata:
  lyteboat:
    requiredTools: [tool_a, tool_b]   # 唯一的键；激活技能时激活这些工具，替换上一个技能的
---
```

技能正文以 `<skill_content name="…">` 的形式出现（`dsh/skill/skill/src/index.ts` `renderSkillContent`）。dynamic 模式下它是一条技能调用消息（`source` 为 `{ kind: 'skill-invocation', name, form: 'instructions' }`），skill-router 在 `agent/pre-step` 里追加；切换技能时，这条消息的正文前面多一句 `Skill "<上一个技能>" is no longer active; follow the skill below instead.`（`lyteboat/plugins/skill-router/src/index.ts` `invocationMessage`）。full 模式下它在 `lyteboat:skills` 段里；模型用 `skill` 工具加载时，它作为那次 `tool/result` 的文本出现（§3.3）。`metadata.lyteboat` 由 `lyteboatSkillMetaSchema` 严格校验（`lyteboat/core/contracts/src/index.ts` `LyteboatSkillMeta`、`lyteboatSkillMetaSchema`，`lyteboat/plugins/skill-router/src/index.ts` `lyteboatSkillMeta`）。

### 7.5 intake 和 pre-assemble

类型由内核的 agent loop 声明（`dsh/core/agent-loop/src/lyteboat/step-hooks.ts` `LyteboatIntakeReply`、`LyteboatIntakeDecision`、`LyteboatStepPayload`），`@lyteboat/contracts` 以同样的名字 `LyteboatIntakeDecision`、`LyteboatIntakeReply`、`LyteboatStepPayload` 重新导出（`lyteboat/core/contracts/src/index.ts`）。下面是声明原文（节选，不是需要你新建的文件）：

```ts
export interface LyteboatIntakeReply {
  kind: 'reply'
  /** The deciding plugin; recorded as the assistant message's `model`. */
  plugin: string
  /** The reply's blocks. A tool call cannot be replied: nothing would execute it. */
  content: Exclude<ContentBlock, { type: 'tool-call' }>[]
}

/** An intake listener's verdict: let the step proceed, or answer it. */
export type LyteboatIntakeDecision = { kind: 'pass' } | LyteboatIntakeReply

/** Payload of the loop's pre-assembly events. */
export interface LyteboatStepPayload {
  agent: Agent
  /** The messages claimed for this step, before admission. */
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}
```

| 事件 | 签名 | 默认 `next()` | 什么时候用 |
|---|---|---|---|
| `lyteboat/intake` | `(payload: LyteboatStepPayload, next) => Promise<LyteboatIntakeDecision>` | `{ kind: 'pass' }` | 更底层的拒识或固定回复，不请求模型，也不在请求上留判定。请求级的准入用 `ctx.intakeGuard`（§2.11、§7.8）；intake-guard 自己就是这个事件的一个监听，在 `next()` 之后作答 |
| `lyteboat/pre-assemble` | `(payload: LyteboatStepPayload, next) => Promise<void>` | 什么也不做 | 在本步组装 prompt 之前激活工具、路由（写法：§4.4） |

两者都注册为内核扩展 `agent-loop-intake` / `agent-loop-pre-assemble`（`dsh-compat/contract/extensions.yml`），都按 agent 作用域过滤：挂在 agent 作用域里的监听器只收到自己 agent 的事件（`step-hooks.ts` `declare module '@deepseek-ai/cordis'`）。之后 dsh 自己还派发一个 waterfall `agent/pre-step`，默认结果是本步认领的消息加上 runtime context；skill-router 在它的 `next()` 之后追加技能调用消息（`dsh/core/agent-loop/src/agent.ts` `ReactLoopAgent.preStep`，§3.1）。

### 7.6 投影（`lyteboat/core/contracts/src/index.ts`）

| key | 值 | 读法 |
|---|---|---|
| `lyteboatState` | 累积的工具状态 | `ctx.sessionProjections.stateOf(agent.session, 'lyteboatState')`（`render_a2ui` 就这样取数，`lyteboat/plugins/a2ui/src/index.ts` `A2uiService.registerRenderTool`） |
| `lyteboatCards` | `LyteboatCard[]`（`callId`、`surfaceId`、`area`、`emission`、`payload`），工具结果的卡和准入回复的卡都在内 | `ctx.a2ui.cardsOf(agent)`；一轮怎么显示用 `ctx.a2ui.turnParts` |
| `lyteboatActiveSkill` | 折叠状态 `{ active, loading }`，对外的视图是 `string \| null` | `ctx.skillRouter.activeOf(agent)` |
| `lyteboatRequest` | `{ requests, context, intake, owner }`：带请求的人类消息数、会话当前的请求上下文、最近一次的准入判定（没有时为 `null`）、第一个请求记下的发起者 `{ kind: 'user' \| 'operator' \| 'system', id }`（没有时为 `null`） | `ctx.requestContext.contextOf(agent)` 读 `context` |

`lyteboatState`、`lyteboatCards`、`lyteboatActiveSkill` 的 `stateVersion` 是 1，`lyteboatRequest` 是 3。在 agent 行里直接用 `ctx.sessionProjections` 要补齐四处。宿主插件 `@lyteboat/request-context` 用的是同一套写法，下面各条附上它对应的文件。四处都在一份 policy-desk 的拷贝上实测过：

1. 行的 `inject` 加 `'sessionProjections'`（`lyteboat/plugins/request-context/src/index.ts`）。
2. `src` 里加 `import type {} from '@deepseek-ai/dsh-session-projection'`，把服务的类型声明合并进 `Context`。少了这一处，`tsc -b` 报 `error TS2339: Property 'sessionProjections' does not exist on type 'Context'.`。
3. `package.json` 的 `peerDependencies` 和 `devDependencies` 都加 `"@deepseek-ai/dsh-session-projection": "workspace:*"`（内核包，`lyteboat/plugins/request-context/package.json`）。少了这一处，类型检查照样通过（包已经提升到根 `node_modules`），但 `pnpm run lint` 里的 knip 报 `Unlisted dependencies`，指向那行 import。
4. `tsconfig.json` 的 `references` 加 `{ "path": "../../../dsh/session/session-projection" }`（`lyteboat/plugins/request-context/tsconfig.json`），`tsc -b` 才按依赖顺序构建（`CLAUDE.md`「Repository layout」）。

### 7.7 `@lyteboat/testing`

| 子路径 | 导出 | 说明 |
|---|---|---|
| `@lyteboat/testing` | `createLyteboatUnitHost(adapter, options?)` → `Context`；`followUpAndWait(agent, text \| message)`；`MockAdapter`、`textResponse`、`toolCallResponse`、`maxTokensResponse`；`mountDshTestServices(ctx, options?)` | 单元宿主：不变量注册表、dsh 服务、内核 agent loop、`mock` provider，测试结束时释放；要测的 lyteboat 服务由测试自己挂（`lyteboat/tooling/testing/src/index.ts`）。`MockAdapter` 按脚本逐次应答，并记录每次请求（`mock-adapter.ts`） |
| `@lyteboat/testing/scratch` | `createLyteboatScratch(name)` → `{ root, run(label, files?), remove() }`；`lyteboatTempDir(name)` → 目录路径 | 每个测试文件的临时目录树：`run(label)` 给出干净的 `home` 和 `workspace`（工作区里放一个 `README.md`），同一个 label 再调会重建（`scratch.ts`）。`lyteboatTempDir` 在系统临时目录下建一个空的 `lyteboat-<name>-*`，正在跑的测试结束时（vitest 的 `onTestFinished`）连同内容删掉，所以只能在测试体里调，不能在 `beforeEach`、`beforeAll` 或 `describe` 体里调 |
| `@lyteboat/testing/composition` | `bootComposition({ bundles, args, cwd, env, home?, patches?, timeoutMs? })` → `{ code, home, stdout, stderr }`；`startComposition(同样的参数)` → `{ home, exited, stdout(), stderr(), waitForStdout(pattern), stop() }`；`LYTEBOAT_TRY_BUNDLES`、`LYTEBOAT_SERVE_BUNDLES`、`LYTEBOAT_EVAL_BUNDLES`、`LYTEBOAT_WEB_BUNDLES`、`LYTEBOAT_STUDIO_BUNDLES`、`LYTEBOAT_INSPECT_BUNDLES`；`pluginFileRow(file)`；`printedSessionId(stderr)` | 进程内启动组合；profile 跳过了要求的 bundle 时失败；`bootComposition` 等树请求退出，`startComposition` 在服务跑着时就返回，测试调完它再 `stop()`；`pluginFileRow` 相当于 `--plugin`（`composition.ts`） |
| `@lyteboat/testing/chat-client` | `postChat(url, body, { token? })` → `{ status, body }`；`streamChat(url, body, { token?, onOpen?, onFrame? })` → `{ status, frames, keepAlives, refusal }` | 调 `/chat` 的测试客户端：一个 JSON 回答，或逐帧读 enterprise 事件流；`onFrame` 的 `leave()` 模拟调用方断开（`lyteboat/tooling/testing/src/chat-client.ts`） |
| `@lyteboat/testing/scripted-model` | `startScriptedModel(script, { apiKey? })` → `{ baseURL, requests, loopRequests(), close() }`；`withTitle(script)`；`scriptedModelEnv(model)` | `RecordedRequest`：`purpose`（`loop`/`title`/`router`，agent 自己的旁路调用也记成 `loop`）、`body`、`lastUser`、`latestMessage`（最后一条 user 消息里最后一个不是 dsh 运行时上下文快照 `Current runtime context.` 的文本块，即调用方最后写的话）、`systemText`、`toolNames`、`calledTools`；回复为 `{ text }` 或 `{ toolCall: { name, arguments, id? } }`，脚本也可以返回 Promise，在它落定之前压住回答（`scripted-model.ts`）。`scriptedModelEnv` 给出 `DEEPSEEK_BASE_URL`（`${baseURL}/v1`）、`DEEPSEEK_API_KEY`（`mock-key`）、`DSH_TELEMETRY_DISABLED` |
| `@lyteboat/testing/session-log` | `findSessionLogs(home)`、`readSessionLog(path)`、`waitForSessionLog(home, sessionId, until, { timeout?, interval? })`、`eventTypes(records)`、`normalizeSessionLog(records, options)` | 找、读（逐帧解压）、归一化会话日志（`session-log.ts`）；`waitForSessionLog` 用 vitest 的 `vi.waitFor` 轮询这个会话的日志，直到 `until` 成立，默认最多 10 秒、每 50 毫秒读一次 |
| `@lyteboat/testing/json-lines` | `readJsonLines(file)` | 按行解析 JSON Lines 文件的每个非空行：评测的 `results.jsonl`、Studio 的审计日志、运行指标的日文件；会话日志仍走 `session-log` |
| `@lyteboat/testing/session-reopen` | `reopenRefusal(records)` | dsh 的持久化拒绝重开这份日志的原因；能重开时为 `undefined`（`session-reopen.ts`） |
| `@lyteboat/testing/process` | `lyteboatLauncher(bin)` → `{ runLyteboat(args, { env, cwd, timeoutMs }), startLyteboat(…) }` | 派生构建好的 CLI；`env` 里值为 `undefined` 的键会从子进程环境里删掉（`lyteboat/tooling/testing/src/process.ts` `childEnv`） |

### 7.8 请求上下文、准入、旁路调用

三个宿主服务都由 `@lyteboat/host` 挂好（`lyteboat/bundles/host/cordis.patch.yml`）。agent 行要用哪个，就把服务名写进 `inject`：

| 服务（`inject` 里的名字） | 包，目录 | 成员 |
|---|---|---|
| `requestContext` | `@lyteboat/request-context`，`lyteboat/plugins/request-context` | `message(text, request)`：把一条人类消息连同请求（`requestId?`、`owner?`、`agent?`、`traceId?`、`context?`、`intake?`）写成 user 消息，什么都不带时 `source` 就是 `{ kind: 'user' }`；`requestOf(message)`：读回消息带的请求，信封不合 schema 时抛错；`contextOf(agent)`：会话当前的请求上下文，没有时为 `{}` |
| `intakeGuard` | `@lyteboat/intake-guard`，`lyteboat/plugins/intake-guard` | `register({ name, admit })`：在调用方作用域登记准入函数，近的作用域优先，返回 disposer；`admissionFor(agent)`：这个 agent 用哪个准入函数；`submit(agent, { text, context?, requestId?, owner?, agent? }, signal)`：准入，再把请求写成人类消息 `followup` 给 agent，返回记下的判定，没有准入函数时为 `undefined`；空的 `context` 和不带一样，沿用会话的上下文；准入期间 `signal` 中止时什么也不交给 agent |
| `auxLlm` | `@lyteboat/aux-llm`，`lyteboat/plugins/aux-llm` | `generate({ agent, purpose, route?, system, prompt, maxTokens, temperature?, timeoutMs, signal })`：发一次旁路调用，返回 `{ kind: 'answer', text, route, durationMs }` 或 `{ kind: 'failed', reason, message, durationMs }`，并追加一条可忽略的 `lyteboat/aux-llm-call` |

类型：

- 准入函数 `LyteboatAdmission` 是 `{ name, admit(input) }`，`input` 为 `LyteboatAdmissionInput`：`{ agent, text, context, signal }`，`admit` 返回不带 `by` 的判定（`lyteboat/plugins/intake-guard/src/index.ts`）。
- 判定 `LyteboatIntakeVerdict` 是 `{ by, decision: 'pass' | 'reply', verdict?, text?, cards? }`；请求 `LyteboatRequest` 是 `{ requestId?, owner?, traceId?, agent?, context?, intake? }`，`agent` 是请求发给的 agent 的身份 `LyteboatAgentIdentity`：`{ id, version?, digest }`（§4.16）；发起者 `LyteboatRequestOwner` 是 `{ kind: 'user' | 'operator' | 'system', id }`（`/chat` 记 `user`，`lyteboat web` 的页面和命令行记 `operator`，评测记 `system`；和 dsh 的 `source.kind: 'user'` 是两回事）；`lyteboatRequest` 投影的状态 `LyteboatRequestState` 是 `{ requests, context, intake, owner }`（`lyteboat/core/contracts/src/index.ts` `LyteboatAgentIdentity`、`lyteboatAgentIdentitySchema`）。contracts 同时导出它们的 zod schema（`lyteboatIntakeVerdictSchema`、`lyteboatRequestSchema`……），lyteboat 的读者按它们解析日志里的信封。
- 旁路调用的记录 `LyteboatAuxLlmCallRecord`：`purpose`、`route`、`system`、`prompt`、`maxTokens`、`temperature`、`reasoningEffort?`、`output?`（成功时）、`failure?`（失败时，`reason` 为 `timeout`、`max-tokens` 或错误名）、`durationMs`（`lyteboat/core/contracts/src/index.ts`）。`temperature` 默认 0。没有可用的模型时返回 `reason: 'no-route'`，什么都不发，也不记；调用方自己的 `signal` 中止时直接抛出，也不记（`lyteboat/plugins/aux-llm/src/index.ts` `AuxLlmService.generate`）。

在 agent 里声明它们，照金融智能体写（`examples/agents/finance/src/agent.ts` `inject`，以及同目录的 `package.json`、`tsconfig.json`）：

| 服务 | `src` 里的类型 import | `package.json`（`peerDependencies` 和 `devDependencies` 各一次） | `tsconfig.json` 的 `references` |
|---|---|---|---|
| `requestContext` | `import type {} from '@lyteboat/request-context'` | `"@lyteboat/request-context": "workspace:*"` | `{ "path": "../../../lyteboat/plugins/request-context" }` |
| `intakeGuard` | `import type {} from '@lyteboat/intake-guard'`，或者 import 它导出的 `LyteboatAdmission` 类型 | `"@lyteboat/intake-guard": "workspace:*"` | `{ "path": "../../../lyteboat/plugins/intake-guard" }` |
| `auxLlm` | `import type {} from '@lyteboat/aux-llm'`，或者 import 它导出的 `AuxLlmService` 类型 | `"@lyteboat/aux-llm": "workspace:*"` | `{ "path": "../../../lyteboat/plugins/aux-llm" }` |

工具读请求上下文的现成写法：金融智能体的工具从 `ctx.requestContext.contextOf(agent)` 取客户 id，取不到就让工具失败（`examples/agents/finance/src/agent.ts` `apply`）。
