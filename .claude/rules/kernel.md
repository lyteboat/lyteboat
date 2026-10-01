---
paths:
  - "dsh/**"
  - "dsh-compat/**"
  - "scripts/dist/**"
  - "dsh.upstream.json"
  - ".pnpmfile.cjs"
  - "pnpm-workspace.yaml"
  - "docs/02-distribution.md"
---

# Kernel rules

These rules govern every change under `dsh/` and the compatibility contract. CLAUDE.md「Architecture boundaries」 names them; the text is here.

- **The kernel changes only by classified commits.** Every commit that touches `dsh/<group>/<package>/` carries `Dist-Change: backport | fix | extend | redesign | compat | drop | policy | build` and the trailer its class requires (`Dist-Upstream` for backport, `Dist-Tests` for fix and redesign, `Dist-Extension` for extend, `Dist-Exit` for compat and drop, `Dist-Policy` for policy), plus `Dist-Contract` and `Dist-Exit` wherever the contract or an exit condition is involved (`pnpm run dist:delta -- --check`). Keep hooks in upstream files to a few lines and put lyteboat's logic in `src/lyteboat/` and its tests in `tests/lyteboat/`; a smaller carried hunk is a cheaper sync.
- **A distribution policy changes composition, never code.** `Dist-Change: policy` turns off rows of an upstream bundle's default composition that send data off the machine (dsh-base's session-log upload, package inventory, and feedback telemetry), in that bundle's `cordis.patch.yml` and nowhere else (`dist:delta -- --check` refuses any other file). It is permanent, carries `Dist-Policy` saying what it turns off and why, and is listed in `dsh-compat/COMPAT.md` §8.
- **The contract only grows, by registration.** G1 compares lyteboat's build with `dsh-compat/contract/dsh-<version>/`: a removed export, member, event, service, or config field fails; an added or widened one fails unless `dsh-compat/contract/extensions.yml` registers it (with its tests and exit condition) and an `extend` commit names it. A plugin outside the repository that uses an extension injects `lyteboatDistro`. Persistence (the session event vocabulary) is held the same way by the overlay `persistence` gate.
- **Upstream's tests are never edited.** `dsh/*/*/tests` outside `tests/lyteboat/` are upstream's and run under G2 as imported; an environment difference is an adaptation in `dsh-compat/tests/upstream-harness` (listed in its README), a test that cannot run outside upstream is excluded there with a reason, and a behavior lyteboat changes on purpose is a `redesign`/`extend` whose upstream tests still pass.
- **Promotion.** A dsh package from npm enters the kernel the first time lyteboat must change its implementation (not configure it, not replace it with a provider), when it is a capability every lyteboat composition needs to start (model access, tools, skills, sessions), or when it is an upstream bundle whose default composition the distribution changes (a `policy`, as for `dsh-base`): add it to `dsh/kernel.json`, the overrides, and the root `tsconfig.json` references, switch every lyteboat reference to it to `workspace:*`, import the tag again, and it falls under G1–G3 from that commit. When its dependencies reach kernel packages as peers it does not declare itself, `packageExtensions` in `pnpm-workspace.yaml` adds those peers to it, or pnpm keeps a second copy of each such dependency for it alone. A package that publishes Typert files (`./typert`, `./remote`) brings them with the import: upstream's generator derives them from its whole workspace, so lyteboat builds with the published ones while the package's source is the imported source, and `pnpm run dist:overlay <checkout> typert --write` regenerates them when lyteboat changes it. A package with a browser face (`dsh.client` in its manifest) brings its published browser bundle and `./client` declarations the same way (`scripts/dist/client-face.ts`): lyteboat compiles and bundles only its Node face, excludes its browser-face specs from G2, and the build stops if `src/client/` changes.

## Commands

| Task | Command |
|---|---|
| G1 contract check (after a build) | `pnpm run contract:check` |
| Upstream's kernel tests only (G2) | `npx vitest run --project dsh` |
| What lyteboat carries on top of the tag | `pnpm run dist:delta` (`-- --check` for the trailer discipline only) |
| Snapshot a tag's contract | `pnpm run dist:snapshot <dsh checkout at the tag>` |
| Import a tag's kernel (then `git merge`) | `pnpm run dist:import <dsh checkout at the tag>` |
| Persistence and G3 gates | `pnpm run dist:overlay <installed dsh checkout at the tracked tag> persistence` / `g3` |
| Typert files against upstream's generator (`--write` regenerates) | `pnpm run dist:overlay <installed dsh checkout at the tracked tag> typert` |
