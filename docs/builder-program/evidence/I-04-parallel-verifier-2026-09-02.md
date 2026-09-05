# I-04 bounded parallel verifier — verification evidence

Document class: report / verification evidence  
Recorded: 2026-09-02  
Work package: I-04, Q1 Branch A

## Outcome

`G-INFRA-RUNNER`: **PASS** for the I-04 scope. The verifier now runs a validated
dependency graph with a bounded job count, holds declared exclusive resource
keys for the lifetime of each process group, and stops launching work on the
first failure. Running work receives `SIGTERM`; surviving process groups receive
`SIGKILL` after 10 seconds. The first observed failing task's exact nonzero
status remains the verifier status.

The representative 12-task `verify:changed` plan passed in both serial and
four-job modes. Its ordered task IDs were identical to the pre-change plan. On
comparable warm replays, runner wall time fell from 85,222 ms to 38,645 ms:
46,577 ms / 54.7%. The parallel run's sampled aggregate peak was 1,853,329,408
bytes RSS and 827.6% CPU. Its critical path was the viewer package typecheck
followed by its test, 37,387 ms.

This is verification infrastructure only. It does not alter product state,
schemas, automation contracts, UI, or Cargo arguments. No tsconfig file,
`apps/photolab` source, or `target/photolab` path was changed.

## Before

The pre-change runner was synchronous and persisted only task ID, duration, and
exit status. It had no job cap, dependencies, resource exclusions, process
group cancellation, resource samples, critical path, or parallel delta.

The pre-change serial measurement used this combined docs, TypeScript, Rust,
viewer, and release-staging-input plan:

```text
CARGO_TARGET_DIR=target/builder /usr/bin/time -v node scripts/verify.mjs changed \
  --path=docs/builder-program/MASTER-PLAN.md \
  --path=apps/builder/renderer/src/App.tsx \
  --path=crates/himmelcad-core/src/lib.rs \
  --path=packages/@himmelcad/viewer/src/index.ts \
  --path=scripts/stage-automation-runtime.mjs
```

Result: 12/12 tasks passed, 204.83 s outer wall time, 257% average CPU, and
2,273,824 KiB maximum RSS. The Rust task spent 111,965 ms recompiling concurrent
worktree changes, so this run records the old runner and ordered baseline but is
not used as the speedup denominator.

## Change

- `scripts/verify.mjs` accepts `--jobs N` and `--jobs=N`, then `VERIFY_JOBS`,
  with default `max(1, min(4, floor(available cores / 2)))`. Tier names and
  package scripts remain unchanged.
- `scripts/verification/planner.mjs` emits `resourceKeys` and `dependsOn` for
  every task. Cargo and nested-Cargo gates share `cargo:$CARGO_TARGET_DIR`;
  same-package Node checks share a package output lane, while different
  packages remain independent. Viewer WASM staging, browser targets, visual
  fixtures/ports, automation staging, PhotoLab package staging, real-data
  fixtures, and platform targets have explicit exclusive keys.
- `scripts/verification/runner.mjs` validates IDs/dependencies/cycles, launches
  the first ready non-conflicting tasks in stable plan order, bounds active
  children, and records results back in plan order. It manages detached Unix
  process groups and escalates failed-run cancellation after 10 seconds.
- `.build/verify/timings.json` remains the report path and retains the existing
  `tier`, `risk`, `recordedAt`, `results`, per-result `id`, `durationMs`, and
  `exitCode` fields. Version 2 adds planned IDs, jobs, wall/serial timing,
  actual prior-serial comparison when available, ISO and offset task
  start/end, resource keys, sampled peak RSS/CPU, critical path, and
  first-failure/cancellation latency.
- `verification.self-test` now invokes `pnpm verify:matrix:check`, so runner
  tests are included instead of only the planner test.
- Planner and runner tests cover resource declarations, stable serial order,
  dependencies, bounded concurrency, Cargo-lane exclusion, matching serial
  baseline use, first-status propagation, cancellation, process-group reaping,
  and ten repeated runs.

Files changed by I-04:

```text
scripts/verify.mjs
scripts/verification/planner.mjs
scripts/verification/planner.test.mjs
scripts/verification/runner.mjs
scripts/verification/runner.test.mjs
docs/builder-program/evidence/I-04-parallel-verifier-2026-09-02.md
```

## After measurements

The comparable serial replay used the same command with `--jobs 1` after the
Cargo lane was warm:

```text
planned=12, passed=12, failed=0
runner wall=85222 ms
sampled aggregate peak RSS=621285376 bytes
sampled peak CPU=728.6%
outer wall=85.36 s, average CPU=191%, maximum single-process RSS=496604 KiB
```

The immediately following replay used the same paths and `--jobs=4`:

```text
planned=12, passed=12, failed=0
runner wall=38645 ms
serial baseline=85222 ms (matching previous jobs=1 report)
delta=46577 ms (54.7%)
sampled aggregate peak RSS=1853329408 bytes
sampled peak CPU=827.6%
outer wall=38.80 s, average CPU=394%, maximum single-process RSS=495940 KiB
critical path=node.typecheck:@himmelcad/viewer -> node.test:@himmelcad/viewer
critical-path duration=37387 ms
first failure=null
```

Parallel contention increased individual task durations, so the report also
retains the current-run sum (`serialEstimateMs=143591`). The actual delta above
uses the matching prior jobs=1 report, not that estimate. RSS from the verifier
is the sampled sum across active process groups; `/usr/bin/time` reports a
single-process maximum and is included only as a second observation.

### Ordered task-set equivalence

The pre-change successful result IDs and post-change `plannedTaskIds` were
compared directly:

```text
jq -r '.results[].id' before-serial-timings.json > before.ids
jq -r '.plannedTaskIds[]' after-parallel-final-timings.json > after.ids
diff -u before.ids after.ids
diff_status=0
```

The common order was:

```text
git.diff-check
automation.sdk
automation.runtime-packager
node.typecheck:@himmelcad/automation-host
node.test:@himmelcad/automation-host
node.typecheck:@himmelcad/builder
node.test:@himmelcad/builder
node.typecheck:@himmelcad/photolab
node.typecheck:@himmelcad/viewer
node.test:@himmelcad/viewer
node.typecheck:@himmelcad/weltview
rust.test:himmelcad-core
```

### Conflict and failure behavior

The conflict test starts two synthetic Cargo tasks with the same
`cargo:target/builder` key and one independent Node task at `jobs=3`. Timestamped
events assert that the second Cargo start is at or after the first Cargo end,
while the Node task starts before the first Cargo end. The final test run passed
this assertion; logged task durations were 293 ms, 203 ms, and 285 ms.

The first-failure test starts a long-running task which spawns a grandchild,
then a task exiting 23 after 150 ms. It asserts status 23, absence of the queued
third task, and `kill(pid, 0) -> ESRCH` for the grandchild after completion. In
the final suite failure was detected at 232 ms and the cancelled task was reaped
at 292 ms; no orphan remained.

The bounded small-plan loop completed **10/10 runs**, **30/30 tasks**, with
**0 failures and 0 flakes**. The separate process-group assertion completed
with **0 orphans**.

## Tests run

```text
pnpm verify:matrix:check
# tests 21
# suites 1
# pass 21
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

```text
pnpm exec eslint --max-warnings 0 scripts/verify.mjs \
  scripts/verification/planner.mjs \
  scripts/verification/planner.test.mjs \
  scripts/verification/runner.mjs \
  scripts/verification/runner.test.mjs
# exit 0 (no output)
```

```text
CARGO_TARGET_DIR=target/builder node scripts/verify.mjs release --jobs 1 \
  --dry-run --capabilities=linux-package,windows-package,browser-gpu,real-data
# tier=release risk=release tasks=44; all 44 planned, none executed
```

```text
VERIFY_JOBS=2 node scripts/verify.mjs changed --dry-run --path=docs/README.md
# tier=changed risk=low tasks=1; git.diff-check planned
```

`git diff --check` exited 0 with no output.

## Not verified

- Complete push and release tiers were planned but not executed. Browser GPU,
  real-data, Linux/Windows packaging, Clippy, cargo-deny, and full-workspace
  release tasks therefore remain unverified in this package.
- SIGTERM/SIGKILL process-group cancellation and `/proc`/`ps` aggregate sampling
  were exercised on Linux. Windows child termination was not tested on a native
  Windows host.
- The pre-change measurement included a cold/recompiled Rust task and concurrent
  worktree activity; only the immediate warm jobs=1/jobs=4 pair is used for the
  reported performance delta. These are machine/worktree measurements, not a
  general benchmark.
- Another session's existing PhotoLab and shared-file changes remained in the
  dirty worktree. I-04 did not modify those files. No commit was created.
