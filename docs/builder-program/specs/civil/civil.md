# Civil — workflow-level specification

Status: specified by the 2026-09-02 round-3 registry rebuild. Document class: plan; it is not evidence
that a function exists. Domain: horizontal alignments, vertical alignments, profiles, corridor
representations, embankments/slopes, pit surfaces, and stationing.

This document walks the current `docs/FUNCTION-CONTRACT.md` A1–E3 and the current `docs/DECISION-DOCTRINE.md`
X1–X7/P1–P11. It un-defers the Civil subsystem from Draw DR-D8 under owner decision D7. Its rows and shared
access contributions are registered once in `REGISTRY.md`, satisfying the program README gate.

Primary evidence is `dossiers/rib-civil.md` §2.1–§2.8 and W3–W6. Best-fit feasibility is cited only after the
2026-09-02 sourced additions in `dossiers/rib-civil.md` §2.4 “Best-fit alignment evidence.” Field/catalog
behavior cites `dossiers/field-codes.md` §3.2 and §7.2. Owner workflows cite `OWNER-STATEMENTS-2026-09-02.md`
S7–S11. The E1 reference is the failable criteria in §7 of this in-repository file; no third-party screenshot
is used.

## 0. Authority, ownership, and non-duplication boundary

- `hcad.alignment@1` is the canonical Civil entity. It already contains horizontal geometry, vertical
  segments, station origin, width bands, crossfall bands, and alignment slope rules
  (`crates/himmelcad-core/src/entity_model.rs:871-959`; ADR 0016 “Alignments and views”). Horizontal best-fit
  publishes a true line/arc/clothoid `CurveGeometry::Composite`, never a spline stand-in.
- Draw owns line/arc/clothoid authoring, DR-D6 multi-solution cycling, DR-D12 snap precedence, and the
  specified-but-not-yet-callable `draw.alignment` create-from-curve act. Civil consumes DR-D19/DR-D20 and
  un-defers DR-D8's
  checking, optimization, bands, gradients, profiles, named-axis selection, helper points, and station/offset
  points. It does not re-specify curve construction.
- View VD-D1/VD-D15 owns rigid section views. A line-picked section with direction, optional depth, arrowed
  plan specification, and rotated view is that workflow, not a Civil function. Civil owns
  alignment-based long and cross profiles because their coordinate mapping is station/offset, not a rigid
  transform (owner evidence S8; P10).
- Mesh/Terrain MT-D1–MT-D5/MT-D25/MT-D26 owns the surface-creation window, draft/error/fix lifecycle,
  surface-side dependency recipe, and canonical ElevationSurface publication. Corridor and pit products enter
  that workflow as captured, provenance-bearing
  Civil input records. Civil never publishes a second surface-creation command.
- Pointcloud owns cloud sampling and immutable sampled-cloud products (PC-D8/PC-D18). Civil consumes its
  station-corridor result; it never reads an unbounded cloud into the UI thread or mutates
  source points.
- Select/Edit owns whole-entity transforms and the shared gizmo (SE-D1/SE-D3); SE-D20 emits Civil's typed
  invalidation set at gesture end. Civil grips edit alignment
  parameters; moving the complete alignment uses `entity.transform.*` and invalidates world-space dependants.
- Solids and rasters between surfaces remain Mesh/Terrain and Raster concerns under owner evidence S11. Civil
  supplies alignment/slope surfaces as inputs but does not re-disposition those capabilities.
- The full first-party Builder UI, automation schema, SDK, and command hosts were searched dossier-wide for
  `alignment.*`, `civil.*`, `corridor.*`, and `station.*`; no callable Civil command or Builder surface
  exists. Viewer test hooks are not product access paths and do not count as existence.

## 1. Registry-compatible function catalog

Access key: R ribbon, X entity context menu, Q viewport quick surface, C console, A automation (agent and
Python), K shortcut, P Properties. Performance: cont continuous, bnd bounded under one second, long registered
job with progress/cancel/restart policy. “Shared accelerator” means the row does not claim a second canonical
act.

Negative-status baseline for every row: the complete current Builder ribbon has no Civil action
(`apps/builder/renderer/src/ribbon.ts:35-156`), the only specialized canonical entity-command module
implements placement commands (`crates/himmelcad-core/src/entity_commands.rs:18-91`), and the complete public
automation method catalog has no Civil leaf (`schemas/automation/himmelcad-automation-v1.schema.json:77-146`).
These scoped, line-cited absence checks are part of every “new,” “no command/UI,” and “no Builder host” status
below.

| Id                                               | Tab · group                       | Access paths                                   | Surface                                    | Perf                     | Canonical automation                                                                                       | Status versus current implementation                                                                                                                                                       |
| ------------------------------------------------ | --------------------------------- | ---------------------------------------------- | ------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `civil.alignment.fit`                            | Draw · Alignment                  | R X on 1–2 curves/multi-points C A             | right function panel + viewport preview    | cont + long              | `alignment.fit.session.*`, `alignment.fit.candidate.*`, `alignment.fit.draft.*`                            | new; current alignment geometry can store only the accepted geometric result (`entity_model.rs:946-959`); fit report/recipe/engine/command/UI are absent                                   |
| `draw.alignment` (shared)                        | Draw · Alignment                  | R X on curve C A                               | viewport tool + small setup island         | cont + bnd               | `alignment.create_from_curve`                                                                              | owner: draw; adopted unchanged from DR-D8; storage/import only (`entity_model.rs:946-959`, `landxml.rs:603-652`); no callable command per negative baseline; do not duplicate registry act |
| `civil.alignment.edit`                           | Draw · Alignment                  | R X double-click C A P                         | right panel + grips + element table        | cont + bnd               | `alignment.update`, `alignment.check`, `alignment.list`                                                    | new; validation only at `entity_validation.rs:931-986`                                                                                                                                     |
| `civil.alignment.station-origin`                 | Draw · Alignment                  | X C A P                                        | inline field                               | bnd                      | `alignment.set_station_origin`                                                                             | planned by Draw, not implemented; field exists at `entity_model.rs:951-952`                                                                                                                |
| `civil.vertical.fit`                             | Draw · Profile                    | R X on alignment C A                           | Civil profile workspace                    | cont + long              | `alignment.vertical.fit.session.*`, `alignment.vertical.fit.candidate.*`, `alignment.vertical.fit.draft.*` | new; imported grade/parabola storage exists at `landxml.rs:665-779`; no solver/UI                                                                                                          |
| `civil.vertical.edit`                            | Draw · Profile                    | R X double-click C A P                         | Civil profile workspace + table            | cont + bnd               | `alignment.vertical.update`                                                                                | new; grade/parabola model exists at `entity_model.rs:879-895`; circular rounding is absent                                                                                                 |
| `civil.bands.edit`                               | Draw · Alignment                  | R X C A P                                      | right panel + band table/profile strip     | cont + bnd               | `alignment.band.add`, `alignment.band.update`, `alignment.band.remove`, `alignment.edge.promote`           | new; width/crossfall structs exist at `entity_model.rs:897-923`; no commands/UI                                                                                                            |
| `civil.profile.long`                             | Draw · Profile                    | R X on alignment C A                           | central Civil profile workspace + RP       | cont + long refresh      | `profile.long.open`, `profile.long.state`                                                                  | new UI; local orthographic frame exists at `KernelNavigationController.ts:214-240`                                                                                                         |
| `civil.profile.cross`                            | Draw · Profile                    | R X on alignment/corridor C A                  | Civil profile workspace + station list     | cont + long refresh      | `profile.cross.open`, `profile.cross.set_stations`, `profile.cross.state`                                  | new; LandXML import reads cross-section samples at `landxml.rs:829-930`, no Builder workflow                                                                                               |
| `civil.profile.sync`                             | Draw · Profile                    | workspace button C A                           | review island within workspace             | bnd→long                 | `profile.conflict.describe`, `profile.rebase_preview/commit`, `profile.draft.discard/stay`                 | new; no command/UI per line-cited negative baseline                                                                                                                                        |
| `civil.corridor.preview`                         | Draw · Corridor                   | R X on alignment C A                           | viewport derived representation + RP       | cont                     | `alignment.corridor.preview`, `alignment.corridor.freeze`, `alignment.corridor.unfreeze`                   | kernel partial: partitioned preview at `alignment_preview.rs:38-58,175-210`; viewer bridge at `WgpuKernelViewer.ts:2893-2921`; no Builder host                                             |
| `mesh.create-surface` (shared Civil access)      | Draw · Corridor and Mesh · Create | R X C A                                        | hand-off to Mesh surface window            | long                     | `mesh.surface.draft.create`, then `mesh.surface.check/create`                                              | owner: mesh-terrain; CIV-D5 access path; access contribution to the one Mesh act; typed Civil manifests follow MT-D25/MT-D26 and never define a Civil publication act                      |
| `civil.slope.create`                             | Draw · Slopes                     | R X on area/surface/corridor edge/BIM face C A | right panel + transparent viewport preview | cont + long intersection | `civil.slope.create`                                                                                       | new generic workflow; alignment-only `SlopeRule` exists at `entity_model.rs:925-940`                                                                                                       |
| `civil.slope.edit`                               | Draw · Slopes                     | X double-click C A P                           | right panel + boundary/extent grips        | cont + long refresh      | `civil.slope.update`, `civil.slope.sync`                                                                   | new; no generic derivation component/command/UI per line-cited negative baseline                                                                                                           |
| `civil.pit.build-draft`                          | Draw · Slopes and Mesh · Create   | R X on slopes/base surfaces C A                | progress/review → Mesh surface window      | long                     | `civil.pit.describe`, `civil.pit.build_draft`; publication remains `mesh.surface.create`                   | new Civil lower-envelope act; no solver/command/UI; final surface publication is still the shared Mesh act                                                                                 |
| `civil.station.labels`                           | Draw · Annotation                 | R X on alignment C A P                         | right panel + viewport labels              | cont                     | `alignment.labeling.get`, `alignment.labeling.set`                                                         | new; station origin exists at `entity_model.rs:951-952`; label surface absent per negative baseline                                                                                        |
| `civil.station.equations`                        | Draw · Alignment                  | R X on alignment C A P                         | stationing table + canvas markers          | bnd                      | `alignment.stationing.*`, `alignment.station_equation.*`                                                   | new; current schema has only scalar `station_origin` (`entity_model.rs:951-952`)                                                                                                           |
| `draw.point` (shared station/offset mode)        | Draw · Point                      | R Q “Point by station/offset” C A              | Draw construction input bar + RP           | cont                     | `draw.point.create` with `station_reference`                                                               | owner: draw; Civil access/mode contribution to DR-D19; typed station relation/adapter/UI are absent, and no second point act is registered                                                 |
| `civil.axis.layer-policy`                        | Draw · Alignment and Settings     | automatic + P C A                              | Properties + project settings row          | bnd                      | `alignment.layer_policy.get`, `alignment.layer_policy.set`                                                 | new mechanism; no current surface/command per negative baseline; existing layer template is only specified in DR-D8                                                                        |
| `civil.standards`                                | Draw · Alignment and Settings     | R C A P                                        | standards library window + preview         | bnd                      | `civil.standard.list/get/create/update/import/export/bind`                                                 | new; no versioned Civil office-standard schema, command, serializer, or UI exists                                                                                                          |
| `derived.recipe-manage` (shared Civil access)    | Draw · contextual                 | X on linked/stale derivative C A P             | Properties state/actions + jobs            | bnd→long                 | `derived.recipe.get/list/status/regenerate/regenerate_batch/detach/relink`                                 | owner: mesh-terrain; CIV-D15 access path; access contribution to MT-D25's one common lifecycle; Civil supplies typed payload/output rules and never creates a second recipe act            |
| `inspect.point_info` (shared Civil contribution) | View · Measure + status bar       | existing shared R X C A paths                  | existing RP + status bar                   | cont                     | `inspect.point_info` + `alignment.station_offset.describe`                                                 | owner: measure-inspect; CIV-D24 access path; contribution only; Measure/Inspect owning schema currently has no Civil station/offset member                                                 |

No global shortcut is claimed. F4 remains assigned to Viewing box in `REGISTRY.md` §2.1. Named axes/profiles
are reachable through the Civil panel's filterable object picker and automation list queries; this is a
deliberate non-collision, not silent removal of RIB's F4 concept (`rib-civil.md` §2.2).

### 1.1 Exact command and query shape

All writes carry command id, actor, expected entity revision/version, project units/CRS identity, and explicit
source refs. Fit commands additionally carry the ordered sample refs or bulk-data lease, constraints,
weighting, algorithm version, and requested output layer. Query results are paginated and bounded.

`alignment.fit` inputs are: one ordered path, two ordered edge paths, or an ordered picked-point set; optional
fixed start/end position and tangent; minimum radius; lower/upper clothoid A; maximum orthogonal residual;
element count penalty; maximum elements; and side/orientation confirmation. It returns either a preview
candidate set plus residual report or a typed infeasibility report. It never weakens a constraint without a
new user command.

`alignment.vertical.fit` inputs are an alignment range, an immutable sampled terrain/cloud trace or
picked/drawn profile constraints, fixed ends, grade and rounding bounds, allowed rounding kinds, residual
tolerance, and element-count penalty. Output is an unpublished candidate plus station/elevation residuals.

`civil.pit.build_draft` returns a Mesh draft id, not a surface id. The draft manifest contains exact source
ids/revisions/placements, slope derivation versions, solve boundary, tolerance policy, intersections,
excluded/gap regions, diagnostics, and the immutable candidate mesh hash.

