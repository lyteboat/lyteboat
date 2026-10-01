# lyteboat compatibility definition

lyteboat is a distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It owns the source of a set of dsh packages, the **kernel** (`dsh/kernel.json`), and keeps their published names, so every dsh package and every community plugin that imports them binds to lyteboat's implementation. This document states what lyteboat promises to those plugins, and names the check that holds each promise. It plays the role Android's CDD plays for the CTS: this file says what must hold; `scripts/dist/` and `dsh-compat/tests/` prove it.

## 1. Scope

For the dsh release pinned in `dsh.upstream.json` (`0.2.0-rc.2`), lyteboat promises that a plugin written against that release observes the same **protocol, interface, and behavior** from lyteboat's kernel as from the official packages, except where §4 lists an addition or §8 a distribution policy. Packages outside the kernel are installed from npm at the pinned version, unchanged; lyteboat's promise about them is only that it does not patch them.

## 2. Stable surface

Each item is snapshotted per release under `dsh-compat/contract/dsh-<version>/` and compared on every build by G1 (`scripts/dist/contract-check.ts`), or by the overlay gate where noted.

| Surface | Snapshot | Gate |
|---|---|---|
| Package names, export subpaths, exported names and their declarations (class and interface members one by one) | `api.json` | G1 |
| Module augmentations other than cordis `Context`/`Events` (`SessionEventMap`, `MessageSourceMap`, projection maps, …) | `api.json` › `augmentations` | G1 |
| Service keys on the cordis `Context` and their types | `services.json` | G1 |
| Cordis events, their dispatch mode (`emit` / `serial` / `parallel` / `waterfall`), and their signatures | `events.json` | G1 |
| Plugin `name`, `inject`, and schemastery `Config` of every entry point and exported plugin class | `config.json` | G1 |
| The durable-record vocabulary: session header, event envelopes, payload types, by upstream's own fingerprints | `persistence.json` | overlay `persistence` |
| The JSONL files a session writes, read by the other side | — | G6 (`dsh-compat/tests/roundtrip`) |

A key upstream has and lyteboat lacks always fails. A changed or added key fails unless `dsh-compat/contract/extensions.yml` registers it.

## 3. Behavior invariants

Every invariant is held by a test that runs against lyteboat's kernel. Upstream's own tests of the kernel packages run unmodified under G2 (`dsh/*/*/tests`, vitest project `dsh`); the test harness adaptations that make them run outside upstream's monorepo are listed in `dsh-compat/tests/upstream-harness/README.md`.

| Invariant | Held by |
|---|---|
| Anything that reaches a model request is reconstructable from the session log | G2 `dsh/core/agent-loop/tests/request-reconstruction.spec.ts`; the `agent-loop-invariant` companion |
| A step's requests append-extend the previous request; a new request series starts only when the admitted step asks for one | G2 `request-reconstruction.spec.ts` |
| `tool/call` is appended before `tools/pre-execute` runs; pipeline stages run once and in order | G2 `dsh/core/tools/tests/invariant.spec.ts`, `dsh/core/agent-loop/tests/tool-calls.spec.ts` |
| Waterfall events (`agent/pre-step`, `agent/request`, `tools/pre-execute`, …) short-circuit when a listener does not call `next()`, and see rewritten payloads in listener order | G2 `dsh/core/agent-loop/tests/interception.spec.ts` |
| A projection that ignores an event returns the same state reference | G2 `dsh/session/session-projection/tests/registry.spec.ts` |
| Persistence refuses a stored log with an event type outside the compiled catalog unless the event is `ignorable` | G2 `dsh/session/session-persistence-jsonl/tests`, overlay `persistence` |
| For the same scripted model, the same plugins, and the same default composition (the official release run with §8's policy), a session log written on lyteboat equals one written on the official release, event by event after normalization | G4 `dsh-compat/tests/scenarios` |
| Pinned community plugins that run on the official release run on lyteboat and write the same log | G5 `dsh-compat/tests/canaries` |
| A session lyteboat writes opens on the official release, and the reverse | G6 `dsh-compat/tests/roundtrip` |
| Official packages that depend on the kernel keep passing their own tests on lyteboat's kernel | G3 (overlay `g3`) |

## 4. What lyteboat adds

`dsh-compat/contract/extensions.yml` is the registry; this section is its reading guide. An extension only adds: a new export, event, option, or service. A plugin that does not use it cannot tell it exists. Each entry names the contract keys it adds (G1 accepts exactly those), the tests that prove it, and its exit condition: the upstream change that makes it redundant, after which the extension is removed at the next sync.

A third-party plugin that wants a lyteboat extension declares `inject: ['lyteboatDistro']` (the service `@lyteboat/distro` provides, listing this build's extensions by id) and imports the extension's types from `@lyteboat/contracts` (the step events and the one-shot's plans) or from the kernel package that carries it (`LyteboatAppendOptions` from `@deepseek-ai/dsh-session`, the `LyteboatHeadless*Plan` types from `@deepseek-ai/dsh-headless`). On the official release that service does not exist, so the plugin waits instead of calling an option that is not there.

## 5. Transitional interfaces

`compat` changes keep an interface upstream removed, for the community plugins the canaries show still use it. Each one states its expiry (a dsh release) here and in its `Dist-Exit` trailer. There are none.

## 6. Not promised

- Module structure inside a package, file names under `lib/`, and anything not reachable from a package's `exports`.
- Unexported symbols, and private or `#private` class members.
- Performance characteristics, timing, and the order of events the dispatch mode does not order.
- Caches and files other than the session log and the files dsh documents as persistent.
- The version string: lyteboat's packed builds carry `<upstream version>+lyteboat.<commit>`. semver ignores build metadata, so every peer range written against the upstream version matches.

## 7. Release channels

- **lyteboat-next** follows every sync: a sync merges the import of the tag it moves to and must pass G1–G6. Syncs are batched weekly; one sync may cross several tags.
- **lyteboat-stable** is cut only when lyteboat makes a release, and only from a sync onto a dsh release candidate (`-rc.N`) that passes G1–G6; afterwards it takes backports only. No stable channel has been cut: lyteboat has made no release.

## 8. Distribution policy

lyteboat sends nothing off the machine that its user did not send to a model. Where an upstream bundle's default composition does, the kernel's copy of that bundle turns the row off (`Dist-Change: policy`, a `cordis.patch.yml` edit and nothing else). A plugin sees the same interfaces; what changes is only which rows the default composition starts. A deployment that wants a row back lists it again in its own patch.

| Bundle | Row | What upstream sends, and where | Since |
|---|---|---|---|
| `@deepseek-ai/dsh-base` | `session-log-deepseek` | The session's canonical log, as the `dsh_session_log` field of every request to the official DeepSeek API | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-base` | `plugin-package-inventory-deepseek` | The installed plugin packages, as the `dsh_plugin_packages` field of every request to the official DeepSeek API | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-base` | `session-telemetry-otel` | A session-log prefix with an anonymous user id, to upstream's OpenTelemetry collector once a person gives feedback | 0.2.0-rc.2 |

The rows are turned off by patch entries appended after upstream's insert list in `dsh/bundle/base/cordis.patch.yml`; upstream's rows stay as written. `session-telemetry-otel` is OpenTelemetry's standard log export with a configurable endpoint (`exporter.url`, or `DSH_TELEMETRY_OTLP_URL`); when lyteboat runs a collector of its own, the row comes back pointed there.
