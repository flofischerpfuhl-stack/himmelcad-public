# ADR 0031: Release 0.5 data-model admissions bundle

## Status

Proposed (architect-derived, owner acceptance pending; implementation of
admitted items authorized under MASTER-PLAN §9.7 as vetoable substrate work)

Date: 2026-09-02.

## Context

Release 0.5 is the owner-accepted **DGM aus Scan** path in
`docs/builder-program/MASTER-PLAN.md` §0a and §6. Its ordered workflow is:
import and fluid viewing, viewing-box lock/bake, ground extraction,
sampling/rasterization, tri-modal breakline and boundary drafting, checked DGM
creation, region smoothing and downsampling, DXF/LandXML export, and basic
measurement. The release explicitly excludes classification beyond ground,
registration and station view, Civil, specifications, Plan, and BIM.

Work package S-01 may implement only data-model additions admitted by an ADR.
Registry §4.4 lists twelve pending or previously promoted items. This ADR
admits only the producer and consumer profiles needed by the 0.5 path, and
defers every other profile. It is a vetoable derived record under MASTER-PLAN
§9.7 while the owner is away; it does not convert a plan into implementation
evidence.

The candidate partition required one correction. Registry item 11, the stable
segment locator, is admitted because the ordered 0.5 substrate package
S-B2-P9/G5–G11 names the segment-locator admission as a prerequisite and exits
through `G-B2-SEGMENTS` before breakline/boundary drafting and the DGM error-
fixing window. Conversely, item 7's offset/parallel recipe profile is not
needed: split/trim/parallel editing is expressly part of the 1.0 M-RW outcome,
not the 0.5 drawing slice.

## Decision

### Relationship to accepted ADRs and owning specifications

This ADR is the narrow ADR 0016 admission extension required by MI-D2: it adds
`hcad.measurement@1` and `hcad.snapshot-marker@1` to the strict built-in type
registry and admits the named components/resources without changing ADR 0016's
stable envelope, CAS, optional-Z, or lossless-extension rules. On acceptance it
also narrowly supersedes ADR 0016's statement that clipping boxes are only view
state: the named viewing-box/section definition is canonical, while activation,
camera, and presentation remain ViewState/local state. ADR 0019's canonical
document and journal-last authority is unchanged.

The verbatim specification decisions below are adopted only within the explicit
0.5 producer boundary in this ADR. Where a quoted decision anticipates a wider
domain (for example angle/area measurements, neighbour fitting, Civil role
consumers, or Plan state), this ADR retains its invariants and serialized-reader
compatibility but does not authorize that deferred producer. This is a
deliberate release admission boundary, not a paraphrased rewrite of the owning
record; MASTER-PLAN §9.6 requires the later specification re-walk when a
deferred producer is admitted.

### Admission boundary

| Registry item | 0.5 disposition                                                                   | Schema id and version                                                                               | 0.5 reason or later owner                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | Admit a basic-measurement producer profile                                        | `hcad.measurement@1`, schema version 1                                                              | M-0.5 requires saved single-point, horizontal/3D-distance, and height-difference results with exact anchors. Angle, area, plane-warning workflows, and reports remain for M-RW/D-06.                      |
| 2             | Defer                                                                             | `hcad.component.edit-lock@1` reserved, not admitted here                                            | The 0.5 path needs P9 effective editability and layer/project causes, but no user-created per-entity edit lock; M1 on the 1.0 path admits it with the complete Select/Edit rejection semantics.           |
| 3             | Admit the 0.5 ViewState profile                                                   | `himmelcad.view-state`, protocol version 2                                                          | 0.5 needs entity-referenced viewing-box clips and VD-D8 view presentation above canonical entity styles. Pinned Plan viewports, Plan filters, update policies, and captured Plan revisions remain for M7. |
| 4             | Defer                                                                             | Plan-root id/version intentionally unset                                                            | Plan is excluded from 0.5; M7 admits the complete Plan root rather than an orphan subset.                                                                                                                 |
| 5             | Admit                                                                             | `hcad.snapshot-marker@1`, schema version 1                                                          | P-01 save/recovery requires session-start, safety, named, restore, and retention markers.                                                                                                                 |
| 6             | Admit                                                                             | `hcad.derived-recipe@1` and `hcad.mesh-source-roles@1`, schema version 1 for both                   | DGM creation, checked regeneration, region repair, and certified downsampling need the P10 recipe lifecycle and exact Mesh source roles.                                                                  |
| 7             | Split: admit point-acquisition and support-role components; defer offset/parallel | `hcad.component.point-acquisition@1` and `hcad.component.support-role@1`, schema version 1 for both | Tri-modal input and explicit blue support geometry are 0.5 substrate. The Draw offset/parallel `hcad.derived-recipe@1` payload profile waits for M3/M-RW in 1.0.                                          |
| 8             | Not re-admitted                                                                   | ADR 0030 ids and versions                                                                           | ADR 0030 already promotes this item. X-R1/PhotoLab R1 consumes it; ADR 0031 neither narrows nor duplicates it.                                                                                            |
| 9             | Defer                                                                             | Journal actor/batch ids and versions intentionally unset                                            | 0.5 needs P11 command parity, not embedded-Agent turn batching, restartable agent roots, or actor audit expansion; M8 admits the complete trust/audit bundle.                                             |
| 10            | Defer                                                                             | Civil bundle ids and versions intentionally unset                                                   | Civil is explicitly excluded from 0.5; M5 admits the bundle as one Civil-owned contract.                                                                                                                  |
| 11            | Admit (moved from the candidate defer set)                                        | `hcad.curve-subentity-ref@1`, schema version 1 (`CurveSubentityRefV1`)                              | The 0.5 substrate and `G-B2-SEGMENTS` require deterministic segment survival/pruning before line and DGM correction workflows.                                                                            |
| 12            | Admit                                                                             | `hcad.local-history@1`, schema version 1, stored as three independent stream instances              | Selection, display/visibility, and camera actions used by the 0.5 bottom strip need P8-local undo/recovery without entering the document journal.                                                         |

