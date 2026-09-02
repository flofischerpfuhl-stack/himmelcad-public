# Verification tiers

The verifier selects tests from changed paths, workspace dependencies and risk.
It unions tasks by stable ID, so a gate runs at most once per invocation, and
writes durations to `.build/verify/timings.json`. Timings explain cost; they
never suppress a required gate.

| Tier    | Command                                     | Purpose                                                                                                                                                |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| changed | `pnpm verify:changed`                       | Frequent local feedback: affected package typechecks/tests and direct Rust crate tests. No English, browser, visual, package or real-data gates.       |
| commit  | `pnpm verify:commit`                        | Staged paths plus changed-file lint/format, Rust format and the currently implemented PhotoLab English UI audit exactly once.                          |
| push    | `pnpm verify:push`                          | The commits since the upstream merge base, with reverse consumers and risk-triggered contract/browser/visual/clippy gates.                             |
| release | `pnpm verify:release -- --capabilities=...` | Full release plan. Missing GPU, real-data or native package capabilities fail rather than silently skip. CI fans this plan out across capable runners. |

Rust Clippy follows the lint levels declared in the workspace manifest:
`clippy::all` is blocking, while `clippy::pedantic` remains advisory.
Verification must not add a blanket `-D warnings` that silently promotes
advisory lints.

`verify:changed` only enumerates untracked files below known source roots. An
unknown top-level directory is reported as one shallow notice and is never
recursively traversed. This protects local multi-gigabyte capture datasets.

## Risk escalation

- Documentation is low risk and starts no compiler in the changed tier.
- App/package sources select their owning Node package and transitive workspace
  consumers.
- Core, viewer, WASM, IO, Electron security, schemas and test infrastructure
  are high risk and add portable workspace gates on push.
- Packaging, lockfiles, vendored code and licenses escalate to release gates.
- Unknown source paths fail safe as high risk. Local `photolab/` capture data
  is explicitly not source code.
- Automation schema, generator and generated Python SDK changes run one
  deduplicated SDK test/staleness gate. Release verification always runs it.
- The family-wide English UI policy applies to every product. PhotoLab has the
  current automated audit; Cap and the remaining product surfaces must add
  equivalent gates rather than relying on documentation alone.
- A Node package is selected for `node.test:<name>` only when its manifest
  declares a `test` script. PhotoLab's entry point is
  `pnpm --filter @himmelcad/photolab test`, which chains `test:renderer`
  (`node --experimental-strip-types --test` over `renderer/src/**/*.test.ts`),
  `test:electron` (the `tsc`-compiled `preferences`/`projectLifecycle` suites)
  and `test:contracts` (processing-report golden and the Cap import boundary).
  It is also what CI's `node:test` job reaches through `pnpm -r test`. Renderer
  sources import siblings with TypeScript's `./module.js` specifier, so the
  runner loads `scripts/lib/renderer-ts-resolve.mjs`, which maps such a
  specifier to the neighbouring `.ts`/`.tsx` only when no `.js` file exists.
  The remaining `photolab:test:*` root scripts stay operator-run.
- Managed-runtime manifests, staging, OpenCV build/audit recipes and the
  deterministic wheel packager select the SDK, packager and automation-host
  gates together. Stock development wheels can therefore never become release
  artifacts through a path-classification gap.

## Automation runtime release tasks

Release plans always add the following automation gates in dependency order:

- `automation.sdk` runs the generated Python SDK unit and staleness suite.
- `automation.runtime-packager` verifies deterministic staged-wheel packaging.
- `automation.runtime-stage-linux` runs
  `node scripts/stage-automation-runtime.mjs linux-x64 --release` and requires
  the `linux-package` capability.
- `automation.runtime-stage-windows` runs
  `node scripts/stage-automation-runtime.mjs win32-x64 --release` and requires
  the `windows-package` capability.
- `node.typecheck:@himmelcad/automation-host` and
  `node.test:@himmelcad/automation-host` run after the platform staging tasks.

Each staging task verifies the pinned automation schema, SDK generator,
generator manifest, Python host transport, generated inputs/outputs, CPython
archive and platform wheels. It rejects unsafe archive paths or extracted
objects, installs offline without dependency resolution, removes runtime
installers, probes SDK/NumPy/Pillow/OpenCV imports and atomically emits the
hash-bound runtime inventory. `--release` additionally fails if any selected
artifact declares a release blocker.

These are platform certifications, not portable best-effort tests. The Linux
and Windows tasks therefore remain separate and capability-owned; the release
runner fails when a required capability is missing instead of reporting a
skip. Windows Wine smoke provides deterministic cross-platform evidence for
the pinned NumPy/OpenCV wheels, but does not replace the native Windows package
and install gate. On a Linux audit workstation,
`node scripts/verify-windows-automation-runtime-release.mjs` assembles every
pinned Windows component in a fresh private tree, repeats all source/artifact
hash and archive-safety checks, proves `pip`/`ensurepip` absent and exercises
Pillow, SDK/host, NumPy BLAS/LAPACK/concurrency and OpenCV PNG/SIFT under Wine.

The repository supplies opt-in hooks in `.githooks`. Run `pnpm hooks:install`
once per clone. Hooks do not stash or rewrite the working tree: staged tests may
therefore expose an error in an unstaged version of the same source file.

Release capability names currently are `browser-gpu`, `real-data`,
`linux-package` and `windows-package`. Platform-specific CI jobs must own them;
a foreign-platform or unavailable-data skip is not a certification pass.
