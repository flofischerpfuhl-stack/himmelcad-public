# Viewer completion snapshot — July 2026

Status: archived summary. It records an earlier implementation campaign and has
no authority over current priorities or release claims.

The campaign implemented the shared Rust/wgpu viewer kernel and its public
`@himmelcad/viewer` boundary across six milestones:

1. canonical imaging and prepared large-geometry contracts;
2. canonical entity and representation coverage;
3. rendering, navigation, picking, measurement, clipping, and sections;
4. civil-scale streaming, recovery, residency, and backend hardening;
5. the stable application-facing viewer facade;
6. release and physical hardware conformance preparation.

The implementation was considered application-ready on the tested revision.
Native platform, package, real-data, and physical GPU claims remained dependent
on their explicit test environments; absence of a capable runner was never a
pass. Detailed historical evidence is retained in
`docs/history/VIEWER-VERIFICATION-2026-07.md`.

Current viewer architecture is governed by ADR 0017,
`docs/ARCHITECTURE.md`, and `packages/@himmelcad/viewer/README.md`.
