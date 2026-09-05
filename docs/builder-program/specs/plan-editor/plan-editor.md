# Plan editor — workflow-level specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2.

Grounding: `docs/PLAN-EDITOR-EXPORT.md`; RIB Civil plan production
(`dossiers/rib-civil.md` §2.9 and W7); Revit view rules and schedules
(`dossiers/revit.md` §2.6, §2.8, W5, W6, §5); the current Plan package and
maintained Excalidraw fork. E1 reference artifact: §7 of this file, whose
criteria are in-repository and failable.

## 1. Function catalog — registry rows

Access: R = Builder ribbon; W = Plan-window UI; X = Plan-canvas context menu;
C = console; A = agent + Python SDK; K = keyboard. Every UI, console, and
automation path resolves to the same typed operation named in the Automation
column. §1.2 classifies each operation as a canonical command, query, UI
action, job action, or approved external action; only canonical Plan mutations
enter the journal and Ctrl+Z walk.

| Id                     | Tab · group                  | Access paths                          | Surface                                 | Perf                                 | Automation command                                                                                                 | Status vs current implementation                                                                                                                                |
| ---------------------- | ---------------------------- | ------------------------------------- | --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.window`          | File · Project               | R (`Plan editor`, toggle/focus), C, A | dedicated resizable OS window           | bnd                                  | `plan.window.open/close`                                                                                           | **missing**; current Plan is a `FloatingTaskIsland` (`App.tsx:849–852`) and Electron creates only the main `BrowserWindow` (`electron/main.ts:269–323`)         |
| `plan.sheet`           | Plan window · Sheets         | W, X, C, A                            | sheet rail + properties                 | bnd                                  | `plan.sheet.add/duplicate/rename/reorder/set_paper/remove/list`                                                    | **partial**; local sheet operations exist but are not journal-backed (`PlanIsland.tsx:289–325, 809–878`)                                                        |
| `plan.compose`         | Plan window · Draw / Arrange | W, X, K, C, A                         | finite-paper Excalidraw canvas          | cont preview; bnd commit             | `plan.element.create/update/remove/group/ungroup/align/distribute/reorder/list`                                    | **partial**; fork actions stay (`packages/excalidraw-plan/HCAD_FORK.md:40–51`), but composition state is renderer-local (`PlanIsland.tsx:183–200`)              |
| `plan.viewport`        | Plan window · Viewports      | W, X, C, A                            | canvas frame + properties               | cont preview; bnd edit; long refresh | `plan.viewport.create/update/set_update_policy/refresh/pin/unpin/remove/list`                                      | **not existing**; adapter implementation is explicitly `MockPlanModelViewAdapter` and returns no elements (`viewport.ts:117–130`)                               |
| `plan.viewport-filter` | Plan window · Layers         | W, C, A                               | Layers rail + viewport properties       | bnd                                  | `plan.viewport.set_layer_filter/set_rule_filters`                                                                  | **not existing**; hard-coded `MOCK_LAYERS` and placeholder tab (`PlanIsland.tsx:150, 716–724, 1080–1098`)                                                       |
| `plan.view-template`   | Plan window · Viewports      | W, C, A                               | template picker/editor                  | bnd                                  | `plan.view_template.create/update/apply/assign/unassign/remove/list`; `plan.view_filter.create/update/remove/list` | **missing**; descriptor v1 has only one layer filter (`document.ts:34–52`)                                                                                      |
| `plan.template`        | Plan window · Library        | W, X, C, A                            | library + binding properties            | bnd                                  | `plan.template.instantiate`; `plan.binding.set/clear`; `plan.template.list`                                        | **partial**; typed built-ins/bindings exist (`templates.ts:10–94, 96–107`), but UI supplies mock project metadata (`PlanIsland.tsx:327–351`)                    |
| `plan.library`         | Plan window · Library        | W, C, A                               | scoped library manager                  | bnd                                  | `plan.library.save/remove/import/export/list` with `scope`                                                         | **partial**; project templates sit in the document and user templates use `localStorage` (`document.ts:118–130`; `library.ts:31–66`)                            |
| `plan.schedule-place`  | Plan window · Insert         | W, X, C, A                            | canvas table frame + properties         | bnd; long repagination               | `plan.schedule.place/update/remove/list`                                                                           | **missing**; `PlanSheet` contains only scene, viewports, template instances, and a legacy sheet filter (`document.ts:108–116`)                                  |
| `plan.exchange`        | Plan window · File           | W, C, A                               | OS open/save dialog + collision preview | bnd→long                             | `plan.exchange.import/export`                                                                                      | **partial** standalone file open/download (`PlanIsland.tsx:463–481, 520–536`); it is wrongly treated as authority (`:167`)                                      |
| `plan.export`          | Plan window · Output         | W, C, A                               | preflight → platform job                | long                                 | `plan.export.describe/run`                                                                                         | **partial** deterministic bundle/report exists (`export.ts:49–87`), with disclosed omissions (§2.4) and browser-download-only output (`PlanIsland.tsx:483–518`) |
| `plan.print`           | Plan window · Output         | W, C, A                               | preflight → OS print dialog             | long                                 | `plan.print`                                                                                                       | **missing**; current output toolbar exposes PDF/SVG/PNG only (`PlanIsland.tsx:635–651`)                                                                         |

Catalog boundaries: model dimensions, point labels, alignments, and their
screen-space text are canonical Draw content rendered by a viewport, not Plan
elements (`draw.md` E2 consumer table, row **Plan composer**). Model layer CRUD
remains `layers.*` in Draw; this domain only holds viewport-level references.
Schedules remain BIM-owned (`bim-specs.md` BS-D14); this spec owns their sheet
placement, pagination, and output consumption. Per-entity display and
specification resolution remain PC-D11 and BS-D12; Plan adds a view-override
layer and consumes the resolved result. Model export remains File-owned; this
catalog owns composed-sheet export.

The B1 reachability matrix is explicit: the Builder ribbon exposes only the
File toggle because all authoring needs the Plan window; Plan-canvas context
menus expose entity-relevant sheet operations, while the main model context
menu is absent because paper objects are not canonical model entities. A main
viewport quick surface is absent because composition needs finite-paper
context. Every catalog row has console and agent/Python access through its
listed typed operation; state-changing rows use the canonical commands named in
§1.2. Keyboard access is present only for focus-local compose/edit/navigation
actions; operations needing a picker, preflight, or collision decision
intentionally have no unscoped shortcut.

### 1.1 Dossier-row dispositions

The catalog derives from every row in `rib-civil.md` §2.9 plus the two
plan-display rows in §2.3. Each has an explicit disposition.

| Dossier row                                                         | Disposition                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planausschnitte                                                     | **Adopted, adapted:** named/rotated model frames become named sheets plus viewports referencing canonical model views; fit-sheet replaces full-screen frame mode (`rib-civil.md` §2.9, W7).                                                              |
| Drucken Plan + Skalierung                                           | **Adopted:** typed scale, deterministic scale-true PDF, and print (§2.4). WMF/metafile is **deferred** to the import-formats owner because no repository format contract or provider exists (`rib-civil.md` §2.9).                                       |
| Plangestaltung                                                      | **Adopted, adapted:** sheet decoration is Plan content and reusable templates, stored in project/user scopes rather than sibling `*.dzg`/`*.dag` files (`rib-civil.md` §2.9).                                                                            |
| Dynamische Bemaßung, Trassengestaltung, Detailzeichnungen           | **Adopted through ownership split:** viewports render Draw-owned model dimensions/alignment styling; Plan owns sheet text, arrows, shapes, and detail composition (`rib-civil.md` §2.9; `draw.md` E2 Plan-consumer row).                                 |
| RE-2012-konforme Pläne                                              | **Deferred with reason:** regulation-specific generation needs a separate sourced workflow and ruleset; no rule is invented here. Templates, bindings, and filters are its substrate (`rib-civil.md` §2.9).                                              |
| Höhen-/Querschnittspläne                                            | **Adopted through Civil ownership:** CIV-D7/CIV-D12 own longitudinal/cross-profile model views; PE-D21 captures their exact revisions through the existing viewport and schedule-placement contract without a new paper model (`rib-civil.md` §2.9, W7). |
| Listen                                                              | **Rejected from this domain:** list/report definition and output are File/BIM functions; Plan only places an already-defined schedule (`rib-civil.md` §2.9; `bim-specs.md` BS-D14).                                                                      |
| Rasterbilder — already georeferenced model rasters and paper images | **Adopted:** georeferenced raster remains model content visible through a viewport; logos/key images are paper images and must embed in export (`rib-civil.md` §2.9, W7).                                                                                |
| Rasterbilder — three-point fitting of an unreferenced scan          | **Rejected from this domain:** Raster owns evidence-based placement through `raster.georeference.preview/apply`; Plan consumes the resulting entity and never fits or invents coordinates (`raster.md` RA-D2 and §2.1).                                  |
| HV-Planverwaltung                                                   | **Rejected from this domain:** foreground/background edit locking is model layer authority owned by Draw; Plan view filters never make model content editable (`rib-civil.md` §2.3).                                                                     |
| Darstellung options                                                 | **Adopted:** per-plan visibility becomes per-viewport layer and rule filters, without canonical style mutation (`rib-civil.md` §2.3).                                                                                                                    |

Relevant Revit rows are also dispositioned because the registry assigns them
here. Rule-based view filters and assigned/applied view templates are
**adopted** with their predicate/override and include/exclude/lock behavior
(`revit.md` §2.6, W5, §5). Schedule definition is **rejected from Plan** as
BIM-owned, while live sheet placement is **adopted** (`revit.md` §2.8, W6;
`bim-specs.md` BS-D14). No other dossier absence is asserted.

### 1.2 Operation classes, grants, CAS, and results

The automation boundary is ADR 0024, not UI reachability. Capabilities never
carry across a project generation or process. `projectRead`, `projectWrite`,
`filesystemRead(path)`, `filesystemWrite(path)`, `externalPublish(path)`,
`devicePrint(device)`, `userLibraryRead/Write`, and `uiSession` are separate
grants. Approval tokens are single-operation, scope-bound, expiring inputs;
possessing a filesystem grant is not approval to publish. The UI obtains the
same scoped grants through its picker/confirmation flow.

Every canonical Plan mutation accepts `projectGeneration` and
`expectedPlanRevision`; success returns `planRevision`, `commandId`, and a
human-readable `undoLabel`. A mismatch returns typed `StalePlanRevision` with
the current generation/revision and commits nothing. Queries return the
observed generation/revision. Long operations return `jobId`; status and cancel
use UIP-D10/UIP-D11 `jobs.list/cancel`. Cancel, denied/expired approval,
revoked project access, or a missing renderer has a typed terminal result and
publishes neither a Plan root nor an external target.

| Operation family                                                                                                                                                                                                                  | Class                                      | Required grant / approval                                                                              | Result and undo behavior                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.window.open/close`                                                                                                                                                                                                          | platform UI action                         | `uiSession`; active project read to bind the window                                                    | focuses/creates/closes the project-generation window; `UiUnavailable` headlessly; never journals and is never prerequisite to headless work |
| `plan.*.list`, `plan.export.describe`                                                                                                                                                                                             | canonical/read query                       | `projectRead`; `describe` needs no path grant                                                          | paginated/read result plus observed generation/revision; no undo                                                                            |
| `plan.sheet.*`, `plan.element.*`, `plan.viewport.create/update/set_update_policy/pin/unpin/remove`, `plan.viewport.set_*`, `plan.view_template.*`, `plan.view_filter.*`, project-scope `plan.template/library/binding/schedule.*` | canonical command                          | `projectWrite` + CAS fields                                                                            | committed revision/id/undo label; exactly one journal step per completed user act                                                           |
| `plan.viewport.refresh` and schedule repagination/refresh                                                                                                                                                                         | job action over derived products           | `projectRead`; a later explicit Pin needs `projectWrite`                                               | UIP-D10 handle; linked refresh completion is not an undo step; Pin is                                                                       |
| user-scope `plan.library.list/save/remove`                                                                                                                                                                                        | versioned user-store query/command         | `userLibraryRead` or `userLibraryWrite`                                                                | user-store revision and reversible user-store Undo action; never project Ctrl+Z                                                             |
| `plan.exchange.import`, file-backed `plan.library.import`                                                                                                                                                                         | approved external-read + canonical command | `filesystemRead(path)` + explicit external-read approval; import also `projectWrite` + CAS             | validated preview token, then job/committed revision; no partial objects/root                                                               |
| `plan.exchange.export`, file-backed `plan.library.export`                                                                                                                                                                         | approved external action                   | `projectRead`/`userLibraryRead` + `filesystemWrite(path)` + `externalPublish(path)`                    | job handle and final target hash; external file is not undoable                                                                             |
| `plan.export.run`                                                                                                                                                                                                                 | approved external action                   | `projectRead` + `filesystemWrite(path)` + `externalPublish(path)` + unexpired frozen description token | UIP-D10 handle; atomically published files/hashes; no Plan mutation                                                                         |
| `plan.print`                                                                                                                                                                                                                      | approved device action                     | `projectRead` + `devicePrint(device)`                                                                  | PDF handoff job; unavailable unattended; no Plan mutation                                                                                   |

