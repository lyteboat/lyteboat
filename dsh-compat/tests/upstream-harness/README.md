# G2: upstream's kernel tests, unmodified

`pnpm run test` runs every `dsh/<group>/<package>/tests/**/*.spec.ts` in the vitest project `dsh`. The test files are upstream's, byte for byte, as the last import wrote them; nothing in this repository edits them. They pass against lyteboat's kernel sources, or the gate fails.

Upstream runs these tests inside its monorepo, with a resolution facade that maps every `@deepseek-ai/*` package to its TypeScript source and with cordis compiled from source. lyteboat installs the packages outside the kernel from npm, so `harness.ts` rebuilds that environment. These are all the differences:

| Adaptation | Why |
|---|---|
| Kernel package names and export subpaths resolve to `dsh/<dir>/src/…` | A test imports its own package both relatively (`../src/errors.ts`) and by name; one module instance, as upstream has it, keeps `instanceof` and service identity intact. |
| Every other `@deepseek-ai/*` package is inlined (processed by vite) | So its own imports of kernel packages take the same route, instead of loading the published kernel bundles beside the sources. It also makes their exports spyable, as `request-freeze.spec.ts` needs (`vi.spyOn` on `dsh-util-values`). |
| `@deepseek-ai/cordis` resolves to the published build plus runtime objects for its `declare const enum`s (`FiberState`, `LoggerLevel`), read from its `.d.ts` | The kernel sources read `FiberState.*`; upstream compiles against cordis sources, where the enum exists at runtime; the published build erases it. |
| `../../../settings/settings/tests/live-config.ts` → `shims/live-config.ts` | `agent-loop/tests/settings.spec.ts` imports a helper from another package's tests; the file is copied here (MIT, same tag). |
| `@deepseek-ai/dsh-llm-pi-ai/src/context.ts` → `shims/pi-context.ts` | `agent-loop/tests/system-prompt-admission.spec.ts` imports an unexported source file of a package lyteboat installs from npm; the shim derives the two facts the test reads. |
| `../../../settings/settings/tests/configuration-fixture.ts` → `shims/configuration-fixture.ts` | `session-controller/tests/session-models.host.spec.ts` imports a helper from another package's tests; the file is copied here (MIT, same tag), with the settings plugin taken from the published package. |
| `@deepseek-ai/dsh-subagent/src/projection.ts` → `shims/subagent-projection.ts` | Three `session-controller` specs import an unexported source file of a package lyteboat installs from npm; the shim re-exports the same module from the published package's compiled `lib/types/projection.js`. |
| TypeScript sources with standard decorators are lowered with `ts.transpileModule` before vite parses them | `dsh-llm`'s source uses standard decorators (`@Remote`), which vite's parser leaves in place; upstream's vitest runs the same lowering (`standardDecoratorPlugin` in its `vitest.shared.ts`). |
| Each test file runs from a directory whose `packages/` links to `dsh/` (`setup.ts`) | Upstream's tests address fixtures from the repository root as `packages/<group>/<package>/…`. |
| `fast-check` and `js-yaml` are root devDependencies | Upstream's property tests import `fast-check`, and `dsh-base`'s bundle spec parses its patch with `js-yaml`, both from upstream's root manifest. |
| `test-invariants.ts` globs companions under `dsh/` | Upstream's invariant host, otherwise unchanged (see below). |

Excluded (`UPSTREAM_TEST_EXCLUDES` in `harness.ts`): the tests of upstream's repository tooling rather than the package, and the browser-face specs (`tests/**/*.client.spec.ts`) of every kernel package that carries its browser face as published (`scripts/dist/client-face.ts`); those run in upstream's DOM lane against the browser build, which lyteboat neither builds nor changes. The tooling tests are:

- `dsh/core/tools/tests/gen-tool-catalog.spec.ts`: upstream's `scripts/gen-tool-catalog.ts`.
- `dsh/core/session/tests/gen-persistence-catalog.spec.ts`: upstream's `scripts/gen-persistence-catalog.ts`; the overlay `persistence` gate runs that script on lyteboat's sources instead.
- `dsh/core/agent/tests/verify-export-jsdoc.spec.ts`: upstream's `scripts/verify-export-jsdoc.ts`, a repository lint.

Upstream's invariant host runs too: `test-invariants.ts` is upstream's `scripts/test-invariants.ts` with the companion glob and the owner match pointed at `dsh/` (its header lists the changes). Every ordinary cordis root a test creates gets the invariant service and the companion of the package under test. Upstream's DOM and proxy-environment setup files are not carried: the kernel's client code is carried as published and its specs are excluded, and no kernel test reads the proxy environment.

A new adaptation needs a line in this table and must leave the test files untouched. If a test cannot run without an edit, exclude it with a reason, and let the overlay gate (`scripts/dist/overlay.ts`), which runs in upstream's own repository, cover it.
