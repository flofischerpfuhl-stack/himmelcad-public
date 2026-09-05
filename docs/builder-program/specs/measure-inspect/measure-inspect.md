# Measure & Inspect — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2. Document class: plan. The Measure domain's seven
View rows and its File-report contribution are registered; implementation
remains blocked on the ADR 0016/Data-model admission proposed in REGISTRY §4.
This
specification walks the current `docs/FUNCTION-CONTRACT.md`, including
code-status citations, dossier-row dispositions, passive consumers, extreme
class members, and gesture arbitration. Consequential choices use the
decision-record format from `docs/DECISION-DOCTRINE.md`; review dispositions are
appended in §13.

Primary evidence is `dossiers/trimble-perspective.md` §2.6 and W5 (five
measurement types, persistent Measurements panel, editable points, automatic
project persistence, TDX export), `dossiers/realworks.md` §2.6–2.7
(coordinates, distances, projected clearance, annotation, and inspection), and
`dossiers/rib-civil.md` §2.2 (F5 numeric twin, snap candidate choice, and
Tachobox readout). Cross-spec owners cited rather than re-dispositioned:
viewing-box VB-D13, draw DR-D4/DR-D9/DR-D12/DR-D14/DR-D15, select-edit SE-D1,
ui-platform §3.6 and UIP-D10/UIP-D14, pointcloud PC-D6/PC-D10/PC-D16,
view-domain VD-D3/VD-D4, and file-project FP-D4/§1.7.

The in-repo E1 artifact is §8 of this file: failable written visual and behavioral criteria. It requires implementation screenshots from Himmel:CAD itself and
uses no third-party screenshots.

## 1. Scope, ownership, and registry catalog

This domain is the sole owner of interactive inspection measurements, the
persistent Measurements panel, Point info, and measurement CSV. Its seven
View · Measure rows below, plus the File · Export report-contributor row, are
the Measure-domain catalog entries to promote unchanged into the program
registry. A measurement reports geometry; it is not a drafting
annotation and it does not replace `draw.dimension`. Both artifacts are
canonical and associative: Dimension is construction annotation with dimension
graphics/style and a derived value (draw DR-D9), while Measurement is an
inspection artifact with source provenance, verification state, panel/report
lifecycle, and no construction-annotation role (MI-D2). Draw DR-D9 now carries
the reciprocal persistent-inspection-entity boundary; it is not a competing
lifecycle contract.

Owner decision D2 removes the Inspect tab. The final ribbon placement is **View · Measure**, immediately after **View · Clip** and before Style. The group has a
**Measure** split button whose menu exposes every type and a separate **Measurements** pure-toggle button for the panel. Contextual starts remain on measurable
geometry. This preserves View adjacency without hiding the functions in context menus (MI-D1).

Surface legend: VT = armed viewport tool + shared bottom construction input bar + docked right options; RP = right panel; SB = persistent status-bar readout.
Perf: cont = continuous; bnd = bounded under one second; long = long-running with UIP-D10 job registration and UIP-D11 cancellation.

| Id                          | Tab · group                                     | Access paths                                                                   | Surface                     | Perf                              | Automation command/query                                                                                                            | Status vs current implementation                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `measure.point`             | View · Measure                                  | R split menu; X **Save point measurement**; C; A                               | VT                          | cont acquisition; bnd commit      | `measurement.create` (`kind: point`)                                                                                                | new; only transient cursor coordinates exist (`BuilderKernelViewport.tsx:836-845`)                                                                                                                                                                                                                             |
| `measure.distance`          | View · Measure                                  | R split primary/menu; X **Start distance here**; C; A                          | VT                          | cont acquisition/edit; bnd commit | `measurement.create` (`kind: distance`, metric Spatial or Horizontal)                                                               | not implemented; current ribbon entry is a passive placeholder (`ribbon.ts:129-141`; unhandled actions only open a panel, `App.tsx:402-451`)                                                                                                                                                                   |
| `measure.angle`             | View · Measure                                  | R split menu; X **Measure angle**; C; A                                        | VT                          | cont acquisition/edit; bnd commit | `measurement.create` (`kind: angle`, `metric: spatial`)                                                                             | not implemented; placeholder only (`ribbon.ts:136-137`, `App.tsx:450`)                                                                                                                                                                                                                                         |
| `measure.area`              | View · Measure                                  | R split menu; X on planar face/area **Measure area**; C; A                     | VT                          | cont acquisition/edit; bnd commit | `measurement.create` (`kind: planarArea`)                                                                                           | new; no Builder handler or measurement entity (`App.tsx:402-451`; `entity_model.rs:1072-1122`)                                                                                                                                                                                                                 |
| `measure.height_difference` | View · Measure                                  | R split menu; X **Measure height difference**; C; A                            | VT                          | cont acquisition/edit; bnd commit | `measurement.create` (`kind: heightDifference`)                                                                                     | new; RealWorks-style vertical clearance has no Builder surface (`ribbon.ts:129-141`)                                                                                                                                                                                                                           |
| `inspect.point_info`        | View · Measure; coordinate readout always in SB | R split menu/panel toggle; X **Point info**; click SB coordinate readout; C; A | RP + SB, no armed tool      | cont hover/readout                | `inspect.point_info`                                                                                                                | partial substrate: candidate cycling and coordinate callbacks exist (`KernelNavigationController.ts:483-540`), but exactness, provider/source classification, provenance, P4 admission, and core revalidation do not; UI shows XYZ and snap kind only (`BuilderKernelViewport.tsx:836-845`, `App.tsx:698-700`) |
| `measurements.panel`        | View · Measure                                  | R pure toggle; X on measurement **Open measurement**; C; A                     | RP                          | bnd; cont endpoint edit           | `measurement.list/get/update_anchor/update_plane/detach_anchor/rebind_anchor/accept_warning/rename/set_layer/set_visibility/remove` | new; canonical built-ins contain Dimension but no Measurement (`entity_model.rs:20-159`; geometry enum `:1072-1122`)                                                                                                                                                                                           |
| `measurements.report`       | File · Export contributor                       | R via **Export**; X on one/many measurements **Export measurements…**; C; A    | existing File export island | bnd→long                          | `measurement.report.generate`                                                                                                       | catalog level, new; no report command exists in the complete Builder command switch (`App.tsx:561-675`)                                                                                                                                                                                                        |

Keyboard shortcuts: none claimed. The View split button and context entries are sufficiently direct; the registry may later assign a shortcut, but this spec
records absence rather than silently taking Tab, F4, or a letter key. There is no void quick-surface entry: a void does not provide an authoritative Z or
measurable entity, and UIP-D13 limits that surface to void-relevant acts.

Pointcloud comparison, deviation maps, flatness, and verticality remain wholly
Pointcloud-owned under PC-D10. This spec assigns them no IDs, ribbon homes,
surfaces, commands, or dispositions. A future measurement report may consume a
Pointcloud-owned inspection result only after that owner defines the result
contract. The required Pointcloud catalog correction is recorded in §6
(MI-D9).

## 2. Full user-perspective workflows

### 2.1 Chained distance over a locked-box scene

The user has a billion-point building scan, a BIM shell, and the locked viewing box **Facade west** active around three storeys. They need the run from a window
corner, around a column, to a door jamb. On View they open the Measure split button and choose **Distance**. The right options panel opens, the Distance button
stays lit, and the bottom bar says **Pick or type start point**. Mode is **Spatial** and **Chain** is on. The existing selection is unchanged.

As the pointer moves, the shared snap marker and readout identify source, entity, snap kind, X/Y/Z, and candidate count. Points outside Facade west, hidden
entities, and hidden point classes never enter the candidate set (P4, VB-D13, PC-D6/PC-D16). Although the box renders a reduced bake, the marker resolves to the
full-precision source point inside the box before the click can be accepted (VB-D13/DR-D15). A nearby BIM vertex and cloud point remain available through the
shared DR-D12 candidate ordering; Up/Down cycle the same stable stack and the readout makes the chosen source explicit.

The input bar names the active binding before any anchor is accepted:
**Attached to source** or **Fixed coordinate** (MI-D3). With Attached active,
the first click stores the exact entity/revision/provider/primitive target;
coarse rendered-depth candidates may preview but cannot commit. With Fixed
active, typing XYZ and pressing Enter stores only that `Position`; it never
guesses a nearby entity binding. The prompt then becomes **Pick or type next
point**. A rubber-band segment and live spatial length follow the cursor; the
bottom bar exposes resolved X/Y/Z plus distance/direction/height components.
The next-point distance/direction/height fields create a Fixed anchor. Attached
mode instead exposes typeable source parameters and offset as the numeric twin
of **Pick source**. Each later accepted anchor completes another pending
segment, but because **Chain** is on the second point does not commit. The panel
lists segment 1, segment 2, segment 3 and **Total** without covering the scene.
Backspace removes only the latest pending anchor. RMB click opens **Finish /
Undo point / Cancel**; RMB drag still pans and the wheel still zooms.

The user presses Enter after the door jamb. The valid chain commits once as
**Distance 1**, immediately appears in the Measurements panel and entity area,
and survives reload without a Save step. Each anchor's binding, exact position,
Attached source provenance where applicable, per-segment results, total,
metric, and creation view are available through `measurement.get`. Ctrl+Z
removes the one committed measurement; Backspace during acquisition was not
document undo.

Later the user selects Distance 1 in the panel, renames it **West facade access
run**, and presses **Edit anchors**. Endpoint handles appear only now; the
select-edit gizmo and whole-entity transform commands are absent for the
measurement (MI-D6). They drag the attached column anchor to the adjacent
authored vertex; the marker names the new exact source and all affected
segment/total values update continuously. Pointer-up publishes one journaled
update. The attached row displays resolved XYZ read-only and offers typeable
source parameter/offset fields. To enter absolute XYZ the user must choose
**Detach to fixed coordinate**; to keep associativity and change the referent
they choose **Pick source**. A Fixed anchor's XYZ and relative
distance/direction/height are typeable and its fixed-coordinate handle moves it
in the explicit construction plane without changing binding. The same rules
apply at creation and later editing; no path silently changes dependency
semantics. Escape during drag reverts to drag start; Escape in a number field
reverts the field; a later Escape exits anchor editing, and the next closes the
function panel per UIP-D14.