An admission in this table authorizes S-01 to add the named schema, validators,
migration readers, generated contracts, persistence plumbing, and gate
fixtures. It does not authorize a deferred producer, domain workflow, UI, or
command merely because that future command could carry an admitted envelope.

### Common compatibility and migration rule

All admitted types are additive. S-01 must obey these rules for every item:

1. Opening an existing `.hcad` project, `.hcadx` archive, `.hcap` capture
   package, or historical journal performs no eager rewrite and appends no
   migration command. `.hcap` remains an IO input package, not a project
   format; absence of these Builder records changes no Cap interpretation.
2. The new reader treats absent components, entities, recipe records, snapshot
   markers, segment tokens, and local-history streams as absent. It must not
   infer them from names, geometry, missing fields, renderer state, or indexes.
3. Existing journal bytes and sequence numbers remain unchanged. The first
   explicit command that creates or changes admitted state appends an ordinary
   expected-revision transaction. Undo/redo appends compensating transactions;
   no migration rewinds or edits journal history.
4. Existing content-addressed resources are never rewritten or rehashed.
   Migration that needs a changed resource publishes a new immutable object and
   links it only in a new committed transaction. Rebuildable indexes may be
   regenerated but never become authority.
5. Unknown namespaced components and recognized `@1` extension fields are
   preserved losslessly. An unsupported built-in payload opens read-only when
   safe or fails with a typed unsupported-schema result; it is never silently
   dropped, normalized into another type, or opened writable.
6. `.hcad`/`.hcadx` round trips retain every admitted record exactly. Exporters
   that cannot preserve a record must disclose the named loss or refuse before
   writing. WeltView remains read-only. Sibling readers gain no mutation
   authority from understanding a schema.

ViewState has one additional lazy rule. A version-1 `himmelcad.view-state`
loads through an in-memory compatibility projection and remains byte-for-byte
unchanged on open. A later explicit v2 state mutation writes version 2. Legacy
value clips are materialized through the canonical section/viewing-box command
path only when the user or automation explicitly submits a state change that
adopts them; a passive open never creates entities. Missing local histories
start as in-memory valid baselines and persist independently only after the
corresponding local state changes.

### Item 1 — basic saved measurements

The admitted producer profile of `hcad.measurement@1` contains only:

- `measurement_kind: point | distance | heightDifference`;
- `metric: horizontal | spatial` where valid;
- ordered Fixed or Attached anchors using the exact fields and revalidation
  rules in Measure/Inspect §7.1;
- canonical name, exactly one layer, visibility, creation-view/provenance, and
  `verified | unresolved` verification state; and
- a reconstructible, non-authoritative result cache bound to its inputs and
  algorithm version.

Entity placement is forbidden. Unknown Z remains unknown. `angle` and
`planarArea`, a measurement-plane producer, projected-warning acceptance, and
`measurement.report.generate` are not authorized by this ADR. A future ADR may
admit those additional `@1` producer variants only with compatibility fixtures;
0.5 readers must preserve an unknown valid variant but may not claim to
interpret or edit it.

Owning specification: `docs/builder-program/specs/measure-inspect/measure-inspect.md`,
MI-D2, MI-D3, and MI-D5. Adopted verbatim:

> **Decision:** valid finish creates named canonical
> `hcad.measurement@1`/`MeasurementGeometry` with journaled create/edit/warning/
> rename/layer/visibility/remove. The strict built-in list, geometry enum,
> validator/admission matrix, migration registry, project/archive schema
> coverage, generated TypeScript/Python contracts, old-reader preservation,
> WeltView read-only reader, exporters, snapshot/restore consumers, and
> automation schemas in §7.1/§11 are one indivisible implementation tranche.
> An ADR 0016 extension/superseding ADR and DATA-MODEL update must accept that
> delta before implementation acceptance; this plan does not amend the accepted
> ADR.

