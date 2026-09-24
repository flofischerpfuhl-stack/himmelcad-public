# SPLIT WASM-FIX — display closure and Windows recovery

Date: 2026-09-24

Scope: dependency ownership and portability repair only. There is no behavior,
schema, serde, wire, route, or file-format change.

## Result

The viewer WASM builds and stages again. The display-layer normal dependency
closure is now limited to the portable model/prepared/spatial/transform
foundation, and the Windows GNU/LLVM cross-check is green.

`himmelcad-prepared` is now the renderer-neutral, WASM-safe DTO crate. Native
preparation and publication code moved to the new
`himmelcad-prepared-build` foundation crate. The persistent project store,
filesystem durability, process execution, command orchestration, and domain
crates are absent from the display closure.

Two prescribed runtime gates are not green and are recorded without masking:

- the headless WebGPU browser gate reproducibly fails in Dawn while mapping the
  GPU pick readback buffer;
- the unchanged document group-commit timing test reports a 126.740 ms p95
  against its 100 ms machine threshold on the final quiet-machine retry. All
  other document tests in that run passed.

## Root cause and history

The break was a dependency-ownership regression assembled across ADR 0032
steps, rather than a WASM-specific source defect:

1. `himmelcad-wasm -> himmelcad-core` predated ADR 0032. Step 4a
   (`96ed3263`) made that edge reach `himmelcad-document`; step 4b
   (`36532ea2`) also made it reach `himmelcad-process`.
2. Step 3 (`77db273e`) introduced `himmelcad-render -> himmelcad-prepared`.
   Step 5a (`8b480025`) then combined portable prepared DTOs with native
   tilers/publishers and added `himmelcad-prepared ->
{himmelcad-document,himmelcad-process}`. Render therefore acquired the same
   native closure transitively.
3. Step 5b (`140efad8`) added the document-to-process edge. Step 5d
   (`978e96af`) moved the durable store and its `fs2` locking into document.
   `durable_fs.rs` has Unix and Windows implementations only, so following this
   closure on `wasm32-unknown-unknown` ultimately left `file` undefined.
4. The same Step-5d store move retained a Windows-only `tracing::debug!` call
   without adding `tracing` to `himmelcad-document`, causing WIN-23. The
   architect's in-progress `tracing` dependency, non-WASM `fs2` target
   dependency, and store module cfg were retained as part of the completed
   ownership fix.

## Crate changes

- Added `himmelcad-prepared-build`. It owns the native mesh, splat, and raster
  tilers, prepared-triangle-mesh package production, PLY conversion, and viewer
  raster manifest publishers. Their implementations and tests moved together.
- Reduced `himmelcad-prepared` to portable renderer-neutral DTOs and manifests:
  dense raster, hierarchy index, MVS scene, point cloud, Potree, raster-surface,
  and prepared-root contracts.
- Moved the pure in-memory canonical document engine and entity-command logic
  from `himmelcad-document` to `himmelcad-model`, with tests verbatim.
  `himmelcad-document` re-exports those modules while retaining persistence,
  import publication, locking, durability, and recovery.
- Replaced `himmelcad-wasm -> himmelcad-core` with direct dependencies on
  `himmelcad-model` and `himmelcad-prepared`; WASM imports now name the owning
  portable crates.
- Updated native IO/domain/sidecar consumers to import producers from
  `himmelcad-prepared-build`. No native producer is re-exported by the portable
  DTO crate.
- Updated viewer staging hashes to track `himmelcad-model` and
  `himmelcad-prepared`, the actual WASM inputs, instead of `himmelcad-core`.
- Kept `fs2` as a non-WASM target dependency of `himmelcad-document`, added its
  missing `tracing` dependency, and cfg-gated the native store module.
- Applied pure import cfgs in `himmelcad-process/src/worker.rs` for Linux-only
  worker diagnostics, removing the Windows-only unused-import warnings.
- Moved one wrapper test beside its now domain-owned private implementation;
  the test body and repository test count are unchanged.
- Raised only the WebGL2 browser-harness timeout from 30 seconds to 120 seconds.
  Both original 30-second failures had already reached `ready: true`,
  `phase: "ready"`, and `error: null`; the production kernel was not changed.

## Dependency checker

`scripts/check-module-dependencies.mjs` now evaluates the transitive NORMAL
dependency graph from `cargo metadata --all-features` rather than checking only
direct manifest edges. For each display crate it permits only display crates
and these explicitly WASM-safe foundation crates:

- `himmelcad-model`
- `himmelcad-prepared`
- `himmelcad-spatial`
- `himmelcad-transform`

Consequently, `himmelcad-document`, `himmelcad-process`,
`himmelcad-command`, `himmelcad-core`, every domain crate, and every other
first-party crate are rejected anywhere in the display crate's normal
transitive closure. The old WASM-to-core allowlist exception was removed.

The fixture
`scripts/fixtures/module-dependencies/display-transitive-forbidden.json`
proves that an indirect display-to-document path is rejected. The checker suite
now has 9 passing cases. The live checker reports 22 Rust crates, 107 Rust
edges, 13 TypeScript packages, 63 TypeScript edges, 2 edge exceptions, and 1
source-include exception.

## Test-count invariant

The repository Rust attribute count remains exactly 1,237:

| Attribute           |     Count |
| ------------------- | --------: |
| `#[test]`           |     1,134 |
| `#[tokio::test...]` |       103 |
| Total               | **1,237** |

No test timing bound was relaxed. No duplicate type, cross-crate `include!`,
domain `macro_export`, Cargo `package =` rename, `extern crate self as`, or
blanket domain-to-foundation re-export was introduced.