If the user changes the viewing box so one anchor is outside, the measurement entity and value remain stored, but its viewport graphic hides and the panel row
says **Hidden by active view**. Returning the anchor to the visible set restores the graphic. The box never changes the canonical value after commit.

### 2.2 Area on a facade

The user wants the projected area of a rough scanned facade—not a plan area and not an invented triangulated surface. They choose **Area**. The panel first
requires a **Measurement plane**: **Plan XY**, **Planar face**, or **By 3 points**. Because the target is a cloud, they choose By 3 points and pick three
full-precision points across the facade. The panel shows the derived plane origin and orientation in typeable fields. A collinear triple is rejected in place
with **Plane needs three non-collinear points**; no boundary starts.

The prompt changes to **Pick or type first boundary point**. The user traces the opening outline. Every source anchor remains at its exact 3D position; the
preview explicitly says **Projected on measurement plane**. The overlay draws
thin perpendicular residual ticks from each source anchor to the plane and the
panel reports **Max offset**, **RMS offset**, and the count and percentage
beyond tolerance, so a warped facade and one gross outlier are distinguishable.
The largest outlier is highlighted and reachable through **Go to outlier**.
The live result is plane-projected area and plane-projected perimeter. It is
never described as mesh surface area. The warning threshold is the larger of
ten project display-resolution steps and 0.1% of the boundary diagonal (MI-D4,
tunable).

After three points the outline becomes closable. A self-intersecting boundary
highlights the crossing and cannot commit. If every residual is within the
threshold, Finish commits with status **Verified projected**. If the threshold
is exceeded, Finish opens a blocking choice showing maximum and RMS offset,
beyond-tolerance count/percentage, and the exact tolerance, with **Edit plane**
and **Save projected result with warning**. Accepting the warning commits
**Area 1** with status **Projected — warning accepted**. The accepted warning,
residual statistics, tolerance, plane revision, boundary anchors, projected
area/perimeter, units, and provenance are canonical and appear in the panel and
CSV. Projection remains mathematically valid at any residual; neither status
claims mesh surface area. A later endpoint or plane edit recomputes the status
and requires a new acceptance if still above threshold. Boundary edits
recompute only adjacent perimeter terms and the area accumulator while keeping
the explicit plane unchanged; **Edit plane** is a separate journaled action so
moving a boundary cannot silently reinterpret the measurement.

If a source class is hidden or the active section clips any defining plane or boundary anchor, the graphic hides as a unit (VB viewing-box E2; P4), while the
panel preserves the row and explains the view cause. If source geometry is deleted or replaced so an anchor cannot revalidate, the row becomes **Unresolved —
source changed**, retains its last verified value only as clearly labeled history, and is excluded from reports unless the user opts to include unresolved rows.
Undoing the source edit revalidates it.

### 2.3 Point, angle, height, and point information

**Point** is a one-anchor persistent coordinate measurement. **Angle** is a
deliberate Builder extension grounded in the existing Inspect-ribbon
placeholder (`ribbon.ts:129-141`), not in reference behavior: neither the full
Perspective dossier nor the full RealWorks dossier documents an angle tool
(`trimble-perspective.md` §2.6; `realworks.md` §2.6). The first release is
**Spatial angle** only: first ray point, vertex, second ray point; the smaller
unsigned 0–180°/0–200 gon result uses project angle settings and is evaluated
as `atan2(|a × b|, a · b)`. Non-coplanar rays are valid; either unknown Z
or a zero-length ray blocks commit. Horizontal, signed, and reflex angles are
deferred because each needs an explicit projection/orientation workflow absent
from the current product intent (MI-D13). **Height difference** prompts From
then To and reports signed `To.Z − From.Z`; either missing Z blocks commit
rather than becoming zero. Horizontal distance is a mode of Distance, matching
Perspective's five types without creating a sixth near-duplicate button
(`trimble-perspective.md` §2.6).

**Point info** is read-only and never arms a tool. Clicking the existing SB
coordinate readout opens its RP. Hover shows the active candidate's entity
name/id/kind, primitive address, source/snap kind, X/Y/Z (including `Z —`),
provider/provenance, attributes, and an explicit **Exact** or **Rendered surface
estimate** status. An estimate has no Save action. Tab/Shift+Tab keeps its idle
platform meaning and cycles the same candidates. **Save point measurement** is
available only after exact core revalidation and routes to
`measurement.create(kind: point)`; the query itself creates nothing.

## 3. Reference catalog dispositions

Every relevant dossier row is accounted for. “Other owner” and “deferred” are deliberate dispositions, not omissions.

| Dossier evidence                                                                                                                  | Disposition                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perspective single point, slope distance, horizontal distance, vertical clearance, area+perimeter (`trimble-perspective.md` §2.6) | adopted as Point, Distance Spatial, Distance Horizontal, Height difference, and planar Area                                                                                                                                                                                             |
| Perspective origin station/view metadata (§2.6)                                                                                   | adapted: store creation view and exact source provenance now; station id is stored when supplied, without inventing one before the stations domain exists                                                                                                                               |
| Perspective stacked panel, visibility eye, delete, drag-point editing, auto-save (§2.6; W5)                                       | adopted by `measurements.panel`, MI-D2/MI-D6                                                                                                                                                                                                                                            |
| Perspective TDX export (§2.6)                                                                                                     | adopted at outcome level—portable project state plus standalone report; this spec rejects a native TDX writer until a documented format or dependency-policy-compatible encoder and fidelity corpus exist (MI-D8); IF-D10 now applies the same opaque-codec gate to readers and writers |
| Angle                                                                                                                             | dossier-wide absence: neither cited measurement dossier documents an angle tool; retained as a deliberate Builder extension from the existing ribbon placeholder, Spatial-only in the first release (MI-D13)                                                                            |
| RealWorks coordinates, distances, smart clearance and projected vertical/horizontal distance (`realworks.md` §2.6)                | adopted by Point, Distance modes, and Height difference                                                                                                                                                                                                                                 |
| RealWorks 3D annotations, links, captures, view stations, inspection-distance fields (§2.6)                                       | other owners: Draw labels and View bookmarks; inspection-map annotations remain with PC-D10; rejected from measurement entities to preserve the DR-D9 boundary                                                                                                                          |
| RealWorks feature coding/Easy Line/polyline and catenary (§2.6)                                                                   | other owner: Draw; no duplicate rows here                                                                                                                                                                                                                                               |
| RealWorks Surface/Twin Surface, 3D/2D inspection and analyzer (§2.7; W8)                                                          | Pointcloud-owned under PC-D10; no row or command is assigned here; §6 requests the missing Twin Surface/cloud-to-cloud catalog row in that owner                                                                                                                                        |
| RealWorks floor flatness and wall verticality (§2.7)                                                                              | Pointcloud-owned under PC-D10; §6 requests the missing wall-verticality row in that owner                                                                                                                                                                                               |
| RealWorks low-density error behavior (§2.7)                                                                                       | evidence about failure messaging inside 3D inspection, not evidence for a standalone density tool; no density row is created here or requested                                                                                                                                          |
| RealWorks tank inspection and volume (§2.7)                                                                                       | tank rejection remains pointcloud's prior disposition; volume remains Mesh-owned (`realworks.md` §5); not re-decided here                                                                                                                                                               |
| RIB F5-Box, Fangkreis/Punktauswahl, Tachobox (`rib-civil.md` §2.2)                                                                | adopted as shared typed input, kernel snap/candidate cycle, and adaptive readout; implementation comes from Draw DR-D12/DR-D14                                                                                                                                                          |
| RIB Maßketten/dynamic dimensions (`rib-civil.md` §2.1, §2.9)                                                                      | other owner: `draw.dimension`; explicitly not an inspection measurement (DR-D9)                                                                                                                                                                                                         |
| RIB quantity counts/lengths/areas/volumes (`rib-civil.md` §2.8)                                                                   | rejected from this catalog: billing quantities derive from canonical design/terrain entities, not user inspection artifacts; Mesh/Civil retains that domain                                                                                                                             |

## 4. Function contract — core measurement creators

### A. Purpose and grounding

**A1.** The full outcomes are §2.1–2.3: choose a type, acquire explicitly Fixed
anchors or exact visible Attached anchors, inspect a live derived result,
commit one named artifact, reopen it, edit anchors, hide/show, undo, restore,
automate, and include it in a report.

**A2.** The five-type catalog and persistent edit model are adopted from
Perspective §2.6/W5. RealWorks §2.6 contributes projected
horizontal/vertical clearance. RIB §2.2 contributes the typed twin and
adaptive readout. Stated deviations: Area works on an explicit plane rather
than Perspective's Map-only XY surface; results are canonical entities from
first valid commit rather than unspecified panel records; Angle is a
Spatial-only Builder extension from the existing placeholder because the full
measurement dossiers document no angle behavior (MI-D13); and native TDX
output is rejected locally by MI-D8 until an implementable codec and fidelity
corpus exist, so portable `.hcadx` plus the open report fulfill the sharing
outcome.

**A3.** Siblings: `draw.dimension` and Measurement are both persistent but have
the distinct contracts in §1/MI-D2; DR-D9 supplies the derived-value boundary.
Draw A3's contrary transient wording is explicitly superseded here and queued
for owner-file correction in §6. Its shared snap marker/readout/input-bar
conventions are adopted. The kernel pipeline and source preferences are
DR-D12, not a new measurement snap engine. Visibility/full precision are
VB-D13/DR-D15/P4.
Attached-project interiors remain non-editable but measurable (file-project §1.7). The raster-depth helper already computes exact source-position segment
distances for depth-backed raster/panorama inputs (`himmelcad-wasm/src/lib.rs:3438-3461`); it becomes a provider behind the same anchor resolver, not a second
UI or persistence path.

### B. Access and lifecycle

**B1.** Every registry row states ribbon/context/console/automation/keyboard presence. UI, console, agent, and Python call the same `measurement.*` command or
`inspect.point_info` query. Context starts seed the first anchor from the clicked geometry after core revalidation. Quick-surface and shortcut absences are
recorded in §1.

