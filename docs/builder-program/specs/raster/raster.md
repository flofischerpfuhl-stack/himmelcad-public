# Raster tab — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2 and PhotoLab arrivals. Document class: plan. This document walks the
CURRENT `docs/FUNCTION-CONTRACT.md` per function group and uses the decision-
record form from `docs/DECISION-DOCTRINE.md`. It claims Raster-owned behavior
only; cross-domain capabilities are cited, not re-dispositioned.

Primary reference evidence: `dossiers/rib-civil.md` §2.3, §2.9, W2, §5
(background plans, raster placement, transparency); `dossiers/realworks.md`
§2.7–§2.8, W6, §5 (ortho and image artifacts). Trimble Perspective §2.2
and §5 documents elevation colouring with typed minimum/maximum for point
clouds; Raster adopts that interaction evidence for authoritative
ElevationSurface heights, with the domain deviation stated in §1.2. A
dossier-wide search of all four dossiers found no draping, hillshade, or
raster crop behavior (`realworks.md` §1–§7; `rib-civil.md` §1–§6; `revit.md`
§1–§7; `trimble-perspective.md` §1–§7). Those are stated additions grounded
below in ADR 0020 and current code, never reference claims.

Interlocks: Pointcloud PC-D9 owns ortho generation and names Raster as artifact
owner; View VD-D8 owns the two-layer display model; Draw DR-D4/DR-D12/DR-D13
own layer locking and snap-source semantics; Mesh MT-D6/MT-D12 owns elevation-
surface display and terrain consumption; File FP-D5 owns export-plan honesty;
UI Platform §3.6/UIP-D10/UIP-D14 own gestures, jobs, and Escape. E1's in-repo
reference artifact is §8.

## 1. Registry-ready function catalog

Ribbon: **Raster**. Groups: **Place**, **Appearance**, **Edit**, **Convert**.
R = ribbon, X = entity context menu, P = Properties, C = console, A = agent and
Python automation. The labels and command spellings below are exact for this
spec and adopt F8's schema-verified dotted lower-case/`snake_case` convention;
no surface acquires a second command. None receives a keyboard shortcut:
these are selection-contextual, low-frequency operations with no cited
reference binding; the registry may assign one later only from usage evidence.