## Gates

All Rust commands used
`CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split`; all requested
Rust compilation/test commands used `-j 4`. Commands below are quoted verbatim
from the requested gates.

### WASM and viewer staging

| Gate (verbatim)                                                                                                   | Result | Measured wall time / notes                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `cargo check -p himmelcad-wasm -p himmelcad-render -p himmelcad-decode-wasm --target wasm32-unknown-unknown -j 4` | PASS   | 15.02 s final cached run                                                                                              |
| `pnpm --filter @himmelcad/builder prepare:viewer:dev`                                                             | PASS   | Built and staged the WASM viewer; 4 min 45 s cold run                                                                 |
| `pnpm --filter @himmelcad/photolab prepare:viewer:dev`                                                            | PASS   | This is PhotoLab's `package.json` staging equivalent; shared artifacts were current and were staged/skipped correctly |

### Headless browser kernel

Both commands were run with `DISPLAY` removed, using the repository's headless
browser path.

| Gate (verbatim)                                              | Result   | Notes                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @himmelcad/viewer test:browser-kernel-webgl2` | PASS     | SwiftShader WebGL2 class-I path. The release browser build took 6 min 16 s; the final run passed with the corrected harness ceiling.                                                                                                         |
| `pnpm --filter @himmelcad/viewer test:browser-kernel-webgpu` | **FAIL** | Reproduced on two warm attempts: `[canonical-entity-zoo] GPU pick readback mapping failed: Error occurred when trying to async map a buffer`. This is the Dawn/headless WebGPU adapter path; no renderer behavior was changed to conceal it. |

### Windows cross-check

| Gate (verbatim)                                                                                                                                                                                                     | Result | Measured wall time / notes                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH="$PWD/.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64/bin:$PATH" cargo check --target x86_64-pc-windows-gnullvm -p himmelcad-builder-sidecar -p himmelcad-photolab-sidecar --all-targets -j 4` | PASS   | Zero errors; 2.43 s final cached run. An initial run exposed a moved wrapper test calling a now-private helper; the test was moved beside the helper and the final cross-check passed. Existing unrelated warnings remain, while the requested `worker.rs` Windows import warnings are gone. |

### Rust workspace and focused tests

| Gate (verbatim)                                                                                                                            | Result                            | Measured wall time / counts                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo check --workspace --all-targets -j 4`                                                                                               | PASS                              | 4.21 s final cached run (42.02 s earlier run); pre-existing `MissingCpu` warning remains                                                                                                                                                                                           |
| `cargo fmt --all --check`                                                                                                                  | PASS                              | Also rerun after the final Rust edit                                                                                                                                                                                                                                               |
| `cargo test -p himmelcad-prepared -p himmelcad-document -p himmelcad-render -j 4 -- --test-threads=2` (plus the producer crate if created) | **FAIL on unchanged timing gate** | Run included `-p himmelcad-prepared-build`. Document: 40 passed before `group_commit_machine_gate` failed at 100.106 ms p95; retries were 106.952 ms and 126.740 ms against 100 ms. Separate runs passed prepared 12/12, prepared-build 31 passed + 1 ignored, and render 344/344. |
| `cargo test -p himmelcad-sidecar -p himmelcad-builder-sidecar -p himmelcad-photolab-sidecar -j 4 -- --test-threads=2`                      | PASS                              | 8 min 09 s cold build; builder 3/3, PhotoLab library 1/1, PhotoLab main 48 passed + 1 ignored, portable MVS 13/13, shared sidecar 26/26, frozen protocol 3/3                                                                                                                       |

Additional ownership verification: `cargo test -p himmelcad-model -j 4 --
--test-threads=2` passed 60 unit tests and 1 integration test in 58.39 s.

### Module and TypeScript tests

| Gate (verbatim)                                          | Result | Notes                                                                                                                             |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:modules`                                     | PASS   | 7.21 s final all-features metadata run (20.43 s earlier under parallel validation load); live closure statistics are listed above |
| `node --test scripts/check-module-dependencies.test.mjs` | PASS   | 9/9                                                                                                                               |
| `pnpm --filter @himmelcad/builder test`                  | PASS   | Exit 0                                                                                                                            |
| `pnpm --filter @himmelcad/viewer test`                   | PASS   | 163/163                                                                                                                           |

## Required WASM tree quote

Command:

```text
cargo tree -p himmelcad-wasm --target wasm32-unknown-unknown -e normal | grep -o 'himmelcad-[a-z-]*' | sort -u
```

Output:

```text
himmelcad-model
himmelcad-prepared
himmelcad-render
himmelcad-wasm
```

## Measured time

The recorded repository-edit and validation interval was 59 min 31 s
(09:00:25–09:59:57 CEST). The dominant reported gates were the 8 min 09 s
sidecar suite, 6 min 16 s release viewer build, 4 min 45 s development WASM
stage, and 4 min 29 s cold focused producer/test build. Repeated WebGPU and
document timing attempts are included in the interval.

## Not verified

- The real Windows host, MSVC toolchain, installer/signing paths, and unlocked
  Windows GUI were not run. The prescribed `x86_64-pc-windows-gnullvm`
  all-target cross-check was run and passed.
- WebGPU was not rerun on a physical discrete-GPU host. The repository headless
  Dawn path was run twice and failed as reported above.
- Ignored real-dataset tests were not enabled.
- `bindings:generate` was not run.
- No commit or push was made.
- No `.build/split-wasm-fix/` scratch directory exists at handoff.
