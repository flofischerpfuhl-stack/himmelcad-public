# S-01 — Release 0.5 data-model admissions evidence

Date: 2026-09-02

Scope: ADR 0031 items 1, 3, 5, 6, the admitted portion of 7, 11, and 12. No
producer UI or deferred admission was added. `crates/himmelcad-sidecar`,
`packages/@himmelcad/ui`, `packages/@himmelcad/theme`, and `apps/builder` were
not edited by this work package.

## Implemented substrate by item

| Item | Files | Executable gate and result |
| --- | --- | --- |
| 1 — basic Measurement | `crates/himmelcad-core/src/release_05_admissions.rs`, `entity_model.rs`, `entity_validation.rs`, generated `packages/@himmelcad/data/src/generated/Measurement*.ts` | `release_05_admissions::tests::g_s01_1`: PASS. The strict built-in, three admitted kinds, metric/anchor arity, explicit Fixed/Attached binding, exact-source fields, no-placement/exactly-one-layer entity rule, unknown-Z refusal, and deferred-version refusal execute in core. |
| 3 — ViewState v2 | `release_05_admissions.rs`, `packages/@himmelcad/app/src/view.ts`, `packages/@himmelcad/app/test/view.test.ts`, automation schema/fixture, generated TS/Python | `release_05_admissions::tests::g_s01_3`: PASS; `G-S01-3 ViewState v2 accepts clip references and rejects Plan fields`: PASS. V1 bytes are retained on passive read; v2 validates exact clip revisions and has no Plan fields. |
| 5 — snapshot markers | `release_05_admissions.rs`, `entity_model.rs`, `entity_validation.rs`, generated `SnapshotMarker*.ts` | `release_05_admissions::tests::g_s01_5`: PASS. The marker schema, kinds, generation, origin, restore linkage, retention, and non-renderable built-in admission execute in core. |
| 6 — recipe and Mesh roles | `release_05_admissions.rs`, generated `Derived*.ts` and `MeshSourceRole*.ts` | `release_05_admissions::tests::g_s01_6`: PASS. The common lifecycle envelope, exact sources/outputs, last-good/error/detach records, producer allow-set, immutable role-resource hashing, and DAG cycle refusal execute in core. |
| 7 — acquisition/support | `release_05_admissions.rs`, generated `PointAcquisition*.ts` and `SupportRole*.ts` | `release_05_admissions::tests::g_s01_7`: PASS. Pick/typed/manual-estimate truth rules and explicit support metadata execute; no offset, neighbour-fit, field-code, or station/offset producer is admitted. |
| 11 — curve subentities | `release_05_admissions.rs`, generated `CurveSubentityRefV1.ts` | `release_05_admissions::tests::g_s01_11`: PASS. Exact stable-member/hash/interval resolution and deterministic no-widen prune/refusal execute against a 10,000-member index. |
| 12 — local histories | `release_05_admissions.rs`, generated `LocalHistory*.ts` | `release_05_admissions::tests::g_s01_12`: PASS. One schema covers three discriminated streams; checksum/head validation and absent-stream no-write baseline execute independently. |
| Common compatibility | `release_05_admissions.rs`, `docs/DATA-MODEL.md`, `docs/PROJECT-FORMAT.md` | `release_05_admissions::tests::g_s01_compatibility_round_trip_and_fail_closed`: PASS. The fixture hash is identical before/after passive open; unknown versions retain exact bytes read-only and fail writable; unknown project fields remain lossless. |
| P11 table | `schemas/automation/himmelcad-automation-v1.schema.json`, `packages/@himmelcad/data/test/release-05-admissions.test.mjs`, generated Python SDK | `G-S01-P11 exposes every admitted row in the single generated command table`: PASS; `G-S01-DEFERRED keeps deferred producer rows unavailable`: PASS. |

The Rust-first generator was extended in
`crates/himmelcad-core/src/bin/generate_entity_bindings.rs`; its outputs remain
under the repository's existing generated-output exclusion and were regenerated
in place. `packages/@himmelcad/data/src/index.ts` was not changed.

## Exact generated command/query rows added

- Measurement/inspect: `measurement.create`, `measurement.list`,
  `measurement.get`, `measurement.update_anchor`,
  `measurement.detach_anchor`, `measurement.rebind_anchor`,
  `measurement.rename`, `measurement.set_layer`,
  `measurement.set_visibility`, `measurement.remove`, `inspect.point_info`.
- View/viewing box: `viewing_box.place`, `viewing_box.update`,
  `viewing_box.set_operation`, `viewing_box.lock`, `viewing_box.unlock`,
  `viewing_box.rename`, `viewing_box.activate`, `viewing_box.deactivate`,
  `viewing_box.remove`, `viewing_box.list`, `view.presentation.set`,
  `view.point_size.set`. Existing `view.state.get/set` rows now use
  `ViewStateV2`.
- Snapshots: `snapshot.create`, `snapshot.list`, `snapshot.rename`,
  `snapshot.restore`, `snapshot.delete`.
- Derived/Mesh: `derived.recipe.get`, `derived.recipe.list`,
  `derived.recipe.status`, `derived.recipe.regenerate`,
  `derived.recipe.regenerate_batch`, `derived.recipe.detach`,
  `derived.recipe.relink`, `mesh.surface.draft.list`,
  `mesh.surface.draft.get`, `mesh.surface.draft.create`,
  `mesh.surface.draft.set`, `mesh.surface.draft.apply_fix`,
  `mesh.surface.draft.history`, `mesh.surface.draft.undo`,
  `mesh.surface.draft.redo`, `mesh.surface.draft.suspend`,
  `mesh.surface.draft.resume`, `mesh.surface.draft.discard`,
  `mesh.surface.check`, `mesh.surface.create`,
  `mesh.surface.edit.add_breakline`, `mesh.surface.edit.remove_breakline`,
  `mesh.surface.edit.add_form_line`, `mesh.surface.edit.remove_form_line`,
  `mesh.surface.edit.set_source_role`, `mesh.simplify.preview`,
  `mesh.simplify.check`, `mesh.simplify.bake`.
