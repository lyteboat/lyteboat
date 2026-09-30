# dsh-compat

What lyteboat promises the plugins written against dsh, and the proof that it keeps the promise. No runtime code lives here.

- `COMPAT.md` states the promise for people: the stable surface, the behavior invariants, what lyteboat adds, what it does not promise.
- `contract/` states it for machines: the contract snapshot of each tracked release (`dsh-<version>/`) and `extensions.yml`, the registry of what lyteboat adds.
- `tests/` proves it, together with `scripts/dist`: `upstream-harness/` (G2), `scenarios/` (G4), `canaries/` (G5), `roundtrip/` (G6).

| Gate | What it proves | Where | How to run | When |
|---|---|---|---|---|
| G1 | lyteboat's kernel build has the release's contract; every difference is registered | `scripts/dist/contract-check.ts`, `contract/` | `pnpm run test` (after the build) | every change, CI |
| G2 | upstream's own tests of the kernel pass on lyteboat's sources, unmodified | `tests/upstream-harness/`, `dsh/*/*/tests` | `pnpm run test` (vitest project `dsh`) | every change, CI |
| G3 | the official packages that depend on the kernel still pass their tests on lyteboat's kernel | `scripts/dist/overlay.ts g3` | `pnpm run dist:overlay <installed upstream checkout at the tag> g3` | every sync |
| persistence | the durable-record schema upstream derives from lyteboat's sources equals the release's | `scripts/dist/overlay.ts persistence` | `pnpm run dist:overlay <checkout> persistence` | every sync, and any kernel change that can reach a persisted type |
| typert | the published Typert files lyteboat builds with (`lib/typert.*`) are what upstream's generator emits from lyteboat's sources, analyzing upstream's whole workspace | `scripts/dist/overlay.ts typert` | `pnpm run dist:overlay <checkout> typert` | every sync, and any change to a kernel package that publishes Typert files |
| G4 | the official release and lyteboat write the same session log for the same scripted run | `tests/scenarios/` | `pnpm run dsh-compat` | before a merge to lyteboat-next, every sync |
| G5 | pinned community plugins run the same on both, installed with `dsh plugin add`, and bind to lyteboat's kernel | `tests/canaries/` | `pnpm run dsh-compat` | before a merge to lyteboat-next, every sync |
| G6 | a session one side writes, the other continues exactly as the writer would | `tests/roundtrip/` | `pnpm run dsh-compat` | before a merge to lyteboat-next, every sync |

G4–G6 compare two install trees outside the repository (`scripts/dist/trees.ts`, under `$LYTEBOAT_DIST_CACHE`, default `~/.cache/lyteboat-dist`): the release as npm publishes it, and the same manifest with every kernel package replaced by lyteboat's packed build (`<version>+lyteboat.<commit>`). The trees differ only in the kernel, so a difference is the kernel's. Both run the official CLI (`dsh headless`) against upstream's mock model server (`@deepseek-ai/dsh-llm-mock-server`); logs are compared after `@lyteboat/testing`'s normalization, which drops timing values and replaces ids and paths. The trees need registry access on their first install; later runs reuse them while the kernel packs are unchanged.

## Canaries

`tests/canaries/canaries.yml` pins each canary by name and version and states how the list is chosen: from a community sample, ranked by the risk category a kernel change could break, at most three per category, and only plugins that install, activate every row, answer, and exit on the official release, because a canary that fails there says nothing about lyteboat. G5 runs every canary on the official release as well as on lyteboat, so the list is validated on the tracked release, 0.2.0-rc.2. The list is re-selected from the same sample when the tracked release moves; a canary that fails on the official release after a sync is replaced, and one that fails only on lyteboat is a G5 failure.

## Upstream tests

`tests/upstream-harness/README.md` lists every adaptation that lets upstream's kernel tests run outside upstream's monorepo, and every exclusion. The test files themselves are never edited.