## 2. Full user-perspective workflow narratives

### 2.1 Horizontal alignment — best fit, classic construction, and table parity

The user has an as-built road in a point cloud and two surveyed polylines along the pavement edges. They
select both and press **Best-fit alignment**. The panel names both inputs, shows their direction arrows, and
asks which end is the start. Reversing either input changes only the preview order until commit. With one
edge, the proposed axis follows that path; with two, the preview lies between them and the residual report
lists each edge separately. With no curves preselected, **Pick points** arms the viewport and accepts an
ordered point string using Draw's snapping and candidate cycling.

The user types minimum radius, clothoid A minimum/maximum, fit tolerance, maximum elements, and the
element-count penalty. Each value has project units and office precision. The solver first reports **Preparing
samples**, then candidate progress. The viewport draws the best candidate as directed analytic elements:
lines, circular arcs, and clothoids have distinct tokenized segment markers; transition points and constraint
violations are visible. A residual strip shows maximum, RMS, and 95th-percentile deviation for each source,
plus the objective contribution from element count. **Previous solution** and **Next solution**, mirrored by
↑/↓ while the candidate indicator is live, cycle valid local alternatives under Draw DR-D1/DR-D6.
Every committed constraint edit advances the fit session generation; an older candidate remains visibly stale
and cannot be selected or accepted. Acceptance performs the complete generation/source/constraint/solver CAS
defined by CIV-D18.

If no candidate satisfies every hard constraint, the panel says **No feasible alignment** and names the
conflicting ranges and nearest residual; it offers editable constraints, never **Accept anyway**. Cancellation
leaves source polylines and project state unchanged. A crash preserves the source capture and completed fit
checkpoints but publishes no alignment.

On **Create alignment**, the chosen true tuple becomes one named `hcad.alignment@1` entity. The command
records samples, weights, constraints, fit report, solver version, candidate identity, and the Civil
dependency recipe in §11.1. Its default layer
is resolved through DR-D8's editable office template (shipped seed `Achse <name>`); the resolved layer is
displayed before commit. The source edges remain ordinary authoritative curves. Ctrl+Z removes the alignment
in one step and never removes the edges.

For a designed road or a surveyor who distrusts fitting, the parity path is **Create alignment from curve**.
The user constructs the exact W3 line/arc/clothoid sequence with Draw's couple/pivot/buffer tools and DR-D6
solution cycling, selects it, names the alignment, chooses direction/start station, and commits through the
specified shared `draw.alignment` act; its callable command is absent today. Double-clicking an alignment
opens the same element table used by the fit
result. Each row shows kind, start/end station, length, radius/curvature, clothoid A, tangency, and residual
provenance where applicable. Editing a row and dragging a grip are synchronized; all continuity checks run
before one atomic update.

### 2.2 Vertical alignment — live profile fitting, graphic editing, and table parity

With the alignment selected, the user presses **Long profile**. The central viewport changes to
station/elevation axes while the right panel remains the Civil tool surface. The terrain/cloud trace arrives
from an immutable Pointcloud sampling job along the alignment corridor; the status says which cloud/surface
revisions and sampling interval produced it. The raw trace is a reference, not a replacement for measured
points (`rib-civil.md` §2.6 Punktwolke app; owner evidence S9).

The user chooses **Best fit**, constrains start and end station/Z/grade, maximum grade, minimum tangent
length, rounding radius/length, fit tolerance, and allowed **Parabola**, **Circular arc**, **Clothoid**, or any
declared combination. The fit
preview shows tangent grades in percent, crest/sag rounding kind, residuals, and a live cover band against the
reference trace, adopting RIB's gradient and cover workflow (`rib-civil.md` §2.5 and W4). Infeasible rounding
is refused with the exact station and reason; the solver does not shorten, switch kind, or move a fixed end
silently.

Graphic parity is always available. LMB on the empty profile adds a tangent intersection point; a constrained
pick snaps station, grade, Z, or tangent. Dragging a point previews the result. Typing selects station/offset
and a vertical mode: absolute Z, relative ΔZ from the captured reference, or slope %. The panel mirrors
station, Z, ΔZ, incoming/outgoing grade, and rounding. Tab/Shift+Tab focus and traverse the construction bar;
↑/↓ cycle candidates while its indicator is live. A rounding grip exposes available
parabola/arc/clothoid solutions through the same candidate set before commit.

The **Vertical elements** table is a complete parity path: insert/remove/move tangent points, edit grades, set
rounding kind/radius/length, and define fixed ends. One edit is one journal command after validation. The
vertical alignment stays a typed part of the same alignment entity, not a detached curve. Circular and
Clothoid vertical segments require the additive canonical schema extensions recorded in CIV-D6/CIV-D17;
approximating either with parabolas is forbidden.

### 2.3 Width bands, promoted edges, and the live corridor

The user selects the fitted left and right road-edge polylines and chooses **Use as width-band edges**. Civil
computes station/offset samples against the main axis and shows crossings, direction reversals, and stations
outside the axis range before commit. The original polylines remain untouched. Each edge becomes a named
secondary alignment with its own horizontal tuple and vertical alignment so the user can smooth its raw vertex
heights in the same profile workspace. The width-band relation references those secondary axes and their exact
revisions; this realizes the owner's “pretty edge axes” workflow (S9).

The band table offers left/right offset, crossfall, widening/taper, and station ranges. Every numeric cell is
typeable; grips at sampled stations move only the selected control after preview. Typed offset construction is
station/offset plus absolute Z, ΔZ, or slope %, as required by C1. A change that would reverse inner/outer
order, create a zero-width run, or break station monotonicity is rejected with the affected interval.

As soon as main gradient, secondary-edge gradients, and bands are valid, a transparent/shaded corridor
representation appears. It is a live derived representation of the alignment entity, partitioned by station. A
local edit replaces only affected partitions; selecting a preview strip selects the alignment and reports
exact station/offset/Z. The preview is not an ElevationSurface and exporters do not treat it as one (ADR 0016
“Alignments and views”). **Freeze preview** retains immutable partition meshes and stops per-edit rebuilding
until **Unfreeze**; the panel shows **Preview frozen — changes pending** and the implementation drops
per-frame evaluation.

On a cold build, a generation-numbered background job publishes validated station partitions progressively
and shows first-progress, partition, cancellation, memory/disk, and restart state. It never blocks the UI or
mixes revisions. CIV-D22 defines the 10 km/100 km extreme budgets and G-CIV-3 gate.

When the user needs a DGM, machine-control surface, volume input, or delivery, they press **Create surface…**.
Civil captures the exact alignment revision, station range, bands, crossfalls, slopes, and candidate geometry
and opens the Mesh surface-creation window through `mesh.surface.draft.create`. Mesh owns checks, fixes, draft
history, progress, cancellation, and the final `mesh.surface.create`. Closing Civil does not close or cancel
that Mesh draft.

### 2.4 Embankments and excavation pits from polygons, corridors, and BIM faces

The user imports foundation polygons from DWG. They first assign an explicit common height to each closed
polygon through Draw's height command; missing Z never becomes zero. **Create base surfaces…** hands those
closed, height-known areas to Mesh. Once the horizontal base surfaces exist, the user multi-selects them and
chooses **Create slopes**. The same command accepts a corridor edge or a selected outer face of a BIM object;
the face remains BIM-owned and is only an exact source relation (owner evidence S7).

The slope panel lists each source edge/face, outward side, angle or ratio, cut/fill role, solve target when
present, and finite computation boundary. Angle, horizontal/vertical ratio, projected extent, start/end
station, and vertical seed all support pick, constrained pick, and typed input. Vertical input offers absolute
Z, ΔZ, and slope %. The transparent preview uses the shared surface tokens and direction hatching; **Display
extent** changes only the finite preview. A bake/solve requires either a target surface or an explicit closed
solve boundary—an infinite theoretical slope is never passed to an algorithm or exporter.

Each generic slope is a canonical `hcad.surface-3d@1` entity with an `hcad.civil.slope-derivation@1`
component: exact source refs/revisions/ placements, source edge parameter range, outward side, angle/ratio,
target or solve boundary, display extent, algorithm version, and current derived-mesh hash. Alignment-edge
slopes remain alignment `SlopeRule`s and use the existing partition preview; no duplicate generic entity is
created. Cheap unambiguous source edits rebuild live. Large target intersections show **Updating** and retain
the last exact mesh marked stale until a new revision publishes (P10).

Successful slope geometry follows CIV-D20 exactly: signed-distance edge panels, a radial fan at convex
corners, bisector/intersection trim at concave corners, validated seams/self-intersections, and the first
role-valid transversal target-terrain hit. Tangent/coincident/NoData/no-hit/ambiguous-first-hit cases are
typed highlighted creation errors and reuse the same list on regeneration.

To form an excavation, the user selects all base and slope surfaces and presses **Build surface from lower
edge**. A preflight shows the solve boundary, participating revisions, exact coincidence groups, gaps, and
non-height-field regions. The job builds a planar arrangement of all projected patch boundaries and pairwise
intersection curves using adaptive robust predicates; it splits patches at intersections, classifies each XY
cell, and selects the mathematically lowest valid Z patch over that cell. Boundaries are stitched into a 2.5D
lower envelope and validated for single-valued Z, manifold adjacency, coverage, and source-revision
consistency before a Mesh draft is published.

Coincident/overlapping slopes are handled explicitly. Equal geometry and equal Z within the recorded project
tolerance collapse to one patch while retaining all provenance. Same XY with different valid Z participates in
the lower envelope and the report names the winning source per cell. Nearly coincident or numerically
indeterminate intersections are not snapped by guess: the job stops with **Ambiguous overlap**, highlights the
interval, and offers source exclusion, a tighter/looser explicit tolerance, or source correction. Opposite
faces, vertical folds, self-intersections, uncovered holes, non-finite values, stale sources, and a result
with multiple Z values at one XY all fail without a draft. No “best effort” pit surface is published (X1).

The successful product is still a Mesh named draft. The user reviews its boundary, holes, triangles,
provenance, and diagnostics in the Mesh window, then commits an `hcad.elevation-surface@1`. Cancel, failure,
or crash before Mesh commit leaves sources unchanged and no canonical pit surface.

### 2.5 Long profiles and cross profiles — live or visibly stale

The Civil profile workspace has **Long profile** and **Cross profiles** tabs. Long profile maps station
horizontally and elevation vertically. Cross profiles map offset horizontally and elevation vertically at one
or many stations. The station list supports one station, typed ranges/steps, and checked multi-station
editing, adopting RIB's Stationsfenster pattern (`rib-civil.md` §2.7 and W6). The active station and direction
are always visible.

Station/offset-defined Civil geometry—alignment elements, gradient, bands, crossfalls, secondary axes, and
corridor rules—is live in both views because the mapping is cheap and unambiguous (P10). Editing a checked
station range previews every affected station and commits one atomic alignment update. Arbitrary projected
Draw, BIM, surface, and cloud geometry is a captured derived trace. It carries source revision/placement and a
visible **Current**, **Stale**, **Draft edits**, or **Sync failed** badge. Point clouds and arbitrary surfaces
are reference-only; no inverse edit is invented.

Editable projected curves may receive draft profile edits only when every anchor has a stored, unique source
mapping. **Sync** opens a review of world coordinates, affected source entities, and residuals, then applies
one expected-revision transaction or none. Unsupported or ambiguous inverse mapping blocks Sync and offers
discard/export-as-new-Draw-geometry, never a guessed source edit. When the user switches Long/Cross/Plan/3D
with pending draft edits, a compact choice says **Synchronize**, **Discard profile edits**, or **Stay**.
Switching with no draft edits is immediate; a merely stale reference does not block switching.

The draft captures the horizontal revision and station-region map. **Synchronize** is the deterministic
previewed CAS rebase in CIV-D21; **Discard profile edits** never rolls back a separately committed horizontal
change, and **Stay** blocks profile commit while preserving the stale draft.

Cross-profile extraction from a point cloud or surface is a long Pointcloud/ Mesh read job with real station
progress and cancellation. Completed station traces publish atomically into the profile cache. A source change
marks only affected stations stale. Restart resumes from verified station partitions; cancel preserves the
last complete set.

### 2.6 Stationing, chainage labels, station/offset points, and auto-layers

Selecting an alignment and choosing **Station labels** opens a right-panel group for start station,
major/minor interval, tick/label side, precision, equations/discontinuities, and label specification. Labels
are derived from exact chainage plus the station origin; changing global label visibility does not destroy
per-alignment choices (P9). A reversed alignment previews the new direction and station consequences before
one command.

Station equations use CIV-D16's ordered back/ahead pairs and stable equation/region ids. Labels, table ranges,
canvas snaps, and automation always retain internal chainage plus region/equation side. A displayed number
that resolves to more than one chainage opens the candidate list and cannot be committed bare.

**Point by station/offset** is a Draw point construction. The user picks or chooses a named alignment, types
or snaps station and signed offset, then sets height as absolute Z, ΔZ from the alignment/target, or slope %.
The live marker shows the perpendicular foot, side, station, offset, Z acquisition, and axis direction.
Tab/Shift+Tab focus and traverse the input bar; ↑/↓ cycle overlapping alignments/solutions only while the
candidate indicator is live. The output is the ordinary `hcad.point@1` from `draw.point.create` with the
station-reference relation defined in §11.2; it receives the
current specification/layer exactly like any Draw point.