**B2.** A lit measurement type toggles off. Point auto-commits after one valid
anchor. Distance with Chain off and Height difference auto-commit after the
second valid anchor; Angle auto-commits after the third. With Chain on, the
second Distance anchor completes segment 1 but remains pending: Enter when the
viewport/tool owns focus, valid tool-rung Escape, ribbon toggle, or tool-menu
Finish commits the whole valid chain once; explicit Cancel discards it and
Backspace removes the latest pending anchor. Area uses the same explicit end
paths after a valid boundary, subject to the §2.2 residual-warning choice.
Invalid end paths commit nothing. The RP has an x; closing it exits editing but
leaves committed entities and visibility intact. Uncommitted field text is
discarded, never blur-committed on close (UIP-D14).

**B3.** VT is required because the pointer stays on geometry while options and
typed twins remain visible. The persistent list is an RP because users keep
navigating and editing endpoints. Report setup contributes to File's existing
export island rather than opening a second exporter. Nothing in §2 needs a
dedicated window; Pointcloud-owned analysis remains outside this spec.

### C. Interaction and state

**C1.** Every anchor declares `fixed` or `attached`; UI and automation never
infer the discriminant. Fixed anchors expose typeable X/Y/Z and relative
distance/direction/height plus a fixed-coordinate handle in the explicit
construction plane. Attached anchors expose **Pick source**, exact source
parameters/offsets, and resolved XYZ read-only; entering absolute XYZ first
requires **Detach to fixed coordinate**. A snapped edit remains attached and a
fixed edit remains fixed until the explicit symmetric action changes binding
(MI-D3, X5). Plane origin/orientation can be picked or typed under the same
rule. Units/precision and angle convention use project settings. Derived
distance, angle, area, perimeter, residual, and ΔZ are deliberately read-only:
allowing a typed replacement would falsify the inspection claim, the same
X1-over-C1 resolution as DR-D9. Users type the inputs that derive the number,
never the answer.

**C2.** Ribbon creation ignores and preserves selection. A context start uses
only the clicked geometry to seed one Attached anchor after exact core
revalidation. A running tool captures its target/source preferences and target
layer at launch; later selection/current-layer changes do not retarget it.
Selecting measurement entities in the entity tree/panel highlights their
graphics but exposes no move/rotate/scale commands or whole-entity gizmo:
`hcad.measurement@1` is non-transformable (MI-D6). Mixed multi-selection
supports visibility/remove/report, while anchor/plane editing requires exactly
one measurement and is the sole owner of measurement handles. Attached project
geometry is a valid read-only anchor source (file-project §1.7).

**C3.** Core measurement preview has no user lock: inputs are a small ordered
anchor set, exact semantic targets are resolved incrementally through the
shared kernel path, and endpoint edits update adjacent segment/area terms. A
lock would add state without reducing the billion-point source; the viewing box
lock already bakes that source (P2). The implementation exploits committed
entity/source revisions as immutable cache keys.

**C4.** A valid finish creates `hcad.measurement@1`, a new canonical named
entity distinct from `hcad.dimension@1` (MI-D2). It has exactly one layer,
captured at tool start and Default when omitted (draw DR-D4). Create,
endpoint/plane edit, warning acceptance, rename, visibility, layer assignment,
and remove are journaled, undoable commands. Acquisition previews, pending
anchors, hover, active row, panel filter/scroll, and edit mode are view-local.
The artifact and reconstructible last-verified result travel losslessly in
`.hcad/.hcadx`; report files are outputs, not authority. Snapshot restore
includes measurement create/delete/revision/visibility/layer and source
revisions in the same published generation, then revalidates every restored
anchor; snapshot entities alone remain exempt per FP-D4. Bookmarks capture only
canonical measurement visibility by entity ID per VD-D3/VD-D4, never anchors,
values, layer, verification state, or panel state. This follows P1's explicit
saved-measurement class and Perspective auto-save (§2.6).

### D. Performance and degradation

**D1.** Continuous: hover point info, rubber bands, result preview, candidate cycling, and endpoint/plane-handle drag. Gate G-MI-CONTINUOUS (§9) uses a
locked-box mixed scene plus a 10,000-anchor chain/area: presented-frame- interval p95 ≤ 2× target frame time, exact snap query ≤ 4 ms p95 (the draw DR-D1 gate),
pointer-to-readout ≤ 150 ms p95, and no stale candidate shown. Bounded: commit/edit/list/undo under one second with an inline busy state only if perceptible.
Reports cross to long at the platform job threshold.

**D2.** The viewer governor may reduce decorative overlay tessellation and cloud display density, in that order. It may pause hover picking during camera motion
as the controller already does (`KernelNavigationController.ts:483-509`). Never degraded: input response, visible-set filtering, source choice, core
revalidation, f64 coordinates, derived values, journal integrity, or report provenance. A locked box supplies the performance path without reducing measurement
precision (VB-D13).

### E. Quality, conflict, and verification

**E1.** §8 is the repository artifact and §9 names the screenshot gate.

**E2.** The consumer and gesture contracts are §7. Failures never publish a partial measurement. A stale anchor rejects commit and keeps the acquisition open
with the failed anchor named. Source deletion never silently deletes the measurement; it becomes unresolved (MI-D3).

**E3.** Named agent-runnable gates are in §9; no implementation claim is left without an intended gate. Explicitly unverified items are listed there.

## 5. Function contract — information, panel, and report

**A1.** Point info turns the existing terse cursor output into a source-aware
inspection readout; the panel makes all committed measurements findable and
editable; Report snapshots selected/all measurements into a reviewable export
plan and produces the versioned long-table CSV contract in §5.1.

**A2.** Perspective §2.6 supplies the stacked panel, origin/view metadata,
visibility, deletion, drag editing, auto-save, and export. RealWorks §2.9
documents inspection reports including CSV. We adopt the behaviors, but route
generation through the existing File export flow. Native TDX writing is a
deliberate MI-D8 rejection consumed by import-formats IF-D10's generalized
reader-and-writer codec gate.

**A3.** The SB coordinate and snap chips exist (`BuilderKernelViewport.tsx:836-845`; `App.tsx:698-700`) and are extended rather than duplicated. The RP uses
platform tab close/detach behavior (UIP-D7/UIP-D8). `file.export` owns the plan/execute shell; this domain contributes measurement scope and writer data, which
file-project FP-D5/FP-D6 now registers.

**B1.** Access is cataloged in §1. Report context access appears only when the selection contains measurements. `measurement.report.generate` accepts an
explicit id list or `all`; there is no implicit “whatever is selected when the job finishes.” Point-info automation supplies view id plus screen coordinate or
an explicit world ray; it never depends on an inaccessible human cursor.

**B2.** Point info/Measurements buttons and panel x are symmetric toggles; closing preserves state. The report island follows `file.export` back/cancel/close
behavior. Long report generation continues only while its captured project snapshot lease is valid; project close requests cancellation and publishes no partial
target.

**B3.** RP fits a filterable measurement list and one selected artifact's anchors. File export island fits report scope/options. If inspection maps need a
canvas/error list, that is exactly the dedicated-window PC-D10 class, not a reason to inflate this panel.

**C1.** Point info is output only. Panel anchor and plane fields provide the typed side of every handle. Report scope/options are form controls, not direct
manipulation. Report numeric values are derived read-only for the X1 reason in §4 C1.

**C2.** Point info follows cursor candidates independent of selection. Panel selection is synchronized with the global entity selection for measurement
entities; multi-select common actions are named in §4 C2. Report captures its explicit id set and exact revisions at plan confirmation; later selection or
measurement edits do not mutate the running export.

**C3.** Panel filters may be frozen by an explicit text filter but gain no computational lock. Report generation uses the captured immutable revision set to
precompute and stream rows boundedly; no whole-project JSON materialization.

**C4.** Point-info hover is transient. Measurement entities and visibility are canonical/journaled. Panel layout/filter are per-user UI state outside undo.
Generated report files are external outputs and are never used to restore the canonical entities; `.hcadx` is the lossless sharing story.

**D1.** Point info uses the continuous budget in §4 D1. Panel list operations are bounded and virtualized for 100,000 rows. Report generation is bnd→long,
streams rows, registers with UIP-D10 when long, reports real row/asset counts, and is cancellable per UIP-D11.

**D2.** Weak hardware reduces hover frequency and decorative overlay detail, never exact click/save resolution. Panel virtualization preserves input response.
Report images, if a later writer adds them, may reduce image quality only when the confirmed plan says so; numeric content never degrades.

**E1.** Criteria 1–6 and 9–10 in §8.

**E2.** A report reads a captured canonical snapshot while edits continue; it does not lock measurement editing. If a referenced source becomes unresolved after
capture, the captured verified status is written with project/journal revision so the report never pretends to be live. Output publication uses a sibling
candidate and atomic replacement per project-format transactional practice. Consumers are included in §7.

**E3.** G-MI-POINT-INFO, G-MI-PANEL, G-MI-REPORT, G-MI-AUTOMATION, and G-MI-VISUAL (§9).

### 5.1 Measurement report CSV v1

The default writer is **Portable CSV (`himmelcad.measurement-report@1`)**:
UTF-8 without BOM, comma delimiter, `.` decimal, CRLF record endings, and
RFC-4180 quoting (embedded comma, quote, CR, or LF quotes the field; a quote is
doubled). The first record is exactly the ordered header below. Empty means
not applicable; it never means numeric zero. Booleans are lowercase
`true`/`false`; finite numbers use shortest round-trippable decimal; NaN and
infinity are forbidden. `z` is empty when unknown and `z_known=false`. Every
portable row carries `schema_version=himmelcad.measurement-report@1` and
`format_profile=portable`.

```text
schema_version,format_profile,record_type,measurement_id,measurement_revision,measurement_name,measurement_kind,metric,verification_status,record_index,segment_index,anchor_index,anchor_role,layer_id,visible,value,value_unit,secondary_value,secondary_unit,x,y,z,z_known,coordinate_unit,binding,source_entity_id,source_entity_revision,source_entity_version_hash,source_provider_id,source_representation_id,source_primitive_id,source_parameter,offset_x,offset_y,offset_z,plane_origin_x,plane_origin_y,plane_origin_z,plane_u_x,plane_u_y,plane_u_z,plane_v_x,plane_v_y,plane_v_z,plane_n_x,plane_n_y,plane_n_z,plane_revision,max_offset,rms_offset,beyond_tolerance_count,sample_count,beyond_tolerance_percent,tolerance,residual_unit,warning_accepted,creation_view_id,result_basis,unresolved_reason
```

Row and value rules are normative:

- `record_type=measurement`: exactly one row per requested measurement. `value`
  is Distance total, Angle, projected Area, or signed Height difference;
  `secondary_value` is projected perimeter for Area. Point has both empty and
  its coordinate in the anchor row. Plane basis, residual statistics,
  tolerance, warning acceptance, creation view, visibility, and result basis
  live on this row.
- `record_type=segment`: one row per Distance-chain segment in ascending
  `segment_index`, with segment length in `value`; absent for other kinds.
- `record_type=anchor`: one row per ordered measurement anchor and plane-defining
  anchor. `anchor_role` distinguishes `point`, `from`, `to`, `rayStart`,
  `vertex`, `rayEnd`, `boundary`, and `planeDefinition`; `anchor_index` is
  zero-based within that role. Fixed rows carry position and `binding=fixed`.
  Attached rows additionally carry exact source identity/revision/provider/
  representation/primitive/parameter and offset.
- Every row repeats schema version, format profile, measurement identity,
  revision, name, kind, metric, status, layer, and visibility. `record_index`
  is monotonically increasing within one measurement. Measurements preserve
  the confirmed request order; child rows use the ordering above.
- `coordinate_unit`, `value_unit`, `secondary_unit`, and `residual_unit` are
  explicit UCUM-compatible project-unit symbols. Stored f64 values are emitted
  without display rounding. Angles use the confirmed project unit (`deg` or
  `gon`); areas use the squared project length unit.
- Plane axes `u`, `v`, `n` are a right-handed orthonormal basis and unitless;
  its origin uses `coordinate_unit`. `plane_revision` identifies the plane
  definition used for the result. Non-area rows leave all plane/residual fields
  empty.
- `result_basis=current` is required for resolved rows.
  `result_basis=last_verified` and `unresolved_reason` are required for an
  unresolved row included by explicit option; unresolved rows remain excluded
  by default. `warning_accepted=true` is valid only for
  `verification_status=projectedWarningAccepted`.

The export island also offers **Excel locale CSV** as an explicitly named
format profile, never as the silent default. Its confirmed locale chooses
delimiter and decimal symbol (they must differ), writes a UTF-8 BOM, and keeps
the identical column order, row semantics, units, and schema version;
`format_profile=excelLocale:<BCP-47 tag>`. The preview states the chosen
delimiter/decimal before execution. MI-D8 owns this contract.

P7 distinction: the portable CSV order above is the versioned interchange
schema, not an office report-layout mandate. Human-facing measurement reports
use an editable named layout/profile (visible columns/order, units/display
precision, headings, logo/footer, locale), seeded with the portable table and
importable/exportable as user data. Export always records both layout id/revision
and wire schema; offices may edit the former without forking the latter.

## 6. Cross-spec reconciliation results

The program README's cite-and-revise changes below landed in the consolidated
2026-09-02 reconciliation. They remain implementation prerequisites where the
owning row says so and do not transfer ownership back into this spec.

| Owner file                                                         | Applied disposition / remaining external gate                                                                                                                                                                            | Governing record here            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `docs/builder-program/REGISTRY.md`                                 | Reconciled 2026-09-02: seven View · Measure rows plus the File · Export contributor are registered, F5a is closed, and the layout/panel/gesture/contribution checks pass.                                                | MI-D1                            |
| `specs/view/view-domain.md`                                        | **Applied:** VD-D12 places **Measure** between Clip and Style and cites MI-D1.                                                                                                                                           | MI-D1                            |
| `specs/draw/draw.md`                                               | **Applied:** DR-D9 names Dimension and Measurement as canonical/associative but separates construction annotation from persistent inspection.                                                                            | MI-D2                            |
| `specs/select-edit/select-edit.md`                                 | **Applied:** SE-D14 excludes `hcad.measurement@1` from move/rotate/scale/mirror; measurement anchor/plane editing owns its handles.                                                                                      | MI-D6                            |
| `specs/pointcloud/pointcloud.md`                                   | **Applied:** PC-D10 owns dossier-backed Twin Surface/cloud-to-cloud and wall-verticality rows, targets Measurement dispositions here, and adds no standalone density row.                                                | MI-D9                            |
| `specs/import-formats/import-formats.md`                           | **Applied:** IF-D10 covers opaque codecs in both directions and rejects the Perspective TDX measurement writer until a documented format or compatible encoder plus fidelity corpus exists.                              | MI-D8; IF-D10                    |
| `specs/file-project/file-project.md`                               | **Applied:** FP-D5/FP-D6 register the measurement CSV contribution and output matrix; FP-D4/FP-D16 cover Measurement restore and reachability without changing FP-D4's snapshot-only exemption.                          | MI-D8/MI-D11; FP-D4–FP-D6/FP-D16 |
| `docs/adr/0016-canonical-entity-model.md` and `docs/DATA-MODEL.md` | Before implementation acceptance, record the new built-in and its strict semantic-admission/migration contract. This spec supplies the complete delta in §7.1/§11; it does not write or silently amend the accepted ADR. | MI-D2                            |

## 7. Shared state, consumers, failures, and gesture arbitration

### 7.1 Canonical anchor and result contract

`hcad.measurement@1` is a distinct built-in admitted only with canonical
`MeasurementGeometry`; Dimension and Label geometry are incompatible. The v1
geometry contract contains:

- `measurement_kind`: `point | distance | angle | planarArea |
heightDifference`; `metric`: `spatial | horizontal` only where valid;
- ordered `MeasurementAnchor`s with an explicit binding discriminant:
  `Fixed { position }` or `Attached { entity_id, expected_revision,
expected_version_hash, provider_id, representation_id, primitive_address,
source_parameter?, exact_source_position, offset }`;
- for Area, a right-handed `MeasurementPlane` (origin plus orthonormal
  `u/v/n`, definition anchors, revision) and ordered boundary anchors;
- `MeasurementVerification`: `verified | verifiedProjected |
projectedWarningAccepted | unresolved`, including max/RMS residual,
  tolerance, beyond-tolerance count/sample count, warning acceptance, and
  unresolved reason as applicable;
- a reconstructible result cache containing inputs/plane revision and
  algorithm version. Anchors and plane are authority; cache mismatch is
  invalidated and recomputed, never trusted as a replacement for inputs.

The envelope also carries name, exactly one layer, canonical visibility, and
creation view/provenance. Entity placement is forbidden: measurement geometry
is already expressed through Fixed world positions and Attached source
dependencies, so a second transform would make its reported claim ambiguous.
The current browser exact-target path is useful precedent
(`packages/@himmelcad/data/src/index.ts:1241-1279`), but the kernel cursor path
does not yet satisfy it: Rust `PickCandidate` has no exact/provider fields,
retains unowned coarse rendered-depth hits (`picking.rs:253-298`), the
TypeScript facade calls every candidate exact (`WgpuKernelViewer.ts:1077-1087`),
and Builder hard-codes `source: 'point-cloud'`
(`BuilderKernelViewport.tsx:1297-1307`). A Measurement commit accepts only a
candidate whose provider marked it exact and whose canonical core resolver
revalidates the complete target against the expected source revision (MI-D5).

Entity placement changes re-resolve a still-valid Attached local target.
Geometry replacement/re-sync must revalidate its stable address; failure marks
the measurement unresolved instead of freezing an unlabeled old claim. Fixed
XY positions may back Point or Horizontal Distance; Spatial Distance, Spatial
Angle, Height difference, and a facade plane require known Z. Unknown never
means zero (`docs/DATA-MODEL.md` “Coordinates and dimensionality”).

| Consumer                                     | Required effect                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render/overlay passes and draw order         | screen-legible measurement graphics render after world geometry and before selection/tool handles; among measurements, canonical layer draw order applies, then stable entity id; they never become dimension geometry or alter source passes                                                                                                                                                      |
| Picking/snapping                             | all acquisition and edits use one kernel candidate/refinement pipeline; coarse rendered-depth hits are labeled estimates and may preview but cannot commit; provider/source identity and explicit Coarse or Exact state survive Rust→TypeScript→Builder, and exact core revalidation is mandatory (MI-D5). Measurement graphics have a selection hit zone but never enter geometry snap candidates |
| Clips and visibility                         | P4 applies at acquisition; clipped, entity-hidden, layer-hidden, and class-hidden sources cannot anchor; natural occlusion does not exclude. A committed overlay is visible only when its own eye, its exactly-one layer eye, and every Attached anchor source visibility test pass; any failure hides the whole graphic (VB-D13, PC-D6/PC-D16)                                                    |
| Layers                                       | target layer is captured at tool start, Default if omitted; reassignment replaces membership (DR-D4). A locked measurement layer keeps rows/results readable but rejects anchor, plane, warning-acceptance, rename, visibility, and remove edits with the layer named                                                                                                                              |
| Locked viewing box                           | candidates may originate in the bake but accepted anchors resolve against full-precision source points inside the box (VB-D13/DR-D15)                                                                                                                                                                                                                                                              |
| Source entities                              | edits/transforms trigger revalidation and recompute; deletion/replacement preserves an unresolved measurement row; undo may revalidate                                                                                                                                                                                                                                                             |
| Attached projects                            | nested geometry is a valid read-only target and follows reference placement; re-sync revalidates; measurement editing never edits the attachment (file-project §1.7)                                                                                                                                                                                                                               |
| Selection/entity tree/properties/select-edit | measurement is one selectable non-transformable entity; selection shows properties/highlight only. Move/rotate/scale/mirror and the whole-entity gizmo are absent. **Edit anchors/Edit plane** suppresses select-edit handles and exclusively owns measurement hit zones; close/exit removes them all                                                                                              |
| Draw dimensions                              | no conversion or shared entity kind; both may reuse formatter/math primitives, but measurements use inspection overlay and dimensions remain annotation (DR-D9)                                                                                                                                                                                                                                    |
| Snapshots/restore                            | FP-D4 restore includes measurement create/delete/revision/visibility/layer and every source revision in one published generation; anchors revalidate only after the full generation is visible. Snapshot entities alone remain exempt; no measurement state is exempt                                                                                                                              |
| View bookmarks                               | VD-D3/VD-D4 capture and restore only canonical measurement visibility by entity id. They never capture anchor/value/layer/verification state or panel filter/selection/edit mode                                                                                                                                                                                                                   |
| `.hcad` / `.hcadx`                           | lossless entity, geometry, verification, source dependencies, and unknown-field preservation; archive round-trip is required before the built-in ships                                                                                                                                                                                                                                             |
| Measurement CSV                              | explicit selected/all scope, captured revisions, schema §5.1; unresolved excluded by default and clips never act as an implicit report filter                                                                                                                                                                                                                                                      |
| Ordinary CAD/model exporters                 | exclude inspection overlays unless that writer explicitly declares `hcad.measurement@1` support; the File plan lists the exclusion/loss before writing (FP-D5)                                                                                                                                                                                                                                     |
| Screenshot / Plan viewport / viewer publish  | each plan exposes **Include measurement overlays**. Screenshot defaults on to match the visible viewport; Plan and viewer publish default off. When on, only overlays passing the visibility rule above render; the option never changes canonical visibility                                                                                                                                      |
| WeltView and strict sibling readers          | the same implementation tranche adds read-only parse, preserve, list, render, inspect, layer/eye, warning, and unresolved support to WeltView. Other strict readers must either implement the generated v1 contract or preserve and surface an unsupported read-only entity; none may drop it or open writable                                                                                     |
| Automation                                   | generated command/query schema exposes the full discriminated geometry and status: create/read/edit/detach/pick-source/update-plane/accept-warning/rename/layer/visibility/remove/report; Attached creation requires exact target fields, Fixed creation requires `Position`, and ambiguous payloads fail schema validation. Point-info takes explicit view/screen/ray inputs (X3/ADR 0024)        |
| Project/journal/viewer recovery              | journal is authority; overlay rebuilds from committed snapshot after device/renderer loss (ADR 0019); pending acquisition is safely transient; cache disagreement recomputes from anchors and never changes authority                                                                                                                                                                              |

