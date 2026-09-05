# Registration & Stations — domain specification

Status: specified (registry 2026-09-02 incremental). This is the owed G14/S16 specification. Catalog rows are in
`REGISTRY.md` §1.14; `view.station` is owned here (VD-D11 discharged by RS-D5). Reciprocal cite-and-revise requests in §9
and the verification manifest remain implementation/admission work, not a registry-row blocker. No local command, schema,
gesture, or ownership claim below overrides an incumbent spec.

Normative basis: current `FUNCTION-CONTRACT.md`; `DECISION-DOCTRINE.md` X1–X7, P1–P11; owner statement S16
(`OWNER-STATEMENTS-2026-09-02.md` §S16/G14); ADRs 0021 and 0025; and the current owner decisions and design system. All UI copy
below is English. Registration means scan/cloud placement registration, not civil alignment stationing.

## 1. Scope, ownership, and function catalog

This domain owns first-class capture stations and registration groups, post-import cloud-to-cloud registration among already
canonical project entities, Station View, station-depth derivation, and registration-quality reports. It does not own file
admission, import-time registration, general point-cloud sampling, measurement entities, the shared recipe lifecycle, or the
generated automation transport.

### 1.1 Registry-compatible catalog

Access codes are R ribbon, X contextual ribbon/context menu, P Properties, C console, A automation, LP left panel, and Q viewport
quick surface.

| Function id                   | Tab / group                       | Access paths, including automation                                                                                                                                                                                                                                                                                                              | Surface                                                          | Performance                                  | Current implementation status                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `station.catalog`             | Pointcloud · Stations             | LP **Imported from** tree; X **Stations**; P; C; A `station.get`, `station.list`, `station.rename`, `station.rename_batch`; group A/C uses `registration.group.get`, `.list`, `.create`, `.rename`, `.remove_member`, `.dissolve`                                                                                                               | LP tree + Properties                                             | bnd; long only when expanding a paged source | **not existing**: E57 retains scan names/poses but merges the runtime stream (`crates/himmelcad-io/src/e57_import.rs:3-17`); a multi-scan association has no addressable station entity (`:1229-1288`)                                                                                                                                                                                                                                             |
| `registration.cloud-to-cloud` | Pointcloud · Registration         | R **Cloud-to-cloud**; X/Q **Register to…** on eligible cloud/station; C; A `pointcloud.registration.session.begin`, `.get`, `.activate_link`, `.add_link`, `.remove_link`, `.retry_link`, `.set_point_pairs`, `.suggest_coarse`, `.set_manual_delta`, `.preview_coarse`, `.apply_settings`, `.preview_icp`, `.background`, `.commit`, `.cancel` | dedicated resizable three-view workspace + RP                    | cont pick/navigation; bnd fit; long ICP      | **partial substrate, function absent**: robust fit and bounded ICP exist (`crates/himmelcad-core/src/registration.rs:343-416,510-635`), but the runtime owns staged imports only (`crates/himmelcad-sidecar/src/import_registration_runtime.rs:144-202,518-588`). Raw import registration dispatch exists at `crates/himmelcad-sidecar/src/main.rs:1323-1324,1897-2106`; its app-private boundary comes from AG-D4 and IF-D12, not those handlers. |
| `registration.report`         | Pointcloud · Registration         | R **Registration reports**; X on station/group; P; C; A `pointcloud.registration.report.get`, `.list`; export via `io.export.plan`, `io.export.execute`                                                                                                                                                                                         | RP inspection table + viewport QA overlay                        | bnd, paged; long export                      | **not existing**: the import wizard shows only summary RMS/overlap/matched values (`packages/@himmelcad/ui/src/ImportRegistrationWizard.tsx:1001-1015`); no canonical report/group consumer exists                                                                                                                                                                                                                                                 |
| `station.depth-image`         | Pointcloud · Stations             | X/P **Build station depth**; C; A `station.depth.plan`, `station.depth.build`; lifecycle A/C uses sole `derived.recipe.get`, `.list`, `.status`, `.regenerate`, `.regenerate_batch`, `.detach`, `.relink`                                                                                                                                       | RP plan + shared Jobs island                                     | long                                         | **not existing**: E57 imports an image with `depth: null` and `status: notRun` (`crates/himmelcad-io/src/e57_import.rs:1612-1633`); no builder/checkpoint service exists                                                                                                                                                                                                                                                                           |
| `view.station`                | View · Camera; station LP/Q entry | R **Station view**; LP double-click/row action; Q marker **Open station view**; X; C; A `view.station.open`, `.close`, `.get`, `.set_orientation`, `.reset_orientation`, `.apply_preset`, `.next`, `.previous`                                                                                                                                  | main viewport mode + compact station strip + orientation popover | cont; bnd switch; long depth is separate     | **partial substrate, workflow absent**: `PanoramaGeometry` and analysis view/depth sampling exist (`crates/himmelcad-core/src/entity_model.rs:750-759`; `packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:2259-2357`), but there is no Builder station mode, taxonomy, switching, or exact-source hand-off                                                                                                                                |

The architect must copy these five rows without changing ids or ownership. The existing deferred `view.station` row is replaced, not
duplicated. File Export remains the one export act: `registration.report` contributes **Registration report CSV** and **Registration
report HTML** scopes to its plan/execute flow. Per-station visibility dispatches the existing P9 `interaction.state.*` act;
per-station color dispatches `view.presentation.set`. Neither is a duplicate catalog row (P11; UIP-D20; VD-D8/VD-D12).

### 1.2 Canonical station, group, and report contract

Pending accepted data-model admission, the smallest truthful schema bundle is:

```text
StationV1 {
  entity_id, revision, type_id = hcad.station@1, name, owner, placement,
  source{import_id, source_scan_guid?, source_scan_name?, source_pose?},
  cloud{entity_id, revision, content_hash, representation_slot},
  panorama_ids[], registration_group_id?, capture_order?, attributes_ref
}
RegistrationGroupV1 {
  entity_id, revision, type_id = hcad.registration-group@1, name,
  fixed_station_id, member_station_ids[], report_ids[]
}
RegistrationReportV1 {
  entity_id, revision, type_id = hcad.registration-report@1,
  group_id, fixed_station_id, moving_station_ids[], method,
  input_revisions[], transform_deltas[], links[], summary,
  solver{algorithm_id, version, parameters}, created_by, created_at
}
RegistrationLinkV1 {
  link_id, fixed_id, moving_id, status, coarse_method,
  icp{mode, iterations, matched_samples, overlap_ratio, converged},
  aggregate_residuals, warnings[]
}
```

The transient, main-process-owned session has one independently reviewable link per moving resource:

```text
RegistrationSessionV1 {
  session_id, project_id, reference{id, revision, content_hash, placement_revision},
  ordered_link_ids[], active_link_id?, selected_link_ids[], group_destination?,
  phase, job_ids[], expected_project_generation
}
RegistrationSessionLinkV1 {
  link_id, moving{id, revision, content_hash, placement_revision},
  state: unaligned | coarse | fine | reviewed | committed,
  pairs[], coarse{method, transform, diagnostics}?,
  icp{profile_id, effective_values, result, checkpoint_ref}?,
  validation_token?, error?
}
RegistrationPairV1 {
  pair_id, link_id, moving_endpoint, reference_endpoint, weight, enabled
}
RegistrationEndpointV1 =
  Exact{entity_id, content_hash, placement_revision, locator, resolved_world_xyz} |
  Typed{world_xyz, project_units_at_entry} |
  Estimated{method, source_refs, residual, confidence, sample_count}
```

The session and its pairs/previews are transient under ADR 0025. The immutable report persists transform deltas, per-link aggregate
residual/min/max/overlap/convergence, solver/profile provenance, and warnings only. It does **not** persist manual endpoints,
locators, enabled/weight state, sampled ICP points, or nearest-neighbor correspondences. The Review outlier list is therefore a
live-session aid: it can locate endpoints only while the transient observations remain valid; reopened historical reports expose
aggregate diagnostics and captured transforms, never a misleading **Locate endpoints** action. No report or recipe can replay picks.

A Station is the semantic scanner setup/capture, not a renamed cloud. Its canonical placement is the station pose; its cloud and
panoramas are owned children/relations with their own immutable resources and absolute entity placements. Owner hierarchy is not an
implicit transform parent (SE-D8). Registering a Station therefore expands its exact child closure and left-composes the same rigid
delta into the Station, source-cloud, and panorama placements in one transaction; registering an unassigned cloud changes only that
cloud placement. A Station may own one source cloud in v1; a cloud without defensible scan identity remains an ordinary cloud and
can still participate. A Registration Group records membership and the fixed member; it adds no transform authority
(`DATA-MODEL.md`, Canonical Entity Layout).

The left tree is exactly:

```text
Imported from
  <source display name>
    Stations
      <station name>
        Point cloud
        Panoramas
          <panorama name>
    Unassigned point clouds
Registration groups
  <group name>
```

Group membership is exclusive in v1. Creating registration from an ungrouped reference creates a named group; an existing group is
an eligible destination only when its fixed resource is the selected reference. A moving member already belonging to another group
is rejected with **Dissolve its group first**; registration never silently merges, splits, or reparents it. Changing the fixed
reference requires dissolution followed by a new reviewed registration, not a membership-only move. The fixed
member cannot be removed or replaced. `registration.group.remove_member` removes one moving member and its current link projection
without changing historical report snapshots; it is one journaled command. `registration.group.dissolve` removes every current
membership/link projection but preserves reports as Historical with captured group/name/member snapshots. Delete is the same
command and is allowed only after no retained moving member remains; an empty group has no separate zombie state. `get/list/create/
rename/remove_member/dissolve` are revision-checked, conflict-visible, and undoable. A group eye is a P9 bulk operation over its exact
current member ids, not a visibility ancestor or second truth store: Mixed is computed presentation, and activation dispatches the
canonical per-entity interaction-state batch. Source ancestry continues to determine inherited state under SE-D19.

`owner` expresses containment; typed relations express station↔cloud, station↔panorama, and group membership. A source filename is
provenance, never identity. Rename changes only the display name. Multi-select **Rename…** previews all station/group results,
orders by stable id, resolves collisions by an explicit **Reject all** or user-selected deterministic numbered-suffix rule, and
commits all names as one cancel-before-publication transaction and one undo root. UI, console, Agent, and Python use
`station.rename_batch`; no automation loop substitutes for the visible batch workflow.

### 1.3 Derived station-depth profile

Station depth is one MT-D25/P10 output recipe, not canonical source geometry:

```text
recipe_kind = station_depth_image
parameter_type_id = hcad.station-depth-parameters@1
sources = [station pose, panorama image?, station cloud]
outputs = [depth field, validity/confidence masks, exact-source locator index]
parameters = {profile_id, projection, width, height, near, far}
algorithm_id = hcad.station-depth.spherical-nearest
```

Profile `hcad.station-depth.equirectangular-nearest@1` freezes these rules: longitude `u = (atan2(x,y)/(2π) + 0.5) mod 1`,
latitude `v = 0.5 - asin(clamp(z/r,-1,1))/π`, with pixel centers `((i+0.5)/width,(j+0.5)/height)`, a half-open longitude seam,
and the north/south poles assigned to the lowest column index. Range is f64 metres in station-local `rayDistance`; non-finite,
non-positive, `< near`, or `> far` samples are invalid. The nearest positive range wins; equal ranges compare the complete immutable
locator lexicographically. `valid = winner exists`. A cell is `discontinuity` when any valid 8-neighbour differs by more than
`max(0.02 m, 0.01 * min(range))`; confidence is `0` for invalid, otherwise `clamp(winner_count / 4, 0, 1) *
(discontinuity ? 0.5 : 1)`. These numeric constants are profile-version tunables under X6, but an implementation may not vary them
without a new/evidenced profile. The collision policy is fixed by the algorithm and is not an exposed parameter.

Source selection is deterministic. Prefer a validated structured range/depth channel associated with the exact station and source
generation; otherwise use the explicitly associated station cloud. When both exist, structured range wins and the plan names the
unused cloud. RGB alone is ineligible and yields image-only/NoData, never photogrammetric inference. For structured input, original
valid row/column samples map through the declared scan projection and invalid cells stay invalid; resampling to an output grid uses
the same nearest-positive winner rule, never bilinear range invention. For cloud input, the builder projects from the canonical
station origin.

`exact-source locator index` is versioned direct addressing, not spatial search:

```text
StationDepthLocatorV1 =
  Structured{source_content_hash, scan_id, image_id, row, column} |
  Cloud{source_content_hash, import_member_id?, partition_id, chunk_id, point_ordinal}
```

Resolution indexes directly to the exact stored record, verifies recipe/source/content/placement generations and locator bounds,
and returns `Unresolved` on mismatch or absence. Nearest-neighbour substitution and full-source scans are forbidden. Hover uses
resident cells only. Click shows busy feedback within 100 ms; an evicted storage fetch is cancellable and reports progress after
250 ms. `exact-source locator index` maps a valid cell to the winner; it is not a user-editable per-point entity id.