Every new alignment resolves a layer through the editable DR-D8 office template; child profile/corridor
presentation can use user-editable project templates but never hard-coded office naming. Changing the policy
affects future creations by default; **Apply to existing** is an explicit reviewed multi-entity command. This
adopts RIB auto-layer behavior (`rib-civil.md` §2.3) and field-code current-spec/layer targeting
(`field-codes.md` §3.2/§7.2) under P7 rather than mandating a convention.

Fit/check thresholds, transition/ramp policies, station-label rules, tolerances, and these layer templates live
in the versioned Civil standards library (CIV-D19). Every recipe captures its exact standard revision; width,
crossfall, vertical, fit, and station-equation tables support lossless batch import/export.

## 3. Dossier-row dispositions

These dispositions cover every RIB row registered to Civil by §5 mapping hints and the Civil-relevant
field-code rows. Rows owned by another spec are cited, not re-dispositioned.

### 3.1 RIB §2.1–§2.3 Civil dependencies

| Dossier row                                    | Disposition                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Kleinpunkt / Achskleinpunkt                    | adopted: §2.6 station/offset mode of shared `draw.point` (DR-D19)                                                                  |
| Gerade/Bogen/Klothoide constructions           | already adopted by Draw DR-D6/DR-D8; Civil consumes their analytic tuple, no second tool                                           |
| Linienzug, Trimmen                             | already adopted by Draw; classic alignment path cites it                                                                           |
| F5-Box, Tachobox, Mehrdeutigkeit, Punktauswahl | adopted through contract C1, DR-D1, DR-D6, and DR-D12                                                                              |
| F4-Box named-object selection                  | adopted as filterable named picker/list query; F4 key rejected because registry assigns it to Viewing box                          |
| Hilfspunkte                                    | adopted through ordinary support-geometry points plus station-reference relation; visibility remains UI-platform/select-edit owned |
| Folie per Achse/Gradiente/Dreiecksnetz         | adopted as editable layer-policy templates (§2.6); Mesh retains surface-layer behavior                                             |
| Spezifikation/F9                               | already BIM/Draw-owned; Civil consumes current specification for labels/points, no duplicate state                                 |
| HV and general display toggles                 | other domain: P9/UI-platform/View own visibility; no Civil re-disposition                                                          |

### 3.2 RIB §2.4 alignments

| Dossier row                               | Disposition                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Achse erzeugen                            | adopted via shared `draw.alignment` parity path                                                                                                                                              |
| Achsentwurf / automatic generation        | adopted and extended by constrained one/two-edge/point best fit (§2.1)                                                                                                                       |
| Achsprüfung                               | adopted in `alignment.check`; fit report and post-edit continuity diagnostics                                                                                                                |
| Achsoptimierung                           | adopted as explicit constrained re-fit; never silent background mutation                                                                                                                     |
| Achsverziehung                            | partial: station-dependent width-band taper is adopted; the evidenced four-equal-tangent/arc construction macro is deferred until the junction/transition assistant is sourced and specified |
| Knotenpunkt assistants                    | deferred: junction-specific geometry/catalog requires its own sourced workflow after the core alignment editor                                                                               |
| Rampenband generation                     | partial: table/graphic editing is adopted; regulation-driven generation is deferred until a versioned rule table is admitted to the Civil standards library (CIV-D19)                        |
| Breiten-/Rampen-/Kurvenband/Deckenbuch    | width/crossfall adopted; curvature band is derived display; pavement book deferred to BIM/corridor-assembly semantics                                                                        |
| Schleppkurve                              | deferred: separate vehicle-path analysis, no owner workflow/evidence requirement in this tranche                                                                                             |
| Sichtweitenanalyse/HViSt                  | deferred: analysis over gradient/DGM after the core data path exists                                                                                                                         |
| Added Civil 3D best-fit evidence          | adopted: sources, regression review, two-path centerline concept, transitions, residual report; arbitrary feasibility guarantee rejected per dossier-wide absence                            |
| Added published clothoid fitting evidence | adopted as algorithm class only; no code or numeric rule is copied from research                                                                                                             |

### 3.3 RIB §2.5 gradients

| Dossier row                                           | Disposition                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Längsprofilfenster                                    | adopted as Civil profile workspace (§2.2/§2.5)                                                                     |
| Automatic tangent polygon / modern optimized gradient | adopted as constrained best fit                                                                                    |
| Gradiente create/dissolve                             | create/update adopted; dissolve rejected because it discards Civil semantics—export/copy as Draw curve is explicit |
| TS point insert/append/remove/move                    | adopted with grips and table parity                                                                                |
| Ausrunden                                             | adopted with parabola and circular rounding; impossible solutions fail explicitly                                  |
| Tangent grades                                        | adopted as typed percentage fields                                                                                 |
| Gradientenüberdeckung                                 | adopted as live cover band against exact source revision                                                           |

### 3.4 RIB §2.6–§2.8 surfaces, cross sections, earthworks

| Dossier row                               | Disposition                                                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DGM creation/errors/contours/volumes      | other domain: Mesh MT-D1–MT-D8 owns; Civil supplies captured corridor/pit records only                                                                                                              |
| Pointcloud axis-based long/cross profiles | adopted through Pointcloud sampling hand-off and Civil profile cache                                                                                                                                |
| Multiple horizons/soil models             | other domain: Mesh/BIM; slopes accept named target surfaces without redefining horizons                                                                                                             |
| RQ editor/component catalogs              | deferred: typical-section assembly is larger than width-band/crossfall core and needs its own sourced catalog contract                                                                              |
| QP Generator project                      | adopted as cross-profile tab, station set, captured inputs, and project-persisted view state                                                                                                        |
| Stationsfenster                           | adopted: checked station list and station-range multi-apply                                                                                                                                         |
| Construction assignment by station/side   | adopted for band/crossfall/slope rule ranges; full RQ macro assignment deferred with RQ editor                                                                                                      |
| Point construction/intersection assistant | adopted through tri-modal station/offset/Z profile construction; arbitrary loci beyond current geometry deferred                                                                                    |
| Ditches, slope rounding, parallels        | split: P10 parallel/offset relations are adopted via Draw DR-D20; ditch and slope-rounding macros are deferred with the sourced RQ assembly catalog; a generic slope is only a prerequisite         |
| Accounting boundary lines                 | deferred to Mesh quantity/report workflow; Civil cross-profile traces remain usable inputs                                                                                                          |
| Fachbedeutungen                           | adopted by consuming the existing specification catalog; values remain office data under P7                                                                                                         |
| Intelligent linkage                       | adopted: station-defined geometry live; arbitrary projections stale-with-sync under P10                                                                                                             |
| Erdbauwerke pit/dam/pond                  | partial: excavation-pit lower envelope and explicit target-surface intersection are adopted; dams, ponds, benches/workspaces, and machine/proof deliverables are deferred pending sourced workflows |
| Other quantity rows                       | other domain: Mesh owns computation/export; no silent pruning                                                                                                                                       |

### 3.5 Field-codes dossier dispositions

| Evidence row                                                                     | Disposition                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RIB numeric specification/current F9/layer target (`field-codes.md` §3.2)        | adopted by consumption: Civil points/labels use the one current specification and its layer rule |
| Catalog code, feature instance, control code, typed attributes separation (§7.1) | adopted for imported Civil source provenance; never collapsed into one alignment name            |
| Draw current specification and shortcuts (§7.2)                                  | adopted unchanged; Civil creates no second current-spec state                                    |
| Product-mandated code/naming grammar                                             | rejected under P7 and dossier negative evidence                                                  |

## 4. Function-contract answers A1–E3 by group

### 4.1 Group A — horizontal alignment (`civil.alignment.*`, shared `draw.alignment`)

**A1.** The complete outcomes are §2.1: fit or construct, inspect analytic elements/residuals, create one
named alignment, edit graphically or by table, and undo without changing sources.

**A2.** RIB supplies element-wise construction, checking/optimization, and axis creation (`rib-civil.md` §2.4,
W3). The sourced Civil 3D and published research additions in dossier §2.4 establish one/two-path and point
best fit, regression review, and line/arc/clothoid recovery. We adopt all three paths and deviate by making
hard-constraint infeasibility explicit; dossier-wide absence finds no arbitrary-solution guarantee.

**A3.** Draw DR-D6/DR-D8/DR-D12 are the exact sibling semantics. LandXML import already maps horizontal curves
into Alignment (`landxml.rs:603-652`). The same improvement is required in import/export only as provenance
preservation; Civil does not alter provider ownership.

**B1.** Catalog rows list every path. No Q entry for whole alignment fit because it requires reviewed
sources/constraints. No shortcut due to F4 collision. All UI/console/automation paths resolve to the listed
canonical commands.

**B2.** Ribbon toggles the panel; x and UIP-D14 rung 7 close it. Escape in a field reverts; active drag
reverts; picked-point capture cancels at rung 4. Closing keeps a named fit draft/checkpoint but never commits
it. **Discard fit** removes the draft explicitly.

**B3.** Right panel plus viewport: constraints must remain visible during source picks/grips. Residual detail
expands into a resizable lower drawer; it does not justify a separate app window.

**C1.** Every source/control/element input is pick, constrained pick, or typed. Every vertical value supports
absolute Z, ΔZ, and slope %. Grips and table stay live-synchronized; Tab/arrow behavior is §5.1.

**C2.** Launch captures one/two selected curves or a preselected ordered point set. Selection changes later do
not change the draft; **Replace sources…** is explicit. Element edit operates on one alignment;
multi-selection exposes only shared labeling/layer properties with Mixed behavior per UIP-D17.

**C3.** A fit draft may be **Freeze candidate** to retain the current analytic candidate while
constraints/source visibility change; the solver stops and the preview becomes immutable. Alignment corridor
preview freeze is Group C.

**C4.** Fit draft metadata/checkpoints persist per project outside the document journal;
Create/update/station-origin are canonical commands. One accepted candidate is one undo step. Heavy
samples/checkpoints are content-addressed and retained while the draft or undo horizon references them;
discard/GC releases unreachable artifacts (P5).

**D1.** Grip/table preview is continuous and gated by G-CIV-1. Fits below 50,000 samples should produce first
candidate within 1 s; larger fits are long. Extreme gate: 1,000,000 ordered samples, 10,000 allowed elements,
first real progress ≤250 ms, cancel acknowledgement ≤500 ms, resident working set ≤2 GiB, staged disk ≤4×
encoded samples, verified checkpoint every ≤30 s, restart from last checkpoint, and completion means a
validated candidate/report or typed infeasibility—never partial canonical state. Values are tunable under X6.

**D2.** Preview tessellation/line thickness and residual-chart sampling degrade first. Fit source samples may
stream but are never silently discarded; the report names any user-selected sampling. Correct constraints, f64
output, input response, and commit validation never degrade.

**E1.** Criteria CIV-V1–V4 and CIV-V11 in §7.

**E2.** Consumers: entity renderer, picking/snapping, station labels, vertical profile, bands/corridor, slope
rules, Mesh hand-off, selection/Properties, LandXML/export, journal/undo, automation, and import-update
dependency scan. A source edit marks a fit draft stale; an alignment update CAS-rejects stale publication.
Least member is one line; largest is the extreme fit above. A single line is valid without invented arcs; a
million-sample fit stays bounded.

**E3.** G-CIV-1, G-CIV-5, G-CIV-6, and tier gates in §8.

### 4.2 Group B — vertical alignment and profile editing

**A1.** §2.2 and §2.5: open the live profile, sample reference data, fit or draw grades/roundings, review
cover, edit by table, sync only mapped projected edits, and leave the view safely.

**A2.** RIB's profile window, automatic tangent polygon, TS editing, typed grades, parabola rounding,
impossible-rounding refusal, and live cover band are adopted (`rib-civil.md` §2.5/W4). Circular rounding is an
owner-requested addition (S9), stored exactly per CIV-D6.

**A3.** View's local frame infrastructure is real (`KernelLocalSectionView.ts:26-38`;
`KernelNavigationController.ts:214-240`), but VD-D1 rigid sections remain separate. Pointcloud PC-D8 owns
immutable sampling products. Draw input and UIP-D14 provide interaction semantics.

**B1/B2/B3.** Ribbon/context/console/automation paths are in §1. The Civil profile workspace uses the central
viewport plus RP because editing and exact canvas interaction are inseparable. Ribbon re-toggle/x requests
view exit; pending draft edits trigger Synchronize/Discard/Stay. Escape unwinds field, drag, armed
construction, then tab; it never silently syncs.

**C1.** §2.2 supplies full tri-modal station/offset/Z/ΔZ/slope parity, typed grades and rounding values, live
preview, Tab/Shift+Tab construction-bar traversal, and ↑/↓ candidate cycling.

**C2.** One primary alignment is captured. Reference selections may be added explicitly. Cross-profile checked
stations are an explicit multi-set; Mixed table values show Mixed and commit to all checked stations after
preview.

**C3.** **Freeze reference traces** bakes the current complete long/cross profile cache, drops resampling
work, and marks later source changes stale. Unfreeze schedules refresh. It never freezes canonical alignment
editing.

**C4.** Alignment edits journal normally; profile camera, exaggeration, pan, and active station are
view-history state under P8/ADR 0016. Named profile definitions belong in canonical ViewState v2, while traces
remain derived. Draft projected edits persist until sync/discard. Heavy traces use exact source hashes and
release with view-state/undo reachability.