- Draw/support: `draw.point.create`, `draw.curve.create`,
  `draw.support_role.get`, `draw.support_role.set`,
  `draw.support_role.clear`, `view.support_overlay.get`,
  `view.support_overlay.set`.
- Selection/local history: `selection.granularity.get`,
  `selection.granularity.set`, `selection.kind_filter.get`,
  `selection.kind_filter.set`, `select.get`, `select.list`, `select.set`,
  `select.add`, `select.remove`, `select.clear`, `interaction.state.explain`,
  `interaction.state.preview`, `interaction.state.apply`,
  `view.labels.global.get`, `view.labels.global.set`,
  `view.labels.entity.get`, `view.labels.entity.set`, `selection.history.get`,
  `selection.history.undo`, `selection.history.redo`,
  `selection.history.clear`, `display.history.get`,
  `display.history.undo`, `display.history.redo`,
  `display.history.clear`, `camera.history.get`, `camera.history.undo`,
  `camera.history.redo`, `camera.history.clear`.

No RPC allowlist was added. The rows live only in
`schemas/automation/himmelcad-automation-v1.schema.json`, the existing single
generated automation table.

## Verification results

- `pnpm typecheck`: PASS (`tsc -b`; PhotoLab English UI check also passed).
- `pnpm --filter @himmelcad/data typecheck`: PASS.
- `pnpm --filter @himmelcad/data bindings:check`: PASS, canonical entity
  bindings current.
- `pnpm --filter @himmelcad/data test`: PASS, 2/2.
- `pnpm --filter @himmelcad/app test`: PASS, 15/15.
- `pnpm --filter @himmelcad/photolab typecheck`: PASS.
- `python3 scripts/generate-automation-sdk.py --check`: PASS, generated SDK current.
- `python3 -m unittest discover -s sdk/python/tests`: PASS, 12/12.
- `node scripts/run-cargo.mjs test -p himmelcad-core`: PASS, 216 core unit
  tests + 1 automation-schema golden + 0 doc tests. The wrapper was required
  because `cargo` is not on the non-login shell PATH; it resolved the configured
  toolchain and retained the exported absolute `target/builder` target dir.
- `git diff --check` over S-01 paths: PASS.

## Decisions resolving ADR ambiguity

### S01-D1 — Keep canonical contracts Rust-first

**Decision:** canonical admitted records and validators live in one new core
module and are exported by the existing `ts-rs` binding generator. Automation
rows remain in the existing automation JSON schema and generate Python from
that same table.

**Derivation:** DATA-MODEL makes current Rust plus generated contracts the
source of truth; the repository has no second JSON-schema pipeline for
canonical entity components.

**Rejected:** adding a parallel canonical JSON-schema generator or handwritten
copies in `data/src/index.ts`.

**Tunable:** no.

### S01-D2 — Shared operation envelope for row-only substrate

**Decision:** newly admitted P11 rows use the generated
`AdmissionOperationRequest/Result` versioned payload envelope. Domain slices
must replace the opaque payload leaf with their precise generated command DTO
when they implement execution; this package adds no producer or RPC handler.

**Derivation:** ADR 0031 requires the exact row names in the single table while
forbidding producer workflows in S-01. The canonical domain records themselves
are strongly typed in Rust/TS.

**Rejected:** inventing handlers, private RPC allowlists, or claiming deferred
workflow execution merely from an admitted envelope.

**Tunable:** the per-row request/result DTO selected by its owning domain slice;
the row names and admission boundary are not tunable.

### S01-D3 — Preserve PhotoLab's v1 call surface during shared v2 admission

**Decision:** retain `parseViewState`/`ViewStateV1` for the current PhotoLab
subset and add `parseViewStateV2` plus generated v2 SDK contracts. Automation's
canonical view rows speak v2. Passive v1 parsing does not write or materialize
clips.

**Derivation:** ADR 0031 requires shared v2 contracts but explicitly queues
PhotoLab product adoption behind its release priority and permits typed subset
handling.

**Rejected:** modifying PhotoLab's renderer in this concurrent package or
making passive parsing create canonical viewing-box entities.

**Tunable:** no.

## Not verified / intentionally outside S-01

No producer UI, domain command handler, renderer behavior, export writer,
large-restore cancellation implementation, or domain workflow was added or
claimed. Consequently, owning-domain interaction/performance gates such as
`G-MI-UNIT-MATH`, `G-B2-MESH-DRAFT-RULES`, `G-RW-DGM-SMOOTH`, and
`G-B2-HISTORY` still require their later producer packages even though the
S-01 schema/admission portions are executable here. Real on-disk `.hcadx`
streaming pack/unpack remains the IO owner's gate; S-01 verifies lossless
serialized record/fixture preservation at the shared contract boundary.

## Follow-up 2026-09-04 (architect)

The run verified `himmelcad-core` only; the new `GeometryObject::Measurement` variant left two non-exhaustive matches downstream (`himmelcad-render/src/entity_compiler.rs` `required_entity_proxy_slots`, `himmelcad-io/src/canonical_provider.rs` `collect_geometry_resources`), found by the PhotoLab lane as a sidecar test-build failure. Both arms added by the architect (Unsupported resolver / no resources); `cargo check -p himmelcad-sidecar --tests` green. Brief rule added: enum-variant additions require a workspace-wide `--all-targets` check.