Concurrency: only one viewport tool may be armed (ui-platform §3.6). Starting another tool ends a valid measurement by the B2 rule or cancels an invalid one.
Automation editing the same measurement during a drag cancels/reverts the preview, applies the winning canonical revision, and reports the conflict; an
expected-revision failure changes nothing. Source mutation between pick and commit makes core revalidation reject the stale anchor while keeping the acquisition
open. Report jobs capture revisions and therefore coexist with editing. Project replacement cancels acquisition and project-bound report leases at a bounded
boundary. A renderer failure loses only preview/hover; committed measurement state reprojects from the journal.

Extreme members: the anchor-source class ranges from one fixed typed XY point to a point inside a streamed billion-point cloud or nested attached project; all
obey exact/P4 admission. The measurement class ranges from a one-anchor Point to a 10,000-anchor distance chain or facade polygon; list virtualization and
incremental math preserve interaction. The visibility class ranges from one hidden entity to a hidden class removing hundreds of millions of points; neither
leaves pick candidates or half-visible graphics. The revision class ranges from a placement-only transform (re-resolve) to an attachment re-sync with different
geometry (unresolved unless the address validates). The numeric-coordinate
class ranges from a metre-scale polygon near the project origin to the same
polygon translated to kilometre and national-grid-scale coordinates, with
near-duplicate and almost-collinear edges; all use the §7.3 local-frame rule
and recorded scale-aware tolerances.

### 7.2 Armed-tool gesture map

This table reconciles every claimed input against ui-platform §3.6 and adopts DR-D14's armed-click pattern without re-dispositioning it.

| Input while a measurement tool/edit mode is armed | Claim and reconciliation                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LMB click below UIP-D1 threshold                  | in Attached mode, preview/commit an exact source target; in Fixed mode, place a fixed coordinate in the explicit construction plane; idle select is suspended and selection never changes (DR-D14 pattern)                                                                  |
| LMB double-click                                  | unclaimed; keeps the platform reservation; Finish remains visible in RMB menu/Enter                                                                                                                                                                                         |
| LMB drag                                          | platform orbit/pan unless press begins on an armed measurement/plane handle; armed measurement editing suppresses the select-edit gizmo, and handle-origin drag belongs exclusively to this tool. Attached handles accept exact sources; Fixed handles remain fixed-binding |
| Ctrl+LMB                                          | unclaimed as selection; tool receives the same anchor pick—selection cannot mutate mid-tool                                                                                                                                                                                 |
| RMB click                                         | measurement tool menu: Finish, Undo point, Cancel; UIP-D5 routes the armed event as in DR-D14                                                                                                                                                                               |
| RMB drag; MMB drag/click; wheel                   | platform pan; platform pan/unassigned; platform zoom—untouched                                                                                                                                                                                                              |
| Tab / Shift+Tab                                   | focuses/traverses input-bar fields; never cycles candidates (DR-D1/DR-D14)                                                                                                                                                                                                  |
| Up / Down                                         | cycles the live candidate stack; otherwise unclaimed                                                                                                                                                                                                                        |
| Backspace                                         | removes latest pending anchor; never document undo                                                                                                                                                                                                                          |
| Enter                                             | with field focus, commits the typed anchor/parameter; with tool focus, finishes a valid Chain-on Distance or Area. Chain-off Distance has already auto-committed at anchor two                                                                                              |
| Escape                                            | exactly UIP-D14: field revert → active handle-drag revert → menu close → tool rung ends valid/cancels invalid → detached island → function tab → selection                                                                                                                  |
| Printable typing                                  | auto-focuses the shared construction input bar; registry shortcuts suspend while the field owns input                                                                                                                                                                       |
| Touch equivalents                                 | tap acquires; handle drag edits; tap-hold opens tool menu; pinch/navigation remains platform-owned                                                                                                                                                                          |

### 7.3 Stable planar calculation contract

Planar Area never applies shoelace math to large world coordinates directly.
Let the explicit plane store origin `O` and right-handed orthonormal basis
`u, v, n` (`u × v = n`). For each f64 anchor `P`, first subtract `O` in f64,
then compute local coordinates `x=(P-O)·u`, `y=(P-O)·v` and residual
`r=(P-O)·n`. Area uses the local `(x,y)` pairs, with Neumaier-compensated
or pairwise accumulation for the shoelace sum and perimeter. The result is
normalized to counter-clockwise winding; reversed input produces the same
positive area/perimeter and a canonical normalized boundary order.

Scale-aware validation uses `L=max(boundary diagonal, longest edge, 1 project
length unit)`, `eps_len=max(project geometric tolerance when explicitly set,
128 * f64::EPSILON * L)`, and
`eps_area=max(project area tolerance when explicitly set,
256 * f64::EPSILON * L²)`. Adjacent points within `eps_len` are duplicates;
edges at or below it are near-zero; an explicit closing point within
`eps_len` of the first is removed before implicit closure; orientation and
intersection predicates use `eps_area`; absolute signed area at or below
`eps_area` is degenerate and cannot commit. These initial multipliers are
tunable under X6, but one measurement records the actual tolerances used so
replay and reports do not drift (MI-D12).

## 8. E1 visual and behavioral criteria — failable artifact

Implementation review captures light- and dark-theme screenshots at 100% UI scale and compares them against these criteria:

1. View ribbon order visibly reads Camera, Clip, **Measure**, Style; no Inspect
   tab remains. The split menu names Point, Distance, Angle, Area, Height
   difference; Measurements is a distinct toggle.
2. On a dense cloud plus BIM edge, exactly one armed snap marker is dominant;
   source name/kind and candidate count are legible without a color wash.
3. Live lines/arcs/polygons distinguish pending from committed inspection
   graphics and from Draw dimensions in both themes, using shared tokens only.
4. The bottom bar keeps a stable order: prompt, **Fixed coordinate** or
   **Attached to source** binding chip, X/Y/Z, then metric-specific fields.
   Attached resolved XYZ is visibly read-only beside **Pick source** and
   **Detach to fixed coordinate**. `Z —` is explicit and never rendered as 0.
5. Measurements panel rows show name, primary value + unit, type icon,
   visibility eye, and status. Long names truncate with full tooltip; no row
   moves vertically when hover/actions appear.
6. Selected measurement handles appear only in Edit anchors/Edit plane; no
   whole-entity transform gizmo or transform context verb appears. Closing the
   panel disarms every measurement hit zone. A stationary pointer produces no
   inter-frame handle or value jump.
7. Locked-box screenshots contain no marker/graphic for clipped anchors, while
   an inside full-precision anchor shows the same formatted coordinate before
   and after lock.
8. Facade Area says **Projected on measurement plane**, draws the plane/offset
   residuals, and shows Area, Perimeter, Max offset, RMS offset, and beyond-
   tolerance count/percentage. Above tolerance cannot look normally verified;
   the blocking choice and any accepted-warning badge are unmistakable. A
   self-crossing edge uses error-status styling and cannot look committed.
9. An unresolved row is unmistakable in both themes: warning icon, words
   **Unresolved — source changed**, last verified value labeled as such, and
   no normal “current” overlay.
10. Point info never obscures the cursor target; entity name/id/kind, source,
    snap, XYZ, provenance, and **Exact** versus **Rendered surface estimate**
    align as scannable label/value rows. Unknown or unavailable values use an
    em dash, not invented defaults; an estimate cannot present a Save action.

## 9. Verification plan (per `docs/TEST-TIERS.md`)

- **G-MI-UNIT-MATH — changed:** Rust unit/property tests for spatial and
  horizontal chains, signed ΔZ, Spatial-angle non-coplanar rays,
  `atan2(cross,dot)`, unknown-Z/zero-ray refusal, degree/gon formatting, and the
  §7.3 local-plane algorithm. Run the identical polygon at local, kilometre,
  and national-grid-scale origins; reversed winding; almost-collinear and
  near-zero edges; explicit near-duplicate closure; and 10,000 vertices. Stable
  area/perimeter/residual results must agree within the recorded project-unit
  tolerance; incremental updates equal full recomputation.
- **G-MI-UNIT-ANCHOR — changed:** core anchor validation across fixed,
  point-cloud point, curve vertex/edge, mesh face, raster-depth, and attached
  nested targets; Fixed and Attached schemas are mutually exclusive; typed XYZ
  never infers a binding; snapped-then-edited stays Attached; detachment is
  explicit and symmetric in UI/automation. Expected-revision failure changes
  nothing; transform re-resolves; replacement/delete produces unresolved; undo
  revalidates.