**D1.** Profile pan/zoom, grip drag, station scrub, and checked-station preview are continuous. G-CIV-2
asserts presented-frame-interval p95 ≤2× target frame time and input-to-visible p95 ≤100 ms during
2,000-control alignment editing with a 10,000-station cached trace. Extraction beyond cached data is a UIP-D10
job: first progress ≤250 ms, cancel ≤500 ms, partition checkpoint ≤30 s.

**D2.** Reference trace density, labels, hatching, then non-active station previews degrade. Active geometry,
selected controls, exact cursor readout, input response, stale badge, and sync correctness never degrade.

**E1/E2/E3.** Criteria CIV-V5–V7/CIV-V11; consumers are corridor preview, labels, cross profiles, Mesh bake,
LandXML, picking, automation, view history, and projected-source dependency scans. A two-control grade and a
10,000-station set obey the same live/stale rules. G-CIV-2/G-CIV-5/G-CIV-6 prove them.

### 4.3 Group C — bands and corridor

**A1/A2.** §2.3. RIB links width/ramp bands, gradient, and cross profiles (`rib-civil.md` §2.4/§2.7); owner
evidence S9/S10 asks for promoted edges and an easy live surface. We adopt links and make the unbaked/baked
boundary explicit.

**A3.** Existing alignment fields and preview evaluator are siblings (`entity_model.rs:897-959`;
`alignment_preview.rs:190-210`). Mesh MT-D1–MT-D5 owns surface drafts; SE-D3 owns whole alignment placement.

**B1/B2/B3.** Catalog paths apply. Closing hides editing chrome but leaves the canonical live preview visible;
a chip reopens it. Freeze/unfreeze are explicit pairs. RP plus viewport is sufficient; Mesh opens its own
window at hand-off.

**C1/C2.** Band controls are tri-modal and typed; one alignment is captured. Promote accepts one or two
selected edge curves and never follows later selection changes implicitly. Shared properties on multiple bands
use Mixed.

**C3.** Freeze preview bakes immutable station partitions and suspends rebuild; unfreeze computes only
affected partitions. This directly reduces per-frame and per-edit work under X2.

**C4.** Band/edge relations are parts of the journaled alignment revision. Preview partitions are derived,
content-addressed cache. Surface creation is a separate Mesh command; undoing it removes only the baked
surface, not alignment or preview.

**D1/D2.** G-CIV-3 gates CIV-D22's 10 km and 100 km/100-band cold builds, cancellation/restart and burst
supersession, then one warm local edit: presented-frame-interval p95 ≤2× target; input-to-old-preview-stale
badge within one presented frame; only affected partitions recompute; new partition publish ≤500 ms for
bounded work or remains a visible job. Weak hardware reduces non-active band density and preview tessellation,
never station/height truth.

**E1/E2/E3.** Criteria CIV-V8/CIV-V9. Consumers: render, pick/snap, profile, slopes, Mesh draft, export
(ignore unbaked geometry), selection, automation, and transform/import invalidation. Zero-width single band
and 100-band extreme are both validated. G-CIV-3/G-CIV-5/G-CIV-6.

### 4.4 Group D — slopes and pit lower envelope

**A1/A2.** §2.4. Owner evidence S7 defines polygon/common-height, transparent finite display, BIM-face,
coincident-slope, and lower-edge workflow. RIB's Erdbauwerke row documents variable slopes and automatic DGM
intersection (`rib-civil.md` §2.8). A whole-dossier audit of `rib-civil.md` searched its Civil catalog,
workflows, and sources for corner patch/fan/miter, concave trim, self-intersection, tangent/coincident terrain
hit, NoData, and multiple-hit rules; none supplies permission for a heuristic topology branch. The exact
Himmel:CAD branch is therefore the X1 decision in §11.5, not reference attribution.

**A3.** Alignment slope rules and renderer resolution are partial siblings (`entity_model.rs:925-959`;
`entity_compiler.rs:1493-1545`). Mesh owns canonical surface review/publication. BIM owns face identity; Draw
owns source areas; SE-D3 placement revisions participate in every cache key.

**B1/B2/B3.** Catalog paths apply. Slope panel close keeps canonical slopes and disarms grips; Escape reverts
field/drag/tool/panel. Pit jobs continue in UIP-D10 after panel close; cancel is available there. Mesh opens
its dedicated window.

**C1/C2.** Every angle/ratio/extent/boundary/Z is pick/constrained/typeable. Slope create captures a
multi-selection; changes after launch do nothing until Add/remove sources. Mixed angle shows Mixed and an edit
applies atomically to all selected slopes.

**C3.** **Freeze derived mesh** retains exact slope resources and marks source changes stale, trading liveness
for fast interaction. Pit output is inherently a baked Mesh draft; there is no useful second lock.

**C4.** Generic slope parameters and refs are canonical and journaled; previews are derived. Pit calculation
is a persisted lightweight job manifest plus content-addressed arrangement/mesh checkpoints; final Mesh create
is one undo step. Undo never changes bases/slopes. GC releases staged artifacts after draft, job, and undo
reachability ends.

**D1.** Slope grips are continuous (G-CIV-3). Pit solve is long. Extreme gate: 1,000 source patches, 100,000
intersection segments, first progress ≤250 ms, cancel ≤500 ms between arrangement batches, working RAM ≤4 GiB,
staged disk ≤3× encoded input+candidate, checkpoint ≤30 s, restart from verified phase, completion only after
lower-envelope and 2.5D validation. Tunable under X6.

**D2.** Transparent tessellation and inactive-source display degrade first. Robust predicates, lower-envelope
classification, failure reporting, input response, and exact final validation never degrade.

**E1/E2/E3.** Criteria CIV-V9/CIV-V10. Consumers: surface renderer, picking/ snapping, visibility/P4, Mesh
drafts, volume/raster/solid downstream readers, selection/Properties, BIM/Draw source dependency scan,
journal, automation, and exporters. Least member is one planar edge and bounded slope; extreme is the gate
above. Coincident equal patches and conflicting near-coincident patches are explicit G-CIV-4 cases.

### 4.5 Group E — profiles, stationing, points, and layer policy

**A1/A2.** §2.5/§2.6. RIB supplies linked profile/QP stations, checked multi-station construction,
Achskleinpunkt, and auto-layers (`rib-civil.md` §2.1–§2.3, §2.7/W6); station-label behavior is supported
specifically by `rib-civil.md` §2.4/W3. We adopt them with P10 live/stale
and P7 office-data rules.

**A3.** UI-platform owns selection/Mixed/Escape; Draw owns point creation and current specification; View owns
visibility/history; Civil adds only station-reference semantics and profile mapping.

**B1/B2/B3.** Paths are in §1. Station labels/layer policy use RP/Settings; point construction uses Draw's
input bar; profiles use the Civil workspace. Close/cancel behavior is §2.5/§2.6, never implicit commit.

**C1/C2/C3/C4.** Point creation is fully tri-modal. Labels operate on one or many alignments with Mixed
values. Profile traces may freeze; labels/points do not benefit from locks. Label settings, station refs, and
applied layer changes are journaled; current layer/policy default follows DR-D10/P7 and is not an undo step
until **Apply to existing** changes entities.

**D1/D2.** Label collision layout and station-point preview are continuous and part of G-CIV-2. On weak
hardware minor labels cull before major labels; exact station readout, point coordinates, selected label, and
input response remain.

**E1/E2/E3.** Criteria CIV-V6/CIV-V11. Consumers include Draw styling/layers, selection, snapping, labels,
exporters, automation, profile/corridor relations, and P9 visibility. A zero-length alignment is rejected; a
100 km alignment with 100,000 minor stations uses bounded label LOD. G-CIV-2/G-CIV-5.

## 5. Decision records

### 5.1 Gesture reconciliation (CIV-D1)

**Decision:** Civil uses the UIP §3.6 platform map exactly. While a Civil construction is armed, only the
claims below replace idle meanings; every unlisted gesture remains platform-owned.

| Gesture                     | Alignment point/profile/station-point tools                                         | Grip/band/slope edit                                             | Pit/surface hand-off                                |
| --------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| LMB click                   | claims construction pick; idle selection suspended                                  | off-handle remains select; handle click selects handle           | no claim; preselection captured                     |
| LMB double-click entity     | finishes a valid picked-point string; otherwise reserved                            | opens element edit on alignment/slope                            | no claim                                            |
| LMB double-click void/cloud | no claim; platform clear unless point string is valid, then finish with status copy | platform clear                                                   | platform clear                                      |
| LMB drag                    | platform orbit/pan                                                                  | claims only when press began on visible grip; off-grip orbit/pan | platform orbit/pan                                  |
| Ctrl+LMB                    | platform selection unless construction explicitly captures a source point           | platform selection off grips                                     | platform selection                                  |
| RMB click/drag              | platform menu/pan; tool verbs appear as registered menu entries                     | same                                                             | same                                                |
| MMB/wheel                   | platform pan/zoom                                                                   | platform pan/zoom                                                | platform pan/zoom                                   |
| Tab/Shift+Tab               | focus/traverse the shared construction input bar; never cycles candidates           | focus/traverse fields; never cycles candidates                   | platform focus traversal                            |
| ↑/↓                         | cycles candidate/solution set only while the live indicator is visible              | same                                                             | no Civil claim                                      |
| Escape                      | UIP-D14 field → drag → armed tool → function tab                                    | same                                                             | cancels setup; running job only via explicit Cancel |
| Typing                      | focuses Civil/Draw numeric input without moving cursor                              | focuses corresponding field, freezing pointer preview            | no viewport claim                                   |

**Derivation:** UIP §3.6, UIP-D14, DR-D1/DR-D6/DR-D12, SE-D1; X7. **Rejected:** RMB tool takeover (platform
says tools contribute menu entries), any Tab candidate cycling, and off-handle drag capture.
**Tunable:** shared 4 px drag threshold only (X6).

### 5.2 CIV-D2 — Best fit is constrained analytic regression with honest failure

**Decision:** use a segmented-curvature/robust orthogonal-regression algorithm class with model selection over
line/arc/clothoid elements, hard feasibility constraints, and a residual-plus-element-count objective. Return
inspectable candidates or typed infeasibility; never commit a spline or silently relax. **Derivation:**
X1/X4/X6; `rib-civil.md` §2.4 best-fit evidence additions and dossier-wide absence line; owner S9.
**Rejected:** spline centerline (not the required tuple); one opaque candidate; automatic constraint
weakening. **Tunable:** residual weights, robust loss, penalty, iteration/checkpoint budgets.

### 5.3 CIV-D3 — Classic, graphic, fit, and table paths edit one model

**Decision:** all paths resolve to one alignment command model; tables are not export reports and grips are
not viewer-owned mutations. **Derivation:** X3/X5; RIB W3/W4 and P7; ADR 0019 command boundary. **Rejected:**
separate “fitted axis” type or table-side database. **Tunable:** default table columns.

### 5.4 CIV-D4 — Promoted road edges are secondary alignments

**Decision:** a promoted edge becomes a named secondary alignment with its own vertical alignment; the
width-band relation references it by exact revision. Source curves remain unchanged. **Derivation:** owner S9;
P10; X1/X3; RIB linked bands §2.4/§2.7. **Rejected:** raw vertex offsets only (cannot carry the requested
pretty gradient); destructive curve conversion. **Tunable:** initial fit constraints and generated name.

### 5.5 CIV-D5 — Corridor is live derived representation; Mesh alone bakes

**Decision:** corridor strips/slopes stay alignment-derived preview partitions under CIV-D15/CIV-D22.
Materialization always enters MT-D26's Mesh draft, cites surface dependency record MT-D25, and produces a
separate surface only on `mesh.surface.create`. **Derivation:** ADR 0016 lines 198–201; P10/X2; owner S9/S10;
MT-D25/MT-D26. **Rejected:** silently treating render proxies as a DGM; a Civil-owned create-surface command;
provenance without a live/stale recipe. **Tunable:** partition/sample size and auto-freeze threshold.

### 5.6 CIV-D6 — Exact circular vertical rounding extends the alignment schema

**Decision:** add an exact tagged Circular vertical segment with start station, start elevation, signed
radius/curvature, sweep/length, and continuity invariants to the canonical alignment schema/migration while
retaining `hcad.alignment@1` as required by the program. LandXML export reports a loss when the target subset
cannot represent it; it never substitutes a parabola. **Derivation:** owner S9; X1; current absence at
`entity_model.rs:879-895`; DATA-MODEL derived-truth rules. **Rejected:** parabola approximation (silent
geometry change); Draw-only profile curve detached from the alignment. **Tunable:** no; migration/version
compatibility is architect-owned.

### 5.7 CIV-D7 — Live/stale follows mapping, not entity popularity

**Decision:** station/offset-defined Civil geometry is live. Arbitrary projected geometry caches exact source
revisions, becomes visibly stale, and synchronizes only through CIV-D21's unique reviewed inverse/rebase;
view switch confirmation applies only to pending edits, not staleness alone. CIV-D15 governs accepted derived
entities. **Derivation:** P10 and owner S8; X1. **Rejected:** all-live projection (ambiguous/expensive);
all-manual refresh (needlessly stale Civil geometry); silent discard; stale-only switch confirmation.
**Tunable:** background refresh debounce only.

### 5.8 CIV-D8 — Generic slope is a derived Surface3D entity

**Decision:** generic area/BIM/edge slopes use `hcad.surface-3d@1` plus the versioned
`hcad.civil.slope-derivation@1` component; alignment-edge slopes stay inside Alignment `SlopeRule`. Every
solve is finite, recipe-bound by CIV-D15, and topologically defined by CIV-D20. **Derivation:** owner S7;
DATA-MODEL lines 67–79/114–117; ADR 0016
alignment rule; X1/X3/P10. **Rejected:** unbounded infinite entity; copying BIM faces; a second generic slope
entity for alignment edges. **Tunable:** display extent/default tolerance, never solve finiteness.