> **Decision:** every anchor payload and UI row declares Fixed or Attached.
> Typed XYZ/relative construction produces Fixed and never guesses a source;
> exact source pick produces Attached. A snapped/dragged Attached edit remains
> Attached and exposes typeable source parameter/offset; absolute XYZ requires
> **Detach to fixed coordinate**. Changing an Attached referent requires **Pick
> source**. A Fixed handle remains Fixed. The same rule applies to creation,
> editing, UI, agent, and SDK. Attached targets revalidate/follow valid placement;
> stale replacement/delete becomes visibly unresolved with last-verified
> history.

> **Decision:** Measure reuses DR-D12 markers/ranking/candidate cycle
> and P4 filtering, but the kernel contract gains provider/source identity and
> `coarse|exact`; retained rendered-depth hits remain coarse and are labeled
> estimates. Only an exact provider target that passes canonical core
> revalidation may create/rebind an Attached anchor. Locked-box exactness follows
> VB-D13/DR-D15.

Migration: old projects contain no Measurement built-in and therefore need no
entity rewrite. New readers add the strict type/admission registry entry;
existing unknown extension bytes remain opaque. Old readers must preserve an
unknown namespaced measurement on lossless/read-only paths or reject writable
open, never drop it.

P11 exposure: `measurement.create` for `point`, horizontal/spatial `distance`,
and `heightDifference`; `measurement.list/get/update_anchor/detach_anchor/
rebind_anchor/rename/set_layer/set_visibility/remove`; and
`inspect.point_info`. The deferred plane, warning, area, angle, and report
leaves must reject as unsupported in the 0.5 command table rather than appear
implemented.

Acceptance gate `G-S01-1`: run the MI-D2 `G-MI-SCHEMA` migration/round-trip
matrix plus the 0.5 subsets of `G-MI-UNIT-MATH`, `G-MI-UNIT-ANCHOR`, and
`G-MI-COMMAND`; prove `.hcad`, `.hcadx`, `.hcap`-import, journal replay,
old-reader preservation/rejection, generated TypeScript/Python staleness, exact
Attached revalidation, Fixed non-inference, unknown-Z refusal, and one-command
undo for all three admitted kinds. The gate fails if a deferred kind can be
created.

### Item 3 — ViewState v2, 0.5 profile

The schema id remains `himmelcad.view-state`; the protocol discriminator is
`version: 2`. The admitted 0.5 payload adds `clipRefs` containing canonical
section/viewing-box entity id, expected revision, activation, and readable lock
state, and the VD-D8 upper presentation fields including
`colorModeOverride` and `pointSizeMultiplier`. Canonical per-entity styles stay
in the lower entity/style layer and are changed only by their owning document
commands. The profile may retain the v2 canonical/session hidden-id split for
compatibility, but S-01 may not implement Plan-pinned viewport state, Plan rule
filters, update policy, or captured Plan revisions.

Owning specification: `docs/builder-program/specs/view/view-domain.md`, VD-D8
and VD-D13. Adopted verbatim:

> **Decision:** display resolves in two layers. **Below:** per-entity
> canonical display styles — color source, mode parameters, palette ref,
> per-entity point size — journaled, automation-visible, owned by Pointcloud
> PC-D11, Mesh/Terrain MT-D6, Raster RA-D5, and BIM BS-D12 for their respective
> entities; Raster images are another canonical lower-layer owner and the
> view-level render-style override never recolors them. **Above:** un-journaled,
> project-persisted view presentation (VD-D5/VD-D6) with a **Color mode
> override** defaulting to **Follow entity display**; when set, it
> overrides every point-cloud entity's color source at render time
> without touching canonical state. The View tab's color-mode control _is_
> this override — revising PC-D11's clause that made it an accelerator
> issuing scene-wide canonical edits (scene-wide canonical recolor remains
> available through the Pointcloud multi-select path, PC-D12/PC-D13).
> **Point size** adopts PC-D11 verbatim: per-entity canonical size (Auto
> default) × view-local unitless multiplier, default 1.0. The override is
> captured by bookmarks; the multiplier is **not** (explicitly decided:
> the multiplier compensates workstation display density — comfort, like
> theme — and capturing it would fight per-screen tuning; the override
> expresses view intent, which is what a bookmark names). Per-entity
> opacity/exaggeration/visibility stay canonical below; today's
> `view.opacity`/`view.exaggeration` console commands (`App.tsx:650–665`)
> migrate to Pointcloud canonical commands.