`plan.export.describe` freezes no authority by itself: it returns a short-lived,
hash-bound description token naming the Plan/project/view/artifact graph. `run`
rejects an expired token or changed graph instead of exporting an unreviewed
state. SDK signatures expose these classes and grants rather than calling every
verb a command (PE-D16).

## 2. Full workflow narratives

### 2.1 Create a sheet with a live model viewport at 1:250

The user has an open Builder project containing a classified cloud, survey
linework, and BIM objects. File → **Plan editor** opens a dedicated resizable
window. A second invocation focuses the existing window; it never creates a
second writer. Finite authoritative sheets lie on an infinite pan/zoom canvas;
Sheets/Library/Layers, tools, and properties occupy floating/dockable top, left,
and right islands (PE-D20). The title bar closes the
window. Escape backs out of the active field/tool/selection but never closes
the window, preserving UIP-D14's workspace-safety outcome while moving Plan
out of its obsolete island class.

Electron main owns exactly one non-modal Plan `BrowserWindow` and one project
lease for the active project generation. The Plan window has a shared-token,
accessible product title bar; OS move/resize/minimize/maximize behavior remains
native, but unstyled product controls do not. File toggle restores and focuses
an existing minimized/hidden window. Minimizing the main window minimizes Plan;
restoring either preserves their independent monitor positions. Closing only
Plan cancels local gestures and backgrounds registered jobs. Project switch or
app quit follows file-project's E2 rule: one prompt names all active jobs and
offers **Wait** or **Cancel and proceed**; automation close returns its named
busy rejection. Only after waits/cancellation reach safe boundaries does the
project generation invalidate and the window close. A late worker holding the
old generation can never publish.

Plan bounds are user-level layout state under UIP-D9: persisted as display id,
DIP rectangle, maximized state, and last scale factor. Open/restore clamps the
header and a usable 1280 × 720 DIP workspace into the selected display work
area (or the largest available area on a smaller display); a missing display
rehomes to primary. Display removal, reattachment, or DPI change reclamps in
DIP and rerenders at the new device scale rather than stretching cached pixels.
**Reset layout** resets Plan bounds too. Renderer reload remounts the committed
Plan root and rehydrates UIP-D10's main-process job mirror; it never adopts an
uncommitted canvas preview (PE-D1).

On first use the project-owned Plan root is created implicitly with Sheet 1,
A3 landscape. The user renames it **Site plan**, chooses A1 landscape, and
types a 10 mm margin. Each completed action is already stored; there is no
dirty flag or independent `.hcplan` Save authority. The Plan File menu and
Ctrl+S expose File's real `project.flush`/status behavior from owner decision
D1 and FP-D2; they do not create a second save model. Drawing a rectangle
previews continuously, then
pointer-up publishes one journaled Plan command. If publication fails, the
preview returns to the last committed scene and the status bar says what
failed. Closing during an unfinished stroke cancels that stroke; it never
commits a half gesture and never loses an already completed action.

The user chooses **Add model viewport**. The source picker lists canonical
view bookmarks. **Use current model view** is a convenience that atomically
captures a named bookmark through the View-domain command and creates the
viewport referencing it; it never embeds an anonymous camera. The chosen
bookmark is a top orthographic view. The user types **1:250**, places a
240 × 160 mm frame, and sees actual project content through the pass-complete
capture in §2.5. At 1:250, 25 m measures 100 mm on paper because the transform
is explicit, not because the preview happens to look right.

`PlanViewportTransform v1` contains: the bookmark's exact orthographic
`origin`, unit `right`, unit `up`, and derived normal in project-world space;
crop center and extents in project units; authoritative
`metersPerProjectUnit` plus project-unit/CRS revision; paper rectangle in mm;
positive scale denominator; and `paperRotationClockwiseDeg`. Paper axes are
`+x` right and `+y` down. For project point `P`, let
`q = (dot(P-cropCenter,right), -dot(P-cropCenter,up))`, rotate `q` by
`[[cosθ,-sinθ],[sinθ,cosθ]]`, and multiply by
`paperMmPerProjectUnit = metersPerProjectUnit * 1000 / denominator` before
translating to the paper-rectangle center. Thus
`paper_mm = project_length * metersPerProjectUnit * 1000 / denominator`.
The Plan scene then uses
`paper_mm * PLAN_SCENE_UNITS_PER_MM`; the existing constant is 4
(`packages/@himmelcad/plan/src/paper.ts:32-34`) and the existing metre helper
implements the same terminal conversion only after project units have become
metres (`paper.ts:109-115`). `paperRotationClockwiseDeg` rotates the complete
view and rectangular mask around the frame center; zero maps bookmark right to
paper +x. There is no ambiguous generic `rotation` field.

Only an orthographic bookmark with an authoritative linear project unit and
working plane may carry `1:n`. Geographic/non-linear coordinates without an
explicit projected working plane, a non-finite/non-orthonormal basis, or a
perspective bookmark produce **Not to scale (NTS)** with the missing prerequisite
named; scale entry and scale-bar insertion are disabled. No local scale factor
or plane is inferred (X1).

The active linked viewport uses a live renderer preview. Other viewports, a
closed window, and weak hardware show the last good cached vector/raster
capture. Selecting the viewport exposes frame X/Y/width/height in paper mm,
model center E/N/Z in project units, **Paper rotation (clockwise)**, scale,
source view, and update
policy. Frame resize and move have typed twins. **Adjust view** arms a local
mode: drag inside pans the model center, wheel selects an exact scale, and the
fields update live; pointer-up/scale selection is one command.

A north-arrow instance is not freely rotated decoration: it binds to
`viewportId` and one authoritative `northReference` (`gridNorth`, `trueNorth`,
or a named project-defined north). The project CRS/settings pipeline supplies
that direction at the viewport crop center; true north also requires its
authoritative meridian convergence. Plan projects the direction into the
bookmarked orthographic basis and applies the same paper rotation matrix,
deriving the arrow's paper angle. If the direction, convergence, project north
definition, or usable projection into the view plane is absent, the editor
shows **Unresolved north: <reason>** and clean export is blocked. Changing
project unit/CRS/north truth marks the viewport and arrow stale; neither Plan
nor the template invents a north direction (PE-D15).

Each viewport follows one state machine (PE-D5). Journaled fields are
`sourceBookmarkId`, `updatePolicy: linked | pinned`, filters/template refs,
transform, and, only when pinned, `pinnedSourceTuple` plus verified artifact
hashes. Derived state is `lastResolvedSource`, `lastGoodArtifacts`,
`pendingJobId`, and `status: clean | stale | refreshing | error |
sourceMissing`. The source tuple includes project generation, bookmark and
ViewState/schema revisions, relevant entity/attribute/specification/layer,
clip/display/template/project-unit/CRS/north revisions, and renderer/capture-
contract version. Linked means resolve the current revision of the stable
bookmark id. Bookmark rename alone does not stale; recapture or any relevant
tuple change does.

The frame always identifies the last-good source revision/time and, when stale
or refreshing, the pending target revision. Linked viewports debounce and
coalesce to queue depth one. Cancel/failure leaves last good visible. Successful
linked refresh atomically publishes a verified derived-cache lookup and adds no
Ctrl+Z step. A completion for a superseded tuple, restored snapshot, or invalid
project generation is discarded before publication. **Pin** is one journaled
command that freezes the full tuple and verified hashes; **Unpin** removes only
the current-root edge and immediately re-evaluates linked staleness. Source
deletion keeps the last good picture with **Source missing**, disables Refresh,
and offers **Relink** and **Remove**; no bookmark is matched by name or invented.

### 2.2 Create a layer-filtered viewport

The same sheet needs a 1:100 detail with Survey and Existing, but without
Design or Annotations. The user duplicates the first viewport, types 1:100,
and selects it. The Layers rail now lists the real canonical project layers,
not the current `MOCK_LAYERS`. Unchecking Design and Annotations changes only
this viewport's include/exclude filter, marks it stale, and refreshes it. The
1:250 viewport is unchanged. With no viewport selected, the rail shows the
concise existing empty state and a **Manage model layers…** link that focuses
Draw's layer manager; Plan never creates, renames, locks, or reorders layers.

Effective content is current live entities ∩ the referenced model view's
VD-D3 visibility/clip boundary ∩ the viewport's layer/rule filters. A filter
cannot resurrect a deleted entity or bypass canonical hidden/class-hidden
state. New entities that match the filter enter on refresh. A deleted layer
reference is shown as **Missing layer**, never silently reinterpreted as
unfiltered. An include filter containing only missing layers produces an empty
viewport with a warning, not all content.

For office consistency the user saves the selected viewport settings as
**Existing works 1:100**. A Plan view template uses VD-D13 field names and
stores scale/update policy, presentation overrides, layer filters, rule-filter
references, and an `includedFields` mask. It never duplicates camera,
`clipRefs`, or canonical visibility; those come from the bookmark. **Apply**
copies included values once. **Assign** keeps included fields locked to the
template until **Unassign**. Rule filters select by canonical entity kind,
specification, and typed attribute predicates, then hide or apply graphical
overrides above BS-D12/PC-D11 resolved per-entity display. They never edit the
entities or their styles.

The selected linked orthographic viewport also exposes **Model dimension…**.
This is a visible Plan-window access path to Draw's existing
`draw.dimension.create/edit`, not a Plan command or paper measurement type.
While armed, the selected live viewport temporarily accepts Draw's associative
model picks, snap ordering, chain mode, numeric placement offset, and derived
value contract from DR-D9. The finished canonical dimension belongs to the
model and appears in every applicable viewport after refresh; Plan stores no
measurement value. A pinned, perspective/NTS, cached-only, or source-missing
viewport disables the action with **Unpin**, **Relink**, or **Open model view**
as applicable. The safe fallback focuses the main Builder viewport at the
referenced bookmark, runs the same Draw command, and returns focus to Plan after
commit. It never measures capture pixels. Paper arrows and free text are named
**Annotation**, never **Dimension** (PE-D17).

