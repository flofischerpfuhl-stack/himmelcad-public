# I-02 keyed development WASM staging — verification evidence

Document class: report / verification evidence  
Recorded: 2026-09-02  
Work package: I-02, Q1 Branch A

## Outcome

`G-INFRA-WASM-DEV`: **PASS for keyed staging behavior; baseline delta not
available**. Builder and PhotoLab now request an explicit development profile,
while their existing build paths retain the release-default staging command.
An unchanged preparation invokes zero Cargo and zero wasm-bindgen work. A
forced preparation runs Cargo and both wasm-bindgen passes, and the next
preparation skips.

The before/after speed delta cannot be certified: the genuine pre-change probe
failed in an actively edited shared Rust dependency before producing a warm
state, and later attempts to reconstruct the old warm path repeatedly detected
new changes in that dependency. The after measurements and functional gate are
real; no pre-change warm number is inferred.

This is an infrastructure-only change. It does not alter product state,
persistence, commands, schemas, automation contracts, UI behavior, or release
profile selection.

## Before

Source inspection confirmed that both `pnpm dev` scripts ran
`prepare:viewer` unconditionally. The staging script always ran this work:

```text
cargo build -p himmelcad-wasm -p himmelcad-decode-wasm --target wasm32-unknown-unknown --release
wasm-bindgen .../release/himmelcad_wasm.wasm ...
wasm-bindgen .../release/himmelcad_decode_wasm.wasm ...
```

It also hard-coded input artifacts below `target/wasm32-unknown-unknown`, so it
did not follow `CARGO_TARGET_DIR=target/builder`.

The pre-change Builder preparation probe was:

```text
CARGO_TARGET_DIR=target/builder /usr/bin/time -f 'I02_BEFORE_ELAPSED_SECONDS=%e' \
  pnpm --dir apps/builder prepare:viewer
I02_BEFORE_ELAPSED_SECONDS=102.74
error[E0425]: cannot find function `populate_calibration_diagnostics` in this scope
error: could not compile `himmelcad-core` (lib) due to 1 previous error
```

This was a cold failed sample, not a warm baseline. The shared source changed
during the work and the error was subsequently resolved outside I-02. Two
later attempts to establish the old release path as warm immediately began
recompiling `himmelcad-core`; both invalid samples were stopped and are not
reported as performance results.

## Change

- `scripts/stage-builder-viewer-wasm.mjs` now computes SHA-256 content keys
  for each WASM artifact. Inputs include the staging script, toolchain,
  workspace manifest and lockfile, each bridge crate, and their local
  `himmelcad-core`/`himmelcad-render` source dependencies.
- Per-artifact keys mean a bridge-only source edit rebuilds only that package
  and its corresponding wasm-bindgen output. Shared inputs invalidate both.
- The key record is written atomically beside the staged artifacts only after
  Cargo and every required wasm-bindgen pass succeed. Missing output files
  invalidate the matching artifact.
- A cross-process lock serializes the shared staging destination. Contenders
  report that they are waiting, then recompute keys and artifact presence
  after acquiring the lock. A dead owner is detected by PID and recovered.
- `--profile dev|release` is explicit, with `release` as the default.
  `--force` invalidates both artifacts. The parser also accepts the literal
  `--` forwarded by pnpm.
- Cargo resolution reuses
  `scripts/verification/cargo-resolver.mjs` from I-01.
- Both apps expose `prepare:viewer:dev` and use it from `dev`. Existing
  `prepare:viewer`, `build`, package, and release paths remain release by
  default.
- The staging script honors `CARGO_TARGET_DIR`; all recorded Rust runs used
  `target/builder`.

Files changed by I-02:

```text
apps/builder/package.json
apps/photolab/package.json
scripts/stage-builder-viewer-wasm.mjs
scripts/stage-builder-viewer-wasm.test.mjs
docs/builder-program/evidence/I-02-wasm-staging-2026-09-02.md
```

I-02 imports but does not modify the concurrent I-01 files
`scripts/run-cargo.mjs` and
`scripts/verification/cargo-resolver.mjs`.

## After measurements

Full development staging from a cold dev-profile target:

```text
CARGO_TARGET_DIR=target/builder pnpm --dir apps/builder prepare:viewer:dev
Finished `dev` profile [optimized + debuginfo] target(s) in 5m 24s
I02_BUILDER_DEV_COLD_ELAPSED_SECONDS=331.90
```

After the dependency-key expansion, a real invalidated development rebuild
took 42.00 seconds (`cargo` reported 34.94 seconds). This smaller result reused
the populated dev target and ran both wasm-bindgen passes.

Adding the staging lock changed the script key. The resulting final-code
rebuild took 7.10 seconds (`cargo` reported 0.37 seconds).

Five unchanged samples for the final implementation:

| App      | Samples (seconds)            | Median | nearest-rank p95 |
| -------- | ---------------------------- | -----: | ---------------: |
| Builder  | 0.83, 0.90, 0.64, 0.61, 0.66 |   0.66 |             0.90 |
| PhotoLab | 0.68, 0.62, 0.64, 0.61, 0.68 |   0.64 |             0.68 |

Every sample printed exactly this staging-script line and showed no Cargo or
wasm-bindgen output:

```text
WASM staging unchanged (profile dev); skipping Cargo and wasm-bindgen.
```

The explicit forced path on the final implementation was:

```text
CARGO_TARGET_DIR=target/builder pnpm --dir apps/builder prepare:viewer:dev -- --force
Finished `dev` profile [optimized + debuginfo] target(s) in 0.35s
I02_LOCKED_FINAL_FORCED_DEV_SECONDS=6.81
```

Both wasm-bindgen passes ran after Cargo. The immediately following unchanged
preparation skipped in 0.64 seconds.

A simultaneous unchanged Builder/PhotoLab preparation exercised lock
coordination. Builder acquired the lock and skipped in 1.06 seconds. PhotoLab
printed `WASM staging is already running; waiting for it to finish.`, acquired
the lock after Builder, recomputed, and skipped in 1.26 seconds. Neither
process emitted Cargo or wasm-bindgen output.

A release-profile forced rebuild also completed successfully without changing
the existing build/package command paths:

```text
CARGO_TARGET_DIR=target/builder pnpm --dir apps/builder prepare:viewer -- --force
Finished `release` profile [optimized] target(s) in 4m 22s
I02_FORCED_RELEASE_ELAPSED_SECONDS=266.52
```

The subsequent unchanged release preparation skipped in 0.94 seconds. A later
forced release run after concurrent shared-source edits took 415.32 seconds;
this demonstrates why dependency sources must participate in the key, but it
is not used as a stable performance baseline.

## Tests run

```text
node --test scripts/stage-builder-viewer-wasm.test.mjs
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The tests cover argument parsing, deterministic key computation, per-crate
invalidation, shared lock/dependency/profile invalidation, matching-key skips,
missing-artifact rebuilds, and forced rebuild decisions. They invoke no Cargo.

```text
pnpm exec prettier --check scripts/stage-builder-viewer-wasm.mjs \
  scripts/stage-builder-viewer-wasm.test.mjs apps/builder/package.json \
  apps/photolab/package.json
Checking formatting...
All matched files use Prettier code style!
```

```text
pnpm exec eslint --max-warnings 0 scripts/stage-builder-viewer-wasm.mjs \
  scripts/stage-builder-viewer-wasm.test.mjs
exit 0 (no output)
```

```text
git diff --check
exit 0 (no output)
```

The required dirty-worktree command was run:

```text
CARGO_TARGET_DIR=target/builder pnpm verify:changed
PASS verification.self-test 187ms
PASS node.typecheck:@himmelcad/agent 3330ms
PASS node.typecheck:@himmelcad/app 2386ms
PASS node.typecheck:@himmelcad/automation-host 2179ms
PASS node.typecheck:@himmelcad/builder 9528ms
PASS node.test:@himmelcad/builder 2860ms
PASS node.typecheck:@himmelcad/console 4888ms
PASS node.typecheck:@himmelcad/data 1961ms
PASS node.typecheck:@himmelcad/photolab 17546ms
PASS node.test:@himmelcad/photolab 5152ms
PASS node.typecheck:@himmelcad/plan 2112ms
PASS node.typecheck:@himmelcad/specs 2013ms
PASS node.typecheck:@himmelcad/theme 1836ms
PASS node.typecheck:@himmelcad/ui 4456ms
PASS node.typecheck:@himmelcad/viewer 6387ms
PASS node.typecheck:@himmelcad/weltview 6734ms
FAIL rust.test:workspace 430622ms
rustc-LLVM ERROR: IO failure on output stream: No space left on device
```

The filesystem had 1.2 GiB available when the workspace Rust task failed.
Capacity later recovered without I-02 deleting shared caches. The package-local
changed-path rerun passed:

```text
CARGO_TARGET_DIR=target/builder pnpm verify:changed -- \
  --path=scripts/stage-builder-viewer-wasm.mjs
Verification tier=changed risk=release files=1 tasks=1
PASS git.diff-check 62ms
```

## Gate status

- Keyed unchanged Builder development staging: **PASS**.
- Keyed unchanged PhotoLab development staging: **PASS**.
- Zero Cargo/wasm-bindgen work on the skip path: **PASS**.
- Explicit forced rebuild path: **PASS**.
- Dev/release profile separation with release default retained: **PASS**.
- Per-bridge and shared-input invalidation decision: **PASS** by no-Cargo unit
  test.
- Concurrent shared-destination coordination: **PASS** for simultaneous warm
  Builder/PhotoLab preparations.
- Pre-change warm timing delta: **NOT ESTABLISHED** because the shared Rust
  worktree changed during every attempted baseline.
- Full dirty-worktree changed tier: **FAIL (environmental capacity)** after all
  preceding Node gates passed.

## Not verified

- Full `pnpm dev` was not launched because Electron/Vite cannot be left
  running as a headless measurement in this task; the allowed
  `prepare:viewer:dev` path was measured instead.
- CI, package, push, and release tiers were not run. The existing release
  package scripts were not changed, and a real forced/default release staging
  run passed, but byte-for-byte packaged artifact equality was not measured.
- No native Windows run was performed. Path behavior is delegated to Node path
  APIs and the I-01 Cargo resolver.
- Simultaneous Builder and PhotoLab cold starts were not run. Cross-process
  coordination was verified with simultaneous warm preparations.
- The exact pre-change warm timing, median, p95, invocation counts, and rebuilt
  bytes could not be measured in the moving worktree. No speedup percentage is
  claimed.

No commit was created.
