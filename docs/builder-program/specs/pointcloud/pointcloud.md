# Pointcloud domain — domain specification

Status: specified (registry 2026-09-02 incremental). Round-3 registry rebuild through batch 2; owner batch-3 ground/floor catalog rows are registered. Real-data gate remains an implementation blocker. Revised 2026-09-02. Document class:
plan. Walks
`docs/FUNCTION-CONTRACT.md` per function group, including the 2026-09-01
additions (A2 silence + code-claim + catalog-disposition rules, E2
extreme-class-member and gesture-arbitration rules); every consequential
choice carries a `docs/DECISION-DOCTRINE.md` decision record; destructive
scoping derives from precedent **P4**. Primary evidence:
`docs/builder-program/dossiers/realworks.md` (the named reference for the
point cloud domain, realworks.md §1); supporting evidence:
`dossiers/trimble-perspective.md` §2.2 (display modes), `dossiers/revit.md`
§3 W3 and §5 (multi-select properties model), `dossiers/rib-civil.md` §2.6
(Punktwolke app). Sibling specs: `specs/view/viewing-box.md` (VB-D3,
VB-D11, VB-D13 interlock), `specs/view/view-domain.md` (the shared VD-D8
two-layer display model), and `specs/ui-platform/ui-platform.md` (viewport
gesture map, UIP-D10 job registry, UIP-D14 Escape ladder). E1 reference
artifact: §7 of this document
(in-repo written criteria; no third-party screenshots per repository
license discipline).

Resolution levels per `docs/builder-program/README.md`: **workflow level**
for segmentation, classification, extraction, display properties (§2), and
ground/floor extraction (§10);
**contract level** for sampling, merge, and ortho-image (§3.2–§3.3);
**catalog level** for inspection functions, with the deferral reasoned in
PC-D10.

## 1. Function catalog

Ribbon tab: **Pointcloud** (owner decision D2). Groups: Segment, Classify,
Cloud, Image, Analyze. All ids are registry rows recommended to
`REGISTRY.md`; automation namespace `pointcloud.*` follows the
`viewing_box.*` convention. "Context" = entity context menu on a
point-cloud entity. Status abbreviations: _new_ = no implementation;
_partial_ = machinery exists below the UI; _unwired_ = ribbon button exists
without a handler.