### 2.3 Compose title blocks and place a live schedule

The user inserts the built-in title block. Bound text resolves from real,
versioned sources: project id/name and project metadata; Plan name; sheet
name/number; user display name; an explicitly selected primary viewport's
scale; and schedule name/revision. The binding property shows its source.
Missing required metadata renders **Unresolved: field name** in the editor and
blocks clean export until supplied or explicitly made optional; no mock or
invented value is printed. Editing bound text offers **Override value** or
**Clear binding**. Project metadata changes re-resolve the derived text and
mark the sheet preview stale; the Plan instance stores binding identity and
overrides, not duplicated text as authority.

When BIM schedules exist, **Insert schedule** lists those live schedule ids.
Placement stores the schedule reference, table layout, paper rectangle,
repeated-header choice, and continuation links. It does not redefine fields,
filters, formulae, or edit model cells; those remain `bim.schedule`. A one-row
schedule fits one frame. A 100,000-row schedule is never clipped or silently
truncated: pagination computes real pages, previews the required sheet count,
and asks before adding continuation sheets. Model changes mark the placed
schedule stale; refresh swaps a verified table artifact like a viewport.

Project templates are journaled project data shared by this project's sheets.
User templates live in the versioned user store. On the first upgraded open,
the current localStorage library triggers a one-time **Import / Skip** prompt;
Import previews keep/replace/rename collisions before committing, following
BS-D1's migration pattern. Corrupt data reports recovery choices instead of
the current silent empty-library fallback (`library.ts:53–61`).

### 2.4 Deterministic export

The user presses **Export**. Preflight freezes the Plan journal revision,
canonical project snapshot, referenced bookmark revisions, filter/template
revisions, bound metadata, schedule revisions, and capture hashes. It lists
every sheet and fidelity warning before a destination is chosen. Stale linked
viewports/schedules offer **Refresh frozen snapshot**, **Use last capture with
warnings**, or **Cancel**; clean export defaults to refresh/fail, never silent
stale output. Pinned captures use their exact retained objects. A missing
pinned object is corruption and fails—rebuilding it from a newer model would
change the issued deliverable.

Refresh and export register as cancellable UIP-D10 jobs. Concurrent model
edits after the freeze do not enter the output; the window may become stale
afterward. The existing deterministic SVG/PDF/report pipeline remains the one
writer. Completion closes its hard gaps: PDF draws ellipses and diamonds;
SVG/PDF embed image and viewport-raster bytes rather than bounds; PDF preserves
multiline text; all element rotations apply; supported Plan fonts use bundled
metrics/resources. Remaining advanced roughness/fill/arrowhead differences are
reported per target until their contract changes. PNG remains explicitly
non-deterministic as `docs/PLAN-EDITOR-EXPORT.md` states.

The resulting PDF has exact physical page boxes; SVG sheets declare physical
mm; `*-fidelity.json` records the frozen Plan/project revisions, viewport and
schedule source ids/revisions, filters, pin states, artifact hashes, and every
fallback. Repeating the export from the same frozen object graph produces
byte-identical SVG/PDF/report bytes. **Print** generates that same PDF and
hands it to the OS print dialog with **Print at 100%** copy; automation printing
to a device requires the external-action approval required by ADR 0024.

The agent can perform the complete workflow without opening the window:
`plan.sheet.add` →
`plan.viewport.create(source_bookmark_id, scale=250, rect_mm)` →
`plan.viewport.set_layer_filter` → `plan.template.instantiate` →
`plan.export.describe/run`. Each operation has the same validation, CAS,
staleness, job, grant, approval, and fidelity behavior as its visible UI path;
only the mutation steps are undoable (§1.2).

### 2.5 Pass-complete viewport capture

`PlanCaptureArtifact v1` is an immutable manifest plus content-addressed
resources produced from one exact PE-D5 source tuple and one
`PlanViewportTransform`. It records capture-contract and renderer versions,
ordered compositing partitions, source entity/dataset/revision ids, resolved
BS-D12/PC-D11/VD-D8 presentation, layer/rule/template filters, clips and masks,
output pixel density, paper transform, straight-alpha sRGB output (the kernel
does all geometry/transparency work in linear light before one sRGB transfer,
`crates/himmelcad-render/src/gpu_surface.rs:14-22`), byte lengths, media types,
and SHA-256 hashes. Completion means the manifest and every referenced resource
are present and verified, every applicable pass/entity class has a disposition,
and the manifest is atomically published for the still-current source tuple.

Capture reuses the canonical render world's pass plan, which orders opaque,
points, transparent, section-cap, and overlay work in one color/depth/clip
world (`crates/himmelcad-render/src/frame_graph.rs:7-25,27-76`). It does not
render vectors later as an always-on-top decoration. The existing offscreen
kernel path is a real pass-complete RGBA source—it takes the exact matrix,
floating origin, clips, and mixed batches and returns straight-alpha sRGB
bytes (`gpu_surface.rs:41-69,758-862`)—but it is **not** a vector or hidden-line
extractor. The current Plan exporter is only the deterministic assembly/report
substrate (`packages/@himmelcad/plan/src/export.ts:49-87`): SVG and PDF iterate
paper `sheet.scene.elements` only (`export.ts:120-148,269-335`) and therefore do
not yet consume viewport artifacts. Those capabilities are absent and listed
as New in §5, never implied by the mock adapter.

The repository does have two relevant prepared-source products, but neither is
a Plan vector-export bridge. Exact sections use immutable, residency-independent
source-topology snapshots with revision keys, content hashes, ordered parts,
and material identities
(`crates/himmelcad-render/src/section_topology.rs:1,16-40,89-109,227-374`).
Prepared raster, splat, and extension content uses a shared validated hierarchy
manifest with complete roots and tile descriptors
(`crates/himmelcad-render/src/providers/prepared.rs:21-47,59-80,104-125`).
Plan may consume these verified products; it may not reinterpret a stub,
resident-tile subset, or mock result as complete evidence.

| Source member                                                                                                   | Artifact disposition                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan paper rectangles/ellipses/diamonds/paths/arrows/text and generated schedule grid/text                      | vector when the deterministic writer preserves geometry, rotation, resolved style, font metrics, and clipping; embedded paper images remain raster                                                                                                          |
| Authored model CAD strokes, text, associative labels, and DR-D9 dimensions                                      | vector only after exact clip plus visibility/occlusion classification against every other partition; otherwise the affected compositing partition is raster                                                                                                 |
| Exact section traces and region boundaries                                                                      | vector-eligible only from the kernel's immutable, complete topology product, which carries exact source/plane/tolerance/material identities (`crates/himmelcad-render/src/section.rs:81-92,121-173`); interactive resident-tile edges are never substituted |
| Point clouds and Gaussian splats                                                                                | raster through the canonical point/transparent passes                                                                                                                                                                                                       |
| Source rasters, elevation rasters, and paper/model images                                                       | raster, retaining crop/mask/alpha and color-space metadata                                                                                                                                                                                                  |
| Shaded meshes/surfaces, opaque or transparent triangle/CAD-fill passes, filled 3D/BIM objects, and section caps | raster unless a separately versioned deterministic vector/hidden-line product supplies complete topology, material, clip, and visibility evidence; no such general extractor exists today                                                                   |
| Empty filtered viewport                                                                                         | valid empty transparent partition plus manifest/warning state; never a missing artifact or implicit unfiltered view                                                                                                                                         |

For a vector candidate crossing opaque depth, the producer emits exact clipped
visible spans when the canonical topology/occlusion product can prove them. A
pixel coverage/depth mask may preserve raster occlusion of those spans in SVG
or PDF. If transparency, antialiasing, splat coverage, mixed depth, or pass
ordering cannot be reproduced exactly by ordered vector plus masks, the
smallest connected affected partition is composited by the canonical renderer
and stored as raster. Preflight and `*-fidelity.json` name each raster fallback
with source kinds and reason. Thus a CAD line behind a wall/cloud/raster never
moves in front merely because it was vector-eligible. PDF/SVG embed partitions
in manifest order with their clip/soft masks; screen preview pixels are never
the export source (PE-D7).

### 2.6 `.hcplan` v3 portable exchange package

`.hcplan` v3 is a streaming ZIP64 package using the already-inventoried `zip`
runtime, not an in-memory JSON blob or a new dependency. It starts with ZIP
magic `50 4b 03 04`; the first uncompressed entry is exactly `mimetype` with
`application/vnd.himmelcad.plan+zip`, followed by `manifest.json`. The manifest
declares `format: himmelcad.plan-package`, `formatVersion: 3`, source project id,
Plan root/schema/hash, and an inventory of every portable reachable object with
lowercase SHA-256, byte length, media type, and category. Remaining entries are
only `objects/<64-lowercase-hex>`. Paths must be normalized UTF-8 forward-slash
paths; absolute paths, `..`, backslashes, duplicate/case-colliding names,
symlinks, devices, undeclared entries, and external paths are rejected.

Export freezes the source Plan root, computes portable reachability (sheet
scenes, template bodies, embedded images/fonts allowed by PE-D18, schedule and
viewport artifacts, and pinned captures), previews bytes by category, streams
each object once, verifies its hash, and publishes through sibling-candidate
atomic replacement. Import parses legacy v1/v2 JSON only through explicit
migrations. For v3 it validates the central inventory before extraction,
stages and hashes bounded streams, resolves sheet/template/id collisions with
keep/replace/new-id mappings, and commits one Plan-root replacement last.
Foreign bookmark ids are materialized/imported through `bookmark.capture` with
an explicit old→new identity map or remain **Unresolved source**; name matching
is forbidden. Foreign schedules retain their embedded last-good table artifact
but remain **Source missing** until explicitly relinked.

Initial X6 limits are: 1,000,000 entries, 64 MiB manifest, 16 GiB per object,
128 GiB total declared/expanded bytes, and 200:1 maximum compression ratio.
They are checked before and during streaming; a limit failure explains that
`.hcadx` is the whole-project alternative. Cancel/failure removes only the
operation's staging data and publishes no objects/root. Malicious paths,
duplicate hashes with conflicting metadata, zip-bomb/oversize, missing/hash-
mismatched objects, legacy migration, cross-project identity, and multi-
gigabyte constant-memory streaming are release fixtures (PE-D13).

### 2.7 Snapshot restore, undo, refresh publication, and object reachability

File-project's C4 restore rule is adopted for the full project, not narrowed to
model entities: a snapshot restore returns **every journaled project root** to
the marked generation, including the Plan root and its sheets, viewport
definitions, templates, filters, bindings, schedule placements, pin states,
and pinned hashes. Snapshot entities are the sole journal-state exemption per
FP-D4; view-local Plan selection/camera/focus and runtime job records remain
outside restore because they were never journaled. Restore is one compensating
command and restore-then-undo returns the pre-restore Plan root exactly.

Sheet/element/template/filter/binding/schedule edits and pin/unpin are ordinary
journaled commands. Linked `stale`, `pendingJobId`, last-good cache lookup, and
refresh completion are derived: refresh never inserts a user-visible undo step.
Restoring invalidates pending capture generation tokens, restores old pinned
edges exactly, then re-evaluates linked viewports against the restored project.