### 5.9 CIV-D9 — Pit is a robust lower-envelope arrangement

**Decision:** CIV-D20-valid projected patches + robust intersections + per-cell lower-Z selection + 2.5D validation;
coincident equals deduplicate with provenance, ambiguous near-coincidence fails; output is a Mesh draft.
**Derivation:** X1; owner S7 edge-case requirement; Mesh MT-D3 no-silent-fix class; P10. **Rejected:**
triangle soup union, nearest-vertex stitching, first-source wins, or tolerance snapping without review.
**Tunable:** explicit geometric predicates/tolerances under X6 and G-CIV-4.

### 5.10 CIV-D10 — Civil stays in D2's Draw/Mesh tabs

**Decision:** add Alignment/Profile/Corridor/Slopes groups to Draw and only surface hand-off accelerators to
Mesh; do not introduce a Civil tab. **Derivation:** owner decision D2 fixes the tab taxonomy; D7 un-defers the
subsystem but does not revise that taxonomy; exact group placement is tunable. **Rejected:** unilaterally
adding a tab; hiding Civil in context menus. **Tunable:** group order/collapse behavior.

### 5.11 CIV-D11 — One office-editable layer/spec policy

**Decision:** consume Draw's current specification and DR-D8 layer template; store policy as project/office
data inside the CIV-D19 standard, with explicit Apply to existing. **Derivation:** P7; DR-D8/DR-D10;
`rib-civil.md` §2.3; `field-codes.md`
§3.2/§7.2. **Rejected:** hard-coded German/English names or a Civil-only current layer. **Tunable:** shipped
seed/template visibility.

### 5.12 CIV-D12 — Profile view state is not profile geometry

**Decision:** camera frame, exaggeration, active station, and trace visibility are view state; named profile
definitions use ViewState v2; exact profile traces are derived products. Alignment edits remain document
commands. **Derivation:** ADR 0016 lines 203–213; P8/P10/P1. **Rejected:** `hcad.profile-view` render entity;
journaled pan/zoom; transient unsaved named view. **Tunable:** default exaggeration and persisted last-active
tab.

### 5.13 CIV-D13 — Fit and pit jobs checkpoint; previews never journal per frame

**Decision:** lightweight draft manifests reference immutable samples, candidates, arrangements, and partition
checkpoints. Continuous gestures journal once at accept. Long jobs resume after whole-app restart and publish
only against exact project/source revisions. **Derivation:** P5/X2/X1; FUNCTION-CONTRACT D1; UIP-D10/MT-D17
class. **Rejected:** JSON mesh/sample payloads in journal; restart from zero; late publication into replaced
projects. **Tunable:** budgets in §4/§8.

### 5.14 CIV-D14 — Surface and projected-source consumers are explicit

**Decision:** every alignment/slope change invalidates render, pick/snap, profiles, labels, corridor, Mesh
drafts, import/export plans, and automation caches by indexed dependency relation. Passive readers may never
retain an unmarked old revision. **Derivation:** SYSTEM-001; FUNCTION-CONTRACT E2; SE-D3; IF-D4/MT-D19 class.
**Rejected:** feature-local callbacks or rebuild-on-open only. **Tunable:** coalescing/debounce, not
invalidation truth.

## 6. Current-implementation delta

### 6.1 Exists and remains

- Built-in `hcad.alignment@1` type id and typed Rust model (`entity_model.rs:49-50,97-98,871-959`).
- Analytic Clothoid and Composite curve representations (`entity_model.rs:301-333`).
- Semantic validation for horizontal, vertical, station functions, bands, and slope rules
  (`entity_validation.rs:931-986`).
- LandXML import of horizontal, vertical parabola/grade, width/crossfall data (`landxml.rs:603-652,665-930`)
  and export of horizontal/grade/parabola (`landxml.rs:2047-2163`). Export currently omits corridor
  bands/slope rules, which is reported through a loss code (`landxml.rs:1685-1693`).
- Renderer slope-resolution validation (`entity_compiler.rs:1493-1559`), alignment/band tessellation
  (`entity_compiler.rs:1566-1615`), and immutable partitioned corridor preview with revision/target checks
  (`alignment_preview.rs:190-210,719-824`).
- WASM/viewer preview build/update/remove paths (`himmelcad-wasm/src/lib.rs:1680-1731`;
  `WgpuKernelViewer.ts:2893-2921`).
- Local profile/section frame and optional depth slab (`KernelLocalSectionView.ts:26-73`;
  `KernelNavigationController.ts:214-240,288-299`).
- Browser evidence that one preview partition updates and stale generation is rejected
  (`kernel-browser-e2e.mjs:1390-1422`). This is a harness, not Builder reachability or a smoothness gate.

### 6.2 Changes required

- Extend vertical segments with exact Circular and Clothoid members plus migration and LandXML loss/adapter
  behavior (CIV-D6/CIV-D17).
- Admit and generate the typed CIV-D23 schema bundle. Current `WidthBand`/`CrossfallBand` have station
  functions but no secondary-axis ids, and current Alignment has no fit recipe/report, station equations, or
  station-reference relation (`entity_model.rs:897-959`).
- Generalize dependency indexing for alignments, profile caches, slopes, fit drafts, and Mesh hand-offs
  through the one CIV-D15 recipe/DAG (CIV-D14/CIV-D15).
- Bind existing preview partitions to canonical Civil commands and Builder selection/picking/snapping; remove
  test-only host assumptions.
- Add a versioned generic slope derivation component to Surface3D and preserve exact BIM face/area/edge refs.
- Extend Pointcloud sampling with station-corridor trace requests and Mesh with Civil input records, through
  owning-spec revisions.

### 6.3 New

Everything user-facing in §1: Builder ribbon/context/Properties surfaces, Civil panel/profile workspace,
analytic best-fit engines and reports, canonical alignment command/query family, table/grip editors, promoted
secondary axes, profile live/stale/sync state, station labels/points, generic slope and pit solver, platform
job manifests/checkpoints, Civil standards library, station-equation/region model, recipe management,
automation schema/SDK leaves, E1 captures, and the not-yet-created performance/robustness gate artifacts in
§11.8.

### 6.4 Explicitly not existing

No cited stub, deprecated surface, test hook, or model field is counted as a product function. First-party
searches found no Builder command handler, ribbon entry, context entry, automation schema leaf, or generated
SDK method for the §1 Civil ids. Therefore every catalog status says new/partial rather than “implemented.”

## 7. E1 failable visual and behavioral criteria

Implementation review must capture both themes at 100% UI scale and compare against these written criteria.
Product tokens/shared components only; a grep for literal one-off Civil chrome colors must return none.

1. **CIV-V1 — Analytic fit preview.** Lines, arcs, and clothoids are visually distinguishable by shape/segment
   markers without relying on color alone; transition points do not jump between sampled drag frames. Fail on
   a generic spline, hidden direction, or unstable grips.
2. **CIV-V2 — Constraints and residuals.** Hard constraints, units, candidate number, maximum/RMS/p95
   residual, and element count are simultaneously readable without covering the picked road. Fail if “valid”
   appears without numeric evidence or an infeasible candidate can be committed.
3. **CIV-V3 — Source identity.** One/two edges render with direction and stable source labels; reversing a
   source changes arrows before geometry. Fail if left/right provenance is discoverable only in a tooltip.
4. **CIV-V4 — Element table parity.** Selecting a table row highlights exactly one viewport element and vice
   versa; Mixed/error cells use shared states; typed and grip values agree at project precision.
5. **CIV-V5 — Long profile.** Station/elevation axes, datum, units, exaggeration, active source revisions,
   grade %, rounding kind, and cover band are visible. Fail if exaggeration can be mistaken for canonical Z.
6. **CIV-V6 — Cross profiles/stations.** Active station, view direction, checked station count, and left/right
   offsets are visible; multi-station preview distinguishes active from affected stations without color alone.
7. **CIV-V7 — Live/stale/sync.** Current, Stale, Draft edits, Updating, and Sync failed are distinct tokenized
   badges with direct actions. Fail if old geometry appears current or view switching hides a pending-edit
   choice.
8. **CIV-V8 — Corridor partition update.** Changed partitions show a subtle rebuilding boundary within one
   frame while unchanged partitions remain stable; final seams are invisible. Fail on whole-corridor
   flash/removal.
9. **CIV-V9 — Transparent slopes.** Source edge, outward direction, angle, finite display extent, stale/frozen
   state, and target are legible over cloud/mesh/BIM content. Fail if transparency hides selection or implies
   an infinite computed product.
10. **CIV-V10 — Pit diagnostics.** Coincident groups, lower-envelope winner, gaps, and ambiguous overlaps are
    locatable from the error list and viewport; no error uses a silent “fixed” state. Fail if failed regions
    resemble a complete surface.
11. **CIV-V11 — Input/focus.** The construction bar always shows station, offset, X/Y, absolute Z/ΔZ/slope %,
    direction, and current acquisition; Tab/Shift+Tab traversal and the live ↑/↓ candidate indicator are
    visually unambiguous. Fail if Tab cycles a candidate, typing moves the cursor, or Escape commits a blurred
    field.
12. **CIV-V12 — Standard shell.** Docked/detached panel, close button, jobs chip, menus, Properties, and
    confirmation islands match UI-platform in both themes. Fail on unstyled controls, one-off
    shadow/radius/type, or missing accessible name/focus order.

## 8. Verification plan per `docs/TEST-TIERS.md`

Named gates below are gate specifications, not present runnable artifacts. The exact targets/scripts in §11.8
must be created and registered in the Verification Planner; until then absence is a promotion blocker and never
a skip.

### 8.1 Changed tier

- **G-CIV-CORE** — Rust unit/property suite: analytic tuple continuity; station monotonicity/equations;
  repeated display values and exact equation sides; equation edit/reversal/reload; grade/parabola/circular/
  clothoid continuity and degeneracies; band ordering; station/offset round-trip; recipe DAG/detach/source-loss;
  no non-finite or invented Z; validation of least/extreme members; canonical hash stability.
- **G-CIV-FIT-UNIT** — deterministic synthetic lines/arcs/clothoids with noise, one/two paths, reversed paths,
  S-curves, short elements, constraint conflicts, multiple solutions, and typed infeasibility; residual report
  recomputes from output and source independently.
- **G-CIV-PIT-UNIT** — analytic lower envelopes: single plane, crossing planes, equal coincident patches,
  unequal overlap, nearly coincident ambiguity, holes, vertical fold, self-intersection, non-manifold seam,
  and stale input. Assert no coordinate/Z changes without explicit input.
- Component tests: all panel/table fields; live drag/type sync; UIP-D14 field/drag/tool/tab order; Mixed
  behavior; close keeps draft; discard removes; sync/discard/stay; accessible names; English UI.
- Command tests: exact expected-revision transactions, one-step create/update/ multi-station edits, undo
  restoration scope, no preview-frame journals, dependency invalidation, late job rejection, and heavy
  artifact refs only.

### 8.2 Commit tier

- `pnpm verify:commit` plus markdown/format checks.
- **G-CIV-CATALOG** validates unique ids, dotted lower-case/snake_case leaves, every user act's automation
  path, no duplicate Mesh/View/Draw act, and no shortcut/gesture collision with `REGISTRY.md`.
- **G-CIV-ENGLISH** audits all Civil UI copy when the Builder English gate exists; absence of that gate
  remains a release blocker, not a skip.

### 8.3 Push tier

- **G-CIV-1 — Alignment interaction:** self-launching browser test creates from curve, fits one/two edges,
  cycles candidates, edits grip/table, cancels, commits/undoes, and asserts presented-frame-interval p95 ≤2×
  target plus input-to-visible p95 ≤100 ms. Runs under `browser-gpu` for viewer paths.
- **G-CIV-2 — Profile interaction:** 2,000 controls/10,000 cached stations; pan/zoom, TS drag, station scrub,
  checked-station multi-preview, field focus, stale/sync/view-switch flows; same frame/input thresholds.
  Metric is presented interval, never render-body CPU time.
- **G-CIV-3 — Corridor/slope cold and warm paths:** 10 km and 100 km/100-band cold builds plus warm local
  update; asserts CIV-D22 first-progress/visible-partition/cancel/RSS/disk/completion/restart budgets, burst
  supersession, one-generation publication, affected-only replacement, seams/pick station, stale-target
  rejection, and freeze dropping rebuild work.
- **G-CIV-4 — Pit robustness browser/worker:** visual/error-list linkage for every G-CIV-PIT-UNIT class;
  coincident equality succeeds with provenance; near ambiguity fails and publishes no Mesh draft.
- **G-CIV-5 — Automation parity:** generated SDK can fit/list/edit, open/query profiles, sync/discard, edit
  bands, freeze/unfreeze, create/update slopes, describe/build pit draft, edit station equations/standards,
  manage every recipe, rebase/discard profile drafts, apply layers, and construct/inspect station points; a UI
  and SDK action produce identical journal payload/result.
- **G-CIV-6 — LandXML/provider round trip:** line/arc/clothoid + gradient + bands import, update,
  export/reimport; unsupported circular vertical/band/ slope loss is explicit and source values unchanged; no
  silent catalog prune.