- **G-MI-SCHEMA — changed, release:** built-in identifier/geometry round-trip,
  strict role/geometry admission (Measurement accepts only
  `MeasurementGeometry`; Dimension/Label reject it and vice versa), finite
  fields, result-cache invalidation/reconstruction, migration registry fixture,
  generated TypeScript/Python `--check`, old-reader lossless preservation,
  `.hcad` and `.hcadx` format-version fixtures, and WeltView read-only
  parse/list/render/inspect for every kind/status. No strict reader may silently
  drop or writable-open an unsupported measurement.
- **G-MI-COMMAND — changed:** create/update-plane/update-anchor/rename/
  accept-warning/layer/visibility/remove transactions; Chain-off second anchor
  auto-commits, while the exact Chain-on click/type/Backspace/Finish sequence
  commits once; every valid end path yields one undo step. Compensating
  undo/redo, `.hcad` replay, `.hcadx` round-trip, and crash reconstruction of
  cached results from canonical anchors are required.
- **G-MI-PANEL — changed:** component tests for split menu and pure panel
  toggle, list virtualization at 100,000 rows, mixed actions, Fixed/Attached
  controls, drag↔typed parameter synchronization, explicit detach/pick-source,
  Enter/blur commit, Escape revert, close-mid-edit discard, hidden-by-view,
  verified/warning/unresolved copy, outlier navigation, and no measurement-style
  collision with Dimension.
- **G-MI-GESTURE — push, viewport-risk:** browser test of every §7.2 row:
  anchor clicks never alter selection; ordinary LMB/RMB drags and wheel retain
  navigation; handle-origin drag edits with binding preserved; selecting a
  measurement exposes no transform gizmo; Edit anchors suppresses select-edit
  handles; overlap hit priority belongs to MI-D6; RMB menu works; Tab focus
  split; Backspace is local; UIP-D14 resolves one rung per press; closing
  disarms all measurement hit zones.
- **G-MI-VISIBLE-PRECISION — push, `browser-gpu`:** chained workflow §2.1 in
  mixed cloud+BIM with unlocked and locked Facade west. Assert zero candidates
  from clipped/entity-hidden/layer-hidden/class-hidden sources; natural
  occlusion still eligible; an unowned coarse rendered-depth hit is labeled an
  estimate and cannot commit; inside locked exact picks equal source f64
  coordinates, not displayed/baked samples; attached-project geometry can
  anchor but not edit. Create both geometrically equal Fixed and Attached
  anchors, then move/re-sync the source: only Attached follows/revalidates.
- **G-MI-CONTINUOUS — push risk-triggered; release always,
  `browser-gpu`:** self-launching pointer/drag burst on the §4 D1 scene;
  presented-frame-interval p95 ≤ 2× target, snap query ≤ 4 ms p95,
  pointer-to-readout ≤ 150 ms p95, zero stale markers, and exact winner/source
  assertions. Samples also prove criteria 2, 6, and 7.
- **G-MI-AREA-FACADE — release, `browser-gpu` + `real-data`:** complete §2.2
  against an in-repo scanned facade; independent CPU oracle matches projected
  area/perimeter; below-threshold commits Verified projected; above-threshold
  Finish blocks on the statistics choice, Edit plane returns to editing, and
  accepted warning/statistics/tolerance/plane revision survive reload and CSV;
  later edit requires re-acceptance; largest outlier is reachable;
  self-crossing cannot commit; clip/hide toggles hide and restore the graphic
  without changing value.
- **G-MI-POINT-INFO — push:** candidate cycling makes RP and SB report the
  same entity/address/source/XYZ/precision; retained coarse hits say **Rendered
  surface estimate** and expose no Save action, exact revalidated hits say
  **Exact**; target-plane `Z —`; explicit screen/ray automation query parity;
  Save point routes through `measurement.create` only after revalidation.
- **G-MI-REPORT — push/release:** captured-id/revision stability under
  concurrent edits, unresolved excluded by default and labeled when included,
  golden-file and parse-round-trip checks for the exact §5.1 portable and
  Excel-locale profiles: Point, 10,000-anchor chain, Area plane/residual/
  warning rows, Angle, Height difference, large coordinates, unknown Z,
  unresolved last-verified rows, commas/quotes/embedded newlines, and explicit
  units. Open both profiles in a spreadsheet check. Stream 100,000 rows with
  real progress/cancel via UIP-D10/UIP-D11; cancellation leaves no target and
  atomic replacement preserves an existing report on failure.
- **G-MI-CONSUMERS — changed:** exactly-one-layer/Default/capture-at-start and
  locked-layer edit refusal; own-eye ∧ layer-eye ∧ every Attached-source
  visibility; layer draw order; FP-D4 restore publishes source+measurement in
  one generation before revalidation; VD-D3 bookmark captures only measurement
  eye; ordinary CAD export discloses exclusion; screenshot/Plan/viewer overlay
  options and defaults; `.hcadx` losslessness; WeltView parity.
- **G-MI-AUTOMATION — push via `automation.sdk`; release always:** generated
  Python sync/async and agent paths call every `measurement.*` command and
  `inspect.point_info`; schema rejects missing/ambiguous binding and non-exact
  Attached targets. A script creates equal Fixed/Attached locked-box anchors,
  renames/edits/detaches/rebinds, accepts an Area warning, reloads, generates a
  report, and checks UI/query equality plus distinct source-revalidation
  behavior. SDK staleness must pass.
- **G-MI-VISUAL — push visual-risk/release:** screenshots for all ten §8
  criteria in both themes; image diff plus reviewer checklist is blocking.

Explicitly unverified until implementation: subjective marker readability
beyond the screenshot scenes and facade residual-warning calibration on
materials outside the named real dataset. Pointcloud analysis is outside this
spec, not an unverified promise. TDX interoperability is intentionally absent
under MI-D8. None is represented as shipped.

## 10. Decision records

**MI-D1 — Measure owns seven View rows beside Clip and one File report
contribution; no Inspect tab.** **Decision:** this spec solely owns the seven
View · Measure rows and the File · Export report-contributor row in §1. View group order is
Camera / Clip / Measure / Style / Overlays / Navigation / Diagnostics. Measure
is a split catalog plus Measurements toggle; entity-relevant seeded starts also
appear in context menus. The consolidated Registry and View VD-D12 now carry
the same group placement and ownership. **Derivation:** owner decision D2 explicitly remaps Inspect
to contextual surfaces + View; the program README requires rows at
specification time and cite-and-revise rather than duplicate disposition; P4
makes Clip the closest dependency; DESIGN-SYSTEM requires visible access.
**Rejected:** retaining Inspect (owner-overridden); context-only access
(undiscoverable); Pointcloud ownership for CAD/BIM measurement (wrong domain);
pretending the current registry already agrees (unauditable). **Tunable:** exact
button packing, not owner/tab/group/order.

**MI-D2 — Measurement is a distinct persistent built-in with the complete ADR
0016 delta.** **Decision:** valid finish creates named canonical
`hcad.measurement@1`/`MeasurementGeometry` with journaled create/edit/warning/
rename/layer/visibility/remove. The strict built-in list, geometry enum,
validator/admission matrix, migration registry, project/archive schema
coverage, generated TypeScript/Python contracts, old-reader preservation,
WeltView read-only reader, exporters, snapshot/restore consumers, and
automation schemas in §7.1/§11 are one indivisible implementation tranche.
An ADR 0016 extension/superseding ADR and DATA-MODEL update must accept that
delta before implementation acceptance; this plan does not amend the accepted
ADR. **Derivation:** X1 (semantic admission cannot lie), X3/P1 (saved
measurements are canonical and agent-visible), ADR 0016 built-in/admission and
Required follow-up 3, Perspective §2.6/W5, and DR-D9's annotation boundary.
**Rejected:** transient overlay (violates P1/reference);
`hcad.dimension@1` reuse (construction placement/style and no Point/Area
semantics); `hcad.label@1` reuse (text/leader rather than auditable result);
shipping only a schema name without readers/migration (data loss). **Tunable:**
automatic names only.

**MI-D3 — Fixed and Attached are explicit, symmetric anchor bindings.**
**Decision:** every anchor payload and UI row declares Fixed or Attached.
Typed XYZ/relative construction produces Fixed and never guesses a source;
exact source pick produces Attached. A snapped/dragged Attached edit remains
Attached and exposes typeable source parameter/offset; absolute XYZ requires
**Detach to fixed coordinate**. Changing an Attached referent requires **Pick
source**. A Fixed handle remains Fixed. The same rule applies to creation,
editing, UI, agent, and SDK. Attached targets revalidate/follow valid placement;
stale replacement/delete becomes visibly unresolved with last-verified
history. **Derivation:** X1 (dependency semantics are data integrity), X5
(click/type and create/edit symmetry), C1/C4, ADR 0019 CAS authority, and the
no-invented-domain-truth principle. **Rejected:** "same anchor" while silently
storing clicks associative and typing fixed (review blocker); guessing an
entity from typed coordinates; all-fixed picks (lose intended association);
cascade delete (data loss). **Tunable:** no.

**MI-D4 — Facade area is explicit projected area with auditable warning
acceptance.** **Decision:** Plan XY, validated planar face, or a plane
defined/typed by three points is mandatory; exact 3D anchors project only for
the labeled calculation. At/below tolerance status is Verified projected.
Above tolerance, Finish blocks on Edit plane versus Save projected result with
warning; acceptance, max/RMS/count/percentage/tolerance and plane revision are
canonical and re-evaluated after edits. Simple one-loop area ships first;
holes/surface integration remain geometry/quantity work. **Derivation:** X1 and
AGENTS "never invent coordinates/heights"; Perspective Map-only area
(`trimble-perspective.md` §2.6) bounds the extension; X5 gives plane pick/type
parity; X6 delegates the threshold. **Rejected:** camera plane; unstated cloud
triangulation; silent best-fit; refusing every above-threshold projection
(projection remains mathematically valid); normal commit with only Max offset
(hides distributed warp/outliers). **Tunable:** residual threshold only.

**MI-D5 — Shared picking requires explicit exactness before Measurement
commit.** **Decision:** Measure reuses DR-D12 markers/ranking/candidate cycle
and P4 filtering, but the kernel contract gains provider/source identity and
`coarse|exact`; retained rendered-depth hits remain coarse and are labeled
estimates. Only an exact provider target that passes canonical core
revalidation may create/rebind an Attached anchor. Locked-box exactness follows
VB-D13/DR-D15. **Derivation:** X1, X7, P4, DR-D12, VB-D13/DR-D15, and code
evidence in §7.1 showing the current flag/source gap and retained coarse hits.
**Rejected:** treating every f64 reconstructed coordinate as exact; GPU-depth
commit; clip-unaware picking; a separate measurement snap engine; global
re-ranking that contradicts DR-D12. **Tunable:** shared snap radius and
one-shot override binding, owned by DR-D12/registry.