The protected object-reachability roots are: the current manifest and Plan
root; every journal generation retained inside the undo/redo horizon; every
manual/automatic snapshot's marked generation; every pinned viewport edge in
any such Plan root; all other project/product references; ready transactions;
and active export/print/`.hcplan` leases. A source-missing viewport's persisted
last-good recovery lease remains protected until Relink/Remove. Unpin/removal
removes only the current-root edge. FP-D16 maintenance may collect a capture
only when none of these roots reaches it; linked caches outside protected or
active recovery leases are rebuildable and may be collected. This is the
cross-spec reachability line file-project must adopt (PE-D2/PE-D7).

## 3. Function contract answers by capability group

### 3.1 Window, sheet, composition, and project storage

**A1.** §2.1 from File launch through stored sheet composition. **A2.** Named,
rotated plan frames, decoration, fixed-scale print, and linked model content
are adopted from `rib-civil.md` §2.9/W7/§1 with the dispositions in §1.1.
**A3.** The surface follows D2, not the current Plan island. Finite paper,
selection/transform/snap/align, and host actions stay from
`packages/excalidraw-plan/HCAD_FORK.md` §Intent/§Maintained changes. Shared
journal undo follows file-project FP-D11; Plan does not gain a second stack.
The fork audit/host-history seam is PE-D18.

**B1.** File ribbon, `plan.window.*`, and all §1 `plan.sheet/element.*` paths;
no entity context menu because D4 says Plan records are not canonical model
entities. No main-viewport quick entry: composition is not meaningful over
model-space void. Plan-local shortcuts are active only while its window has
focus. **B2.** File launch focuses/toggles, title-bar x closes, and app/project
close follows the explicit §2.1 lifecycle. Plan-window close cancels only the
innermost unfinished preview and backgrounds jobs; project switch/quit adopts
file-project's one-prompt Wait/Cancel rule. Completed actions are already
durable. Escape never closes the OS window.
**B3.** Dedicated resizable window: sheet canvas, independent selection,
libraries, filters, pagination, and preflight outgrow a panel or island, exactly
the FUNCTION-CONTRACT B3 dedicated-window class.

**C1.** Paper size/margins and every selected element's paper X/Y/width/height/
rotation are typeable and synchronized with handles; units are mm. **C2.** Plan
selection is window-local. Mixed multi-selection follows UIP-D17; switching
sheets clears selection, while external Plan commits prune deleted ids and
preserve valid ids. **C3.** A whole sheet is not lockable: viewport pin and
template assignment exploit the expensive/useful invariants; locking ordinary
paper strokes would add no precompute. **C4.** Small Plan product records and
root changes are journaled and are inside snapshot restore scope (§2.7). Sheet
scenes, image/file payloads, and retained captures are immutable content-
addressed objects. Each completed Excalidraw action is one journal command;
gesture previews, canvas camera, selection, and focused rail tab are view-local.
Ctrl+Z appends the canonical compensating transaction. The fork may group a
gesture, but PE-D18 prevents its local History from acting as a second undo
authority.

**D1.** Canvas pan/zoom, handle drag, free draw, and text placement are
continuous and gated by G-PE-CANVAS. Commits/sheet operations are bounded
(<1 s, inline busy only when perceptible). **D2.** Cached viewport previews
replace live previews first, then preview raster resolution drops; active-sheet
input and committed geometry never degrade. **E1.** Criteria 1–3 and 8.
**E2.** One Plan window per active project generation, with bounds, DPI,
focus/minimize, crash/remount, close, and late-result rules in §2.1. Plan writes
serialize through the journal; an external same-root write during an active
gesture receives typed `PlanBusy` and retries rather than cancelling user
input. Project replacement waits or cancels through file-project's E2 owner
lifecycle before invalidation. Least typical member: blank A4 with one text
label; largest: 500 custom 2000 mm sheets—only the active sheet mounts, sheet
rail virtualizes, and commands touch one sheet object. **E3.** G-PE-UNIT,
G-PE-STORE, G-PE-CANVAS-UI, G-PE-ELECTRON, and G-PE-CANVAS (§6).

### 3.2 Templates, bindings, libraries, and schedule placement

**A1.** §2.3. **A2.** RIB plan heads/decorations are adopted
(`rib-civil.md` §2.9/W7); Revit live sheet schedules are adopted only at the
placement boundary (`revit.md` §2.8/W6); authoring stays BS-D14. **A3.** BS-D1
supplies the migration behavior; BS-D12 supplies resolved presentation; the
Plan side satisfies BS-D14's sheet-placement dependency. View/template records
here do not alter BIM definitions.

**B1.** Library, canvas/context insertion, console, and automation paths in §1.
There is no model-viewport quick entry: templates/schedules require paper
context. **B2.** Pickers close by x/Escape/menu choice; closing discards an
uncommitted binding edit. Long refresh/migration jobs survive window close in
UIP-D10 and remain cancellable. **B3.** Library rail + properties for recurring
placement; collision/pagination preview is a focused modal inside the dedicated
window.

**C1.** Template anchor X/Y and schedule rectangle/column widths/repeat-header
count are drag/type twins in paper units. **C2.** Save-to-library captures the
explicit Plan selection at commit; changing selection before commit updates the
count. A placed schedule references one BIM schedule; multi-select properties
show shared/mixed values. **C3.** Assigned view-template fields are frozen by
invariant; schedule/table artifacts are cached by schedule revision. Ordinary
template instances stay editable. **C4.** Project library, instances, bindings,
overrides, and schedule placements are journaled. User library is a versioned,
automation-visible user store, excluded from project Ctrl+Z; save/remove shows
an immediate reversible Undo action in that store. Bound rendering is derived;
binding identity and explicit override are authority.

**D1.** Normal insertion/rebinding is bounded. Large library import and schedule
pagination are long UIP-D10 jobs. **D2.** Off-screen schedule previews virtualize
rows; output pagination never drops them. **E1.** Criteria 6 and 7. **E2.**
Consumers: Plan preview/export/print, metadata query, BIM schedule query,
project/user libraries, `.hcadx`, `.hcplan` exchange, and automation. Metadata
or schedule revision marks dependants stale. Missing required metadata blocks
clean export; a removed schedule keeps its last capture with **Source missing**
and cannot refresh. Extreme template: a static logo with no fields versus a
north arrow bound to a viewport/north reference and a title block with every
namespace; extreme schedule: one row versus 100,000 rows with continuations.
**E3.** G-PE-UNIT, G-PE-CANVAS-UI, G-PE-REAL-EXPORT, automation.sdk.

### 3.3 Model viewports, filters, and view templates

**A1.** §§2.1–2.2. **A2.** RIB's linked plan/model trait and named rotated
frames are adopted (`rib-civil.md` §1, §2.9, W7). Revit rule filters and
apply-vs-assign view templates are adopted (`revit.md` §2.6/W5/§5).
**A3.** A viewport references a VD-D3 bookmark and consumes VD-D13 ViewState v2;
it never re-dispositions or copies their schema. It consumes PC-D11 and BS-D12
display below its view filters. Plan adopts DR-D9 for model dimensions and RA-D2
for raster georeferencing. The registry, BS-D15, VD-D12, UIP-D9/UIP-D14,
Draw access-path, and file-project restore/GC records now cite these owning
Plan decisions (§8). The sole remaining draft reason is the architect-owned
`PLAN-EDITOR-EXPORT.md` proposal; this spec does not re-disposition owned acts.

**B1.** Canvas/properties/Layers/template UI plus console and the automation
families in §1. **Model dimension…** is a Plan-window accelerator to Draw's
command, not a `plan.*` operation. No main entity context menu. **B2.** Adjust
mode ends via Done, Escape tool rung, switching selection, or window close;
unfinished changes revert. Refresh continues as a platform job if its surface
closes. **B3.**
Canvas + properties are required: users see sheet fit while typing exact scale.

**C1.** Frame, crop center/extents, `paperRotationClockwiseDeg`, and scale are
drag/type twins under `PlanViewportTransform v1` (§2.1). Exact scale is
orthographic/linear-working-plane only; perspective or unresolved unit/plane is
NTS. North angle is derived/read-only, never dragged or typed as a decorative
override. **C2.** Filters/properties target the
selected viewport(s); mixed state follows UIP-D17. Model-window selection is
never consumed except while the explicit Draw-owned Model dimension tool is
armed. **C3.** Pin retains exact immutable captures and removes journal
watch/render work. Template assignment locks included fields and avoids
re-resolving them per edit. **C4.** The journal/derived split, snapshot restore
scope, async-refresh publication rule, and complete object-reachability roots
are §2.7. In particular, linked refresh is not an undo step; Pin/Unpin are, and
unpin/removal cannot collect an object an older undo generation or snapshot
still reaches. Bookmark edits are View-domain commands and merely stale Plan.

**D1.** Live preview navigation is continuous (G-PE-CANVAS). Refresh is long and
cancellable. Its extreme member is the prepared 500M-point mixed capture in
G-PE-CAPTURE-500M: enqueue blocks neither window for >50 ms; job row and first
real phase arrive within 250 ms; cancel acknowledgement ≤250 ms and terminal
no-publication ≤2 s outside the short atomic swap; warm full-resolution p95
≤10 s on interaction tier and ≤30 s on weak tier; peak additional resident
memory ≤2 GiB and transient disk ≤4 GiB beyond retained artifacts. These are
initial X6 tunables, not aspirations. Progress reports measured point nodes,
tiles/passes, raster tiles, vector primitives, bytes, elapsed time, peak memory,
cache state, and cancellation checkpoints; when no total exists it reports
units without a fabricated percentage. Completion is the verified atomic
manifest publication defined in §2.5 for the still-current source tuple.
**D2.** Governor switches non-selected viewports to cached images,
then reduces preview-only raster density; export capture resolution, scale,
filter correctness, and input latency never degrade. **E1.** Criteria 2, 4, 5.
**E2.** Consumer/effect matrix:

| Consumer                             | Required effect                                                                                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model renderer/capture adapter       | Reads the exact PE-D5 source tuple and PE-D15 transform; emits PE-D7 ordered partitions using the canonical frame graph, never a vector-above-raster shortcut.                                      |
| CAD curve/text/dimension             | Vector only with resolved style, clip, and proven occlusion; Draw remains the dimension owner and Plan pixel capture is never a measurement source.                                                 |
| BIM/mesh/filled CAD/section          | Resolved BS-D12 style enters canonical opaque/transparent/cap passes; only authoritative section products may supply exact vector traces; otherwise raster.                                         |
| Raster/point/splat passes            | Raster partitions preserve masks, color/alpha, transparency, and shared depth; PC-D11 remains the canonical display owner.                                                                          |
| Clips/visibility                     | Use bookmark `clipRefs` and VD-D3 canonical-visibility snapshot; missing refs warn as VD-D3 specifies and never widen scope silently.                                                               |
| Layer/rule/spec/attribute indexes    | Determine the effective set and enter the source tuple; a relevant membership/predicate/template change stales, while a bookmark rename does not. Missing include-only layers produce empty output. |
| Project unit/CRS/north               | Supply authoritative scale and north truth; changes stale; unresolved truth forces NTS or Unresolved north and blocks clean output.                                                                 |
| Picking/selection                    | Normally picks frame/paper elements only; explicit Model dimension mode temporarily routes semantic picks to Draw under §2.2/§3 gesture rules.                                                      |
| Title blocks/scale bars/north arrows | Read validated primary-viewport transform and bindings; perspective/unresolved views never claim scale or north.                                                                                    |
| Export/print                         | Consume verified full-resolution artifact partitions in manifest order, never screen-preview pixels; fidelity report lists every fallback.                                                          |
| Restore/undo/maintenance             | Restore reinstates Plan roots/pinned hashes; late jobs cannot publish; FP-D16 protects every §2.7 reachability root.                                                                                |
| Main Builder view                    | Unchanged except the explicit, focus-bounded Draw dimension fallback; Plan filters/camera/refresh never mutate it.                                                                                  |
| Automation                           | `plan.viewport.list` reports source tuple, last-good/pending revisions, pin/status/artifacts; grant/result semantics are §1.2.                                                                      |