> **Decision:** the view protocol bumps to `version: 2`
> (`himmelcad.view-state`): (a) value-typed `scopedClips`
> (`view.ts:51–74`) are replaced by **`clipRefs`** — entity references
> with activation and readable lock state; an automation `state.set` that
> supplies a value-typed clip **materializes it as a canonical section or
> viewing-box entity** through the same journaled commands, eliminating
> the third clip channel (`setAutomationClipVolumes`, `App.tsx:163–165`);
> (b) `hiddenEntityIds` splits into **`hiddenEntityIds`** (canonical
> visibility) and **`sessionHiddenEntityIds`** (view-local, automation-
> settable, never journaled) — fixing today's merge (`App.tsx:153–176`)
> and making the VD-D3 capture boundary expressible; (c) presentation
> gains `colorModeOverride` (follow | mode + params) and
> `pointSizeMultiplier`; `background` drops `transparent` (screenshot
> requests keep it, `view.ts:95–106`); `showSelectionOutline` stays,
> automation-only, default true — automation can disable it for clean
> captures; no ribbon surface (recorded). SDK and host changes are listed
> in §6. **Sibling adoption (X7):** the shared parser and SDK speak v2;
> PhotoLab's duplicate assert
> (`apps/photolab/renderer/src/App.tsx:4076–4085`) is disposed the same
> way — typed model, PhotoLab's product subset — with implementation
> queued behind PhotoLab's release priority
> (`docs/CURRENT-DIRECTION.md`); until then PhotoLab rejects unsupported
> v2 fields with the same typed error surface, not a thrown assert.

Migration: use the common lazy rule above. A v1 state remains readable without
a write; the first explicit v2 write validates all referenced entity revisions
and either materializes legacy clip values through canonical commands or rejects
without partial state. No migration fabricates a pinned Plan viewport.

P11 exposure: `view.state.get/set`,
`viewing_box.place/update/set_operation/lock/unlock/rename/activate/deactivate/
remove/list`, `view.presentation.set`, and `view.point_size.set`. These are rows
in the one generated table; a raw automation-host allowlist is not exposure.

Acceptance gate `G-S01-3`: version-1 fixtures open without byte or journal
change; explicit migration produces valid v2 and canonical clip entities in one
atomic command set; invalid/stale clip refs publish nothing; v2 round-trips in
`.hcad`/`.hcadx`; PhotoLab accepts its typed subset or returns the typed
unsupported-field result; and no Plan root, viewport, filter, or capture record
is created.

### Item 5 — snapshot markers

`hcad.snapshot-marker@1` is a canonical, non-renderable entity. Version 1
contains the marked journal generation, marker kind
`manual | session_start | pre_restore`, creation time, origin class
`ui | sdk | agent | system`, optional restore linkage, and retention class
`manual | automatic`. It carries no Agent identity or batch/root metadata from
deferred item 9. Restore appends one compensating transaction; snapshot-marker
entities are the sole canonical-state exemption from restore.

Owning specification: `docs/builder-program/specs/file-project/file-project.md`,
FP-D4. Adopted verbatim:

> **Decision:** §1.4; every successful open creates a "Session start" marker
> before accepting commands; restore's
> affected-state set is all canonical state at the marked generation
> **except snapshot entities**, which are markers about the history line
> (VCS-tag semantics) and survive every restore — including the safety
> snapshot created to guard the restore itself. Plan sheets/viewports are
> ordinary journaled state in this affected set;
> PE-D7 linked captures remain content-addressed and are restored by exact
> reference. Measurement entities likewise restore as ordinary canonical state
> (MI-D11).

Migration: old projects have an empty snapshot collection. On open, recovery
and lock acquisition complete first; only then may the normal, new
`snapshot.create` command append the automatic Session start marker. That is a
new operational command, not an open-time file migration. Existing generations
and resources remain unchanged.

P11 exposure: `snapshot.create/list/rename/restore/delete`; generic entity reads
may list the marker but may not bypass snapshot restore semantics.

Acceptance gate `G-S01-5`: old journal fixtures replay unchanged; Session start
is the first accepted post-open command; create/rename/delete/restore and
undo/redo round-trip; pre-restore safety markers survive restore; every other
canonical state, including admitted measurements and recipes, restores
atomically; manual retention is never collected automatically; cancellation of
a large restore publishes nothing.

### Item 6 — derived recipes and Mesh source roles

This ADR adopts `DerivedRecipeV1` from Mesh/Terrain §10.1 as
`hcad.derived-recipe@1` without a second envelope. It also admits
`hcad.mesh-source-roles@1` as the immutable associated resource containing the
exact source entity/revision/placement, role, sampling/tolerance, boundary,
exclusion, and content hashes required by MT-D26. Release 0.5 producers are
limited to checked DGM creation/regeneration, region repair's temporary use of
the same lifecycle, and the `hcad.mesh.simplify-terrain@1` downsampling payload.
No Civil, Raster, BIM, contour, volume, hull, solid, strata, or Draw-offset
producer is authorized here.

Owning specification:
`docs/builder-program/specs/mesh-terrain/mesh-terrain.md`, MT-D25 and MT-D26.
Adopted verbatim:

> **Decision:** the envelope,
> responsibility split, operations, transitions, CAS, restore set, persistence,
> and budgets above are the complete common P10
> contract cited by Draw, Civil, Raster, BIM, and Mesh. DATA-MODEL and PROJECT-FORMAT must admit this exact envelope before an
> implementation claim; domain-prefixed UI/console spellings may adapt to the common ids but may not define another transition
> machine.

> **Decision:** the role topology, Form-line
> sampling/resource, set-union exclusions, auto boundary, fully draped crop, P9 rechecks, Civil manifest admission, commands,
> and source-immutability rules above extend MT-D1–D5/D16/D17.

Migration: absence means directly authored/imported or legacy derived geometry
with no admitted mapping; S-01 must not invent a recipe for it. New recipe and
role objects are additive immutable resources linked only after complete hash
validation and a journal-last CAS transaction. Unknown recipe kinds/parameter
types stay opaque/read-only or fail closed. Reverse indexes and DAG indexes are
rebuilt from canonical recipes and never persisted as competing authority.

P11 exposure: common
`derived.recipe.get/list/status/regenerate/regenerate_batch/detach/relink`;
`mesh.surface.draft.list/get/create/set/apply_fix/history/undo/redo/suspend/
resume/discard`; `mesh.surface.check/create`;
`mesh.surface.edit.add_breakline/remove_breakline/add_form_line/remove_form_line/
set_source_role`; and `mesh.simplify.preview/check/bake`. Domain UI and console
aliases dispatch these rows and may not register another lifecycle.

Acceptance gate `G-S01-6`: schema/hash/unknown-version fixtures, DAG cycle
rejection, generation monotonicity, source/revision/placement CAS, last-good
retention, linked/stale/regenerating/detached/error transitions, atomic
multi-output restore, reverse-index rebuild, archive/journal replay, immutable
resource reachability, and generated SDK parity pass. It incorporates
`G-B2-MESH-DRAFT-RULES`, `G-B2-MESH-RECOVERY`, `G-RW-DGM-SMOOTH`, and
`G-RW-DGM-DOWNSAMPLE` at their owning tiers and fails if any deferred recipe
producer can publish.

### Item 7 — point acquisition and support role; offset deferred

`hcad.component.point-acquisition@1` records the acquisition discriminant,
final coordinate, exact source/provider/revision when present, input mode, and
truth label. The 0.5 producer tags are `pick | typed | manual_estimate`; a
constrained pick remains `pick` with its exact snap/constraint/source fields,
not a second truth class. A manual estimate carries explicit confirmation and
no fabricated residual/confidence. Neighbour-fit, field-code, and
station/offset producer profiles remain 1.0 work even though readers preserve
their unknown versioned payloads.

`hcad.component.support-role@1` is exactly
`{role_kind: helper_point|defining_point|defining_curve,
defines[{entity_id, revision, semantic_role}]?, provenance}` on ordinary Point
or Curve entities. Missing metadata means ordinary geometry, never support.
The blue support overlay is presentation over the explicit role and does not
mutate it.

Owning specification: `docs/builder-program/specs/draw/draw.md`, DR-D18 and
DR-D21. Adopted verbatim:

> **Decision:** §3.8's `hcad.component.support-role@1` is explicit canonical
> metadata on ordinary geometry; `CurveSubentityRefV1` is view-local, topology-aware,
> revision/semantic-hash guarded, and consumed only by the declared matrix. Copy,
> fragment, export-loss, P9, remap/prune, history, and extreme-Composite behavior are
> part of the contract.

> **Decision:** §3.6 separates Manual 3D target from an optional registered
> neighbour-fit evaluator. Manual position is an explicit estimate with no
> statistical residual/confidence; fitting exposes captured sources, algorithm,
> rank, RMS residual, and the stated confidence formula, and always falls back to
> Manual on NoData/degeneracy. Both converge on ordinary `draw.point.create` with
> full acquisition provenance and one undo root.

Migration: no role or acquisition component is synthesized from color, name,
layer, missing code, coordinate, or historical command text. Existing Points
and Curves therefore remain ordinary. New component updates are expected-
revision document commands and unknown component versions round-trip opaque.

P11 exposure: `draw.point.create` carries admitted acquisition payloads;
`draw.curve.create` carries the tri-modal command input without turning inline
curve vertices into Point entities; `draw.support_role.get/set/clear` owns role
access; `view.support_overlay.get/set` controls only presentation; generic
entity queries expose the read-only components. The unregistered
`support.role.*` spelling is not a second public API. `draw.offset.apply` and
its Draw-specific recipe payload must remain unsupported in 0.5.

