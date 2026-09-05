# I-01 Cargo resolver — verification evidence

Document class: report / verification evidence  
Recorded: 2026-09-02  
Work package: I-01, Q1 Branch A

## Outcome

`G-INFRA-CARGO`: **PASS** for the I-01 scope. The verifier and
`scripts/run-cargo.mjs` now use one resolver, every Cargo task retains its task
ID and argument vector, 10/10 representative changed-path plans launched the
pinned Cargo successfully, and the runner's first nonzero status propagation
remains covered.

This is an infrastructure-only change. It does not alter product state,
persistence, commands, schemas, automation contracts, UI behavior, or Cargo
task arguments.

## Before

The `.build/verify/timings.json` present at the beginning of the work was a
successful commit-tier run recorded at `2026-09-02T17:27:44.637Z`. Its summary
was captured before running any probes:

```text
tier=commit risk=normal
git.diff-check                         10 ms  exit 0
node.typecheck:@himmelcad/builder    6885 ms  exit 0
node.test:@himmelcad/builder         2145 ms  exit 0
node.typecheck:@himmelcad/console    3283 ms  exit 0
node.typecheck:@himmelcad/photolab   9548 ms  exit 0
node.test:@himmelcad/photolab        3954 ms  exit 0
node.typecheck:@himmelcad/theme      1340 ms  exit 0
node.typecheck:@himmelcad/ui         3218 ms  exit 0
node.test:@himmelcad/ui              1618 ms  exit 0
node.typecheck:@himmelcad/weltview   4670 ms  exit 0
node.prettier:changed                1742 ms  exit 0
node.eslint:changed                  2450 ms  exit 0
photolab.english-ui                   460 ms  exit 0
```

That artifact contained no Rust task, so it neither demonstrated nor
contradicted the reported 2026-09-01 `rust.test:workspace` failure. The older
artifact had already been overwritten and was not available to copy.

Source inspection confirmed that `automation.wire-rust`,
`rust.test:workspace`, per-package `rust.test:*`, `rust.fmt`, `rust.clippy`, and
`licenses.cargo-deny` all emitted bare `cargo`. In the agent environment,
`cargo` was absent from `PATH` while `/home/oem/.cargo/bin/cargo` existed. A
direct pre-change spawn returned:

```text
status: null
error.code: ENOENT
error.message: spawnSync cargo ENOENT
```

The representative command was:

```text
CARGO_TARGET_DIR=target/builder node scripts/verify.mjs changed --path=crates/himmelcad-core/src/lib.rs
```

Pre-change Cargo-task samples, in milliseconds:

| Sample | Duration | Exit |
| -----: | -------: | ---: |
|      1 |        5 |    1 |
|      2 |        2 |    1 |
|      3 |        4 |    1 |
|      4 |        6 |    1 |
|      5 |        2 |    1 |
|      6 |        4 |    1 |
|      7 |        5 |    1 |
|      8 |        3 |    1 |
|      9 |        7 |    1 |
|     10 |        6 |    1 |

Result: 0/10 launches, 10/10 exit 1, median 4.5 ms, nearest-rank p95
7 ms. These are time-to-failure samples, not useful Rust results.

## Change

- Added `scripts/verification/cargo-resolver.mjs`. It resolves an explicit
  `CARGO`, `CARGO_HOME/bin`, the `HOME` and `USERPROFILE` Cargo homes (including
  their normal rustup proxy), `RUSTUP_HOME/shims`, and finally `PATH`. It checks
  executability and reports every searched location when resolution fails.
- Changed `scripts/run-cargo.mjs` to use that resolver rather than maintaining
  a separate candidate list.
- Changed `scripts/verification/planner.mjs` to lazily resolve Cargo once and
  use that executable for all six Cargo task classes. Non-Cargo plans still do
  not require Cargo to be installed.
- Extended `scripts/verification/planner.test.mjs` with resolver tests for
  Linux and Windows path conventions, absence diagnostics, and exact
  executable/task-ID/argument assertions for every emitted Cargo task class.
- Added `scripts/verification/runner.test.mjs` to prove exact argument delivery,
  stop-at-first-failure behavior, timing persistence, and propagation of exit
  status 7.

Files changed by I-01:

```text
scripts/run-cargo.mjs
scripts/verification/cargo-resolver.mjs
scripts/verification/planner.mjs
scripts/verification/planner.test.mjs
scripts/verification/runner.test.mjs
docs/builder-program/evidence/I-01-cargo-resolver-2026-09-02.md
```