| Id                    | Tab · group         | Access paths                                                                                       | Surface                                   | Perf                                  | Automation command                                          | Status vs current implementation                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raster.display`      | Raster · Appearance | R **Monochrome** (toggle; off = Source); P **Color** / **Opacity**; X **Display properties**; C; A | Properties group                          | cont slider; bnd commit               | `raster.set_display`                                        | partial — kernel style has opacity (`render_world.rs:228-240,709-710`), but Builder hardcodes `RASTER_STYLE` (`BuilderKernelViewport.tsx:80-83,357,397`)                                                                                                                                                                                                                                |
| `raster.drape`        | Raster · Appearance | R/X **Drape onto…**; P **Drape onto** / **Clear drape**; C; A                                      | Properties + jobs                         | bnd link; long prepare; cont view     | `raster.set_drape` / `raster.clear_drape`                   | partial — ADR 0020 surface-tile contract and working decoders exist (`elevation_raster.rs:21-100,569-619,684-720`); Builder load APIs (`BuilderKernelViewport.tsx:121-126`) feed only a development preview (`App.tsx:349-393`)                                                                                                                                                         |
| `raster.georeference` | Raster · Place      | R/X **Georeference…**; C; A; File-import hand-off                                                  | dedicated resizable georeferencing window | cont marker/canvas preview; bnd apply | `raster.georeference.preview` / `raster.georeference.apply` | not existing — the shared registration wizard has two views and Fit (`ImportRegistrationWizard.tsx:741-823`) but only aggregate 3D diagnostics (`:996-1015`); GeoTIFF rejects missing mapping/CRS (`geotiff_provider.rs:46-50,257-260`). A repo-wide search of `crates/`, `packages/`, and `apps/` found `Affine2D` apply/storage but no `fit_affine_2d` or raster georeference command |
| `raster.clip`         | Raster · Edit       | R/X **Clip…**; C; A                                                                                | viewport tool + right panel               | cont preview; bnd apply               | `raster.clip.set` / `raster.clip.clear`                     | not existing — a repo-wide search of `crates/`, `packages/`, and `apps/` found no Raster clip command/component; `RasterImageGeometry` has pixels/dimensions/mapping/depth only (`entity_model.rs:718-733`)                                                                                                                                                                             |
| `raster.crop`         | Raster · Edit       | R/X **Create cropped raster…**; C; A                                                               | clip panel + jobs                         | long                                  | `raster.crop`                                               | not existing — no image kept-pixel mask exists and GeoTIFF output is exact-source passthrough only (`entity_model.rs:718-733`; `geotiff_provider.rs:386-434,777-800`)                                                                                                                                                                                                                   |
| `raster.to_dgm`       | Raster · Convert    | R/X on Grid **Convert grid to editable TIN…**; C; A                                                | small setup panel + jobs                  | long                                  | `raster.to_dgm`                                             | not existing — GeoTIFF imports `hcad.elevation-surface@1` Grid (`geotiff_provider.rs:287-310`); Grid→editable Tin is absent and hands its product to Mesh                                                                                                                                                                                                                               |
| `raster.difference`   | Raster · Analyze    | R X P C A                                                                                          | assistant + VP/Properties + job           | long                                  | `raster.difference.preview/create`                          | Not implemented — batch-2 (D7) capability; RA-D14                                                                                                                                                                                                                                                                                                                                       |

No raster-owned import or export row is created. `file.import` owns providers;
`file.export` owns the reviewed plan and execution. `pointcloud.ortho_image`
remains the one generation row; §2.3 defines its Raster-owned arrival contract.
PhotoLab source-package arrivals are the same boundary: IF-D19/IF-D20/IF-D25
publish DEM Grid and orthomosaic products through `file.import`; Raster owns the
post-commit entity behavior and adds no import alias. DEM Grid retains the exact
resource/mapping/sampling/prepared binding. Orthomosaic arrival is RA-D11's sole
`PlanGrid2D`, `z: null` mapping and never a zero-height bridge.
For a selected ElevationSurface Grid, **Raster ▸ Appearance ▸ Elevation ramp /
Hillshade** is a proposed access-path fan-in to Mesh-owned `mesh.display` /
`mesh.set_display` (MT-D6), not a duplicate registry row. MT-D6 owns the ramp
and cites this Raster-tab access path; hillshade is accepted as the same
Mesh-owned mode.

### 1.1 Boundaries and registered obligations

- Raster owns `hcad.raster-image@1` display, drape, clip/crop, registration,
  tiling behavior, and export implications (`entity_model.rs:37-38,85-86`).
- Pointcloud owns projection parameters and the journaled ortho create. Raster
  adopts PC-D9's output boundary without re-disposition.
- A GeoTIFF interpreted as elevation data is already an ElevationSurface Grid;
  `raster.to_dgm` materializes an editable Tin. Mesh MT-D6/MT-D22 cites RA-D7
  and governs that product; Raster does not define triangulation editing.
- A non-georeferenced scan is staged by File but is not a world entity until
  `raster.georeference.apply`; FP-D13 and IF-D12 cite this plain TIFF/PNG/JPG
  staged-image hand-off. It is not a second import command.
- The canonical model must add `RasterMapping::PlanGrid2D` and an image
  kept-pixel mask before this workflow can ship. Their exact admission,
  migration, generated-binding, and sibling-reader obligations are in §6;
  no implementation may substitute a zero-height `OrthoGrid`.
- Raster images are not snap sources. Elevation Grid surfaces remain terrain
  sources through Draw DR-D13. Layer locking remains Draw DR-D4.

### 1.2 Per-dossier-row dispositions

| Dossier row                                                      | Disposition                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RIB §2.9 `Rasterbilder`: TIFF/TFW, JPG/JGW plan background       | **Adopted:** File imports/stages; Raster owns placement and display. TFW/JGW and plain-image providers are deferred to File because only GeoTIFF/COG exists now.                                                                                           |
| RIB §2.9 + W2: 3+ control points, six-parameter fit              | **Adopted with a safer default:** `raster.georeference` offers the documented six-parameter affine model, but defaults to angle-preserving Helmert as already supported by `docs/TRANSFORMATIONS.md`; §2.1 and RA-D2 state the audit and redundancy rules. |
| RIB §2.3 `HV-Planverwaltung`: background visible, untouchable    | **Adopted by Draw already:** DR-D4 layer lock; Raster uses that posture and adds no duplicate backdrop flag.                                                                                                                                               |
| RIB §2.3 display toggle for raster images                        | **Adopted by View/Draw already:** entity/layer visibility; Raster does not duplicate it.                                                                                                                                                                   |
| RIB §5: monochrome/transparent raster display                    | **Adopted:** `raster.display` source/monochrome + opacity (§3.1).                                                                                                                                                                                          |
| Trimble Perspective §2.2/§5: elevation colour with typed min/max | **Adopted as interaction evidence:** the catalog and typed bounds are reused; **domain deviation:** Mesh/Raster apply them to authoritative ElevationSurface height, not point-cloud attributes, and the style never changes height (RA-D5).               |
| RealWorks §2.8 + W6: Ortho-/Multi Ortho Projection               | **Adopted by Pointcloud already:** PC-D9; Raster owns the resulting entity (§2.3).                                                                                                                                                                         |
| RealWorks §2.8: Convert to Ortho-Image / image rectification     | **Split:** position/scale is adopted through the stronger RIB control-point flow; perspective rectification is deferred because it needs a camera-model workflow not specified here.                                                                       |
| RealWorks §2.8: Image Matching / RealColor                       | **Deferred:** it changes point-cloud colors and requires the registration/station image model queued by PC-D15.                                                                                                                                            |
| RealWorks §2.8: Key plan                                         | **Deferred:** plan-composer content under owner decision D4; Raster will supply the image artifact.                                                                                                                                                        |
| RealWorks §2.7: 2D inspection-map image output                   | **Deferred by Pointcloud:** PC-D10 owns generation; its future raster product inherits RA-D8.                                                                                                                                                              |

## 2. Full user-perspective workflows

### 2.1 Place a scanned paper plan by control points

The user imports a scanned TIFF/PNG/JPG from **File**. Because it has no
trustworthy CRS or mapping, Builder does not put it at the origin, assign a
height, or show it in world space. The staged source opens in the Raster
georeferencing window with **Not georeferenced** status. The dedicated,
resizable workspace contains a pan/zoom source-image canvas, an independent
project viewport, and a control/residual table; the main Builder viewport
remains usable behind it. This reuses the shared import wizard's actual
two-view + Fit layout (`ImportRegistrationWizard.tsx:741-823`), not its robust
3D similarity/ICP semantics (`registration.rs:343-415`). Raster uses pixel↔XY
pairs, 2D Helmert/affine models, no ICP, and per-pair diagnostics instead of
the sibling's aggregate-only 3D RMS/overlap card
(`ImportRegistrationWizard.tsx:996-1015`). Window bounds and detached-monitor
placement follow UIP-D8/UIP-D9 layout persistence; registration content does
not live in that layout state.

The user clicks **Add pair**, then a known mark in the image pane. They next
pick the corresponding surveyed point in the viewport—using Draw DR-D12's
authored/cloud/terrain candidates through MT-D12's clip-aware kernel producer—
or type exact project X/Y. P4 applies to the target pick: hidden or clipped
geometry supplies no candidate, while natural occlusion does not exclude it.
Image pixel column and row are also typeable. Source-pane wheel/trackpad zooms
the image and a void drag pans it; project-viewport gestures keep the platform
orbit/pan/zoom meanings in §4. Image landmarks are capture points, not snap
candidates. Each pair is numbered in both panes and appears in the table.

**Transform** defaults to **Helmert (similarity)**, preserving angles with one
scale. **Affine (6 parameter)** is an explicit choice for scan stretch/shear,
following RIB W2 while retaining the safer model already present in
`docs/TRANSFORMATIONS.md`. Either model needs at least three enabled,
non-duplicate, non-collinear pairs. Affine with exactly three pairs remains
applicable but shows **No redundancy — add a fourth control to verify the fit**;
four or more are recommended. Each row has an enabled/excluded checkbox and a
positive typed weight (default 1), and reports read-only `dX = fittedX -
targetX`, `dY = fittedY - targetY`, and planar residual
`sqrt(dX² + dY²)` in project units. The summary shows weighted planar RMS
`sqrt(sum(weight × residual²) / sum(weight))` and the unweighted maximum;
the worst enabled pair is highlighted and **Frame pair** frames both canvases.
Excluded pairs stay visible and remain in the audit report but do not enter
the fit or aggregates.

The parameter card shows translation, rotation, and uniform scale for Helmert;
for Affine it shows the six matrix coefficients plus derived axis scales and
shear. These outputs are copyable/read-only; controls, weights, source pixels,
and target XY are the typeable evidence. Non-finite input, duplicate source or
target controls, collinearity, singular fits, or fewer than three enabled
pairs disable **Apply** and name the rejection. A warning threshold defaults
to one fitted source-pixel diagonal when no project registration threshold is
configured, is typeable, and is recorded with its source. Exceeding it never
pretends to be a universal survey tolerance: **Apply** requires explicit
**Accept residual warning** acknowledgement. No point, CRS, or threshold can
fill missing placement evidence.

**Apply** transactionally publishes `hcad.raster-image@1`, its immutable source,
`RasterMapping::PlanGrid2D`, control-pair resource, and registration report as
one journaled create/update. The report records model, every control and its
enabled/weight state, parameters, residuals/aggregates, warning threshold and
acknowledgement, source content hash, actor, command id, and timestamp; **Save
registration report…** and automation return the same immutable report. The
2D mapping contains finite f64 XY origin/column/row steps and no Z field. It is
admitted only to 2D/2.5D plan rendering under ADR 0022; it produces no 3D
geometry pick, measurement, snap, terrain source, or elevation/depth authority.
Viewport selection may resolve the raster entity id from its 2D footprint but
returns no world coordinate; tree selection remains available. Entity
placement must be absent for this mapping, so mapping and placement cannot be
applied twice and no generic 3D transform can smuggle in a height. Drape may
consume its XY mapping without converting it to a false plane.

That publication rule is for a staged, height-unknown scan. Refining an
existing height-aware `OrthoGrid` or explicit planar/camera raster updates only
the mapping dimensions actually evidenced by the 2D controls and preserves its
authored Z/plane/camera authority byte-for-byte; it never demotes the raster to
`PlanGrid2D` or invents a new plane. The preview and report name the preserved
authority before Apply.

Ctrl+Z removes/restores the committed registration as one compensating command.
Reopening **Georeference…** restores the pairs and starts from the committed
fit. Window x, ribbon re-toggle, and the UIP-D14 window-close rung discard only
uncommitted edits; an explicit **Cancel import** also deletes recoverable
staging. Closing without Cancel checkpoints the staged source and every
complete pair off the interaction thread under P5 and returns it as a **Needs
placement** job after renderer reload or full app restart. A half pair and
uncommitted field text are intentionally discarded.

### 2.2 Drape an ortho over terrain with transparency

The user selects a 2 cm orthophoto and, in Properties, sets **Opacity** to 65%
with the slider or typed percentage. Under **Drape onto**, they choose the
named visible 10 cm DGM. **Clear drape** returns a `PlanGrid2D` source to plan
only and an already-heighted ortho to its authored mapping.

The setup always shows **Scope: visible set**. It names every active viewing
box/section and counts hidden source/target exclusions; there is no optional
"use active clip" checkbox. At Apply, Builder captures the intersection of
active clip volumes, explicit entity/class visibility, the image footprint,
its canonical kept-pixel mask, and the terrain's connected valid region as
immutable, camera-free world-space command arguments with the exact referenced
revisions. Natural occlusion contributes nothing. A later clip edit or
visibility change cannot reshape the committed drape. To drape the full
footprint, the user explicitly deactivates clips and unhides inputs before
Apply. For `PlanGrid2D`, clip membership is evaluated at the selected terrain's
authoritative XYZ for each XY sample; the operation never supplies a raster Z
of its own (RA-D12).

Builder journals the link, registers a UIP-D10 background job, and reports
real tile counts. ADR 0020 prepares independent color pages and elevation
support grids: the fine image is not degraded to the DGM spacing, the terrain
is not fabricated at image resolution, NoData stays disconnected, and shared
tile-edge supports match. The prior valid presentation remains until atomic
publication; cancel or failure keeps it and marks the requested drape unapplied.

On completion the ortho follows the terrain and the 65% opacity reveals the
surface/model below. Orbit, pan, and zoom stay available while preparation
runs. Picking the drape resolves the support triangle's project XYZ; color
pixels never become height authority (ADR 0020, “Picking and measurement”). If
the DGM changes, one debounced rebuild follows the settled revision. If it is
deleted, the drape is disabled with **Terrain source missing**; stale heights
never remain presented as current.

### 2.3 Receive an ortho-image from a cloud

The user starts **Pointcloud ▸ Image ▸ Ortho-image…**, defines plane, extent,
resolution, and depth, and runs the PC-D9 job (pointcloud spec §3.3; RealWorks
W6). Pointcloud owns that tool, its parameters, cancel behavior, and the one
journaled create; Raster does not offer a duplicate generator.

On success a standard, georeferenced `hcad.raster-image@1` appears in the tree,
named from the source cloud/plane and linked to its generation provenance. It
starts at full opacity, source color, no clip, no drape. From that instant the
same Raster properties and commands apply: transparency, monochrome, drape,
clip/crop, registration refinement, and honest export. A layer lock can make it
a visible click-through drafting backdrop (Draw DR-D4). Cancellation or failure
publishes no raster, so Raster never receives a half-artifact.

## 3. Function-contract answers by group

### 3.1 Appearance: display and drape (`raster.display`, `raster.drape`)

**A1.** §2.2 is the main flow. Raster-owned image properties are opacity and
source / monochrome. For an Elevation Grid, the same panel slot and Raster-tab
accelerators surface Mesh-owned elevation ramp with typed min/max and the
proposed Mesh-owned hillshade `Off` / `View light` / `Fixed`; Fixed exposes
typed azimuth and altitude. Drape binds an image to a named ElevationSurface.
**A2.** RIB §5 grounds transparency/monochrome. Trimble Perspective §2.2/§5
grounds elevation colouring and typed bounds for clouds; applying the
interaction to authoritative ElevationSurface height is a stated domain
deviation. Drape and hillshade remain additions after the dossier-wide check.
ADR 0020 specifies drape. Runtime gradient resolution and shader consumption
exist (`gpu_frame.rs:261-289`; `shaders/mixed.wgsl:201-225`), while elevation
preparation currently produces fixed dataset-range grayscale
(`geotiff_preparation.rs:430-450,869-871`).
**A3.** Raster adopts VD-D8's two-layer model. This spec owns raster opacity
and source/monochrome as canonical, journaled lower-layer entity style. The
upper View layer must not reinterpret it: `view.color-mode` remains the
point-cloud override described by VD-D8, and `view.render-style` is scoped to
Mesh/BIM. VD-D6/VD-D8 now name those boundaries. MT-D6 owns elevation
ramp/hillshade; Raster contributes only its contextual access path.

**B1.** **Monochrome**, Properties **Color/Opacity**, **Display properties**,
console, and automation call `raster.set_display`; Grid ramp/hillshade call
Mesh-owned `mesh.set_display`; **Drape onto…** and **Clear drape** call the one
drape set/clear pair. The shortcut absence and reason are in §1.
**B2.** Properties is closeless platform
chrome; a preparation continues in Jobs after focus changes and cancels only
through its explicit cancel action. **B3.** Properties is correct because the
user must keep interacting with the viewport. **C1.** Opacity and fixed-light
angles have slider/type parity; ramp bounds are typeable in project units.
**C2.** One or many compatible entities; common fields show Mixed and one
commit edits all atomically (UIP-D17). Selection changes retarget Properties;
an in-flight preparation keeps its captured entities/revisions. **C3.** Drape
is the bake; there is no second lock. Display uniforms need none. **C4.** Style
and drape links are canonical, journaled, project-persisted; prepared tiles are
rebuildable and not journaled (ADR 0020).

**D1.** Slider previews are continuous; commits bounded; drape preparation is
long with UIP-D10 progress/cancel; orbit is continuous and gated by G-RA-1.
**D2.** The quality governor loads coarser independent pyramids first. It may
reduce hillshade sample quality before color resolution; input response,
mapping, NoData topology, and pick coordinates never degrade. **E1.** §8.1–3.
**E2.** The consumer/mutation and recovery contract is §3.6. The largest
member is a country-scale COG (streamed; no full decode or main-thread
resample); the least typical is a constant-height Grid (single-colour ramp,
hillshade neutral, no divide-by-zero). Drape always captures P4 scope as §2.2;
missing/deleted sources fail there. **E3.** §7.

### 3.2 Georeferencing (`raster.georeference`)

**A1.** §2.1. **A2.** RIB §2.9/W2's 3+ pairs and six-parameter affine
transform are adopted as the deliberate distortion model; Helmert is the safe
default from `docs/TRANSFORMATIONS.md`. Residual rows, weights/exclusions, and
the audit report are X1 additions. **A3.** The actual sibling is the shared
two-view + Fit surface (`ImportRegistrationWizard.tsx:741-823`) and its robust
3D-similarity backend (`registration.rs:343-415`); Raster reuses its layout and
shared controls only. Semantic deviations are pixel↔XY, Helmert or affine,
no ICP, and per-pair residuals. DR-D12/MT-D12 provide P4-aware target snaps;
source-image picks remain pixels.

**B1.** R/X **Georeference…**, C/A, and the File hand-off share preview/apply;
the shortcut absence and reason are in §1. **B2.** The ribbon is a pure window
toggle; window x/re-toggle/its UIP-D14 close rung discard uncommitted edits but
keep recoverable staging unless **Cancel import** is chosen. **B3.** A
dedicated resizable window is required because the workflow has two canvases,
a control table, and an error/diagnostic list; a right panel is too small.
**C1.** Pixel and target coordinates, weights, and warning threshold are
typeable; fitted parameters/residuals are derived, readable, and copyable.
**C2.** One raster/staging session is captured at launch; selection changes do
not retarget. **C3.** Fit preview is cheap; no lock. **C4.** Apply is one
journaled create/update; undo affects mapping, pairs, and report together,
never the immutable source. Complete-pair staging checkpoints under P5; half
pairs and field text do not.

**D1.** Marker drag and both-canvas pan/zoom are continuous, G-RA-2; fit/apply
are bounded. **D2.** The preview image may use a coarser mip, while pair
coordinates and residuals stay f64/full precision. **E1.** §8.4. **E2.**
§3.6 defines every consumer and crash/race outcome. Largest: a huge
unreferenced scan uses bounded mips; least typical: an already-georeferenced
raster opens with its committed mapping and any update loses current exact-
passthrough eligibility. Concurrent canonical edit invalidates preview and
requires rebase; deletion closes the tool. Degenerate fit publishes nothing.
**E3.** §7.

### 3.3 Edit: clip and crop (`raster.clip`, `raster.crop`)

**A1.** The user draws a rectangle/polygon in raster pixel coordinates. **Apply
clip** stores a non-destructive kept-region boundary; **Clear clip** restores
all. **Create cropped raster…** runs a job and creates a new raster over the
tight pixel bounding rectangle. It carries an immutable canonical one-bit
kept-pixel mask distinct from image alpha and depth/elevation validity: row
major, pixel index `row × width + column`, LSB-first within each byte, `1 =
kept`, exact length `ceil(width × height / 8)`, and zero padding bits. The
mapping shifts to the tight rectangle; source revision and authored polygon
are provenance. Render, entity hit testing, drape, plan composition, crop,
future synthetic export, and Grid→Tin all use this one mask; excluded corner
pixels are absent, never transparent-as-valid. **A2.** No dossier documents
this (all four checked as cited); it is a stated addition for RIB W2 backdrop
hygiene. **A3.** It reuses Pointcloud's fence overlay family and P4 visible-set
semantics, not its cloud mutation command.

**B1.** R/X **Clip…** and **Create cropped raster…**, C/A; the shortcut absence
and reason are in §1. **B2/B3.** Ribbon toggles a right-panel viewport tool;
close discards uncommitted vertices. **C1.** Every vertex is draggable
and typeable as pixel column/row; rectangle fields expose left/top/width/height.
**C2.** One captured raster; selection changes do not retarget. **C3.** Clip
lets residency skip wholly excluded tiles; crop is a baked reduction (X2).
**C4.** Clip set/clear is journaled. Crop publishes verified immutable pixels,
mask, mapping, and provenance, then atomically links one new entity. Undo crop
removes only that product/link; undo clear restores only the prior source clip.

**D1.** Overlay edits continuous (G-RA-2); clip commit bounded; crop long with
UIP-D10 progress/cancel. **D2.** Boundary overlay may simplify only between
authored vertices; kept-set correctness and canonical mask resolution never
degrade. **E1.** §8.5. **E2.** Crop shows the non-optional **Scope: visible
set** summary and captures the P4 intersection exactly as RA-D12; natural
occlusion does not scope it. Export remains FP-D5's canonical-data exception.
If a `PlanGrid2D` crop has an active clip whose membership depends on unknown Z,
**Create cropped raster…** is disabled with **Scope unresolved — raster has no
height**; the user deactivates that clip or drapes first. Builder never ignores
the clip or projects it to XY as a guess. An XY-only clip is applied exactly.
Largest: a million-vertex boundary is rejected above a tunable cap with
simplify guidance; least typical: an empty kept set is rejected. Crop and
georeference on one source serialize; source revision change makes the job
fail before publication. Recovery is §3.6. **E3.** §7.

### 3.4 Convert: elevation Grid to editable DGM Tin (`raster.to_dgm`)

**A1.** The user selects an ElevationSurface Grid, chooses retained spacing,
reviews the mandatory **Scope: visible set** summary, previews output counts,
then receives an editable Tin surface. At launch, `raster.to_dgm` captures the
active clips and explicit visibility filters as immutable world-space
arguments with input revisions; occlusion is ignored. Full-entity conversion
requires deactivating clips/unhiding inputs before launch. **A2.** RIB §2.6
establishes DGM/Tin as the civil terrain workflow,
but not Grid→Tin conversion; this is a stated representation bridge. **A3.**
Mesh MT-D1/MT-D5/MT-D22 owns Tin validation/editing and cites this arrival;
Raster owns only the source-side conversion command.

**B1.** R/X **Convert grid to editable TIN…**, C/A; small setup panel, job; the
shortcut absence and reason are in §1. **B2/B3.** Panel may close
while the UIP-D10 job continues; Jobs provides cancel. **C1.** Spacing is typed
in project units; estimated vertices/triangles are derived read-only. **C2.**
One captured Grid. **C3.** The result is baked. **C4.** One journaled create
with exact source revision, captured P4 scope, and parameters; undo removes
only the Tin.
**D1.** Long, real rows/cells progress, bounded cancellation. **D2.** No quality
degradation inside a chosen conversion; the user explicitly chooses spacing.
**E1.** Reuses Mesh creation-result criteria, not new Raster chrome. **E2.**
NoData, excluded visibility/clip cells, and disconnected cells remain holes;
raster color, opacity, hillshade, drape, and occlusion never influence heights.
Largest Grid streams bounded tiles; a 1×N/empty valid Grid is rejected because
it cannot form a surface. Mesh renderer/editor, terrain snap, contours/volume,
selection, export, and automation consume the Tin under the requested RA-D7
Mesh cross-link. Recovery is §3.6. **E3.** §7.

### 3.5 Ortho arrival and export honesty

**A1.** §2.3, then File ▸ Export. **A2.** RealWorks §2.8/W6 grounds the hand-off;
RIB §2.9 grounds georeferenced raster exchange. **A3.** PC-D9 is adopted, never
re-dispositioned; FP-D5 exclusively owns the two-step plan and accepted-loss
flow. **B1.** There is no Raster export row: X **Export…** calls `file.export`.
**B2/B3.** File's island rules apply. **C1-C3.** Not applicable: export has no
Raster direct manipulation or lock. **C4.** Export changes no entity.

**D1.** File's long-running job contract applies. **D2.** Never degrade output
silently. **E1.** File FP-D5 criteria apply. **E2.** The Raster-specific plan
matrix is below. "Accepted?" means accepting every reviewed loss permits
execution; exact-passthrough providers still refuse any nonempty loss list.
Unknown codes render raw through FP-D5 and remain unaccepted by default.

| Scope / format                                                                              | Availability and output                                                                                                                                                                                      | Exact planned loss codes                                                                                                                                                                                   | Accepted?                                                                                         | Raster display state in deliverable                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Native `.hcadx` via **Save As…**                                                            | Available; canonical entities, resources, styles, clips, provenance, and project view state are retained under FP-D3                                                                                         | none                                                                                                                                                                                                       | n/a, lossless                                                                                     | retained according to the canonical-lower / project-view-upper split |
| One unchanged matching GeoTIFF import                                                       | Available only for the same provider package, exactly one entity, revision `0`, no entity placement, unchanged dimensions/mapping/pixels, and no depth; output is a verified byte-identical copy             | none (`geotiff_provider.rs:777-810`)                                                                                                                                                                       | n/a, lossless                                                                                     | not authored into the TIFF; source bytes are unchanged               |
| Any revised, placed, clipped, draped, generated, georeferenced, or cropped raster → GeoTIFF | Disabled as **Only an unchanged GeoTIFF import can be exported as GeoTIFF**; a forced plan reports `hcad.loss.geotiff.not-exact-passthrough@1`, plus `hcad.loss.geotiff.multiple-entities@1` when applicable | those exact codes (`geotiff_provider.rs:386-406`)                                                                                                                                                          | **No**; export rejects every nonempty plan (`:427-434`)                                           | absent; no misleading file is written                                |
| Style-only revised GeoTIFF → GeoTIFF                                                        | Same conservative refusal: revision is no longer `0`, even if pixels/mapping compare equal                                                                                                                   | `hcad.loss.geotiff.not-exact-passthrough@1`                                                                                                                                                                | **No** until a geometry/mapping/hash guard plus byte-identity regression proves a narrower policy | absent; no file is written                                           |
| Raster → DXF                                                                                | Available as an honestly lossy project/selection export; raster is omitted                                                                                                                                   | `hcad.loss.dxf.canonical-identity@1` and `hcad.loss.dxf.entity-omitted@1`; `hcad.loss.dxf.metadata-not-representable@1` also appears when raster metadata/style is populated (`dxf_provider.rs:1724-1782`) | **Yes**, only after every planned code is accepted                                                | absent by declared omission                                          |
| Raster → LandXML                                                                            | Available as an honestly lossy project/selection export; raster is omitted                                                                                                                                   | `hcad.landxml.export-unsupported-entity@1`; `hcad.landxml.export-entity-metadata-omitted@1` also applies when style/non-LandXML metadata is populated (`landxml.rs:1500-1535,1728-1732`)                   | **Yes**, only after every planned code is accepted                                                | absent by declared omission                                          |
| Raster → IFC 2x3/4/4.3                                                                      | Disabled as **IFC export requires one unchanged IFC import**; forced plan cannot synthesize a raster                                                                                                         | `hcad.loss.ifc.not-exact-source@1` (`ifc_provider.rs:285-315`)                                                                                                                                             | **No**; no lossy synthetic IFC writer exists                                                      | absent; no file is written                                           |
| Raster → Gaussian-splat PLY                                                                 | Disabled as **Gaussian-splat PLY requires one unchanged splat import**                                                                                                                                       | `hcad.loss.gaussian-splat-ply.multiple-or-non-splat@1` and `hcad.loss.gaussian-splat-ply.not-exact-passthrough@1` (`gaussian_splat_provider.rs:223-275`)                                                   | **No**; export rejects a nonempty plan                                                            | absent; no file is written                                           |

Synthetic GeoTIFF writing remains FP-D14/import-formats scope. **E3.** One
plan/execute test per row plus unknown-loss rendering is required in §7.

### 3.6 Mutation, consumer, and recovery contract

Every reader uses exact revisions; no passive consumer follows a mutable
viewer object. This table is part of each group's E2 answer.

| Change                                                               | Required effect on consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raster mapping / registration changes                                | Plan render, 2D entity footprint, Properties, tree status, plan-composer live placements, and automation readers advance atomically. The old drape cache is invalid and is not rendered against the new mapping; the valid undraped/plan presentation remains while an atomic rebuild targets the new revision. Pixel-coordinate clip vertices keep their pixel meaning. Existing crops remain immutable products of the exact old source revision and show **Source changed** rather than moving. Export discards any old plan and replans. In-flight crop/drape jobs with the old revision fail before link publication. |
| Pixel payload, dimensions, or kept-pixel mask changes                | Render/LOD/residency, plan composition, hit testing, drape, crop, and export re-resolve the new immutable resource. A clip is retained only if every authored pixel vertex remains in bounds; otherwise the editing command is rejected rather than silently clamped. Existing crops remain bound to the old source and become visibly stale.                                                                                                                                                                                                                                                                              |
| Raster style-only change                                             | Render, Properties, selection highlight composition, automation, and the canonical lower display layer update; mapping, clips, crops, drape geometry, picking, and measurements do not rebuild. Current GeoTIFF passthrough still refuses because the provider's revision-zero guard is intentionally conservative (§3.5).                                                                                                                                                                                                                                                                                                 |
| Drape terrain revision/deletion                                      | The old support cache is immediately ineligible; one debounced rebuild keys the exact settled terrain revision and no stale height is rendered as current. Deletion disables the drape with **Terrain source missing**. Draw terrain snap continues to use the terrain entity, never raster colour.                                                                                                                                                                                                                                                                                                                        |
| Clip/visibility/viewing-box changes after a geometry-consuming Apply | They affect ordinary current rendering/picking under P4 but never mutate an already captured drape, crop, or Tin. Re-run the command to produce a differently scoped artifact. Natural occlusion never enters either scope.                                                                                                                                                                                                                                                                                                                                                                                                |
| Source raster deletion                                               | Open Raster surfaces close or retarget only by explicit user action. Independent crop products remain viewable with **Source missing** provenance; a drape owned by the deleted source disappears with it. Automation calls against the deleted id fail atomically. Export replans.                                                                                                                                                                                                                                                                                                                                        |

Coordination: georeference and pixel-changing edits on one raster serialize;
style edits may run during preparation but advance the entity revision and
therefore force the preparing command to revalidate its geometry/mapping hashes
rather than relying on revision alone. Drape, crop, and Grid→Tin may run
concurrently only when their captured inputs do not overlap a writer; each
publishes verified immutable artifacts first and one atomic link/create last.
A stale expected revision/hash, cancellation, or validation failure publishes
no link and no partial canonical entity. Project replacement requests bounded
cancellation, leaves staging/checkpoints with the original project, and rejects
every late result against the closed project id. App shutdown uses the same
bounded cancellation; restart follows the table below.

| State/work                                             | Renderer reload while main process lives                                                                                 | Full app/main-process restart                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staged scan + complete point pairs                     | Main-owned UIP-D10 job and project-managed P5 checkpoint rehydrate as **Needs placement**; source hash and pairs survive | Same checkpoint is discovered and offered as **Needs placement**; **Cancel import** removes it. Half pairs/field text never survive either case                                                                                                                      |
| Committed display, mapping/report, clip, or drape link | Rehydrates from canonical project state; derived render resources are requested again                                    | Journal replay restores it; missing/stale prepared data rebuilds from exact inputs                                                                                                                                                                                   |
| Running drape preparation                              | UIP-D10 mirror rehydrates and the job continues; prior valid presentation remains                                        | Interrupted job returns as **Needs rebuild** and may retry from verified staged artifacts; canonical link determines the required exact revisions                                                                                                                    |
| Running crop or Grid→Tin                               | UIP-D10 mirror rehydrates and the job continues                                                                          | Returns **Interrupted — retry** with captured arguments. Verified unlinked immutable artifacts may be reused after hash validation; invalid/unreachable staging is cleaned by project maintenance. It is never shown as success before the atomic entity link exists |
| Published crop or Tin                                  | Ordinary canonical entity, unchanged                                                                                     | Journal + immutable resources restore it; provenance may be stale/missing as described above but geometry never moves silently                                                                                                                                       |

## 4. Armed-tool gesture arbitration

Unlisted gestures keep UI Platform §3.6 meaning; at most one tool is armed.

| Gesture          | Georeference                                                                         | Clip/crop                                                              | Reconciliation                                                       |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| LMB click        | capture active image/project point                                                   | add vertex / rectangle corner                                          | claims the §3.6 claimable click; idle selection suspended            |
| LMB drag         | marker = move control; source-canvas void = pan image; project-viewport void = orbit | drag vertex only; off-handle remains orbit/pan                         | each canvas keeps its own navigation off handles                     |
| Ctrl+LMB         | same as LMB; no selection toggle                                                     | same as LMB                                                            | tool owns click while armed                                          |
| RMB click / drag | project entity menu / project pan; source pane makes no RMB claim                    | tool menu (Finish, Undo vertex, Cancel) / pan                          | RA-D10 deviation only for discoverable finish; drag remains platform |
| MMB / wheel      | pan/zoom the canvas under pointer (image in source pane; camera in project viewport) | pan / zoom                                                             | navigation stays canvas-local                                        |
| Tab / Shift+Tab  | traverse georeference fields                                                         | traverse crop fields                                                   | never cycles candidates; Up/Down cycles a live target-pick list      |
| Backspace        | remove current pair only when table not editing                                      | remove last vertex                                                     | typed fields retain text-edit meaning                                |
| Escape           | field revert → marker drag revert → cancel active pair → close tool                  | field revert → vertex drag revert → discard open boundary → close tool | one UIP-D14 rung per press                                           |
| Typing           | active pair field                                                                    | active vertex/rectangle field                                          | focused numeric surface wins                                         |
| Touch            | tap/drag equivalents                                                                 | tap/drag; tap-hold tool menu                                           | pointer-equivalent arbitration                                       |

## 5. Decision records

**RA-D1 — Canonical style below VD-D8, one entity owner.** **Decision:** Raster
owns raster-image opacity and source/monochrome as journaled lower-layer style;
drape is a separate canonical link. VD-D8's View colour override remains
point-cloud-only and VD-D6's render-style override is Mesh/BIM-only; neither
changes Raster. MT-D6 owns elevation ramp. Raster offers only an access-path
fan-in; MT-D6 accepts that ramp/hillshade contribution and owns its typed values.
**Derivation:** X3/P1/X7; VD-D8's two-layer class; MT-D6; RIB §5; program
README cite-and-revise rule. **Rejected:** view-local raster style (automation
divergence); applying both canonical monochrome and a global monochrome
override (double ownership); defining Mesh display state here. **Tunable:**
yes — palette/light defaults under X6; ownership and layer scope are not.

**RA-D2 — No coordinates until evidence.** **Decision:** an unreferenced image
stays staged outside world space. **Helmert (similarity)** is the default and
six-parameter **Affine** is an explicit scan-distortion choice; both require
≥3 enabled nondegenerate controls, with ≥4 recommended for affine redundancy.
The journaled report carries every typed control/weight/use state, dX/dY/planar
residual, weighted RMS, maximum, parameters, warning acknowledgement, source
hash, and actor. **Derivation:** X1/X4; RIB §2.9/W2 background-plan workflow;
`docs/TRANSFORMATIONS.md` supports both empirical models and requires frozen
audit records. **Rejected:** affine-only (can disguise stretch/shear as valid
placement); two-point Helmert commit (no redundancy); three-point affine
without warning (zero-residual tautology); invented hard survey tolerance.
**Tunable:** yes — residual warning threshold under X6; initial fallback is one
fitted source-pixel diagonal.

**RA-D3 — Image pixels never snap.** **Decision:** an unlocked raster may be
selected/picked as an entity, but produces no geometric snap candidates;
ElevationSurface Grid snaps through DR-D13. Backdrop click-through uses DR-D4
layer lock. **Derivation:** X1; DR-D12 enumerates authored/cloud/terrain; RIB
§2.3 HV posture. **Rejected:** pixel/edge snap (turns visual evidence into
survey truth); a duplicate backdrop flag. **Tunable:** no.

**RA-D4 — Drape is a canonical link, derived bake.** **Decision:** exact image
and terrain revisions, the captured RA-D12 scope, kept-pixel mask, and evaluator
version key a UIP-D10 prepared surface; settled source change rebuilds and the
published revision is explicit. **Derivation:** ADR 0020; X1/X2; P4; VB-D3
lifecycle class; X5 drape/clear symmetry. **Rejected:** render-time whole-raster
resampling; a view-local link; a live pointer to mutable clip state. **Tunable:**
yes — rebuild debounce under X6.

**RA-D5 — Elevation display never alters height.** **Decision:** the ramp remains
Mesh-owned `mesh.display` style; Raster supplies a contextual accelerator.
MT-D6 accepts hillshade with Off / View light / Fixed and its typed parameters.
Typed min/max and any fixed light are presentation only; NoData is never
coloured as a low value. **Derivation:** X1/X4/X7; VD-D8; MT-D6; Trimble
Perspective §2.2/§5 interaction evidence; working GPU resolution/shader paths
(`gpu_frame.rs:261-289`; `shaders/mixed.wgsl:201-225`). **Rejected:** a duplicate
Raster style resource/command; claiming Raster owns hillshade values;
baking styled heights into elevation authority. **Tunable:** yes — palettes and
light defaults under X6.

**RA-D6 — Clip and crop are distinct.** **Decision:** clip is a reversible
canonical kept-region component applying P4; crop creates a derived raster and
preserves the source. Polygon crop carries the canonical one-bit image kept-
pixel mask specified in §3.3; every consumer uses it independently of alpha or
depth validity. **Derivation:** X1/X2/X5; ADR 0020's alpha-is-not-elevation-
validity rule; immutable resources; P4. **Rejected:** destructive in-place
crop; bounding a polygon to a rectangle; treating transparent alpha as
validity; consumer-specific masks. **Tunable:** yes — authored-vertex cap under
X6; encoding and mask meaning are not.

**RA-D7 — Grid→Tin command here, product in Mesh.** **Decision:** Raster owns
source selection, spacing, captured RA-D12 scope, and journaled create; Mesh
MT-D22 cites RA-D7 and owns the resulting Tin's validity/edit/display contract.
**Derivation:** PC-D9
input-domain/output-domain boundary generalized by X7; Mesh MT-D1/MT-D5.
**Rejected:** redefining Tin semantics here; omitting the bridge because Grid is
already an ElevationSurface. **Tunable:** default spacing (X6).

**RA-D8 — Every raster producer has one arrival contract.** **Decision:** PC-D9
orthos and future PC-D10 inspection maps arrive as ordinary raster entities and
immediately inherit all applicable Raster records; no “ortho result” subtype.
**Derivation:** PC-D9; X7. **Rejected:** special-case artifact paths.
**Tunable:** no.

**RA-D9 — Existing export losses tell the truth.** **Decision:** Raster adds no
parallel exporter or speculative loss codes; every current format follows the
§3.5 matrix. GeoTIFF retains the conservative revision-zero exact-passthrough
guard, including refusal after style-only revision, until a narrower semantic
guard proves unchanged geometry/mapping/pixels and byte identity. **Derivation:**
X1; FP-D5; current provider plan/execute behavior cited in §3.5. **Rejected:**
silent source-byte export after placement/crop; pretending accepted losses let
an exact-only provider synthesize output; weakening the style-only guard
without a byte-identity test. **Tunable:** no.

**RA-D10 — Armed clicks edit; navigation stays platform-owned.** **Decision:**
georeference and clip/crop claim LMB clicks and handle drags; off-handle LMB
drag, RMB drag, MMB, and wheel retain navigation. Clip/crop alone replaces RMB
click with a tool menu so Finish/Undo vertex/Cancel remain visible. **Derivation:**
UI Platform §3.6 permits claimed clicks but protects navigation; DESIGN-SYSTEM
requires visible completion/cancellation. **Rejected:** capturing every pointer
gesture (navigation dead-end); keyboard-only Finish. **Tunable:** no.

**RA-D11 — Plan-only raster mapping is an explicit canonical variant.**
**Decision:** add `RasterMapping::PlanGrid2D { origin_xy: [f64; 2],
column_step_xy: [f64; 2], row_step_xy: [f64; 2] }`. Validation requires finite,
linearly independent XY steps, forbids depth and entity placement, and admits
the raster only to ADR 0022 plan modes. It is version-2 Raster geometry while
the semantic type id stays `hcad.raster-image@1`. Its coordinate result is XY
with `z: null`; it has no 3D render/pick/measure/snap/terrain authority. Drape
consumes XY but does not promote or rewrite the mapping. **Derivation:**
X1/X3/X5; ADR 0016
semantic admission and missing-Z rule; ADR 0022 plan-only posture; Draw DR-D3;
FP-D15's explicit-placement class. **Rejected:** Z=0 `OrthoGrid`; invalid
entity publication; generic placement on the plan raster; dropping the RIB
§2.9/W2 workflow. **Tunable:** no.

**RA-D12 — Geometry-consuming Raster acts freeze the P4-visible set.**
**Decision:** drape, crop, and Grid→Tin always display **Scope: visible set** and
capture active clip volumes plus explicit visibility/class filters as immutable
world-space, camera-free command arguments with exact revisions at Apply;
natural occlusion is excluded. Later view changes do not mutate the artifact.
Georeference target acquisition uses the same P4-aware snap/pick pipeline. For
`PlanGrid2D`, drape evaluates scope against target-surface XYZ; a crop is
disabled when an active clip needs unknown Z and applies XY-only clips exactly.
**Derivation:** P4/X1; MT-D12; VB-D13; MT-D15's same camera-free replay class.
**Rejected:** optional clip checkbox; operating on hidden full data; retaining a
live pointer to view state; letting occlusion scope canonical work. **Tunable:**
no.

**RA-D13 — Raster work recovers by durable evidence, never partial success.**
**Decision:** P5 checkpoints staged sources and complete controls; UIP-D10
rehydrates jobs across renderer reload. Full restart returns placement staging
as **Needs placement**, canonical drape links as **Needs rebuild** when caches
are absent/stale, and interrupted crop/Grid→Tin as **Interrupted — retry**.
Verified unlinked artifacts may be reused only after hash/revision validation;
publication is one atomic link and unreachable staging is cleanable. The
mutation effects in §3.6 bind every consumer. **Derivation:** X1/X2; P5;
UIP-D10/UIP-D11; ADR 0016 immutable-resource-before-link rule; SYSTEM-001.
**Rejected:** renderer-only job state; auto-publishing recovered staging;
silently discarding complete pairs; treating a partial artifact as success.
**Tunable:** no.

## 6. Current-implementation delta

**Exists and stays:** `hcad.raster-image@1` and ElevationSurface Grid
(`entity_model.rs:34-38,465-481,718-733`); GeoTIFF/COG import as RasterImage or
ElevationSurface (`geotiff_provider.rs:89-95,266-310`); bounded elevation
pyramids (`geotiff_preparation.rs:69-117`); ADR 0020's independent surface
contract and working decoders (`elevation_raster.rs:21-100,569-619,684-720`);
height-gradient runtime resolution and shader use (`gpu_frame.rs:261-289`;
`shaders/mixed.wgsl:201-225`); exact-passthrough export/loss codes
(`geotiff_provider.rs:58-61,373-437,777-810`).

**Changes:** canonical raster-image styles replace `RASTER_STYLE`; the dev-only
orthophoto/drape route is retired after canonical wiring; File can stage a
missing-transform plain image without publishing it and hand it to Raster;
export-plan copy implements the §3.5 matrix without changing provider
acceptance semantics; the registration workspace reuses the shared two-view
controls but not its 3D model or aggregate-only diagnostics.

**New — ADR 0016 admission/schema delta (RA-D11/RA-D6):** extend the canonical
`RasterMapping` union with `PlanGrid2D`, `RasterImageGeometry` with optional
`image_validity` referencing the exact one-bit kept-pixel mask from §3.3, and a
typed 2D registration report/control schema rather than reusing the current 3D
residual type. The `hcad.raster-image@1` semantic type id remains unchanged
because entity meaning does not change. Raster entity `schema_version: 1`
remains valid only with the existing mapping/depth shape; any entity carrying
`PlanGrid2D` or
`image_validity` uses `schema_version: 2`, and the first canonical edit of such
state writes version 2. Semantic admission must validate mapping determinant,
no depth/no placement for `PlanGrid2D`, mask dimensions/byte length/padding,
resource hash, and the one-primary-source rule.
Existing version-1 `OrthoGrid`/`Planar`/`Camera` values read losslessly and keep
their meaning; they remain version 1 until an ordinary edit needs version-2
state. Migration never infers plan-only state from a zero-height grid, never
converts alpha to validity, and never changes entity placement. Projects with
no new variant need no data rewrite. Older readers fail closed on the unknown
variant/schema rather than flattening it; no down-conversion is offered.

ADR 0016's sibling-reader obligation is explicit: regenerate the Rust-owned
TypeScript and Python/automation contracts; update exhaustive matches in core
validation, project/archive replay and migration, IO package validation and
GeoTIFF passthrough guards, WASM, viewer streaming/admission, render
compilation, picking/measurement, plan composition, drape/crop/Grid→Tin, and
PhotoLab/WeltView read-only hosts. Each host either implements plan-mode
admission/mask consumption or rejects the new schema with a typed unsupported-
schema result; none substitutes Z=0 or ignores the mask. Migration fixtures
cover old raster variants, new plan-only values, polygon masks, generated SDK
round-trips, archive reopen, sibling read/reject behavior, and absence of an
implicit zero in serialized JSON. This is an implementation delta under ADR
0016, not a rewrite of that ADR.

**New — functions:** Properties group; Raster access fan-in to MT-D6 ramp and
proposed hillshade controls; canonical drape link and UIP-D10 job wiring;
staged-image Helmert/affine fit, pair/report resources, and dedicated two-canvas
window; clip component and shared P4 scope capture; kept-mask crop pipeline;
Grid→Tin command; lifecycle/recovery state from §3.6; `raster.*` automation and
SDK generation. Plain PNG/JPG and TFW/JGW provider work remains File/import-
formats scope. Synthetic GeoTIFF writing remains FP-D14.

## 7. Verification plan (`docs/TEST-TIERS.md`)

- **changed — G-RA-UNIT:** Rust tests for exact/noisy/outlier Helmert and affine
  fits, typed weighted residual math, enabled/excluded controls, three-point
  affine no-redundancy warning, collinear/duplicate/singular rejection, and
  report round-trip; `PlanGrid2D` admission rejects placement/depth/non-finite
  or dependent steps and serializes no implicit zero; old-schema migration
  never infers plan state; generated TS/Python bindings round-trip `z: null`.
  Clip inclusion/clear and polygon-crop mask bit order, padding, dimensions,
  provenance, source preservation, and alpha/depth-validity separation; ADR
  0020 independent-grid/hash/edge invariants; Grid→Tin holes and captured scope.
  One export plan/execute fixture for every §3.5 row, including style-only
  GeoTIFF refusal and raw unknown-loss rendering.
- **changed — G-RA-UI:** component tests for slider/type sync, Mixed values,
  ramp bounds, proposed hillshade modes, drape/clear pair, dedicated-window
  resize/layout restore, Helmert default/Affine selection, typed control and
  weight fields, dX/dY/norm/RMS/max, exclusions, worst-row two-way framing,
  no-redundancy/warning acknowledgement, rejection copy, report export,
  clip/clear/crop copy, and x/ribbon/Escape close semantics.
- **push — G-RA-BROWSER:** gesture table one-rung-per-press with distinct
  source-canvas pan/zoom and project orbit/pan; no entity exists before Apply;
  `PlanGrid2D` renders only in plan modes, emits no coordinate/snap/measure
  candidate, and preserves `z: null`; locked backdrop is click-through. Drape,
  crop, and Grid→Tin each run with locked and unlocked viewing boxes plus hidden
  inputs, assert **Scope: visible set**, zero effects outside the captured box,
  full-precision target coordinates, immutable scope after later box edits,
  and no occlusion scoping. Drape-target deletion disables stale output;
  mapping-change races assert every §3.6 consumer result; jobs survive renderer
  reload and cancel from Jobs.
- **push/release, `browser-gpu` — G-RA-1:** self-launching
  `bench-raster-drape.mjs`; large mismatched-GSD drape + 65% opacity orbit has
  presented-frame-interval p95 ≤ 2× target frame time, using rAF/present deltas
  (VB-D7 metric, never render-body cost); zero visible tile cracks.
- **push/release, `browser-gpu` — G-RA-2:** marker and clip-vertex drag bursts,
  same p95 bound; numeric fields match sampled preview state each frame.
- **release, `real-data` + `browser-gpu` — G-RA-REAL:** real COG + DGM drape,
  NoData holes, settled rebuild, cancellation with no partial publication;
  polygon crop mask and Grid→Tin under locked/unlocked active boxes and hidden
  inputs, with zero output outside captured scope; full app restart during
  staging/drape/crop/Grid→Tin verifies the §3.6 Needs placement / Needs rebuild /
  Interrupted-retry states and atomic links. Exact source passthrough succeeds
  only unchanged; modified/generated/style-only cases expose the exact losses
  and write no file.
- **automation — G-RA-SDK:** generated SDK parity for every catalog command;
  exact/noisy/outlier and three-point-no-redundancy registration cases return
  the same typed per-control report; end-to-end display+drape, clip+polygon
  crop, and Grid→Tin with captured scope; `jobs.list/cancel` observes long
  operations and recovered states.
- **cross-domain display — G-RA-DISPLAY:** mixed cloud+raster+mesh scene:
  raster canonical monochrome survives View override/bookmark changes; raster
  opacity never affects cloud/mesh; View override changes only the VD-D8 upper
  layer and never journals raster state. Gate activates after the VD-D6/VD-D8
  amendment.
- **manual/E1 — G-RA-VISUAL:** both themes, both 2D and 3D where applicable,
  screenshots compared against §8.

Unverified until implementation: subjective ramp aesthetics beyond exact stop
sampling; residual warning calibration; touch hardware gestures. They are
manual/tunable, not silent completion claims.

## 8. E1 failable visual and behavioral criteria

1. **Properties:** uses shared controls/tokens; opacity slider and field agree;
   ramp legend prints actual min/max; hillshade never changes reported XYZ.
2. **Drape:** 65% image exposes underlying geometry; no cracks, skirts, color-
   resolution collapse, or invented fill across NoData at any sampled LOD;
   **Scope: visible set** names the active box/hidden inputs before Apply.
3. **Elevation:** ramp pixels match declared stops; constant-height Grid is one
   stable color; NoData is absent, not minimum-color; fixed/View-light states
   are distinguishable and named.
4. **Registration:** paired numbered markers remain legible over darkest and
   brightest scan regions; the two canvases and table remain usable at the
   minimum window size; Transform, use, weight, dX, dY, planar residual, RMS,
   maximum, warning, and worst-pair framing are visible without ambiguity;
   staged status cannot be mistaken for world placement.
5. **Clip/crop:** kept boundary uses the shared fence accent; excluded pixels
   including polygon-bounding-box corners are absent, not merely dimmed or
   transparent; source and cropped product are visibly named as separate tree
   entities with stale/source-missing state where applicable.
6. **Themes and states:** screenshots cover dark/light, idle/hover/focus,
   Mixed, preparing, cancelled, failed, missing-terrain, and Not georeferenced;
   no unstyled native/product controls or one-off colors.

## 9. Owner-decision items

None. The escalation protocol was applied and dissolved every candidate:

- “May image pixels snap?” is closed by X1 plus DR-D12/DR-D13 (RA-D3).
- “Where may an unreferenced scan appear?” is closed by X1 and the data model's
  missing-coordinate rule, ADR 0022, and DR-D3; `PlanGrid2D` plus staging
  preserves the workflow without invented truth (RA-D11).
- “Helmert or affine?” is closed by X1/X4, the RIB background-plan evidence,
  and the existing dual-model transformation contract; model availability is
  fixed and only warning calibration remains delegated (RA-D2).
- “Does active view state scope a bake?” is closed by P4; captured immutable
  arguments dissolve the live-vs-full ambiguity (RA-D12).
- “Does crop destroy the source, and how are polygon corners represented?” is
  closed by X1/X2/X5 and ADR 0020's validity separation (RA-D6).
- “What survives a crash?” is closed by P5, UIP-D10/UIP-D11, and ADR 0016's
  immutable-artifact-before-link rule (RA-D13).
- “Who owns Grid→Tin?” is closed by PC-D9 generalized under X7 and the existing
  Mesh contract (RA-D7).
- “Who owns Raster monochrome?” is closed by X3/X7 plus VD-D8's two-layer
  class; Raster owns the canonical lower layer and View must narrow its upper
  overrides by cite-and-revise (RA-D1).
- “Can passthrough export write the source after edits?” is closed by FP-D5 and
  the provider's existing loss/refusal behavior; without the required proof,
  style-only revision stays conservatively refused (RA-D9).

No axiom conflict, reserved scope, licensing, or product-identity question
survives; owner-decision count is zero.

## 10. Cross-spec cite-and-revise results

The consolidated 2026-09-02 reconciliation applied each owner-file side:

1. **View:** VD-D8 names Raster opacity/source/monochrome as canonical
   lower-layer style; VD-D6 makes `view.render-style` Mesh/BIM-only and leaves
   Raster unaffected. G-RA-DISPLAY is registered against the shared boundary.
2. **Mesh & Terrain:** MT-D6/catalog/B1 cite RA-D5's Raster-tab
   elevation-display fan-in and accept hillshade with its typed parameters.
   MT-D22 cites RA-D7 and specifies Grid/Tin arrival validation, editability,
   display, MT-D12 snap registration, and provenance.
3. **Registry:** all six §1 rows, access
   paths, performance classes, commands, shortcut absences, and both §4 armed-
   tool gesture sets; replace §5.2's pending Raster text; link PC-D9 to ordinary
   Raster arrival and RA-D7 to the Mesh product; record the VD-D6/VD-D8 layer
   boundary are registered; this check passes in the 2026-09-02 rebuild.
4. **File/import-formats:** FP-D13 and IF-D12 retain the plain TIFF/PNG/JPG and
   TFW/JGW staging/provider hand-off and return the project-managed staged
   source used by RA-D13 rather than publishing an invented world entity.

## 11. Disposition — raster spec review 2026-09-02

| Finding id  | Disposition                                                                                                                                                                                                                                                                                   | Spec section / decision id                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1 (blocker) | **Resolved:** explicit `PlanGrid2D` canonical mapping, plan-only admission, no placement/depth, no invented Z; explicit ADR 0016 admission/migration/generated-binding/sibling-reader delta. The unsupported explicit-plane sentence was removed, so no half-specified plane command remains. | §1.1, §2.1, §6; RA-D11                            |
| 2 (blocker) | **Resolved:** drape, crop, and Grid→Tin show and freeze the P4-visible set; visibility/active clips scope, natural occlusion does not; georeference target picks use the same pipeline; locked/unlocked cases added.                                                                          | §2.2, §3.3–§3.4, §7; RA-D12                       |
| 3 (major)   | **Resolved:** Helmert default/Affine choice, minimums and affine redundancy warning, typed weights/use state and dX/dY/norm/RMS/max, rejection/acknowledgement rules, parameters, exportable report, and test matrix.                                                                         | §2.1, §3.2, §7–§8; RA-D2                          |
| 4 (major)   | **Resolved:** georeferencing moved to a dedicated resizable two-canvas/table window; actual shared UI/backend semantics cited; close/Escape/layout and canvas-specific gestures defined.                                                                                                      | §1, §2.1, §3.2, §4; RA-D2, RA-D10                 |
| 5 (major)   | **Resolved reciprocally:** adopted VD-D8's two layers, fixed Raster at the canonical lower layer, excluded Raster from upper overrides, and added mixed-scene verification; VD-D6/VD-D8 now carry the matching boundary.                                                                      | §3.1, §7, §10.1; RA-D1; VD-D6/VD-D8               |
| 6 (major)   | **Resolved:** polygon crop gains an exact immutable image kept-pixel mask distinct from alpha/depth validity, shared by all consumers with explicit undo/provenance semantics.                                                                                                                | §3.3, §6–§7; RA-D6                                |
| 7 (major)   | **Resolved:** mutation-by-consumer and renderer/full-restart recovery matrices cover mapping/style/source changes, staging, pair checkpoints, drape/crop/Grid→Tin, atomic publication, retry, and stale products.                                                                             | §3.6, §7; RA-D13                                  |
| 8 (major)   | **Resolved:** native, GeoTIFF variants, DXF, LandXML, IFC, and splat PLY have availability/output/loss/execute/display rows; style-only GeoTIFF keeps the proven conservative refusal; per-row and unknown-loss tests added.                                                                  | §3.5, §7; RA-D9                                   |
| 9 (major)   | **Resolved:** false elevation-ramp absence withdrawn; Trimble Perspective evidence and the surface-domain deviation are explicit in the overview, dossier disposition, A2, and decision derivation.                                                                                           | introduction, §1.2, §3.1; RA-D5                   |
| 10 (major)  | **Resolved by round 3:** the consolidated rebuild records the rows, labels, commands, and shortcut absences requested in §10.3.                                                                                                                                                               | §1, §10.3; REGISTRY §1.7                          |
| 11 (minor)  | **Resolved reciprocally:** Raster contributes the hillshade/ramp access path; MT-D6 accepts it and MT-D22 consumes RA-D7 Grid→Tin arrival semantics.                                                                                                                                          | §1, §3.1, §3.4, §10.2; RA-D5, RA-D7; MT-D6/MT-D22 |
| 12 (minor)  | **Resolved:** declaration-only citations replaced with decoder, GPU-resolution/shader, and DXF planner paths; absence claims state the repo-wide search surface.                                                                                                                              | §1, §3.1, §3.5, §6                                |
| 13 (minor)  | **Resolved:** every visible ribbon/context/Properties label names its canonical command and every shortcut absence has the required rationale.                                                                                                                                                | §1, §3.1–§3.4                                     |

## Cross-spec reconciliation 2026-09-02

| Item                      | Disposition                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File/Import               | Plain image/world-file sources stay staged and follow RA-D13 recovery until `raster.georeference.apply`; both owners cite this boundary.                            |
| Mesh                      | MT-D6 cites RA-D5 and accepts Raster-tab ramp/hillshade fan-in; MT-D6/MT-D22 cite RA-D7 Grid→Tin arrival.                                                           |
| View                      | VD-D8 names Raster RA-D5 as a canonical lower display-layer owner and excludes Raster from Mesh/BIM render-style overrides.                                         |
| Pointcloud                | PC-D9 generation ↔ Raster artifact ownership remains one command/product hand-off and is registered.                                                                |
| PhotoLab product arrivals | IF-D19/IF-D25 DEM Grid and orthomosaic products adopt RA-D11 and Raster's ordinary post-commit contract; IF-D20 remains the sole generated import exposure.         |
| P10/G12 dependency        | RA-D15 supplies Raster drape payload/output rules while MT-D25 alone owns `derived.recipe.*`; SE-D20/IF-D18 invalidations arrive once at gesture/transaction end.   |
| Semantic cursor           | Raster cites UIP-D24/§9.7 and declares non-raster exact-provider pick/snap, move/crop handles, prohibited, and wait; raster pixels never supply snap markers.       |
| Batch-2 GAP attribution   | RA-D14 derives the Raster-owned signed Grid/report split from GAP-D8 and its visual gate from GAP-V10; GAP-D7 remains Mesh-window-only.                             |
| GAP §6 Civil inbound      | RA-D5/RA-D7 are amended by RA-D14/RA-D15 citations to CIV-D5/CIV-D15 and MT-D25 for corridor/difference evaluator arrivals without taking Civil or Mesh authority.  |
| Re-walk 2026-09-02        | Complies with P5/P6 and current C4/D1/X3/B1/A2 rules: marker/clip gestures journal once; close/cancel/recovery are explicit; no office convention is mandated (P7). |

## Owner statements batch 2 — 2026-09-02

This section amends RA-D4/D5/D7/D12/D13. **Height difference raster** accepts two
surface/cloud evaluators, explicit `A minus B` sign, CRS/datum, grid origin and
resolution, exact boundary, NoData policy, and a named editable color/legend
definition. Cloud inputs use PC-D17 mean-height evaluators. Preview may use a
declared coarser LOD; final cells never do. Commit publishes one canonical signed
Grid plus a linked legend definition and exportable legend raster, recording
sources/revisions, evaluator versions, units, zero, min/max, class boundaries,
NoData, and resolution. The viewport and Properties show sign and Stale state.
Cancel publishes nothing; partitions checkpoint/restart; late revision mismatch
rejects publication; File owns export plan/execute.

Raster drape recipes now follow P10/MT-D25: linked by default, Stale at gesture end,
journaled Regenerate, automatic only under a recorded cost budget, Detach with
recipe provenance, auto-detach/console note on missing support, DAG validation, and
creation-error reuse. The last good drape may remain visibly stale but is never
labeled current. Raster owns this drape command/product, not the common state
machine.

Civil corridor products enter this spec only after Civil CIV-D5 hands a typed
manifest to Mesh and Mesh publishes an evaluator/surface under MT-D26; Raster does
not evaluate alignment or width-band semantics itself.

Registry entry applied by the round-3 rebuild: new `raster.difference` (Raster · Analyze;
assistant + viewport/Properties; `raster.difference.preview/create` and linked
legend queries/export hand-off). Existing `raster.drape` contributes access to
MT-D25's `derived.recipe.get/list/status/regenerate/detach/relink`; no second
drape or recipe act is created.

**RA-D14 — Signed difference Grid and legend are Raster products.** **Decision:**
the assistant, canonical Grid, linked legend and raster legend, provenance/NoData,
stale/rebuild/export contract are as above; Pointcloud retains inspection metrics
and Mesh retains evaluators/solids. **Derivation:** S11, P10, X1, X3, PC-D17,
MT-D27, GAP-D8, GAP-V10. **Rejected:** a transient shader-only heat map; calling cloud
inspection metrics a Grid; presenting preview resolution as final. **Tunable:**
resolution, ramp classes, and worker budget.

**RA-D15 — Drape is a P10 recipe consumer.** **Decision:** RA-D4's drape lifecycle
cites the single MT-D25 model, including Detach/auto-detach/DAG. **Derivation:**
S14/G12, P10, MT-D25, SE-D20, IF-D18, X1. Source/import/placement changes emit
one invalidation at transaction or gesture end; Raster changes no sibling source.
**Rejected:** silent cache rebuilds without recipe state;
a Raster-specific dependency model. **Tunable:** automatic-regeneration budget.

E1 follows GAP-V10. Tests cover sign reversal, zero/min/max/units, Grid×Tin and
cloud-mean evaluators, mismatched extents/resolutions, NoData, preview/final
separation, legend-raster export, cancel/restart/revision race, and all P10 drape
transitions including a cycle refusal.

| Work-order item                                     | Disposition                                        |
| --------------------------------------------------- | -------------------------------------------------- |
| S11 surface/cloud difference Grid and legend raster | Applied by RA-D14.                                 |
| S14/G12 drape recipe                                | Applied by RA-D15, citing the single MT-D25 model. |