- Browser cross-tests: active clip P4 scopes Civil picking; transform preview updates every world consumer;
  import matched update/removal marks dependants; Mesh draft remains after Civil panel close; project
  replacement rejects late fit/pit publication.

### 8.4 Release tier and capabilities

- **G-CIV-7 — E1 visual certification** (`browser-gpu`): screenshots for every CIV-V1–V12 state in both
  themes, including hover/selected/error/frozen/stale, compared by reviewer and stable pixel/state assertions.
- **G-CIV-SCALE-FIT** (`real-data` + `browser-gpu` where displayed): the 1,000,000-sample/10,000-element
  budget from §4.1, early/late cancel, crash/ restart checkpoint, bounded RAM/disk, and atomic publication.
- **G-CIV-SCALE-PROFILE** (`real-data`): long/cross extraction over a logical 500-million-point streamed
  cloud, recorded corridor sampling, UI response during job, station checkpoints, restart/cancel, and no claim
  of unsampled accuracy.
- **G-CIV-SCALE-PIT** (`real-data`): 1,000 patches/100,000 intersections under §4.4 budgets, source revision
  change mid-run, restart/cancel, exact validation, then Mesh review/commit/undo.
- Release automation uses `automation.sdk`; missing GPU/real-data capability fails rather than skips
  (`docs/TEST-TIERS.md`).

### 8.5 Manual/unverified

Manual: civil-engineer review of candidate usefulness, label density, and profile readability beyond the
failable gates; actual screenshots against §7. Explicitly unverified until implementation: solver convergence
distribution on regional road classes; appropriate default fit penalties/tolerances; subjective comfort of
multi-station editing; translation quality of imported office tables. These are calibration, not permission to
weaken correctness.

## 9. Zero owner-decision items

Count: **0**. Potential questions were dissolved through the doctrine protocol:

- **“Is a Civil tab required?”** Derivation survives: D2 explicitly fixes the tab taxonomy and makes group
  placement tunable; D7 un-defers functionality, not a new tab. CIV-D10 decides Draw/Mesh groups. No
  owner-reserved conflict.
- **“May best fit relax impossible constraints?”** X1 plus the new dossier-wide absence and X6 decide typed
  infeasibility and tunable thresholds (CIV-D2).
- **“Are profiles live?”** P10 directly decides station-defined live versus arbitrary projection
  stale-with-sync (CIV-D7).
- **“What is a generic slope?”** DATA-MODEL/ADR 0016 plus S7 decide a Surface3D derived entity/component and
  alignment-local rule split (CIV-D8).
- **“Who creates corridor/pit surfaces?”** ADR 0016 and MT-D1–MT-D5 decide the Mesh draft/publication hand-off
  (CIV-D5/CIV-D9).
- **“Parabola, arc, or clothoid?”** S9 requires the exact requested grammar, while RIB evidence retains the
  distinct parabola and X1 forbids approximation; schema extension/migration is an architect task, not an
  owner preference (CIV-D6/CIV-D17).
- **“How are repeated stations identified?”** X1 forbids guessing and existing station-origin storage is
  insufficient; monotone chainage plus region/equation side is the lossless construction (CIV-D16).
- **“Must vertical clothoids ship?”** S9 explicitly requires them and X1 forbids a parabola substitute
  (CIV-D17).
- **“Which slope corner/terrain branch wins?”** X1 plus S7's robustness requirement decides an exact branch
  and typed refusal where authority is non-unique (CIV-D20).
- **“What are the cold-build numbers?”** X6 delegates calibration and D1/P5 require bounds/restart, so the
  values are set in CIV-D22 rather than escalated.
- **“Are Civil rules product constants?”** P7 directly makes them versioned office data (CIV-D19).
- **“May passive point info choose the nearest axis?”** X1/X3 require candidates and explicit pinning, while
  one shared inspection act follows X7 (CIV-D24).

No surviving item is an axiom conflict, product identity/scope/money/licensing choice, or owner-reserved
boundary.

## 10. Cross-spec cite-and-revise results (2026-09-02)

The round-3 transaction applied the owning-spec and Registry items below. The
schema/ADR bundle remains a pending architect admission and is not invented here.

1. **Received:** Draw DR-D19/DR-D20 now consumes Civil station/offset semantics and the shared P10 recipe while
   retaining `draw.point` and primitive authoring. The Registry registers the shared station/offset mode as
   an access contribution, not `civil.point.station-offset` as a second act.
2. **Received:** View VD-D15 owns the line-derived rigid section and explicitly leaves alignment profiles to
   Civil.
3. **Received:** Mesh MT-D25/MT-D26 owns the surface-side dependency record, accepts typed Civil corridor/pit
   manifests, and remains the sole `mesh.create-surface` publication owner. The Registry carries no duplicate
   Civil surface act.
4. **Received:** Pointcloud PC-D18 owns bounded station-corridor sampling from exact Civil revisions.
5. **Received:** Select/Edit SE-D20 emits the Civil invalidation set once at gesture end.
6. **Recorded pending, not admitted:** REGISTRY §4.4 mirrors the DATA-MODEL admissions for the contracts in §11.9:
   shared Civil recipe, fit/report, secondary-axis relation, station equations/regions/references, exact
   Circular and Clothoid vertical members, generic slope derivation, profile definition/cache manifest, pit
   manifest, and Civil standards library. Implementation may not invent substitutes meanwhile.
7. **Applied:** REGISTRY includes the non-shared §1 rows, shared access contributions, §5.1 gestures, and §11.8 gates; the future-Civil queue is removed and `view.station` remains distinct.
8. **Applied:** Measure/Inspect extends the one `inspect.point_info` result with the optional Civil member and the Registry records the access contribution.
9. **Applied:** UI Platform, Measure/Inspect, Civil, every normative gesture table, and REGISTRY use Tab/Shift+Tab for construction input and Up/Down for a live candidate set.
10. **Applied:** Import Formats/File carry the exact station-equation, vertical-clothoid, recipe, standards-version,
    and unsupported-loss contracts in §11.2/§11.3/§11.9, including `.hcad/.hcadx`, LandXML, restore, and
    strict-reader behavior.

## 11. Normative review amendments

This section is normative and amends the earlier workflow/contract text where it is more specific. It is not
an implementation claim.

### 11.1 One Civil dependency recipe (CIV-D15)

Every accepted best-fit axis, fitted or traced gradient, promoted width-band axis, corridor manifest, generic
or alignment-edge slope, pit manifest, named profile trace, and station/offset point has exactly one
`hcad.derived-recipe@1` record governed by MT-D25, with a Civil-owned typed payload and result semantics from
CIV-D15. A station-authored alignment with no derived source has no recipe merely for being an alignment. A
materialized surface has one separate output recipe governed by MT-D25 that references the upstream Civil
recipe id/generation; it is never a second recipe for the same output and never creates a second surface
publication command.

The persisted recipe contains `recipe_id`, `recipe_kind`, `output_id`, output type and stable component/
manifest `output_locator` where the derivative is part of an alignment, ordered
`source_refs[{entity_id, revision, version_hash, role, placement_revision}]`, typed parameters, bound
`civil_standard_id` and revision, algorithm/schema versions, dependency recipe ids, state
`linked-current | linked-stale | detached`, monotonically increasing generation, last-successful output
revision/content hash, and the last typed creation/regeneration error. `detached` retains all recipe fields as
provenance but removes dependency edges. The recipe graph is validated as a DAG in the same command preflight
that validates revisions; a cycle rejects the whole command.

At the transaction end of a source gesture, SE-D20 invalidation marks affected recipes stale once. It never
regenerates mid-drag. The last successful artifact remains visible with a **Stale** badge. A system-authored,
journaled regeneration may run automatically only when the estimator predicts at most 50 ms worker CPU,
16 MiB additional resident memory, no external sampling/Mesh check, and a unique mapping; otherwise
**Regenerate**, **Regenerate selected**, or **Regenerate all stale** starts a cancellable batched job. These
initial X6 thresholds and the 150 ms post-gesture coalescing window are tunable. Regeneration publishes only
after source-revision, recipe-generation, standard-revision, and output CAS checks. Failure preserves the
last-good artifact and uses the exact creation error list. Missing/deleted source auto-detaches the last-good
result and writes a console event naming recipe, source, revision, and recovery action; it never cascade-deletes
the output.

`derived.recipe.get/list/status`, `derived.recipe.regenerate`,
`derived.recipe.regenerate_batch`, `derived.recipe.detach`, and
`derived.recipe.relink` are the MT-D25 canonical query/commands consumed here.
Civil-specific payload validation and result semantics remain CIV-D15; there is no
`civil.recipe.*` exposure. Detach, relink, automatic regeneration, and
explicit regeneration are journaled document transactions; one batch is one undo root with per-item results.
Undo/redo restores recipe edges/state, last-good artifact reference, error, and output revision together.
Save/reload stores recipes and last-good hashes and revalidates their edges before showing `linked-current`.
Heavy artifacts stay content-addressed and reachable through recipe, draft, checkpoint, and undo roots.
G-CIV-CORE and G-CIV-5 run the same source-edit, source-deletion, failed-regeneration, detach, detach-undo,
reload, and UI/Python parity matrix for best-fit axis, gradient, promoted width-band axis, corridor manifest,
generic and alignment-edge slope, pit manifest, named profile trace, and station/offset point.

Drafts never modify sources. The allowed inverse mapping is explicit:

| Recipe kind              | Mapping back to source                                                                       | View-switch confirmation                     |
| ------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| best-fit axis            | none; edit recipe constraints/output or detach before free geometry editing                  | only if the fit draft has pending edits      |
| fitted gradient          | none to sampled terrain/cloud; station-space edits change the alignment/gradient recipe only | only if the vertical draft has pending edits |
| promoted width-band axis | none to the surveyed source curve; editing the secondary axis changes its recipe/output      | only if its profile draft has pending edits  |
| corridor manifest        | none from preview or Mesh result to alignment/bands                                          | never for staleness alone                    |
| slope                    | none from solved mesh to boundary, BIM face, or target surface                               | never for staleness alone                    |
| pit manifest             | none from lower envelope to bases/slopes                                                     | never for staleness alone                    |
| station/offset point     | station/offset parameters edit the point recipe; the point never edits the alignment         | only while point construction is pending     |
| projected profile curve  | only the stored one-to-one anchor inverse reviewed in §11.7; otherwise no inverse            | only if pending projected edits exist        |

**Decision:** one recipe/state machine governs all accepted Civil derivatives and cites MT-D25 for the surface
side; linked is the default, source loss auto-detaches, and switch confirmation concerns pending edits only.
**Derivation:** extended P10, P5, X1–X3, SE-D20, MT-D25/MT-D26, Draw DR-D19/DR-D20.
**Rejected:** provenance-only accepted results; per-entity lifecycle variants; mid-gesture rebuilding; drafts
that mutate sources; confirmation merely because a reference is stale. **Tunable:** automatic budget,
coalescing, batch size, and retention horizon under X6.

### 11.2 Unambiguous station equations and references (CIV-D16)

Geometric location is always monotone internal `chainage` in `[0, alignment_length]`; displayed station is a
formatted projection and never geometric authority. `hcad.civil.stationing@1` stores `origin_station`,
stationing direction, stable first-region id, and an ordered, versioned table of equations. Each equation has
stable `equation_id`, stable `before_region_id` and `after_region_id`, strictly increasing `chainage`, a
zero-based `equation_index` in current chainage order, `back_station`, and `ahead_station`. Adjacent equations
must share the intervening region id. Region ids, not display numbers, make repeated values unique. Between
equations, display station advances from the region's start value by signed chainage delta.

Every persisted station-bearing value—vertical/band samples and ranges, fit ranges, profile stations, labels,
corridor partitions, slope-rule ranges, and station points—stores chainage. A durable external reference is:

```text
StationReferenceV1 {
  alignment_id, alignment_revision, chainage,
  region_id, equation_id?, equation_side: none|back|ahead,
  captured_display_station
}
```

At an equation chainage the UI shows both values, for example `10+000.000 back [EQ-3]` and
`12+000.000 ahead [EQ-3]`. Elsewhere it shows the office-standard label plus a region suffix only when the
same display value has multiple geometric candidates. Typed entry accepts the displayed number followed by a
region id, or equation id plus `back|ahead`; a bare displayed number is accepted only when it resolves to one
chainage. Ambiguous, out-of-domain, deleted-region, and stale-alignment inputs are typed errors with candidate
rows; the application never chooses nearest. Canvas snaps carry the complete reference, not the label string.

Automation uses the structure above, never a scalar station alone. Queries
`alignment.stationing.get/resolve/format` return every candidate with chainage, region/equation identity, side,
world point, and revision. Commands `alignment.station_equation.create/update/delete` and
`alignment.stationing.reverse` are expected-revision journal transactions. The table and canvas share these
commands; batch CSV import/export uses stable ids, chainage, back/ahead pairs, direction, and label-standard
revision. Editing an equation never moves referenced geometry: chainage survives, display/region bindings are
recomputed and previewed; stable region ids are retained where boundaries survive, and merged/deleted ids are
reported before commit. Reversal maps every physical reference to `length - chainage`, reverses equation order
and sides, and previews all label changes; reset-stationing is a separate explicit option.

LandXML import preserves supported equations and creates stable ids. Export writes them when the selected
provider profile supports them; otherwise `io.export.plan` reports exact equation/reference losses and blocks a
lossless claim. Old scalar-origin projects migrate to one region with no equations. Invalid ordering or
non-finite pairs blocks load as a typed repair item; repair may remove/replace an equation only through a
reviewed command and may never relocate geometry. This schema is explicitly requested for the
`docs/DATA-MODEL.md` pending-admissions list and requires an accepted ADR before implementation.