## After measurements

The same representative changed-path command used the resolved executable:

```text
RUN  rust.test:himmelcad-core: /home/oem/.cargo/bin/cargo test -p himmelcad-core
```

Post-change Cargo-task samples, in milliseconds:

| Sample | Duration | Exit | Note                           |
| -----: | -------: | ---: | ------------------------------ |
|      1 |   154696 |    0 | clean `target/builder` compile |
|      2 |     4734 |    0 | warm                           |
|      3 |     5214 |    0 | warm                           |
|      4 |     5844 |    0 | warm                           |
|      5 |     5437 |    0 | warm                           |
|      6 |     5630 |    0 | warm                           |
|      7 |     5454 |    0 | warm                           |
|      8 |     5731 |    0 | warm                           |
|      9 |     4588 |    0 | warm                           |
|     10 |     5322 |    0 | warm                           |

Result: 10/10 launches and useful Rust results, 0 bare-spawn failures. Across
all ten samples the median was 5445.5 ms and nearest-rank p95 was 154696 ms;
the p95 is the clean-lane compilation. For the nine warm samples, the median
was 5437 ms and nearest-rank p95 was 5844 ms. The last measurement artifact
from this ten-sample series was:

```text
recordedAt=2026-09-02T17:51:06.417Z tier=changed risk=high
git.diff-check                 30 ms  exit 0
rust.test:himmelcad-core     5322 ms  exit 0
```

The exact package-script form requested for the after check also passed:

```text
CARGO_TARGET_DIR=target/builder pnpm verify:changed -- --path=crates/himmelcad-core/src/lib.rs
PASS git.diff-check 25ms
RUN  rust.test:himmelcad-core: /home/oem/.cargo/bin/cargo test -p himmelcad-core
test result: ok. 203 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test automation_fixture_round_trips_through_canonical_rust_serde ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
Doc-tests himmelcad_core: 0 tests, ok
PASS rust.test:himmelcad-core 2507ms
```

Because `.build/verify/timings.json` is shared, the concurrent PhotoLab session
subsequently overwrote it with its `2026-09-02T17:52:12.167Z` commit-tier run.
That run also recorded resolved Rust tasks passing (`rust.test:himmelcad-core`,
`rust.test:himmelcad-sidecar`, and `rust.fmt`, all exit 0), but it is not counted
as an I-01-run measurement.

## Tests run

```text
node --test scripts/verification/*.test.mjs
# tests 15
# suites 1
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

The 15 tests include the resolver, planner, and runner assertions. The runner
fixture deliberately reports `FAIL rust.test:example` internally and the test
passes only when `runPlan` returns and records the exact status 7 without
running its second task.

```text
pnpm exec prettier --check scripts/run-cargo.mjs scripts/verification/cargo-resolver.mjs scripts/verification/planner.mjs scripts/verification/planner.test.mjs scripts/verification/runner.test.mjs
Checking formatting...
All matched files use Prettier code style!
```

```text
pnpm exec eslint --max-warnings 0 scripts/run-cargo.mjs scripts/verification/cargo-resolver.mjs scripts/verification/planner.mjs scripts/verification/planner.test.mjs scripts/verification/runner.test.mjs
exit 0 (no output)
```

```text
CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs --version
cargo 1.88.0 (873a06493 2025-05-10)
```

`git diff --check` also exited 0 with no output.

## Not verified

- A full dirty-worktree `pnpm verify:changed`, push tier, and release tier were
  not run. The explicit-path changed tier was selected to exercise the planner
  and a real Rust task without claiming or interfering with the concurrent
  PhotoLab and architect changes.
- I-01 did not independently execute Clippy, cargo-deny, release-wide workspace
  tests, or the automation-schema-only plan. Their planner commands and exact
  arguments are unit-tested; the concurrent commit run's Rust format result is
  corroborating evidence only.
- Windows resolution was unit-tested with Windows path and environment-key
  conventions, not on a native Windows host.
- The missing-Cargo diagnostic was unit-tested with all candidates absent; the
  machine installation was not altered to create a system-level absence test.
- Timing samples were collected on the same machine and worktree in immediate
  sequence, but another session was compiling concurrently. They certify
  launch correctness, not a general performance baseline.
- No separate demanding-user review agent was run. This slice has no product
  surface or user flow; its operational flow was exercised through the real
  verifier entry point.

No commit was created.
