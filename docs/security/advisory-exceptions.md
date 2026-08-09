# Cargo advisory exceptions

Last reviewed: 2026-07-20. Next mandatory review: 2026-10-01.

These exceptions cover maintenance-status advisories only. A vulnerability,
unsoundness or yanked release is never accepted through this list.

## RUSTSEC-2025-0141 — bincode is unmaintained

HimmelCAD uses `bincode 2.0.1` only for the ephemeral `HCDECODE v5` worker
artifact. The artifact has an authenticated input-manifest identity, an exact
framed body length, a 64 MiB input/allocation limit, trailing-byte rejection
and no persistence compatibility promise. `bincode` is not used for project,
network or canonical entity storage.

The project evaluated the suggested successors. The Serde-compatible options
available at this review do not provide the same bounded-allocation decoder;
switching would weaken hostile-worker-output handling. Replace bincode before
`HCDECODE v6` when a maintained decoder offers an equivalent hard allocation
limit, or earlier if any security advisory is published.

## RUSTSEC-2024-0436 — paste is unmaintained

`paste 1.0.15` is a compile-time-only transitive macro dependency of
`simba 0.9`, reached through the vendored acadrust fork's `nalgebra 0.34`
dependency. It is absent from runtime linking and processes no project input.
`nalgebra 0.35` removes this dependency through `simba 0.10`, but requires
Rust 1.89 while the supported workspace toolchain is Rust 1.88.

Remove this exception as part of the Rust 1.89 toolchain upgrade and acadrust
compatibility gate. Any security or soundness advisory overrides that schedule.
