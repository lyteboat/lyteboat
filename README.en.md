# lyteboat

[![CI](https://github.com/lyteboat/lyteboat/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lyteboat/lyteboat/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文](README.md) | **English**

> **Harness for business, built on DeepSeek Harness.**

lyteboat (轻舟) is a harness for business agents built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It is not a coding agent: it is a production-ready, out-of-the-box harness that gets the work done, does it right, and leaves a trace.

- [Why lyteboat](#why-lyteboat)
- [Features](#features)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Documentation](#documentation)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Status and roadmap](#status-and-roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why lyteboat

The model is the engine, not the harvester: however strong the engine, it brings in no grain until a purpose-built header is mounted on it.

Every industry faces the same situation today. Model capability is no longer the bottleneck; wiring the model into real business and closing the last mile is. The last mile holds no new algorithm, only concrete questions: which tools the model sees at which step, whose business state is authoritative, how a result reaches the user as a business interface, and how to reconstruct what the model saw when something goes wrong. Every industry team answers them again from scratch.

lyteboat turns that last mile into a reusable chassis for vertical agents. A team adds its business skills, tools, and card templates and gets an agent that can go to production.

## Features

- **Business capabilities out of the box**, as Cordis plugins on dsh's seams; the framework packages carry no business vocabulary:
  - Skill routing: `full` puts every skill body in the prompt; `dynamic` picks a skill with a side model call each turn and applies it in the same step; the routed skill is dsh's own skill-invocation message, so the session reopens and continues (`@lyteboat/skill-router`).
  - Tool visibility and state deltas carried by tool results; an agent can hide every inherited tool it does not declare (`@lyteboat/tool-policy`).
  - A2UI template cards: a tool result can carry several, shown at once or placed where the answer writes a `[[card:<area>]]` marker, by emission mode; the `render_a2ui` tool renders them, and so can an agent's own tools (`@lyteboat/a2ui`).
  - Request context: a request enters the log with its own context and admission verdict, and the session keeps the context (`@lyteboat/request-context`).
  - Admission ahead of the loop: an agent registers an admission function that lets a request in or answers it before the loop, cards included (`@lyteboat/intake-guard`); the lower-level `lyteboat/intake` hook is available too.
  - Audited side calls: routing and classification calls leave their full prompt and answer in the session (`@lyteboat/aux-llm`).
  - Import of external conversation history (`@lyteboat/history-import`).
- **One business agent is one directory.** Write its composition file, skills, tools, and card templates under `examples/agents/<id>/`.
- **A business agent gets only what it declares.** The three business modes, `lyteboat try`, `serve`, and `eval`, all list the business base (`@lyteboat/business-base`): no coding tools, no sandbox, no human approval; no host persona, no working-directory AGENTS.md, and no list of the installed packages in model requests. The dsh tools an agent uses, and its skills, are written in its own composition.
- **Compatible with the dsh ecosystem.** lyteboat is a distribution of dsh: it owns the source of dsh's 14 kernel packages under their published names (`dsh/`), so official packages and community plugins run on lyteboat's implementation unchanged. It keeps the protocol, interfaces, and behavior of the dsh release it tracks, and six gates, G1–G6, prove it ([`dsh-compat/`](dsh-compat/README.md)).
- **Traceable.** Everything a model sees is reconstructable from the session log, and every fact lyteboat records rides an envelope dsh already knows.

## Quick start

### Requirements

- Node.js 22.19+ or 24+
- pnpm 11.7 (`corepack enable` picks up the version pinned in `package.json`)

### Install and build

```sh
git clone https://github.com/lyteboat/lyteboat.git
cd lyteboat
corepack enable
pnpm install
pnpm run build
```

The launcher is `lyteboat/apps/cli/lib/bin.js`; the examples below call it `lyteboat`:

```sh
alias lyteboat="node $PWD/lyteboat/apps/cli/lib/bin.js"
```

### Configure the model

lyteboat uses dsh's model settings: set `DEEPSEEK_API_KEY` in the environment or in `$LYTEBOAT_HOME/.env`. `DEEPSEEK_BASE_URL` is optional and points to an endpoint that speaks DeepSeek's Anthropic-compatible Messages API.

Side calls (skill routing, intake classification) use their route's default reasoning effort; DeepSeek thinks before it answers by default, and the thinking counts against the call's `maxTokens`. To have side calls answer directly, give the `lyteboat-aux-llm` row an effort in a patch file and add it with `--patch`:

```yaml
- id: lyteboat-aux-llm
  config:
    reasoningEffort: 'off'    # the route's model adapter defines the ids; this one is DeepSeek's
```

### Run

```sh
lyteboat try --agents ./examples/agents --agent finance "什么是再平衡"   # one-shot task as an agent: answer and exit
lyteboat try --agents ./examples/agents --agent finance --context '{"customer":"young-idle-cash"}' "看看我的资产"   # the finance agent: the request context names the customer
lyteboat serve --agents ./examples/agents                     # HTTP service: POST /chat, answered at once or as an enterprise stream
lyteboat eval --agents ./examples/agents --agent finance      # run an agent's eval cases and check every turn
lyteboat release --agents ./examples/agents --agent finance   # check an agent against its baseline and write its release lock
lyteboat inspect --agents ./examples/agents --agent finance   # mount an agent and print what it is made of: tools, skills and their checks, case files
lyteboat serve --release ./examples/agents/finance/agent.release.json   # serve only the agent the lock releases
lyteboat web --agents ./examples/agents --no-open             # browser UI: dsh web with lyteboat's pages
lyteboat studio account add admin --role admin < pw.txt       # the Studio workshop's first account; the password is read from stdin
lyteboat studio --agents ./examples/agents                    # the Studio workshop: inspects agents, runs no session
```

## Usage

### Commands

| Command | What it does |
|---|---|
| `lyteboat try [options] "task"` | Answers one task, prints the result, and exits (profile `try`); without `--agent` the model has the `skill` tool only, for plugin smoke tests and quick checks, not as a coding assistant |
| `lyteboat serve [options]` | Serves every agent of the `--agents` directories over HTTP (profile `serve`): `POST /chat`, `GET /agents`, `GET /health` |
| `lyteboat eval [options]` | Runs an agent's eval cases and checks every turn (profile `eval`); `lyteboat eval compare <before> <after>` compares two runs |
| `lyteboat release [options]` | Puts an agent through the release gate and, when it passes, writes its release lock `<agent>/agent.release.json` (profile `eval`, as `lyteboat eval release`); `--agents` and `--agent` are required; exits 0 when released, 1 when refused, naming the step on stderr |
| `lyteboat inspect [options]` | Mounts one agent as the business modes do and prints what it is made of: its tools (how each reaches the model), its skills with each skill's checks, and its eval case files (profile `inspect`); no agent instance, no model call; exits 0 when it mounts, 1 with the reason when it does not |
| `lyteboat web [options]` | Serves the browser UI (profile `web`): dsh web with lyteboat's Agents and Evals pages and the lyteboat tab of a session's right sidebar; `--agents` (repeatable, reloaded when a directory changes), `--agent` (the agent a new session runs), and dsh web's own flags; `lyteboat web --help` |
| `lyteboat studio [options]` | Serves the Studio workshop (profile `studio`): it inspects agents and never creates or continues a session; people sign in with Studio's own accounts and roles (admin, editor, viewer) or through an authorizing gateway; its pages are at `/studio/` (sign-in, the agent radar, Users, System, an agent's workspace with Overview, Skills, Tools, and Sessions, the Dashboard, and Evals in a window of their own at `/studio/evals`) and its API at `/api/studio`; `lyteboat studio account add \| set-password \| remove \| list` manages the accounts, reading a password from stdin; `lyteboat studio --help` |
| `lyteboat config dump [options]` | Prints the composed plugin tree and exits; `--default` shows the bundle layers only |

All eight accept:

| Option | What it does |
|---|---|
| `--profile <name>` | The profile under `$LYTEBOAT_HOME/profiles` to boot |
| `--patch <path>` | An extra patch layer applied after the profile layer (repeatable) |
| `--plugin <file>` | Inserts a local ESM plugin file as a row of the tree (repeatable) |

`lyteboat try` also takes:

| Option | What it does |
|---|---|
| `--agents <dir>` | A directory of agents (repeatable) |
| `--agent <id>` | Runs one agent from those directories |
| `--history <file>` | Imports external conversation history first; the task becomes its next turn |
| `--session-id <id>` | Continues a stored session; every run prints its session id to stderr |
| `--context <json>` | The request context: a JSON object, inline or in a file; logged with the request, read by tools, not shown to the model |
| `--result <format>` | `text` (the default: the answer, each card as a `[card <area>]` line) or `json` (the turn as one object: outcome, text, cards, tools, skill, model, session id) |

`lyteboat try -h` lists every flag of the one-shot mode.

`lyteboat inspect` also takes:

| Option | What it does |
|---|---|
| `--agents <dir>` | A directory of agents (repeatable, at least one) |
| `--agent <id>` | The agent to inspect (required); exits 2 when no directory holds it or a flag is wrong |
| `--result <format>` | `text` (the default) or `json` (one JSON object) |

`lyteboat serve` also takes:

| Option | What it does |
|---|---|
| `--agents <dir>` | A directory of agents (repeatable); `/chat` answers for every agent in it |
| `--release <file>` | Instead of `--agents`: an agent's release lock, `<agent>/agent.release.json` (repeatable); serves only the agent it releases, and refuses to start when the agent's files, version, or model, or the kernel's dsh release, differ from the lock |
| `--host <host>` | `127.0.0.1` (the default) or `0.0.0.0` |
| `--port <port>` | 8080 by default; 0 lets the OS pick a free port |
| `--auth <mode>` | `none` (the default, `127.0.0.1` only) or `shared-secret` (`Authorization: Bearer <secret>`) |
| `--secret-env <name>` | The environment variable that holds the shared secret; `LYTEBOAT_CHAT_SECRET` by default |

`lyteboat studio` also takes:

| Option | What it does |
|---|---|
| `--agents <dir>` | A directory of agents to inspect (repeatable, at least one); re-read when it changes |
| `--host <host>` | `127.0.0.1` (the default) or `0.0.0.0` (with `--trusted-host`) |
| `--port <port>` | 8090 by default; 0 lets the OS pick a free port |
| `--trusted-host <name>` | A host name people reach the Studio by, or `name:port` (repeatable); beside the loopback names the API (`/api/studio`) answers only these Host headers, any other gets 421; the pages hold no data and are the same for any Host |
| `--gateway-secret-env <name>` | Gateway mode: an authorizing gateway sends this variable's value and the user's id on every request, and a request without them gets 401; an identity seen for the first time becomes a viewer |
| `--admin <user-id>` | Gateway mode: makes this user an admin at startup (repeatable) |
| `--anonymous-viewer` | Account mode: a request without a token reads as an anonymous viewer (`127.0.0.1` only) |
| `--trace-link <url>` | The tracing UI's URL for one trace, with `{trace_id}` where the id goes |

In account mode a Studio without any account refuses to start and names `lyteboat studio account add`. Accounts, roles, the token secret, and the audit log live in `$LYTEBOAT_HOME/studio/`, mode 0600; serve can read them when it runs as the same system user.

A `/chat` request:

```json
{ "agent_id": "finance", "user_id": "u-1", "message": "看看我的资产",
  "session_id": "optional: continue a session", "message_id": "optional: idempotency key", "trace_id": "optional",
  "stream": false, "context": { "customer": "young-idle-cash" } }
```

`lyteboat eval` also takes:

| Option | What it does |
|---|---|
| `--agents <dir>`, `--agent <id>` | The agent the cases talk to (both required) |
| `--cases <path>` | A case file or a directory of them (repeatable); the agent directory's `evals/` by default |
| `--case <id>` | Runs only the cases with this id (repeatable); an id no case file holds fails the run |
| `--run-id <id>` | Names the run's directory under `$LYTEBOAT_HOME/evals`, which must not exist yet; the start time and four hex digits by default |
| `--model real\|replay` | `real` (the default) calls the model and records every case's session; `replay` plays back the run `--from` names, with no model and no key |
| `--from <run>` | The run a replay plays back: its directory, or its id under `$LYTEBOAT_HOME/evals` |

Every case is a new session whose turns go through the session controller (the path a `/chat` message takes). After each turn the session is read for the active skill, the tools called, the cards shown, the outcome, the answer text, and the loop's model calls, and each `expect` of the case is checked. A run is written to `$LYTEBOAT_HOME/evals/<run id>/`: `run.json`, `results.jsonl` (one line per turn and no timings, so one recording replays into the same lines), `sessions/` (a real run's recordings), and `report.md`. It exits 0 when every check passed, 1 when one failed, and 2 when it could not run (an invalid case file, a missing recording). [`examples/agents/finance/evals/cases.yml`](examples/agents/finance/evals/cases.yml) shows how cases are written.

`lyteboat release` (that is, `lyteboat eval release`) checks that `agent.yml` declares a version and a model; that `evals/baseline` is a real run of this agent on that model; that replaying it through this build shows every turn as recorded and passes; and that no existing lock releases the same version with other content. It then writes `<agent>/agent.release.json`, which `lyteboat serve --release` serves. The lock does not cover lyteboat's own code, so serve it with the build that released it. The steps are in the [agent development guide](docs/03-agent-development.md) §4.16.

Without `stream`, the answer is one JSON body: `session_id`, `message_id`, `outcome` (`completed`, `tool_stopped`, `rejected`, `stopped_by_limit`, `aborted`, `errored`), `response`, `cards` (`area`, `surface_id`, `a2ui`), and `tool_calls`. With `"stream": true` it is the enterprise event stream (SSE, AGUI envelopes): `run_started`, at most one `reasoning_*` pair (reasoning deltas and tool calls), at most one `text_message_*` pair (text deltas, with each card as a `ui_protocol: "A2UI"` frame where the answer marks it), and exactly one `run_finished` or `run_error`; an idle stream sends `: keep-alive` every 15 seconds. A session belongs to the `user_id` that created it: another user's session, and a session not started through `/chat` (from `lyteboat web`, the command line, or an eval), answers as one that does not exist (404); a repeated `message_id` in a session is refused with 409; a session's messages queue and are answered in turn; a stream whose caller disconnects cancels that message's running turn.

### Writing a business agent

A business agent is a directory `examples/agents/<id>/`, named by its id. Business agents are not part of the distribution: they build on `lyteboat/`, and nothing in `lyteboat/` depends on them.

- `agent.cordis.yml` (required): the plugin rows for persona, skill routing, tools, and policy; each row applies to this agent's sessions only. A dsh tool the agent uses (`@deepseek-ai/dsh-tool-todo`, say) is a row here too: besides dsh's `skill` tool, the business modes give an agent no tool it does not declare.
- `agent.yml` (optional): the manifest: display fields such as the name, plus the version (`version`) and the model it is evaluated on (`model`); an unknown key fails at load.
- `assets/`: the non-code files read at runtime, beside `src/` and `lib/`: `skills/` (one `SKILL.md` per skill), `a2ui/` (card templates), `sample-data/`.
- `src/`: business code, compiled to `lib/` and loaded by `./lib/x.js` rows of the composition file.
- `evals/`: eval cases (where `lyteboat eval` looks by default) and a baseline recorded against the real model, which the composition test replays without a key.

The [agent development guide](docs/03-agent-development.md) walks through every step with a runnable example; [`examples/agents/finance`](examples/agents/finance) is a working agent kept deliberately minimal, there to exercise the end-to-end flow.

### Data and session logs

- All lyteboat data lives under `$LYTEBOAT_HOME` (default `~/.lyteboat`). The launcher exports that directory as `DSH_HOME`, and its `.agents` as `DSH_AGENTS_HOME`, before any dsh package loads, so your own `~/.dsh` and `~/.agents` are never touched.
- Every agent has a working directory of its own, `$LYTEBOAT_HOME/agent-workdirs/<id>`: the sessions of `/chat`, of evals, and of `lyteboat try --agent` are recorded under it wherever the process started, so `lyteboat try --agent <id> --session-id <session>` continues a session from any directory; `lyteboat try` without `--agent` still runs in the directory it was started in.
- Every request records who sent it: `/chat` records `user:<user_id>`, `lyteboat web`'s lyteboat tab `operator:web`, `lyteboat try` `operator:cli`, and an eval run `system:eval`.
- The session log is the single source of truth. A card and a state delta sit on `tool/result.meta.lyteboat`, a request's context and admission verdict on the human message's `source.lyteboatRequest`, a routed skill is dsh's own skill-invocation message, an intake reply is an assistant message whose `source.provider` is `lyteboat`, and imported history is closed turns of ordinary nodes; the side-call audit `lyteboat/aux-llm-call` is marked ignorable. So these sessions reopen under dsh's own persistence.
- `@lyteboat/host` turns off dsh-base's `session-log-deepseek` row: the model provider receives the request and nothing else.

## Documentation

The guides are written in Chinese.

| Document | What it covers |
|---|---|
| [Architecture](docs/01-architecture.md) | lyteboat's architecture: C4 layers, the startup sequence, lifecycle and dependency injection, the flow of one request, the session log |
| [Distribution](docs/02-distribution.md) | The distribution machinery: the kernel and the upstream line, a sync step by step, change classes, promotion, how to run each gate, branches and channels, versions and pins |
| [Agent development](docs/03-agent-development.md) | The agent-development guide: building a business agent from scratch, its directory, composition, skills, tools, policy, cards, admission, tests, and running it |
| [Alignment with the reference implementation](docs/04-reference-alignment.md) | The reference-alignment analysis and forward plan: which capabilities of the reference implementation to bring in, and how they land on lyteboat while keeping dsh's capabilities |
| [Compatibility promise](dsh-compat/COMPAT.md), [gate list](dsh-compat/README.md) | What lyteboat promises dsh plugins, and the gates G1–G6 that prove it |
| [CLAUDE.md](CLAUDE.md) | How to work in this repository: layers, commits, tests, sync rules |
| [CHANGELOG](CHANGELOG.md) | Everything lyteboat provides; it has no releases |

## Repository layout

```
dsh/                  the kernel: the 14 dsh packages dsh/kernel.json lists, under their @deepseek-ai/* names
lyteboat/             lyteboat's 29 packages, one directory per layer
  apps/               processes: the lyteboat launcher
  bundles/            compositions: host (in every profile), business-base (in the business modes, the Studio, and inspect), and one each behind lyteboat try, serve, eval, web, studio, and inspect
  plugins/            capability plugins
  core/               declarations
  tooling/            test infrastructure
examples/agents/      example business agents, built on the distribution
dsh-compat/           the compatibility promise and its proof: contract snapshot, extension registry, G2/G4/G5/G6 tests
scripts/              layer, pin, and sensitive-word checks; dist/ holds the distribution tooling
docs/                 the guides
dsh.upstream.json     the tracked dsh release
```

Dependencies point down only: `apps` → `bundles` → `plugins` → `core`; `examples` depend on `plugins` and `core` only (their tests may also reach `apps`, `bundles`, `tooling`), and nothing in the distribution depends on them; `tooling` is for tests. `pnpm run lint` checks it.

| Path | Package | Role |
|---|---|---|
| `lyteboat/apps/cli` | `@lyteboat/cli` | The `lyteboat` launcher: profile templates, patch stack, boot (adapted from dsh's CLI) |
| `lyteboat/bundles/host` | `@lyteboat/host` | The host bundle every profile lists: the distribution marker and the capability plugins' service rows |
| `lyteboat/bundles/business-base` | `@lyteboat/business-base` | The business modes' base, listed by the try, serve, eval, studio, and inspect profiles (not by web), one patch and nothing else: the coding tools and the rows only they use off; sandbox, approval, and permissions off; the workspace's AGENTS.md, the package inventory, the plugin manager, and the session-title side call off; no default skill roots of the host, and no host persona or harness identity |
| `lyteboat/bundles/try` | `@lyteboat/try` | The one-shot bundle behind `lyteboat try`: task, `--agent`, `--agents`, `--history`, `--session-id`, `--context`; a request is admitted before the loop, and the output composes the turn's cards |
| `lyteboat/bundles/eval` | `@lyteboat/eval` | The bundle behind `lyteboat eval`: declares the one agent the cases talk to, mounts the session controller (without the web UI) and the eval runner, and exits with the run's result |
| `lyteboat/bundles/web` | `@lyteboat/web` | The bundle behind `lyteboat web`: over dsh web it declares every agent of the `--agents` directories (reloaded when a directory changes, a failure reported on the Agents page), mounts lyteboat's pages, and turns off dsh's coding presets; the agent plane dsh web moves behind its presets goes back on the host. It does not list the business base and keeps dsh's own capabilities, so a session does not run the way `/chat` runs it |
| `lyteboat/bundles/serve` | `@lyteboat/serve` | The service bundle behind `lyteboat serve`: declares every agent of the `--agents` directories, mounts dsh's session controller (without the web UI), `/chat`, and the run-metrics recorder |
| `lyteboat/bundles/inspect` | `@lyteboat/inspect` | The bundle behind `lyteboat inspect`: it lists the business base and mounts one agent as try, serve, and eval do (one that does not mount is reported with its reason, exit 1), reads its tools (how each reaches the model), its skills with each skill's checks, and its case files through agent-inspector and the eval records, and prints them as text or one JSON object (`--result json`); no agent instance, no model call |
| `lyteboat/bundles/studio` | `@lyteboat/studio` | The bundle behind `lyteboat studio`: it lists the business base, so an agent's tools and skills mount as serve mounts them; it declares every agent of the `--agents` directories (reloaded when a directory changes) and mounts agent-inspector, session-index, the run-metrics reader, the eval records, studio-auth, studio-api, and studio-web; no session controller, so the Studio never creates or continues a session, and an eval run it starts is a `lyteboat eval` process; its `account` commands manage the accounts |
| `lyteboat/plugins/distro` | `@lyteboat/distro` | The `lyteboatDistro` service: the dsh release the kernel came from and the kernel extensions this build carries |
| `lyteboat/plugins/tool-policy` | `@lyteboat/tool-policy` | Tool visibility and state deltas; `./agent` declares policy in an agent's composition file, and its `inherited: visible \| hidden` sets whether the inherited tools no declaration names are visible; `visible(scope)` answers the tools a new agent under a standing scope sees before anything is activated |
| `lyteboat/plugins/aux-llm` | `@lyteboat/aux-llm` | Side model calls (skill routing, intake classification), each under its own deadline and recorded in the session as an ignorable audit record; an answer cut off at `maxTokens` is a failure; `reasoningEffort` sets the effort side calls request |
| `lyteboat/plugins/request-context` | `@lyteboat/request-context` | The request context: the request a human message answers to (request id, owner, context, admission verdict) rides its own source; the `lyteboatRequest` projection keeps the session's context and owner |
| `lyteboat/plugins/intake-guard` | `@lyteboat/intake-guard` | Admission ahead of the loop: an agent registers an admission function, and the caller submits each request with `submit`, which admits it and records the request with its verdict; the loop answers a recorded reply verdict directly and admits in the loop what arrives unadmitted |
| `lyteboat/plugins/skill-router` | `@lyteboat/skill-router` | Skill load modes and model routing (`historyWindow`, `timeoutMs`, `maxTokens` configurable); `./agent` declares the mode in an agent's composition file |
| `lyteboat/plugins/a2ui` | `@lyteboat/a2ui` | The A2UI template engine, the `render_a2ui` tool, and the `lyteboatCards` projection; a result may carry several cards, laid into the turn by emission mode (immediate, deferred, deferred-discard) and the answer's `[[card:<area>]]` markers (`turnParts`); `./agent` mounts the tool from a composition file, and an agent's own tools render cards with `renderCard`, `cardsPresentationMeta`, and `cardMarker`; the default component catalog carries no business vocabulary |
| `lyteboat/plugins/history-import` | `@lyteboat/history-import` | Parsing of external conversation history and the session seed behind `lyteboat try --history` |
| `lyteboat/plugins/agent-inspector` | `@lyteboat/agent-inspector` | What an agent is made of, read from its standing scope without creating an agent instance or writing to disk: its tools (how each reaches the model, the skills that require it), its skills and routing, and each skill's deterministic checks; the Studio and `lyteboat inspect` use it |
| `lyteboat/plugins/session-index` | `@lyteboat/session-index` | An agent's stored sessions, read only (by its working directory, never taking a session's write ownership): listed, searched, folded into a timeline, or read as stored; the Studio's Sessions pages use it |
| `lyteboat/plugins/run-metrics` | `@lyteboat/run-metrics` | Run metrics: the recorder (mounted by serve) appends one line per turn to `$LYTEBOAT_HOME/run-metrics/<day>.jsonl` after it ends and keeps a heartbeat of the running turns, outside model requests and the session log; the reader (`./reader`) serves the Studio's Dashboard |
| `lyteboat/plugins/agent-catalog` | `@lyteboat/agent-catalog` | The agent catalog: scans agent roots, declares each agent as a dsh preset with its working directory, and reports the agents that fail to mount; `reload()` declares them again from what the roots hold now, and `watch` reloads whenever a root changes |
| `lyteboat/plugins/chat-api` | `@lyteboat/chat-api` | `/chat`, a business caller's entry: each message enters its session through dsh's session controller with its request (owner, trace id, context) on the human message; the answer is one JSON body or the enterprise event stream with its cards where the answer marks them; shared-secret auth, session ownership, duplicate `message_id` refusal, and cancellation when the caller leaves; an agent row may register a frame decorator that adds fields to its frames |
| `lyteboat/plugins/eval-runner` | `@lyteboat/eval-runner` | Evals: reads the cases (YAML, checked strictly), runs every case as a new session whose turns go through the session controller, and checks each turn from the session log; a real run records the sessions, a replay plays them back with no model; writes the run and its report and compares two runs; `./records` reads the runs and case files on disk for the Studio |
| `lyteboat/plugins/web-pages` | `@lyteboat/web-pages` | lyteboat's pages in dsh web: Agents (the list, why one failed to mount, a reload), Evals (the runs and their reports), and the lyteboat tab of a session's right sidebar, which sends a message with its request context and shows the session's active skill, request, cards, and state as they change; the Host face answers the pages at `/api/lyteboat/<endpoint>` on dsh's connection |
| `lyteboat/plugins/studio-auth` | `@lyteboat/studio-auth` | Studio's sign-in: accounts an operator makes from the command line (scrypt passwords), admin/editor/viewer role grants (nobody changes their own, the last admin stays one), signed tokens, gateway mode (a shared-secret header and a user-id header), and login throttling (five failures of one username from one address lock it for 30 seconds); `./accounts` serves the account commands |
| `lyteboat/plugins/studio-web` | `@lyteboat/studio-web` | Studio's pages: a React single-page app ported from the original Studio (`src/client`, its data from `/api/studio`) with the agent radar, an agent's workspace (Overview, Skills, Tools, Sessions), the Dashboard, and the Evals window; built by Vite into `lib/web` in `pnpm run build` and served at `/studio` under a strict CSP |
| `lyteboat/plugins/studio-api` | `@lyteboat/studio-api` | Studio's HTTP API at `/api/studio` on the host web server: a Host allowlist, role checks, and request bodies checked strictly against the contracts' schemas; it serves sign-in, users and roles, the System page, the agent radar and workspace, sessions, the Dashboard, and Evals (a run is a `lyteboat eval` process), and an admin's hot-fix of an existing skill's SKILL.md; every change is appended to an audit log |
| `lyteboat/core/contracts` | `@lyteboat/contracts` | lyteboat's declarations over the dsh seams: tool and skill metadata, the kernel's `lyteboat/*` events (re-exported), log nodes, projection keys, prompt orders, `LyteboatDistro`, and the zod schemas of the JSON types it declares; `./studio` holds the Studio API's requests and answers, and `./cli` the types and schemas of what `lyteboat inspect` and `lyteboat try --result json` print, and the mode runner ids |
| `examples/agents/finance` | `@lyteboat/agent-finance` | The finance agent, kept deliberately minimal and built from public financial knowledge only: an asset overview, an allocation diagnosis by the 100-minus-age rule (two cards), investor education on three concepts; three routed skills; requests are admitted before the loop (the unauthorized card, an out-of-scope reply, investor education and small talk always in), and the request context names the customer |
| `lyteboat/tooling/testing` | `@lyteboat/testing` | Test infrastructure: the unit host (dsh's invariants, the dsh services, the kernel's agent loop) and `MockAdapter`, in-process composition boots (a one-shot run until it exits, a service while the test talks to it), per-file scratch homes and workspaces, the session-log reader and its reopen check, a JSON Lines reader, the scripted model, a `/chat` test client, launcher processes |

## Development

| Command | What it does |
|---|---|
| `pnpm run build` | Builds every package and bundles the kernel the way upstream does |
| `pnpm run test` | Build, the G1 contract check, unit, composition, and e2e tests, upstream's kernel tests (G2); what CI runs |
| `pnpm run lint` | oxlint, knip (declared dependencies and dead exports), the layer check, the distribution manifest check, the sensitive-word check |
| `pnpm run typecheck` | Type-checks sources and tests |
| `pnpm run dsh-compat` | G4–G6: installs the official release and lyteboat side by side outside the repository and compares them (needs the network) |
| `pnpm run check` | lint + test + dsh-compat |
| `pnpm run dist:delta` | Lists what lyteboat carries on top of the imported dsh tag |

Syncing a new dsh release, promoting a package into the kernel, and running G3 and the persistence gate are covered in the [distribution conventions](docs/02-distribution.md).

**On Windows.** The repository's `.gitattributes` checks every text file out with LF, as dsh's own repository does: the kernel is imported byte for byte, and the Typert source digests, an agent's digest and release lock, the release gate's comparison with its baseline, and the test goldens must see the same bytes on every host. Git for Windows defaults to `core.autocrlf=true`, so a clone made before this file still holds CRLF text: commit or stash local work, then check it out once more with `git rm -r --cached -q . && git reset --hard`.

### Why the pnpm settings look unusual

- **Reinstall from a clean `node_modules` after adding or moving a workspace package.** An incremental `pnpm install` keeps stale hoisted links.
- **`publicHoistPattern: ['@deepseek-ai/*', '@lyteboat/*']`.** An agent's composition file names its rows by bare package name, resolved from the agent directory upward, and the composition tests resolve rows from the repository root; under pnpm's isolated layout both reach the dsh and lyteboat packages only at the root `node_modules`. The launcher itself resolves rows through dsh's runtime resolution of `lyteboat/apps/cli`'s dependency graph.
- **`overrides`.** Every kernel package name resolves to its workspace copy under `dsh/`, for lyteboat's packages and for every npm package that depends on it, so the graph holds one instance of each: lyteboat's. `rolldown` is held at the version upstream's lockfile resolves, so the kernel bundles build byte for byte as npm publishes them.
- **`.pnpmfile.cjs`.** Published dsh packages depend on each other with caret ranges, so an unpinned install drifts to a newer prerelease than the tracked tag. It leaves the kernel names alone: it runs after the overrides and would undo them.
- **dsh peers are exact versions.** A lyteboat package writes a non-kernel dsh peer as the tracked release's exact version, not `catalog:dsh`: dsh's startup admission reads a row's dsh peers from the manifest on disk, where pnpm never resolves `catalog:`, and disables a row whose peers it cannot match. `scripts/upstream-pins.spec.ts` keeps them equal to `dsh.upstream.json`.
- **`minimumReleaseAgeExclude`.** pnpm 11 refuses packages younger than a day; a dsh release pinned on its first day is listed there by exact version, and the entries can go once the release has aged.
- **`allowBuilds`.** pnpm 11 blocks install scripts unless listed; only node-pty's helper chmod is needed on Linux and macOS.

## Status and roadmap

- Tracks dsh **0.1.7-rc.2** (`dsh.upstream.json`). The kernel is its import plus lyteboat's four registered extensions (`agent-loop-intake`, `agent-loop-pre-assemble`, `session-append-ignorable`, `session-controller-prompt-source`), and every gate above passes against it.
- Provides eight commands: `lyteboat try` (a one-shot task), `serve` (the `/chat` service), `eval` (eval cases), `release` (the release gate and lock), `inspect` (what an agent is made of), `web` (dsh web with lyteboat's pages), `studio` (the Studio workshop), and `config dump` (the composed plugin tree), with the capability plugins behind them, the finance agent, the distribution tooling and the 14-package kernel, and the compatibility gates G1–G6. The [CHANGELOG](CHANGELOG.md) has the full list.
- Known limitations:
  - `lyteboat web` is dsh web with lyteboat's pages and keeps dsh's own capabilities (coding tools, sandbox, approval), so its sessions do not run the way `/chat` runs them; to debug an agent as `/chat` runs it, use `lyteboat eval` or `lyteboat try --agent`. A message sent from dsh's own composer in `lyteboat web` carries no request context; the lyteboat tab sends one that does. dsh's conversation shows a card as its marker only; the tab shows the cards as JSON.
  - A business mode's model requests still carry a few traces of the host: dsh's skill-invocation message names the skill's absolute directory; the compaction summarizer's instructions are written for a coding assistant; `{{cwd}}` in a persona renders the server's path, so a business persona should not use it. The launcher also still reads a `.env` in the directory it starts in (kept for the operator's deployment settings).
  - There is no memory and there are no suggested questions. Side calls use the agent's own model by default; skill routing can name its own provider and model in the `@lyteboat/skill-router/agent` row, intake classification cannot yet.
- What comes next: the forward plan in the [alignment analysis](docs/04-reference-alignment.md).

## Contributing

- Read [CLAUDE.md](CLAUDE.md) first: layer rules, test requirements, commit message format. A change under `dsh/` is a classified commit with a `Dist-Change:` trailer; read the [compatibility promise](dsh-compat/COMPAT.md) before touching `dsh/`.
- Before committing, run `pnpm run lint`, `pnpm run typecheck`, and `pnpm run test`; after a kernel or compatibility change, also `pnpm run dsh-compat`.
- A plugin outside this repository that uses a lyteboat extension declares `inject: ['lyteboatDistro']`, so it stays unloaded on the official release.
- Merge pull requests with a merge commit, not a squash or a rebase: the upstream line is found through the `Dist-Import` trailer of the import commits.

## License

lyteboat is released under the [MIT License](LICENSE). The kernel packages under `dsh/` and the files marked "Adapted from deepseek-ai/deepseek-harness" keep DeepSeek's MIT copyright notice; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

lyteboat is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and its Cordis plugin system.