Acceptance gate `G-S01-7`: schema and generated-contract round trips prove each
admitted acquisition mode, exact-source CAS, manual-estimate truth labeling,
one create undo root, support-role set/clear symmetry, P9/render/pick/snap
consumers, blue overlay non-mutation, copy/archive/export-loss behavior, and
absence-as-ordinary migration. The gate includes the 0.5 subset of
`G-DR-INPUT` and `G-B2-SELECTION-VISUAL` and fails if offset/parallel,
neighbour-fit, field-code, or station/offset is publishable.

### Item 11 — stable curve-subentity references

`hcad.curve-subentity-ref@1` is the serialized schema name for
`CurveSubentityRefV1`:

```text
{
  parent_id, parent_revision, topology_kind, stable_member_id,
  directed_parameter_interval, loop_id?, use_id?, semantic_hash
}
```

The reference is view-local selection state or an explicit typed command
parameter; it is not a canonical segment entity. A source edit remaps only when
the same stable member id, semantic hash, and geometric interval still match;
otherwise it prunes with a typed reason. It never scans an unindexed extreme
Composite on the interaction path and never widens silently to the parent.

Owning specifications: `docs/builder-program/specs/draw/draw.md` DR-D18 and
`docs/builder-program/specs/select-edit/select-edit.md` SE-D19. Adopted
verbatim:

> **Decision:** §3.8's `hcad.component.support-role@1` is explicit canonical
> metadata on ordinary geometry; `CurveSubentityRefV1` is view-local, topology-aware,
> revision/semantic-hash guarded, and consumed only by the declared matrix. Copy,
> fragment, export-loss, P9, remap/prune, history, and extreme-Composite behavior are
> part of the contract.

> **Decision:**
> the resolver, cause explanation, support/BIM eligibility, segment token lifecycle,
> kind filter, and separate selection history above supersede “selection is not
> undoable.”

Migration: old projects and selection streams contain no segment tokens. Whole
selection remains the default; no geometry is exploded or rewritten. A token
restored from a new stream must revalidate against the exact parent revision or
deterministically remap/prune before becoming active.

P11 exposure: `selection.granularity.get/set`, `selection.history.get/undo/
redo/clear`, selection queries that return a selected member, and only the
registered segment-aware Draw/Mesh/BIM command parameters that declare this
type. `draw.edit.apply` and DGM correction consumers may use it in 0.5;
`draw.trim.apply`, `draw.divide.apply`, and `draw.offset.apply` remain deferred
workflow producers despite having reserved generated shapes.

Acceptance gate `G-S01-11`: `G-B2-SEGMENTS` plus schema/generator fixtures prove
Whole↔Segments changes no document geometry, exact same-member survival,
reversal rules, deterministic prune with reason, no neighbor/parent widening,
one parent-command undo, automation equality, and indexed remap/refusal for a
10,000-member Composite. Old local-state fixtures open as Whole with no write.

### Item 12 — independent local histories

`hcad.local-history@1` is one envelope schema instantiated and stored
independently for `selection`, `display`, and `camera`. Each instance contains
project id, stream kind, monotonically increasing local sequence, cursor/head,
typed before/after state, optional gesture-session/coalescing metadata, and a
checksum over the acknowledged stream record. It is not a canonical entity,
immutable geometry resource, or document-journal command. The three instances
must have separate atomic publication and corruption boundaries.

The affected-state sets are exactly UIP-D23 §9.4: Selection records membership,
Whole/Segments, kind filter, and segment remap/prune disclosures; Display
records P9 display/permission changes, isolate, Support/Labels, and other view
visibility presentation; Camera records pose/pivot, projection, and 3D/2.5D/2D
mode. Ctrl+Z/Ctrl+Shift+Z remain document-only.

Owning specifications:
`docs/builder-program/specs/ui-platform/ui-platform.md` UIP-D23,
`docs/builder-program/specs/select-edit/select-edit.md` SE-D19,
`docs/builder-program/specs/view/view-domain.md` VD-D14, and
`docs/builder-program/specs/file-project/file-project.md` FP-D21. Adopted
verbatim:

> **Decision:** the exact table/lifecycle in §9.4 governs recording, branch
> truncation, coalescing, persistence, project replacement/reopen, crash, and
> isolated corruption.

> **Decision:**
> the resolver, cause explanation, support/BIM eligibility, segment token lifecycle,
> kind filter, and separate selection history above supersede “selection is not
> undoable.”

> **Decision:** the
> two local histories and non-destructive overlays behave as above and expose query/
> action parity through UIP-D19.

> **Decision:**
> document history and the three local histories have independent storage, restore,
> queries/actions, and corruption scope.

Migration: absent streams initialize from the validated current Selection,
Display, or Camera state without creating a history entry. The first local
change publishes only its stream atomically. An unknown/incompatible version,
checksum failure, or invalid head resets only that stream to a valid current-
state baseline and writes a console explanation; it never resets another local
stream or the document journal.