Native structured range/row-column data may be a source only when import preserves and validates its exact station association.
Otherwise the builder spherically projects the station's own cloud from the canonical station origin. An RGB panorama alone contains
no range. With image only, Station View is image-only and Build says **No station cloud or structured range is available**; it never
fabricates depth (E57's current explicit no-invention posture is `e57_import.rs:8-17`).

Automatic regeneration budget is zero. Content, panorama-camera/relative-pose, association, projection/profile, resolution, or
algorithm-version change marks the recipe `linked-stale` at transaction end. A placement-only change follows the P10
placement-equivalence corollary: if station, panorama, exact depth source, and output receive the identical rigid left-composed
delta, and content/profile/locator mapping/station-relative transforms are unchanged, the transaction advances source placement
references and generations while retaining the immutable artifact hash and `linked-current`. Any differential transform or failed
proof is stale under MT-D25. The equivalence proof and exact generation mapping are audit fields of the registration commit. Last-good
stale depth remains visible with a **Depth out of date** badge, but exact picking and measurement are blocked until explicit
regeneration. Direct depth editing is absent; Detach preserves the bake for image inspection but permanently labels it detached and
blocks source-exact measurement. MT-D25 alone owns lifecycle commands, DAG/CAS, last-good, persistence, restore, undo, and GC roots.

### 1.4 Ownership boundaries and registered obligations

| Inbound obligation                                        | Disposition here                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S16/G14 RealWorks-starter station/registration outcome    | adopted as this complete spec; not reduced to the existing import wizard (`OWNER-STATEMENTS-2026-09-02.md` §S16/G14)                                                                                                                                                              |
| View `view.station` / VD-D11                              | adopted and revised by §§1.1, 2.3, 6, RS-D5; View retains camera/display history and viewport-mode infrastructure                                                                                                                                                                 |
| VD-D12 per-station color and walkthrough/fly-to           | per-station color adopted through View's existing act; walkthrough/fly-to remains explicitly deferred because Station View satisfies S16 and Perspective's primary station posture; no silent pruning                                                                             |
| P9 station visibility/state                               | adopted unchanged: Hidden and Inert are ineligible; Reference is inspectable but not transformable; Editable is fully eligible; source ancestry propagates, while a registration group summarizes Mixed and dispatches a bulk per-member command (UIP-D20/SE-D19; RS-D12)         |
| UIP-D23–D26 3D target/cursor/continuous contract          | adopted for point-pair acquisition; exact platform extension requested in §9, not locally forked                                                                                                                                                                                  |
| PC-D17/PC-D18 sampling                                    | cited, not re-dispositioned: grid-mean and station-corridor sampling remain Pointcloud-owned and are not silently reused as ICP/depth truth                                                                                                                                       |
| IF-D19–IF-D25 PhotoLab arrivals                           | cited, not re-dispositioned: IF-D19 imports a prepared product as ordinary domain-owned entities; station-aware packages must satisfy this schema or arrive as ordinary unassigned clouds; IF-D20–D25 keep sole generated admission, parity, snapshot, source, and consumer rules |
| AG-D4/AG-D13 raw `registration.*` bounds                  | adopted: raw import-session RPCs remain app-private; public post-import acts are the typed `pointcloud.registration.*` commands in §1.1, generated through AG-D22/P11                                                                                                             |
| ADR 0021/0025 import-time registration                    | remains Import-owned. This domain reuses the solver and reviewed-preview shape but cannot take, resume, commit, or cancel an Import-owned staged session                                                                                                                          |
| MI-D5/MI-D14 exact picking and passive recipe consumption | adopted unchanged: Station View measurement routes to `measurement.*`; Measure never regenerates depth and refuses coarse/stale/detached picks                                                                                                                                    |
| MT-D25 recipe lifecycle                                   | cited, not re-dispositioned; §1.3 supplies the typed station-depth profile and applies P10 placement equivalence; reciprocal MT-D25 specialization remains a §9 registry-pending request                                                                                          |

## 2. Full user-perspective workflows

### 2.1 Stations arrive and remain understandable

After importing a station-bearing E57, the user expands **Imported from**, the source, and **Stations**. Each station row shows its
name, effective P9 state, registration-group badge, cloud availability, panorama availability, and depth state. A missing panorama
or stale depth is words plus icon, never an empty placeholder. Ordinary LAS/LAZ clouds appear under **Unassigned point clouds**;
Builder does not invent stations from filenames or spatial clusters (X1).

Click selects the Station as one semantic unit and frames its marker/cloud. Expanding reveals the cloud and panoramas for inspection
without changing selection. The row eye uses the shared P9 state menu. Hidden removes station marker, cloud, panorama,
registration-link drawing, pick/snap candidates, and Station View eligibility. Inert still renders but exposes no viewport reaction
or command. Reference renders, can be opened/measured and can be the fixed registration input, but cannot move. Editable adds
moving-registration and rename/group actions. Source-parent changes propagate; a group summarizes exact member state as **Mixed**
and its eye performs the explicit P9 bulk command without becoming an inherited parent or flattening later member choices.

Properties names source GUID/name, exact source pose, current placement, children, group, and depth recipe state. **Build station
depth** appears only when the admitted source set can produce it. Source replacement is an Import transaction; on successful
replacement IF-D18 invalidates the station recipe once and this domain marks reports that referenced the old revision historical.

### 2.2 Cloud-to-cloud registration between project entities

1. The user selects one or more Editable station/cloud rows and chooses **Pointcloud > Registration > Cloud-to-cloud** or **Register
   to…**. The workspace opens with **Reference**, **Moving**, and **Combined** views plus a right-side steps panel. Current
   selection seeds Moving but is not a hidden ongoing filter.
2. The Reference picker lists visible Reference or Editable clouds/stations. The user chooses one fixed reference and one or more
   moving inputs. Hidden, Inert, duplicate, cyclic ownership, already-edited-by-another-session, empty, stale-revision, and
   unsupported entities are disabled with reasons. The captured ids/revisions/placements are shown before **Start**.
3. Builder creates one stable link per moving resource, orders the member list by launch order then stable id, selects the first as
   active, estimates sample cost, and pins immutable source revisions. The list always shows each member's independent
   **Unaligned → Coarse → Fine → Reviewed → Committed** state, error, and residual summary. Exactly one active link drives
   the single Moving pane, Combined preview, pair table, and residual panel; changing the active link preserves every other link's
   observations, settings, and result. `activate_link`, pair, coarse, refine, retry, and discard operations always carry `link_id`.
   `add_link` and `remove_link` update only transient membership; remove/discard confirms when observations exist. **Apply settings
   to selected links** validates every target first and changes all or none. A bounded preview opens promptly; preparation beyond the
   long threshold becomes a shared job with real point/node/byte progress. No canonical placement has changed.
4. In **Coarse alignment**, the user clicks **Add point pair**. The Moving view prompts **Pick point in moving cloud** for the active
   link; an exact Shared3DTarget reticle marks the source. The Reference view then prompts **Pick matching point in reference
   cloud**. The ordered pair appears with pair/link ids, both XYZ values, `Exact`/`Typed` acquisition badges, precision, and residual.
   A pair may instead be typed as two XYZ triples. `Estimated` can guide hover but cannot enter a Ready pair. Releasing a dragged
   endpoint is `Exact` only after snapping to and revalidating a point in that endpoint's own pane; otherwise it becomes visibly
   `Typed`, stores the entered/world coordinate, and drops every source locator. It never silently selects a nearest source point.
   Three non-collinear pairs enable **Preview alignment**. Delete, disable, and re-pick are explicit row actions; Backspace removes
   only the current pending half-pair.
5. The user may request **Suggest coarse alignment**. It produces an optional, badged suggestion and diagnostics for the active link
   but never advances beyond Coarse or commits without explicit review. Constrained manual alignment exposes typed translation XYZ
   and intrinsic Z-Y-X rotation fields plus matching axes/rings; it remains a rigid delta and calls the same reducer as dragging.
   Unconstrained free pan/rotate is absent because it cannot provide C1 numeric and audit parity. The rigid robust fit previews the
   moving placement in Combined. Pair lines are colored by residual status, not merely a
   continuous rainbow. Degenerate, non-finite, stale, or estimated targets cannot produce Ready to review. Scale is fixed at 1.0 and
   not presented as an option (RS-D4).
6. The user chooses **Refine with ICP**. The panel shows mode, maximum correspondence distance, minimum overlap, iterations, and
   deterministic sample count. Typed fields and automation are identical. **Run refinement** starts a cancellable job; Combined
   keeps the last complete preview while the panel reports phase, iteration, matched samples, and overlap. Cancel restores the
   coarse preview and publishes nothing.
7. **Review** changes the active link from Fine (or Coarse when refinement was deliberately skipped) to Reviewed and shows
   Before/After, flicker, per-link RMS 3D/min/max, matched samples, overlap, convergence, warnings, and the resulting f64 rigid
   transform. While the transient session is live, the user can select an outlier row to locate both endpoints. Historical reports
   show aggregate diagnostics only. A non-converged or
   below-minimum-overlap result cannot commit. Thresholds are admission parameters, never a badge that overrides solver failure.
8. **Commit registration** is enabled only when every retained link is Reviewed against the same immediately revalidated reference
   generation. A stale/failing member returns to Coarse with its precise error; the user repairs/retries it or explicitly removes it.
   Commit performs one optimistic transaction: apply only the rigid placement delta to every moving unassigned
   cloud or to the exact Station + source-cloud + panorama child closure defined in §1.2, create/update one Registration Group, and
   create the immutable Registration Report. It checks every captured revision and source hash immediately before publication. Any
   conflict/failure rejects the whole batch: no placement revision, group/report, invalidation, or undo entry publishes, and review
   stays open on the failing link.
9. The tree and viewport update after the journal acknowledgment. One Undo restores every prior placement, group membership, and
   report reachability plus the complete consumer set in §8; Redo reapplies the atomic result. Undo granularity is the committed batch
   root—not one Ctrl+Z per link—because partial reversal would falsify the reviewed group transaction. A later explicit
   `registration.group.remove_member` is a new per-link journaled transaction and has its own Undo. Point-resource hashes do not
   change. Placement-equivalent depth/derived artifacts remain current; differential relations become stale once after commit.

Close symmetry is explicit. Closing before Start exits. Closing with a pending pair discards that half-pair. Closing a live fit/ICP
offers **Continue in background**, **Cancel registration**, or **Keep working**. Background keeps the canonical main-owned session/job
identity and immutable launch snapshot, lists reference/group/member count, phase, real progress, **Cancel**, and **Reopen** in Jobs,
and permits unrelated edits. Reopen restores the exact active link, list scroll/selection, last complete previews, and review state.
If captured inputs change before completion, the job finishes **Needs attention**, returns that link to Coarse, and never applies
automatically. Renderer reload preserves job identity; process restart restores only hash-valid checkpoints and otherwise reports
**Restart refinement required** with the affected link. Cancellation acknowledges at the bounded safe point and then closes. Closing a
review says **Discard preview?**; discard releases pinned inputs and transient pairs. There is no suspended point-pair draft because
ADR 0025 requires fresh observations and P5 gives heavy jobs checkpointing, not authority to persist unreviewed control evidence.
Project close uses the same cancel path. Renderer reload rehydrates a main-owned live job and its last complete preview; if
transient exact pick tokens cannot be revalidated, the session returns to Coarse alignment with the affected pair named.

Multiple moving stations may share a fixed reference and commit atomically, but v1 solves independent fixed↔moving links. Network
target adjustment, combined target/point/cloud adjustment, and bundle adjustment are deferred with explicit reasons in §3; no report
calls the result a network adjustment.

### 2.3 Build and use Station View

The user opens Station View from a station marker, row action/double-click, context menu, or View ribbon after selecting one
eligible station. The main viewport moves to the exact station origin. When an associated RGB panorama exists it is a
non-authoritative underlay; otherwise valid depth renders with an honest depth/luminance shader and the strip says **No panorama —
depth view**. Building depth never claims to create radiometry. A cloud-only station offers the build plan; until completion the
ordinary 3D view remains available.

If depth is missing, the image is still navigable and the strip says **Depth not built — picking and measurements unavailable**.
**Build station depth** opens a plan naming station, source cloud, panorama, projection, requested resolution, estimated input
points/output bytes, and available disk. Confirm registers a main-owned shared job. Phases are **Inventory**, **Project points**,
**Resolve cells**, **Verify**, and **Publish** with actual points/partitions/tiles/bytes. The user may close the plan or Station
View; the job continues. Cancel stops at the tile boundary, retains a verified checkpoint, and offers **Resume** or **Discard build
data** in Jobs.

For multiple selected stations and **Build missing/stale depth images**, the same command first creates one canonical batch plan. It
lists every eligible/ineligible station with reason, selected source/profile, per-item peak bytes, aggregate peak reservation,
available disk plus safety margin, and deterministic order `(source_content_hash, station_id)`. Nothing starts unless the entire
aggregate reservation succeeds and the user confirms. The default heavy-worker cap is one until G-RS-DEPTH-BATCH calibrates a
higher cap; queues are bounded and duplicate immutable sources share content-addressed reads/indexes. Each station owns independent
checkpoint/result/error state. **Cancel current** preserves verified prior items and pauses that item; **Cancel remaining** prevents
unstarted items; resume hash-verifies and skips completed artifacts. One corrupt station fails only that item. The batch history row
groups the UI intent, while artifact retry/lifecycle remains per station and no partial artifact is published.

Restart loads only hash-valid checkpoints matching project, station/cloud/ panorama revisions, placement, parameters, algorithm
version, completed source partitions, and tile checksums. It resumes from the first incomplete partition. A source change makes the
checkpoint incompatible and preserves it only as a short-lived GC root until the job reports **Source changed — restart required**.
Publication writes immutable artifacts first, verifies them, then atomically publishes the MT-D25 recipe/output link. Partial depth
never becomes reachable.

In Station View, LMB drag rotates yaw/pitch about the fixed station origin; wheel zooms; RMB drag and MMB drag pan are intentionally
unavailable because translation would leave the real capture origin. The pointer uses the ordinary orbit cursor, and pitch clamps
to `[-89°,+89°]`; yaw wraps to `[-180°,+180°)`, and vertical FOV clamps to `[10°,120°]`. A design-system orientation
popover/Properties card exposes editable **Yaw**, **Pitch**, and **Vertical FOV**, **Reset**, and named front/back/left/right/up/down
presets in project angular units while storing f64 radians. Drag, wheel, keyboard step, fields, and generated commands use the same
reducer, live-synchronize, and contribute one Camera-history gesture; close/reopen restores exact values. The station strip contains
station name, image mode, depth status, **Previous**, **Next**, orientation, and an exit thumbnail. Previous/Next follow stable
capture order, then name/id; Hidden or Inert stations stay listed but disabled and are never silently skipped. Exit restores the
exact prior view mode/camera from local View history (P8).

The View color control offers **Panorama**, **Luminance**, **True color**, and **Cloud** only when that station has the required
resources. RGB is sampled independently at its native resolution and may never establish validity; depth/mask lookup uses the depth
grid, so differing resolutions do not resample validity from color. Invalid depth cells retain visible image/depth context under the
shared invalid-data hatch and text legend, expose valid/NoData/discontinuity masks, use a prohibited cursor, and accept no click.
Missing image regions are not interpolated color. Other stations do not
contribute depth or pick candidates. Registration links, the viewing box, free orbit pivot, selection gizmo, walk/fly, and editing
are not available in Station View; the strip explains **Return to 3D View to edit**. Perspective likewise disables its limit box in
Station View (`dossiers/trimble-perspective.md` §2.3).

With current linked depth, a click samples depth, resolves its locator to the exact immutable source point, revalidates P4
visibility and source revision in core, and reports station distance plus world XYZ. If the cell has NoData, stale/detached depth,
an unresolvable locator, or only a rendered estimate, the cursor says **No exact point** and no Save action appears. Starting Point,
Distance, Horizontal distance, or Height difference routes to the existing `measurement.*` acquisition and panel; Station View
supplies exact anchors and origin-station metadata only. Area is unavailable because MI-D13/ Perspective §2.6 restricts it to Map
View. No measurement value or entity is owned here.

### 2.4 Registration quality, inspection, and export

Opening **Registration reports** shows group summaries first and link rows second. Each link names fixed/moving revisions, method,
status, aggregate point-pair RMS/min/max, ICP iterations/matched/overlap/convergence, transform delta, warnings,
algorithm version, and creation actor/time. Empty or not-run fields display an em dash; zero is never substituted. Selecting a row
frames/highlights the two station markers and their link in 3D View. In Station View the report remains readable but the QA overlay
is unavailable with the reason named.

Reports are committed inspection records, not live recalculations. They contain aggregate link diagnostics, not manual pair rows or
endpoint locators. Later placement/source changes mark the row **Historical — inputs
changed** and retain the recorded values/revisions. Undo of the registration removes the report from ordinary reachability as part
of the same root; retained journal/snapshot roots keep its immutable data recoverable. Report rows are not selectable geometry,
snappable, transformable, clip participants, or measurement sources (MI-D2 and MI-D14's passive-inspection boundary).

**Export…** opens the one File Export plan with selected report/group scope. Portable CSV schema `himmelcad.registration-report@1`
writes one `summary` and one `link` per fixed↔moving link, all with `schema_version`,
report/group/station ids and revisions, SI values plus unit, status, method, solver/version, transform components, residual fields,
overlap, matched count, convergence, warnings, and project journal revision. HTML is the same captured data in a human-readable
table. Both stream rows, reserve peak temporary destination bytes before starting, report phase plus rows/bytes, cap additional RSS
at 64 MiB and scratch at estimated output + 16 MiB, show first progress within 250 ms and cancellation within 250 ms/out within 2 s,
and restart from zero after process loss. They write a sibling temp, then atomically replace; cancel/failure deletes the incomplete
temp, leaves no partial, and preserves an existing target.
RTF is deferred because no in-repo format contract exists.

## 3. Reference catalog dispositions

Each relevant dossier catalog row is named; owner-domain rows are cited rather than silently re-owned. The two dossiers were checked
end-to-end for the absence claims below.

### 3.1 RealWorks dossier

| Dossier row / section                                  | Disposition                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Import scans (§2.1)                                    | adopted by Import, not re-dispositioned; station-bearing E57 must arrive through IF-D19–D25/this schema                                          |
| Station sampling on import (§2.1)                      | deferred to Import/Pointcloud; not reused as post-import ICP or depth truth                                                                      |
| Sampling spatial/intensity/range (§2.1)                | adopted by Pointcloud; PC-D17/PC-D18 remain authoritative                                                                                        |
| Scan-Based Sampling > Split per Scan (§2.1)            | adapted: preserve one semantic Station and source cloud per source scan at admission; no destructive post-hoc split                              |
| Project tree (WorkSpace) (§2.1)                        | adopted as §1.2 taxonomy, grouping, P9 state, rename, and multi-select batch-pattern rename with preview/collision/transaction/undo parity       |
| Scan Explorer (§2.1)                                   | adopted as Station View and exact measurement hand-off; structured export remains File/Import-owned                                              |
| Auto-Extract Targets and Register (§2.2)               | deferred: target detection/model/admission lacks an in-repo canonical contract and starter S16 calls cloud-to-cloud                              |
| Target Analyzer (§2.2)                                 | deferred with target extraction; no target entity is invented                                                                                    |
| Auto-Register using Planes (§2.2; W1)                  | deferred: plane extraction/selection/confidence needs a separate deterministic solver contract; reference-selection/report posture is adopted    |
| Cloud-Based Registration: automatic seed (§2.2; W2)    | adapted as optional **Suggest coarse alignment**; suggestion is visibly provisional and cannot become Reviewed/commit without user review        |
| Cloud-Based Registration: manual Pan/Rotate (§2.2; W2) | adapted to constrained rigid translation/rotation handles with typed numeric twins; unconstrained manipulation is rejected by C1/X1 audit parity |
| Cloud-Based Registration: pairwise picks (§2.2; W2)    | adopted as per-link exact/typed pairs in the three-view workspace                                                                                |
| Cloud-Based Registration: Refine (§2.2; W2)            | adopted as bounded, cancellable per-link ICP                                                                                                     |
| Cloud-Based Registration: visual check (§2.2; W2)      | adopted as per-link Before/After/flicker/residual review                                                                                         |
| Cloud-Based Registration: Apply Group (§2.2; W2)       | adopted as one reviewed all-links-or-none placement/group/report transaction                                                                     |
| Refine Registration using Scans (§2.2; W1)             | adapted: rigid ICP per fixed↔moving link; whole-network refine deferred                                                                          |
| Adjust Registration (§2.2)                             | deferred: mixed targets/points/clouds and mutable link network require target/network schemas not present in starter                             |
| Bundle adjustment (§2.2)                               | deferred: v1 reports independent links and never claims network covariance/adjustment                                                            |
| Georeferencing / Orientation / UCS (§2.2)              | rejected from this function: registration cannot invent CRS/control truth; existing transformation/georeference owner remains authoritative      |
| Registration report & visual check (§2.2)              | adopted as reviewed pre-commit §2.2 and immutable §2.4 report                                                                                    |
| Measurement tools (§2.6)                               | adopted by Measure; Station View supplies exact depth picks, not another measurement model                                                       |
| Station markers vs box (§2.5)                          | adopted by Viewing Box/View visibility consumers; this domain supplies marker identity only                                                      |
| Media/report outputs (§2.9)                            | adapted: CSV+HTML via File; RTF deferred for absent in-repo codec contract                                                                       |
| Examiner/Walkthrough/Fly-to (§2.10)                    | deferred: Perspective's constrained Station View is primary and S16 does not require free roaming; retained under VD-D12                         |
| Station 3D markers scaled by distance (§2.10)          | adopted at outcome level through shared viewport marker scale/readability; visual criterion V2 makes it failable                                 |

### 3.2 Trimble Perspective dossier

| Dossier row / section                                             | Disposition                                                                                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map View (§2.1)                                                   | adopted by View, not re-dispositioned                                                                                                                                                               |
| 3D View (§2.1)                                                    | adopted by View, not re-dispositioned                                                                                                                                                               |
| Station View (§2.1; W2; §4; §5)                                   | adopted as §2.3: real origin, 2-DOF rotation, image-backed rendering, list/marker/previous/next entry and thumbnail exit                                                                            |
| Per-station/per-scan color; registration-set color (§2.2; W3)     | adapted through View's color-mode act; no registration-local display store                                                                                                                          |
| Station markers, labels, registration links (§2.2)                | adopted as passive render consumers of station/group/report state                                                                                                                                   |
| Station View NoData red and image/luminance/panorama modes (§2.2) | adopted with design-system status tokens plus an explicit text legend; red alone never carries meaning                                                                                              |
| Limit box disabled in Station View (§2.3)                         | adopted; returning to 3D restores the unchanged box                                                                                                                                                 |
| Station object selection (§2.5)                                   | adopted through shared selection/P9; bare panorama pixels do not become entities                                                                                                                    |
| Point/distance/horizontal/vertical measurements (§2.6; W5)        | adopts only the observed ability to pick scan data in Station View; exact locator mechanics derive from X1, S16, MI-D5, and the versioned source schema, not an asserted Perspective implementation |
| Area in Map View (§2.6)                                           | rejected in Station View; unchanged Measure/View capability elsewhere                                                                                                                               |
| Measurement persistence/panel/edit/export (§2.6)                  | adopted by MI-D2–MI-D14, not re-owned here                                                                                                                                                          |
| Magnify on one/all including hidden stations (§2.7)               | rejected for Station View v1: P4 forbids hidden geometry becoming an implicit pick source; ordinary 3D tools retain their owners                                                                    |
| nearest/recent station filters (§2.7)                             | deferred: stable Previous/Next and explicit P9 visibility ship first; filter presets require observed Builder repetition                                                                            |
| per-station/per-scan show/hide (§2.7)                             | adopted through P9 with parent propagation and Mixed state                                                                                                                                          |

On the current dossier revisions, a whole-file search including every section and source ledger used the terms and synonyms
`depth`, `range image`, `station raster`, `cache`, `artifact`, `build`, `regenerate`, `stale`, `invalidate`, `checkpoint`, `resume`,
and `NoData`. It found no documented content-addressed station-depth build, checkpoint/restart, exact-source locator, stale recipe,
or atomic publication contract in RealWorks, and no derivation/cache lifecycle in Perspective. This records absence from the
dossiers, not proof that either competitor lacks the feature, and must be repeated after a dossier revision. Perspective §2.6/W5
establishes only that scan-data measurement is available in Station View; its statement about a hidden structured-range mechanism
is unsupported by the cited source and is not used here. S16 requires Himmel:CAD's depth approach; X1, MI-D5, P5/P10, and MT-D25
determine its exact and safe lifecycle.

## 4. Function contract — station catalog and model

**A1.** The user can discover every defensible capture station, understand its source/cloud/panorama/group/depth state, control its
shared interaction state, and address it identically from UI, console, and automation.

**A2.** RealWorks §2.1 Project tree and Split per Scan ground hierarchical stations, groups, visibility, and rename. Perspective
§2.1/§2.7 grounds the Stations List, marker/list entry, and per-station toggles. We adapt to canonical Station entities and reject
inferred stations as stated in §3.

**A3.** Import supplies source scan identity and children; Pointcloud owns cloud storage/sampling; View renders markers/color; P9
owns state resolution; File round-trips; Station View, registration, reporting, measurement, snapshots, Plan/viewer publication,
automation, and strict sibling readers consume the same ids. No sibling may reconstruct station identity from names.

**B1.** §1.1 is exhaustive. LP is primary; contextual actions appear only for eligible station/cloud rows; Properties is
inspect/edit; console/automation are complete. No dedicated keyboard shortcut is claimed.

**B2.** Tree expansion and Properties close without mutation. Rename commits on Enter/blur and Escape restores the prior value.
State menus close without change unless an item was activated. Project close needs no Station prompt; active registration/depth
behavior is owned by §§5–6.

**B3.** The hierarchical inventory belongs in LP and facts/actions in Properties. Neither a modal nor a floating island can show
large mixed trees with stable context; registration alone earns a dedicated workspace.

**C1.** Station organization has no coordinate-bearing pointer input. Rename and grouping have exact console/automation fields;
placement is read-only here and editable only through registration/transform owners. Pick/type parity is N/A for topological tree
actions.

**C2.** Selection captures stable station/entity ids, never row indices. Single-select opens station facts; multi-select permits
common P9 state/group actions, batch rename, and registration eligibility. Mixed child selections report exact counts. Selection
changes after launching registration do not change its inputs. Group membership is exclusive and every create/get/list/rename/
remove-member/dissolve, already-grouped conflict, fixed-member invariant, delete condition, and P9 bulk-eye behavior is defined in
§1.2; no implicit merge/reparent path exists.

**C3.** P9 state, canonical selection, names, ownership, relations, and recipe state are freezable/readable by id/revision. LP
expansion/filter/scroll and Properties tab are view-local. A Station id is required; source-name lookup is never a canonical
automation selector.

**C4.** Station/group/name/state changes are journaled document transactions and round-trip `.hcad/.hcadx`; selection/expansion
remain P8 local histories. Immutable clouds/images/depth/report resources, recipes, journal undo, snapshots, and active jobs are GC
roots under Project Format/MT-D25. Undo restores the complete affected owner/relation/state set, not orphan rows.

**D1.** Expand/list is bounded and paged at 1,000 children; LP virtualizes 100,000 stations with input-to-row-update ≤150 ms p95.
Marker culling is continuous and must pass the VB-D7 presented-frame metric: p95 frame interval ≤2× the configured target on the
named scene. Once executable, G-RS-CATALOG and G-RS-STATION-CADENCE enforce this.

**D2.** Weak hardware reduces off-screen marker detail and label density, then cloud display density; it never merges station
identities, changes P9 state, hides status text, or substitutes names for ids. A paged loading row is honest.

**E1.** V1–V4 and V11 in §10 are the in-repo visual/behavioral artifact.

**E2.** Import update, delete, undo/redo, snapshot restore, P9 parent changes, registration commits, depth stale events, report
history, View markers, selection, Properties, File round-trip/export, Plan/viewer publication, Agent, Python, and WeltView are
active consumers. Least member is one cloud-only station; largest is 100,000 stations under 1,000 sources with mixed state and
missing images. Restore publishes owner, children, group, report, recipe, and resources as one visible generation before consumers
revalidate.

**E3.** G-RS-SCHEMA, G-RS-CATALOG, G-RS-CONSUMERS, and G-RS-AUTOMATION in §11.

## 5. Function contract — cloud-to-cloud registration and reports

**A1.** The user can align existing clouds/stations to one fixed reference with exact point pairs, refine with bounded ICP, review
objective residual/overlap evidence, commit one reversible placement-only transaction, and inspect/export the immutable report.

**A2.** RealWorks §2.2/W2 grounds fixed/moving/combined panes, pairwise coarse alignment, Refine, visual check, Apply grouping, and
reports. W1 grounds central reference, link error/overlap/confidence, and refine. We adopt only evidenced cloud-to-cloud statistics
the current solver can define; “confidence” is not invented. Target/network rows are deferred individually in §3.

**A3.** Import-time registration stays IF/ADR-owned; core solver is shared; station/cloud/P9 providers supply inputs; UIP supplies
Shared3DTarget/cursors; Jobs owns progress; journal/Project owns commit and undo; View consumes placement and QA overlay; recipes
consume placement invalidation; Measure is passive; File exports; Agent/Python call generated public commands. Raw `registration.*`
RPC is never exposed.

**B1.** §1.1 lists every path. Ribbon is discovery; context/quick action supplies entity relevance; console and public automation
are complete. Registration reports are also reachable from group/station Properties, and export uses File's `io.export.plan/execute`
contribution. No shortcut is claimed.

**B2.** The complete close/cancel/project-close/reload symmetry is §2.2. One Escape press resolves exactly one UIP-D14 rung: field
revert → active reticle drag/pending half-pair → menu → armed pair tool → workspace close prompt → function tab → selection. Commit
closes only after acknowledgment.

**B3.** The three spatial canvases plus steps/report require a dedicated resizable workspace; a dialog or RP alone would make
comparison illegible. Report browsing without live alignment remains in RP. Detach is not offered in v1 because it would create four
live viewport ownership surfaces.

**C1.** Each point pair has symmetric `{moving Position, reference Position}` fields in project units plus its `Exact | Typed |
Estimated` discriminant. Shared3DTarget drag and field edits remain synchronized; an off-source release becomes Typed and loses its
locator, while Exact requires fresh same-pane snap/provider/core revalidation. Estimated may preview but cannot enter Reviewed.
Pointer, keyboard, fields, and automation call the same reducer. ICP distance, overlap, iteration, and robust thresholds use the
versioned §5 profile and are typed, validated, and available in automation. There is no output-transform override field.

**C2.** Inputs are captured explicitly at Start; later global selection is irrelevant. The fixed reference is exactly one; moving is
one-or-many with stable ids/revisions and one §1.2 session link each. The ordered member list, active link, per-link pair/result/
state/error, add/remove/retry/discard, selected-link settings apply, and transitions are canonical main-owned session state. Only the
active link drives Moving/Combined/residual panels, and every command carries `link_id`. Mixed P9 admission gives per-item reasons
and never silently drops an item. Every retained link must be Reviewed against one reference generation for atomic commit.

**C3.** A freezable session snapshot includes ids/revisions/hashes/placements, solver parameters, enabled point pairs with exact
positions/provenance, last complete preview, phase/progress, diagnostics, and expected revisions. Raw samples are bounded
ephemeral/checkpoint artifacts, not embedded in query responses. Paged reports expose the same committed fields to UI/Python/Agent.

**C4.** Pairs, endpoint locators, sampled ICP data, and previews remain transient under ADR 0025. Commit journals placement deltas,
group membership, aggregate-only report, the typed invalidation/equivalence set, and reverse relations atomically; one batch-level
undo/redo root restores the complete §8 affected-state set. Individual link removal after commit is a separate journaled command,
not hidden sub-root undo. Points are never rewritten. Report resources and source sample/checkpoint hashes remain reachable through
active job/journal/snapshot roots. Cancel publishes nothing and releases roots after checkpoint retention expires.

`hcad.registration-profile@1` is the exact v1 parameter contract. The current implementation defaults are the measured-code
baseline, not survey truth: rigid robust fit `maximum_iterations=20` (`1..100`), `huber_delta=0.05 m` (`0.001..10 m`), and
`convergence_epsilon=1e-10` (`1e-14..1e-4`); ICP defaults to point-to-point, `sample_count=2048` (`128..2048`),
`maximum_iterations=30` (`1..100`), `maximum_correspondence_distance=1.0 m` (`0.001..100 m`),
`convergence_translation=0.0001 m` (`1e-6..0.1 m`), `convergence_rotation=0.00001 rad` (`1e-7..0.1 rad`),
`minimum_overlap=0.20` (`0.01..1.0`), and `huber_delta=0.05 m` (`0.001..10 m`). Point-to-plane rejects targets without exact
normals. Non-finite/out-of-range values reject the whole requested apply; units are explicit. Every report records profile id and
effective values.

Before this drafted spec can become specified, G-RS-CALIBRATION runs a checked-in corpus spanning project scale, density, overlap,
noise, outliers, weak/symmetric geometry, and 1/10/100 links, with deterministic seeds. It publishes accuracy, false-Reviewed,
runtime, RSS, first-progress, and cancellation distributions; any changed default creates a new profile version. X6 delegates these
values, so missing evidence blocks promotion rather than becoming an owner question.

**D1.** Point-pair preview is bounded: ≤10,000 pairs, completion ≤250 ms p95 at the limit on the synthetic gate host. Interactive
navigation/reticle follows VB-D7 p95 frame interval ≤2× target and pointer-to-reticle ≤150 ms p95. ICP is long when estimated >100
ms or source preparation is required. V1 samples are ≤2,048 per cloud because the present validated solver enforces that bound
(`registration.rs:18-19,529-531`). Correspondence construction must check cancellation at least every 4,096 distance tests and every
25 ms, so progress/cancel cannot wait for a completed iteration; first progress is ≤250 ms, cancel is observed ≤250 ms and returns ≤2 s outside an atomic
publication. Extreme obligation: 100 moving stations, 10,000 pairs total, 100 independent 2,048×2,048 ICP links; peak additional RSS ≤1
GiB, scratch ≤2× prepared sample bytes + 256 MiB, first link result ≤5 s, all links complete ≤10 min on the named gate host,
checkpoint at each completed link, restart skips verified links, and final commit is one atomic CAS. G-RS-CALIBRATION,
G-RS-REG-ACCURACY, and G-RS-REG-EXTREME are blocking; these X6 budgets tune only through recorded distributions.

**D2.** Display density and residual-line density may reduce; solver samples, f64 coordinates, transform model, thresholds, pair
inclusion, residuals, revision checks, and point immutability may not. If the sample cap is inadequate, the UI says so and remains
uncommittable; it never labels a sparse result final.

**E1.** V5–V8 and V12 in §10.

**E2.** A source placement/content/P9 change during preview invalidates the session and blocks commit; it never rebases silently.
Only one mutating session may lease a moving entity; read-only View/Measure/report access can coexist. Two disjoint sessions may
solve concurrently and serialize only their journal commits. A depth job may finish against an old placement but its CAS publication
then fails/stales. Device loss reconstructs last preview from CPU state; sidecar loss fails transient session without changing
canon. Extremes include one cloud without station metadata, mixed station/cloud input, already-grouped members, zero overlap,
symmetric geometry, collinear pairs, large coordinates, 100 moving members, hidden reference, source deletion, and project
replacement. All are named in §11 obligations, not assumed typical.

**E3.** G-RS-REG-ACCURACY, G-RS-REG-COMMAND, G-RS-REG-GESTURE, G-RS-REG-EXTREME, G-RS-REPORT, and G-RS-AUTOMATION in §11.

## 6. Function contract — station depth and Station View

**A1.** The user can inspect a real station from its capture origin with image-backed cadence, build/recover an auditable
station-depth artifact, switch stations predictably, obtain exact depth-aware points, and use existing measurement tools without
pretending absent depth is geometry.

**A2.** Perspective §2.1/W2/§4 grounds Station View's origin, 2-DOF image-backed rendering, image modes, station switching, and
exit; §2.6/W5 grounds only observed scan-data measurement, not its hidden implementation; §2.7 grounds per-station visibility.
Exact direct locators derive from X1, S16, MI-D5, and §1.3's versioned source schema. S16 supplies the specific depth-image approach.
The lifecycle itself is dossier-wide absent and therefore derived from P5/P10/MT-D25, as recorded in §3.2.

**A3.** Station/catalog supplies pose and links; Import supplies admitted image/ cloud/structured data; MT-D25 owns recipe state;
Jobs owns execution UX; renderer supplies panorama/depth projection; shared pick resolver and MI-D5 establish exactness; Measure
owns saved results; View owns camera/local history, color, and return; P9/View Box/selection/edit/Plan/File/WeltView/Agent/Python
are explicit consumers. Station View never creates a competing camera or measure store.

**B1.** §1.1 is exhaustive. Station row/marker provide contextual entry, View ribbon provides discovery, Properties provides
Build/recipe actions, Jobs provides resume/cancel, and console/automation cover every non-pointer act. There is no keyboard
shortcut. Previous/Next are visible buttons and commands.

**B2.** Exit thumbnail, ribbon toggle, context switch, `view.station.close`, and Escape at the viewport-mode rung restore the prior
View state. Closing the depth plan does not cancel a confirmed job; Cancel is explicit in Jobs. An unconfirmed plan closes without
state. App restart offers Resume/Discard for a valid checkpoint. Project close checkpoints then releases process resources.

**B3.** Station imagery uses the main viewport; the compact strip fits local switch/mode/status actions; recipe parameters and
provenance belong in RP; long progress belongs in shared Jobs. A dedicated explorer window is rejected because it would duplicate
View history, measurement overlays, and renderer ownership.

**C1.** The visible orientation popover/Properties card, drag/wheel, keyboard stepping, and `view.station.*` commands share the same
yaw/pitch/FOV fields and reducer; §2.3 freezes wrap/clamp/units, Reset, presets, gesture grouping, and reopen behavior. Depth plan
width/height/near/far and source are typed and scriptable. A Station View measurement pick is topological exact-source resolution;
UI pointer acquisition has automation parity through MI's exact world/source anchor payload, not screen-gesture simulation.

**C2.** Open captures exactly one station id/revision. Previous/Next changes it explicitly and records local View history. Global
selection may change without changing the open station. Hidden/Inert transitions close the mode to the prior view with a named
reason; Reference remains inspectable; Editable adds no edit handles in this mode.

**C3.** View state freezes station id/revision, panorama id/revision, depth recipe/output generation, yaw/pitch/FOV, image mode, and
prior return state. Build state freezes recipe inputs, parameters, estimate, progress counters, checkpoint key, and error. Query
payloads reference artifacts and page tiles; they never return the full depth image inline.

**C4.** Camera/station switching is P8 local view history, not document undo. Depth recipe creation/regeneration/detach/relink is
MT-D25 journal state; artifacts and checkpoints are CAS roots. Measurements journal through MI. Station/group placement commit,
undo, and redo apply §1.3 placement equivalence: a proven common rigid delta remaps generation references without changing artifact
hash/current state; differential or unproved change invalidates once. Returning View state never rolls back document state.

**D1.** Station View navigation uses VB-D7's presented-frame interval: p95 ≤2× target, input-to-present ≤150 ms p95, and zero
camera-origin drift over 10,000 drag/wheel events. Switching to an already resident image presents ≤250 ms p95; streaming shows a
lower-resolution resident tier, never blank chrome. Depth build becomes long at >100 ms. Extreme member: 500 million source points
and a 16,384×8,192 depth target, streamed without holding source or target whole in RAM; peak additional RSS ≤1.5 GiB; scratch ≤2×
final artifact + 512 MiB; first progress ≤250 ms; progress at least every 2 s; cancel observed ≤250 ms and process stop ≤2 s;
checkpoint after each source partition and at least every 30 s; restart repeats at most the last partition; completion means every
source partition/cell/mask/locator checksum verified and MT-D25 CAS published last. G-RS-DEPTH-BUDGET and G-RS-STATION-CADENCE are
release obligations.

The 100-station batch extreme additionally requires all-or-none aggregate reservation, one heavy worker by default, bounded queues,
content-addressed source sharing, per-station isolation/checkpoints, first batch progress ≤250 ms, cancel observation ≤250 ms/out ≤2 s,
and resume that hash-verifies/skips completed artifacts. Completion means every eligible item is Current or has one named terminal
error and no reserved unpublished bytes remain. G-RS-DEPTH-BATCH is release-blocking.

**D2.** Navigation may select lower image mip, reduce nonselected marker/overlay density, and defer cloud overlay. It may not reduce
built depth resolution without recording a different plan, interpolate across NoData/discontinuities, drop exact locators, shift
station origin, use other stations' points, or enable measurement on stale/detached/estimated data. Disk/RAM refusal happens at
plan, with required/available values.

**E1.** V1–V4 and V9–V12 in §10.

**E2.** Renderer/image/depth caches, P9 state, clips, View local history, selection, measurement acquisition/overlays, Properties,
Jobs, MT-D25, import replacement, station placement, journal/snapshot/restore, File/archive/export, Plan screenshots/viewports,
WeltView, Agent/Python, and GC all consume the contract. Plan/viewer captures record image and exact depth generation or state
**Station View depth unavailable**; they never launch builds. Least member is image-only; largest is the D1 member; class also
includes cloud-only, panorama+ cloud, structured range, NoData poles/seams, stale/detached/error, removed source, mixed P9, device
loss, restart, and concurrent placement change.

**E3.** G-RS-DEPTH-UNIT, G-RS-DEPTH-BUDGET, G-RS-DEPTH-BATCH, G-RS-STATION-PICK, G-RS-STATION-CADENCE,
G-RS-CONSUMERS, and G-RS-VISUAL in §11.

## 7. Gesture and cursor arbitration

### 7.1 Registration point-pair tool

| Gesture                             | Meaning and UIP §3.6 reconciliation                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LMB click below threshold           | claimed only while a half-pair prompt is armed: accept the exact Shared3DTarget candidate; idle entity selection is suspended                                                          |
| LMB double-click                    | unclaimed; keeps platform reserved behavior, but selection remains suspended while armed                                                                                               |
| LMB drag off reticle                | platform orbit in that pane                                                                                                                                                            |
| LMB drag from Shared3DTarget handle | UIP-D23–D26 axis/plane/ring manipulation; release re-snaps/revalidates in that endpoint's pane or explicitly becomes Typed and loses its locator; it never remains Exact by appearance |
| Ctrl+LMB                            | same exact point acquisition; selection membership cannot mutate session inputs                                                                                                        |
| RMB click                           | platform context surface with **Delete pair** only when over a pair marker; never completes a pair                                                                                     |
| RMB/MMB drag                        | platform pan in that pane                                                                                                                                                              |
| Wheel                               | platform zoom in that pane                                                                                                                                                             |
| Tab / Shift+Tab                     | shared field order: moving X/Y/Z, reference X/Y/Z, weight; never candidate cycling                                                                                                     |
| Up / Down                           | UIP candidate cycle only while the visible reticle candidate indicator is live                                                                                                         |
| Enter                               | commits current valid typed half/pair or activates focused button; never commits registration                                                                                          |
| Backspace                           | with no text focus, removes only the current pending half-pair; never global Undo                                                                                                      |
| Escape                              | one rung per §5 B2/UIP-D14                                                                                                                                                             |
| pointercancel / focus transfer      | reverts active reticle drag; validated typed fields remain, unvalidated field text reverts                                                                                             |

Cursor states use UIP-D24 vocabulary: crosshair while awaiting a point, 3D target axis/plane/ring over handles, prohibited over
estimated/hidden/ineligible geometry, wait while the pane cannot accept input, ordinary orbit/pan/zoom while navigating. The
import-only `n/a` registration row in UIP §9.7 must be revised to add this post-import consumer; no new cursor family is created
(RS-D8).

### 7.2 Station View mode

Station View is a View mode, not an armed construction tool. LMB drag is an explicit mode-specific form of platform 3D orbit
constrained to yaw/pitch at the station origin; LMB click keeps platform selection when no measurement is armed, but only
station-owned exact depth candidates exist. RMB click opens the normal context surface. Wheel zooms. RMB/MMB drags are prohibited
with a station-origin cue because pan would falsify capture position. Touch tap picks; one-finger drag rotates; pinch zooms. When a
Measure tool is armed, MI-D5/MI's gesture map owns clicks and this mode supplies only candidates. Escape first resolves measurement
rungs, then exits Station View. No Previous/Next keyboard key is claimed, so Up/Down and Tab retain focused-control semantics.

## 8. Shared state, consumers, failures, and recovery

| Consumer / event        | Required behavior                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render and draw order   | station images/clouds use normal View passes; markers/links render after geometry and before selection/tool handles; report residual overlays render only in explicit QA mode                                                                                                  |
| Pick/snap               | ordinary 3D uses current P4 candidates; Station View admits only current linked depth with exact locator+core revalidation; report graphics never enter candidates                                                                                                             |
| Clips/viewing box       | clips govern ordinary 3D station clouds/markers per owner contract; Station View disables clip evaluation and leaves canonical/view-local clip state unchanged                                                                                                                 |
| Selection/edit          | Station is semantic selection; child expansion is not selection. Select/Edit transforms eligible Station/cloud placement through its own act; reports become Historical, while derived consumers apply exact §1.3/§8 placement equivalence rather than unconditional staleness |
| P9 visibility           | effective state governs marker/cloud/image/link render, picking, command admission, and Station View entry; parent propagation/mixed are identical in UI/automation                                                                                                            |
| Import/source update    | exact source mapping creates/updates station children atomically; ambiguous scan association lands unassigned and is never repaired by guess; replacement invalidates recipes/reports after commit                                                                             |
| Registration commit     | one generation publishes placements, group, report, relations, invalidations; renderer/tree refresh only after acknowledgment                                                                                                                                                  |
| Locked viewing-box bake | adopt SE-D3: because the world-space box is not co-transformed, keep the last valid clip visible as **Rebuilding locked box**, suspend the old bake as current, and atomically rebuild; failure/undo restores its exact prior bake binding                                     |
| Raster drape            | adopt SE-D3 plus placement equivalence: if image and support receive the identical rigid delta, advance placement refs and retain the bake; otherwise suppress misleading stale drape until one settled rebuild publishes                                                      |
| Measurements            | associative local anchors follow their moved sources and recompute in the published generation; fixed-world anchors remain fixed; failed resolution survives as named Unresolved; cancellation/failure changes none                                                            |
| Plan captures           | linked views observing moved revisions become Stale and retain last-good capture; pinned snapshots remain fixed to recorded revisions/artifacts; registration never overwrites either during preview                                                                           |
| Derived recipes         | every MT-D25 recipe consumes one typed SE-D20 invalidation/equivalence set: common rigid co-transform retains artifact hash/Current and advances placement refs; relative geometry/content/profile changes become Stale and misleading output is suppressed per owner profile  |
| Sections/pick indexes   | source-local indexes remain reusable under a common rigid placement indirection; world-space indexes and linked sections rebuild/recompute once after acknowledgment; preview or failed commit never publishes an index generation                                             |
| Depth job               | immutable read snapshot; checkpoint/restart; CAS rejects late publication; last-good remains labeled stale/error; no partial output is reachable                                                                                                                               |
| Measurement             | MI owns entities/values/panel/report; Station View contributes exact anchor and origin station. Source change revalidation follows MI-D5/MI-D14 and never triggers depth rebuild                                                                                               |
| File/project/archive    | lossless Station/Group/Report/recipe/resources and unknown-version preservation; strict reader preserves unsupported read-only or fails closed, never drops                                                                                                                    |
| Export                  | ordinary cloud exports preserve placement; station structure/panoramas only when writer declares it and File plan discloses losses. Registration CSV/HTML is captured report data, not restore authority                                                                       |
| Snapshot/restore        | complete owner/relation/placement/report/recipe generation becomes visible atomically; consumers revalidate afterward; active transient registration session is not snapshotted                                                                                                |
| Plan/screenshot/viewer  | records exact visible generation and Station View availability; passive, never builds/regenerates; hidden/no-data/stale semantics remain visible                                                                                                                               |
| Automation/Agent/Python | generated public typed commands/queries only; paged lists/reports; exact pairs/parameters; identical conflicts, progress, cancel, report, undo behavior                                                                                                                        |
| Sibling apps            | WeltView reads/preserves/lists/inspects stations/groups/reports and may display current Station View read-only; PhotoLab arrivals use IF-D19–D25 and gain no alternate mutation path                                                                                           |
| Failure                 | solver/job/render failure changes no canonical placement; renderer rebuilds committed state; source/project replacement cancels leases; error names phase/input/recovery action                                                                                                |

Registration adopts the complete SE-D3 placement-consumer matrix and SE-D20 one-publication rule rather than defining a partial
invalidation path. The transaction root contains every moving placement/revision; Station/panorama/group/report projections; one
typed invalidation/equivalence set; locked-box bake state; drape suppression/rebuild state; associative/fixed measurement results;
linked/pinned Plan state; section/pick-index state; and every MT-D25 recipe/output/last-good transition. Preview is non-canonical.
Publication failure restores the exact pre-commit affected set and emits no durable invalidation. Undo and redo restore/reapply the
same logical before/after set, artifact hashes, relation bindings, and captured generation-token mapping in one journal root;
monotonic recipe generations advance as MT-D25 requires instead of reusing an old counter. Fixed-world anchors, pinned captures,
camera/selection/display histories, immutable source bytes, and unrelated entities are exempt because their owners define them as
outside placement ancestry. G-RS-PLACEMENT-CONSUMERS snapshots before/commit/undo/redo for every row.

Concurrency is optimistic and scope-based. Disjoint registration and depth jobs run concurrently. Mutating sessions on the same
moving entity are rejected; report reads and Station View reads coexist. Journal publication serializes. Inputs are immutable
snapshots, and every late producer performs project/id/ revision/hash/generation CAS. Cancellation never masquerades as success.

## 9. Cross-spec cite-and-revise requests

| Owner document/spec                            | Required revision before `specified`/implementation                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRY.md`                                  | deterministic incremental update replaces deferred `view.station`; adds the four other rows and every exact §1.1 public command, this spec as Drafted/registry-pending, RS decisions/obligations, and station schema pending-admission row; run uniqueness, reachability, state-owner, dangling-evidence, and reciprocal-citation lint |
| View `view-domain.md`                          | VD-D11 is discharged by RS-D5; `view.station.*` uses this data contract; VD-D12 adopts per-station/registration-group color now but keeps walkthrough/fly-to deferred                                                                                                                                                                  |
| UI Platform `ui-platform.md`                   | add Registration & Stations to the Shared3DTarget owner/consumer and post-import cursor/gesture matrices; accept §7 exact-downgrade arbitration under UIP-D23–D26                                                                                                                                                                      |
| Import `import-formats.md`                     | retain private import lifecycle; E57 multi-scan admission must produce addressable Stations/children or declare unassigned loss; IF-D19 arrival matrix accepts the station schema when product metadata proves it                                                                                                                      |
| Agent `agent.md`                               | AG-D22/P11 generated rows add every exact §1.1 public `station.*`, `registration.group.*`, `pointcloud.registration.*`, and `view.station.*` command/query; AG-D4/AG-D13 keep raw `registration.*` private                                                                                                                             |
| Measure `measure-inspect.md`                   | MI-D5/MI-D14 exact-provider/placement-consumer matrices accept indexed current station-depth locator targets, refuse stale/detached/estimated cells, and apply associative-vs-fixed semantics; Area remains unavailable in Station View                                                                                                |
| Mesh `mesh-terrain.md` MT-D25                  | add the P10 placement-equivalence specialization: identical rigid co-transform advances placement refs/generations and preserves artifact hash/Current; differential/failed proof stales; admit `station_depth_image` typed profile without duplicating lifecycle commands                                                             |
| File `file-project.md` FP-D22                  | round-trip/restore/GC Station/Group/aggregate Report, session-independent report history, depth recipe/equivalence proof, last-good/checkpoints, and complete placement-consumer affected-state roots                                                                                                                                  |
| Select/Edit `select-edit.md` SE-D3/SE-D20      | register registration as a producer of the same complete placement-consumer matrix and one typed invalidation/equivalence publication; do not create a second matrix                                                                                                                                                                   |
| Perspective dossier                            | correct W5 to the observed scan-data measurement claim and mark structured-range resolution as inference/unsupported mechanism; retain the source limit                                                                                                                                                                                |
| `DATA-MODEL.md`, ADR 0016, `PROJECT-FORMAT.md` | architect admits Station, RegistrationGroup, RegistrationReport, station relations, and station-depth parameter/locator artifacts with strict-reader/migration/persistence rules                                                                                                                                                       |
| `TRANSFORMATIONS.md`                           | replace the stale claim that ICP is merely planned with the bounded implemented import solver evidence, while keeping post-import product status accurately unimplemented                                                                                                                                                              |

These are requests, not edits made by this spec author. ADR 0025 needs no change because §1.2/§2.4 now keep observations and
locators transient and persist aggregate audit only. Until reciprocal changes land, references above are an explicit cite-and-revise
queue rather than dangling claims; the deterministic linter plus incremental registry update applies them, not an LLM registry
rebuild.

## 10. E1 visual and behavioral criteria — failable in-repo artifact

Implementation review captures both themes at 100% and 150% UI scale against in-repo fixtures. Each numbered item is pass/fail; no
third-party screenshot is an oracle.

1. **V1 taxonomy:** LP visibly reads Imported from → source → Stations → station → Point cloud/Panoramas and Registration groups.
   Cloud-only/unassigned, missing panorama, depth not built, stale, running, error, and current states use words plus shared icons;
   long names truncate with full tooltip and no row jump.
2. **V2 marker/state:** station marker remains legible at near/far fixture distances without changing world truth. Hidden, Inert,
   Reference, Editable, and Mixed use UIP-D20 cues; color alone never carries state. Hidden removes marker/link/cloud candidates
   within one presented frame.
3. **V3 Properties:** source id/pose, cloud, panorama, group, placement, and depth recipe show aligned label/value rows. Unknown
   uses an em dash. Build is disabled with a precise reason when no truthful source exists.
4. **V4 Station entry:** row, marker context, ribbon, and command open the same station/orientation; Hidden/Inert entries visibly
   refuse rather than opening an empty view.
5. **V5 registration workspace:** Reference, Moving, and Combined panes remain unmistakable at minimum supported size; one shared
   steps panel shows input, coarse, refine, review. No pane is an unstyled browser canvas.
6. **V6 targets:** exactly one dominant Shared3DTarget appears in the active pane. Moving/reference half-pairs have distinct labels;
   exact, estimated, prohibited, pending, disabled, and outlier states remain distinguishable in both themes without a color wash.
7. **V7 diagnostics:** every moving link shows its state, RMS 3D, min/max, matched, overlap, convergence, warnings, and transform.
   Missing is em dash. A rejected result cannot look Reviewed; selecting a live-session outlier makes both endpoints findable,
   while reopened historical reports expose no endpoint action.
8. **V8 commit/close:** canonical geometry never moves before Commit; Before/ After/flicker state is explicit. Close/cancel copy
   names what is discarded. After acknowledgment, tree group/report, all moving placements, and every §8 consumer appear in one
   coherent generation; failure restores before-state, and Undo/Redo restore/reapply the batch as one visible change.
9. **V9 Station View:** image/depth shader fills viewport without sphere seams or free-origin drift; compact strip names
   station/image/depth and visibly supplies Previous, Next, orientation, and exit thumbnail. Numeric yaw/pitch/FOV, Reset/presets,
   drag/wheel, and keyboard remain synchronized. Pan gestures show prohibited origin cue, not motion.
10. **V10 depth:** image-only, depth-only, NoData, discontinuity, stale, detached, error, building, paused, and current depth are
    visually distinct with words. RGB never masks invalid geometry. Exact picks say **Exact source point**; invalid cells use the
    prohibited cursor, say **No exact point**, and expose no Save/measurement commit.
11. **V11 jobs/recovery:** shared registration/depth/batch rows show named phases and real counts, Cancel/Reopen where applicable,
    and after restart Resume/Discard. Closing Station View or backgrounding ICP leaves the job discoverable. Per-station/link failure
    names source and recovery; no partial view appears.
12. **V12 reports/limits:** current versus Historical report rows are explicit; QA links/outliers appear only in 3D. Station View
    visibly says viewing box, edit gizmo, Area, and QA overlay are unavailable and how to return.

## 11. Verification obligations (`docs/TEST-TIERS.md`)

Status: **Pending manifest; the `G-RS-*` identifiers below are obligations, not executable gates.** Before this spec may become
`specified`, `scripts/verification/registration-stations/manifest.json` must map every id to an exact repository runner/test target,
fixture paths plus SHA-256 hashes and licenses, deterministic seed, timeout, machine-readable assertions, screenshot/audit capture
path where applicable, responsible domain owner, and CI/planner task. Separate core, generated command/automation,
renderer/browser, persistence/restart, and performance targets are required; one opaque end-to-end command is insufficient. An
unavailable fixture or harness remains Pending and blocks promotion. Each eventual review report records command, revision,
environment, exit/result, and output artifact.

- **G-RS-SCHEMA — changed, release:** Rust schema/validation/migration fixtures for Station/Group/aggregate-only Report/relations and
  station-depth payload/direct locator; finite canonical poses, one source cloud, ownership acyclicity, stable ids, structural
  absence of persisted manual observations/ICP samples, strict unknown-version preservation,
  `.hcad/.hcadx` round-trip, WeltView read-only parse/list/inspect, and generated TypeScript/Python `--check`.
- **G-RS-CATALOG — changed:** E57 single/multi-scan and PhotoLab package fixtures produce exact taxonomy only from proven metadata;
  duplicate/missing GUIDs land unassigned with loss; single/batch rename collision preview, exclusive group create/get/list/rename/
  remove/dissolve, already-grouped/fixed-member refusal, P9 bulk-eye/Mixed, undo/redo/reload, and paged 100,000-station
  virtualization behave exactly as §4.
- **G-RS-REG-ACCURACY — push/release:** deterministic synthetic rigid pair with large coordinates, noise, one outlier, typed and
  picked equivalent pairs; robust coarse fit then point-to-point and point-to-plane ICP. Independent CPU oracle checks
  transform/residuals, scale exactly 1, convergence, overlap, matched count, pair residual ordering, repeatability, and
  points/resource hashes byte-identical before/after.
- **G-RS-REG-COMMAND — changed:** every §1.1 command; one link per moving id; active-link pane/residual ownership; independent
  Unaligned/Coarse/Fine/Reviewed/Committed transitions; add/remove/retry/discard/settings; pairs/coarse suggestion/manual numeric
  delta/ICP/background/cancel/commit; one/many moving members; group/aggregate-report creation,
  expected-revision conflict, hidden/ inert/reference admission, source deletion, commit crash/replay, atomic undo/ redo, and
  import-private raw route rejection. No failed/cancelled run changes placement or exposes a report.
- **G-RS-REG-GESTURE — push, `browser-gpu`:** drive every §7.1 row in all three panes; selection never mutates inputs; navigation
  remains platform-owned; target drag↔typed parity, same-pane re-snap, drag-off-source downgrade, stale/unresolved Exact and
  Estimated refusal, candidate cycling, context, focus transfer,
  pointercancel, Backspace, and each Escape rung pass.
- **G-RS-REG-EXTREME — release, `real-data`:** self-launching 100-moving-member §5 D1 job records
  active-link switching and independent pairs/results, RSS/scratch/first-progress/first-result/completion/cancel/checkpoints/restart,
  deterministic per-link results and one final CAS. Inject one stale/failing member, repair or remove it, then prove one atomic
  commit/Undo. Forced conflict/sidecar/device failure publishes nothing partial and retains a usable review or named recovery.
- **G-RS-CALIBRATION — release, `real-data`:** versioned corpus/seed and 1/10/100-link distributions in §5 freeze profile defaults,
  accuracy, false-Reviewed rate, time, RSS, feedback, and cancellation; no parameter ships from an undocumented guess.
- **G-RS-DEPTH-UNIT — changed:** spherical seam/poles, near/far, deterministic collision tie-break, masks/confidence, structured
  range and cloud projection, exact locator resolution, discontinuity refusal, content hash, stale causes, no-source refusal, and no
  RGB-derived depth invention.
- **G-RS-DEPTH-BUDGET — release, `real-data`:** self-launching 500M-point, 16,384×8,192 fixture enforces every §6 D1
  RSS/disk/progress/cancel/checkpoint/ restart/completion bound. Kill at each phase; resume repeats at most one partition; mutate
  placement/source before publish; CAS rejects late output; no partial recipe/output is reachable.
- **G-RS-DEPTH-BATCH — release, `real-data`:** 100 stations cover aggregate reservation refusal-before-start, deterministic
  one-worker scheduling, duplicate-source sharing, bounded RSS/disk/queues, one corrupt member, cancel-current/cancel-remaining,
  process loss, hash-verified resume/skip, and per-station terminal state without partial publication.
- **G-RS-STATION-PICK — push/release, `browser-gpu`:** current direct locator pick equals the exact imported source record, f64 XYZ,
  and scanner range without full scan or nearest substitution; cold cache, evicted chunk, stale hash/generation, deleted source, and
  cancellation obey §1.3 budgets. Seam/NoData/stale/detached/estimate/hidden cells cannot commit; Point/Distance/Horizontal/Height route to MI and persist origin
  station; Area remains unavailable.
- **G-RS-STATION-CADENCE — push risk-triggered, release always, `browser-gpu`:** self-launching 10,000 drag/wheel events and 1,000
  resident station switches enforce VB-D7 presented-frame p95 ≤2× target, input-to-present ≤150 ms p95, resident switch ≤250 ms p95,
  zero origin drift, no stale frame/candidate, and graceful mip/overlay degradation.
- **G-RS-REPORT — push/release:** golden CSV/HTML for single/multi-link aggregate reports, maximum profiled report size, large coordinates, warnings,
  historical revisions, commas/quotes/newlines; parse round-trip, captured-revision stability under edits, File plan loss
  disclosure, bounded RSS/scratch, row/byte progress, stream/cancel/process loss, incomplete-temp cleanup, sibling-temp atomic
  replacement, structural absence of pair endpoints, and no report-as-restore behavior.
- **G-RS-PLACEMENT-CONSUMERS — changed:** one fixture contains locked viewing-box bake, equivalent/differential drapes,
  associative/fixed measurements, linked/pinned Plan captures, station depth, other MT-D25 recipes, and section/pick indexes; assert
  complete before/commit/failure/undo/redo snapshots, one typed publication, common-rigid hash preservation, and stale suppression.
- **G-RS-CONSUMERS — changed:** execute every §8 row across smallest/largest members, P9 states, placement/source invalidation,
  snapshot atomic restore, Plan/screenshot/viewer passive behavior, File/archive losslessness, strict reader, WeltView,
  device/renderer/sidecar loss, GC roots, and concurrent jobs.
- **G-RS-AUTOMATION — push via `automation.sdk`, release always:** generated sync/async Python and Agent invoke every public §1.1
  exact command/query, page large lists/reports, use exact typed pairs/link ids, observe/background/reopen/cancel/resume jobs,
  commit/undo, and compare UI/query state. Raw `registration.*` is unavailable and schemas reject missing revisions,
  screen-gesture payloads, scale, and ambiguous ids; positive enumeration matches only the generated registry table.
- **G-RS-STATION-ORIENTATION — push, `browser-gpu`:** drag, wheel, keyboard step, visible fields, Reset/presets, and generated
  commands reach/serialize identical wrapped/clamped values and restore them after close/reopen.
- **G-RS-ICP-BACKGROUND — push:** background a 100-link refinement, continue unrelated editing, preserve job/session/active-link
  identity across renderer reload and Reopen, produce Needs attention on stale completion, cancel within budget, and exercise the
  documented process-restart checkpoint policy.
- **G-RS-VISUAL — push visual-risk/release:** scripted captures for V1–V12 in both themes/scales; image diff plus reviewer checklist
  is blocking.

Tier mapping follows TEST-TIERS: unit/schema/component obligations target `changed`; browser/SDK target `push`; extreme real-data,
visual, round-trip, and recovery target `release`, with cadence and registration accuracy always release-blocking. No manifest,
runner, fixture ledger, or capture currently exists for these new obligations, so none is executable or claimed passed.

Every browser/real-data obligation must provision its fixture, launch Builder, drive input, sample state, and tear down without a
hand-started app. Once planner rows land, an agent runs them through `pnpm verify:changed`, `pnpm verify:push`, or
`pnpm verify:release -- --capabilities=browser-gpu,real-data`; a missing capability fails, never skips.

## 12. Current implementation delta and implementation order

What exists and should be reused:

1. Versioned registration recipes, robust point-pair fitting, similarity/rigid transforms, residual reports, and deterministic
   bounded ICP with progress/cancel (`crates/himmelcad-core/src/registration.rs:16-84,141-251,302-416,510-635`), including synthetic
   tests (`:1093-1177`).
2. Import-only staged session/resource/sample/preview/commit/cancel machinery
   (`crates/himmelcad-sidecar/src/import_registration_runtime.rs:33-119,133-220,404-589`) and Builder import island/wizard
   (`apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:38-412`;
   `packages/@himmelcad/ui/src/ImportRegistrationWizard.tsx:746-829,1001-1015`).
3. E57 image pose and Panorama/RasterImage emission (`crates/himmelcad-io/src/e57_import.rs:1290-1335,1651-1674`), existing
   `hcad.panorama@1`/`PanoramaGeometry` (`crates/himmelcad-core/src/entity_model.rs:44,750-759`), and viewer panorama/depth
   analysis/picking (`packages/@himmelcad/viewer/src/kernel/WgpuKernelViewer.ts:2259-2357`; browser fixture
   `packages/@himmelcad/viewer/test/browser/main.ts:3815-3868,6145-6168`).

What does not exist as the named product functions:

1. No first-class Station/RegistrationGroup/RegistrationReport schema or strict consumer/persistence admission. Multi-scan E57
   deliberately loses addressable station association (`e57_import.rs:1281-1286`).
2. No post-import project registration session, entity lease, generated public command, atomic placement/group/report transaction,
   or report exporter. All current `registration.*` routes are bound to import sessions (`main.rs:1323-1324,1897-2106`); AG-D4
   and IF-D12, rather than handler existence, establish that these raw methods are app-private.
3. No depth builder, source locator, MT-D25 profile, checkpoint/restart, plan, or job. Imported panoramas explicitly have no depth
   (`e57_import.rs:1628-1632`).
4. No Builder Station View entry/mode/strip/switching/P9 consumer, despite the viewer kernel substrate. A kernel method is not a
   discoverable product act.
5. No UIP registration Shared3DTarget/cursor row, MI exact locator provider, File report writer, WeltView station reader, or
   executable §11 verification manifest.

Implementation order after architect admissions: (1) schemas/generated contracts/strict readers and E57 addressable station
admission; (2) catalog/P9/ tree consumers; (3) shared post-import session over the existing pure solver and atomic command/report;
(4) UIP reticle and registration workspace; (5) MT-D25 depth builder/checkpoints and exact locator resolver; (6) Station View/MI
handoff; (7) File writers, sibling/Plan consumers; (8) the §11 manifest/runners and E1 captures. No slice may call itself complete
before its passive consumers and extreme obligations execute successfully.

## 13. Decision records

**RS-D1 — Stations are first-class canonical capture entities.** **Decision:** use the §1.2 Station/child/group identities; never
infer a station from a cloud name or cluster. **Derivation:** X1/X2; S16; RealWorks §2.1; Perspective §2.1/§2.7; VD-D11's missing
prerequisite. **Rejected:** cloud tags only; filename identity; one merged E57 cloud pretending to be every scan. **Tunable:**
display grouping and page size; identity/pose/source linkage are not.

**RS-D2 — Imported-from taxonomy is source → Stations → children.** **Decision:** §1.2 is the one LP taxonomy, with Registration
groups as a separate projection; RealWorks-style batch rename ships with preview, deterministic collision choice, one transaction,
and UI/command parity. **Derivation:** P1/P9; X3/X4/X5; RealWorks §2.1 Project tree; Perspective Stations List; DESIGN-SYSTEM
hierarchy. **Rejected:** flat station list; group ownership that moves source provenance; automation-only rename loops. **Tunable:**
default expansion, sort, and suffix formatting, never stable ids, provenance, preview, or atomicity.

**RS-D3 — Post-import registration has a separate public command boundary.** **Decision:** use generated
`pointcloud.registration.*`; share solver primitives but never expose or consume raw Import `registration.*` sessions.
**Derivation:** X3/P11; ADR 0021/0025; IF-D12; AG-D4/AG-D13. **Rejected:** promoting raw RPC; making UI call core directly;
extending a staged import after commit. **Tunable:** session page limits; boundary/ownership are not.

**RS-D4 — Registration is rigid and placement-only.** **Decision:** scale is exactly 1; commit changes entity placement only and
never rewrites points. **Derivation:** X1/X2; ADR 0025; source authority; current rigid fit/ICP. **Rejected:** implicit similarity
scale; baked coordinate rewrite; transform override after solving. **Tunable:** robust/ICP numeric parameters under X6, with
defaults recorded in reports.

**RS-D5 — VD-D11 is discharged by station-origin Station View.** **Decision:** adopt the §2.3 mode at the real station origin,
2-DOF, optional non-authoritative image underlay or honest depth shader, explicit switch/exit, and honest limitations; free walk/fly
remains VD-D12 backlog. **Derivation:** S16; Perspective §2.1/W2/§5; X4;
existing PanoramaGeometry. **Rejected:** speculative free camera; dedicated duplicate explorer; leaving the row deferred.
**Tunable:** strip layout, pitch clamp, transition duration; fixed origin is not.

**RS-D6 — Station depth is a deterministic P10/MT-D25 artifact with direct locators.** **Decision:** §1.3 fixes source precedence,
projection/pixel/seam/pole/range/collision/mask/confidence rules and versioned row-column or chunk-ordinal direct locators;
auto-regeneration budget is zero. Proven common rigid co-transform retains artifact hash/Current while differential change stales.
**Derivation:** S16; X1/X2; P5/P10 placement equivalence; MT-D25; MI-D5; current `depth:null`. **Rejected:** RGB-inferred depth;
nearest-neighbour locator recovery; mutable cache without recipe; unconditional placement staleness; another lifecycle. **Tunable:**
versioned numeric profile constants, resolution/near/far, and tile shape through §11 evidence; direct exactness and equivalence proof
are not.

**RS-D7 — Exactness gates Station View measurement.** **Decision:** only a current locator revalidated to immutable source f64 can
enter MI; estimates, NoData, stale, detached, and image-only cells cannot commit. **Derivation:** X1; P4; S16; MI-D5/MI-D14; the
Perspective §2.6/W5 observation that scan data can be measured, without relying on its unsupported hidden-mechanism claim.
**Rejected:** treating reconstructed GPU depth as exact; station-local measurement entities; silently snapping to another station.
**Tunable:** hover wording/marker size and storage-fetch threshold, not admission/direct addressing.

**RS-D8 — Registration reuses Shared3DTarget and fully arbitrates gestures.** **Decision:** §7.1 is the exhaustive mapping and
UIP-D23–D26 extension request, including same-pane exact re-snap or explicit Typed downgrade on handle release. **Derivation:**
X1/X5/X7; FUNCTION-CONTRACT C1/E2; UIP §3.6/§9.5/§9.7. **Rejected:** registration-only reticle; stealing navigation drags;
candidate cycling on Tab; exactness preserved merely by visual proximity; uncited cursor claims. **Tunable:** reticle size/smoothing
within UIP owner rules.

**RS-D9 — Registration commit is reviewed, atomic, and report-producing.** **Decision:** only when every retained link is Reviewed
against the same reference generation may placement/group/aggregate report/full consumer set publish in one optimistic transaction
and one batch-level undo root. Per-link removal afterward is a separate journaled command. **Derivation:** X1–X3; ADR 0025's reviewed
pre-commit precedent; P5/P8; RealWorks §2.2/W1/W2. **Rejected:** live placement writes during preview; partial multi-member commit;
one Ctrl+Z child per link; report generated later from live state. **Tunable:** review layout and warning thresholds; atomic
membership/undo scope are not.

**RS-D10 — Registration quality is an aggregate persistent inspection report.** **Decision:** persist input revisions, per-link
aggregate statistics, solver/profile/effective parameters, transform, and warnings; manual endpoints/locators/weights and ICP
correspondences remain transient. Later edits label the report Historical; export streams CSV/HTML through File. **Derivation:**
ADR 0025; RealWorks §2.2/§2.9; MI-D2/MI-D14; X1/P5. **Rejected:** persisting/replaying observations without superseding ADR 0025;
transient toast only; live recomputation; RTF without an in-repo codec; report as geometry. **Tunable:** table columns/order, HTML
layout, and export resource budgets; audit boundary and schema version are not.

**RS-D11 — Long depth, report, and extreme registration work is bounded and recoverable.** **Decision:** §§2.3/2.4/5–6 budgets,
partition keys, inner-correspondence cancellation checks, real progress, restart policy, CAS, reservation, and completion definitions
are blocking obligations. **Derivation:** X2/X6; P3/P5; Function Contract D1; S16. **Rejected:** restart from zero for resumable
multi-minute compute; iteration-only cancellation; progress by spinner; whole-cloud RAM; partial publish. **Tunable:** numeric
thresholds after §11 evidence, never truth/cancel/CAS/reservation semantics.

**RS-D12 — Per-station visibility is shared P9 state; a group eye is a bulk act.** **Decision:** consume Hidden/Reference/Editable/
Inert everywhere; source ancestry propagates, while registration-group Mixed summarizes exact members and its eye dispatches a
canonical per-entity batch rather than adding inheritance. **Derivation:** P4/P9/X7; Perspective §2.7; UIP-D20/SE-D19.
**Rejected:** Station View-private eye; registration membership as an unregistered visibility parent; hidden points admitted by
Magnify; flattening mixed children. **Tunable:** icons/order, not semantics.

**RS-D13 — Network/target registration is explicit backlog, not starter overclaim.** **Decision:** v1 solves fixed↔moving rigid
cloud links; target extraction/analyzer, plane auto-registration, mixed adjustment, and bundle adjustment remain deferred with §3
reasons. **Derivation:** S16 names cloud-to-cloud; X1; RealWorks §2.2; absent canonical target/network solvers. **Rejected:** stub
buttons; calling independent links bundle adjustment; silent catalog pruning. **Tunable:** future slice order after schema and
verification admission.

**RS-D14 — Registration groups have exclusive, explicit lifecycle semantics.** **Decision:** §1.2 fixes exclusive membership,
same-reference destination, fixed-member immutability, reject-instead-of-reparent, get/list/create/rename/remove/dissolve, historical
snapshots, delete condition, conflicts, and undo. **Derivation:** X1/X3/X5; P1/P9; Function Contract B1/C2; RealWorks §2.1 group
catalog. **Rejected:** implicit merge/split/reparent; removable fixed member; delete with retained moving members; a visibility-parent
shortcut. **Tunable:** default names and page size only.

**RS-D15 — One-to-many registration is a list of independently reviewable transient links.** **Decision:** §1.2/§2.2 define stable
link ids, one active Moving pane, independent state/pairs/settings/results/errors, complete commands, and every-retained-link Reviewed
precommit. **Derivation:** X1/X3/X5; Function Contract C2/E2; S16; RealWorks Apply Group. **Rejected:** one anonymous moving pane;
shared pairs/results; silent failed-member omission; partial publication. **Tunable:** list sorting and selected-link page size, not
state transitions or command identity.

**RS-D16 — Manual observation exactness is a discriminated, transient boundary.** **Decision:** Exact carries direct locator and
generations; Typed carries entered world coordinate and no locator; Estimated cannot reach Reviewed. Drag release re-snaps in the
endpoint's pane or becomes Typed. Reports persist only aggregates under RS-D10. **Derivation:** X1; ADR 0025; MI-D5; UIP-D23–D26.
**Rejected:** free drag retaining an Exact badge; nearest substitution; persisting endpoint evidence contrary to the accepted ADR.
**Tunable:** snap radius through the UIP owner only.

**RS-D17 — Registration consumes the complete placement affected-state set.** **Decision:** §8 adopts SE-D3/SE-D20 for locked-box
bakes, drapes, associative/fixed measurements, linked/pinned Plan captures, sections/indexes, and all MT-D25 recipes; commit,
failure, undo, and redo publish/restore the whole set. **Derivation:** X1/X5/X7; P5/P8/P10 placement equivalence;
SYSTEM-001; SE-D3/SE-D20; MT-D25. **Rejected:** placement/report-only undo; durable invalidation on failed commit; showing stale
geometry as current. **Tunable:** rebuild debounce/resource budgets only.

**RS-D18 — Common rigid placement is an exact remap, not staleness.** **Decision:** when all artifact sources/output receive the
same rigid delta and relative geometry/content/profile/locator mapping is unchanged, retain immutable hash/Current and advance
placement references transactionally; differential or unproved change stales. Record the proof. **Derivation:** P10's
placement-equivalence corollary; X1/X2; MT-D25. **Rejected:** unconditional placement invalidation; assumed equivalence without a
proof; relaxed geometry tolerances. **Tunable:** no.

**RS-D19 — Depth authority and presentation are deterministic and honest.** **Decision:** §1.3 prefers exact associated structured
range, otherwise the associated cloud, never RGB; it freezes projection/raster/mask/locator rules. RGB is optional
non-authoritative underlay, depth-only uses a shader, and invalid geometry remains visibly masked and non-pickable. **Derivation:**
X1/X2; S16; MI-D5; E57 no-invention evidence; design-system invalid-data rules. **Rejected:** photogrammetric depth inference;
RGB-validity coupling; hidden NoData; configurable collision semantics inside one algorithm id. **Tunable:** versioned profile
constants through calibration, not authority/source precedence.

**RS-D20 — Hundreds of depth builds use one reserving, resumable batch plan.** **Decision:** §2.3/§6 require complete discovery,
aggregate reservation, deterministic bounded scheduling, shared source reads, per-item isolation/checkpoints, two cancel scopes, and
hash-verified resume. **Derivation:** X1/X2/X6; P3/P5/P10; Function Contract D1; S16's class size. **Rejected:** per-item estimates
without aggregate admission; unbounded parallelism; restart-all; one corrupt item failing completed siblings. **Tunable:** worker
cap and margins only through G-RS-DEPTH-BATCH evidence.

**RS-D21 — Registration defaults are a versioned calibrated profile.** **Decision:** §5 freezes current code defaults, units,
ranges, validation, report capture, corpus, and promotion rule; calibration changes create a new profile version. **Derivation:**
X1/X6; P3; current `registration.rs:141-227`; Function Contract D1. **Rejected:** unlabeled free parameters; arbitrary owner choice;
silent default changes; sparse success-only corpus. **Tunable:** all named numeric defaults/ranges/budgets through recorded
distributions; schema and validation are not.

**RS-D22 — Long ICP may continue in background without gaining apply authority.** **Decision:** §2.2 keeps main-owned identity,
Jobs/Reopen state, immutable launch inputs, stale-input Needs attention, and explicit restart/cancel behavior; completion never
auto-applies. **Derivation:** X1/X2/X5; P5; Function Contract B2/D1; UIP-D10. **Rejected:** captive foreground workspace; renderer-
owned job; background completion committing silently. **Tunable:** checkpoint cadence and Jobs summary density.

**RS-D23 — Station orientation has visible numeric parity.** **Decision:** §2.3 exposes yaw/pitch/vertical FOV, Reset, presets,
units, wrap/clamp, one Camera-history gesture, and one reducer for direct/keyboard/UI/automation paths. **Derivation:** X3/X5/X7;
P8; Function Contract C1; Viewing Box numeric-parity precedent. **Rejected:** automation-only values; independent field/drag state;
document-journal camera edits. **Tunable:** keyboard step and display precision only.

## 14. Owner-decision items and escalation dissolution

Owner-decision items: **zero**. Every tempting question was run through the doctrine's zero-owner-question escalation protocol:

- _“Is a station just a cloud?”_ dissolves under X1 plus both dossier station catalogs and VD-D11's explicit prerequisite: RS-D1
  admits a distinct identity.
- _“May panorama RGB supply depth?”_ dissolves under X1 and current E57 no-invention evidence: only structured range or a station
  cloud can (RS-D6).
- _“Can derived depth be good enough for measurement?”_ dissolves under X1, P4, and MI-D5 exactness: locator revalidation is
  mandatory (RS-D7).
- _“Should registration allow scale or rewrite points?”_ dissolves under source authority, ADR 0025, X1/X2, and the S16
  cloud-registration purpose (RS-D4).
- _“Does closing preserve unreviewed point pairs?”_ dissolves under ADR 0025's fresh-observation rule and P5: verified job
  checkpoints may persist, transient pairs do not (RS-D9/RS-D11).
- _“May reviewed pairs persist for historical endpoint location?”_ dissolves under accepted ADR 0025: without an ADR change they
  remain transient, so RS-D10/RS-D16 persist aggregate audit and remove historical endpoint actions.
- _“How does one reference with many moving resources work?”_ dissolves under X1/X5 and C2: RS-D15 gives each moving resource an
  independent link while RS-D9 keeps the reviewed publication atomic.
- _“What does an already-grouped or mixed-visibility member do?”_ dissolves under X1/P9/SE-D19: RS-D14 rejects implicit reparenting
  and RS-D12 makes the group eye a bulk act rather than a new visibility parent.
- _“Does a rigid placement invalidate all derived products?”_ dissolves under P10 placement equivalence, X1/X2, SE-D3, and MT-D25:
  RS-D17/RS-D18 preserve exactly co-transformed artifacts and stale only relative-geometry changes.
- _“Which view/gesture/cursor implementation owns Station View?”_ dissolves under P8, UIP §3.6/UIP-D23–D26, and cite-and-revise:
  View/UIP retain substrate, this domain supplies station semantics (RS-D5/RS-D8).
- _“What report format ships?”_ dissolves under dossier evidence, File's sole export act, and X1: versioned CSV+HTML ship;
  undocumented RTF does not (RS-D10).
- _“Must the whole RealWorks registration catalog ship in the starter?”_ dissolves under S16's exact cloud-to-cloud wording and X1:
  RS-D13 keeps every dossier row visible without manufacturing missing target/network contracts.
- _“What are the performance limits?”_ is delegated by X6/P3, not escalated; RS-D11 chooses explicit evidence-calibrated values and
  names what may tune.
- _“Must long ICP hold the workspace open?”_ dissolves under X2/X5/P5/UIP-D10: RS-D22 backgrounds it without granting apply
  authority.
- _“May Station View angles remain automation-only?”_ dissolves under X3/X5 and C1: RS-D23 requires visible numeric parity.

## 15. Completion statement

This specification has re-walked every group after the S16 doctrine/owner batch: catalog, A1–E3, P9/P10/P11, import/PhotoLab
hand-offs, UI gestures/cursors, measurement exactness, passive consumers, extreme class members, pending executable obligations,
and E1 criteria are all explicit. It intentionally modifies no Registry, sibling spec, ADR, normative model document, dossier, or
implementation file.

## 16. Disposition — adversarial review 2026-09-02

All 18 findings are resolved in this specification; none is deferred. External reciprocal work remains explicitly Pending under
§9 and blocks `specified` status, but no finding relies on that queue alone for its local semantic resolution.

| Finding id  | Disposition                                                                                                                                                                                                                                                                     | Spec section / decision id                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1 (blocker) | **Resolved:** retained all five registry-complete rows, changed status to **drafted (registry pending)**, made local ownership non-authoritative until the deterministic incremental update and reciprocal edits land, enumerated exact commands and cross-spec requests.       | opening status; §1.1; §1.4; §9; RS-D3                              |
| 2 (blocker) | **Resolved:** added stable per-moving-resource transient links, ordered list/active-link pane, independent states/pairs/settings/results/errors, link-id commands, repair/remove behavior, all-Reviewed precommit, and all-or-none batch/undo semantics.                        | §1.2; §2.2; §5 C2/C4; RS-D9/RS-D15; G-RS-REG-COMMAND/EXTREME       |
| 3 (blocker) | **Resolved:** adopted SE-D3/SE-D20 and enumerated locked-box bakes, drapes, associative/fixed measurements, linked/pinned Plan captures, sections/indexes, station depth and every MT-D25 recipe across preview/commit/failure/undo/redo.                                       | §8; RS-D17/RS-D18; G-RS-PLACEMENT-CONSUMERS                        |
| 4 (blocker) | **Resolved without changing ADR 0025:** manual observations/endpoints/locators/weights and ICP correspondences remain transient; immutable reports/export retain transforms and aggregate link diagnostics only; historical endpoint location is absent.                        | §1.2; §2.2 step 7; §2.4; §5 C4; RS-D10/RS-D16                      |
| 5 (major)   | **Resolved:** exclusive membership, same-reference destination, fixed-member invariant, already-grouped rejection, explicit group lifecycle/commands/conflicts/undo, historical snapshots, and P9 bulk-eye rather than visibility ancestry.                                     | §1.1–1.2; §4 C2; §8; RS-D12/RS-D14; G-RS-CATALOG                   |
| 6 (major)   | **Resolved:** endpoint union and same-pane re-snap; drag-off-source explicitly downgrades to Typed and loses locator; Estimated/stale Exact cannot reach Reviewed; all input paths share one reducer.                                                                           | §1.2; §2.2 step 4; §5 C1; §7.1; RS-D16; G-RS-REG-GESTURE           |
| 7 (major)   | **Resolved:** adopted P10 placement equivalence for station depth and all derived consumers; common rigid co-transform preserves hash/Current with proof, while differential/unproved change stales; reciprocal MT-D25 request recorded.                                        | §1.3; §2.2 step 9; §6 C4; §8; §9; RS-D6/RS-D18                     |
| 8 (major)   | **Resolved:** deterministic structured-range-first source authority, frozen spherical/pixel/seam/pole/range/collision/mask/confidence profile, fixed collision policy, optional non-authoritative RGB, honest depth-only/NoData rendering, and resolution-independent validity. | §1.3; §2.3; §6; RS-D19; G-RS-DEPTH-UNIT/VISUAL                     |
| 9 (major)   | **Resolved:** versioned row-column/chunk-ordinal direct locator union, generation/hash/bounds verification, Unresolved rather than substitution, no full scan, and cold-fetch feedback/cancel budgets.                                                                          | §1.3; §2.3; §6 D1/D2; RS-D6/RS-D7; G-RS-STATION-PICK               |
| 10 (major)  | **Resolved:** visible multi-select batch plan, complete eligibility/aggregate reservation, deterministic bounded worker/queue policy, shared source reads, per-station failure/checkpoints, two cancel scopes, and hash-verified resume.                                        | §2.3; §6 D1; RS-D20; G-RS-DEPTH-BATCH                              |
| 11 (major)  | **Resolved:** added versioned defaults/units/ranges/validation and calibration corpus; inner-correspondence cancellation checks; 100-link feedback/completion budgets; bounded streaming export with reservation/progress/cleanup/restart semantics.                            | §2.4; §5 C4/D1; RS-D11/RS-D21; G-RS-CALIBRATION/REG-EXTREME/REPORT |
| 12 (major)  | **Resolved:** renamed IDs as Pending verification obligations, specified the exact manifest fields and separate runner classes, and made manifest/fixture absence block `specified`; no test is claimed executable or passed.                                                   | opening status; §11; RS-D11                                        |
| 13 (major)  | **Resolved:** visible orientation popover/Properties fields for yaw/pitch/vertical FOV plus Reset/presets, units/wrap/clamp, one Camera-history gesture, synchronization, command parity, and reopen proof.                                                                     | §1.1; §2.3; §6 C1/C4; RS-D23; G-RS-STATION-ORIENTATION             |
| 14 (major)  | **Resolved:** added Continue in background, stable main-owned session/job identity, Jobs summary/cancel/Reopen, exact active-link restoration, unrelated-edit behavior, stale-input Needs attention, and restart policy without auto-apply.                                     | §2.2 close flow; §5 B2/E2; RS-D22; G-RS-ICP-BACKGROUND             |
| 15 (major)  | **Resolved locally:** withdrew the unsupported Perspective mechanism, grounded exact locators in X1/S16/MI-D5/source schema, and required exact imported-record fixtures; queued the dossier correction without editing it.                                                     | §3.2; §6 A2; §9; RS-D7/RS-D19; G-RS-STATION-PICK                   |
| 16 (major)  | **Resolved:** split every Cloud-Based Registration sub-capability; adapted automatic suggestion, manual constrained numeric alignment, pairs, refine, review and Apply Group; adopted batch rename with full preview/collision/transaction/undo/parity.                         | §1.2; §2.2; §3.1; RS-D2/RS-D15/RS-D21; G-RS-CATALOG/REG-\*         |
| 17 (minor)  | **Resolved:** recorded the complete whole-file dossier search, exact term/synonym set, source-ledger coverage, non-proof caveat, and repeat-after-revision rule.                                                                                                                | §3.2                                                               |
| 18 (minor)  | **Resolved:** corrected raw dispatch citation to `main.rs:1323-1324,1897-2106`, limited code evidence to existence/import staging, cited AG-D4/IF-D12 for privacy, and required negative raw-route plus positive generated enumeration tests.                                   | §1.1; §1.4; §5 A3; §11 G-RS-AUTOMATION; RS-D3                      |