Refreshes for one viewport coalesce to the latest relevant revision (queue
depth ≤1); a superseded result is never published. Export may read a frozen
snapshot concurrently. Same external-target writes reject/serialize. Extreme
viewport: empty include filter versus a billion-point cloud plus splat,
raster, transparent mesh, CAD curve/text/dimension, BIM solid, and exact
section product with deliberate overlap. Extreme source: top orthographic with
exact scale/north versus perspective NTS and source-missing. **E3.** G-PE-UNIT,
G-PE-CANVAS, G-PE-CAPTURE-500M, G-PE-REAL-EXPORT, automation.sdk.

Gesture reconciliation against ui-platform §3.6 (all claims are confined to
the Plan canvas, so the main Builder viewport retains its meanings):

| Input                | Plan canvas idle                                                                          | Adjust-view armed                         | Model dimension armed in selected viewport              | Reconciliation                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| LMB click / Ctrl+LMB | select / toggle paper elements                                                            | set focus; no model selection             | construction/snap pick; selection suspended             | Draw DR-D14 owns the explicit tool claim; no capture-pixel pick                  |
| LMB double-click     | edit text or enter viewport adjustment; void clears local selection                       | finish current inline edit                | unclaimed                                               | main map reserve remains free while dimensioning                                 |
| LMB drag             | transform handle/tool gesture; void drag pans the infinite canvas without changing sheets | inside frame pans model center            | navigation after threshold; no anchor                   | Draw's click-vs-drag boundary is retained; placement offset has numeric twin     |
| RMB click / drag     | Plan context menu / pan                                                                   | tool menu / pan                           | Draw tool menu / pan                                    | UIP-D5 routes click to armed owner; drag stays platform pan                      |
| MMB drag / wheel     | pan / zoom paper                                                                          | pan paper / exact scale step inside frame | pan / zoom live model viewport                          | wheel deviation exists only in Adjust view; Draw navigation stays platform-owned |
| Tab / Shift+Tab      | traverse Plan controls                                                                    | traverse adjust fields                    | focus/traverse the Draw construction bar                | never cycles candidates; Up/Down cycles a live candidate list                    |
| Enter / Backspace    | focused editor meaning                                                                    | commit field / editor meaning             | finish chain / remove last anchor when viewport-focused | exactly Draw's established tool semantics                                        |
| Escape               | field revert → drag revert → menu/tool → local selection                                  | revert field/drag → exit adjust           | revert field/drag → cancel current construction rung    | same UIP-D14 inner order; never closes dedicated window                          |
| Typing               | focused field/text tool; window-local shortcuts                                           | numeric entry wins focus                  | auto-focus Draw numeric bar                             | armed numeric/text entry wins focus                                              |
| Touch                | tap/toggle, hold menu, drag handles/paper                                                 | drag center; pinch paper zoom             | pointer-equivalent construction picks/navigation        | confined surface equivalents; no cross-window claim                              |

### 3.4 Exchange, export, and print

**A1.** §§2.4–2.6. **A2.** Scale-true PDF and fixed-scale printing are adopted
from `rib-civil.md` §2.9/W7/§2.10. **A3.** File-project FP-D5 supplies the
preflight disclosure pattern and UIP-D10 owns jobs. `io.export.plan` in the File
spec describes canonical model export; `plan.export.*` writes composed sheets,
so the acts do not duplicate.

**B1.** Plan Output/File menus, console, and automation in §1. `.hcplan` is
Import/Export copy, never Save/Open authority. Read/write/path/publication and
device approvals are distinct as §1.2 requires; `describe` is path-free and
headless work never requires `plan.window.open`.
**B2.** Preflight closes/cancels freely; job cancel publishes no partial target.
Window close does not cancel background export. **B3.** Preflight modal in the
Plan window followed by global job surface; OS dialogs remain OS-owned.

**C1.** Paper, scale, DPI for PNG, sheet range, copies, and print scaling are
typed; no meaningful drag equivalent exists for output setup. **C2.** Export
uses explicit sheet range, never canvas selection. **C3.** Frozen export graph
and pinned captures make repeatable output; there is no separate output lock.
**C4.** Export/print do not mutate Plan state except optional named presets
owned by File; `.hcplan` v3 follows the bounded package contract in §2.6 and
import commits one validated root replacement as one undo step. Import preview
names sheets/templates/source identity mappings affected. Export/print leases
are reachability roots under §2.7 until terminal publication/cancel.

**D1.** Describe is bounded; capture uses the explicit §3.3 budgets; export,
image embedding, streaming `.hcplan` import, and print are long UIP-D10 jobs
with real sheet/object/byte phases and cancellation. **D2.**
Preview thumbnails may degrade; output fidelity never does. **E1.** Criteria 4,
7, and 8. **E2.** Frozen objects are read-only; missing/hash-mismatched objects
fail before external publication. External targets use sibling-candidate atomic
replacement per PROJECT-FORMAT; package paths/limits/collisions are §2.6.
Largest member is 500 sheets with multi-gigabyte pinned captures/full-resolution
images; it streams one object and one rendered sheet at a time. Least is one
rectangle: no fake progress. PDF ellipses/diamonds/images/capture partitions are
required; remaining limitations stay in the report. **E3.** G-PE-UNIT,
G-PE-PACKAGE, G-PE-REAL-EXPORT, automation.sdk, G-PE-LICENSE, and physical print
check (§6).

## 4. Decision records

**PE-D1 — A true dedicated Plan window.**
**Decision:** Electron main owns one dedicated resizable Plan `BrowserWindow`
and project-generation lease. §2.1 defines focus/minimize, tokenized title
chrome, DIP/display bounds, reset, monitor/DPI recovery, renderer remount, job
rehydration, and project-close behavior. Plan x/File toggle closes only the
window and backgrounds jobs; Escape never closes it. Project switch/quit uses
file-project's one-prompt Wait/Cancel lifecycle and invalidates the generation
before any late completion may publish.
**Derivation:** owner decision D2 explicitly says Plan is a File-launched
window; FUNCTION-CONTRACT B3 names plan composition as the dedicated-window
class; DESIGN-SYSTEM complete-flow rules; UIP-D9 owns window-layout persistence,
UIP-D10 owns job rehydration, and file-project E2 owns project close. UIP-D14's
safety outcome is retained, but its literal “Plan island” member needs
cite-and-revise.
**Rejected:** enlarge `FloatingTaskIsland` (not a dedicated window and already
outgrown by the workflow); renderer-owned window/job state (crash or reload
orphans leases); unconditional project-close cancellation (contradicts the
file-project owner lifecycle).
**Tunable:** yes — default/minimum size and clamp margin only (X6).

**PE-D2 — Journaled Plan root over immutable objects, no paper entities.**
**Decision:** each project has one versioned Plan product-data root. Commands
journal root/small-record changes; sheet scenes, files/images, template bodies,
and captures are immutable content-addressed objects. Snapshot restore includes
this root and all its sheet/viewport/pin state; protected object reachability is
the exact graph in §2.7. No Plan paper element is a canonical model entity.
**Derivation:** D4; X3/P1; PROJECT-FORMAT Product data, Immutable object store,
Canonical journal, and “never keep the only copy ... in a renderer”; ADR 0019;
FUNCTION-CONTRACT C4; file-project FP-D4/FP-D16.
**Rejected:** a mutable `.hcplan` file beside the store (second authority);
canonical paper entities (D4 rejects the domain); renderer-local autosave.
**Tunable:** yes — object compaction/cache retention cadence, never durability,
restore scope, or protected reachability (X6).

**PE-D3 — One completed canvas act is one canonical command.**
**Decision:** pointer-up/tool finish/text commit publishes the new active-sheet
scene object and one journal entry; previews are local. Ctrl+Z/redo use the
shared journal. Linked capture completion is a derived cache publication and
adds no undo step; Pin/Unpin do. PE-D18 disables/reroutes Excalidraw History so
it cannot become an independent authority.
**Derivation:** X3/X5; FP-D11 shared undo; PROJECT-FORMAT one active command
authority; `packages/excalidraw-plan/HCAD_FORK.md` keeps Excalidraw
interactions, not persistence authority.
**Rejected:** a time debounce (admits crash loss); journaling pointer-move
frames; two undo histories.
**Tunable:** yes — scene-object compaction/chunking, not commit or undo boundary.

**PE-D4 — Viewports reference canonical bookmarks; exact scale is ortho-only.**
**Decision:** every viewport stores stable `sourceBookmarkId`; linked mode
resolves its current revision while pinned mode stores the complete frozen
source tuple and artifact hashes. “Current view” atomically materializes a
canonical bookmark. Camera/presentation/visibility/clip meaning is
VD-D3/VD-D13; PE-D5 defines resolution state and PE-D15 defines scale/north.
Perspective is NTS.
**Derivation:** X3/P1; VD-D3 capture boundary; VD-D13 ViewState v2; X1 forbids
claiming a single scale under perspective.
**Rejected:** embedded anonymous view state (automation-invisible duplicate);
camera-only copy; perspective `1:n` label.
**Tunable:** yes — default generated bookmark name only.

**PE-D5 — Linked live preview, explicit stale state, pin for issued content.**
**Decision:** §2.1's single state machine separates stable bookmark identity,
last-resolved tuple, last-good artifacts, pending job, derived status, and
pinned tuple. Linked follows the current bookmark revision and watches every
named dependency; Pin journals the exact full tuple/hashes and stops watching.
Source deletion becomes explicit `sourceMissing`, retains last good, and never
rebinds by name. Superseded/restored/old-generation completions cannot publish.
**Derivation:** X4 (`rib-civil.md` §1 linked-model trait); X2/P2 freeze payoff;
X5 link/pin and stale/refresh symmetry; X1 honest deliverables.
**Rejected:** manual-refresh-only default; silent auto-swap with no badge;
always-live rendering for every sheet.
**Tunable:** yes — refresh debounce and preview resolution (X6).

