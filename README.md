# 轻舟 lyteboat

[![CI](https://github.com/lyteboat/lyteboat/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lyteboat/lyteboat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**中文** | [English](README.en.md)

> **轻舟智能体底座 —— 赋能行业穿越 AI 万重山。**

轻舟（lyteboat）是构建在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）之上的业务智能体底座。它不是 coding agent，而是生产级就绪、开箱即用的业务 harness：让 AI 能干活、干得对、有迹可查。

- [为什么是轻舟](#为什么是轻舟)
- [特性](#特性)
- [快速开始](#快速开始)
- [使用](#使用)
- [文档](#文档)
- [项目结构](#项目结构)
- [开发](#开发)
- [状态与路线图](#状态与路线图)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 为什么是轻舟

大模型是发动机，不是收割机。发动机再强，不装上专用设备就不收粮食。

今天各行业面临的局面完全一样：模型能力已不是瓶颈，把模型接进真实业务、跑通最后一公里才是。最后一公里里没有新算法，只有一件件具体的事：模型在哪一步该看到哪些工具，业务状态以谁为准，结果怎样以业务界面交到用户手里，出了问题怎样还原模型当时看到了什么。每个行业团队都要把这些重新做一遍。

轻舟把这最后一公里做成一套可复用的垂域智能体底座。行业团队加上业务技能、业务工具和卡片模板，就能得到一个上得了生产的智能体。

## 特性

- **业务能力开箱即用。** 都以 Cordis 插件的形式挂在 dsh 的接缝上，框架包不含任何业务词汇：
  - 技能路由：`full` 把全部技能正文放进提示；`dynamic` 每轮用一次旁路模型调用选出技能，并在同一步生效；路由结果是 dsh 自己的技能调用消息，会话能重开、能续聊（`@lyteboat/skill-router`）。
  - 工具可见性、工具结果里的状态增量；agent 可以把它没有声明的继承工具一并隐藏（`@lyteboat/tool-policy`）。
  - A2UI 模板卡片：一个工具结果可以带多张卡，按发射模式立即出，或由回答里的 `[[card:区域]]` 标记放到位；卡片可以由 `render_a2ui` 工具出，也可以由 agent 自己的工具出（`@lyteboat/a2ui`）。
  - 请求上下文：一条请求带着自己的上下文和准入判定进日志，会话内沿用（`@lyteboat/request-context`）。
  - 准入前移：agent 登记准入函数，请求进循环前就放行或直接回复，回复可以带卡（`@lyteboat/intake-guard`）；底层的拒识钩子 `lyteboat/intake` 也可以直接用。
  - 旁路模型调用留痕：路由、分类这类旁路调用在会话里留下完整的 prompt 和回答（`@lyteboat/aux-llm`）。
  - 外部对话历史导入（`@lyteboat/history-import`）。
- **一个业务 agent 就是一个目录。** 在 `examples/agents/<id>/` 下写组合文件、技能、工具和卡片模板即可。
- **业务 agent 只拿到它自己声明的能力。** `lyteboat try`、`serve`、`eval` 三种业务模式都带业务底座（`@lyteboat/business-base`）：没有编码工具，没有沙箱和人工审批；模型请求里没有宿主的 persona、工作目录的 AGENTS.md 和本机装了哪些包。agent 要用的 dsh 工具和它的技能，写在它自己的组合里。
- **与 dsh 生态兼容。** 轻舟是 dsh 的一个发行版：它以原包名接管 dsh 内核 14 个包的源码（`dsh/`），官方包和社区插件不改一行就跑在轻舟的实现上。与所跟踪的 dsh 版本在协议、接口、行为上保持兼容，由 G1–G6 六道闸门证明（[`dsh-compat/`](dsh-compat/README.md)）。
- **有迹可查。** 模型看到的一切都能从会话日志还原；轻舟记录的事实都放在 dsh 已有的日志信封里。

## 快速开始

### 环境要求

- Node.js 22.19+ 或 24+
- pnpm 11.7（`corepack enable` 会按 `package.json` 取到钉住的版本）

### 安装与构建

```sh
git clone https://github.com/lyteboat/lyteboat.git
cd lyteboat
corepack enable
pnpm install
pnpm run build
```

启动器是 `lyteboat/apps/cli/lib/bin.js`，下文用 `lyteboat` 指代它，可以先设一个别名：

```sh
alias lyteboat="node $PWD/lyteboat/apps/cli/lib/bin.js"
```

### 配置模型

轻舟沿用 dsh 的模型配置：在环境变量或 `$LYTEBOAT_HOME/.env` 里设置 `DEEPSEEK_API_KEY`。`DEEPSEEK_BASE_URL` 可选，指向一个兼容 DeepSeek Anthropic Messages API 的端点。

旁路调用（技能路由、准入分类）用路由自己的默认推理强度；DeepSeek 默认先思考再作答，思考同样计入这次调用的 `maxTokens`。要让旁路调用直接作答，用一个 patch 文件给 `lyteboat-aux-llm` 行配上推理强度，运行时 `--patch` 叠上：

```yaml
- id: lyteboat-aux-llm
  config:
    reasoningEffort: 'off'    # 取值由路由的模型适配器定义，这是 DeepSeek 的
```

### 运行

```sh
lyteboat try --agents ./examples/agents --agent finance "什么是再平衡"   # 一次性任务：以一个 agent 作答，答完即退出
lyteboat try --agents ./examples/agents --agent finance --context '{"customer":"young-idle-cash"}' "看看我的资产"   # 金融智能体：请求上下文指明客户
lyteboat serve --agents ./examples/agents                      # HTTP 服务：POST /chat，同步或 enterprise 流式
lyteboat eval --agents ./examples/agents --agent finance       # 跑 agent 的评测用例，逐轮检查
lyteboat release --agents ./examples/agents --agent finance    # 按基线检查 agent，写下发布锁 agent.release.json
lyteboat inspect --agents ./examples/agents --agent finance    # 挂上 agent，打印它由什么组成：工具、技能与检查、用例文件
lyteboat serve --release ./examples/agents/finance/agent.release.json   # 只服务发布过的那个 agent
lyteboat web --agents ./examples/agents --no-open              # 浏览器界面：dsh web 加轻舟的页面
lyteboat studio account add admin --role admin < pw.txt        # Studio 工作台的第一个账户，口令从标准输入读
lyteboat studio --agents ./examples/agents                     # Studio 工作台：只查看 agent，不跑会话
```

## 使用

### 命令

| 命令 | 作用 |
|---|---|
| `lyteboat try [选项] "任务"` | 回答一个任务，打印结果后退出（profile `try`）；不带 `--agent` 时模型只有 `skill` 工具，用来试插件、做快速检查，不是编码助手 |
| `lyteboat serve [选项]` | 把 `--agents` 目录里的全部 agent 以 HTTP 服务出去（profile `serve`）：`POST /chat`、`GET /agents`、`GET /health` |
| `lyteboat eval [选项]` | 跑一个 agent 的评测用例并逐轮检查（profile `eval`）；`lyteboat eval compare <前> <后>` 比较两次运行 |
| `lyteboat release [选项]` | 让一个 agent 过发布闸门，通过就写下它的发布锁 `<agent>/agent.release.json`（profile `eval`，同 `lyteboat eval release`）；`--agents`、`--agent` 必填；通过退出 0，被拒退出 1 并在 stderr 说明是哪一步 |
| `lyteboat inspect [选项]` | 按业务模式的样子挂上一个 agent，打印它由什么组成：工具（怎样到达模型）、技能及每个技能的检查、评测用例文件（profile `inspect`）；不建 agent 实例，不调模型；挂上退出 0，挂不上退出 1 并说明原因 |
| `lyteboat web [选项]` | 启动浏览器界面（profile `web`）：dsh web 加轻舟的 Agents、Evals 页面和会话右侧栏的 lyteboat 页签；`--agents`（可重复，目录一变就重新声明）、`--agent`（新会话默认用的 agent），其余参数同 dsh web；`lyteboat web --help` |
| `lyteboat studio [选项]` | 启动 Studio 工作台（profile `studio`）：只查看 agent，不建也不续会话；用自己的账户与角色（admin、editor、viewer）或经授权网关登录；页面在 `/studio/`（登录、agent 雷达、Users、System，agent 工作台的概览、技能、工具、会话，看板，以及在独立窗口 `/studio/evals` 里的评测），API 在 `/api/studio`；`lyteboat studio account add \| set-password \| remove \| list` 管账户，口令从标准输入读；`lyteboat studio --help` |
| `lyteboat config dump [选项]` | 打印组合后的插件树并退出；`--default` 只看 bundle 层 |

八个命令都接受：

| 选项 | 作用 |
|---|---|
| `--profile <名字>` | 启动 `$LYTEBOAT_HOME/profiles` 下的哪个 profile |
| `--patch <路径>` | 在 profile 层之后再叠一层 patch（可重复） |
| `--plugin <文件>` | 把一个本地 ESM 插件文件插进插件树（可重复） |

`lyteboat try` 另有：

| 选项 | 作用 |
|---|---|
| `--agents <目录>` | 存放 agent 的目录（可重复） |
| `--agent <id>` | 运行其中的某个 agent |
| `--history <文件>` | 先导入一份外部对话历史，任务成为它的下一轮 |
| `--session-id <id>` | 在已存的会话上续聊；每次运行都把会话 id 打到 stderr |
| `--context <json>` | 请求上下文：一个 JSON 对象，内联或放在文件里；随请求落日志，工具读取，模型看不到 |
| `--result <格式>` | `text`（默认：回答原文，每张卡片一行 `[card <区域>]`）或 `json`（这一轮打成一个 JSON 对象：结局、正文、卡片、工具、技能、模型、会话 id） |

`lyteboat try -h` 列出一次性模式的全部参数。

`lyteboat inspect` 另有：

| 选项 | 作用 |
|---|---|
| `--agents <目录>` | 存放 agent 的目录（可重复，至少一个） |
| `--agent <id>` | 要看的 agent（必填）；没有目录装着它，或参数不对，退出 2 |
| `--result <格式>` | `text`（默认）或 `json`（一个 JSON 对象） |

`lyteboat serve` 另有：

| 选项 | 作用 |
|---|---|
| `--agents <目录>` | 存放 agent 的目录（可重复）；其中每个 agent 都能被 `/chat` 调用 |
| `--release <文件>` | 代替 `--agents`：agent 的发布锁 `<agent>/agent.release.json`（可重复）；只服务锁里的 agent，它的目录内容、版本、模型或内核的 dsh 版本和锁对不上就不启动 |
| `--host <地址>` | `127.0.0.1`（默认）或 `0.0.0.0` |
| `--port <端口>` | 默认 8080；0 由系统挑一个空闲端口 |
| `--auth <方式>` | `none`（默认，只能配 `127.0.0.1`）或 `shared-secret`（`Authorization: Bearer <密钥>`） |
| `--secret-env <变量名>` | 存放共享密钥的环境变量，默认 `LYTEBOAT_CHAT_SECRET` |

`lyteboat studio` 另有：

| 选项 | 作用 |
|---|---|
| `--agents <目录>` | 要查看的 agent 目录（可重复，至少一个）；目录一变就重新读 |
| `--host <地址>` | `127.0.0.1`（默认）或 `0.0.0.0`（须同时给 `--trusted-host`） |
| `--port <端口>` | 默认 8090；0 由系统挑一个空闲端口 |
| `--trusted-host <名字>` | 人们访问 Studio 用的主机名，或 `名字:端口`（可重复）；回环地址之外，API（`/api/studio`）只认这些 Host 头，其余回 421；页面本身不含数据，对任何 Host 都一样 |
| `--gateway-secret-env <变量名>` | 网关模式：授权网关在每个请求上带这个变量的值和用户 id，缺了或不对回 401；第一次出现的身份自动成为 viewer |
| `--admin <用户 id>` | 网关模式：启动时把这个用户设为 admin（可重复） |
| `--anonymous-viewer` | 账户模式：不带令牌的请求按匿名 viewer 处理（只能配 `127.0.0.1`） |
| `--trace-link <URL>` | 追踪界面里一条 trace 的地址，`{trace_id}` 处填 trace id |

账户模式下没有任何账户时 Studio 不启动，并提示用 `lyteboat studio account add` 建第一个。账户、角色、令牌密钥和审计日志在 `$LYTEBOAT_HOME/studio/`，文件权限 0600；和 serve 同一个系统用户运行时，serve 也读得到它们。

`/chat` 的请求体：

```json
{ "agent_id": "finance", "user_id": "u-1", "message": "看看我的资产",
  "session_id": "可选：续聊", "message_id": "可选：幂等键", "trace_id": "可选",
  "stream": false, "context": { "customer": "young-idle-cash" } }
```

`lyteboat eval` 另有：

| 选项 | 作用 |
|---|---|
| `--agents <目录>`、`--agent <id>` | 用例对着哪个 agent 跑（都必填） |
| `--cases <路径>` | 用例文件或目录（可重复）；默认是 agent 目录下的 `evals/` |
| `--case <id>` | 只跑这些 id 的用例（可重复）；用例文件里没有这个 id 就跑不起来 |
| `--run-id <id>` | 运行目录的名字（`$LYTEBOAT_HOME/evals` 下），已存在就是用法错误；默认是开始时间加 4 位十六进制 |
| `--model real\|replay` | `real`（默认）调模型并录下每个用例的会话；`replay` 按 `--from` 那次运行的录音回放，不调模型、不要 key |
| `--from <运行>` | 回放哪次运行：它的目录，或 `$LYTEBOAT_HOME/evals` 下的运行 id |

每个用例是一个新会话，逐轮经 session-controller 提交（和 `/chat` 同一条路），一轮结束后从会话里读出激活的技能、调用的工具、出的卡片、结局、正文和主循环的模型调用次数，按用例里写的 `expect` 逐项检查。结果写在 `$LYTEBOAT_HOME/evals/<运行 id>/`：`run.json`、`results.jsonl`（每轮一行，不含耗时，同一份录音回放出来逐行相同）、`sessions/`（real 模式的录音）、`report.md`。全部通过退出 0，有检查失败退出 1，跑不起来（用例文件不合法、没有录音）退出 2。用例的写法见 [`examples/agents/finance/evals/cases.yml`](examples/agents/finance/evals/cases.yml)。

`lyteboat release`（即 `lyteboat eval release`）检查：`agent.yml` 声明了版本和模型；`evals/baseline` 是这个 agent 在这个模型上的一次真实运行；在当前构建上回放它，每一轮都和录下的一样并且全部通过；没有已有的锁用同一个版本发布过别的内容。通过就写 `<agent>/agent.release.json`，交给 `lyteboat serve --release` 服务。锁不覆盖轻舟自己的代码，所以要用发布它的同一个构建去服务。完整步骤见[开发业务 agent](docs/03-agent-development.md) §4.16。

不带 `stream` 时返回一个 JSON：`session_id`、`message_id`、`outcome`（`completed`、`tool_stopped`、`rejected`、`stopped_by_limit`、`aborted`、`errored`）、`response`、`cards`（`area`、`surface_id`、`a2ui`）、`tool_calls`。`"stream": true` 时返回 enterprise 事件流（SSE，AGUI 信封）：`run_started`，至多一对 `reasoning_*`（思考增量与工具调用），至多一对 `text_message_*`（文字增量，卡片以 `ui_protocol: "A2UI"` 插在正文标记的位置），最后恰好一个 `run_finished` 或 `run_error`；空闲时每 15 秒发一次 `: keep-alive`。会话属于第一次创建它的 `user_id`：别的用户的会话，以及不是经 `/chat` 建的会话（`lyteboat web`、命令行、评测建的），都按不存在处理（404）；同一会话里重复的 `message_id` 返回 409；同一会话的消息排队依次作答；流式连接断开会取消这条消息正在跑的那一轮。

### 编写业务 agent

一个业务 agent 是一个目录 `examples/agents/<id>/`，目录名就是 id。业务 agent 不属于发行版：它建在 `lyteboat/` 之上，`lyteboat/` 里没有任何包依赖它。

- `agent.cordis.yml`（必需）：persona、技能路由、工具与策略等插件行；每一行只作用于这个 agent 的会话。要用的 dsh 工具（例如 `@deepseek-ai/dsh-tool-todo`）也在这里列一行：业务模式除了 dsh 的 `skill` 工具，不给 agent 它没声明的工具。
- `agent.yml`（可选）：清单，名字、描述、排序等展示信息，以及版本（`version`）和评测用的模型（`model`）；未知键加载时报错。
- `assets/`：运行时读的非代码文件，与 `src/`、`lib/` 同级：`skills/`（每个技能一个 `SKILL.md`）、`a2ui/`（卡片模板）、`sample-data/`（示例数据）。
- `src/`：业务代码，编译到 `lib/`，由组合文件里的 `./lib/x.js` 行加载。
- `evals/`：评测用例（`lyteboat eval` 默认读这里）和一份真模型录下的基线，组合测试免 key 回放它。

完整步骤和一个可运行的例子见[开发业务 agent](docs/03-agent-development.md)，现成的示例是 [`examples/agents/finance`](examples/agents/finance)：一个刻意做到最小、只为跑通端到端流程的金融智能体。

### 数据与会话日志

- 轻舟的全部数据在 `$LYTEBOAT_HOME` 下（默认 `~/.lyteboat`）。启动器在加载任何 dsh 包之前把它导出为 `DSH_HOME`、把其中的 `.agents` 导出为 `DSH_AGENTS_HOME`，不会碰你自己的 `~/.dsh` 和 `~/.agents`。
- 每个 agent 有自己的工作目录 `$LYTEBOAT_HOME/agent-workdirs/<id>`：`/chat`、评测和 `lyteboat try --agent` 的会话都记在它下面，不管进程从哪个目录启动，所以 `lyteboat try --agent <id> --session-id <会话>` 在任何目录都能续聊；不带 `--agent` 的 `lyteboat try` 仍在启动它的目录里跑。
- 每条请求记着是谁发的：`/chat` 记 `user:<user_id>`，`lyteboat web` 的 lyteboat 页签记 `operator:web`，`lyteboat try` 记 `operator:cli`，评测记 `system:eval`。
- 会话日志是唯一的事实来源。卡片和状态增量记在 `tool/result.meta.lyteboat` 上，请求上下文和准入判定记在人类消息的 `source.lyteboatRequest` 上，路由选中的技能是 dsh 自己的技能调用消息，拒识回复是 `source.provider` 为 `lyteboat` 的助手消息，导入的历史是一串已关闭的普通 turn；旁路调用的审计 `lyteboat/aux-llm-call` 标为可忽略。所以这些会话可以被 dsh 自己的持久化层重新打开。
- `@lyteboat/host` 关掉了 dsh-base 的 `session-log-deepseek` 行：模型服务只收到请求本身。

## 文档

| 文档 | 内容 |
|---|---|
| [架构](docs/01-architecture.md) | 轻舟的架构：C4 分层、启动时序、生命周期与依赖注入、一次请求的流程、会话日志 |
| [发行版](docs/02-distribution.md) | 发行版机制：内核与上游线、同步步骤、改动分类、晋升、各道闸门怎么跑、分支与通道、版本与钉法 |
| [开发业务 agent](docs/03-agent-development.md) | 业务 agent 开发指南：从零写一个 agent 的目录、组合、技能、工具、策略、卡片、准入、测试与运行 |
| [参考实现对齐分析](docs/04-reference-alignment.md) | 与参考实现的对齐分析和后续计划：参考实现的哪些能力要引入，怎样在保留 dsh 能力的前提下落到轻舟上 |
| [兼容性承诺](dsh-compat/COMPAT.md)、[闸门总表](dsh-compat/README.md) | 轻舟对 dsh 插件的承诺，以及证明它的 G1–G6 |
| [CLAUDE.md](CLAUDE.md) | 在本仓库工作的约定：分层、提交、测试、同步规则 |
| [CHANGELOG](CHANGELOG.md) | 轻舟提供的全部能力；轻舟没有发过版 |

## 项目结构

```
dsh/                  内核：dsh/kernel.json 列出的 14 个 dsh 包，沿用 @deepseek-ai/* 包名
lyteboat/             轻舟自己的 29 个包，每层一个目录
  apps/               进程：lyteboat 启动器
  bundles/            组合：每个 profile 都带的 host，业务模式、Studio 与 inspect 共用的 business-base，lyteboat try、serve、eval、web、studio、inspect 各自的 bundle
  plugins/            能力插件
  core/               声明
  tooling/            测试支撑
examples/agents/      业务 agent 示例，建在发行版之上
dsh-compat/           兼容性承诺与证明：契约快照、扩展登记、G2/G4/G5/G6 测试
scripts/              分层检查、版本钉检查、敏感词检查；dist/ 是发行版工具
docs/                 文档
dsh.upstream.json     所跟踪的 dsh 版本
```

依赖只能向下：`apps` → `bundles` → `plugins` → `core`；`examples` 只依赖 `plugins` 与 `core`（测试另可用 `apps`、`bundles`、`tooling`），发行版里没有包依赖它；`tooling` 只给测试用。`pnpm run lint` 会检查。

| 路径 | 包 | 作用 |
|---|---|---|
| `lyteboat/apps/cli` | `@lyteboat/cli` | `lyteboat` 启动器：profile 模板、patch 叠加、启动（改编自 dsh 的 CLI） |
| `lyteboat/bundles/host` | `@lyteboat/host` | 每个 profile 都带的宿主 bundle：发行版标记与各能力插件的服务行 |
| `lyteboat/bundles/business-base` | `@lyteboat/business-base` | 业务模式的底座，try、serve、eval、studio、inspect 五个 profile 都带（web 不带），只有一个 patch：关掉编码工具和只为它们服务的行，关掉沙箱、审批与权限，关掉工作区 AGENTS.md、本机包清单、插件管理、会话标题的旁路请求；不挂宿主的默认技能目录，不加宿主的 persona 和 harness 身份段 |
| `lyteboat/bundles/try` | `@lyteboat/try` | `lyteboat try` 背后的一次性 bundle：任务、`--agent`、`--agents`、`--history`、`--session-id`、`--context`；请求进循环前先准入，输出按轮组合卡片 |
| `lyteboat/bundles/eval` | `@lyteboat/eval` | `lyteboat eval` 背后的 bundle：只声明选中的 agent，挂上 session-controller（不带 Web 界面）和 eval-runner，跑完按结果退出 |
| `lyteboat/bundles/web` | `@lyteboat/web` | `lyteboat web` 背后的 bundle：在 dsh web 之上声明 `--agents` 里的全部 agent（目录变了就重载，挂不上的在 Agents 页报原因），挂上轻舟的页面，关掉 dsh 自带的编码 preset；把 dsh web 挪进 preset 的 agent 层放回宿主。不带业务底座，保留 dsh 自己的能力，所以会话不按 `/chat` 的方式跑 |
| `lyteboat/bundles/serve` | `@lyteboat/serve` | `lyteboat serve` 背后的服务 bundle：声明 `--agents` 里的全部 agent，挂上 dsh 的 session-controller（不带 Web 界面）、`/chat` 和运行指标记录器 |
| `lyteboat/bundles/inspect` | `@lyteboat/inspect` | `lyteboat inspect` 背后的 bundle：带业务底座，按 try、serve、eval 的样子挂上一个 agent（挂不上就报原因，退出码 1），用 agent-inspector 与评测记录读出它的工具（怎样到达模型）、技能及每个技能的检查、用例文件，打印成文字或一个 JSON 对象（`--result json`）；不建 agent 实例，不调模型 |
| `lyteboat/bundles/studio` | `@lyteboat/studio` | `lyteboat studio` 背后的 bundle：带业务底座，agent 的工具和技能按 serve 的样子挂上；声明 `--agents` 里的全部 agent（目录变了就重载），挂上 agent-inspector、session-index、运行指标读取器、评测记录、studio-auth、studio-api 与 studio-web；不挂 session-controller，Studio 不建也不续会话，它起的评测运行是 `lyteboat eval` 子进程；`account` 子命令管账户 |
| `lyteboat/plugins/distro` | `@lyteboat/distro` | `lyteboatDistro` 服务：内核来自哪个 dsh 版本、这次构建带了哪些内核扩展 |
| `lyteboat/plugins/tool-policy` | `@lyteboat/tool-policy` | 工具可见性、状态增量；`./agent` 在 agent 的组合文件里声明策略，`inherited: visible \| hidden` 决定没有声明点名的继承工具是否可见；`visible(scope)` 回答一个新 agent 在某个常驻作用域下、激活之前看得到的工具 |
| `lyteboat/plugins/aux-llm` | `@lyteboat/aux-llm` | 旁路模型调用（技能路由、准入分类）：各自带超时，每次调用在会话里留一条可忽略的审计记录；在 `maxTokens` 处截断的回答算失败；`reasoningEffort` 配置旁路调用请求的推理强度 |
| `lyteboat/plugins/request-context` | `@lyteboat/request-context` | 请求上下文：一条人类消息所回应的请求（请求 id、发起者、上下文、准入判定）记在它自己的 source 上；`lyteboatRequest` 投影保存会话的上下文和发起者 |
| `lyteboat/plugins/intake-guard` | `@lyteboat/intake-guard` | 准入前移：agent 登记准入函数，调用方用 `submit` 提交每个请求，先准入，再把请求连同判定记进会话；循环里按记录的回复判定直接作答，没有经过准入的消息在循环内补做 |
| `lyteboat/plugins/skill-router` | `@lyteboat/skill-router` | 技能加载模式与模型路由（`historyWindow`、`timeoutMs`、`maxTokens` 可配）；`./agent` 在 agent 的组合文件里声明模式 |
| `lyteboat/plugins/a2ui` | `@lyteboat/a2ui` | A2UI 模板引擎、`render_a2ui` 工具、`lyteboatCards` 投影；一个结果可带多张卡，按出卡模式（立即、延迟、延迟丢弃）和正文里的 `[[card:<区域>]]` 标记排进一轮（`turnParts`）；`./agent` 在组合文件里挂上这个工具，agent 自己的工具用 `renderCard`、`cardsPresentationMeta`、`cardMarker` 出卡；默认组件目录不含业务词汇 |
| `lyteboat/plugins/history-import` | `@lyteboat/history-import` | 外部对话历史的解析，以及 `lyteboat try --history` 用的会话种子 |
| `lyteboat/plugins/agent-inspector` | `@lyteboat/agent-inspector` | 查看一个 agent 由什么组成，不建 agent 实例、不写盘：从它的常驻作用域读出工具（怎样到达模型、哪些技能要求它）、技能与路由方式，以及每个技能的确定性检查；Studio 和 `lyteboat inspect` 用它 |
| `lyteboat/plugins/session-index` | `@lyteboat/session-index` | 只读地列出、查找一个 agent 存下的会话（按它的工作目录，不拿写所有权），把一个会话折成时间线或原样读出；Studio 的会话页用它 |
| `lyteboat/plugins/run-metrics` | `@lyteboat/run-metrics` | 运行指标：记录器（serve 挂）每轮结束后往 `$LYTEBOAT_HOME/run-metrics/<日期>.jsonl` 追加一行，并写正在运行的轮次的心跳，不进模型请求也不进会话日志；读取器（`./reader`）给 Studio 的看板用 |
| `lyteboat/plugins/agent-catalog` | `@lyteboat/agent-catalog` | agent 目录：扫描 agent 根目录，把每个 agent 声明成 dsh preset，给出它的工作目录，报告挂载失败的 agent；`reload()` 按根目录现在的内容重新声明，`watch` 时目录一变就自动重载 |
| `lyteboat/plugins/chat-api` | `@lyteboat/chat-api` | `/chat`：业务调用方的入口。消息经 dsh 的 session-controller 进会话，请求（owner、trace id、上下文）记在人类消息上；回答是一个 JSON 或 enterprise 事件流，卡片放在正文标记处；共享密钥鉴权、会话归属、重复 `message_id` 检查、断连取消；agent 行可以登记帧装饰器给帧加字段 |
| `lyteboat/plugins/eval-runner` | `@lyteboat/eval-runner` | 评测：读用例（YAML，严格校验），每个用例一个新会话、逐轮经 session-controller 提交，从会话日志读出每轮的表现并检查；real 模式录下会话，replay 模式不调模型、按录音回放；写出运行结果与报告，比较两次运行；`./records` 给 Studio 读磁盘上的运行与用例文件 |
| `lyteboat/plugins/web-pages` | `@lyteboat/web-pages` | 轻舟在 dsh web 里的页面：Agents（列表、挂载失败的原因、重载）、Evals（运行列表与报告），以及会话右侧栏的 lyteboat 页签：带请求上下文发一条消息，实时显示会话的激活技能、请求、卡片、状态；Host 面在 dsh 连接的 `/api/lyteboat/<端点>` 上回答页面 |
| `lyteboat/plugins/studio-auth` | `@lyteboat/studio-auth` | Studio 的登录：运维用命令建的账户（scrypt 口令）、admin/editor/viewer 角色授予（不能改自己的角色，至少留一个 admin）、签名令牌、网关模式（共享密钥头加用户 id 头）、登录限流（同一用户名与来源连续 5 次失败，锁 30 秒）；`./accounts` 给账户命令用 |
| `lyteboat/plugins/studio-web` | `@lyteboat/studio-web` | Studio 的页面：按原 Studio 移植的 React 单页应用（`src/client`，数据从 `/api/studio` 取），有 agent 雷达、agent 工作台（概览、技能、工具、会话）、看板和评测窗口；`pnpm run build` 用 Vite 构建到 `lib/web`，在 `/studio` 下以严格的 CSP 提供 |
| `lyteboat/plugins/studio-api` | `@lyteboat/studio-api` | Studio 的 HTTP API，挂在宿主 web server 的 `/api/studio`：Host 允许名单、按角色检查、请求体按 contracts 的 schema 严格校验；供登录、用户与角色、系统信息、agent 雷达与工作台、会话、看板和评测（运行是 `lyteboat eval` 子进程）使用，admin 能热修已有技能的 SKILL.md；每次改动写进审计日志 |
| `lyteboat/core/contracts` | `@lyteboat/contracts` | 轻舟在 dsh 接缝上的声明：工具与技能元数据、内核的 `lyteboat/*` 事件（再导出）、日志节点、投影键、提示词顺序、`LyteboatDistro`，以及所声明 JSON 类型的 zod schema；`./studio` 是 Studio API 的请求与回答类型，`./cli` 是 `lyteboat inspect` 与 `lyteboat try --result json` 输出的类型与 schema，以及模式 runner 的 id 表 |
| `examples/agents/finance` | `@lyteboat/agent-finance` | 金融智能体：刻意做到最小的示例业务 agent，只用公开理财常识。资产总览、按「100 减年龄」的配置诊断（两张卡）、三个概念的投资者教育，三个路由技能；请求进入循环前先准入（未授权出门槛卡、范围外拒识、投教与寒暄放行），客户由请求上下文指明 |
| `lyteboat/tooling/testing` | `@lyteboat/testing` | 测试支撑：单元宿主（dsh 不变量、dsh 服务、内核的 agent loop）与 `MockAdapter`、进程内组合启动（一次性的跑到退出，服务型的边跑边测）、每个测试文件的临时 home 与工作区、会话日志读取与重开检查、JSON Lines 文件读取、脚本化模型、`/chat` 测试客户端、启动器进程 |

## 开发

| 命令 | 作用 |
|---|---|
| `pnpm run build` | 编译全部包，并按上游方式打包内核 |
| `pnpm run test` | 构建、G1 契约检查、单元/组合/e2e 测试、上游内核测试（G2）；CI 跑的就是它 |
| `pnpm run lint` | oxlint、knip（依赖声明与无用导出）、分层检查、发行版清单检查、敏感词检查 |
| `pnpm run typecheck` | 源码与测试的类型检查 |
| `pnpm run dsh-compat` | G4–G6：在仓库外装官方版与轻舟两棵安装树做对比（需要联网） |
| `pnpm run check` | lint + test + dsh-compat |
| `pnpm run dist:delta` | 列出轻舟在所导入的 dsh tag 之上带了哪些改动 |

同步新的 dsh 版本、把包晋升进内核、跑 G3 与持久化闸门，见[发行版约定](docs/02-distribution.md)。

**在 Windows 上。** 仓库的 `.gitattributes` 让每个检出的文本都是 LF，和 dsh 自己的仓库一样：内核逐字节导入，Typert 源码摘要、agent 摘要和发布锁、发布闸门对基线的逐字比对、测试的金标都要在每台机器上看到同样的字节。Git for Windows 默认 `core.autocrlf=true`，在加这个文件之前克隆的仓库里文本还是 CRLF，先提交或暂存本地改动，再重新检出一次：`git rm -r --cached -q . && git reset --hard`。

### pnpm 设置为什么和常见项目不同

- **增删或移动工作区包之后，从干净的 `node_modules` 重装。** 增量 `pnpm install` 会留下过期的提升链接。
- **`publicHoistPattern: ['@deepseek-ai/*', '@lyteboat/*']`。** agent 的组合文件按裸包名引用插件行，从 agent 目录向上解析；组合测试从仓库根解析。在 pnpm 的隔离布局下，两者都只能在根 `node_modules` 找到 dsh 与轻舟的包。启动器自己则通过 dsh 的运行时解析，按 `lyteboat/apps/cli` 的依赖图找插件行。
- **`overrides`。** 每个内核包名都指向 `dsh/` 下的工作区副本，轻舟自己的包和依赖它的每个 npm 包都一样，所以依赖图里每个内核包只有一份，就是轻舟的。`rolldown` 固定在上游 lockfile 解析出的版本，内核打包才能和 npm 发布物逐字节相同。
- **`.pnpmfile.cjs`。** 发布的 dsh 包之间用 `^` 范围互相依赖，不钉的话会漂到比所跟踪 tag 更新的预发布版本。它不碰内核包名：它在 overrides 之后运行，会把 overrides 撤掉。
- **dsh peer 写精确版本。** 轻舟的包对非内核 dsh 包的 peer 写所跟踪版本的精确版本号，不写 `catalog:dsh`：dsh 启动时从磁盘上的清单读插件行的 dsh peer，pnpm 不会解析那里的 `catalog:`，对不上的行会被禁用。`scripts/upstream-pins.spec.ts` 保证它们等于 `dsh.upstream.json`。
- **`minimumReleaseAgeExclude`。** pnpm 11 拒绝安装发布不满一天的包；新钉的 dsh 版本按精确版本列在这里，发布满一天后可以删掉。
- **`allowBuilds`。** pnpm 11 默认拦截安装脚本；在 Linux/macOS 上只需要放行 node-pty 的 chmod。

## 状态与路线图

- 跟踪 dsh **0.1.7-rc.2**（`dsh.upstream.json`）。内核是它的导入，加上轻舟登记的四个扩展（`agent-loop-intake`、`agent-loop-pre-assemble`、`session-append-ignorable`、`session-controller-prompt-source`），上面所有闸门都对它通过。
- 提供八个命令：`lyteboat try`（一次性任务）、`serve`（`/chat` 服务）、`eval`（评测用例）、`release`（发布闸门与发布锁）、`inspect`（agent 由什么组成）、`web`（dsh web 加轻舟的页面）、`studio`（Studio 工作台）、`config dump`（组合后的插件树），以及它们背后的能力插件、金融智能体、发行版工具与 14 包内核、兼容性闸门 G1–G6。完整清单见 [CHANGELOG](CHANGELOG.md)。
- 已知限制：
  - `lyteboat web` 是 dsh web 加轻舟的页面，保留 dsh 自己的能力（编码工具、沙箱、审批），会话不按 `/chat` 的方式跑；要按 `/chat` 的样子调试 agent，用 `lyteboat eval` 或 `lyteboat try --agent`。`lyteboat web` 里经 dsh 自己的输入框发的消息不带请求上下文，要带就用 lyteboat 页签发；dsh 的对话里卡片只显示标记，卡片内容在页签里以 JSON 显示。
  - 业务模式的模型请求里还有几处宿主的痕迹：dsh 的技能调用消息带着技能目录的绝对路径；上下文压缩的摘要指令是按编码助手写的；persona 里的 `{{cwd}}` 渲染成服务器上的路径，业务 persona 不要用它。另外，启动器仍会读它启动目录里的 `.env`（留给运维放部署配置）。
  - 没有记忆和推荐问。旁路调用默认用 agent 自己的模型；技能路由可以在 `@lyteboat/skill-router/agent` 行里另指 provider 和 model，准入分类还不能单独指定。
- 后续计划见[参考实现对齐分析](docs/04-reference-alignment.md)。

## 参与贡献

- 先读 [CLAUDE.md](CLAUDE.md)：分层规则、测试要求、提交信息格式。`dsh/` 下的改动必须是带 `Dist-Change:` trailer 的分类提交；动 `dsh/` 之前先读[兼容性承诺](dsh-compat/COMPAT.md)。
- 提交前跑 `pnpm run lint`、`pnpm run typecheck`、`pnpm run test`；改了内核或兼容面，再跑 `pnpm run dsh-compat`。
- 仓库外的插件如果要用轻舟的扩展，声明 `inject: ['lyteboatDistro']`，这样它在官方 dsh 上不会加载。
- 合并 PR 请用 merge commit，不要 squash 或 rebase：上游线靠导入提交的 `Dist-Import` trailer 查找。

## 许可证

轻舟以 [MIT 许可证](LICENSE) 发布。`dsh/` 下的内核包，以及文件头标注 "Adapted from deepseek-ai/deepseek-harness" 的文件，保留 DeepSeek 的 MIT 版权声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 致谢

轻舟构建在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与它的 Cordis 插件系统之上。