P11 exposure: `selection.history.get/undo/redo/clear`,
`display.history.get/undo/redo/clear`, and
`camera.history.get/undo/redo/clear`; selection state remains readable/writable
through `select.*`, `selection.granularity.get/set`, and
`selection.kind_filter.get/set`; display through `interaction.state.*`,
`view.support_overlay.get/set`, and `view.labels.*`; camera through
`view.state.get/set` and the registered camera rows. `clear` removes entries but
does not change current state and is not itself recorded.

Acceptance gate `G-S01-12`: run `G-B2-HISTORY` with interleaved document,
selection, display, and camera changes; prove disjoint undo/redo, document-only
Ctrl+Z, branch truncation, one entry per completed gesture, independent atomic
restart recovery, project replacement/reopen, isolated corruption reset with
console reason, generated SDK parity, and `.hcad`/`.hcadx` round trips. Missing
streams and `.hcap` imports must open without writes.

## Deferred admissions

- Item 1 remainder is unnecessary for basic 0.5 measurement and is admitted at
  M-RW/D-06 with angle, planar area/plane warning, full reports, and their
  complete gates.
- Item 2 is unnecessary because 0.5 uses P9 effective state and existing
  layer/project causes rather than a canonical per-entity edit lock; M1 on the
  1.0 path admits it.
- Item 3 remainder is unnecessary because Plan is excluded from 0.5; M7 admits
  pinned viewports, Plan filters/update policy, and exact captured revisions.
- Item 4 is unnecessary because 0.5 creates no sheets or Plan-owned content; M7
  admits the complete Plan root.
- Item 7's offset/parallel profile and non-0.5 acquisition producers are
  unnecessary for breakline/boundary creation; M3/M-RW in 1.0 admits
  split/trim/parallel and the remaining point-acquisition profiles.
- Item 8 is already promoted by ADR 0030, so duplication here would create two
  authorities; X-R1/PhotoLab R1 consumes that existing admission.
- Item 9 is unnecessary for UI/SDK command parity in 0.5; M8 admits Agent
  actor, batch/root, restart, audit, and heavy-undo retention together.
- Item 10 is unnecessary because Civil is expressly excluded from 0.5; M5
  admits the complete Civil schema bundle.

Item 11 is not deferred: the 0.5 queue makes it a prerequisite, as recorded
above. Item 12 is likewise admitted because the 0.5 bottom-strip state uses all
three P8 streams.

## Consequences

- S-01 may implement only the named schema versions, additive readers,
  validators, persistence/migration paths, generated command/query contracts,
  and `G-S01-*` gates for items 1, 3, 5, 6, the admitted portion of 7, 11, and 12.
- The admitted schemas remain shared core/project-format contracts. Builder,
  PhotoLab, Cap import, WeltView, the automation host, and the Python SDK must
  preserve or reject them consistently; no app may create a private substitute
  store or raw-RPC exposure.
- S-01 may add no Plan root, edit-lock component, journal actor/batch schema,
  Civil bundle, Draw offset/parallel payload producer, full-measurement
  producer, or Plan-pinned ViewState state. Those remain forbidden until their
  named milestone ADR admits them.
- Admission does not prove a user workflow complete. Each domain slice must
  still pass its owning interaction, correctness, performance, cancellation,
  recovery, real-data, and demanding-user gates.
- Any owner veto changes the matching decision below and triggers MASTER-PLAN
  §9.6 across schemas, consumers, formats, SDKs, and tests before implementation
  continues.

## Primary references

- `docs/DATA-MODEL.md`, "Immutable resources" and "Pending data-model
  admissions".
- `docs/builder-program/REGISTRY.md` §4.4, items 1–12.
- `docs/builder-program/MASTER-PLAN.md` §0a, §5 S-01 and 0.5 packages, §6
  M-0.5, and §9.7.
- `docs/DECISION-DOCTRINE.md` X1–X7 and P1, P5, P8, P10, P11.
- ADR 0016, ADR 0019, and ADR 0030.
- The owning decision records quoted under each admitted item.

## Vetoable decisions

### ADR31-D1 — The 0.5 admission boundary

> **Decision:** admit Registry items 1 (basic producer profile), 3 (0.5
> ViewState profile), 5, 6, 7 (point acquisition and support role only), 11,
> and 12; leave item 8 to ADR 0030; defer items 2, 4, 9, 10 and the stated
> remainders of 1, 3, and 7.
> **Derivation:** MASTER-PLAN §0a, §5 S-01 and packages 0.5-01–0.5-08, §6
> M-0.5; X1/X7; Registry §4.4.
> **Rejected:** admitting all twelve items (expands beyond the owner-cut 0.5
> path); keeping item 11 deferred (contradicts the explicit S-B2 prerequisite
> and `G-B2-SEGMENTS`); admitting offset/parallel (belongs to 1.0 M-RW).
> **Tunable:** no.

### ADR31-D2 — Measurement is a restricted 0.5 producer profile