**MI-D6 — Measurements are non-transformable; armed editing exclusively owns
their handles.** **Decision:** `hcad.measurement@1` has no entity placement and
no move/rotate/scale/mirror verbs or whole-entity gizmo. Selection shows
properties/highlight. Edit anchors/Edit plane arms the one measurement tool,
suppresses select-edit handles, gives handle-origin drag exclusively to §7.2,
and removes every hit zone on exit/close. **Derivation:** X1 (moving a report
independently of Fixed/source truth falsifies it), ui-platform §3.6 one-tool
rule, SE-D1 capability profiles, DR-D14, Perspective drag editing, and
SYSTEM-001 consumer arbitration. **Rejected:** generic transform participation;
both gizmos active; always-live handles; capturing off-handle navigation.
**Tunable:** shared UIP-D1 click/drag threshold.

**MI-D7 — Values are derived; numeric parity edits inputs.** **Decision:**
result numbers are read-only; every binding-appropriate anchor/plane
manipulation has a typed twin and live synchronization. **Derivation:** X1
priority over literal C1; DR-D9 class; RIB F5-Box (`rib-civil.md` §2.2); X5;
MI-D3. **Rejected:** editable result override (false claim); mouse-only inputs;
typing Attached resolved XYZ without explicit detach. **Tunable:** displayed
precision from project settings, never stored f64 truth.

**MI-D8 — Versioned CSV is the open report; opaque TDX writing fails closed.**
**Decision:** `.hcadx` is lossless sharing; `measurement.report.generate`
contributes explicit selected/all scope and the exact §5.1 portable/Excel-
locale long-table profiles to File export, captures revisions, streams, and
registers when long. No TDX writer ships without a documented format or
dependency-policy-compatible encoder and a fidelity corpus; this is decided
here while §6 requests IF-D10's class generalization. **Derivation:** D2;
FP-D5 plan/disclosure; Perspective export evidence
(`trimble-perspective.md` §2.6); RealWorks CSV/report evidence
(`realworks.md` §2.9); X1; UIP-D10/UIP-D11; DEPENDENCY-POLICY. **Rejected:**
unspecified "UTF-8 CSV"; locale-dependent default; implicit current-view
export; renderer copy; report locking edits; guessed proprietary writer.
**Tunable:** job threshold and future documented open profiles; the TDX safety
gate is not tunable.

**MI-D9 — Measure does not catalog Pointcloud analysis.** **Decision:** this
spec assigns no Pointcloud inspection IDs, surfaces, commands, or dispositions.
PC-D10 retains that class; §6 requests dossier-backed Twin Surface/cloud-to-
cloud and wall-verticality rows from its owner and rejects inventing a
standalone point-density row from low-density error messaging. **Derivation:**
program README cite-and-revise rule; PC-D10; RealWorks §2.7/W8; X4 evidence
boundary. **Rejected:** the former foreign hand-off table (a second catalog);
standalone density without dossier evidence; duplicate `inspect.*` ownership.
**Tunable:** no.

**MI-D10 — Continuous and report gates are calibrated here.** **Decision:**
§4 D1/G-MI-CONTINUOUS and 100,000-row report/panel extremes are blocking;
only decorative quality/frequency degrades. **Derivation:** X2, X6/P3,
contract D1, VB-D7 interval metric, draw DR-D1 snap-query gate, UIP selection
latency precedent. **Rejected:** "smooth" manual claim; average FPS;
small-scene-only tests. **Tunable:** 2×/4 ms/150 ms and row-count thresholds.

**MI-D11 — Measurement lifecycle participates in layers, restore, bookmarks,
exports, and sibling readers explicitly.** **Decision:** §7.1's consumer
matrix is normative: exactly one captured layer; conjunctive eye/layer/source
visibility; locked-layer edit refusal; FP-D4 full-generation restore and
revalidation; VD-D3 visibility-only bookmarks; lossless `.hcadx`; explicit
writer/overlay options; same-tranche WeltView read-only support. **Derivation:**
X1/X3, DR-D4, FP-D4, VD-D3/VD-D4, FP-D5, ADR 0016 strict readers, and contract
E2 passive-consumer rule. **Rejected:** treating an overlay as layerless;
revalidating against half-restored state; bookmark capture of geometry/value;
silent export inclusion/exclusion; strict-reader disappearance. **Tunable:**
screenshot/Plan/viewer option defaults only after usability evidence; the v1
defaults stated in §7.1 apply until revised.

**MI-D12 — Area math uses a local plane frame and stable accumulation.**
**Decision:** §7.3 subtraction-before-projection, right-handed orthonormal
basis, compensated/pairwise accumulation, winding normalization, and
scale-aware tolerances govern every planar area. The actual tolerances are
recorded per result. **Derivation:** X1 (national-grid coordinates must not
erase small facade area through cancellation), X6/P3 (calibration), and
contract E2 extreme-member rule. **Rejected:** world-coordinate shoelace;
naive summation; one absolute epsilon for every project scale; accepting
near-degenerate polygons as plausible area. **Tunable:** epsilon multipliers
and explicit project tolerances, with recorded replay stability.

**MI-D13 — Angle ships as smaller unsigned Spatial angle only.** **Decision:**
retain Angle as a deliberate extension from the existing Builder placeholder,
not as reference adoption. Compute 0–180°/0–200 gon Spatial angle for two 3D
rays with `atan2(|cross|, dot)`; non-coplanar rays are valid, unknown Z and
zero-length rays reject. Horizontal, signed, and reflex modes are deferred
until an explicit projection/orientation workflow is specified. **Derivation:**
the dossier-wide absence in §3; current ribbon placeholder as product intent;
X1 (mode must be named, no implicit projection); project angle settings; X4
permits a stated extension. **Rejected:** claiming Perspective/RealWorks
behavior; unnamed angle; implicit XY projection; signed/reflex without an
orientation normal. **Tunable:** display precision only.

## 11. Current implementation delta

**Exists and stays as substrate, not measurement truth:** the Rust GPU
neighborhood and provider-refinement boundary (`picking.rs:253-298`),
deterministic ranking (`picking.rs:397-411,492-500`), cursor candidate cycling
and coordinate callbacks (`KernelNavigationController.ts:483-540`), Builder XYZ
and snap-kind display (`BuilderKernelViewport.tsx:836-845`,
`App.tsx:698-700`), the exact raster/panorama depth-distance helper
(`himmelcad-wasm/src/lib.rs:3428-3549`), and Dimension math/anchors as a
non-reused sibling (`entity_model.rs:1004-1070`). The existing cursor candidate
is not accepted as exact: Rust retains unowned rendered-depth hits, its struct
has no exact/provider discriminant, the TypeScript comment overclaims exactness,
and Builder hard-codes source classification (§7.1).

**Changes to existing surfaces/contracts:**

- delete Inspect and add View · Measure per MI-D1 after registry/View-owner
  reconciliation; extend the shared Draw input bar/marker with explicit
  Fixed/Attached controls;
- extend Rust→generated TypeScript pick candidates with precision
  (`coarse|exact`), provider id, source kind, and stable source identity; never
  promote retained coarse hits; apply P4 before publication; add canonical core
  target revalidation; fix the TypeScript "Exact" comment and Builder's
  hard-coded `point-cloud` source;
- extend layers/entity tree/Properties with the non-transformable capability
  profile and overlay ordering; select-edit consumes the exclusion rather than
  manufacturing a second handle system;
- extend File's exporter registry with the §5.1 report writer and the §7.1
  overlay/exclusion matrix.

**New ADR-0016-governed built-in delta (one implementation gate):**

1. Before code acceptance, land an accepted ADR 0016 extension/superseding ADR
   and explanatory DATA-MODEL update for `hcad.measurement@1`; this spec defines
   obligations but does not edit ADR history.
2. Add the built-in identifier/enum, `MeasurementGeometry`, kind/metric,
   discriminated anchors, plane, verification, and reconstructible result-cache
   types from §7.1. Forbid entity placement and invalid kind/metric/known-Z
   combinations.
3. Extend geometry validation and the strict semantic-admission matrix:
   canonical Measurement role ↔ `MeasurementGeometry` only; Dimension/Label
   and their geometry remain mutually incompatible. Validate finite values,
   exact Attached targets, plane orthonormality/right-handedness, residual
   statistics, warning-state invariants, and cache input hashes.
4. Register the built-in and geometry schema in the project-format migration
   registry and `.hcad`/`.hcadx` coverage. New readers preserve unknown fields;
   an older/unsupported reader preserves the raw entity and exposes a read-only
   unsupported placeholder or refuses writable open—never drop/down-save. Add
   schema-version fixtures and archive round trips.
5. Regenerate TypeScript canonical types and Python sync/async SDK contracts.
   The public automation schema contains binding-discriminated create/edit,
   detach/pick-source, plane, warning acceptance, layer/visibility, report, and
   point-info commands/queries; ambiguous binding and non-exact Attached
   payloads fail before command execution.
6. Add journaled command handlers, exact anchor resolver, local-plane math,
   cache invalidation/rebuild, renderer overlays/handles, all five creators,
   Measurements/Point info panels, and §5.1 streaming writer.
7. Upgrade strict sibling readers in the same tranche: WeltView provides
   read-only parse/preserve/list/render/inspect, layer/eye, warning, and
   unresolved behavior. Other readers either consume the generated contract or
   use the explicit unsupported-read-only path; exporters cannot silently omit
   the entity.
8. Wire FP-D4 snapshot/restore scope exactly: measurement and restored source
   revisions publish in one generation, then anchors revalidate; only snapshot
   entities remain exempt. Wire VD-D3/VD-D4 bookmark visibility-only behavior.
9. Implement exporter behavior per §7.1: lossless project/archive, explicit
   measurement CSV, declared-support-only CAD/model writers with loss plan, and
   screenshot/Plan/viewer overlay options.
10. Land every G-MI-\* gate, including migration/admission/generated-schema,
    strict-reader, restore/bookmark/export, coarse-hit refusal, binding parity,
    report golden files, and large-coordinate math.