**Decision:** chainage is the sole geometric coordinate; equation/region identity disambiguates displayed
stations everywhere. **Derivation:** X1, X3, owner S9, FUNCTION-CONTRACT A1/B1/C4, DATA-MODEL missing-Z and
command-authority rules. **Rejected:** scalar display station as identity; nearest-region guesses; rewriting
geometry when an equation changes. **Tunable:** label format/precision only, through CIV-D19.

### 11.3 Exact vertical clothoid (CIV-D17)

The vertical grammar retains Grade and Parabolic, adds CIV-D6 Circular, and adds a distinct Clothoid member.
The Clothoid stores start chainage/elevation, start tangent angle (or exactly equivalent grade), signed start
and end curvature, and positive profile arc length `L`. For profile arc parameter `s` in `[0,L]`,
`k(s)=k0+(k1-k0)s/L`, `theta(s)=theta0+k0*s+(k1-k0)s^2/(2L)`, station is
`station0 + integral(0..s, cos(theta(t)) dt)`, and elevation is
`elevation0 + integral(0..s, sin(theta(t)) dt)`. This formula is the authority; deterministic Fresnel
evaluation is an implementation technique, not a different curve.
The validator requires finite values, positive length, monotone station (`cos(tangent_angle) > 0` over the
whole member), exact position/tangent continuity, and the declared curvature continuity at connected members.
Equal start/end curvature is a Circular member; both zero is a Grade. These degeneracies are converted only by
an explicit previewed command, never silently at deserialization.

UI construction and the vertical table accept start/end curvature, length, and the equivalent clothoid-A
parameter `A=sqrt(L/abs(k1-k0))` with curvature direction shown separately; changing one representation
updates the others. Orientation/crest/sag is explicit.
Snapping exposes endpoints, tangent intersections, and declared curvature-continuity points. Tessellation is
adaptive against a recorded chord/grade error and never changes analytic storage. LandXML writes an exact
member only for a provider profile that supports it; otherwise the export plan reports
`unsupported_vertical_clothoid` and offers an explicitly lossy copy, never a parabola substitute. Migration,
generated TypeScript/Python schemas, validation, persistence, undo, and reload must precede UI enablement.

**Decision:** owner-required vertical clothoids are exact analytic members alongside Grade, Parabolic, and
Circular. **Derivation:** owner S9; X1, X3, X5; current absence at `entity_model.rs:879-895`.
**Rejected:** omission; parabolic/circular approximation; an untyped Draw curve in profile space.
**Tunable:** tessellation error and default input representation, never analytic identity.

### 11.4 Fit-session generations and recoverable automation (CIV-D18)

A horizontal or vertical fit draft has stable `session_id`, monotonically increasing `input_generation`,
captured source revisions, constraint hash, solver id/version, selected candidate id, result generation, and
draft revision. Each
committed field edit increments the input generation immediately; scheduling is debounced 150 ms, and the
previous worker is cancelled or superseded. An old result may remain visible as **Stale result** but is not
selectable for acceptance. Publication and `alignment.fit.accept` compare session id, input generation,
source revisions, constraint hash, solver version, and candidate id. Any mismatch returns
`stale_fit_generation` without a document write. Out-of-order workers can checkpoint immutable data but can
never replace the current candidate list.

The canonical parity inventory is:

- `alignment.fit.session.create/update/cancel/get`, `alignment.fit.candidate.list/select/accept`,
  `alignment.vertical.fit.session.create/update/cancel/get`, and
  `alignment.vertical.fit.candidate.list/select/accept`;
- `alignment.fit.draft.list/open/rename/discard`, `alignment.fit.source.freeze`,
  `alignment.vertical.fit.draft.list/open/rename/discard`, and `alignment.vertical.fit.source.freeze`;
- `derived.recipe.get/list/status/regenerate/regenerate_batch/detach/relink` from MT-D25/§11.1;
- `alignment.stationing.get/resolve/format` and station-equation commands from §11.2;
- `alignment.band.import/export`, `alignment.vertical.import/export`, and
  `alignment.layer_policy.apply_existing`;
- `profile.conflict.describe/rebase_preview/commit`, `profile.draft.discard`, and `profile.draft.stay` from
  §11.7; and `civil.standard.*` from §11.5.

Every result carries stable ids, source/input/result generations, expected/current revisions, progress/job and
cancellation ids when applicable, warnings, and typed errors. UI, console, embedded agent, and generated Python
SDK call these exact contracts. Freeze source creates immutable local geometry with source provenance; it does
not merely pin a worker buffer. A restored checkpoint is accepted only when all captured inputs still match;
otherwise it is visibly stale and must be revalidated. Closing preserves the named draft; list/open/rename and
discard make that recovery discoverable outside the UI.

**Decision:** latest committed fit input generation alone may publish or be accepted, and every recoverable UI
state has canonical query/command parity. **Derivation:** X1, X3, P1, P5, FUNCTION-CONTRACT B1/C4/D1/E2.
**Rejected:** source-CAS-only acceptance; last-worker-wins publication; anonymous/UI-only drafts.
**Tunable:** 150 ms debounce and checkpoint cadence under X6.

### 11.5 Versioned Civil standards and complete table interchange (CIV-D19)

`hcad.civil.standard@1` is editable office/project data. A named version contains fit constraint/check sets,
transition and ramp-generation policies, station label format/precision/equation-side notation, geometric
tolerances, and layer/specification templates. It has a shipped editable seed, schema version, stable id,
revision, units, provenance, validation diagnostics, and migration history. A project binds one default
revision; each recipe captures the exact revision it used. Editing a standard creates a new revision and marks
only dependent recipes stale under CIV-D15. It never rewrites geometry implicitly.

The standards library window supports create/clone/edit/validate/preview/name/default, JSON and tabular
import/export, project binding, and migration preview through `civil.standard.*`. `Apply to existing` is an
explicit expected-revision batch command with per-entity preview and one undo root. Vertical elements,
width/crossfall bands, station equations, and fit constraints each have lossless CSV/table import and export;
canvas and table edit the same canonical commands. Unsupported policy columns or unknown units block import
until mapped; no office convention is hard-coded.

**Decision:** every variable Civil convention is versioned user data and every station-based table has batch
interchange parity. **Derivation:** P7, X3–X5, `rib-civil.md` §2.3–§2.5/§2.7.
**Rejected:** prose defaults, regulation logic in code, Civil-private layer state, canvas-only data entry.
**Tunable:** shipped seed values and visible default columns; the mechanism is not tunable.

### 11.6 Deterministic slope and pit topology (CIV-D20)

For an oriented source boundary, the user confirms outward side and cut/fill role. On each smooth edge with
source point `c(u)`, unit plan normal `n(u)`, signed outward distance `d >= 0`, and declared vertical/horizontal
ratio `q`, the slope is `S(u,d) = (c.xy + d*n, c.z + q*d)` until the finite solve boundary or authoritative
terrain hit. Mixed winding, zero-length edges, non-finite Z, and an outward side inconsistent across a closed
loop are creation errors.

The initial seam/Z tie tolerance is the larger of 1 mm converted to project length units and `1e-9` times the
finite solve-boundary diagonal; it is stored in the recipe/standard and is tunable under X6. At a convex
vertex, the missing sector is a radial fan centered on the exact vertex with the same `q`; angular
subdivision is tessellation only. At a concave vertex, adjacent panels are intersected and trimmed on the
nearest-source/equal-distance bisector, never overlapped. A tie whose candidate Z values differ beyond the
project-unit tolerance is `ambiguous_concave_corner`. Obtuse corners use the same convex-fan or concave-trim
classification, not a special heuristic. Open ends terminate on the explicit end-normal cap or solve boundary.
After patch construction, exact-or-adaptive robust predicates trim all self-intersections; inconsistent
orientation, non-manifold seams, uncovered regions, or adjacency gaps above tolerance fail. Equal coincident
patches deduplicate with all provenance. No gap is bridged or snapped without a reviewed parameter change.

For target-terrain termination, each `(u,d)` ray searches increasing `d`. The authoritative hit is the first
finite transversal intersection whose signed crossing matches the declared cut/fill role. An isolated tangent
that does not cross, a coincident interval, NoData/hole before a hit, absence within the solve boundary, or
multiple non-identical first hits within tolerance is a typed highlighted error. Later intersections are
reported but do not replace the first valid hit. If cut/fill role does not disambiguate the branch, creation
fails. The creation/regeneration list uses stable codes:
`mixed_winding`, `zero_edge`, `unknown_source_z`, `ambiguous_concave_corner`, `self_intersection`,
`non_manifold_seam`, `coverage_gap`, `terrain_no_hit`, `terrain_tangent`, `terrain_coincident`,
`terrain_nodata`, and `terrain_multiple_first_hits`.

Pit lower-envelope construction first requires every input slope/base to pass these rules; it then applies
CIV-D9's cell-wise lower-Z arrangement. The pit recipe records corner branch, hit classification, tolerance,
and errors. Exact fixtures cover convex, concave, and obtuse corners; mixed winding; two terrain crossings;
tangent/coincident contact; holes/NoData; self-intersection; and values immediately below/at/above tolerance.

**Decision:** signed-distance panels plus convex fans, concave trimming, and first role-valid transversal
terrain hits define the only successful topology branch. **Derivation:** X1, owner S7, CIV-D9, MT-D3/MT-D25,
and the whole-dossier absence audit in §4.4 A2. **Rejected:** triangle-soup union, nearest-vertex stitching,
first enumerated triangle, tangent acceptance, and heuristic gap filling. **Tunable:** robust tolerance and
tessellation density under X6; branch selection is not tunable.

### 11.7 Revision-safe profile drafts and rebase (CIV-D21)

Every open profile/vertical draft captures `alignment_id`, horizontal revision/version hash, station-region
map hash, all projected source revisions, draft revision, input generation, and last-good overlay hash. A
horizontal edit, reversal, station-equation edit, or source deletion marks it stale at the source gesture's
transaction end and preserves the last-good overlay. Projection/rebase jobs are generation-numbered,
cancellable within 500 ms, and superseded by newer revisions.

**Synchronize** means `profile.conflict.describe` followed by a deterministic `rebase_preview` onto a named
new horizontal revision. The preview lists preserved, moved, split, out-of-domain, deleted-region, ambiguous,
and unmappable elements and shows old/new world coordinates. Nothing writes during preview. **Apply rebase**
uses compare-and-swap over the old/new horizontal revisions, region-map hash, source revisions, and draft
revision and commits the rebased profile as one journal transaction. Any unmappable element blocks commit
unless the user explicitly removes it from the profile draft; it is never clamped to an endpoint.

**Discard profile edits** discards only the named profile/vertical draft and restores its last-good overlay. It
never undoes a separately committed horizontal/source edit. **Stay** keeps the stale draft open and blocks
profile commit. View switching and close ask Synchronize/Discard profile edits/Stay only when pending edits
exist; a stale read-only trace alone never blocks switching. Save/reload restores the captured revisions and
same choice. Source loss uses CIV-D15 auto-detach for accepted products and a typed conflict for open drafts.
Tests cover horizontal shorten, reversal, station-equation edit, source deletion, cancel/supersession, CAS
failure, discard scope, close/reload, undo/redo, and UI/Python parity.

**Decision:** profile synchronization is a previewed CAS rebase; Discard is draft-only and stale-only views do
not demand confirmation. **Derivation:** P10, P8, X1, X3, X5, owner S8, FUNCTION-CONTRACT C4/E2.
**Rejected:** silent reprojection, source undo hidden behind Discard, committing a stale draft, confirmation on
every stale view switch. **Tunable:** worker partition/debounce only.

### 11.8 Bounded corridor cold build and creatable gates (CIV-D22)

The maximum supported fixture is 100 width/crossfall bands. A cold corridor build is a background,
generation-numbered job partitioned into station ranges no longer than 100 m with at most four computed and
two unpublished partitions in flight. It publishes validated partitions progressively in station order. A
first build is visibly **Building N%**; an update keeps the complete last-good revision visibly **Stale** until
the new generation is complete. It never presents a mixture as one current corridor. A newer alignment,
band, standard, or target revision cancels/supersedes old work; stale partitions fail the publication CAS.
Eviction is deterministic least-recently-visible among unpinned content hashes, while active/selected and undo/
checkpoint roots are pinned.

On the recorded `browser-gpu` reference runner (hardware inventory emitted with results), the 10 km/100-band
cold fixture must show first real progress within 250 ms, first validated visible partition within 1 s,
acknowledge cancellation within 500 ms, use at most 2 GiB additional RSS and 8 GiB staged disk, and complete
all partitions within 120 s. The 100 km/100-band stress fixture has the same first-progress/cancel/resource
bounds and a 20 minute completion budget. Checkpoints are content-addressed after each 1 km of contiguous
validated station range and resume only for the exact recipe generation. Completion means every supported
station range is present, same-generation seam/topology validation passes, the recipe points to the manifest,
and no job-owned unpublished artifact remains. Failure is a visible hard job error preserving the last-good
stale result; on a first build it leaves no canonical corridor. These X6 values are tunable, but boundedness,
cancellation, restart, and atomic current-state truth are not.

All paths in this table are **to be created**. Each command self-launches from a clean checkout, invokes
`scripts/verification/run-civil-gate.mjs --gate <id>`, uses
`scripts/fixtures/generate-civil-fixture.mjs --gate <id>`, writes
`.build/verify/civil/<id>/result.json` plus captures where visual, and fails—never skips—when its required
capability is absent.