> **Decision:** admit `hcad.measurement@1` only for point,
> horizontal/spatial distance, and height difference in 0.5, while requiring
> the complete additive reader/persistence/automation tranche and preserving
> unknown future variants.
> **Derivation:** M-0.5 outcome 8; MI-D2/MI-D3/MI-D5; X1/X3/P1/P11.
> **Rejected:** transient-only measurements (violates P1); full D-06 in 0.5
> (scope expansion); silently accepting unimplemented kinds (false capability).
> **Tunable:** no.

### ADR31-D3 — ViewState migration is lazy and Plan-free

> **Decision:** admit `himmelcad.view-state` version 2 for entity clip refs and
> VD-D8 presentation, with no write on passive v1 open and no Plan-pinned
> fields or entities.
> **Derivation:** VD-D8/VD-D13; M-0.5 viewing-box path; X1/X3/X7; PROJECT-FORMAT
> compatibility rules.
> **Rejected:** eager open-time migration (changes files merely by viewing);
> retaining permanent value clips (a second clip authority); admitting Plan
> state without the Plan root.
> **Tunable:** no.

### ADR31-D4 — Snapshots are additive canonical markers

> **Decision:** admit `hcad.snapshot-marker@1` with snapshot-exempt restore and
> no dependency on deferred Agent actor/batch metadata.
> **Derivation:** FP-D4; P1/P5/P6; M-0.5 save/restart acceptance; P-01.
> **Rejected:** store copies (duplicates heavy data); restore that deletes
> snapshot markers (erases its safety marker); blocking snapshots on item 9.
> **Tunable:** yes — automatic-marker retention only, as owned by FP-D4.

### ADR31-D5 — One recipe envelope and one Mesh role resource

> **Decision:** admit the exact MT-D25 `hcad.derived-recipe@1` lifecycle and
> MT-D26 `hcad.mesh-source-roles@1` resource for the 0.5 DGM producers; no
> domain-private lifecycle or deferred producer may publish through them.
> **Derivation:** P10; MT-D25/MT-D26/MT-D34; M-0.5 outcomes 5–6; X1/X2/X3/P5.
> **Rejected:** provenance-free baked DGMs; app-private recipes; broad recipe
> admission merely because the envelope is shared.
> **Tunable:** yes — MT-D25 cost, checkpoint, page, and retention budgets only.

### ADR31-D6 — Acquisition/support admission excludes offset

> **Decision:** admit `hcad.component.point-acquisition@1` and
> `hcad.component.support-role@1` for 0.5 truth labeling and explicit support
> geometry; keep the DR-D20 offset/parallel payload unavailable.
> **Derivation:** DR-D18/DR-D21; M-0.5 breakline/boundary input; DESIGN-SYSTEM
> support token; M-RW's explicit split/trim/parallel scope.
> **Rejected:** inferring support from color/name/absence (invented truth);
> provenance-free input; pulling parallel editing into 0.5.
> **Tunable:** yes — display calibration and evaluator thresholds only;
> admission and truth labels are not tunable.

### ADR31-D7 — Stable segment locator moves into 0.5

> **Decision:** move Registry item 11 across the candidate line and admit
> `hcad.curve-subentity-ref@1`/`CurveSubentityRefV1` for deterministic 0.5
> selection and DGM-correction consumers.
> **Derivation:** MASTER-PLAN §5 S-B2 explicitly requires the segment-locator
> admission and `G-B2-SEGMENTS`; DR-D18; SE-D19; X1/X7.
> **Rejected:** deferral to 1.0 (leaves an explicit 0.5 prerequisite
> unauthorised); index-only or nearest-member locators (silent identity drift);
> materialized segment entities (fork geometry).
> **Tunable:** no.

### ADR31-D8 — Local histories share a schema, not state

> **Decision:** admit `hcad.local-history@1` as one envelope schema stored as
> three independently published, recovered, and corrupted Selection, Display,
> and Camera streams; Ctrl+Z remains document-only.
> **Derivation:** P8; UIP-D23; SE-D19; VD-D14; FP-D21; M-0.5's bottom-strip and
> `G-B2-HISTORY` prerequisites.
> **Rejected:** one temporal mega-history; three unrelated schema contracts;
> dropping local recovery on restart; focus-sensitive Ctrl+Z.
> **Tunable:** yes — depth and coalescing window under UIP-D23/X6 only.

### ADR31-D9 — Compatibility never fabricates admissions

> **Decision:** old projects, archives, `.hcap` inputs, and journals open
> without eager writes; absence stays absence; unknown versions are preserved
> read-only or rejected; immutable resources and journal history are never
> rewritten in place.
> **Derivation:** ADR 0016/0019; DATA-MODEL "Immutable resources"; PROJECT-FORMAT
> compatibility and migration; X1/X3/P5.
> **Rejected:** synthesize-on-open migration (invents provenance/roles/recipes);
> destructive in-place rewrites; silent drop or normalization.
> **Tunable:** no.