The current Inspect Distance/Angle buttons are not implementation; they are
unhandled placeholders (`ribbon.ts:129-141`, `App.tsx:450`).

## 12. Owner-decision items and escalation dissolution

None. Consequential candidates were tested against every escalation condition:

- **“Persistent or transient?”** does not survive P1/X3 and Perspective §2.6;
  MI-D2 decides canonical state.
- **“Where in the ribbon?”** is already bounded by owner decision D2; P4 and
  DESIGN-SYSTEM derive View · Measure beside Clip (MI-D1); the contradictory
  registry/View prose is a cite-and-revise task, not a choice.
- **“May a new built-in ship without an ADR/migration/readers?”** does not
  survive X1 or ADR 0016's strict admission and follow-up 3; MI-D2 makes the
  whole delta one gate and §6 records the governing-document request.
- **“Does typed mean fixed or associative?”** dissolves under X1/X5: the
  binding must be explicit and symmetric, never inferred (MI-D3).
- **“How is facade area defined?”** is a correctness question settled by X1
  and the no-invented-truth rule; explicit plane projection is the only option
  that labels the computation honestly, while X6 delegates its warning
  threshold (MI-D4/MI-D12).
- **“Can a measurement use the generic transform gizmo?”** is closed by X1
  and the one-tool rule: independent placement would falsify the claim
  (MI-D6).
- **“What report/TDX contract ships?”** is closed by X1, dependency policy,
  and the available open CSV evidence: version the open writer and fail closed
  on an undocumented proprietary codec (MI-D8).
- **“What does Angle mean?”** is not an owner call: dossier absence plus X1
  require an explicit stated extension and mode; current product intent bounds
  v1 to smaller unsigned Spatial (MI-D13).
- **“Who owns cloud comparison/density?”** is closed by the README's
  cite-and-revise rule and PC-D10; Measure removes its foreign rows and sends
  the evidenced catalog correction to Pointcloud (MI-D9).

No axiom conflict, reserved scope boundary, product-identity choice, money, or licensing issue remains; the zero-owner-question target is met.

## 13. Disposition — spec review 2026-09-02

All 14 findings are resolved; none is deferred. Where the finding assigns an
edit to another owner, §6 records the exact request and this spec adopts the
resolved side without editing that file.

| Finding id  | Disposition                                                                                                                                                                                                                                                                                       | Spec section / decision id                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1 (blocker) | Resolved reciprocally: sole Measure ownership, seven View rows plus one File report contribution, and fixed View placement are normative here and match VD-D12 plus the consolidated Registry.                                                                                                    | §1, §6; MI-D1; VD-D12; REGISTRY                     |
| 2 (blocker) | Resolved: distinct built-in retained with explicit geometry, admission, validation, migration, generated contracts, old-reader preservation, `.hcad/.hcadx`, WeltView, exporter, restore, and automation obligations. Accepted ADR/DATA-MODEL update is an implementation gate, not written here. | §4 C4, §7.1, §9 G-MI-SCHEMA, §11; MI-D2             |
| 3 (blocker) | Resolved: Fixed versus Attached is explicit in UI/schema/automation; typed coordinates never infer a source, snapped edits stay Attached, and detach/rebind are named symmetric actions with distinct revalidation tests.                                                                         | §2.1, §4 C1, §7.1–7.2, §9; MI-D3                    |
| 4 (major)   | Resolved: Chain-off auto-commit and Chain-on pending/finish/cancel/Backspace lifecycle are unambiguous and tested as one journaled commit.                                                                                                                                                        | §2.1, §4 B2, §7.2, G-MI-COMMAND                     |
| 5 (major)   | Resolved: layers, draw order, snapshot restore, bookmarks, export classes/options, WeltView, strict readers, and source/eye visibility are explicit consumers with gates.                                                                                                                         | §4 C2/C4, §7.1, G-MI-CONSUMERS; MI-D11              |
| 6 (major)   | Resolved reciprocally: Measurement is non-transformable; Select/Edit excludes generic transform verbs/gizmo, and armed anchor/plane edit exclusively owns handle hits.                                                                                                                            | §2.1, §4 C2, §7.1–7.2, §6; MI-D6; SE-D14            |
| 7 (major)   | Resolved: status and delta now call the current path partial substrate; explicit coarse/exact and provider/source data are required, retained coarse hits cannot commit, and a refusal gate is named.                                                                                             | §1 row, §7.1, G-MI-VISIBLE-PRECISION, §11; MI-D5    |
| 8 (major)   | Resolved: above-threshold Area blocks on Edit plane versus warning acceptance; max/RMS/count/percentage, tolerance, plane revision, outlier, and acceptance persist/recompute/report.                                                                                                             | §2.2, §7.1, §8 criterion 8, G-MI-AREA-FACADE; MI-D4 |
| 9 (major)   | Resolved reciprocally by the canonical Dimension/Measurement boundary; Draw DR-D9 now names Measurement as a persistent inspection entity.                                                                                                                                                        | §1, §4 A3, §6; MI-D2; DR-D9                         |
| 10 (major)  | Resolved: all foreign Pointcloud IDs/catalog/workflow contract removed. Pointcloud requests add only dossier-backed Twin Surface/cloud-to-cloud and wall verticality; standalone density is rejected for absent evidence.                                                                         | §1 boundary, §3, §6; MI-D9                          |
| 11 (major)  | Resolved: TDX rejection is this spec's X1/dependency-policy decision and IF-D10 now consumes it through the shared reader/writer codec gate.                                                                                                                                                      | §3, §5 A2, §6; MI-D8; IF-D10                        |
| 12 (major)  | Resolved: exact versioned portable and Excel-locale CSV syntax, header, rows, units, nulls, provenance, plane/residual/warning fields, ordering, and golden/spreadsheet tests are normative.                                                                                                      | §5.1, G-MI-REPORT; MI-D8                            |
| 13 (major)  | Resolved: explicit local orthonormal frame, subtraction before projection, stable accumulation, winding, scale-aware tolerances, degenerate rules, and translated/extreme tests.                                                                                                                  | §7.3, G-MI-UNIT-MATH; MI-D12                        |
| 14 (minor)  | Resolved: dossier-wide absence stated; Angle is a deliberate existing-placeholder extension, Spatial-only v1 with explicit smaller/unsigned/unit/unknown-Z/non-coplanar behavior and tests.                                                                                                       | §2.3, §3, G-MI-UNIT-MATH; MI-D13                    |

## Cross-spec reconciliation 2026-09-02

| Item                    | Disposition                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ribbon                  | View VD-D12 inserts Measure between Clip and Style and cites MI-D1; this row is the reciprocal citation.                                                                                                 |
| Draw/Select             | Draw cites MI-D2; Select/Edit excludes Measurement from generic transforms and routes to MI-D6 anchors/plane.                                                                                            |
| Pointcloud              | PC-D10 now owns/catalogs surface-to-model, cloud-to-cloud, floor-flatness, and wall-verticality; no density row.                                                                                         |
| Import/File             | IF-D10 adopts MI-D8's writer gate; File registers MI-D8 report contribution and MI-D11 restore/reachability consumers.                                                                                   |
| Data model              | `hcad.measurement@1` admission remains an architect-owned normative proposal in REGISTRY §4; implementation is blocked, not the specification.                                                           |
| Civil point information | CIV-D16/CIV-D24 contribute an optional branch-explicit station/offset member to the existing `inspect.point_info` result; Measure retains the sole act.                                                  |
| Semantic cursor         | Measure/Inspect cites UIP-D24/§9.7 and declares pick/snap/Fangkreis, anchor/plane handle, prohibited, and wait; passive point info never arms a cursor mode.                                             |
| GAP §6 Civil inbound    | MI-D2/MI-D8 are amended by MI-D14 citations to CIV-D2–CIV-D12/CIV-D16/CIV-D24 for Civil/solid inputs and optional point information without quantity ownership.                                          |
| Re-walk 2026-09-02      | P5: gestures journal once. P6: Escape/Undo/right-click finish remain. P7 fix: portable CSV is an interchange schema; human report layout/units/branding are editable named profiles with a shipped seed. |

## Owner statements batch 2 — 2026-09-02

This section amends MI-D2/MI-D8 and bottom-bar references. The persistent C1 Draw
construction bar and UIP-D19 global strip are separate rows/surfaces; Measure tools
may mirror numeric results but never hide or replace global controls. Measurement
consumes MT-D27 solids, RA-D14 difference Grids, and Civil alignment/profile/corridor
entities as inspectable inputs. Planar Area remains planar area, MT-D8 remains the
auditable surface-volume report, a solid remains geometry, and a difference Grid
remains Raster data; none is relabeled as another.

**MI-D14 — Measurement consumes batch-2 products without taking ownership.**
**Decision:** input/result layout and type distinctions are as above; queries expose
source revisions/stale state and route regeneration to the owning domain.
**Derivation:** P8, P10, S3/S11, X1, UIP-D19, MT-D8/MT-D27, RA-D14, Civil
CIV-D2–D12. **Rejected:** using bottom-bar space as a Measure-only readout; calling
planar Area or a report equivalent to a solid/difference product. **Tunable:**
compact overflow only.

`inspect.point_info` optionally appends Civil station/offset only when a nearby
alignment can be resolved under CIV-D16/CIV-D24. The result names the alignment
id/revision, station-equation branch, station, signed offset, and typed
unavailable/ambiguous reason. Measure remains the one query/result owner; Civil
contributes `alignment.station_offset.describe` and never creates a second
inspection act.

Cursor declaration: pick crosshair, snap-kind marker/Fangkreis, prohibited, and
bounded-work wait from UIP-D22. Tests cover strip coexistence at minimum width,
typed result/provenance inspection for every new product, stale routing, and type-
safe refusal of mismatched measurement commands.

| Work-order item                             | Disposition                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 construction/global-strip reconciliation | Applied by MI-D14.                                                                                                                                       |
| S11 solid/difference/Civil consumption      | Applied by MI-D14 without quantity ownership.                                                                                                            |
| S13/G11 cursor declaration                  | Applied as a UIP-D24/§9.7 consumer.                                                                                                                      |
| Civil point information                     | CIV-D16/CIV-D24 contribute an optional, branch-explicit station/offset member to the existing `inspect.point_info` result; Measure retains the sole act. |