Synthetic fixtures are generated deterministically from the gate id and recorded seed. Real-data gates read
`testdata/civil/manifest.json` (to be created), which records source/license permission, immutable hash, CRS,
units, expected extent, and allowed redistribution for each fixture; a missing or hash-mismatched manifest is
a hard failure.

| Planner id            | Named command                                     | Capability              | Required assertion/artifact                                        |
| --------------------- | ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `G-CIV-CORE`          | `pnpm verify:civil -- --gate G-CIV-CORE`          | portable                | schemas, equations, recipes, vertical members, round trips         |
| `G-CIV-FIT-UNIT`      | `pnpm verify:civil -- --gate G-CIV-FIT-UNIT`      | portable                | deterministic fits and independent residual report                 |
| `G-CIV-PIT-UNIT`      | `pnpm verify:civil -- --gate G-CIV-PIT-UNIT`      | portable                | every CIV-D20 topology/error fixture                               |
| `G-CIV-CATALOG`       | `pnpm verify:civil -- --gate G-CIV-CATALOG`       | portable                | one-row-per-act, commands, sibling ids, gesture map                |
| `G-CIV-ENGLISH`       | `pnpm verify:civil -- --gate G-CIV-ENGLISH`       | portable                | English UI audit, fail if host absent                              |
| `G-CIV-1`             | `pnpm verify:civil -- --gate G-CIV-1`             | `browser-gpu`           | fit generations, input p95 ≤100 ms, frame p95 ≤2× target           |
| `G-CIV-2`             | `pnpm verify:civil -- --gate G-CIV-2`             | `browser-gpu`           | profile rebase/discard/reload and same latency bounds              |
| `G-CIV-3`             | `pnpm verify:civil -- --gate G-CIV-3`             | `browser-gpu`           | 10/100 km cold/warm, burst supersession, budgets above             |
| `G-CIV-4`             | `pnpm verify:civil -- --gate G-CIV-4`             | `browser-gpu`           | topology diagnostics linked to viewport; no draft on failure       |
| `G-CIV-5`             | `pnpm verify:civil -- --gate G-CIV-5`             | `browser-gpu`           | UI/Python command/result/journal parity for full §11.4 inventory   |
| `G-CIV-6`             | `pnpm verify:civil -- --gate G-CIV-6`             | portable                | LandXML exact round trip and explicit equation/clothoid/loss plans |
| `G-CIV-7`             | `pnpm verify:civil -- --gate G-CIV-7`             | `browser-gpu`           | CIV-V1–V12 both-theme PNGs and state assertions                    |
| `G-CIV-SCALE-FIT`     | `pnpm verify:civil -- --gate G-CIV-SCALE-FIT`     | `real-data,browser-gpu` | §4.1 budget, cancel, restart, stale-accept refusal                 |
| `G-CIV-SCALE-PROFILE` | `pnpm verify:civil -- --gate G-CIV-SCALE-PROFILE` | `real-data`             | 500M logical cloud, checkpoint/restart/NoData honesty              |
| `G-CIV-SCALE-PIT`     | `pnpm verify:civil -- --gate G-CIV-SCALE-PIT`     | `real-data`             | §4.4 resource/revision/topology/commit bounds                      |

**Decision:** cold corridor evaluation is bounded, progressively published by station generation, restartable,
and covered by a named creatable gate rather than a warm-cache assertion. **Derivation:** FUNCTION-CONTRACT D1,
P5, X1, X2, X6. **Rejected:** all-partitions-before-publication, UI-thread build, mixed generations, restart from
zero. **Tunable:** numeric budgets and partition/in-flight counts.

### 11.9 Schema admission, persistence, compatibility, and repair (CIV-D23)

Current implementation is narrower than the specification: `AlignmentGeometry` stores horizontal geometry,
Grade/Parabolic verticals, scalar origin, station functions, and alignment-local slope rules
(`entity_model.rs:871-959`). It has no fit report/recipe, secondary-axis reference, station equations/regions,
station-reference relation, Civil standards profile, generic slope component, profile/pit manifest, Circular,
or Clothoid vertical member. A generic `EntityRelation` is not evidence of any typed Civil relation.

The pending admission bundle is:

| Schema                                | Required authority and compatibility behavior                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hcad.derived-recipe@1` Civil payload | CIV-D15 typed meaning/output rules within MT-D25 state/DAG/last-good/error; unknown kinds preserved but not regenerated |
| fit recipe/report/session draft       | exact samples/constraints/generation/solver/report; heavy hashes, no JSON bulk payload                                  |
| secondary-axis relation               | main/secondary/source ids+revisions, band role, recipe id, offset policy                                                |
| stationing/equation/reference         | CIV-D16 identities, commands, format and migration                                                                      |
| vertical Circular/Clothoid            | CIV-D6/CIV-D17 exact analytic fields and loss behavior                                                                  |
| `hcad.civil.slope-derivation@1`       | source/topology/hit branch, CIV-D20 errors and last-good hash                                                           |
| corridor/pit/profile manifests        | typed station partitions/sources/recipe generation; Mesh MT-D25 reference where materialized                            |
| `hcad.civil.standard@1`               | CIV-D19 versioned user data and binding                                                                                 |

Rust/Serde is the source schema; generated TypeScript, automation JSON Schema, and Python SDK must be regenerated
from it. Validators reject non-finite values, stale refs, invalid station regions, recipe cycles, incompatible
standard units, and topology errors before publication. `.hcad` and `.hcadx` preserve every admitted field and
unknown extension losslessly; snapshot restore and undo/redo retain last-good artifact roots. Migrations are
versioned and idempotent. Repair can relink, detach, rebind a station region without moving chainage, or discard
an invalid draft after preview; it never fabricates geometry, revisions, equations, or CRS truth. Export plans
name every unsupported semantic field. Strict older readers preserve unknown extensions or refuse safely.
Implementation is blocked until DATA-MODEL lists this bundle and an accepted ADR assigns versions/invariants.

**Decision:** Civil semantics receive typed, generated, migratable schemas; generic relations and geometric
result storage are not substitutes. **Derivation:** X1, X3, DATA-MODEL/ADR 0016/0019, FUNCTION-CONTRACT A2/A3/C4.
**Rejected:** hiding semantics in attributes/generic relations; UI-only draft stores; implementing ahead of
admission. **Tunable:** no.

### 11.10 Passive Civil point information (CIV-D24)

Civil contributes an optional `civil` member to the shared `inspect.point_info` result and the bounded query
`alignment.station_offset.describe`; it does not define a second point-info act. Input is exact world point,
P4-visible scope, optional pinned/active alignment id, search radius, and page limit. Each candidate returns
alignment id/name/revision, internal chainage, displayed station, region/equation side, signed offset and side
convention, perpendicular distance, axis direction, resolved XYZ, Z acquisition/source/revision or NoData,
and ambiguity diagnostics.

An active or explicitly pinned valid alignment is used first. Without one, zero candidates shows no Civil row;
one candidate may display directly; multiple qualifying alignments show a named candidate list and require
selection. Distance or list order never silently decides authority. Repeated station display values remain
distinct through CIV-D16. Results are revision-bound, paged, cacheable only by point/scope/alignment revision,
and available identically to status bar, Measure/Inspect panel, console, embedded agent, and Python.

**Decision:** shared point information gains a bounded optional Civil contribution with explicit ambiguity.
**Derivation:** X1, X3, X7, RIB Tachobox/Achskleinpunkt (`rib-civil.md` §2.1–§2.2), MI-D14 shared-consumer
boundary. **Rejected:** tool-only station readout; unconditional nearest alignment; a duplicate inspection act.
**Tunable:** search radius/page size and compact status-bar presentation.

## Cross-spec reconciliation 2026-09-02

| Item                                            | Disposition                                                                                                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draw and View inbound citations                 | DR-D19/DR-D20 consume CIV-D15/CIV-D16 without a second point or recipe act; VD-D15 retains rigid line sections while CIV-D7/CIV-D12 own station/offset profiles.                                                                          |
| Mesh and Pointcloud hand-offs                   | MT-D25/MT-D26 own common recipe/surface publication and accept Civil manifests; PC-D18 owns bounded station-corridor sampling consumed by CIV-D24/profile workflows.                                                                      |
| Select/Edit and Measure invalidation/inspection | SE-D20 emits Civil invalidations once at gesture end and CIV-D15 consumes them; MI-D14 now accepts CIV-D16/CIV-D24's optional branch-explicit station/offset result.                                                                      |
| Common P10 lifecycle                            | CIV-D15 uses exactly one MT-D25 `hcad.derived-recipe@1` per Civil output and the common `derived.recipe.*` family; a materialized Mesh output has its own recipe referencing the upstream Civil recipe, never two recipes for one output. |
| File/Import compatibility                       | FP-D22 and IF-D18 cite Civil persistence, migration, circular-vertical loss, strict-reader preservation, and owner-side invalidation; CIV-D23 remains the typed schema admission gate.                                                    |
| Tab/gesture and cursor sweep                    | CIV-D1 follows Tab/Shift+Tab focus traversal, Up/Down live candidate cycling, UIP-D14 Escape, and UIP-D24/§9.7 cursor vocabulary (including Shared3DTarget only where point/plane input applies) with no contrary claim.                  |
| GAP §6.2 inbound matrix                         | Reciprocal rows now name the required legacy record families in Draw, UI, View, Pointcloud, Mesh, Select/Edit, BIM, Raster, File, Import, Plan, Measure, and Agent; Registry §4.3 records the same Civil hand-offs.                       |

## 12. Disposition — adversarial review 2026-09-02

All 16 findings are resolved in this specification; none is deferred. The §10
reciprocal edits and Registry promotion are complete; schema admissions remain
explicit implementation prerequisites, not unresolved Civil behavior or owner questions.

| Finding id  | Disposition                                                                                                                                                                             | Spec section / decision id                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1 (blocker) | Resolved with one persisted P10 lifecycle for every derived Civil class, surface-side MT-D25 citation, commands, DAG, source loss, last-good/error, persistence and inverse-map table.  | §11.1; CIV-D15                                    |
| 2 (blocker) | Resolved with monotone chainage, stable equation/region identity, back/ahead pairs, display/typed/automation rules, commands, migration/loss, and DATA-MODEL request.                   | §11.2/§11.9; CIV-D16/CIV-D23                      |
| 3 (blocker) | Resolved with bounded 10 km and 100 km cold builds, progressive station partitions, cancellation/supersession, resource/restart/completion budgets, and creatable gate.                 | §11.8; CIV-D22; G-CIV-3                           |
| 4 (blocker) | Resolved throughout and reciprocally: Tab/Shift+Tab is construction input; ↑/↓ is live candidate cycling in every normative spec and Registry map.                                      | §2.1/§2.2/§2.6, §4 C1, §5.1, CIV-V11, §10; CIV-D1 |
| 5 (blocker) | Resolved with captured revisions/region hash, stale-at-gesture-end, deterministic previewed CAS rebase, draft-only Discard, Stay/close/reload and automation.                           | §11.7; CIV-D21                                    |
| 6 (blocker) | Resolved with mathematical panels, convex fans, concave trims, topology validation, authoritative terrain hit and shared creation/regeneration errors.                                  | §11.6; CIV-D20                                    |
| 7 (major)   | Resolved by narrowing current claims and specifying typed admission, serializer, validation, migration, repair, loss, command and generated-schema obligations.                         | §0/§1, §6, §11.9; CIV-D23                         |
| 8 (major)   | Resolved with the complete canonical fit/draft/freeze/recipe/layer/station/profile/standards command and query inventory and result envelope.                                           | §11.4; CIV-D18                                    |
| 9 (major)   | Resolved reciprocally: DR-D19/DR-D20, MT-D25/MT-D26, VD-D15, PC-D18, SE-D20, every GAP §6 inbound owner citation, and the no-duplicate Registry rows are landed.                        | §0/§1/§10; cross-spec reconciliation table        |
| 10 (major)  | Resolved with an exact vertical Clothoid analytic member, construction/table/snap/serialization/loss/migration/tests while retaining distinct Parabolic and Circular members.           | §2.2/§11.3; CIV-D17                               |
| 11 (major)  | Resolved with honest partial/deferred dossier sub-capabilities and a versioned editable Civil standards library plus table import/export.                                               | §3.2/§3.4/§11.5; CIV-D19                          |
| 12 (major)  | Resolved by identifying every gate as not yet present and specifying one clean-checkout runner, fixture generator, command, capability, artifacts, assertions and fail-not-skip policy. | §8/§11.8; CIV-D22                                 |
| 13 (major)  | Resolved as an optional Civil extension of shared `inspect.point_info`, with bounded candidates, station identity, pin/ambiguity policy and automation parity.                          | §11.10/§10.8; CIV-D24                             |
| 14 (major)  | Resolved with stable fit session/input generations, debounce/cancel/supersede, stale non-committable results, multi-key acceptance CAS and restore tests.                               | §11.4; CIV-D18                                    |
| 15 (minor)  | Resolved by distinguishing specified shared act from callable code, narrowing fit-schema claims, and splitting exact renderer slope/alignment ranges.                                   | §0/§1/§6.1                                        |
| 16 (minor)  | Resolved with a whole-`rib-civil.md` topology absence audit and the exact §2.4/W3 station-label citation.                                                                               | §4.4 A2/§4.5 A2                                   |