| Id                                    | Ribbon group                                    | Access paths                                                                                             | Surface                                         | Perf class                               | Automation                                                                                                               | Status vs current                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pointcloud.segment`                  | Segment                                         | ribbon toggle; context "Segment"; in-tool keys (PC-D2)                                                   | viewport takeover + right panel                 | continuous (fence), bounded→long (apply) | `pointcloud.segment.apply`                                                                                               | new; `segment.*` buttons unwired (`ribbon.ts:114-127`, no App.tsx handler)                                                                                                                                                                                                                                       |
| `pointcloud.classify`                 | Classify                                        | verb inside segmentation tool; context "Classify to class…"                                              | same surface as segment                         | bounded (recolor), bounded→long (apply)  | `pointcloud.classify.apply`                                                                                              | new; `segment.classify` unwired                                                                                                                                                                                                                                                                                  |
| `pointcloud.classes`                  | Classify                                        | ribbon "Classes" (palette + class table); properties panel                                               | floating island                                 | bounded                                  | `pointcloud.classes.get/set`                                                                                             | new; renderer palette exists (`render_world.rs:63-67`)                                                                                                                                                                                                                                                           |
| `pointcloud.extract`                  | Cloud                                           | verb inside segmentation tool; viewing-box panel (VB-D11); context "Extract region…"                     | command + UIP-D10 registered job                | long-running                             | `pointcloud.extract`                                                                                                     | new; `segment.extract` unwired                                                                                                                                                                                                                                                                                   |
| `pointcloud.sample`                   | Cloud                                           | ribbon "Sample…"; context                                                                                | right function panel + UIP-D10 registered job   | long-running                             | `pointcloud.sample`                                                                                                      | new                                                                                                                                                                                                                                                                                                              |
| `pointcloud.merge`                    | Cloud                                           | ribbon "Merge"; context on multi-selection; Ctrl+M recommended to `REGISTRY.md` (realworks.md §2.3 [22]) | command + small dialog + UIP-D10 registered job | long-running                             | `pointcloud.merge`                                                                                                       | new (import-time E57 scan merge exists, `e57_import.rs:73`, but no user command)                                                                                                                                                                                                                                 |
| `pointcloud.ortho_image`              | Image                                           | ribbon "Ortho-image…"                                                                                    | tool window + UIP-D10 registered job (B3, §3.3) | long-running                             | `pointcloud.ortho_image.generate`                                                                                        | new; boundary with Raster domain (PC-D9)                                                                                                                                                                                                                                                                         |
| `pointcloud.display`                  | — (properties panel)                            | properties panel group; context "Display properties"                                                     | right properties panel                          | bounded                                  | `pointcloud.set_display` / property commands (color source, opacity, vertical exaggeration, point size, mode parameters) | partial: renderer supports all modes (`render_world.rs:52-72`) and per-entity styles (`render_world.rs:710`), but Builder hardcodes `POINT_CLOUD_STYLE` (`BuilderKernelViewport.tsx:59-73`) and today's `view.opacity` / `view.exaggeration` mutate transient group appearance; the View color button is unwired |
| `pointcloud.point_size` (per entity)  | — (properties panel)                            | properties panel; automation                                                                             | right properties panel                          | bounded                                  | via `pointcloud.set_display`                                                                                             | new: `RenderStyle` has no point-size field (`render_world.rs:228-245`); size is a global frame uniform today (`gpu_surface.rs:52-53`, wasm `set_point_size`)                                                                                                                                                     |
| `view.point-size` (view multiplier)   | View tab (existing)                             | ribbon popover; console `view.point-size <factor>`                                                       | popover                                         | bounded                                  | `view.point_size.set`                                                                                                    | exists as global px (`App.tsx:73,602-606`); relabeled unitless × multiplier, default 1.0 (PC-D11)                                                                                                                                                                                                                |
| `pointcloud.inspect.surface_to_model` | Analyze (group absent until specified)          | none yet — no disabled placeholder buttons (§3.4)                                                        | tool window                                     | long-running                             | deferred                                                                                                                 | catalog only (PC-D10)                                                                                                                                                                                                                                                                                            |
| `pointcloud.inspect.cloud_to_cloud`   | Analyze (group absent until workflow promotion) | none yet — no disabled placeholder buttons (§3.4)                                                        | tool window                                     | long-running                             | deferred                                                                                                                 | catalog only (PC-D10); Twin Surface/cloud-to-cloud evidence: realworks.md §2.7/W8                                                                                                                                                                                                                                |
| `pointcloud.inspect.floor_flatness`   | Analyze (group absent until specified)          | none yet — no disabled placeholder buttons (§3.4)                                                        | tool window                                     | long-running                             | deferred                                                                                                                 | catalog only (PC-D10)                                                                                                                                                                                                                                                                                            |
| `pointcloud.inspect.wall_verticality` | Analyze (group absent until workflow promotion) | none yet — no disabled placeholder buttons (§3.4)                                                        | tool window                                     | long-running                             | deferred                                                                                                                 | catalog only (PC-D10); realworks.md §2.7                                                                                                                                                                                                                                                                         |
| `pointcloud.grid-mean-sample`         | Pointcloud · Cloud                              | R X C A; Mesh hand-off                                                                                   | RP + job                                        | long                                     | `pointcloud.sample.grid_mean`                                                                                            | Not implemented — batch-2 (D7) capability; PC-D17                                                                                                                                                                                                                                                                |
| `pointcloud.station-corridor-sample`  | Civil hand-off                                  | C A                                                                                                      | paged job result                                | long                                     | `pointcloud.sample.station_corridor`                                                                                     | Not implemented — batch-2 (D7) capability; PC-D18                                                                                                                                                                                                                                                                |

VD-D8's command hand-off is claimed by `pointcloud.display`: per-entity
opacity and vertical exaggeration are fields of the canonical display-style
resource and are set through `pointcloud.set_display` (or the generic property
commands). The existing group-scoped console commands `view.opacity` and
`view.exaggeration` migrate to this entity-targeted canonical path; they are
not view-presentation overrides. Every long-running row that ships registers
with the main-process job registry and uses its status-bar chip, jobs island,
and per-job cancellation contract (UIP-D10).

PhotoLab arrivals use the same acts, not import aliases. IF-D19/IF-D20/IF-D25
publish ordinary `hcad.point-cloud@1` entities and, after canonical admission,
`hcad.gaussian-splat-cloud@1` entities. Pointcloud explicitly owns the latter's
streamed render, entity/bounds pick and snap, P9 selection, whole-entity
placement, tree/Properties display controls, Plan capture, export-loss review,
WeltView read-only projection, and paged automation semantics. Per-point splat
editing is unsupported until an admitted representation provides stable point
identity. This is an ownership row over the existing `pointcloud.display` and
selection/edit acts, not a second function or import command; IF-D20 remains the
only product-dataset registration exposure.

Catalog boundaries and queued entries:

Viewer Core's hierarchy/budget and adaptive point-presentation amendments cite PC-D5/PC-D11 in `../view/viewer-core-addendum.md` (VC-D2/VC-D3/VC-D5/VC-D6); this spec remains the pointcloud owner.

- **Registration and station view** (realworks.md §2.1 Scan Explorer, §2.2,
  W1–W2) belong to
  `docs/builder-program/specs/registration-stations/registration-stations.md`.
  That specification owns station view and cloud-to-cloud registration. They
  are cited here, not dispositioned or double-booked here; interactive import
  registration already has ADR 0025.
- **Queued** (PC-D15 backlog, evidence cited there): auto-segment moving
  objects / steel beams / reflections, noise reduction (realworks.md §2.3);
  remaining indoor/outdoor class families after the ground/floor slices
  promoted by PC-D19/PC-D20 (realworks.md §2.4); circle fence and
  region-grow "magic wand" fences (realworks.md §2.3); scan-based sampling
  and scanner-range filtering (realworks.md §2.1); push-to-raw-scan
  deletion (realworks.md §2.3 "Remove Points from TZF Scans"); densifying
  re-extraction (realworks.md §2.5 [8], shared with VB-D11).
- **Draw/Mesh/Raster/BIM neighbors**: profile extraction and cloud
  digitizing (rib-civil.md §2.6) belong to Draw; meshing and volumes to
  Mesh (realworks.md §5); ortho-image _output_ to Raster (PC-D9).

### 1.1 Dossier catalog disposition

Per the contract's catalog-disposition rule, every realworks.md catalog
row touching this domain gets an explicit disposition; omissions are
decisions, not accidents. Rows owned by other domains are marked with
their owner.

| Dossier row (realworks.md)                                                       | Disposition                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Import scans; station sampling on import (§2.1)                                  | other domain: File (import), per realworks.md §5                                                                                                 |
| Sampling — spatial, intensity (§2.1)                                             | adopted: `pointcloud.sample` (§3.2)                                                                                                              |
| Sampling — scanner range (§2.1)                                                  | deferred: needs per-point range attribute from structured scans (PC-D15)                                                                         |
| Scan-Based Sampling > Split per Scan (§2.1)                                      | deferred with scan-station tooling (PC-D15)                                                                                                      |
| Project tree, groups, batch rename (§2.1)                                        | other domain: ui-platform / file-project                                                                                                         |
| Scan Explorer (§2.1)                                                             | deferred: station-centric raw-scan viewing needs the station domain first (PC-D10 class)                                                         |
| Registration rows (§2.2)                                                         | other spec: registration domain (§1 boundary note; ADR 0025)                                                                                     |
| Segmentation tool (§2.3)                                                         | adopted: `pointcloud.segment` (PC-D2/PC-D3)                                                                                                      |
| Auto-Segment Moving Objects / Steel Beams / Reflection (§2.3)                    | deferred: algorithm projects on the same command surface (PC-D15)                                                                                |
| Remove Points from TZF Scans (§2.3)                                              | deferred: no raw-scan write-back path exists (PC-D15)                                                                                            |
| Noise Reduction (§2.3)                                                           | deferred (PC-D15)                                                                                                                                |
| Cloud merge, Ctrl+M (§2.3 [22])                                                  | adopted: `pointcloud.merge` (§3.2)                                                                                                               |
| Auto-Classify Indoor / Outdoor (§2.4)                                            | partially adopted: Ground and Floor extraction are workflow-level PC-D19/PC-D20; remaining indoor/outdoor class families stay deferred in PC-D15 |
| Layer/class management (§2.4)                                                    | adopted: `pointcloud.classes` (PC-D6)                                                                                                            |
| Limit box rows (§2.5)                                                            | other spec: `specs/view/viewing-box.md`                                                                                                          |
| Limit Box Extraction (§2.5)                                                      | adopted: `pointcloud.extract` (PC-D7); densifying re-extraction deferred (PC-D15)                                                                |
| Cutting plane (§2.5)                                                             | other domain: View (section planes)                                                                                                              |
| Measurement/annotation rows (§2.6)                                               | persistent inspection measurements: Measure/Inspect MI-D2/MI-D9; construction annotations: Draw DR-D9; named views: View VD-D3                   |
| Surface to Model / Twin Surface / 3D+2D Inspection (§2.7)                        | deferred: cataloged Analyze rows, PC-D10                                                                                                         |
| Floor flatness / Wall verticality (§2.7)                                         | deferred: cataloged Analyze rows, PC-D10                                                                                                         |
| Tank calibration & inspection (§2.7)                                             | rejected for the catalog: vertical-market edition feature with no owner-stated demand; revisit only on demand (X4 deviation, stated)             |
| Volume calculation (§2.7)                                                        | other domain: Mesh (realworks.md §5)                                                                                                             |
| Mesh/modeling/drawing rows (§2.8)                                                | other domains: Mesh / Draw / BIM (realworks.md §5)                                                                                               |
| Ortho-Projection / Multi Ortho (§2.8)                                            | adopted: `pointcloud.ortho_image` (PC-D9)                                                                                                        |
| Convert to Ortho-Image / rectification / matching / RealColor / key plans (§2.8) | other domain: Raster (realworks.md §5)                                                                                                           |
| Export/publishing rows (§2.9)                                                    | other domain: File                                                                                                                               |
| Viewing/navigation rows (§2.10)                                                  | other spec: view domain / ui-platform                                                                                                            |

## 2. Workflow narratives

### 2.1 Segmentation — cleaning a scan

The user has an imported, registered cloud with scan artifacts: a passing
truck, reflections, vegetation over a curb line. With the cloud selected
(the ribbon group is disabled otherwise, PC-D4) they press **Segment**. The
button lights, the right panel opens, and the viewport enters fence mode:
the status line reads "Draw a fence — polygon (X), rectangle (S), lasso
(L)". While the tool is armed, the left button belongs to the fence:
clicks place polygon vertices, press-drag draws the lasso or rectangle;
middle-drag orbits, wheel zooms, and right-drag pans exactly as before —
but only while no fence is open. With an open fence, navigation gestures
are rejected with a status-line explanation ("Close or discard the fence
to navigate"), because open-fence vertices live on the view plane until
the fence closes (v1 restriction; the reference's mid-fence navigation
behavior is undocumented — logged as a dossier gap per the contract's
silence rule, not invented). The user draws a polygon around the truck;
vertices commit per click, Ctrl+Z removes the last vertex
(realworks.md §2.3 per-vertex undo), a double-click or Enter closes the
fence. Closing binds the target: the panel header now reads "Applies to:
1 cloud", and changing the selection afterward affects only the _next_
fence, never this one (C2). On a closed, unapplied fence Ctrl+Z removes
the closing edge and resumes per-vertex undo; Escape discards it. The
fence overlay fills its interior with the shared selection tint and the
panel shows the verb choices: **Keep**, **Delete**, **Extract**,
**Classify** — each available for **inside** or **outside** the fence
(X5 pair, PC-D3). The apply acts on what the user sees (doctrine **P4**):
the fence volume is intersected with the active viewing box and the
visible-class set, so clipped-away storeys and hidden classes are never
silently edited — natural occlusion, by the same precedent, does not
scope anything: the fence cuts through depth. When a box is active the
panel names the scope — "Scoped to: Stairwell B" — and clicking it jumps
to the box panel (finding 16, adopted). They press Delete-inside: within
a blink the truck's points vanish (mask applied to every rendered node,
streamed-in ones included, PC-D14), the console logs the command with the
affected point estimate, and a background compaction job registers with
the main-process job registry (UIP-D10) and starts rebaking the tiles. The
status-bar jobs chip exposes it; opening the jobs island shows its real phase
progress and cancel action, while the console retains the log. Cancelling
keeps the visually identical mask state; nothing partial ever publishes
(PC-D1). The user fences and deletes twice more,
orbiting freely between fences — navigation stays smooth the whole time,
the bar RealWorks sets and its users complain about when missed
(realworks.md §4 "interaction stability during segmentation"); the
fifteen-applies-in-ten-minutes session is the norm, so compaction
coalesces: at most one job per entity, always targeting the newest
revision, superseded jobs dropped (PC-D1). Each apply is one journal
step: Ctrl+Z restores the truck exactly, including its classification
codes — and undo during a running compaction cancels or supersedes it;
nothing partial publishes. Escape follows one ladder, one rung per press:
open or closed-unapplied fence → discard it, keep the tool; no fence →
close the tool and panel; the ribbon button and the panel's close
affordance always close (B2). Everything the tool did is replayable: the
journaled command stores the projection-true fence volume — a prism in
orthographic views, a polygonal frustum with its apex at the eye in
perspective views, so the stored volume is exactly the shape the user saw
tinted — plus side, verb, and the effective P4 scope, never screen
pixels, so replay and automation need no camera (PC-D5, PC-D16).

### 2.2 Classification — manual classes and the palette

The same fence surface classifies. The user opens **Classes** on the
Classify group: the ribbon button is a pure toggle (VB-D14 class rule)
for a small island with its own close affordance. It registers as a
**detached function island**, so when topmost its close occupies UIP-D14
Escape rung 6, after any inner field, drag, or menu rung and before the
active function-tab and selection rungs. The island lists the project's
classification table —
LAS-compatible codes 0–255 with names and palette colors, seeded from the
built-in civil/LAS palette (`render_world.rs:62` empty-palette behavior)
and per-project editable (PC-D6). They fence the ground floor slab,
choose the verb **Classify** → class "Floor", apply: a journaled command
stamps the class code onto the fenced points. To see the result they
switch the cloud's color source to **Classification** in the properties
panel — the recolor is effectively instant, because color modes map
per-point attributes without rebuilding geometry (`render_world.rs:45`) —
and the cloud renders in palette colors. Unchecking a class's visibility
box in the Classes island hides those points — and that toggle is itself
a journaled canonical command (PC-D6): visibility scopes picking,
measurement, and destructive applies (P4), so it must be restorable,
undoable, and automation-visible like viewing-box activation is; picking,
snapping, and measurement ignore hidden points by the same precedent.
Exports are the deliberate exception: they include class-hidden points —
an export is data, not styling — and the export dialog says so when
classes are hidden (P4 governs geometry _actions_, and the export-reads-
canonical-data rule is the viewing-box E2 precedent for exactly this). Misclassified regions are fixed the
same way RealWorks users fix auto-classification (realworks.md W5 step 2):
fence, classify again; each apply is one undo step. The class table and
palette are canonical project resources — an agent can list classes,
classify a fenced volume, and restyle the palette through the same
commands (X3).

### 2.3 Extraction — a region becomes its own cloud

The user wants the stairwell as its own entity for a subcontractor. Two
equivalent doors, one command: fence the stairwell in the segmentation
tool and press **Extract**, or use the viewing-box panel's extract button
on the active box (this spec supplies the command both surfaces call; viewing-box
VB-D11 now un-queues its extract item onto `pointcloud.extract`). A name prompt
defaults to "Cloud — extract 1";
they type "Stairwell B". Extraction is long-running and therefore registers
with UIP-D10: the status-bar chip and jobs island expose real tile-scan/rebake
progress and cancel, and cancellation publishes no entity; on completion a
new canonical
`hcad.point-cloud@1` entity appears in the entity tree with its own fully
baked, content-addressed prepared dataset (the `potree-<manifest-hash>`
layout, `las_import.rs:553`; ADR 0003 format), carrying
the source's classification codes, intensity, and colors, plus a recorded
relation to its source entity. The source cloud is untouched — extract
copies; removing the region from the source is a separate Delete apply,
deliberately two undo steps (PC-D7). Orbiting the new entity alone feels
exactly like having imported a stairwell-sized scan — P2 verbatim, gated
in §6. Undo tombstones the new entity; redo restores it without rebaking
(the dataset is content-addressed and kept). Automation parity:
`pointcloud.extract` takes an entity id plus a world-space region (any
PC-D5 volume — prism, frustum — or a box), returns the new entity id,
and `"extract the active viewing box to a new cloud"` is a two-call
agent script.

### 2.4 Display properties — one cloud, many clouds

A cloud entity's **Display** group lives in the right properties panel
(selection-driven, like every entity property). It shows: **Color
source** — Uniform, Source colors, Height, Intensity, Classification,
Return number, Scan source (PC-D11; renderer enum `render_world.rs:52-72`);
beneath it the source-specific parameters: uniform color swatch, height
gradient with typed minimum/maximum and ramp choice (typed min/max per
Trimble Access, trimble-perspective.md §2.2 [S8]), palette reference for
classification; typed **Opacity** and **Vertical exaggeration** fields;
and **Point size** — **Auto** (the renderer picks the
size adaptively; the default) or a typed pixel value, with a reset-to-Auto
affordance next to the field (C1: every displayed number is typeable).
Changing any of these is a journaled canonical command on the entity's
style (`SetStyleRef`, `canonical_document.rs:124`): the display setup
survives reload, travels in `.hcadx` archives (D1), is undoable, and
automation renders reproduce it (X3, P1). This is VD-D8's lower canonical
layer; the former group-scoped `view.opacity` / `view.exaggeration` console
paths migrate to `pointcloud.set_display` with entity ids. The **view point
size** control
on the View tab is relabeled to what it becomes: a unitless **×
multiplier** over per-entity sizes, default 1.0, view-local
(`App.tsx:73`), the justified view-local exception (PC-D11); automation
renders use × 1.0 unless their view state sets it, so agent screenshots
are workstation-independent.

Because the reference posture is view-level display (Perspective's color
and size options are rendering settings of the views, not cloud
properties, trimble-perspective.md §2.2), VD-D8 supplies a second layer
above those entity styles. The View tab's **Color mode override** is
un-journaled, project-persisted view presentation whose default is **Follow
entity display**. Choosing a mode overrides every cloud only while rendering
this view; it never writes an entity style or a journal entry, and switching
back to Follow entity display reveals the canonical styles unchanged.

The scene-wide _canonical_ recolor path remains one gesture: use tree Ctrl+A
to select all clouds, then change Color source once. The Mixed edit commits
to the whole selection as **one**
journaled multi-entity command (PC-D12/PC-D13). The ribbon override sits
above that path; it is not a scene-wide canonical accelerator (VD-D8,
revising the original PC-D11 accelerator clause).

Multi-select follows the Revit properties contract (revit.md §3 W3, §5
"adopt Revit's proven contract"): select three clouds and the panel header
shows the type and count; only properties common to all display; a
property whose values differ shows the shared Mixed placeholder (already
implemented: `property_schema.rs:236-241`, `App.tsx:1019`); typing or
picking a value pushes it to the whole selection as one journaled
multi-entity command (`MultiEntityPropertyEditRequest`,
`property_schema.rs:286`). Setting Color source = Classification on a
mixed selection where one cloud lacks classification data **must** fall
back to Source colors for that cloud at render time, and the panel notes
the fallback rather than blocking the edit. This fallback is specified,
not current behavior: the renderer documents it only for intensity
("retaining source color when absent", `render_world.rs:59`), and the
classification shader path has no absent-attribute branch — the packed
attribute defaults to 0 and would paint an unclassified cloud in the
class-0 color (`shaders/mixed.wgsl:290-294`); §6 names the test. Improvement over the
reference, carried from revit.md §5: the edit is applied without a modal
"Edit Type" detour, and the console logs how many entities changed.

## 3. Function contract

### 3.1 The fence family: segmentation, classification, extraction

**A1 — User outcome.** §2.1–§2.3 in full.

**A2 — Reference behavior.** RealWorks segmentation (realworks.md §2.3,
W4): fence-based split with polygon/rectangle/circle/magic-wand fences on
in-tool shortcuts, in/out keep, per-vertex undo, Production-mode gating
with a cloud selected. We adopt: the fence surface, in/out pairing,
per-vertex undo, selection-contextual enabling (the dossier's own
derivation guidance, realworks.md §5). We deviate: our fence set is
polygon/rectangle/lasso now with circle and magic wand queued (PC-D2);
our verbs include Extract and Classify in the same tool where RealWorks
splits these across Segmentation, classification layers, and Limit Box
Extraction (realworks.md §2.3, §2.4, §2.5) — one surface, four verbs,
because the fence interaction is identical and X5 pairs keep/delete.
RealWorks' sampled-working-cloud architecture (working clouds backed by
full-density raw scans, realworks.md §4 "Relevance") maps to our Potree
LOD streaming (ADR 0003): display density is automatic, so no manual
working-cloud sampling step is adopted. Perspective/Access document no
fence segmentation (trimble-perspective.md §2.5: selection is
object-tap-based; checked, nothing comparable). RIB Civil's Punktwolke app
digitizes and profiles clouds but documents no fence editing
(rib-civil.md §2.6; checked).

**A3 — Siblings.** Viewing box (clip volumes, extract pairing VB-D11 —
now un-queued onto `pointcloud.extract` by the reciprocal viewing-box record;
the bake machinery P2;
visible-set tools VB-D13/P4); viewport selection: the `select.box` /
`select.lasso` ribbon entries are unwired stubs with no handler or
overlay today (`ribbon.ts:107-109`, verified — no App.tsx case), so the
fence tool **builds** the shared fence-overlay module and the selection
tools adopt it later, not the reverse; measurement tools (consume edited
datasets). The overlay uses the shared selection tint tokens, no one-off
chrome (E1, §7).

**B1 — Reachability.** Ribbon Pointcloud → Segment toggle (present);
entity context menu "Segment" / "Classify to class…" / "Extract region…"
(present); viewport quick surface: absent — the tool needs a selected
cloud, and the quick surface is for empty-space actions
(`docs/DESIGN-SYSTEM.md` "Discoverability"); console + automation:
`pointcloud.segment.apply`, `pointcloud.classify.apply`,
`pointcloud.extract` with world-space fence arguments (present, X3);
keyboard: no global shortcut claimed — the dossier binds none for
segmentation (realworks.md §2.3 documents only in-tool fence keys); in-tool
keys X/S/L mirror RealWorks' Shift+X/S/C pattern (PC-D2). All paths
resolve to the same canonical commands.

**B2 — Open/close.** Ribbon button is a pure toggle (VB-D14 class rule);
panel close affordance present; Escape ladder: open **or
closed-unapplied** fence → discard it; otherwise → close tool. A closed,
unapplied fence also honors Ctrl+Z: it removes the closing edge and
resumes per-vertex undo (§2.1). Closing means cancel of the uncommitted
fence only — applied edits are already journaled. No keep-alive state.
The Classes island (§2.2) has its own symmetric lifecycle: ribbon toggle,
close affordance, and explicit registration as a detached function island:
when topmost it closes at UIP-D14 rung 6, not at the armed-tool rung.

**B3 — Surface.** Viewport takeover with right function panel: the user
must draw in the viewport while choosing verbs and target class —
DESIGN-SYSTEM "tool parameters stay docked". Nothing in §2.1–§2.3
outgrows it; the class table island (§2.2) is a separate small surface by
choice, shared with the properties panel.

**C1 — Numeric parity.** The fence is inherently graphical; its numeric
twin is the automation argument (a typed projection-true volume — prism
or frustum, PC-D5). Rectangle fences accept typed extents in the panel,
defined as **world units measured on the view plane, anchored at the
first-placed corner** (finding 11). Class codes are typeable. Extraction
names are typed. No displayed number is drag-only.

**C2 — Selection.** The target set binds at **fence close**: the panel
header names it ("Applies to: 3 clouds") and the verbs act on exactly
that set (multi-cloud fences apply per entity, one transaction, PC-D13).
Selection changes after fence close affect only the next fence — never a
bound one (§2.1; this supersedes any disable-on-change behavior). With no
fence open, selection changes retarget the tool normally; losing the last
cloud in the selection disables fence drawing with a status line. Ribbon
group disabled without a cloud selection (PC-D4).

**C3 — Freezability.** The compaction bake _is_ the freeze: after edits
settle, tiles rebake so the reduced cloud is resident reduced data (X2,
P2). No separate user-facing lock is needed — rejected as redundant with
the viewing-box lock, which stays the explicit spatial freeze (VB-D3).

**C4 — Persistence and undo.** Every apply (keep/delete/extract/classify)
is one canonical journaled command (PC-D1); fence-in-progress and vertex
edits are view-local (VB-D2 class rule). Undo restores points with all
attributes; extraction undo tombstones the new entity (§2.3). Defensible
to a Ctrl+Z user: a fence apply is "a step"; a vertex click is not, but
has its own in-tool Ctrl+Z while drawing (realworks.md §2.3).

**D1 — Performance budget.** Continuous: fence drawing and navigation
during the tool (gate **G-PC-A**), navigation after applies (gate
**G-PC-C**) — both named with scripts in PC-D14/§6. Bounded: mask
application on apply (< 1 s to visible effect, streamed-in nodes masked
on arrival too, gate **G-PC-B**). Long-running: compaction and extraction
bakes — registered with UIP-D10 so the status-bar chip, jobs island, real
progress, and cancel remain available even when the owning panel is closed;
nothing partial publishes (DESIGN-SYSTEM "Progress, cancellation").
Compaction queue depth ≤ 1 per entity with supersede-on-new-apply (PC-D1).

**D2 — Degradation.** During fence drags the existing interaction path
applies (`setInteracting`, preview caps, governor density). Degradation
order: overlay fidelity, then point density. Never degraded: committed
edit correctness, input responsiveness, journal integrity. On weak
hardware compaction takes longer in the background; the mask keeps the
view correct meanwhile (PC-D1).

**E1 — Visual quality.** §7 criteria 1–3.

**E2 — Conflicts, failure, consumers.** _Gesture map while the fence tool
is armed_ (contract gesture rule; reconciled against the ui-platform
viewport map — LMB sub-threshold click = select, LMB drag = orbit, RMB
pan, Up/Down arrow keys = pick-candidate cycling (Tab is reserved for the construction input bar — draw DR-D1, 2026-09-02), `ui-platform.md` §2.2):

| Gesture              | No open fence                                                                                         | Open fence                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| LMB click            | place polygon vertex (claims the ui-platform select gesture while armed — registry arbitration entry) | place vertex                                                                            |
| LMB press-drag       | draw lasso / rectangle (claims orbit while armed — registry entry)                                    | continue lasso/rectangle                                                                |
| MMB drag / wheel     | orbit / zoom (unclaimed, pass through)                                                                | rejected with status line (§2.1)                                                        |
| RMB drag             | pan (pass through)                                                                                    | rejected with status line                                                               |
| Enter / double-click | —                                                                                                     | close fence                                                                             |
| Ctrl+Z               | journal undo (last apply)                                                                             | vertex undo; on closed-unapplied fence: reopen                                          |
| Escape               | close tool                                                                                            | discard fence                                                                           |
| X / S / L            | fence type switch                                                                                     | fence type switch (discards open fence after confirm-free vertex count ≤ 1, else keeps) |
| Typing               | panel fields only                                                                                     | panel fields only                                                                       |

Tab is never claimed by the fence tool — it keeps its platform meaning (construction input bar, draw DR-D1); pick-candidate cycling is ↑/↓ (2026-09-02). The two LMB claims
are the only collisions; both exist exactly while the tool is armed and
are released on close — recorded for the registry's gesture map.

Consumers of the point dataset a segmentation edit revises:

| Consumer                                   | Effect of an apply                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Point render pass                          | new revision: mask immediately on every rendered node — streamed-in nodes are masked on arrival, not only resident ones; compacted tiles when baked                                                                                                                                   |
| Picking/snapping/cursor                    | per-node refinement runs against the edited revision; deleted or class-hidden points are never hit (P4)                                                                                                                                                                               |
| Selection tools, measurement               | operate on visible, live points; existing measurement graphics keep their anchor coordinates                                                                                                                                                                                          |
| Active viewing box / clip volumes          | scope the apply itself (P4): effective set = fence volume ∩ active clip ∩ visible classes; natural occlusion never scopes (PC-D16)                                                                                                                                                    |
| Class visibility state                     | scopes the apply (P4) and is itself journaled canonical state (PC-D6)                                                                                                                                                                                                                 |
| Viewing-box lock bake                      | keyed on source-dataset revision → auto-rebake on **settled** revisions, debounced across an apply burst — one rebake after coalesced compaction, not one per apply (noted against VB-D3, whose spec owns the bake)                                                                   |
| Exporters / deliverables                   | read canonical post-edit state; never the mask-less original; class-hidden points are included, dialog says so (§2.2)                                                                                                                                                                 |
| Entity tree / properties                   | point count and dataset size update on compaction                                                                                                                                                                                                                                     |
| Scan-station relations                     | station links (`e57_import.rs` station associations) survive edits; extraction records a source relation and does **not** claim station membership (PC-D7); merge keeps the union of its sources' station links — whole clouds retain their identity, unlike a spatial extract (§3.2) |
| Automation / journal                       | commands visible in `journal.read`; renders arrive post-edit                                                                                                                                                                                                                          |
| Sibling viewers (WeltView, plan viewports) | same canonical prepared datasets                                                                                                                                                                                                                                                      |
| Prepared-tile cache                        | old revisions retained for undo, GC-eligible when unreferenced (tunable retention, X6)                                                                                                                                                                                                |

_Extreme class members_ (contract rule): largest — a fence apply bound to
every cloud of a 23-cloud project runs as one transaction (PC-D13) with
per-entity masks and one coalesced compaction each; least typical — a
bound cloud whose effective P4 scope contains zero points: the apply
fails before journaling with an explaining status ("No visible points in
the fence for 'Cloud 7'") rather than journaling a no-op (finding 15),
and a remove-inside viewing box active during a fence apply scopes the
apply to the _kept_ outside region — the box operation, not the box
volume, defines visibility.

Concurrency: applies serialize through the journal; an automation apply
arriving while a fence is open does not disturb the fence (the fence is
view-local); repeated applies coalesce compaction — queue depth ≤ 1 per
entity, newest revision wins, superseded jobs dropped (PC-D1). Undo
arriving mid-compaction cancels or supersedes the in-flight job; nothing
partial publishes (§6 test). Failure mid-bake: mask state stays published
and correct, bake retries or is cancelled; crash: journal replays
commands, bakes are derived data rebuilt on open (same class as VB-D3's
cache rule).

**E3 — Verification.** §6.

### 3.2 Sampling and merge (contract level)

**A1.** Sample: the user picks a cloud, chooses method — spatial step,
random percentage, or intensity range — sees the estimated output count,
and gets a new, named, fully baked cloud entity; the source is untouched.
Merge: the user multi-selects clouds, confirms name and attribute notes,
and gets one new merged entity; sources remain until deleted deliberately.
**A2.** RealWorks samples by spatial step, intensity, and scanner range
(realworks.md §2.1) and splits per scan (§2.1); it merges cloud objects
with an **explicit user command on Ctrl+M** (realworks.md §2.3 [22] —
dossier extended first per doctrine rule 2; the earlier
"merges implicitly in registration groups" claim was invented over a
dossier gap and is withdrawn). We adopt: spatial and intensity sampling;
the explicit merge command, with Ctrl+M recommended to `REGISTRY.md`
(X4). We add random-percentage sampling (stated addition: cheapest
defensible decimation, no reference conflict); scanner-range and
scan-based variants are queued (PC-D15). We deviate twice with reasons:
our merge **keeps the source clouds** (X1 — RealWorks' in-place merge
destroys the parts; a keep-sources create loses nothing and undo stays
trivial), and we skip import-time working-cloud sampling because Potree
LOD already governs display density (ADR 0003) — sampling exists for
deliverable and processing control, not navigation (PC-D8). **A3.**
Extraction (same new-entity pipeline), import (E57 already merges scans
at import, `e57_import.rs:73`). **B1.** Ribbon Cloud group; context menu;
`pointcloud.sample` / `pointcloud.merge`; Ctrl+M recommended to the
registry for merge (realworks.md §2.3 [22]); no sample shortcut. **B2.** Panel/dialog
close = cancel; running jobs remain available through the UIP-D10 status-bar
chip and jobs island and cancel there per DESIGN-SYSTEM. **B3.** Sample:
right panel (method parameters while viewing the cloud); merge: small
dialog (no viewport interaction needed). **C1.** Step, percentage, range,
and estimated counts are typed fields. **C2.** Sample: single cloud;
merge: the multi-selection captured at launch. **C3.** Output is baked by
construction (X2). **C4.** Both are journaled creates; undo tombstones
the product. **D1.** Long-running work registers with UIP-D10, with real
progress and per-job cancel; estimation is bounded. **D2.** Background
jobs; interaction never blocked. **E1.** §7
criterion 5 (standard panel/dialog patterns only). **E2.** New-entity
consumers identical to extraction (§3.1 table); merge attribute policy:
the union of attributes, absent values null per schema, downgrades named
in the dialog before start; no silent loss (X1). Station links: merge
keeps the **union** of its sources' station links — whole clouds retain
their scan identity, unlike a spatial extract, which records provenance
only (PC-D7). Failure honesty: sample or extract over an empty effective
set (zero points after P4 scoping, or a zero-point cloud — the least
typical class member) fails before journaling with an explanation, never
a silent empty entity. **E3.** §6.

### 3.3 Ortho-image generation (contract level; Raster boundary)

**A1.** The user defines a projection plane (fitted plane, current view
plane, or typed plane), extents, resolution, and depth range, chooses the
color source (defaulting to the entity's display color source), generates,
and receives a georeferenced raster entity. **A2.** RealWorks
Ortho-Projection / Multi Ortho (realworks.md §2.8, W6): plane definition,
extents/resolution/depth, in-tool segmentation, split guidance for huge
outputs. We adopt plane/extents/resolution/depth and the W6 flow; in-tool
segmentation is unnecessary — our segmentation tool and viewing box
already scope the source (stated deviation); split guidance becomes an
output-size warning (tunable threshold, X6). **A3.** Raster entities
(ADR 0020), plan composer (D4) as the main consumer of the image. **B1.**
Ribbon Image group; `pointcloud.ortho_image.generate`; context menu on a
cloud; no shortcut. **B2/B3.** Dedicated tool window (spatially dense:
plane placement, extent handles, preview) with explicit close = cancel.
**C1.** Plane origin/normal, extents, resolution, depth are typed with
drag twins on the preview rectangle. **C2.** Selected cloud(s) at launch.
**C3.** Generation is a bake by definition. **C4.** Generation is a
journaled create of the raster entity; parameters are stored on it for
regeneration. **D1.** Long-running generation registers with UIP-D10; its
status-bar chip and jobs-island row expose real progress and cancel. Preview
rectangle manipulation is continuous and rides the existing overlay path. **D2.**
Preview density degrades first. **E1.** §7 criterion 5. **E2.** **Domain
boundaries, two of them:** (a) this spec owns the generation tool and its
parameters; the produced entity is a raster entity whose display,
editing, tiling, and export belong to the **Raster domain spec** — the
registry must link the two so neither spec double-owns the entity.
(b) PhotoLab's camera-based orthomosaic is a different product: ADR 0011
explicitly rejects dense-cloud RGB as an orthomosaic backend; this tool
is the RealWorks-style cloud projection (realworks.md §2.8) and never
claims photogrammetric orthomosaic quality. Failure/cancel publishes no
partial raster. **E3.** §6.

### 3.4 Inspection functions (catalog level)

Surface-to-model, Twin Surface/cloud-to-cloud, floor flatness, and wall
verticality are cataloged (§1) with
RealWorks as reference (realworks.md §2.7, W8, W9) and deliberately not
specified to workflow depth here — the deferral is reasoned in PC-D10,
not open: Mesh/Terrain now satisfies the aligned-model dependency (MT-D1–MT-D6)
and registers the Pointcloud breakline-finding → Draw curve → Mesh breakline
handoff (MT-D14); workflow promotion still depends on report/deliverable
infrastructure and classification (floor
flatness consumes class = floor, realworks.md W9 step 1). Contract answers
and workflow narratives land in a follow-up revision of this spec once
the Mesh domain spec exists; until then the registry rows carry status
"cataloged, deferred". Twin-surface inspection and wall verticality join
the same deferred group; volume calculation and tank workflows are
dispositioned per row in §1.1. Until the follow-up spec lands, the
**Analyze ribbon group does not appear at all** — no permanently disabled
placeholder buttons (finding 15; DESIGN-SYSTEM discoverability is for
existing capabilities — a button that can never enable is dead chrome).

### 3.5 Display properties and point size

**A1.** §2.4 in full. **A2.** Perspective/Access display modes
(trimble-perspective.md §2.2 [S2][S3][S8]): per-station/per-scan color,
intensity gray or color-coded, true color, elevation with typed min/max,
uniform color, point size. The reference posture is **view-level**: these
are "rendering options (shared between Map View and 3D View)" and Access
"Map settings" — settings of the viewer, not properties of a cloud
(trimble-perspective.md §2.2, read as written). We adopt the mode
_catalog_; making the modes **per-entity canonical state** is our stated
deviation, derived from X3/P1 (a display setup is deliberate, restorable,
automation-visible state in a multi-cloud CAD project, not a viewer knob)
— and VD-D8 binds that unchanged canonical layer beneath an un-journaled
view-level override. §2.4's tree Ctrl+A + Mixed edit preserves canonical
scene-wide recolor as one journaled command, while the View-tab override
preserves temporary one-decision-recolors-everything ergonomics without
mutating entity styles. Per-scan coloring
maps to our Scan source mode (`PointSourceId` — per-point source id ≈ one
color per scan); per-registration-set coloring is queued (needs
registration domain). We add Classification and Return number (RealWorks
classification display via layered classes, realworks.md §2.4/W5; LAS
attributes our renderer already maps, `render_world.rs:61-71`) —
additions, no reference conflict. Color-coded intensity (beyond
grayscale) is queued (tunable ramp on the same attribute). **A3.** Mesh/CAD entity display properties (same
properties-panel grammar); viewing box (unaffected by display changes);
specifications/styles system (the style store `SetStyleRef` is shared).
**B1.** Properties panel group (present); context "Display properties"
(present); console/automation `pointcloud.set_display` plus the generic
property commands (present), including entity-targeted opacity and vertical
exaggeration migrated from `view.opacity` / `view.exaggeration`; ribbon: the
View-tab point-size control stays as the × multiplier, while
`view.color-mode` becomes VD-D8's working un-journaled view-level override
dropdown, default **Follow entity display**. It sits above the properties
path and never issues a canonical entity edit; no shortcut. **B2.** The properties panel is permanent
chrome; not applicable beyond field commit/revert semantics
(DESIGN-SYSTEM "Input consistency"). **B3.** Right properties panel —
selection-driven property editing, the shell's designated surface.
**C1.** Every value typed: gradient min/max, uniform color, point size px
(Auto = adaptive renderer choice, reset affordance beside the field,
§2.4), opacity, and vertical exaggeration; the view multiplier is a typed
unitless factor, default 1.0;
pickers are accelerators. **C2.** Multi-select per §2.4: common
properties, Mixed placeholder, commit-to-all
(`property_schema.rs:236-299`, revit.md §3 W3). **C3.** Not applicable —
restyles are cheap attribute remaps (`render_world.rs:45`); there is
nothing to freeze. **C4.** Per-entity display edits, including opacity and
vertical exaggeration, are journaled canonical style updates (X3, P1:
deliberately created, wanted back). VD-D8's color-mode override and the
global point-size scale are view-local and un-journaled; the override is
project-persisted presentation and the multiplier is workstation comfort
(PC-D11/VD-D8). **D1.**
Recolor, opacity, exaggeration, and size changes are bounded (< 1 s, no indicator when
imperceptible; no reload — attribute remap only). Gradient live preview
while dragging a ramp stop is continuous and rides the existing style
update path; gate in §6. **D2.** Governor may defer restyle of unstreamed
nodes; streamed-in nodes always arrive restyled. **E1.** §7 criterion 4.
**E2.** Consumers of per-entity display state: point render pass
(restyle); screenshots and automation renders (must reflect it — agents
judge clouds by classification colors); plan-composer viewports (D4)
render per-entity display; ortho-image tool (reads it as default color
source, §3.3); exporters (display never alters exported point data — an
export is data, not styling; deliberate, logged in the export dialog);
picking (unaffected, except class-visibility hiding which scopes per P4);
class visibility itself (journaled canonical state, PC-D6 — its own
consumer row in the §3.1 table); properties panel of sibling selections
(Mixed aggregation); automation renders (render at multiplier × 1.0
unless their view state sets one, §2.4). _Extreme class members_: largest
— tree Ctrl+A over every cloud followed by one Mixed edit is one journaled
command (PC-D13), while the ribbon override remains a separate un-journaled
VD-D8 layer; least typical — a cloud lacking the selected
attribute entirely (no classification, no intensity) renders the
specified Source fallback (§2.4, `mixed.wgsl:290-294` gap named there),
and a zero-point cloud accepts style edits like any entity (styles are
not geometry-scoped). Concurrent automation restyle while the panel is
open updates fields live (same canonical state). Crash: styles replay
from the journal. **E3.** §6.

## 4. Decision records

**PC-D1 — Segmentation edits are canonical mask-delta commands with
coalesced background compaction** (revised per review finding 7).
**Decision:** each fence apply journals one canonical command carrying
(entity ids, projection-true fence volume per PC-D5, side, verb, class
code if classifying, effective P4 scope per PC-D16); the immediate effect
is a point mask that is part of the revision's render state — applied to
every rendered node, including nodes streamed in later; a background,
cancellable compaction rebakes Potree tiles into the revision's prepared
dataset. That bake registers with the main-process job registry (UIP-D10),
which supplies the status-bar chip, jobs-island progress/cancel surface,
renderer-reload rehydration, and console record. Compaction coalesces: at
most one queued job per entity, always
retargeted to the newest revision, superseded jobs dropped — fifteen
applies in ten minutes cost one bake. Undo arriving mid-compaction
cancels or supersedes the in-flight job; nothing partial ever publishes.
Locked viewing boxes rebake once per settled revision, debounced across
an apply burst (noted against VB-D3, which owns the bake). Prior
revisions stay GC-eligible for undo. **Derivation:** C4 + X3 (deliberate edits are
canonical/journaled); prepared datasets are immutable and
content-addressed (`las_import.rs:28-29,553`; ADR 0003), so an edit is
necessarily a new revision, never a mutation; X2 + P2 (spend preprocessing
so the reduced cloud performs natively small); X1 (undo must restore
attributes exactly).
**Rejected:** view-local hiding (automation-invisible "deletion", X3
violation); synchronous tile rewrite on apply (blocks interaction on
billion-point clouds — the exact RealWorks complaint class,
realworks.md §4 [19]). **Tunable:** revision retention before GC;
compaction scheduling (X6).

**PC-D2 — Fence set: polygon, rectangle, lasso; circle and magic wand
queued.** **Decision:** ship polygon (X), rectangle (S), lasso (L) with
per-vertex undo; circle and region-grow queued (PC-D15). In-tool
single-letter keys, no Shift chord. **Derivation:** X4 — RealWorks fences
are polygon/rectangle/circle/magic-wand on Shift+X/S/C/W
(realworks.md §2.3); lasso replaces circle as the freehand workhorse and
matches our existing `select.lasso` sibling (`ribbon.ts:108`); plain keys
because the tool owns the keyboard while active (stated deviation from the
Shift chords). **Rejected:** all five at once (delays the core; region
grow is an algorithm project, not a fence). **Tunable:** key assignment
(registry owns collisions, VB-D9 class rule).

**PC-D3 — Verbs × sides: keep/delete/extract/classify, inside/outside.**
**Decision:** one fence surface offers four verbs, each applicable to
either side of the fence. **Derivation:** X5 (keep/remove pair; shipping
one side is a defect); realworks.md §2.3 (in/out keep is the reference
segmentation behavior); consolidating Extract and Classify into the same
surface follows from identical interaction needs (§3.1 A2). **Rejected:**
separate tools per verb (three ribbon buttons, one interaction —
RealWorks' own split is a silo artifact, realworks.md §2.3/§2.4/§2.5).
**Tunable:** no.

**PC-D4 — Selection-contextual enabling.** **Decision:** the Segment,
Classify, and Cloud ribbon groups enable only with at least one
point-cloud entity selected. **Derivation:** realworks.md §5 derivation
guidance (Production-only gating maps to selection-contextual enabling);
DESIGN-SYSTEM (disabled with explanation over rejection after launch).
**Rejected:** always-enabled with a launch error (later, noisier).
**Tunable:** no.

**PC-D5 — Fences journal as projection-true world-space volumes**
(revised per review finding 2 — blocker). **Decision:** the canonical
command stores the volume that matches what the user saw: in an
orthographic view, the fence polygon extruded along the view direction (a
prism); in a perspective view, the polygonal **frustum** — apex at the
eye position, expanded through the fence polygon (equivalently, its
bounding plane set) — both fully world-space and camera-free once
computed. Tint membership and apply membership are the same predicate by
construction. **Derivation:** X1 — the review showed a naive prism
disagrees with the drawn shape under perspective at depth: the user
tints one set and deletes another, a correctness defect; X3 (replay and
automation without a camera); ADR 0019 (journal entries
self-contained). **Rejected:** prism-always (the finding-2 blocker);
storing screen polygon + camera (couples the journal to view state;
breaks headless replay). **Tunable:** no.

**PC-D6 — Classification is a per-point attribute plus a canonical class
table.** **Decision:** class codes live per point in the tiled dataset
(LAS-compatible 0–255, already in the Potree attribute schema, ADR 0003);
the project carries one canonical classification table (code, name,
palette color, visibility) seeded from the built-in LAS/civil palette;
class visibility hides points from rendering _and_ from
picking/snapping/selection/measurement/destructive applies (P4), and a
visibility toggle is itself a **journaled canonical command** (revised
per review finding 8): state that scopes geometry actions must be
restorable, undoable, and automation-visible — the journaled viewing-box
activation is the class precedent. Exports include class-hidden points
(an export is data, not styling) and the export dialog states it when
classes are hidden. **Derivation:** X4 — RealWorks
classes land in layers with per-class display control downstream
(realworks.md §2.4, W5); ADR 0003 planned a classification-label sidecar
mapping that was never built — the shipped dataset manifest
(`hcad.dataset.json`, `las_import.rs:82`) carries none, so the canonical
class table supplies it, fixing the gap at the source (doctrine rule 2);
`render_world.rs:61-67` plus the built-in 19-entry LAS palette
(`gpu_frame.rs:45-65`) implement palette-indexed display; P4 (which
generalized VB-D13) extends to class-hidden points
(X1: snapping to an invisible point writes wrong survey numbers).
**Rejected:** classes as separate child entities per class (explodes the
entity tree, breaks per-point multi-class-free format compatibility);
display-only hiding with pickable hidden points (P4 violation).
**Tunable:** default palette colors (X6).

**PC-D7 — Extraction copies; it never mutates the source.** **Decision:**
`pointcloud.extract` creates a new fully baked entity carrying all point
attributes and a source relation; the source is unchanged; source removal
is a separate Delete apply. Station-membership relations are not copied —
the extract records provenance, not station identity. **Derivation:** P2
(extracted cloud performs like natively small data — verbatim); X2 (bake
on create); X5 (extract/delete compose to "split" without a third
command); `e57_import.rs` station associations are scan-level facts that
a spatial subset does not inherit (X1, no false metadata). **Rejected:**
move-semantics extract (one command mutating two entities — surprising
undo, and RealWorks' Limit Box Extraction also produces a new cloud,
realworks.md §2.5 [8]). **Tunable:** no.

**PC-D8 — Sampling produces a new entity; no in-place resample.**
**Decision:** sampling (spatial step, random percentage, intensity range)
always creates a new cloud entity; the source persists. **Derivation:**
X1 (destroying source density is unrecoverable data loss); X2 (a second
baked dataset is the memory-for-integrity trade the doctrine pre-approves);
A2 §3.2 (RealWorks' import-time sampling exists because its working clouds
are resident; ADR 0003 streaming removes that need — deviation reasoned).
**Rejected:** in-place decimation with undo (undo would need the original
anyway — same storage, worse semantics). **Tunable:** default step /
percentage presets (X6).

**PC-D9 — Ortho-image: tool in Pointcloud, product owned by Raster.**
**Decision:** the generation tool, its parameters, and the journaled
create live in this domain; the produced georeferenced raster entity is
governed by the Raster domain spec (ADR 0020 tiles, display, export). The
registry links both rows. **Derivation:** X4 — RealWorks hosts
Ortho-Projection in Imaging but drives it from cloud data
(realworks.md §2.8, §5 maps image outputs to the Raster tab); D2 taxonomy
is data-domain based: the _input_ interaction is cloud-domain, the
_artifact_ is raster-domain. **Rejected:** whole feature in Raster (the
user stands in a cloud when they need a facade image; discoverability);
duplicated ownership (conflicting specs). **Tunable:** output-size warning
threshold (X6).

**PC-D10 — Inspection depth deferred with reason.** **Decision:**
surface-to-model, Twin Surface/cloud-to-cloud, floor-flatness, and wall-
verticality inspection stay catalog-level entries in this spec revision;
there is no standalone density row. Mesh/Terrain MT-D1–MT-D6 satisfies the
aligned-model dependency and MT-D14 registers breakline-finding output as
Draw curves consumed by Mesh; workflow specification now follows the remaining
report/classification prerequisites. **Derivation:**
program README resolution levels (workflow level is for the
implementation horizon); dependency order: surface-to-model needs aligned
models (realworks.md W8 step 1 — Mesh domain), flatness needs
classification (W9 step 1 — shipped by this spec first);
`docs/CURRENT-DIRECTION.md` completion discipline (a shallow spec now
would fake completeness). **Rejected:** inventing workflow/report contracts
before their remaining owners publish them; adding an unevidenced density act
from a low-density error condition (evidence-precedes-specification, A2).
**Tunable:** no.

**PC-D11 — Display properties are per-entity canonical style beneath VD-D8
view presentation.** **Decision:** color source, mode parameters, palette
ref, opacity, vertical exaggeration, and per-entity point size are canonical
journaled style state behind `SetStyleRef`, carried by a **new
point-cloud display-style canonical resource kind** (today's style
resources cover material/texture/hatch/line-type/annotation only,
`canonical_resources.rs:32-42`, and every import sets `style_ref: None`);
`pointcloud.set_display` owns those entity-targeted fields, and today's
group-scoped `view.opacity` / `view.exaggeration` console commands migrate
to that canonical command rather than remaining View-domain presentation.
Per-entity point size defaults to **Auto** (renderer-adaptive) with a
typed px override and a reset-to-Auto affordance; the View-tab control
becomes a view-local **unitless × multiplier**, default 1.0 (existing
`App.tsx:73` state, relabeled and re-ranged); effective size = per-entity
size × view multiplier, which requires adding a point-size field to
`RenderStyle` (none exists, `render_world.rs:228-245`); automation
renders use × 1.0 unless their view state sets one. Per VD-D8, the unwired
`view.color-mode` ribbon button becomes a working **un-journaled view-level
override** dropdown, default **Follow entity display**. It renders above
the canonical entity styles without mutating them; tree Ctrl+A followed by
one Mixed Color source edit remains the one-command canonical scene-wide
recolor path (PC-D12/PC-D13), and the ribbon override is not its accelerator.
**Derivation:**
X3/P1 (a display setup the user built is deliberate state, restorable,
automation-visible — agents read classification renders); the reference
posture is **view-level** display settings
(trimble-perspective.md §2.2 — rendering options of the views, not cloud
properties), so per-entity canonical state is a stated X3/P1 deviation,
with VD-D8's upper override preserving the reference ergonomics without
altering the lower canonical layer;
X3's view-local exception clause for the multiplier (per-workstation
comfort, like theme — carries no project meaning). **Rejected:** all
display state view-local (the reference posture — breaks X3/P1: reload
loses the setup, automation renders diverge from the user's screen);
journaling the global multiplier (journal spam for a comfort knob, VB-D2
class); using the View color control as a journaled scene-wide accelerator
(VD-D8: a temporary view look would mutate entity state and could not be
bookmark-owned independently). **Tunable:** multiplier clamp range; Auto sizing
policy (X6).

**PC-D12 — Multi-select property contract adopted from Revit.**
**Decision:** intersection of common properties; Mixed placeholder that
commits to all on overwrite; header with type and count; one journaled
multi-entity edit; render-time fallback (with panel note) where a mode
lacks data instead of blocking. **Derivation:** X4 — revit.md §3 W3 is
the documented reference contract, and revit.md §5 recommends adopting it
verbatim; `property_schema.rs:236-299` already implements the aggregate
model, so the decision also minimizes new machinery. **Rejected:**
per-entity sequential edits (N undo steps for one intent); blocking
mixed-capability edits (punishes the common case). **Tunable:** no.

**PC-D13 — Verbs apply per entity in one transaction.** **Decision:** a
fence apply over a multi-cloud selection produces one journal entry with
per-entity mutations (atomic all-or-none per
`CanonicalCommandTransaction`, `canonical_document.rs:214`). **Decision
scope:** class-shaped — any multi-entity Pointcloud command follows it.
**Derivation:** C2 (defined multi-select behavior); X1 (partial
application across entities is corruption); the transaction type already
guarantees atomicity. **Rejected:** one command per entity (undo tears
one gesture into N steps). **Tunable:** no.

**PC-D14 — Named perf gates with scripts and baseline recipes** (revised
per review finding 9). **Decision:** five gates, each with a stable id
and an agent-runnable script:
**G-PC-A** `bench-pointcloud-fence.mjs` — scripted polygon/lasso drawing
plus orbit over a large cloud, p95 frame interval ≤ 2× target frame time
(VB-D7 calibration class).
**G-PC-B** `bench-pointcloud-apply.mjs` — apply-to-visible-mask latency
< 1 s at the gate scene's scale, asserting streamed-in nodes arrive
masked.
**G-PC-C** `bench-pointcloud-edit-parity.mjs` — post-edit parity: delete
≥ 50% via scripted fences, wait for compaction, orbit; baseline recipe:
the same source LAS is **cropped offline to the surviving region and
imported natively**, and the identical scripted orbit runs against both;
edited p95 ≤ 1.1× baseline (P2, VB-D8 calibration class).
**G-PC-D** `bench-pointcloud-extract-parity.mjs` — same recipe for an
extracted entity vs the native import of the same crop; ≤ 1.1× (P2
verbatim).
**G-PC-E** `bench-pointcloud-restyle.mjs` — color-source switch < 1 s on
streamed nodes.
**Derivation:** D1 (a continuous interaction without a runnable, _named_
gate is not specifiable as smooth); P3/X6 (numbers delegated, recorded
tunable); P2 (parity gates); the offline-crop recipe makes the baseline
reproducible without hand-built fixtures. **Rejected:** thresholds
without script names (finding 9 — unimplementable as CI gates);
subjective "smooth" claims (contract D1). **Tunable:** yes — every
threshold; script names stable once registered.

**PC-D15 — Queued backlog.** **Decision:** one queue behind this spec:
auto-segment moving objects / steel beams / reflections and noise
reduction (realworks.md §2.3); auto-classify indoor/outdoor
(realworks.md §2.4), except the Ground and Floor slices promoted by
PC-D19/PC-D20; circle + magic-wand fences (§2.3); scan-based and
scanner-range sampling (§2.1); push-deletion-to-raw-source (§2.3);
per-registration-set coloring and color-coded intensity
(trimble-perspective.md §2.2); densifying re-extraction
(realworks.md §2.5 [8], shared queue item with VB-D11).
**Derivation:** `docs/CURRENT-DIRECTION.md` completion discipline (finish
the six-verb manual core first); every queued item keeps its dossier
citation so later specs inherit the evidence. **Rejected:** bundling now.
**Tunable:** no.

**PC-D16 — Applies act on the visible set** (new per review finding 1 —
blocker; derives from doctrine precedent **P4**). **Decision:** the
effective set of every fence apply is _fence volume ∩ active clip volumes
(viewing box / clip planes) ∩ visible classes and entities_; natural
occlusion never scopes (the fence cuts through depth — P4's explicit
carve-out). The journaled command captures the effective scope as
world-space and attribute arguments (clip volume geometry + operation,
hidden-class set), so replay is camera-free and history-stable: a later
box or visibility change never alters what an old journal entry did. A
remove-inside box scopes to its kept region — the box _operation_
defines visibility, not the box volume. The panel names the active scope
("Scoped to: Stairwell B", jump to the box panel — finding 16).
**Derivation:** P4 verbatim ("anything that acts on geometry acts on the
visible set … destructive applies alike"); X1 (silently deleting points
in a clipped-away storey is data destruction the user never saw); ADR
0019 (self-contained journal entries force scope capture at apply time).
**Rejected:** fence-volume-only applies (the finding-1 blocker: the
prism punches through the viewing box); occlusion-scoped applies
(explicitly excluded by P4; would make applies camera-dependent and
unreplayable). **Tunable:** no.

## 5. Current implementation delta

**Exists and stays:** the canonical entity/command/journal machinery
(`canonical_document.rs` transactions, typed edits incl. `SetStyleRef`,
`SetRepresentations`; tombstone/restore undo); `hcad.point-cloud@1` type
and `PointCloud { dataset: StreamedGeometry }` representation
(`entity_model.rs:40,1097`); the Potree import pipeline and immutable
content-addressed prepared-data layout (ADR 0003 format half; its
three-loader renderer half is superseded by the live Rust/wgpu streaming
path, `crates/himmelcad-render/src/providers/potree.rs`); renderer color
modes, palettes, per-upload point size,
frame size scale (`render_world.rs:52-84`, `gpu_frame.rs:896`,
`gpu_surface.rs:53`); property aggregation with Mixed + multi-entity edit
(`property_schema.rs:236-299`) and the panel's Mixed placeholder
(`App.tsx:1019`); global point-size console/ribbon control
(`App.tsx:602-606`); automation schema generation from the canonical
contract (`schemas/automation/himmelcad-automation-v1.schema.json`).

**Changes:** ribbon remap per D2 — `segment`/`select`/`inspect` workflow
tabs dissolve into the Pointcloud tab and contextual surfaces; the
unwired `segment.extract/classify/invert` buttons (`ribbon.ts:114-127`)
are replaced by the fence tool's verbs; `view.color-mode` becomes VD-D8's
working view-level override dropdown with **Follow entity display** as its
default, rather than being removed or issuing journaled entity edits;
`view.point-size` becomes the documented view-local
multiplier over per-entity sizes; `POINT_CLOUD_STYLE` hardcoding
(`BuilderKernelViewport.tsx:59-73`) is replaced by style resolution from
the entity's canonical style; group-scoped `view.opacity` and
`view.exaggeration` migrate to entity-targeted `pointcloud.set_display`
canonical commands (PC-D11/VD-D8).

**New:** the fence surface (overlay, verbs, panel) and
`pointcloud.segment.apply` / `classify.apply` / `extract` commands with
mask + compaction pipeline (PC-D1) — including viewport point picking for
fences, which does not exist today (Builder selection comes only from the
entity tree, `App.tsx:519-520`; no viewport pick handler); classification
table island and canonical class/palette resource (PC-D6), plus a
`hasClassification` import attribute beside `hasIntensity`
(`las_import.rs:1044-1059`); class-visibility-aware and edit-aware
picking (P4); `pointcloud.sample`, `merge`,
`ortho_image.generate` with progress/cancel; the point-cloud
display-style resource kind (including opacity and vertical exaggeration)
and a `RenderStyle` point-size field
(PC-D11); an absent-classification fallback branch in the point shader
(`shaders/mixed.wgsl:290-294` has none today — packed default 0 would
paint unclassified clouds class-0, §2.4); per-entity display group in the properties panel wired to
journaled style commands; the named automation surface `pointcloud.*` —
today's wire format carries only opaque `command_id`s and the automation
schema contains no point-cloud method (checked; the dead
`ExtractPointCloudSegment`/`CreateSelectionMask` strings in
`packages/@himmelcad/data/src/index.ts:1283-1293` are unimplemented
vocabulary and are retired by this spec); `view.state.get` display
reporting; UIP-D10 registration for compaction, extraction, sampling, merge,
and ortho-image jobs; the five gates of PC-D14.

## 6. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** Rust core tests — fence-volume command round-trip with the
  **perspective membership test**: tint membership == apply membership for
  a frustum fence at multiple depths (PC-D5, finding 2); P4 scope capture
  round-trip — clip volume, operation, and hidden-class set stored on the
  command, replay identical after later box/visibility changes (PC-D16);
  mask-delta application and attribute-exact undo (PC-D1); compaction
  coalescing — N rapid applies yield queue depth ≤ 1 targeting the newest
  revision (PC-D1); undo mid-compaction cancels/supersedes with nothing
  partial published (finding 7c); multi-entity transaction atomicity
  incl. the zero-visible-points failure before journaling (PC-D13,
  finding 15); class-table resource round-trip, empty-palette default,
  and journaled visibility toggle undo (PC-D6); sampling estimators;
  style edit round-trip via `SetStyleRef`, including opacity and vertical
  exaggeration; Mixed aggregation over display
  properties (`property_schema.rs` tests extended).
- **changed:** panel/component tests — target binding at fence close
  ("Applies to: N" stable under selection change, finding 6), Escape
  ladder (open-fence, closed-unapplied-fence, tool rungs) and Ctrl+Z
  reopening a closed fence (finding 12), typed rectangle extents (world
  units on the view plane, finding 11), scope line with box-panel jump
  (finding 16), class picker, Classes-island open/close symmetry
  plus UIP-D14 rung-6 ordering after an inner field/menu rung (finding 8,
  registry F12), display group field commit/revert per DESIGN-SYSTEM input
  rules, Auto-size reset affordance (finding 10), Mixed placeholder
  commit-to-all; tree Ctrl+A + one Mixed color edit issues one canonical
  multi-entity command; the View override defaults to Follow entity display,
  writes no entity style or journal entry, and reveals those canonical styles
  again when reset (VD-D8; finding 5, registry F1).
- **push (risk-triggered by viewer/viewport/kernel paths):** browser
  interaction tests — fence gesture map: LMB draws while armed, MMB/RMB/
  wheel navigate with no open fence and are rejected with an open one
  (finding 4); fence drawing with per-vertex undo; apply produces the
  mask without a full reload and newly streamed nodes arrive masked
  (finding 7a); a pick inside a deleted or class-hidden region returns no
  phantom point (P4); properties-panel restyle reflected in the frame;
  classification mode on a cloud without classification renders Source
  fallback, not class-0 color (finding 13); opacity/exaggeration property
  edits survive reload and undo; ribbon toggle symmetry. Starting compaction
  or another Pointcloud bake creates a UIP-D10 job whose chip/island progress
  and cancel survive renderer reload; cancel publishes no partial result
  (registry F7).
- **push (risk-triggered) / release (always), capability `browser-gpu`:**
  gates **G-PC-A**, **G-PC-B**, **G-PC-E** (PC-D14) — self-launching,
  agent-runnable scripts.
- **release, capabilities `browser-gpu` + `real-data`:** gates **G-PC-C**
  and **G-PC-D** on a real large cloud, baselines built by the
  offline-crop recipe (PC-D14); the P4 scope test on real data — a delete
  apply with a keep-inside box active touches **zero** points outside the
  box (finding 1); compaction and extraction cancel leave no partial
  canonical state; viewing-box lock auto-rebake fires once per settled
  revision across an apply burst (debounce, finding 7d; cross-spec with
  VB-D3).
- **automation:** SDK parity — every `pointcloud.*` command callable;
  scripted end-to-end: fence-classify a region, switch display to
  classification, screenshot reflects palette colors at multiplier ×1.0;
  set per-entity opacity and vertical exaggeration through
  `pointcloud.set_display`; apply and clear the VD-D8 view override without a
  journal entry or canonical-style mutation;
  "extract the active viewing box" two-call script; journal lists the
  applies including class-visibility toggles.
- **manual/visual:** screenshots (both themes; fence idle/drawing/closed;
  scope line; classification palette; Mixed multi-select panel) compared
  against §7.

Explicitly unverified: subjective fence-drawing feel beyond G-PC-A;
compaction progress accuracy on exotic datasets; sampling estimate
accuracy (calibration, X6) — accepted as manual-review-only.

## 7. Visual quality criteria (E1 reference artifact)

Failable criteria; implementation review compares actual screenshots
against them. Design tokens only; no one-off chrome.

1. **Fence legibility:** the open fence renders vertices and edges with
   the shared selection accent; the fenced side carries the shared
   selection tint at a fill opacity that leaves point colors identifiable
   beneath (fail: opaque fill, novel color, or no side indication).
2. **Verb clarity and scope honesty:** after fence close, the panel's
   verb buttons name verb and side ("Delete inside"), the header names
   the bound target ("Applies to: 3 clouds"), and an active clip or
   hidden class shows the scope line ("Scoped to: Stairwell B") — never a
   bare icon row (fail: generic "Apply", missing target count, or a
   silent scope; DESIGN-SYSTEM UI copy).
3. **Grip/vertex stability:** during fence editing no committed vertex
   moves except the one under the pointer — the RealWorks v12.4
   "jumping grips" regression class (realworks.md §4 [18]); asserted from
   G-PC-A state samples.
4. **Palette rendering:** classification colors match the class table
   exactly (sampled pixels vs palette entries); hidden classes leave no
   ghost points at any zoom (fail: LOD levels showing hidden classes).
5. **Standard surfaces:** sample panel, merge dialog, ortho tool window,
   and the Classes island are assembled from shared `@himmelcad/ui`
   modules; screenshots show token-consistent spacing/typography with the
   viewing-box panel as the sibling baseline (fail: any unstyled control,
   DESIGN-SYSTEM "Shared controls").

## 8. Owner-decision items

None. Candidates tested against the escalation protocol and dissolved in
derivation: "may segmentation delete points destructively?" — closed by
X3/C4 (journaled canonical commands with attribute-exact undo, PC-D1);
"is display styling canonical or view-local?" — closed by the VD-D8
two-layer model: PC-D11 entity styles remain canonical below, while the
View-tab color override and point-size multiplier are un-journaled above;
"which fences and auto-tools ship
first?" — closed by X4 + completion discipline (PC-D2, PC-D15); "who owns
the ortho-image entity?" — closed by D2's data-domain taxonomy plus ADR
0020 (PC-D9); "how fast must edited clouds be?" — closed by P2 with
delegated calibration P3 (PC-D14); "is class visibility a view setting or
project state?" (raised by review finding 8) — closed by X3/P1 plus the
journaled viewing-box-activation precedent, reinforced by P4: state that
scopes destructive applies cannot be view-local (PC-D6); "may a fence
apply edit clipped-away points?" — closed outright by P4 (PC-D16). No
axiom conflict, scope boundary, or reserved question remains;
registration's exclusion is a sequencing note to the registry, not a
scope question.

## 9. Disposition — spec review (2026-09-01, findings 1–16)

| #   | Finding                                                           | Disposition                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Applies punch through clip volumes and hidden classes             | PC-D16 (from doctrine P4, occlusion excluded per its carve-out); §2.1, §3.1 C2/E2 rows; real-data zero-outside-box test (§6)                                                                                                                                                   |
| 2   | Stored prism ≠ drawn shape in perspective                         | PC-D5 rewritten: projection-true volume (prism / eye-apex frustum); tint==apply membership test (§6)                                                                                                                                                                           |
| 3   | Merge claim invented over a dossier gap                           | realworks.md §2.3 extended first with sourced Ctrl+M merge ([22], doctrine rule 2); §3.2 A2 restated: explicit merge adopted, keep-sources deviation from X1, Ctrl+M recommended to the registry (§1 row)                                                                      |
| 4   | No fence gesture map                                              | §3.1 E2 gesture table, reconciled against `ui-platform.md` §2.2; navigation rejected with open fence (v1), status-line copy in §2.1; mid-fence reference behavior logged as dossier gap per the A2 silence rule                                                                |
| 5   | Display reference posture misread; scene-wide recolor lost        | §3.5 A2 + PC-D11 retain per-entity canonical styling as the stated X3/P1 deviation; registry F1/VD-D8 supersede only the old accelerator clause: tree Ctrl+A + one Mixed edit is the canonical scene-wide command, while the View control is an un-journaled override above it |
| 6   | Selection-change contradiction §2.1 vs §3.1                       | Target binds at fence close, "Applies to: N clouds" header; §2.1, §3.1 C2; binding test (§6)                                                                                                                                                                                   |
| 7   | Mask/compaction lifecycle gaps (a–d)                              | PC-D1 revised: masks on streamed-in nodes (a), coalescing queue ≤ 1/entity (b), undo cancels/supersedes in-flight bake (c), debounced settled-revision rebake noted against VB-D3 (d); UIP-D10 registration added by registry F7; §6 tests each                                |
| 8   | Classes island lifecycle; visibility state class                  | §2.2 island toggle/close and explicit UIP-D14 rung-6 detached-function-island mapping (registry F12); PC-D6: visibility journaled canonical (X3/P1 + activation precedent); own rows in §3.1/§3.5 E2; exports include hidden points with dialog note                           |
| 9   | Gates unnamed, baselines recipe-less                              | PC-D14 rewritten: G-PC-A…E with script names; offline-crop baseline recipe for both parity gates; §6 wires ids to tiers                                                                                                                                                        |
| 10  | Auto size undefined; multiplier semantics                         | §2.4/§3.5 C1/PC-D11: Auto = renderer-adaptive default, reset affordance, unitless × multiplier default 1.0, automation renders ×1.0; §1 row relabeled                                                                                                                          |
| 11  | Typed rectangle extents undefined                                 | §3.1 C1: world units on the view plane, anchored at the first corner                                                                                                                                                                                                           |
| 12  | Closed-unapplied fence undo/escape                                | §2.1 + §3.1 B2: Ctrl+Z reopens (removes closing edge), Escape discards; component test (§6)                                                                                                                                                                                    |
| 13  | Wrong fallback citation; classification path unverified           | §2.4 corrected: `render_world.rs:59` documents the intensity fallback; `mixed.wgsl:290-294` has no absent branch (verified — class-0 painting named); fallback specified as new work + §5 delta + §6 test                                                                      |
| 14  | VB-D11 extract queue conflict; phantom overlay reuse              | VB-D11 now un-queues extract and cites `pointcloud.extract`; A3 corrected: fence _builds_ the shared overlay, `select.box`/`select.lasso` are verified unwired stubs (`ribbon.ts:107-109`) that adopt it later                                                                 |
| 15  | Disabled Analyze buttons; zero-point failure; merge station links | §3.4 + §1: Analyze group absent until specified, no dead chrome; §3.1/§3.2 E2: empty effective set fails before journaling with explanation; merge keeps the union of station links, extract records provenance only                                                           |
| 16  | Scope indicator idea                                              | Adopted: §2.1 "Scoped to:" panel line with jump to the box panel (PC-D16); component test (§6)                                                                                                                                                                                 |

Registry reconciliation row set (2026-09-02):

| Registry finding | Disposition                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1               | Reconciled to VD-D8 in §2.4, §3.5, PC-D11, §5, and §6: canonical per-entity display remains unchanged; View `color-mode` is the un-journaled override, default Follow entity display; tree Ctrl+A + one Mixed edit remains the canonical scene-wide recolor path. |
| F4               | Claimed by `pointcloud.display` and PC-D11: opacity and vertical exaggeration are per-entity canonical display fields set by `pointcloud.set_display`; legacy group-scoped `view.opacity` / `view.exaggeration` migrate to that path.                             |
| F7               | Reconciled to UIP-D10 in the catalog, workflows, contracts, PC-D1, §5, and §6: every shipping long-running compaction/extraction/sample/merge/ortho bake registers with the main-process registry and exposes chip, jobs-island progress, and cancel.             |
| F12              | Reconciled to UIP-D14 in §2.2, §3.1 B2, and §6: Classes is a detached function island and closes at rung 6 when topmost, after inner field/drag/menu rungs.                                                                                                       |

## Cross-spec reconciliation 2026-09-02

| Item                      | Disposition                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Measure ownership         | Measurement dossier rows now target Measure/Inspect MI-D2/MI-D9; PC-D10 adds cloud-to-cloud and wall-verticality catalog rows and explicitly rejects a density row.                                                                           |
| Mesh readiness            | PC-D10 cites MT-D1–MT-D6/MT-D14; aligned-model dependency is satisfied and breakline-finding hands Draw curves to Mesh.                                                                                                                       |
| Display                   | PC-D11 ↔ VD-D8 remains the closed lower/upper-layer split, including canonical opacity/exaggeration and Raster/Mesh sibling owners.                                                                                                           |
| PhotoLab product arrivals | IF-D19/IF-D25 point-cloud and Gaussian-splat products use Pointcloud's ordinary render/pick/snap/selection/display/Plan/export/WeltView contracts; IF-D20 remains the sole generated import exposure and no Pointcloud import alias is added. |
| Semantic cursor           | Pointcloud cites UIP-D24/§9.7 and declares pick/snap/Fangkreis, borrowed Shared3DTarget, prohibited, and wait; its producer lease never commits a Draw point.                                                                                 |
| GAP §6 Civil inbound      | PC-D8/PC-D10/PC-D11 are amended by PC-D17/PC-D18: Pointcloud owns bounded samples for CIV-D4–CIV-D7/CIV-D12/CIV-D24 and leaves Raster difference products to RA-D14.                                                                          |
| Re-walk 2026-09-02        | P5 applies to fences/sliders: one journal root at gesture end and async compaction. P6 preserves Escape/Undo/right-click finish. Current D1/X3/B1/A2 rules and P7 are satisfied; no office convention is mandated.                            |

## Owner statements batch 2 — 2026-09-02

This section amends PC-D2/D8/D10/D11/D15. Pointcloud supplies bounded
pick/fit leases to UIP-D22's 3D target: resident candidates may seed an estimate,
and an explicit refinement job may return source ids, revisions, residual, sample
count, and confidence. It owns neither the reticle nor `draw.point.create`; missing
coverage/NoData stays visible and never invents a plane or height.

Two immutable grid-mean sampling products join the existing Spatial step mode. For
cell `(i,j) = floor((x-origin_x)/size), floor((y-origin_y)/size)`, compute the mean
finite Z of admitted points. **Existing point nearest cell mean Z** returns the
source point minimizing `abs(z-mean_z)`, breaking ties by XY distance to cell center
then stable point id. **Synthetic cell center at mean Z** returns `(center_x,
center_y, mean_z)`. Empty cells emit NoData. Both record source id/revision, P4
scope, CRS/datum, origin, size, bounds, mode, count, variance, tie rule, empty-cell
count, and content hash; estimates expose expected cells/points, time, memory, and
disk before Run. Outputs are immutable and may be referenced job-locally by Mesh;
they never edit the cloud.

`pointcloud.station_corridor.sample` accepts a Civil alignment/profile revision,
station range/step, offset bands, vertical window, class filter, and sampling mode.
It returns bounded, paged station/offset/elevation samples with residual/NoData and
exact provenance for Civil profiles/corridors; stale Civil inputs reject late
publication. PC-D10 inspection metrics remain Pointcloud-owned. Canonical signed
difference Grids and legends are Raster RA-D14, and Mesh/solid evaluators consume
the immutable products without duplicating sampling.

Registry entries applied by the round-3 rebuild: `pointcloud.grid-mean-sample` (ribbon/context/
Mesh hand-off; `pointcloud.sample.grid_mean` plus job status/cancel) and
`pointcloud.station-corridor-sample` (Civil hand-off;
`pointcloud.sample.station_corridor`).

**PC-D17 — Grid mean modes are exact immutable sampling products.** **Decision:**
the formulas, deterministic tie break, provenance, estimates, and NoData behavior
above extend PC-D8. **Derivation:** S10/G10, C1, P10, X1, X2, MT-D26. **Rejected:**
nearest cell center; lowest/highest point; modifying source points; triangulating a
cloud merely to expose mean height. **Tunable:** cell size and estimate-warning
threshold, never the formula.

**PC-D18 — Civil receives a bounded station-corridor sampler, not sampling
authority.** **Decision:** Pointcloud owns the query/product and Civil owns station,
profile, and corridor interpretation. **Derivation:** Civil CIV-D4–D7/CIV-D12,
P10, X2, `cross-spec-needs.md` "From civil.md". **Rejected:** Civil scanning raw
cloud storage; Pointcloud publishing a corridor. **Tunable:** page size and worker
budget.

Verification covers deterministic cell-boundary/tie fixtures, empty/NaN cells,
rotated origins, billion-point estimates and cancellation/restart, source-revision
races, source immutability, sparse reticle failure, and station-range paging.

| Work-order item                 | Disposition                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| S4/G7 reticle leases            | Applied as a bounded producer/consumer note; Draw remains point owner. |
| S10/G10 grid mean modes         | Applied by PC-D17 with exact formulas and immutable provenance.        |
| Civil station-corridor sampling | Applied by PC-D18.                                                     |
| S11 difference ownership        | Applied: PC-D10 metrics retained; Raster RA-D14 owns Grid/legend.      |

## Owner batch 3 — 2026-09-02

This section promotes the S16 terrain/ground and floor extraction slices to
workflow level. It amends PC-D4/PC-D6/PC-D7/PC-D13/PC-D15 where stated and
otherwise reuses them unchanged: selected-cloud enabling, the canonical class
table, copy-not-move extraction, atomic multi-entity commands, and the one
remaining classifier backlog. P4 scopes every analysis and apply. Station view
and cloud-to-cloud **registration** belong to
`docs/builder-program/specs/registration-stations/registration-stations.md`
(the owning specification); that path is cited and neither capability is
dispositioned here. PC-D10's different
Twin-Surface/cloud-to-cloud **inspection** row also remains unchanged.

### 10.1 Catalog amendments (registry rows)

| Id                          | Ribbon group     | Access paths                                                                                                                                | Surface                                                                   | Perf                                                                | Canonical automation                                                                                                           | Status                       |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `pointcloud.extract-ground` | Classify / Cloud | ribbon **Extract ground…**; selected-cloud context **Extract ground…**; console `pointcloud ground extract`; automation                     | closeable right function panel + viewport preview + UIP-D10 job           | continuous preview inspection; bounded estimate; long analysis/bake | `pointcloud.ground.preview`, `.check`, `.commit`; optional extracted output is the PC-D7 copy contract in the same commit plan | workflow-level, new (PC-D19) |
| `pointcloud.extract-floor`  | Classify / Cloud | ribbon **Extract floor…**; selected-cloud and active-viewing-box context **Extract floor…**; console `pointcloud floor extract`; automation | closeable right function panel + viewport candidate preview + UIP-D10 job | continuous preview inspection; bounded estimate; long analysis/bake | `pointcloud.floor.preview`, `.check`, `.commit`; class/extract/both outcomes share one checked membership manifest             | workflow-level, new (PC-D20) |

Both rows enable only for one or more SE-D19-admitted point-cloud entities.
Ground may use the whole P4-visible selected set. Floor additionally requires
an active viewing box or an explicit current spatial selection. No quick-
surface entry or global shortcut is added. The panel x and ribbon re-toggle
close the panel without cancelling a registered job; the jobs chip/island owns
continued progress and Cancel. **Discard preview** removes only staging.

Both workflows open with a shipped, named **Himmel:CAD survey default**
parameter profile. Every numeric default is X6 calibration data, not a hidden
product constant: users can edit it in the panel, save a named user or project
profile, reset to the shipped profile, and import/export the versioned profile
as JSON. The active profile and every resolved value are recorded in Preview,
Check, provenance, and automation payloads. Class names/codes remain entries in
the editable PC-D6 class table. This applies P7's editable-default mechanism
without presenting classifier thresholds or office class conventions as
survey truth.

### 10.2 Workflow — terrain/ground extraction

The user selects one or more registered outdoor clouds and presses **Extract
ground…**. The panel names the captured entities and exact P4 scope: active
clip volumes, entity/class visibility, and included input classes. Natural
occlusion is ignored. The target is a chosen entry in the canonical PC-D6
class table; the generated-name suggestion **Ground** is editable and never
creates a fixed office class code. Existing non-target class assignments are
preserved by default; **Reclassify included classes** must be enabled explicitly
and the affected class/count estimate is shown before Run.

The versioned `hcad.pointcloud.ground-progressive@1` filter exposes these typed
parameters in project units:

- seed cell size and seed percentile, with deterministic stable-point-id tie
  break;
- neighborhood radius and multiscale growth factor;
- maximum local terrain slope;
- maximum vertical residual above/below the current candidate terrain;
- minimum connected ground area and maximum void bridge distance;
- included source classes and the target Ground class.

The algorithm starts from the requested low-percentile finite-Z seeds per
project-XY cell, constructs a deterministic robust candidate terrain, and grows
membership only when both slope and vertical-residual tests pass at the current
scale. Cells without sufficient support remain **Unknown**, not non-ground.
Every candidate point retains its stable source point identity; no coordinate,
height, intensity, return, color, or source-station attribute changes. These
rules make the classifier reproducible, but its result is still a proposed
classification, never a claim of survey truth.

**Preview** writes an immutable temporary membership manifest keyed by cloud
ids/revisions, placements, P4 scope, input-class table revision, parameters,
algorithm version, and evaluator hashes. The viewport overlays Ground,
Non-ground, and Unknown with token colors/pattern legend; the panel reports
counts, area/height ranges, residual distribution, disconnected components,
and withheld/ambiguous points. Changing a parameter or source marks the
last-good preview **Preview stale** within the §10.6 interaction budget and
starts a new job only after the gesture settles. The review surface reuses the
§2.1 fence overlay for preview-local **Include as Ground / Exclude from Ground**
overrides; it does not invoke §2.2's immediately journaled Classify command.
Using that ordinary command separately changes the source revision and marks
this preview stale.

The result plan always includes **Assign Ground class**. **Also create extracted
ground cloud** is optional and shows the output name, point count, attributes,
time/RSS/disk estimate, and the PC-D7 copy semantics. **Commit** waits until any
requested extracted dataset and its prepared hierarchy are verified, then
atomically journals one grouped root: exact before/after classification deltas
for every source cloud plus, when selected, a new fully baked
`hcad.point-cloud@1` containing exactly the committed Ground membership and all
point attributes. The extracted cloud carries PC-D7 provenance to each source
revision but no false station membership. Sources are never deleted or
geometrically edited. Undo restores every prior class byte and tombstones the
optional extracted entity; redo restores both from retained immutable hashes.
Cancel, failure, stale CAS, and app restart before Commit publish neither class
changes nor an entity.

After Commit, **Create DGM…** selects the extracted ground cloud (or the source
cloud with the Ground class as its captured visible class) and hands it to
Mesh/Terrain `mesh.create-surface`. Mesh MT-D9/MT-D26 owns sampling roles,
Check, breaklines/boundary, triangulation, the MT-D25 surface recipe, and DGM
publication; `mesh-terrain.md` §11.7 carries the reciprocal PC-D19 hand-off
request. Pointcloud never triangulates or labels its classifier preview a DGM.

### 10.3 Workflow — planar floor extraction

The user selects the indoor source clouds and either activates a named viewing
box or creates an explicit spatial selection, then presses **Extract floor…**.
The panel refuses an entity-only target with no spatial region and offers
**Use active viewing box** or **Use current spatial selection**. It captures the
PC-D5 world-space prism/frustum/box or stable point-membership selection plus
the complete P4 scope. Later camera, selection, box, or class-visibility changes
do not retarget the running analysis.

The user chooses reference up — **Project Z**, an exact named UCS axis, or a
typed unit vector — and types:

- maximum floor inclination from reference up;
- point-to-plane distance tolerance;
- neighborhood radius and maximum support gap;
- minimum supporting point count and project-XY patch area;
- minimum separation between parallel floor levels;
- target Floor class and included source classes.

Every slider/stepper is an accelerator mirrored by the typed field; project
units and precision apply. The panel shows the normalized up vector, angular
tolerance, distance tolerance, and each detected plane's origin, normal,
elevation in project Z, inclination, RMS/max residual, support count, area, and
source revision. No implicit datum or level name is invented.

`hcad.pointcloud.floor-planes@1` deterministically finds connected planar
supports inside the captured region. A candidate must meet every typed
inclination, distance, support, area, gap, and separation test. Parallel slabs
at different elevations remain separate candidates; ramps exceeding the floor
inclination remain excluded rather than flattened; stairs, walls, furniture,
holes, sparse patches, and degenerate neighborhoods are reported as excluded or
Unknown. The user checks one or more candidate rows; **Jump** frames and pulses
their exact support in the viewport. A last-good preview remains visible and
marked stale while recomputation runs.

The result selector requires at least one of **Assign Floor class** and
**Create extracted floor cloud**. Class-only writes exact PC-D6 class deltas.
Extract-only creates a PC-D7 fully baked copy from the checked membership
manifest without modifying source classes. Both atomically publish the class
deltas and copied entity/entities in one grouped journal root after every
artifact and expected revision verifies. Each selected plane may become a
separate named extracted cloud, or all selected planes may become one named
cloud; the explicit choice and plane membership are provenance. All point
attributes are preserved and station identity is not asserted. Undo/redo,
cancel, failure, checkpoint, and stale-result behavior match §10.2.

This workflow stops at floor point extraction. Floor flatness/levelness reports
remain the cataloged PC-D10 inspection capability; the existing RealWorks
flatness disposition is not repeated or silently promoted here.

### 10.4 Function-contract answers

#### Ground extraction (`pointcloud.extract-ground`)

**A1.** §10.2. **A2.** RealWorks Auto-Classify Outdoor includes Ground and
other classes (`realworks.md` §2.4), and W5 explicitly reviews/fixes
misclassification then extracts classified regions. We adopt that
classify-review-extract sequence. The dossier does not document its filter
parameters or algorithm; the transparent versioned parameter schema above is
the S16/C1-driven Himmel:CAD deviation, not attributed to RealWorks. The
existing §1.1 Auto-Classify row is amended once to partial adoption; no new
dossier row or second disposition is created. **A3.** PC-D6 supplies classes,
PC-D7 the extracted-cloud semantics, PC-D13 atomic multi-cloud application,
and Mesh MT-D9/MT-D26 the ground-cloud→DGM hand-off.

**B1.** §10.1 contains every path; no quick surface/shortcut. **B2.** Panel
close is keep-job-running; Discard removes staging; Commit alone changes the
document. **B3.** A right panel preserves viewport inspection while fitting the
parameter/count/result set. **C1.** All parameters and class/output names are
typed/selectable; no direct geometry handle exists; the named editable profile
mechanism above supplies, persists, resets, imports, and exports their defaults.
**C2.** Selected clouds and P4 scope capture at Preview/Run and revalidate at
Commit; later selection is irrelevant. Multi-cloud commit is all-or-none.
**C3.** The optional extracted cloud is the PC-D7/P2 bake; the classifier
preview is an immutable reusable manifest, not canonical state. **C4.** §10.2
names the single grouped commit, exact restore set, and retained hashes.

**D1/D2.** §10.6. Weak hardware reduces overlay density and histogram sample
frequency first; classification membership, attributes, estimates, cancel
response, and final bake never degrade. **E1.** The real-data gate captures
both themes/scales with P4 scope, typed inputs, three-state preview,
Ground/non-ground/Unknown counts, residuals, optional output, stale-last-good,
progress/cancel, and DGM hand-off. **E2.** Render, pick/snap, selection,
measurement, active viewing box, class visibility, exports, tree/Properties,
station relations, prepared cache, automation, Plan/WeltView, and Mesh all see
the new revision/output atomically. Concurrent class edits or source
compaction cause CAS rejection and a refreshed preview; independent clouds may
analyze concurrently, while one commit serializes through the journal. Largest
and least members are §10.6 and a captured scope with no finite-Z ground seed;
the latter fails Check without journaling. **E3.** §10.6.

#### Floor extraction (`pointcloud.extract-floor`)

**A1.** §10.3. **A2.** RealWorks' floor-flatness row says the tool extracts
floor-only points, and W9 says it auto-retrieves them with indoor
classification as a possible preselection (`realworks.md` §2.7/W9). We adopt
only that extraction prerequisite. Exact planar detection parameters and the
box/selection scope are not documented there; they are stated Himmel:CAD S16,
C1, and P4 decisions. No dossier addition is needed, and PC-D10 still owns the
deferred analysis/report. **A3.** Viewing Box VB-D13 and PC-D5 supply
camera-free scope; PC-D6/PC-D7 supply class/copy outcomes; selection remains
ui-platform-owned.

**B1/B2/B3.** §10.1; same panel/job lifecycle as Ground. The active-box context
entry is an adapter to the same commands. **C1.** Every tolerance, vector,
minimum, class, and name is typed; each slider/stepper and typed tolerance are
live-synchronized twins, and their defaults use the named editable profile
mechanism above. List selection and Jump are topological choices with no
numeric twin. **C2.** One or more clouds plus exactly one explicit spatial
region are captured; candidate selection changes only the result manifest.
**C3.** Preview manifests and optional prepared extracts are the bakes. **C4.**
Class/extract/both are one atomic grouped root with exact attribute/entity undo.

**D1/D2.** §10.6; overlay density may reduce, planar admission and final
membership may not. **E1.** Captures show the box/selection source, typed
tolerances/up vector, separate parallel floor candidates, residuals/Unknown,
Jump, class/extract/both, and failure states without color-only meaning.
**E2.** The Ground consumer list applies. Viewing-box deletion after capture
marks preview stale but cannot change membership silently. Plane rows remain
analysis results, not CAD planes or station resources. Least members are one
valid planar patch and an under-supported/collinear patch (explicit failure);
largest is §10.6. **E3.** §10.6.

#### Gesture arbitration

Neither workflow arms a new viewport acquisition tool. Ordinary ui-platform
§3.6 LMB selection, LMB/RMB/MMB navigation, wheel zoom, context click, Escape
ladder, and touch equivalents remain platform-owned. Clicking a highlighted
preview candidate selects its result row through the ordinary pick adapter;
**Jump** is a button, not a hidden gesture. Tab/Shift+Tab traverse panel fields;
Up/Down act on the focused candidate list; typing edits only the focused field.
No candidate cycling or DR-D1 construction bar is claimed. Existing Viewing Box
or selection tools finish and release their gesture lease before either
analysis starts.

### 10.5 Decision records

**PC-D19 — Ground extraction is reviewed classification with an optional
PC-D7 cloud, not an inferred DGM.** **Decision:** §10.2's versioned progressive
filter, typed parameters, editable named default profiles,
Ground/non-ground/Unknown preview, P4 capture, preserve-existing-class default,
atomic class deltas, optional fully baked PC-D7 output, exact undo, and Mesh
hand-off are mandatory. The filter proposes membership only; Mesh alone creates
the DGM. **Derivation:** owner S16/G14; X1–X3/X5/X6;
P2/P4/P5/P7/P8/P11; C1/D1/E2; RealWorks dossier §2.4/W5;
PC-D1/PC-D4/PC-D6/PC-D7/PC-D13/PC-D16; MT-D9/MT-D25/MT-D26. **Rejected:**
silently overwriting every class; deleting non-ground points; triangulating in
Pointcloud; treating occlusion as scope; publishing class changes before the
requested extract is verified. **Tunable:** filter/default quality parameters,
overlay density, thresholds, and performance budgets under X6; P4, source
coordinate immutability, Unknown honesty, atomicity, and Mesh ownership are not
tunable.

**PC-D20 — Floor extraction is explicit planar detection in a captured box or
selection with class/extract parity.** **Decision:** §10.3's spatial-scope
requirement, typed up/tolerances, multi-plane candidate semantics, class-only,
editable named default profiles, extract-only, or atomic both outcome, PC-D7
provenance, and no-flatness-report boundary are mandatory. **Derivation:** owner
S16/G14; X1–X3/X5/X6; P2/P4/P5/P7/P8/P11; C1/D1/E2; RealWorks dossier
§2.7/W9; PC-D5–D7/PC-D13/PC-D16; VB-D13.
**Rejected:** whole-project floor guessing without a spatial region; lowest-Z
equals floor; merging parallel storeys; flattening ramps/stairs; relabeling the
result as a flatness report; station-view or registration ownership here.
**Tunable:** inclination/distance/support/gap/separation defaults, overlay, and
job budgets; captured scope, exact attributes, explicit outcomes, and report
boundary are not tunable.

### 10.6 Named real-data gate and D1 budgets

**`G-RW-EXTRACT-GROUND-FLOOR`** is the one M-RW acceptance gate named by the
master plan. Launcher: `node scripts/verify-pointcloud-extraction.mjs --gate G-RW-EXTRACT-GROUND-FLOOR`.
It requires capabilities `browser-gpu` and `real-data`. It is currently absent
and therefore **unverified**; missing fixture capability fails at release
rather than skips.

The gate uses two checksum-pinned, license-recorded real datasets: an outdoor
survey containing sloped terrain, curbs, vegetation, vehicles, roofs, voids,
and independently reviewed point labels; and a multi-storey indoor scan with
floors, ramps, stairs, walls, furniture, holes, sparse areas, and independently
reviewed plane/membership references. Fixture manifests record CRS/datum,
source checksum, reference-author, review date, point counts, class balance,
and any known uncertainty. The gate fails if those artifacts are absent.

It proves P4 by hiding a class and clipping each dataset, then independently
recomputes that zero changed/extracted points lie outside the captured set. It
checks deterministic hashes and stable ids; typed/UI/automation parameter
parity; Ground precision and recall ≥ 0.95 on reviewed finite labels with
Unknown reported separately; floor-candidate precision and recall ≥ 0.95,
plane inclination within the typed bound, and every admitted point within the
typed distance tolerance; exact preservation of coordinates and non-class
attributes; optional-extract PC-D7 provenance; atomic undo/redo; source-revision
races; cancel; crash/restart; and ground cloud → Mesh Create surface Check on
the same dataset. Accuracy thresholds are X6-tunable only with a retained
confusion matrix and owner-visible false-positive/false-negative captures;
they are classifier quality gates, never survey-accuracy claims.

Continuous orbit, candidate-row hover/jump, and parameter editing while a
last-good preview is visible keep presented-frame interval p95 ≤ 2× target;
changed input marks the preview stale within 100 ms p95. Estimates are bounded
< 1 s. Extreme Ground work is 500M captured points and completes ≤ 20 min on
the calibrated active tier. Extreme Floor work is 100M captured points across
100 valid/invalid candidate planes and completes ≤ 10 min. Both show first
truthful phase/unit progress ≤ 500 ms, poll cancellation in ≤ 250 ms units,
acknowledge ≤ 250 ms p95 and ≤ 2 s hard outside a ≤ 500 ms atomic publication
boundary, use additional RSS ≤ `min(4 GiB, 25% of physical RAM)`, and stage ≤
`2 * captured immutable input bytes + final prepared output bytes + 2 GiB`.
Jobs predicted ≥ 60 s checkpoint by command id, source/scope/class-table hash,
parameter/algorithm hash, and Morton tile; restart restores **Paused after
restart**, verifies completed hashes, and resumes. Cancellation/failure leaves
no class delta or entity. Completion means the final membership manifest,
requested prepared outputs, render/pick indices, provenance, and one durable
CAS journal root are all readable.

Weak hardware lowers preview point/overlay density first and may increase job
time after a truthful revised estimate. It never loosens scope, tolerances,
membership checks, attribute equality, cancellation bounds, or atomicity.

### 10.7 Current implementation delta (verified 2026-09-02)

**Exists and is reused:** LAS/Potree import recognizes the classification
attribute semantic (`crates/himmelcad-io/src/las_import.rs:926-943`) and creates
immutable prepared point-cloud datasets. The current import attribute summary,
however, records color and intensity but no classification-presence flag
(`crates/himmelcad-io/src/las_import.rs:1044-1058`), matching the PC-D6 gap.
The renderer already defines a point-classification palette mode
(`crates/himmelcad-render/src/render_world.rs:52-67`), decodes optional source
classification into packed point metadata
(`crates/himmelcad-render/src/providers/potree.rs:162-216`), and colors the
packed class in the shader
(`crates/himmelcad-render/src/shaders/mixed.wgsl:290-294`). Those are display
and decode paths, not a classification writer or either extraction workflow.
The current Builder ribbon exposes unwired generic Segment Extract/Classify
actions only (`apps/builder/renderer/src/ribbon.ts:114-127`), and generic entity
commands journal placement rather than point classification or extraction
(`crates/himmelcad-core/src/entity_commands.rs:18-91`). The automation schema's
method table contains generic app/view/entity/command lifecycle operations but
no Ground or Floor commands
(`schemas/automation/himmelcad-automation-v1.schema.json:77-145`). Therefore
neither workflow exists today.

**New:** deterministic ground and planar-floor kernels; immutable membership
manifests and checkpoint descriptors; preview overlays/error/result tables;
P4/SE-D19 capture and CAS; exact class-delta plus optional PC-D7-output grouped
transactions; right-panel/ribbon/context/console wiring; class-presence
admission; Agent/Python schemas; recovery/consumer tests; real-data fixture
manifests; and the named gate launcher. No registration, station panorama,
flatness report, DGM triangulator, private class table, or second extraction
entity contract is added.

### 10.8 Cross-spec requests and disposition

1. Mesh/Terrain MT-D9/MT-D26 must accept PC-D19's extracted ground cloud or
   Ground-visible source capture without reclassifying it; §11.7 of that spec
   carries the reciprocal request. Mesh remains sole DGM checker/publisher.
2. `specs/view/viewing-box.md` and `specs/ui-platform/ui-platform.md` must expose
   their existing camera-free box/selection snapshots to PC-D20 and keep all
   gestures platform-owned; Pointcloud adds no competing volume or selection
   store.
3. `REGISTRY.md` must add both §10.1 rows, the command schemas, and
   `G-RW-EXTRACT-GROUND-FLOOR`; it must also narrow PC-D15's remaining
   classifier backlog exactly as this amendment does. Until that re-walk is
   clean, this amendment is drafted rather than newly registry-verified.
4. `docs/builder-program/specs/registration-stations/registration-stations.md`
   owns station view and cloud-to-cloud registration, including their
   resources, UI, reports, commands, and gates. This spec requests only a
   reciprocal citation that extracted clouds retain provenance but do not
   acquire station identity; it does not disposition either capability.

| Owner batch-3 item            | Disposition                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S16 terrain/ground extraction | Applied at workflow level by PC-D19: parameterized reviewed classification, P4, optional PC-D7 cloud, exact undo, Mesh DGM hand-off, and the real-data gate.                                                       |
| S16 floor extraction          | Applied at workflow level by PC-D20: planar detection inside a box/selection, typed tolerance parity, class/extract/both, and the same real-data gate.                                                             |
| G14 M-RW gate                 | Applied through `G-RW-EXTRACT-GROUND-FLOOR`; the gate is named and budgeted but explicitly unverified until its launcher and licensed fixtures exist.                                                              |
| RealWorks dossier evidence    | Existing §1.1 Auto-Classify disposition amended once to partial adoption. The §2.7/W9 floor-only extraction evidence supports PC-D20; PC-D10 floor-flatness analysis remains deferred and is not re-dispositioned. |

No owner question remains. X6 and the named gate own calibration; P4 fixes
scope; PC-D6/PC-D7 fix class/copy semantics; X1 requires Unknown and exact
undo; the separate registration/station owner prevents double-booking.