**PE-D6 — Plan owns view rules/templates above existing display owners.**
**Decision:** per-viewport layer/rule filters and apply/assign view templates
live in Plan product data. They reference VD-D13 presentation fields and layer
above PC-D11/BS-D12; they never modify canonical entity style. Templates exclude
camera, clips, and visibility, which remain bookmark-owned.
**Derivation:** registry §5.3 obligation; Revit dossier §2.6/W5/§5; BS-D12;
VD-D3/VD-D13; program cite-and-revise rule.
**Rejected:** re-style entities to obtain a sheet view; duplicate ViewState;
layer-only completion (would silently prune BS-D15's rule-filter row).
**Tunable:** yes — predicate UI limits and override palette, not ownership.

**PE-D7 — Vector + raster captures are immutable and pass-complete.**
**Decision:** `PlanCaptureArtifact v1` and its per-source disposition in §2.5
are binding. The canonical frame graph performs all depth/clip/transparency
work; a vector candidate survives only with exact style, clipping, ordering,
and occlusion evidence. Otherwise the smallest affected compositing partition
is rasterized. SVG/PDF consume the ordered manifest, masks, and bytes and the
fidelity report names every fallback. Unpinned linked captures are derived
caches; pinned and source-missing recovery artifacts obey §2.7 reachability.
**Derivation:** X1 (a line brought in front by format splitting is a false
deliverable); X2; PC-D11 and BS-D12 Plan-consumer obligations; PROJECT-FORMAT
object rules; canonical frame graph
(`crates/himmelcad-render/src/frame_graph.rs:7-76`); authoritative section
topology/product (`crates/himmelcad-render/src/section_topology.rs:16-40,227-374`;
`crates/himmelcad-render/src/section.rs:121-173`); validated prepared raster/
splat hierarchy (`crates/himmelcad-render/src/providers/prepared.rs:21-80`);
deterministic export substrate
(`packages/@himmelcad/plan/src/export.ts:49-87`).
**Rejected:** mock/placeholder; raster-only (loses vector scale); vector-only
(drops massive/raster passes); vector-over-raster ordering (breaks occlusion);
screen screenshot as export source.
**Tunable:** yes — preview/export raster density and mask tile size, never pass
membership or fidelity disclosure (X6).

**PE-D8 — Library scope survives without localStorage.**
**Decision:** project templates are journaled project product data; user
templates are versioned user-store data with automation parity. Existing
localStorage imports once via prompt and collision preview; corruption is
reported.
**Derivation:** X3/X7; BS-D1 migration pattern; PROJECT-FORMAT safety invariant;
UIP-D9 user storage class.
**Rejected:** localStorage bridge (two stores and silent reset); removing either
scope (current UI demonstrates distinct intent).
**Tunable:** yes — user-library retention count, never silent pruning.

**PE-D9 — Bindings resolve live from versioned sources.**
**Decision:** template instances store binding ids/requiredness/overrides;
derived text resolves at preview/export from exact project/Plan/sheet/user/
viewport/schedule revisions. Missing required fields are visible and block
clean export.
**Derivation:** X1; DESIGN-SYSTEM UI-copy rule; RIB W7 plan-head workflow;
existing typed binding seam (`templates.ts:10–94`).
**Rejected:** resolve once at insertion; mock/fallback values presented as true;
silently overwrite an explicit override.
**Tunable:** yes — optional-field placeholder copy only.

**PE-D10 — Plan places live schedules but does not own them.**
**Decision:** placement references BIM schedule identity/revision and owns only
paper layout/pagination/continuations. No row truncation; repagination is a job.
**Derivation:** registry §5.3; BS-D14's explicit dependency; Revit dossier
§2.8/W6; X1.
**Rejected:** duplicate schedule definition in Plan; flatten-on-place; clipped
overflow.
**Tunable:** yes — default rows per continuation and header repetition (X6).

**PE-D11 — Deterministic output closes omission gaps but keeps the report.**
**Decision:** PDF adds ellipse/diamond, multiline, rotation, bundled-font
handling; SVG/PDF embed actual images/capture resources. Export freezes exact
objects and retains `*-fidelity.json`; PNG stays declared non-deterministic.
Only PE-D18's audited output-font allow-list may be embedded/subset; an
unapproved font blocks clean deterministic output rather than substituting.
**Derivation:** X1; X5 SVG/PDF parity; `docs/PLAN-EDITOR-EXPORT.md` current
boundaries and update-together rule; existing deterministic writer.
**Rejected:** silently omit; rasterize all PDF content; remove report after the
named gaps close.
**Tunable:** yes — PNG DPI and advanced-style support order (X6).

**PE-D12 — Print is the deterministic PDF consumer.**
**Decision:** UI print hands the PE-D11 PDF to the OS dialog; automation printing
requires approval. It never prints the browser canvas.
**Derivation:** X1 scale truth; X4 (`rib-civil.md` §2.9/W7); DESIGN-SYSTEM
OS-owned surface allowance; ADR 0024 external-action boundary.
**Rejected:** `window.print`; parallel print renderer.
**Tunable:** yes — default copies/range only.

**PE-D13 — `.hcplan` is exchange, never authority.**
**Decision:** §2.6 defines `.hcplan` v3 as a bounded streaming ZIP64 package
with fixed mimetype/versioned manifest, `objects/<sha256>` inventory, safe
paths, hashes/lengths/media types, portable reachability, explicit foreign-id
mapping, legacy v1/v2 migration, and atomic staged import/export. SVG/PDF/PNG
never round-trip.
**Derivation:** D4; D1 journal-implicit persistence; §2.6 supersedes the obsolete
authority sentence in PLAN-EDITOR-EXPORT while retaining that document's
delivery/non-round-trip boundary; PROJECT-FORMAT migration/transaction rules.
**Rejected:** Open/Save dirty-file lifecycle; multi-gigabyte JSON; trusted
external paths; name-based bookmark rebinding; import directly into renderer;
delivery-format round-trip.
**Tunable:** yes — entry/manifest/object/expanded-byte/compression limits in
§2.6 (X6), never path/hash/reference validation.

**PE-D14 — Concurrency is snapshot-read, serialized-write.**
**Decision:** Plan commands serialize by root revision. Captures coalesce;
exports read frozen snapshots concurrently; same external target writes
serialize/reject. Plan-window close backgrounds jobs. Project switch/app quit
inherits file-project's one-prompt Wait/Cancel rule; generation invalidation
rejects all late publication. Snapshot restore invalidates/coalesces capture
jobs as §2.7 defines. Failures publish no partial root, capture, or target.
**Derivation:** SYSTEM-001; PROJECT-FORMAT transactional publication and
multi-writer safety; DESIGN-SYSTEM complete flows; X1.
**Rejected:** last-write-wins; window-wide project lock; export from moving
state.
**Tunable:** yes — busy retry/backoff thresholds (X6).

**PE-D15 — One exact viewport transform and derived north truth.**
**Decision:** `PlanViewportTransform v1` and its formula/sign conventions are
defined in §2.1. `1:n` requires an orthographic bookmark, authoritative linear
project-unit factor, and explicit working plane; all other cases are NTS. A
north arrow binds a viewport and authoritative north reference and derives its
paper angle through the same bookmarked basis/rotation; unresolved truth is
visible and blocks clean output.
**Derivation:** X1; PROJECT-FORMAT safety invariant “Never silently transform
coordinates or units”; file-project FP-D10 project-setting ownership; VD-D3 and
VD-D13 bookmark capture; RIB Civil W7's rotated-plan/north-arrow workflow;
existing Plan paper conversion seams (`packages/@himmelcad/plan/src/paper.ts:32-34,109-115`).
**Rejected:** metre-assuming helper applied directly to project values; generic
rotation; perspective `1:n`; static/free-rotation north artwork; inferred CRS,
working plane, unit, or convergence.
**Tunable:** no — scale and direction truth are correctness properties.

**PE-D16 — Automation exposes typed operation classes and least privilege.**
**Decision:** §1.2 is the grant/result contract. Queries, canonical commands,
UI-session actions, jobs, approved file publication, and approved device print
are distinct. Every Plan mutation uses project-generation + revision CAS;
refresh returns a job and is not undo; headless work never opens a window.
**Derivation:** ADR 0024; X1 (no capability inheritance or unreviewed external
publication); X3 (UI/SDK/agent share validation and canonical commands);
FUNCTION-CONTRACT B1.
**Rejected:** treating every catalog verb as a journal command; one broad
project/filesystem capability; implicit UI-session requirement; prompt-hanging
headless print.
**Tunable:** no — grant separation, CAS, and operation classes are security and
data-integrity boundaries.

**PE-D17 — Plan dimensioning is a Draw access path, never pixel annotation.**
**Decision:** selected eligible viewports expose **Model dimension…**, which
invokes Draw's `draw.dimension.create/edit` with associative anchors, chain
mode, semantic snapping, and derived values. The result is a canonical Draw
entity rendered on refresh. Paper arrows/text remain Annotation. Ineligible
viewports explain and offer Unpin/Relink/Open model view.
**Derivation:** X1; X3; X4 RIB W7; registry cite-and-revise rule; Draw DR-D9
(dimension value is derived and never overridable) and Draw's armed gesture
contract.
**Rejected:** Excalidraw arrow plus typed measurement (falsifiable paper truth);
measuring capture pixels; duplicate `plan.dimension` entity/command.
**Tunable:** no.

**PE-D18 — Vendored editor/history/font closure is a hard prerequisite.**
**Decision:** no new dependency is authorized. Before Plan feature
implementation or release, the exact Excalidraw v0.18.0 maintained-source and
lockfile runtime closure, every packaged font file, license, provenance,
attribution, modification, redistribution term, and notice must be inventoried
under DEPENDENCY-POLICY in `LICENSES/THIRD_PARTY.md`; `HCAD_FORK.md` must name
the dedicated-window host and canonical scene/history authority. At this spec
revision **Plan Output Font Set v1 is empty**: a font becomes eligible only when
its exact files/hashes and embedding/subsetting rights appear in that inventory.
Unapproved fonts block clean output; system fallback metrics never claim
determinism.

The current public fork API exposes only History clear and registers internal
undo/redo (`packages/excalidraw-plan/packages/excalidraw/types.ts:762-779`;
`components/App.tsx:714-778`), so the seam is absent. The smallest explicit fork
change adds host-history mode: internal History recording and undo/redo state
mutation are disabled; toolbar/keyboard undo/redo call host callbacks that issue
`document.undo/redo`; canonical scene remounts use non-capturing updates; the
fork may still group an unfinished gesture but never commits/restores authority.
Changed files/date/behavior must be recorded in `HCAD_FORK.md`.
**Derivation:** X1 security/licensing boundary; DEPENDENCY-POLICY required
workflow; PROJECT-FORMAT single command authority; FP-D11; P6; current fork
evidence (`packages/excalidraw-plan/HCAD_FORK.md:28-60`).
**Rejected:** shipping/auditing later; assuming the root MIT notice licenses
font payloads; using Excalidraw undo beside journal undo; silent font
substitution; adding a new PDF/font dependency before audit.
**Tunable:** no — only the post-audit font allow-list may be revised with
evidence; audit and single authority are gates.

**PE-D19 — The 500M capture has measurable completion and resource budgets.**
**Decision:** G-PE-CAPTURE-500M uses a prepared mixed 500M-point project and an
A1 240 × 160 mm viewport at 300 dpi. Initial budgets are §3.3's 50 ms enqueue,
250 ms first progress/cancel acknowledgement, 2 s cancel terminal, 10/30 s warm
p95, 2 GiB additional resident memory, and 4 GiB transient disk. It reports
real units and simultaneously preserves G-PE-CANVAS cadence. Completion is the
verified, pass-complete atomic artifact publication in §2.5, not “render call
returned”.
**Derivation:** X2/P5 (capture stays off interaction path); X6/P3 (agents choose
and calibrate numeric gates); FUNCTION-CONTRACT D1; §2.5 artifact correctness.
**Rejected:** “long and cancellable” without numbers; fabricated progress;
unbounded cache/memory; declaring complete before hash/reference verification.
**Tunable:** yes — every numeric budget above, recalibrated only with committed
gate evidence (X6).

## 5. Current implementation delta

**Keep:** physical paper sizes/validation, the 4 scene-units/mm conversion, and
the metre-to-paper terminal helper (`paper.ts:13-21,32-34,41-60,99-130`);
PlanDocument v2 validation, stable serialization, hash, and
v1 migration (`document.ts:194–259, 393–449`); sheet CRUD (`:262–371`); typed
template/binding seam and eight built-ins (`templates.ts:10–107`); deterministic
bundle/report substrate (`export.ts:6–87`); maintained Excalidraw action/paper/
theme host (`packages/excalidraw-plan/HCAD_FORK.md:40-58`;
`PlanIsland.tsx:107-141,259-287,737-763`); the kernel's pass-complete RGBA
capture, authoritative section topology/products, and prepared hierarchy
validation (`gpu_surface.rs:41-69,758-862`;
`section_topology.rs:16-40,227-374`; `section.rs:121-173`;
`providers/prepared.rs:21-80`);
existing unit and browser smoke tests (`document.test.ts`, `export.test.ts`,
`templates.test.ts`, `paper.test.ts`; `scripts/builder-plan-e2e.mjs:76–140`).

**Change:** Plan island → dedicated Electron window; output ribbon → File launch;
renderer-local Plan/dirtiness and browser Open/Save → journaled project root and
Import/Export copy; Excalidraw History → explicit host-history fork seam over
the shared journal; `PlanDocument` next schema
stores object refs and removes `projectLibrary`/`hiddenLayerIds`; mock adapter,
mock hashes, mock layers, and mock metadata → real queries/captures and the
PE-D5 state machine; library
localStorage → project/user stores; output writers close PE-D11 gaps and use
desktop paths/jobs/print. The deterministic writers must consume viewport
artifact partitions rather than only `sheet.scene.elements`; no general vector/
hidden-line extractor exists today. Current evidence: `PlanIsland.tsx:152–200, 327–351,
391–454, 463–536, 716–724, 798–803, 1060–1105`; `document.ts:108–130`;
`library.ts:31–66`; `export.ts:120-148,269-371`; `gpu_surface.rs:62-69`.

**New:** `plan.*` product-data command/query protocol and generated SDK; Plan
window IPC/lifecycle and layout bridge; `PlanViewportTransform v1` plus
viewport-bound north; canonical bookmark picker/materialization transaction;
`PlanCaptureArtifact v1`, occlusion partitioner/masks, cache/reachability graph;
linked/pinned state machine; rule filters/view templates; Draw dimension access;
live binding resolver; schedule placement/pagination; `.hcplan` v3 streaming
package; preflight, print, and named gates below. PE-D18's inventory and fork
record updates are prerequisites, not post-implementation cleanup.

## 6. Verification plan — named agent-runnable gates

All tiers follow `docs/TEST-TIERS.md`; missing release capabilities fail.

- **G-PE-UNIT — Plan object/output contract** (`pnpm --filter @himmelcad/plan
test`, changed): migrations; object refs/hash validation; metre, millimetre,
  international-foot and non-linear/NTS scale fixtures; large surveyed coordinates;
  0/90-degree paper rotation; crop/mask mapping; grid/true/project-north derivation
  and unresolved-north blocking; scale-bar validation;
  binding required/optional behavior, filter missing-member extremes, pin state,
  schedule pagination, PDF ellipse/diamond/image/multiline/rotation, repeat-byte
  determinism, ordered capture partitions/masks, and report parity.
- **G-PE-STORE — Plan journal/storage integration** (`pnpm --filter
@himmelcad/builder test`, changed/push): command CAS, one-step undo/redo,
  crash replay after every action boundary, object-before-root publication,
  sheet rollback, pinned and linked rollback, restore-then-undo, refresh racing
  restore, GC after pin/unpin with an older snapshot, every §2.7 reachability
  root, localStorage migration choices/collisions, superseded capture discard,
  source-missing recovery lease, and external-write serialization.
- **G-PE-CANVAS-UI — finite-paper/component workflow** (retain/extend
  `pnpm --filter @himmelcad/builder test:plan-ui`, push): all Plan-local gesture
  rows; sheet/element CRUD; real binding states;
  layer and rule filters; apply/assign/unassign; stale/refresh/pin; schedule
  continuation; Model dimension enable/disable/fallback; preflight/cancel.
  Existing headless Chromium smoke proves only local canvas/sheet/
  library/save behavior (`builder-plan-e2e.mjs:76–140`).
- **G-PE-ELECTRON — native Plan-window lifecycle** (new
  `node scripts/test-builder-plan-electron.mjs`, push/release on native Linux
  and Windows): starts built/packaged Builder and asserts one Plan window,
  open/focus/toggle symmetry, Escape non-close, tokenized/accessible title bar,
  committed-state remount and UIP-D10 job rehydration, generation invalidation,
  Wait/Cancel project close, main-window minimize/quit, off-screen repair,
  bounds reset, monitor unplug/replug, display/scale-factor change, renderer
  crash, and Plan already open on another monitor.
- **G-PE-CANVAS — continuous interaction** (new
  `node scripts/benchmark-builder-plan.mjs`, push risk-triggered; release with
  `browser-gpu`): active A1 sheet with three mixed vector/raster viewports;
  paper pan/zoom, element drag, free draw, and viewport adjust each have
  presented-frame-interval p95 ≤ 2× target frame time, not render-body cost;
  zero input drops; cached fallback sampled on weak tier; the same cadence holds
  while G-PE-CAPTURE-500M runs.
- **G-PE-CAPTURE-500M — extreme viewport capture** (new
  `node scripts/benchmark-builder-plan-capture-500m.mjs`, release with
  `browser-gpu` + `real-data`): prepared 500M-point mixed fixture, A1
  240 × 160 mm viewport at 300 dpi; enforces every PE-D19 latency/cancel/
  memory/disk/completion budget and records point-node/tile/pass units, raster
  tiles, vector primitives, bytes, elapsed, cache state, peak resources, and
  cancellation checkpoints. Recalibration requires committed evidence.
- **G-PE-PACKAGE — `.hcplan` v3 safety/streaming** (new
  `node scripts/test-builder-plan-package.mjs`, push/release): fixed first
  entries, version/inventory, bounded constant-memory multi-gigabyte round trip,
  v1/v2 migration, malicious/absolute/traversal/symlink/case-collision paths,
  zip bomb/entry/object/total limits, missing/hash mismatch, foreign bookmark
  identity mapping, schedule source missing, cancel, and atomic replacement.
- **G-PE-REAL-EXPORT — real project/output fidelity** (new
  `node scripts/test-builder-plan-real-export.mjs`, release with `browser-gpu`
  - `real-data`): canonical bookmark → 1:250 viewport → layer/rule filter →
    model edit/stale/refresh → pin → schedule → title block → two identical
    PDF/SVG/report exports; assert excluded layers absent, all renderer classes
    (point, splat, raster, mesh, transparent/opaque BIM, CAD curve/text/DR-D9
    dimension, exact section, empty filtered view) present; deliberate overlap
    proves occlusion and every raster fallback; criteria 4–8; refresh cancel keeps
    prior capture; pinned output stays identical after later model edits.
- **G-PE-LICENSE — vendored runtime/font/notice closure** (new
  `node scripts/verify-builder-plan-runtime-licenses.mjs`, release): exact
  Excalidraw v0.18.0 fork and lockfile closure, changed-file record, font hashes/
  licenses/embedding rights, Plan Output Font Set allow-list, packaged notices,
  absence of unapproved font/runtime files, dedicated-window host wording, and
  host-history mode with no second undo authority. Missing inventory fails.
- **automation.sdk** (existing TEST-TIERS gate, push/release): every §1.2
  operation and class; create sheet → bookmark viewport → refresh → export;
  read/write/path/publication/device grants; CAS success/stale conflict; job
  handle/cancel; revoked project, denied approval, expired path/description
  token, renderer absent, headless `UiUnavailable`, and generated SDK staleness.
- **Manual/visual/physical** (release): screenshots in both themes against §7;
  measure known metre/non-metre segments and a scale bar to ±0.2 mm on the
  1:250 PDF and one 100%-printed sheet; compare 0/90-degree north-arrow fixtures;
  exercise native Linux/Windows dialogs.

Explicitly unverified until implementation: cross-driver raster pixel identity
(reported driver-dependent, not promised); subjective canvas feel beyond
G-PE-CANVAS; printer-driver scaling beyond PDF handoff (physical check).

## 7. E1 visual and behavioral criteria — failable in repository

1. Dedicated Plan window is independently resizable and uses a shared-token,
   accessible title bar; at 1280×720 all three columns remain usable, at 4K
   none grows unbounded. A recorded secondary-monitor position survives focus/
   minimize/reopen; removing that monitor visibly rehomes a usable window.
2. Finite paper, configured margin, selection handles, and arrange controls use
   the maintained fork/theme bridge; no upstream default export/theme chrome.
3. Escape samples prove: numeric field reverts; drag reverts; menu closes;
   adjust tool exits; local selection clears; the Plan window remains open.
4. Metre and non-metre 1:250 orthographic fixtures measure the PE-D15 expected
   paper lengths ±0.2 mm in PDF/SVG at 0° and 90° paper rotation; scale bars
   agree. Grid/true/project-north arrows derive the expected paper angle. Missing
   convergence/north shows **Unresolved north** and blocks clean output; a
   perspective or non-linear/unprojected viewport visibly says NTS and cannot
   host a scale bar.
5. Clean/stale/refreshing/pinned/error/source-missing states have distinct token
   styling and readable text/icon cues in both themes without covering mapped
   content. Stale/refreshing shows last-good revision/time and pending target.
6. Two otherwise identical viewports visibly differ only by the selected layer/
   rule overrides; missing-layer empty output shows its warning in-frame.
7. Bound title block shows real fixture metadata; missing required value is
   visibly Unresolved. A 100,000-row schedule continues without clipped rows.
8. Editor/SVG/PDF comparison fixture contains rectangle, ellipse, diamond,
   rotated multiline text, embedded logo, point cloud, splat, source raster,
   shaded/transparent mesh, CAD curve/text/dimension, BIM solid, and exact
   section with deliberate overlap. No occluded line moves in front; every
   vector/raster/mask partition is present, and every permitted fallback/style
   difference appears in both preflight and fidelity report.
9. **Model dimension…** is visibly enabled only for an eligible linked
   orthographic viewport; its derived value follows a moved anchor after refresh.
   Pinned/NTS/source-missing cases show their remedy, and paper arrows/text are
   visibly labelled Annotation.

## 8. Owner-decision items and cite-and-revise transaction

None. Escalation candidates were dissolved in writing: **island or window?** D2
and B3 decide a dedicated window (PE-D1); **journal or content-addressed?** D4,
X3, PROJECT-FORMAT, and ADR 0019 require the hybrid (PE-D2), not a choice for the
owner; **restore model entities or Plan too?** C4, X3, FP-D4, and project-format
product roots require every journaled root (PE-D2/§2.7); **anonymous snapshot or
canonical view?** X3/P1 plus VD-D3/VD-D13 require the canonical reference
(PE-D4); **live or frozen?** X4's linked-model reference plus X5/P2 yields linked

- pin and the PE-D5 state machine; **which scale/north?** X1 and the no-invented-
  transform invariant derive PE-D15; **vector or raster?** X1 plus the canonical
  frame graph derives conservative pass-complete partitioning (PE-D7); **who owns
  dimensions/filters/schedules?** DR-D9, BS-D12/D14/D15, VD-D12, and the registry
  rule allocate them (PE-D6/PE-D10/PE-D17); **which grants?** ADR 0024 derives
  PE-D16; **how large/fast?** X6/P3 derive PE-D19; **what dependency/font risk is
  acceptable?** X1 and DEPENDENCY-POLICY permit none until audited (PE-D18). No
  axiom conflict, reserved scope, licensing exception, money, or product-identity
  decision survives.

Per the program cite-and-revise rule, Plan stays **drafted** until this external
transaction lands; these are requests to the owning documents, not permission
for this spec to edit them:

| Owner document                                                        | Required cite-and-revise                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGISTRY.md`                                                         | Reconciled 2026-09-02: all 12 rows and operation classes are registered, the pending-domain entry is retired, consistency checks pass, and File `io.export.plan` remains distinct from composed-sheet `plan.export.*`. |
| `file-project.md`                                                     | **Applied:** FP-D4 restores every journaled project root including Plan data; FP-D16 protects the §2.7 reachability graph.                                                                                             |
| `view-domain.md`                                                      | **Applied:** VD-D12 cites PE-D6 for Plan view-template include/exclude/locking and retains bookmark/ViewState ownership in VD-D3/VD-D13.                                                                               |
| `bim-specs.md`                                                        | **Applied:** BS-D15 cites PE-D6 for Plan filters/templates; BS-D14 retains schedule-definition ownership and cites PE-D10 placement.                                                                                   |
| `ui-platform.md`                                                      | **Applied:** UIP-D9 persists dedicated Plan-window state and UIP-D14 preserves Escape non-close under PE-D1.                                                                                                           |
| `draw.md`                                                             | **Applied:** PE-D17 contributes **Model dimension…** as a surface-local path to DR-D9/`draw.dimension.*`.                                                                                                              |
| `docs/PLAN-EDITOR-EXPORT.md`                                          | **Applied at the planning authority:** D4/PE-D13 exchange semantics replace `.hcplan` authority; PE-D7 implementation remains a runtime delta.                                                                         |
| `packages/excalidraw-plan/HCAD_FORK.md` and `LICENSES/THIRD_PARTY.md` | Record dedicated-window host, host-history change/files/date, exact maintained/runtime closure, every font file/license/hash/embedding term, attribution and notices per PE-D18.                                       |

Raster already owns three-point placement in RA-D2/§2.1, so finding 13 needs
no Raster-spec edit; the registry need only cite that existing owner.

## 9. Disposition — adversarial review 2026-09-02

Resolved: **14**. Deferred: **0**. The §8 cross-spec cite-and-revise transaction
landed on 2026-09-02; implementation deltas remain separately identified.

| Finding     | Disposition                                                                                                                                                                                                                                                             | Spec section / decision id                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 (blocker) | Resolved: exact project-unit→paper transform, named clockwise rotation, ortho/NTS boundary, viewport-bound authoritative north, unresolved-output block, and unit/rotation/north gates.                                                                                 | §2.1; §3.3 C1/E2; PE-D15; G-PE-UNIT/REAL-EXPORT; criteria 4           |
| 2 (blocker) | Resolved: Plan product root is in snapshot scope; command-vs-derived refresh split; pin promotion; restore race handling; undo/snapshot/export reachability and GC roots are explicit. File-project FP-D4/FP-D16 now consume the restore and reachability boundary.     | §2.7; §3.1/3.3 C4; PE-D2/D3/D5/D7/D14; FP-D4/FP-D16; G-PE-STORE; §8   |
| 3 (blocker) | Resolved: versioned pass-complete artifact, per-render-class vector/raster disposition, canonical pass order, occlusion/mask fallback, section-product evidence, current stub/absence evidence, and exporter consumption/gates.                                         | §2.5; §3.3 E2; PE-D7; G-PE-CAPTURE-500M/REAL-EXPORT; criterion 8      |
| 4 (blocker) | Resolved reciprocally: every cite-and-revise side is landed without local re-disposition and the clean Registry restores `specified`.                                                                                                                                   | Status; §3.3 A3; §8; cross-spec reconciliation table                  |
| 5 (blocker) | Resolved: no new dependency; exact audit is a pre-implementation/release gate; current output-font allow-list is explicitly empty; unapproved fonts block; smallest host-history fork seam is specified. Inventory/fork-record updates are requested from their owners. | PE-D18; §5; G-PE-LICENSE; §8                                          |
| 6 (major)   | Resolved: extreme 500M fixture has enqueue, first-progress, cancel acknowledgement/terminal, completion p95, memory/disk, real-unit progress, completion definition, and concurrent-canvas budgets, all X6 tunables.                                                    | §3.3 D1; PE-D19; G-PE-CAPTURE-500M                                    |
| 7 (major)   | Resolved reciprocally: main-owned project lease/window, monitor/DPI/bounds/reset, focus/minimize, tokenized chrome, crash/remount, late-publication fence, and File Wait/Cancel close lifecycle; UIP-D9/UIP-D14 and FP-D4 now cite the boundary.                        | §2.1; §3.1 B2/E2; PE-D1/D14; UIP-D9/UIP-D14; FP-D4; G-PE-ELECTRON; §8 |
| 8 (major)   | Resolved: per-operation class/grant/approval matrix, CAS/result envelope, job/cancel behavior, pure describe token, headless UI semantics, and negative-path tests.                                                                                                     | §1.2; PE-D16; automation.sdk                                          |
| 9 (major)   | Resolved reciprocally: visible Plan accelerator invokes Draw's associative, derived-only dimension command; eligibility/remedies and full gesture arbitration are explicit; paper arrows remain Annotation; Draw now cites PE-D17.                                      | §2.2; §3.3 B1/C2/E2 gesture table; PE-D17; DR-D9; criteria 9; §8      |
| 10 (major)  | Resolved: `.hcplan` v3 streaming ZIP64 magic/mimetype/manifest/object layout, bounded path/hash reader, quotas, atomic publication, legacy migration, collision/foreign identity rules, and adversarial fixtures.                                                       | §2.6; §3.4 C4/E2; PE-D13; G-PE-PACKAGE                                |
| 11 (major)  | Resolved: one linked/pinned state machine separates stable source id, last-resolved tuple, last-good artifacts, pending job, status, pinned tuple, complete invalidation set, source deletion, and transition tests.                                                    | §2.1; §3.3 C4/E2; PE-D4/D5/D14; G-PE-UNIT/STORE/CANVAS-UI             |
| 12 (major)  | Resolved: browser component test renamed honestly; real Electron gate covers native window/IPC/project lifecycle on Linux and Windows.                                                                                                                                  | G-PE-CANVAS-UI; G-PE-ELECTRON; PE-D1                                  |
| 13 (minor)  | Resolved: Rasterbilder row split; Plan consumes already-georeferenced/model and paper rasters, while RA-D2 retains three-point fitting ownership.                                                                                                                       | §1.1; §8 (no Raster edit required)                                    |
| 14 (minor)  | Resolved: catalog verbs are classified as query, canonical command, UI action, job, or approved external action; only mutations journal and SDK signatures expose the distinction.                                                                                      | §1 introduction/§1.2; PE-D16                                          |

## Cross-spec reconciliation 2026-09-02

| Item                    | Disposition                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI Platform             | UIP-D9 persists dedicated-window state; UIP-D14 classifies Plan as an OS window with no Escape-close rung (PE-D10).                                                                                                              |
| View/BIM                | VD-D12 and BS-D15 remove template/filter ownership in favor of PE-D6; BS-D14 cites PE-D10 schedule placement.                                                                                                                    |
| File                    | FP-D4 restores sheets/viewports and FP-D16 retains PE-D7 captures.                                                                                                                                                               |
| Draw                    | DR-D9 registers PE-D17 **Model dimension…** access and surface-local gestures.                                                                                                                                                   |
| Normative export        | The planned PLAN-EDITOR-EXPORT authority/exchange changes are present; implementation remains separate and does not block registry status.                                                                                       |
| P10/G12 passive capture | PE-D21 consumes MT-D25 plus DR-D20/CIV-D15/RA-D15/BS-D24 owner state and exact last-good revisions; Plan reports stale/preflight state and never regenerates.                                                                    |
| Semantic cursor         | Plan cites UIP-D24/§9.7: 3D target/snap markers are `n/a`; move/scale/prohibited/wait tokens apply to paper objects on the dedicated 2D canvas.                                                                                  |
| GAP §6 Civil inbound    | PE-D5–PE-D7/PE-D14 are amended by PE-D21 citations to CIV-D5/CIV-D7/CIV-D15 for exact Civil view/product capture and job/preflight behavior.                                                                                     |
| Re-walk 2026-09-02      | Complies with P5/P6/P7 and current C4/D1/X3/B1/A2 rules: gestures journal once, dedicated-window Escape is honest, capture jobs restart/checkpoint, and page/report defaults are editable templates rather than office mandates. |

## Owner statements batch 2 — 2026-09-02

This section amends §2.1, PE-D1/D5/D6/D7/D9/D14/D18. The dedicated OS window
is retained, but its interior is an infinite pan/zoom canvas containing finite,
authoritative paper sheets. Top, left, and right tool/property islands float above
the canvas, can dock to their named edge, collapse, move without changing sheet
coordinates, and restore their last valid layout through UIP-D9. Native close is
never obscured; Escape follows PE-D10 and does not close the OS window. Island and
canvas-navigation state use local UI/camera histories, never the document journal.

Exact captured inputs now include VD-D15 rigid sections, Civil profiles/corridors,
MT-D27 solids, and RA-D14 difference Grids/legends. Linked inputs keep the last good
capture and show Stale under P10; pinned inputs retain exact revisions. Preflight
reports unresolved sources, NoData, stale recipes, and required regeneration before
export, without making Plan a geometry owner.

**PE-D20 — Infinite canvas hosts finite sheets and floating/dockable islands.**
**Decision:** the layout above replaces the fixed finite three-column interior while
preserving the dedicated window, writer lease, recovery, and exact paper authority.
**Derivation:** S6, C1, P8, X5, UIP-D8/UIP-D9, GAP-D9. **Rejected:** finite rails;
making paper itself infinite; discarding the dedicated window. **Tunable:** default
island sizes/positions and canvas overscroll.

**PE-D21 — New derived products are passive exact-capture inputs.** **Decision:**
PE-D5–D7 consume the products above using their owners' P10 state and revisions;
Plan never regenerates them. **Derivation:** P10, S8–S11, VD-D15, Civil CIV-D5/D7,
MT-D27, RA-D14. **Rejected:** rasterizing stale data without disclosure; Plan-owned
section/corridor/solid commands. **Tunable:** preview LOD only.

E1 follows GAP-V11: paper edges remain unmistakable at all zooms, islands have
visible float/dock/close/focus states in both themes and at 150%, minimum width has
one explicit overflow, and no island can cover native close. Tests prove pan does
not change sheet geometry, layout restore rejects corrupt/off-screen coordinates,
local undo separation, and stale/preflight behavior for each new input type.

| Work-order item                                        | Disposition                                  |
| ------------------------------------------------------ | -------------------------------------------- |
| S6 infinite canvas and floating top/left/right islands | Applied by PE-D20 with failable E1 criteria. |
| S8–S11 passive section/Civil/solid/difference inputs   | Applied by PE-D21 under P10.                 |
