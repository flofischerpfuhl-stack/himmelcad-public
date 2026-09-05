# Select & edit — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; SE-D13's executable benchmarks and SE-D18's shared theme tokens remain unimplemented and unverified. Amended for owner statements batch 2.

Its registry rows and consistency report now exist cleanly, but the three continuous benchmark
scripts in §6 do not yet exist; the cross-project fragment profile is absent
from implementation (the planned profile exists in `docs/PROJECT-FORMAT.md`); and shared semantic axis tokens are absent from
`@himmelcad/theme`. Same-project clipboard and the behavioral contracts below
remain implementation-ready at contract level, but cross-project exchange is
cataloged-deferred until its format implementation lands (`SE-D7`).

Domain boundary: selection tools that build a set of whole canonical entities,
whole-entity transforms and organization, clipboard duplication, canonical
entity lock/visibility commands, and temporary isolation. Draw retains vertex,
text, dimension, and other content edits (draw spec §1 and `DR-D14`).
Pointcloud retains point-level fences and mask edits (`PC-D1`–`PC-D5`); this
spec consumes its shared fence overlay but never creates a point mask.

## 1. Function catalog and ownership

Access: R = ribbon, X = entity context menu, Q = viewport quick surface,
C = console, A = automation (agent + Python SDK), K = keyboard, P = Properties
panel. Surface: VP = viewport tool, RP = right function panel, FI = floating
island. Performance: cont = continuous, bnd = bounded (< 1 s), long =
long-running with progress/cancel. Status is against the audited implementation;
a declaration without a handler is missing.

Owner decision D2 is resolved here as follows: the obsolete **Select** tab is
removed. View ▸ Selection owns Box, Lasso, and Paste; a **Selection** contextual
ribbon group appears at the end of the active domain tab whenever a selection
exists and holds the editing verbs. The same verbs appear in the shared entity
menu when applicable. This is a contextual group, not a new top-level Edit tab
(`SE-D2`).

| Id                              | Tab · group                            | Access paths                 | Surface                     | Perf                  | Automation command                                     | Status vs current implementation                                                                                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------- | ---------------------------- | --------------------------- | --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select.box`                    | View · Selection                       | R toggle C A                 | VP + compact RP             | cont                  | `select.box`                                           | missing — button only (`apps/builder/renderer/src/ribbon.ts:100-109`); unhandled actions only open/highlight a panel (`App.tsx:402-450`)                                                                                                                                                                                  |
| `select.lasso`                  | View · Selection                       | R toggle C A                 | VP + compact RP             | cont                  | `select.lasso`                                         | missing — same dead declaration/handler evidence as `select.box`                                                                                                                                                                                                                                                          |
| `edit.move`                     | contextual Selection · Transform       | R X C A P                    | shared gizmo + RP           | cont; commit bnd→long | `entity.transform.move`                                | partial foundation — the command schema is declared at `entity_commands.rs:18-32`; exact target/revision validation exists at `entity_commands.rs:199-218` and `canonical_document.rs:644-674`; a buffer-sharing translation ghost exists (`WgpuKernelViewer.ts:2802-2829`); no Builder tool or document-authority wiring |
| `edit.copy-vector`              | contextual Selection · Transform       | R X C A                      | shared gizmo + RP           | cont; commit bnd→long | `entity.transform.copy`                                | missing — canonical create transaction exists generically (`canonical_document.rs:182-219`), no guided copy command/surface                                                                                                                                                                                               |
| `edit.rotate`                   | contextual Selection · Transform       | R X C A P                    | shared gizmo + RP           | cont; commit bnd→long | `entity.transform.rotate`                              | missing — affine placement field only (`entity_model.rs:383-397,1199-1233`)                                                                                                                                                                                                                                               |
| `edit.scale`                    | contextual Selection · Transform       | R X C A P                    | shared gizmo + RP           | cont; commit bnd→long | `entity.transform.scale`                               | missing — affine placement field only; no command-specific surface                                                                                                                                                                                                                                                        |
| `edit.mirror`                   | contextual Selection · Transform       | R X C A                      | shared gizmo + RP           | cont; commit bnd→long | `entity.transform.mirror`                              | missing                                                                                                                                                                                                                                                                                                                   |
| `edit.pattern`                  | contextual Selection · More            | R X C A                      | RP (catalog)                | bnd→long              | `entity.pattern.create`                                | cataloged-deferred — no pattern relation/model or UI                                                                                                                                                                                                                                                                      |
| `edit.clipboard.copy`           | contextual Selection · Clipboard       | R X C A K(Ctrl+C rec.)       | inline                      | bnd, same project     | `entity.clipboard.copy`                                | missing — Builder command dispatcher contains no clipboard verb (`App.tsx:561-676`); cross-project packing is not claimed                                                                                                                                                                                                 |
| `edit.clipboard.paste`          | View · Selection · Paste               | R C A K(Ctrl+V rec.)         | VP placement + shared gizmo | cont; commit bnd→long | `entity.clipboard.paste`                               | missing; same-project only until `SE-D7`'s format prerequisite lands                                                                                                                                                                                                                                                      |
| `edit.clipboard.paste-in-place` | View · Selection · Paste               | R Q C A K(Ctrl+Shift+V rec.) | inline                      | bnd→long              | `entity.clipboard.paste_in_place`                      | missing; same-project only until `SE-D7`; UIP-D13 deliberately withheld the Q entry until this owner existed                                                                                                                                                                                                              |
| `edit.fragment`                 | View · Selection · Paste dropdown      | R C A                        | OS picker / progress        | long                  | `entity.fragment.export/import` (provisional spelling) | **cataloged-deferred** — `docs/PROJECT-FORMAT.md` now defines the planned transactional fragment profile; its schema admission and implementation remain pending                                                                                                                                                          |
| `edit.duplicate`                | contextual Selection · Clipboard       | R X C A K(Ctrl+D rec.)       | inline                      | bnd→long              | `entity.duplicate`                                     | missing; generic create is not a user function                                                                                                                                                                                                                                                                            |
| `edit.delete`                   | contextual Selection · More            | R X C A K(Delete rec.)       | inline                      | bnd→long              | `entity.delete`                                        | partial foundation — exact delete mutation exists (`canonical_document.rs:190-197,684-702`); tree exposes removal only for `CameraImage` (`EntityTree.tsx:277-287`)                                                                                                                                                       |
| `edit.group`                    | contextual Selection · Organize        | R X C A K(Ctrl+G rec.)       | inline + rename field       | bnd→long              | `entity.group`                                         | model only — `hcad.group@1` exists (`entity_model.rs:20-22,68-70`), no command/UI                                                                                                                                                                                                                                         |
| `edit.ungroup`                  | contextual Selection · Organize        | R X C A K(Ctrl+Shift+G rec.) | inline                      | bnd→long              | `entity.ungroup`                                       | missing                                                                                                                                                                                                                                                                                                                   |
| `edit.lock`                     | contextual Selection · Organize        | R X C A                      | inline                      | bnd                   | `entity.lock` / `entity.unlock`                        | missing — legacy snapshot has `visibility.locked` (`entity.rs:62-85`), but Builder projection hard-codes `false` (`projectProjection.ts:39-52`)                                                                                                                                                                           |
| `edit.hide`                     | contextual Selection · Visibility      | R X C A                      | inline                      | bnd→long              | `entity.visibility.hide/show`                          | partial, noncanonical — renderer visibility and local snapshot mutate only in `App.tsx:536-557`; VD-D8 requires canonical per-entity visibility                                                                                                                                                                           |
| `edit.isolate`                  | contextual Selection · Visibility      | R X C A                      | inline + viewport chip      | bnd                   | `view.isolate.set/clear`                               | missing; independent session allow-root predicate above VD-D13 hides (`SE-D10`)                                                                                                                                                                                                                                           |
| `edit.renumber`                 | contextual Selection · Organize · More | R X C A                      | RP preview                  | bnd→long              | `entity.renumber`                                      | partial primitive only — Name is writable (`property_schema.rs:127-158,503-524`), but no sequence/pattern preview                                                                                                                                                                                                         |
| `edit.history.undo-command`     | contextual Selection · More            | R C A                        | history FI (catalog)        | bnd→long              | `document.undo` with `command_id`                      | cataloged-deferred — core targets any active root command (`canonical_document.rs:464-487`); no surface; obligation registered from FP-D14                                                                                                                                                                                |

Shortcut entries and command spellings are recommendations to `REGISTRY.md`,
not unilateral claims. The registry already owns Ctrl+Z/redo, Ctrl+A, Tab, and
Escape. The RealWorks dossier proves only that Ctrl+C/V labels occur in a
shortcut roundup (`dossiers/realworks.md` §2.3 [22]); it does **not** establish
an entity payload or cross-project behavior. Ctrl+C/V are therefore
Himmel:CAD-native, tunable shortcut choices under X6/P6, not reference
adoptions. Ctrl+G is supported by the WorkSpace row (`dossiers/realworks.md`
§2.1). Shift variants, Ctrl+D, Delete, and automation spelling are
registry-owned calibration. The 2026-09-02 registry assigns the shortcuts and
closes F8 with dotted lower-case/`snake_case`; this catalog adopts it (`SE-D17`).

### 1.1 Command and state class summary

- `select.*`, independent `sessionHiddenEntityIds`, and the active isolate
  predicate are view/session state, excluded from the document journal but
  recoverable through their P8 Selection/Display histories and fully automation-readable/
  writable (UIP-D3, VD-D13, SE-D19). Isolate never owns or clears the independent
  session-hide set (§3.5, `SE-D10`).
- `entity.transform.*`, paste, duplicate, delete, group/ungroup, lock, canonical
  hide/show, and renumber are atomic canonical transactions with exact
  `EntityVersionRef`s (`canonical_document.rs:22-55,165-219`).
- Copying to the clipboard changes no project state. A same-project clipboard
  token pins its exact immutable closure until replacement, project close, or
  app shutdown; it is invalid after project replacement and never pretends to
  be cross-project data. Pasting or duplicating is one journaled command,
  regardless of entity count.
- A direct manipulation journals exactly once at pointer-up or typed Enter; it
  never writes during pointer motion, and a keyboard-completed gesture ignores
  its later pointer-up (P5, `SE-D1`).

### 1.2 Dossier-row dispositions

The domain boundary for this table is every dossier row whose principal act
selects, transforms, copies, organizes, locks, hides, or deletes whole
entities. Domain-specific interior editing remains with its existing owner.

| Dossier row                                                           | Disposition                                                                                                                                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RIB Civil §2.1 `Kopieren, Rotieren, Verschieben, Nummerieren, Ändern` | adopted: copy-vector/rotate/move and batch renumber; `Ändern` is split — whole-envelope Properties edits consume UIP-D17, while vertex/content editing stays Draw (`draw.md` §1)                   |
| RIB Civil §2.1 `UNDO`                                                 | already dispositioned by file-project FP-D11; this spec consumes it and accepts only FP-D14's selective-history follow-on                                                                          |
| RIB Civil §2.2 `Punktauswahl`                                         | already adapted by UIP-D16 candidate cycling/list; not re-dispositioned                                                                                                                            |
| RIB Civil §2.2 F4-Box                                                 | Civil-owned where admitted by CIV-D2–D14; not claimed here                                                                                                                                         |
| RIB Civil §2.3 HV-Planverwaltung                                      | already adopted as layer lock by draw DR-D4; entity lock extends the same visible-but-untouchable behavior to a different canonical class (`dossiers/rib-civil.md` §2.3)                           |
| RIB Civil §2.9 clipboard/WMF export                                   | rejected here as out of domain; plan-editor PE-D11 already owns/rejects that deliverable format, while this spec owns entity clipboard data                                                        |
| RealWorks §2.1 WorkSpace groups/display toggles/batch rename          | adopted: group/ungroup, hide/show, renumber preview; Ctrl+G recommendation comes from the same row                                                                                                 |
| RealWorks §2.3 segmentation fence                                     | already owned by Pointcloud PC-D1–PC-D5; rejected for entity selection because it edits points, not entity membership                                                                              |
| RealWorks §2.3 Ctrl+C/Ctrl+V shortcut labels                          | **not adopted as workflow evidence**: the dossier establishes labels only, not their payload; Himmel:CAD's same-project entity clipboard and proposed bindings derive natively in `SE-D7`/`SE-D17` |
| RealWorks §2.5 Limit Box manipulator                                  | already owned by viewing-box VB-D5/VB-D6; not treated as a whole-entity transform gizmo                                                                                                            |
| RealWorks §2.8 Move Mesh displacement toolbar                         | adopted through the shared gizmo: a mesh is an ordinary transformable entity (`dossiers/realworks.md` §2.8)                                                                                        |
| Trimble Perspective §2.5 object tap/delete                            | selection lifecycle already owned by UIP-D2/D15/D18; canonical delete here removes the entity from all views, matching the cited row                                                               |
| Trimble Access §2.5 rectangle and polygon selection                   | adopted as Box and click-built Polygon; freehand Lasso is the stated PC-D2/Himmel:CAD addition; tap/deselect/clear/context/disambiguation remain UIP-D2/UIP-D5/UIP-D16                             |
| Revit §3 W2 type duplication                                          | rejected for `edit.duplicate`: duplicating a BIM type is a definition operation owned by BIM, not a whole-entity clone                                                                             |
| Revit §3 W3 multi-select properties                                   | already adopted by UIP-D17; transform numeric fields reuse its Mixed/count grammar without re-disposition                                                                                          |
| Revit §2.4 repeating/array mechanisms                                 | BIM-generative patterns remain BIM-owned; a one-off whole-entity array is retained only as catalog row `edit.pattern`, deferred pending a relation contract                                        |

### 1.3 Cite-and-revise cross-spec register

| Existing record                           | This spec's treatment                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UIP-D15, UIP-D16                          | adopted verbatim for idle picking/candidate state; fences deliberately select cloud/splat **entities**, while click still cannot                                |
| UIP-D17                                   | adopted for shared/mixed numeric presentation and batch commits                                                                                                 |
| UIP-D18                                   | adopted: hide keeps membership; delete prunes; undo never resurrects membership                                                                                 |
| ui-platform §3.6 / UIP-D14                | adopted and fully reconciled in §4; no independent Escape order                                                                                                 |
| UIP-D13                                   | revised need: now that clipboard has an owner, add `edit.clipboard.paste-in-place` to the void quick surface through UIP-D6                                     |
| PC-D2 / PC review finding 14              | adopted: Pointcloud builds the shared projection-true fence overlay; Box/Lasso consume it                                                                       |
| PC-D16 / P4                               | adopted: clip and explicit visibility scope entity fence candidates and every edit target; natural occlusion does not                                           |
| DR-D14                                    | adopted armed-tool pattern; Draw still owns vertex/content editing                                                                                              |
| DR-D4                                     | adopted as the canonical layer-lock source; `SE-D9` supplies the single effective-editability conjunction and requests an owning-spec citation amendment        |
| FP-D15                                    | same gizmo behavior contract; File attach supplies its own command adapter and translate/rotate capability profile                                              |
| FP-D11 / FP-D14                           | global linear undo unchanged; selective non-latest surface accepted as catalog-level follow-on                                                                  |
| VD-D8 / VD-D13                            | adopted: canonical hide below, session-only isolate above; no third visibility store                                                                            |
| VB-D3                                     | adopted for pass scoping; its bake key now includes the exact source entity/placement revision and its preview lifecycle cites SE-D3                            |
| RA-D4                                     | adopted verbatim: a placement revision of the image or support invalidates the exact-revision drape bake; stale prepared output is suppressed while rebuilding  |
| MI-D3                                     | adopted verbatim: valid local associative anchors follow placement and recompute; fixed project-world anchors do not; invalid anchors become visibly unresolved |
| PE-D5                                     | adopted: a linked capture becomes stale on a relevant placement revision and keeps its last good capture; a pinned capture remains fixed to its exact revisions |
| REGISTRY F2/F5b/F8 and future-domain note | reconciled 2026-09-02: rows/gestures/shortcuts are registered, F2/F5b/F8 are closed, command spelling is normalized, and the owed-spec entry is retired         |

## 2. Full user-perspective workflows

### 2.1 Gizmo move with numeric twins

The user has an IFC column, two drafted curves, and a 600-million-point cloud
selected. Clipped-away and explicitly hidden selected entities are named but
excluded: the contextual group says **3 visible of 5 selected** (P4); natural
occlusion excludes nothing. They press **Move** in the contextual Selection
group. The shared transform gizmo appears at the visible selection-bounds
center, the Transform panel opens, and the status line says “Move 3 entities”.
The cloud contributes one entity, never millions of point operands.

The panel exposes **From / pivot X/Y/Z**, defaulted to the visible selection-
bounds center. The user may type it or choose **Pick From** and acquire it
through the shared exact snap pipeline. They drag the red X-axis handle. Axis
handles constrain to one selected world/local axis; XY/YZ/ZX handles constrain
to a plane; the center handle is unconstrained. One transient selection
transform moves the visible draw proxies at presentation cadence; the source
entities remain at their committed placements, and the panel's Delta X/Y/Z
fields update live.
The point cloud reuses its immutable tiles/buffers and changes only placement;
no point coordinates, Potree nodes, attributes, or hashes are rewritten
(`SE-D3`). Snapping, clipping, tile selection, and picking all evaluate the
preview transform so the ghost cannot appear in one place and snap in another.
The moving snap point is the From point. Candidate generation and priority are
exactly DR-D12 after P4 filtering: Up/Down cycle the visible candidate stack,
and the held one-shot source override remains available. An axis/plane
constraint accepts an exact candidate only when the candidate lies on its
constraint manifold within the shared snap tolerance; otherwise the marker
says **Unavailable under X constraint** (or the named plane) and does not claim
an exact snap. Builder never projects an off-axis candidate and labels the
projected point as that candidate. The center handle accepts the exact 3D
candidate.

Before releasing, the user types `2.500 m`. Printable input freezes the last
pointer-derived preview, disarms pointer-derived updates, transfers focus to
the matching numeric field under the DR-D1 focus model, and retains the same
gesture and captured baselines. Enter commits once, releases logical pointer
capture, and marks the pointer id completed; its trailing physical pointer-up
is ignored. The first Escape reverts typed input to the frozen pointer preview
and returns viewport focus; the second Escape occupies UIP-D14's active-drag
rung and restores every target to its captured canonical baseline. Pointer-up
without typing also commits exactly once. Either commit submits one transaction
with the exact revisions captured at gesture start and one `SetPlacement` per
target.
The status changes to “Storing…” only if durable append lags; the viewport never
waits on disk. On success the gizmo remains bound to the now-current selection,
and Ctrl+Z restores all three placements in one step.

Rotate applies the same grammar with a typed/picked pivot, axis ring, and
angle; Scale with pivot plus axis/plane/uniform handles and factors; Mirror with
a typed/picked plane point and normal; Copy by vector with From and To. Visible
panel controls switch modes. Tab is never a mode switch, and any accelerators
must be assigned by the registry. Every pointer or typed gesture produces at
most one journal entry and one Ctrl+Z step (P5).

If an agent edits any target mid-drag, the revision event cancels the preview,
releases pointer capture, and rebinds to the new canonical state with “Move
cancelled — selection changed”. A stale pointer-up never retries against new
state. A locked member blocks launch with its name and an **Unlock** action;
the command never silently skips it. In plan mode, entities with unknown Z keep
unknown Z and the Z axis is disabled — no drag invents a height.

#### 2.1.1 Placement-change consumers

A placement commit advances each target's exact entity version even though its
immutable geometry/dataset hash is unchanged. Preview and commit have one rule
per passive consumer; a generic “derived products invalidate” statement is not
sufficient:

| Consumer                                | During preview                                                                                                                                                                                                                                                                                | After commit / cancellation                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locked viewing-box point bake (`VB-D3`) | Suspend the old world-space bake for a moved source cloud; render that source through the preview placement and the live clip planes. Never present the old bake as current.                                                                                                                  | Key validity on source entity id **and exact placement/entity version** as well as dataset revision. Commit shows **Rebuilding locked box** until one settled, debounced bake publishes atomically; cancellation restores the prior bake. VB-D3 now carries this reciprocal contract.                                   |
| Draped raster (`RA-D4`)                 | Suppress stale prepared drape output when either the image or terrain/support preview changes its world relation; a coarse preview may be generated from current inputs but may not be called current.                                                                                        | The moved image/support entity revision invalidates the exact-revision key; rebuild once settled and atomically publish. Cancel keeps the prior exact bake.                                                                                                                                                             |
| Entity-anchored measurements (`MI-D3`)  | Re-resolve local associative anchors against preview placement for display only; fixed project-world anchors do not move.                                                                                                                                                                     | Valid local anchors follow and values recompute in the same resulting revision view; fixed world anchors remain fixed; invalid targets survive as **Unresolved — source changed** with labeled last-verified history, never cascade-delete.                                                                             |
| Plan captures (`PE-D5`)                 | A live selected viewport may preview the moving result; no pinned artifact or last-good capture is overwritten.                                                                                                                                                                               | A linked viewport observing the target revision becomes **Stale**, keeps its last good capture, and refreshes/coalesces under PE-D5. A pinned viewport remains fixed to its recorded revisions and artifacts.                                                                                                           |
| Attached-project reference (`FP-D15`)   | The reference uses this gizmo only through `project_reference.set_placement`, with translate/rotate capability; its prepared local-content bake remains reusable because source-manifest content did not change. All render/pick/snap/measure consumers evaluate the preview world placement. | Commit advances the reference entity/placement revision and invalidates world-space dependants such as measurements and Plan captures by the rows above; it does not re-bake unchanged source-local content. Scale/mirror are rejected, and no placement is converted into an owned paste or silent CRS interpretation. |

One target revision change cancels the whole preview before any consumer can
publish. `G-SE-CORE`, `G-SE-1`, and the real-data scene cover all five rows.

### 2.2 Box-select, group, and hide

The user wants one facade assembly from a clipped mixed cloud/BIM scene. On
View ▸ Selection they toggle **Box**. A compact panel shows two orthogonal
controls: **Combine** = Replace / Add / Remove, and **Hit rule** = Window
(wholly contained) / Crossing (intersects). Both Box and freehand Lasso support
both rules over projection-true candidate geometry. They drag a rectangle; the
shared fence overlay uses the platform selection tint and a stable 1 px
boundary. Only entity geometry surviving the active viewing box and canonical/
session visibility is queried. Geometry behind other geometry still counts
because natural occlusion is not P4 scope.

On release, Builder selects every entity with visible geometry crossing the
rectangle. A point cloud is selected once as a cloud entity and gets its
bounding-box highlight; no point mask is created. The status says “Selected 14
entities”; the tree and Properties panel show the same set. If the fence merely
crosses points of a cloud, it still selects that cloud deliberately — UIP-D15
forbids accidental click-select, not explicit fence selection. Organizational
groups/layers without geometry are never fence hits.

The user presses **Group**. Builder removes nested duplicate operands, finds the
lowest common owner, creates “Group 1” there, and reparents the selected roots
under it in one expected-revision transaction. The group becomes the selection;
its children and layer memberships do not change. They rename it “Facade west”
inline. Transforming the group later expands its renderable descendant closure
and applies one atomic placement transaction; owner hierarchy itself is not a
spatial transform.

They choose **Hide selection**. A canonical visibility command hides the group
and therefore its descendants effectively; the group remains selected exactly
as UIP-D18 requires, the status reads “Selected: 1 · Hidden: 1”, and the
Properties panel remains inspectable. P4 immediately removes the hidden
descendants from picking, snapping, measurement, future fences, and edit target
resolution. **Show selection** reverses it; Ctrl+Z reverses either command.
Closing Box from its ribbon toggle or panel x cancels only an in-progress fence
and leaves the selection/group/hide results untouched.

Lasso defaults to freehand press-drag-release; it is a Himmel:CAD/PC-D2
addition, not what the Access dossier's polygon row proves. Its accessible
**Polygon** input mode uses single LMB clicks to append vertices, Backspace to
remove the latest, and Enter or double-click to close; Escape discards the open
polygon one rung at a time. Access supplies rectangle/polygon evidence only
(`dossiers/trimble-perspective.md` §2.5 [S9]); `SE-D16` records the deviation.

### 2.3 Copy and paste

The user selects a drafted alignment annotation group and presses Ctrl+C.
Builder captures the exact visible root entities and dependency closure at
their current revisions. Copy changes no project state and shows a quiet
“Copied 8 entities” toast. Within the same project, immutable objects are
referenced, not duplicated. Ctrl+V creates a placement ghost anchored at the
last valid cursor project point (or the current view center if none), opens the
same Transform panel, and lets the user drag or type the offset. Pointer-up or
Enter creates new stable entity ids, remaps internal owner/relation ids, and
commits all creations as one transaction. Escape before commit removes the
ghost and creates nothing; Ctrl+Z after commit removes the entire paste.

Ctrl+Shift+V, View ▸ Paste ▸ **Paste in place**, or the void quick-surface entry
skips placement and preserves the copied project-world placements exactly. It
never applies a convenience offset. **Duplicate** is the same-project,
clipboard-free version of paste-in-place: exact overlap, new ids, one undo step,
and a status message that the duplicate is in place; Builder never invents a
coordinate merely to make the result visible.

The cheap clipboard token is intentionally same-project and process-local. It
contains the source project id, exact root/entity/dependency refs, source CRS
and units, and pinned object hashes. Replacing the clipboard releases its pins;
project close/replacement or app shutdown invalidates it; project maintenance
must treat live pins as reachable. A missing/expired token gives **Copied items
are no longer available** and creates nothing.

For another project, **Export fragment… / Import fragment…** remain visible
catalog rows but are disabled with **Project fragment format is not implemented**.
They do not serialize a made-up `.hcadx` subtype. The planned profile in
`docs/PROJECT-FORMAT.md` owns a versioned fragment manifest carrying source
project id, exact entity/dependency/object refs, source CRS and units, format
version, checksums, and a self-contained operation-owned spool. Its lifecycle
must survive project close/replacement and crash recovery; replacement of the
clipboard or explicit cleanup may release it only after no operation references
it, and containment/path checks apply before staging (`SE-D7`).

Once that format is admitted and implemented, cross-project **Paste in place** enables only for
identical CRS and units or after an explicitly selected, previewed registered
transformation. Numeric identity in a different/unknown frame is a separately
labeled dangerous choice with recorded provenance. **Attach as reference** is
an offered FP-D15 command, never a silent paste fallback and never a conversion
of owned entities into a reference. Cancel/failure publishes no object or
entity; after the format's ready boundary recovery completes or rejects per
`PROJECT-FORMAT`. Until then no Ctrl+C/V cross-project claim is made.

## 3. Function contract answers (A1–E3)

### 3.1 Entity selection fences (`select.box`, `select.lasso`)

**A1.** §2.2 through fence release. **A2.** Trimble Access documents tap,
rectangle and polygon selection plus context/list paths
(`dossiers/trimble-perspective.md` §2.5 [S9]); we adopt rectangle and
click-built polygon entity selection. Freehand Lasso is a stated Himmel:CAD/
PC-D2 addition, not a rename of the Access polygon. RealWorks segmentation is
a point-editing fence (`dossiers/realworks.md` §2.3), deliberately not adopted
as selection semantics. **A3.** Idle click selection/cycling is UIP-D2/D15/D16;
Pointcloud PC-D2 builds the overlay; both fences write the same selection set.
**B1.** Catalog paths; no entity-menu entry because a fence starts on empty
space. **B2.** ribbon pure toggle, panel x, Escape tool rung; close discards an
open fence only. **B3.** VP + compact RP because membership mode stays visible
while the viewport remains interactive. **C1.** No model number is authored or
displayed: fence coordinates are view-projection input, while console/automation
can provide the projection-true world volume. This is not a numeric CAD value
and no drag-only number exists. **C2.** Both tools capture orthogonal
**Combine** (Replace/Add/Remove) and **Hit rule** (Window/Crossing) at the first
vertex/pointer-down; selection result applies only at release/close. Freehand
and click-built polygon modes support the same six combinations. **C3.** no freeze: spatial
entity indexes and visible proxy bounds are precomputed/incremental. **C4.**
selection remains UIP-D3 view-local; fences create selection-history steps, never document-journal steps.

**D1.** pointer/overlay update is continuous; query/result bounded for ordinary
scenes and shows “Selecting…” if it exceeds 150 ms. G-SE-2/G-SE-3 are the
blocking gate contracts in §6, but their named scripts are not present yet;
therefore this draft does not call the interaction verified or smooth.
**D2.** governor may simplify fill and query conservative bounds first, then
refine; never degrade membership correctness or pointer response. **E1.** §7
criteria 1–2. **E2.** consumers: selection store, tree, Properties UIP-D17,
status count, kernel highlight, context registry, automation, and every
selection-captured command. Largest member: a billion-point cloud selects once
from visible entity proxies, never per point. Least typical: a tiny GCP marker
uses its platform pick radius. Hidden/clipped geometry is excluded; natural
occlusion is included (P4). Projection changes during an open drag are rejected
until release; between fences navigation is available. **E3.** §6.

### 3.2 Whole-entity transforms and the shared gizmo

**A1.** §2.1; copy-vector uses the same flow but commits clones. **A2.** RIB
Civil establishes move/copy by vector and rotation around a reference
point/direction, with numeric F5 parity (`dossiers/rib-civil.md` §2.1, §2.2,
§4); RealWorks supplies a mesh displacement toolbar
(`dossiers/realworks.md` §2.8). We adopt those outcomes and add scale/mirror as
Himmel:CAD-native affine-placement functions (`SE-D17`), not as dossier-backed
reference behavior. **A3.**
viewing-box handles are domain-specific; file attach FP-D15 is the first direct
consumer of this component; Draw retains component/vertex edits.

**B1.** catalog paths. Properties exposes the same typed transform fields.
No quick-surface entry: transforms need selected operands. **B2.** Transform
panel/ribbon button toggles; x/Escape closes and cancels any preview, never
reverts committed steps. **B3.** shared overlay + RP: direct manipulation must
remain visible while numeric twins are edited. **C1.** Move From/pivot X/Y/Z
plus ΔX/Y/Z; Rotate pivot X/Y/Z + axis + angle; Scale pivot + X/Y/Z factors
with uniform link; Mirror plane point + normal — every handle value is picked/
typed, unit/precision aware, and live both ways. Axis, plane, and free handles,
DR-D12 snap/override behavior, and the typed-during-drag focus/Escape ladder are
exactly §2.1/SE-D1. **C2.** targets are the P4-visible selection captured at
gesture start; selection changes before a drag rebind, during a drag cancel.
Mixed placements show operation deltas, never a dishonest decomposed “Mixed”
matrix. **C3.** the captured baseline revisions and transient selection
transform freeze expensive source geometry: previews reuse buffers and one
selection matrix. **C4.** preview/field text/hover are transient; each drag-end
or field commit is one atomic journaled command. Ctrl+Z restores the complete
captured target set once (P5).

**D1.** handles/previews/navigation are continuous; G-SE-1 is the blocking gate
contract but its script is not present yet, so this draft makes no verified-
smoothness claim. Commit is bounded
normally; an extreme selection registers a “Store transform” UIP-D10 job,
cancelable before the atomic commit boundary. **D2.** ghost fill/point density
and handle occlusion aids degrade first; never input response, f64 placement,
clip/pick agreement, or transaction atomicity. **E1.** §7 criteria 3–6.
**E2.** Applicability comes from one canonical
`entity.transform_capabilities` query consumed unchanged by ribbon, context
menu, Properties, console, agent, and SDK. The effective operation set is the
intersection across resolved targets. If any target is unsupported, UI
disables with names/reasons and a direct automation call rejects the whole
operation; no member is skipped. Initial owner-adapter matrix:

| Selected kind                                                         | Generic transform result                                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement-backed CAD primitives and ordinary model/mesh entities      | translate/rotate; scale/mirror only when the semantic owner returns explicit support                                                                                                            |
| Point cloud, splat, survey/control source, ElevationSurface Grid/Tin  | translate/rotate; scale/mirror disabled because their owner has not specified CRS/measurement effects                                                                                           |
| Project reference                                                     | translate/rotate only through FP-D15 `project_reference.set_placement`                                                                                                                          |
| Viewing box                                                           | no generic transform; route to `viewing_box.update` and its own handles                                                                                                                         |
| Measurement                                                           | no generic transform; route to **Edit anchors/plane** under MI-D6                                                                                                                               |
| BIM-generated object                                                  | placement-only under BS-D20/BS-D21; linked source observations stay fixed, commit records a manual-placement override, and regeneration asks Keep/Reset; parameter/content edits stay BIM-owned |
| Dimension, text, label, or other screen/style-sensitive Draw entity   | use the Draw domain adapter; expose only whole-placement operations it validates, never content/anchor editing through this gizmo                                                               |
| `hcad.group@1`                                                        | expand the expressly defined renderable descendant closure; all descendants must support the operation                                                                                          |
| Layer, root/default state, or other non-spatial organizational entity | reject; no invented placement                                                                                                                                                                   |

The query reports adapter command, expansion, `supported`, and reason per
operation. A screen-sized label is the least typical renderable member; its
pixel size remains style semantic even if its owner allows anchor placement.
The largest cloud changes placement only. Other consumers: canonical journal/
undo, renderer bounds and every pass,
streaming/SSE (`tile_selector.rs:188-205,309-335`), picking/snapping inverse
placement (`picking.rs:185-249`), clip/measurement, selection bounds, tree and
Properties, exporters, and automation. The five dependent-artifact lifecycles
are exact in §2.1.1, including file attach.
Unknown-Z plan geometry retains unknown Z. Singular scale is rejected
before preview commit (`entity_commands.rs:97-117,199-218`). **E3.** §6.

### 3.3 Clipboard, duplicate, fragment, pattern, selective history

**A1.** §2.3; pattern/history are catalog only. **A2.** RealWorks records
Ctrl+C/V labels, but a dossier-wide check finds no payload semantics, so no
entity-clipboard reference behavior is claimed
(`dossiers/realworks.md` §2.3 [22]); RIB establishes vector copy
(`dossiers/rib-civil.md` §2.1). Revit's repeating arrays are definition-driven
and stay BIM-owned (`dossiers/revit.md` §2.4). **A3.** Save As/archive staging
FP-D3/PROJECT-FORMAT supplies transactional packing; FP-D15 supplies CRS refusal;
FP-D11 remains the global undo behavior.

**B1.** catalog paths; fragment paths are disabled pending schema admission and implementation of the planned format profile.
**B2.** Copy is inline; Escape cancels uncommitted same-project paste placement.
**B3.** Paste uses VP + gizmo, paste-in-place is inline; the deferred fragment
will use OS picker/progress, and promoted Pattern will use RP.
**C1.** Paste placement uses full gizmo parity; paste-in-place has no numeric
change. **C2.** Copy captures visible selected roots and exact revisions; later
selection changes do not change clipboard contents. **C3.** immutable objects
are referenced/deduplicated and pinned for the live token; no second payload
copy. **C4.** the token is runtime state, not undoable: replacement releases
pins, project close/replacement and app shutdown invalidate it, and source GC
must honor live pins. Paste/duplicate are one journal step. The future fragment
spool/ready lifecycle is fixed in §2.3 and `PROJECT-FORMAT`, but remains
non-implementable until an ADR admits its schema.

**D1.** Same-project copy metadata is bounded; large paste is bounded-to-long
with progress/cancel. Future cross-project pack/import is long with real bytes/
files and cancel. **D2.** Weak hardware
streams and may lower ghost density, never validation or placement. **E1.** §7
criteria 7–8. **E2.** consumers: object store/GC reachability, canonical owner/
layer/relation graphs, render and indexes, undo, export, clipboard OS bridge,
automation, project lock, CRS/units. Largest: a point-cloud same-project copy
pins immutable datasets without copying their bytes; a future fragment streams
the closure. Least typical: group-only selection recursively includes
descendants but does not invent geometry. Same-project failure publishes
nothing. Future fragment failure before ready discards staging; after ready,
recovery completes or rejects per PROJECT-FORMAT. Pattern remains explicitly
unverified/cataloged. **E3.** §6.

### 3.4 Delete, group/ungroup, lock, renumber

**A1.** group/hide flow in §2.2; delete/lock/renumber follow the same visible
selection preview/count. **A2.** WorkSpace groups, display toggles, patterned
batch rename (`dossiers/realworks.md` §2.1) and RIB Markierbox batch operations
(`dossiers/rib-civil.md` §2.1) are adopted. **A3.** UIP-D17 provides multi-edit
grammar; file-reference detach, viewing-box remove, and other domain-owned
removals remain command adapters, not parallel generic deletes.

**B1.** catalog. Group/lock/delete/renumber are contextual; no quick surface.
**B2.** Inline commands close by completion. **B3.** Renumber uses RP preview;
ordinary undoable delete has no confirmation, but dependency blocks explain and
stop. **C1.**
renumber start/increment/prefix/suffix are typed; preview every resulting name.
**C2.** one exact visible selection transaction. Locked targets block mutating
verbs whole; reading, selection, snapping, measurement, and copy remain
allowed. **C3.** one authoritative effective-editability query is cached and
invalidated by entity-lock, owner, layer-membership, or layer-lock commits. It
returns `effectiveLocked` plus every cause: self, named owner ancestor, and
named effective layer. **C4.**
all canonical and undoable; ungroup reparents direct children then tombstones
the emptied group in one transaction.

**D1.** Bounded normally; huge hierarchy closure becomes a cancellable
pre-commit job. **D2.** Degrade no transaction to partial/member-skipping. **E1.** §7
criteria 9–10. **E2.** consumers: owner/child indexes, tree, effective lock and
visibility resolvers, selection UIP-D18, properties, renderer, picking/snap,
exporters, dependent relations, automation, journal/GC. Every mutating
canonical command, including Properties and SDK calls, invokes the same
predicate before transaction preparation. `entity.lock/unlock` changes only
the entity source and `layers.set_locked` only the layer source. Each source's
unlock command may clear that source even while it contributes to effective
lock, but it never reports the entity editable while another cause remains.

Delete is preflighted by one registry-fed `entity.delete_plan` query over exact
selected kinds and dependency closure (`SE-D15`). Its result and confirmation
surface state exact direct, descendant, dependent-unresolved, hidden-excluded,
protected, and lock-blocking counts plus the owner adapter for every direct
target. Any protected/locked/invalid member rejects the whole command.

| Delete-plan member                                    | Required result                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hcad.group@1`                                        | delete the explicitly previewed descendant subtree atomically; **Ungroup** is the preserve-children alternative          |
| Project root or Default layer/protected default state | reject with named reason                                                                                                 |
| Viewing box                                           | dispatch to `viewing_box.remove` semantics                                                                               |
| Project reference                                     | dispatch to FP-D15 detach semantics                                                                                      |
| Measurement                                           | dispatch to `measurement.remove`; deleting a measurement source instead preserves it unresolved per MI-D3                |
| Other domain artifact                                 | owning adapter supplies affected refs/cleanup; absence of an adapter rejects rather than falling back to a raw tombstone |

Deleting a cloud therefore does not cascade its associative measurements;
linked drapes/captures become missing/unresolved or stale under their owner
records. Immutable objects remain reachable while journal/undo history needs
them. Ctrl+Z restores exactly the command's canonical affected set, never prior
selection membership (UIP-D18). Largest: a 100,000-member nested group streams
closure/preflight then commits atomically. Least typical: a representation-less
organizational group is tree-selectable and receives the subtree plan above.
**E3.** §6.

### 3.5 Canonical hide/show and session isolate

**A1.** hide is §2.2; isolate creates a session-local operation id plus allow
roots and shows a persistent “Isolated: N · Exit” chip. It does not write the
independent `sessionHiddenEntityIds`. **A2.** RealWorks WorkSpace display toggles
(`dossiers/realworks.md` §2.1) support explicit hide; Perspective station
filters are station-domain behavior (`dossiers/trimble-perspective.md` §2.7),
not adopted as generic entity isolation. **A3.** VD-D8/D13 own the canonical/
session split; UIP-D18 owns selection persistence.

**B1.** catalog; Exit isolate from chip, ribbon, C/A. **B2.** Hide is instant;
isolate closes through Exit, never Escape (persistent chip, no ladder theft).
**B3.** inline plus chip. **C1.** No numeric manipulation. **C2.** Hide targets
the captured P4-visible selection. Isolate captures allow roots, not later
selection; a group root dynamically admits its live descendants. Replacing an
isolate resolves the new roots against the full live project universe without
applying the old isolate predicate, so a selected id hidden by the first
isolate can re-enter. Canonical hides and independent session hides remain
effective. **C3.** No expensive live preview. **C4.** canonical hide/show is
journaled. Hide has no implicit restore snapshot: **Show selection** changes
canonical visibility only for the explicitly captured selected ids; it never
“restores everything hidden by the last Hide”, and it does not clear session
hides or isolate. Isolate is view-local, recoverable through Display history, and automation-visible.
Its exact Exit restore scope is only `{activeIsolateOperationId,
activeIsolateAllowRoots}`. Exit removes that predicate and preserves canonical
visibility, independent `sessionHiddenEntityIds`, selection, camera, clips,
and every other ViewState field. Project close/replacement and app shutdown
clear isolate; panel close, ribbon changes, and selection changes do not.

**D1.** Bounded; hierarchy visibility resolution may stream. **D2.** Density
may degrade, but visibility correctness publishes atomically. **E1.** §7
criterion 11. **E2.** every render pass, pick/snap/measure/fence/edit target,
selection, tree, properties, bookmarks/view-state VD-D13, exporters (canonical
data export is not silently filtered), automation. Effective visibility is
canonical visibility ∩ independent session hides ∩ the active-isolate
predicate. New/restored/pasted/imported entities are hidden by isolate unless
their id or a live owner ancestor is an allow root. **Show selection** may
succeed canonically while isolate still hides the entity; feedback is **Shown
canonically · still hidden by Isolate** with an **Exit isolate** action. Hidden
selected entities stay selected; delete still prunes (UIP-D18). Largest cloud stops draw/pick
without unloading immutable residency; smallest marker disappears from render
and pick together. **E3.** §6.

## 4. Input and gesture arbitration

At most one Box, Lasso, or transform tool is armed. The table reconciles every
input against ui-platform §3.6; unclaimed gestures keep platform meaning.

| Input                       | Box / Lasso                                                                                                                                      | Shared transform gizmo                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LMB click                   | Box/freehand: sub-threshold click commits nothing; Polygon mode: appends one vertex; idle select is suspended                                    | off-handle: UIP-D2 selection; on handle: begins eligible drag only after threshold                                                                                                                                                             |
| LMB double-click entity     | unclaimed/reserved                                                                                                                               | unclaimed/reserved                                                                                                                                                                                                                             |
| LMB double-click void/cloud | finishes a valid click-built Polygon; otherwise clear-selection is suspended                                                                     | platform clear; empty selection closes transform panel after selection event                                                                                                                                                                   |
| LMB drag                    | claims orbit slot to draw rectangle/freehand fence; reason: this is the tool's defining input                                                    | claims orbit slot only when press began on a gizmo handle; off-handle remains orbit                                                                                                                                                            |
| Ctrl+LMB                    | no hidden modifier; fence panel owns Replace/Add/Remove                                                                                          | off-handle toggles membership; on-handle Ctrl is ignored and announced, never covert copy                                                                                                                                                      |
| RMB click                   | platform entity menu/quick surface                                                                                                               | platform entity menu/quick surface                                                                                                                                                                                                             |
| RMB drag                    | platform pan between fences; rejected during active LMB fence with status                                                                        | platform pan except during active handle drag, where rejected with status                                                                                                                                                                      |
| MMB                         | platform pan between fences; rejected during active fence                                                                                        | platform pan except during active handle drag                                                                                                                                                                                                  |
| Wheel                       | platform zoom between fences; rejected during active fence                                                                                       | platform zoom except during active handle drag                                                                                                                                                                                                 |
| Tab / Shift+Tab             | no fence-mode claim; panel focus traverses controls                                                                                              | focus/traverse the transform numeric fields; never cycles candidates or switches transform mode                                                                                                                                                |
| Backspace / Enter           | Polygon: remove latest vertex / close valid polygon; freehand/Box unclaimed                                                                      | text-edit meaning in a focused field; Enter commits the active numeric preview once                                                                                                                                                            |
| Escape                      | focused field reverts (rung 1); active fence/polygon discards (drag/tool-local rung); otherwise tool closes at UIP-D14 rung 4; selection remains | focused typed-during-drag field reverts to frozen pointer preview (rung 1); next press cancels drag to captured baseline (rung 2); next cancels armed transform (rung 4); a later press may close its function tab (rung 7); selection remains |
| Typing                      | no viewport claim; registry shortcuts continue                                                                                                   | during a handle drag, printable input freezes pointer preview and focuses the matching numeric field; otherwise it focuses the armed mode's primary field under DR-D1                                                                          |
| Touch                       | drag/tap equivalents use the same armed scope; tap-hold remains context between fences                                                           | handle drag; off-handle tap selection and tap-hold context remain platform-owned                                                                                                                                                               |

`pointercancel` cancels the entire active pointer gesture to its captured
baseline (UIP-D14 drag rung), never merely a focused field. Project replacement,
device loss, target revision change, or tool switch removes every preview and
releases pointer capture before another owner can claim input.

## 5. Decision records

**SE-D1 — One platform-shared transform gizmo contract (flagship).**
**Decision:** `@himmelcad/ui` owns chrome/numeric fields and
`@himmelcad/viewer/kernel` owns overlay hit-testing/transient selection
transform. Hosts supply target refs, the `entity.transform_capabilities` result,
and a canonical command adapter. Move has a picked/typeable From point; axis,
plane, and center handles constrain it as §2.1 specifies. DR-D12 owns candidate
priority, Up/Down candidate cycling, and the held source override. Printable input during a
drag freezes the pointer preview and uses DR-D1 focus; typed Enter or pointer-up
commits once, a completed pointer id cannot commit again, and UIP-D14's field →
drag → tool → panel Escape order applies. Rotate, Scale, Mirror, and Copy by
vector use the same grammar. FP-D15 attach exposes translate+rotate only.
**Derivation:** DESIGN-SYSTEM shared-controls rules; X5 drag/type symmetry; X1
exact-snap truth; X3 command parity; P5 one-entry gesture; DR-D1/DR-D12;
UIP-D14; FP-D15 explicitly requires a platform gizmo.
**Rejected:** app/tool-specific gizmos (gesture and precision drift); a gizmo
that commits directly to the viewer (ADR 0019 makes viewer journal migration-only).
**Tunable:** handle size/occlusion, snap increments, drag threshold (X6).

**SE-D2 — D2 placement: View selection tools plus contextual editing group.**
**Decision:** retire Select tab; Box/Lasso/Paste live View ▸ Selection; selected
entities reveal a contextual Selection group on the current domain tab and the
same entity-menu verbs.
**Derivation:** owner decision D2 explicitly remaps Select actions to contextual
surfaces + View; DESIGN-SYSTEM discoverability/context rules.
**Rejected:** permanent Edit tab (contradicts D2 taxonomy); context-menu-only
(hidden); placing transforms on Draw (violates draw §1 boundary).
**Tunable:** exact order and More-menu breakpoints.

**SE-D3 — Every transform changes placement, never source geometry.**
**Decision:** compose an affine delta into each exact baseline placement and
commit `SetPlacement`; point cloud/splat/raster/mesh/CAD buffers and coordinates
are untouched. Preview is one transient selection transform. Entity-specific
adapters may issue their already-owned canonical command with identical result.
The placement/entity version advances and every consumer follows §2.1.1:
VB-D3 bake suspension/rebuild with a placement-aware key, RA-D4 exact-revision
drape rebuild, MI-D3 anchor resolution, PE-D5 stale/pin lifecycle, and FP-D15
reference placement. The VB-D3 key change remains an owning-spec amendment.
**Derivation:** X1/X2; ADR 0016 placement semantics; ADR 0019 translation rule;
`entity_model.rs:383-397,1213-1220`; P4; FUNCTION-CONTRACT E2; VB-D3, RA-D4,
MI-D3, PE-D5, and FP-D15 under X7.
**Rejected:** rewriting vertices/points (expensive, changes source truth and
duplicates immutable data); viewer-owned commit (wrong authority).
**Tunable:** no.

**SE-D4 — Operation deltas avoid ambiguous matrix decomposition.**
**Decision:** fields describe the operation delta around a typed pivot. World
composition is `T(p) · Δ · T(-p) · baseline`; local composition applies Δ in
the entity basis. Local is available for one entity or an exactly common basis;
otherwise disabled with explanation. Zero/singular scale is invalid.
**Derivation:** X1; C1; affine matrix is canonical but decomposing arbitrary
negative/nonuniform/sheared matrices is non-unique.
**Rejected:** displaying guessed Euler/scale values as entity truth; silently
choosing the first entity's local axes for mixed selection.
**Tunable:** default basis (start World) and angle/scale snap increments.

**SE-D5 — Entity fences adopt the Pointcloud-built overlay and P4.**
**Decision:** one projection-true overlay module renders rectangle/polygon/
freehand contours; Pointcloud owns/builds it, Select-edit consumes it. Candidate
query excludes explicit hidden/clip state, includes naturally occluded geometry.
**Derivation:** PC review finding 14/PC-D2; P4; X7; DESIGN-SYSTEM tokens.
**Rejected:** a second selection overlay; depth-buffer-only selection (natural
occlusion would wrongly scope the act).
**Tunable:** fill opacity and simplification tolerance.

**SE-D6 — Fences select entities, never point subsets.**
**Decision:** any qualifying visible proxy contributes its stable entity id;
cloud/splat results are one entity with bbox highlight; organizational entities
without geometry are tree-only. Point masks stay Pointcloud.
**Derivation:** domain boundary; UIP-D15's click-only exclusion; PC-D1 mask
authority; X1 (no ambiguous partial cloud state).
**Rejected:** reusing point segmentation apply; excluding clouds entirely from
deliberate entity fences.
**Tunable:** Window/Crossing default.

**SE-D7 — Clipboard closure and the cross-project format prerequisite.**
**Decision:** clipboard captures exact entity/dependency closure. The current
contract is same-project only: an operation token pins exact objects and expires
on replacement, project close/replacement, or app shutdown. Default paste
starts placement; paste in place preserves coordinates. Cross-project exchange
and fragment commands remain cataloged-deferred; `PROJECT-FORMAT` now owns the
planned versioned manifest and operation-spool lifecycle, while an ADR and
implementation are still required. Once promoted,
identical CRS/units or an explicit previewed transform is required; dangerous
identity is separately labeled/provenanced, and FP-D15 Attach remains a
separate command rather than a fallback.
**Derivation:** X1/X3/X5; PROJECT-FORMAT immutable-store, archive, transactional
publication and no-silent-transform rules; REGISTRY F5b.
**Rejected:** unbounded JSON clipboard (large-data violation); geometry-only
copy (loses semantics); silent offset/reprojection.
**Tunable:** same-project token pin-memory threshold and future spool retention,
after the format defines the safe lifecycle.

**SE-D8 — Group is hierarchy, not reusable geometry or a transform parent.**
**Decision:** group creates `hcad.group@1`, reparents selected roots under the
lowest common owner, and preserves layers. Transform expands renderable
descendants; ungroup reparents direct children and deletes the empty group.
**Derivation:** ADR 0016 Group-vs-Block and owner authority; DATA-MODEL “one
canonical owner direction”; X1 owner-cycle validation.
**Rejected:** treating Group as Block (definition semantics); implicit transform
inheritance absent from the data model.
**Tunable:** generated group-name sequence.

**SE-D9 — Entity lock is a canonical edit-lock component with inherited effect.**
**Decision:** add versioned `hcad.component.edit-lock@1`; effective lock is true
when self, any owner ancestor, **or any effective layer** is locked. One
authoritative query returns `effectiveLocked` and all named causes; every
mutating UI/automation command invokes it before preparation. Entity and layer
lock commands change only their own source. Locked entities remain visible,
selectable, snappable, measurable, and copyable; other mutations fail whole.
Legacy `visibility.locked` projects the effective value only.
**Derivation:** X1/X3/X7; DR-D4 canonical layer lock; SYSTEM-001;
RIB HV visible-but-untouchable behavior (`dossiers/rib-civil.md` §2.3);
verified hard-coded legacy gap.
**Rejected:** renderer-local boolean; silently skipping locked members; making
locked reference geometry unsnappable (draw DR-D4 sibling rule).
**Tunable:** no.

**SE-D10 — Canonical hide and session isolate consume VD-D8/VD-D13.**
**Decision:** Hide/Show write only explicitly targeted canonical visibility;
Show is not a restore-all snapshot. Isolate is an independent session predicate
`{operationId, allowRoots}` above canonical visibility and independent session
hides. New/restored entities stay excluded unless admitted by id/allowed
ancestor; replacing isolate resolves from the full live universe. Exit removes
only that predicate. Project close/replacement/app shutdown clear it; panel and
selection changes do not. Neither Hide nor Isolate changes selection.
**Derivation:** C4 restore-scope rule; VD-D8/VD-D13; UIP-D18; P4; X1/X3/X7.
**Rejected:** reusing/clearing the merged renderer-local hidden set
(`App.tsx:153-176`); journaling temporary isolate; snapshotting current
visibility; deselect-on-hide.
**Tunable:** chip count/name truncation.

**SE-D11 — Multi-entity edits are all-or-none expected-revision transactions.**
**Decision:** capture exact refs at launch; any stale, locked, invalid, or
dependency-blocked member rejects the whole commit. Delete prunes selection at
journal apply; undo restores entities but not membership (UIP-D18). Delete
first consumes `entity.delete_plan`; owner adapters, protected-state rejection,
group subtree semantics, dependent-unresolved effects, and immutable-object
reachability are exactly §3.4/SE-D15.
**Derivation:** X1; canonical document atomic transaction and CAS
(`canonical_document.rs:210-219,313-345,513-553`); SYSTEM-001.
**Rejected:** best-effort partial batch; silent retry/rebase.
**Tunable:** preflight/job threshold.

**SE-D12 — Pattern, renumber, and selective history stay visible catalog rows.**
**Decision:** renumber ships as previewed whole-entity names; one-off linear/
radial/grid pattern and selective non-latest undo remain cataloged-deferred
until relation/history workflow promotion, carrying the registered FP-D14 obligation.
**Derivation:** RIB §2.1; RealWorks §2.1; FP-D14; CURRENT-DIRECTION completion
discipline prevents silent pruning without forcing speculative relation UI.
**Rejected:** omitting rows; pretending Revit generative arrays are ordinary
entity patterns.
**Tunable:** renumber defaults and pattern count caps.

**SE-D13 — Named continuous gates.**
**Decision:** G-SE-1 gizmo, G-SE-2 overlay, and G-SE-3 selection-query gates
use presented-frame-interval p95 ≤ 2× target frame time; transform input-to-
present p95 ≤ 50 ms and fence-result p95 ≤ 150 ms on tier hardware. Their
three exact scripts are **to be created** from
`scripts/benchmark-builder-viewing-box.mjs`; none is represented as present or
runnable now, and the behavior remains unverified until scripts plus verifier
routing exist.
**Derivation:** X2; P3/X6; VB-D7 metric class; contract D1.
**Rejected:** subjective “smooth”; render-body timing that misses presentation
jank; cloud-free fixtures.
**Tunable:** yes — 2×, 50 ms, 150 ms; metric remains presented interval.

**SE-D14 — One transform-capability query; intersection, never skip.**
**Decision:** `entity.transform_capabilities` and the matrix in §3.2 are the
single applicability source. Mixed-selection availability is the intersection;
unsupported members disable/reject the whole operation with names/reasons.
Scale/mirror on survey sources remain disabled until their semantic owner
specifies CRS and measurement effects.
**Derivation:** X1/X3/X7; FP-D15; MI-D6; Draw and viewing-box domain ownership;
FUNCTION-CONTRACT E2 extreme-member rule.
**Rejected:** assuming every affine envelope permits every affine operation;
UI-only filtering; silently skipping unsupported members.
**Tunable:** no.

**SE-D15 — Delete is a registry-fed plan, not a raw universal tombstone.**
**Decision:** `entity.delete_plan` resolves every selected kind, descendant and
dependent consequence through owner adapters before `entity.delete` commits.
The §3.4 matrix is binding; group deletion previews/deletes its subtree,
protected roots/defaults reject, domain artifacts use their remove/detach
semantics, and source-dependent measurements survive unresolved under MI-D3.
**Derivation:** X1/X3/X7; canonical owner invariant; MI-D3; UIP-D18;
FUNCTION-CONTRACT C4/E2; SYSTEM-001.
**Rejected:** raw tombstone for every kind; cascade deleting dependants; a
best-effort batch.
**Tunable:** preflight-to-job threshold only (X6).

**SE-D16 — Fence combine and hit rule are orthogonal.**
**Decision:** Box, freehand Lasso, and click-built Polygon use Combine
Replace/Add/Remove independently of Hit rule Window/Crossing. Freehand is a
Himmel:CAD/PC-D2 addition; Access evidence covers rectangle/polygon. Polygon
click, Backspace, Enter/double-click, and Escape are registered in §4.
**Derivation:** FUNCTION-CONTRACT C2/E2; X1 deterministic membership; X5;
Access evidence (`dossiers/trimble-perspective.md` §2.5 [S9]); PC-D2.
**Rejected:** one overloaded mode field; calling freehand behavior an Access
adoption; keyboard-only polygon completion.
**Tunable:** defaults and freehand sample simplification (X6).

**SE-D17 — Native additions and shortcut evidence stay honest.**
**Decision:** scale, mirror, whole-entity duplicate, entity lock, and isolate
are explicitly Himmel:CAD-native: scale/mirror complete validated placement
editing under SE-D14; duplicate is same-project copy symmetry; lock extends
DR-D4's canonical visible-but-untouchable class to entities; isolate is the
view-local P4/VD-D13 visibility predicate in SE-D10. Ctrl+C/V are tunable native
bindings, not RealWorks payload evidence. The consolidated Registry assigns the
shortcuts and F8's schema-verified dotted lower-case/`snake_case` automation
spelling; this catalog adopts both.
**Derivation:** X1/X3/X5/X6/X7; P4/P6; ADR 0016 placement; DR-D4; VD-D13;
DESIGN-SYSTEM discoverability/parity.
**Rejected:** inventing dossier support; deleting useful functions solely
because a reference row is absent; maintaining alternate bindings outside the registry.
**Tunable:** shortcuts and command spelling only.

**SE-D18 — Gizmo axes require shared theme semantics and non-color cues.**
**Decision:** the gizmo may not invent local colors. `@himmelcad/theme` must add
and export `--hc-axis-x`, `--hc-axis-y`, `--hc-axis-z`,
`--hc-axis-hover-outline`, and `--hc-axis-active-outline` with explicit light/
dark values. Dense-cloud/raster screenshots must show at least 3:1 tunable
graphical contrast against the sampled immediate background/halo, while X/Y/Z
glyphs and distinct handle silhouettes preserve meaning without color. Until
the shared tokens exist, E1 criterion 3 fails and implementation remains
unverified.
**Derivation:** AGENTS accessibility rule; DESIGN-SYSTEM token/shared-module
rules; X1; X6 contrast calibration.
**Rejected:** hard-coded gizmo CSS; color-only distinction; naming nonexistent
tokens as an existing reference.
**Tunable:** yes — token values and 3:1 threshold, never the non-color cues.

## 6. Verification plan (per `docs/TEST-TIERS.md`)

- **changed — `G-SE-CORE`:** Rust canonical tests for multi-entity
  SetPlacement/create/delete/reparent/lock/visibility transactions; stale ref,
  duplicate id, owner cycle, singular matrix and any-member-failure publish
  nothing; undo/redo exact effects; group/ungroup closure; point-cloud transform
  changes placement and zero geometry/object hashes; exact entity version
  advances; capability intersection; effective lock causes incl. layer;
  delete-plan extremes/adapters; VB/RA/MI/Plan/reference placement-consumer
  transitions. Fragment dependency/id remap and CRS/unit cases remain deferred
  until the format profile exists.
- **changed — `G-SE-UI`:** shared gizmo component tests for every mode's
  From/pivot pick/type parity, axis/plane/free constraints, DR-D12 priority and
  incompatible-snap rejection, drag↔type sync, frozen-pointer/two-Escape/
  trailing-pointer-up grammar, Mixed delta, capability profiles and reasons;
  effective-lock cause list; delete-plan counts; orthogonal fence controls;
  clipboard expiry; isolate/Show status; renumber preview.
- **push, viewer/viewport risk — `G-SE-INPUT`:** browser gesture table §4,
  pointercancel, off-handle orbit/select, on-handle capture, navigation rejection
  only during active drag, axis + snap + printable input + two Escapes + ignored
  trailing pointer-up, Up/Down candidate cycling/held override, Polygon click/
  Backspace/Enter/double-click, revision-change cancellation, zero journal writes
  before completion, exactly one entry after pointer-up or Enter, one-step undo.
- **push, viewer/viewport risk — `G-SE-P4`:** clipped+hidden mixed scene:
  Box/freehand/Polygon exercise all Combine modes and both Hit rules; return zero
  fully clipped/hidden entities, include naturally occluded entities, select a
  cloud once, never create a point mask; hide keeps membership; delete prunes;
  undo does not restore membership. Isolate tests independent session-hide
  writer, replacement from full universe, paste/restore during isolate, Show
  status, and Exit's exact affected-state set.
- **push / release always, capability `browser-gpu` — `G-SE-1`:**
  **to be created:** `scripts/bench-builder-transform-gizmo.mjs`, following
  `scripts/benchmark-builder-viewing-box.mjs`; self-launching; drag move/rotate/
  scale on 10,000 mixed entities including a streamed large cloud; assert
  SE-D13 interval/input bounds, zero point-buffer/object rewrites, zero stale
  preview frames, one journal entry, and every §2.1.1 transition. Missing
  `browser-gpu` must fail release routing, never report a skip.
- **push / release always, capability `browser-gpu` — `G-SE-2`:**
  **to be created:** `scripts/bench-builder-selection-overlay.mjs`, following
  the same template; rectangle and 2,000-sample lasso bursts; assert interval
  bound, stable contour/tint, no overlay jump or stale frame, and sampled
  overlay-to-membership agreement. Missing capability fails release routing.
- **release, capabilities `browser-gpu` + `real-data` — `G-SE-3`:**
  **to be created:** `scripts/bench-builder-entity-fence-query.mjs`, following
  the same template; billion-point cloud plus 100,000 CAD/BIM entities; assert
  fence-result p95 and exact deterministic CPU-oracle membership for every
  Combine/Hit-rule pair under clip/hidden/natural-occlusion states, with no
  overlay disagreement. Missing either capability fails rather than skips.
- **release, capabilities `browser-gpu` + `real-data` — `G-SE-REAL`:** move
  a real streamed cloud supporting a locked viewing box, draped raster,
  associative+fixed measurements, linked+pinned Plan captures, and an attached
  project reference. Assert every preview/commit/cancel state in §2.1.1,
  including one debounced locked-box rebuild and no stale artifact presented as
  current.
- **release, capability `real-data` — `G-SE-CLIPBOARD`:** same-project paste
  deduplicates object bytes; token survives source entity delete while pins are
  live, expires on replacement/project close/app exit, resists source GC, and
  copies an 80 GB cloud without point duplication.
- **deferred prerequisite — `G-SE-FRAGMENT`:** once an ADR admits and the runtime implements the
  PROJECT-FORMAT profile: pack/cancel/import, app restart/missing spool/source GC, unit-only and
  CRS mismatch, registered transform, dangerous identity provenance, separate
  Attach path, corrupt object/path traversal, crash before/after ready boundary.
- **automation — `G-SE-SDK`:** every cataloged non-deferred command is generated
  and callable; UI and SDK observe identical selection, targets, expected-ref
  failures, ids, placements, transform capabilities, delete plans, all lock
  causes, independent hide/isolate layers, and journal entry; mixed any-member
  rejection matches UI; SDK staleness gate runs once per TEST-TIERS.
- **manual/visual — `G-SE-E1`:** screenshots in both themes and at 100%/200%
  scale for every §7 state; compare only against §7 and existing in-repo
  `@himmelcad/ui`/selection surfaces.

Explicitly unverified until implementation: all three continuous gates (scripts
do not yet exist); shared axis token values (tokens do not yet exist);
subjective handle feel beyond the future gates; real touch hardware;
multi-monitor detached Transform panel; pattern and selective-history
workflows; all cross-project fragment behavior until the planned profile is admitted and implemented.
These are not claimed implemented or verified; they do not reopen the clean
registry status.

## 7. E1 visual and behavioral criteria (failable, in-repo)

1. **Fence overlay:** Box/Lasso use only shared `--hc-*` selection tokens, a
   stable 1 px contour and restrained fill; no hard-coded color, gradient, or
   pointcloud-specific duplicate CSS. Pass in both themes over dense points.
2. **Fence truth:** overlay and final membership agree in scripted samples;
   clipped/hidden proxies never tint as eligible; natural occlusion causes no
   depth-dependent membership flicker.
3. **Gizmo silhouette:** axes use the future shared `--hc-axis-x/y/z` plus
   `--hc-axis-hover-outline`/`--hc-axis-active-outline` tokens, with explicit
   values in both themes and exports from `@himmelcad/theme`. G-SE-E1 records
   the computed token values and sampled ≥3:1 handle/halo contrast over dense
   cloud and raster scenes. X/Y/Z glyphs and distinct axis/plane/center
   silhouettes remain understandable in color-deficiency simulation at
   100%/200%; handles never hide the pivot and have ≥16 px hit targets without
   an invisible hit area stealing off-handle orbit. The criterion fails while
   those shared tokens are absent.
4. **Active feedback:** hovered/active handle and affected axis/plane are
   unmistakable; no handle jumps between consecutive G-SE-1 samples; pointer
   stays attached to the dragged handle.
5. **Numeric parity:** panel always names Mode, Basis, Applies to N, Pivot, and
   the current operation fields; typed and dragged screenshots show identical
   values/units at project precision; Mixed is never shown as a fake zero.
6. **Preview vs commit:** preview uses neutral ghost/elevation, not selected
   accent fill; stale/cancelled preview disappears in the next presented frame;
   committed geometry returns to ordinary selection styling.
7. **Paste placement:** ghost carries “Paste N entities” and source project;
   paste-in-place has no ghost and toast copy says “Pasted in place”; neither
   uses a fabricated offset.
8. **Progress/failure:** while the fragment profile is unimplemented, both fragment
   entries show the disabled prerequisite copy from §2.3. After promotion,
   jobs show real phase/bytes/files through UIP-D10; mismatch copy names source/
   target CRS and units and does not imply a transform was chosen.
9. **Group/lock:** tree shows group nesting immediately; effective lock glyph is
   visible on self and inherited descendants, with tooltip listing every cause,
   including “Locked here”, “Locked by Facade west”, and “Locked by layer
   Existing survey”.
10. **Batch consequence:** destructive/renumber surfaces state exact direct,
    descendant, dependent-unresolved, hidden-excluded, protected, and lock-
    blocking counts before commit; no generic “Are you sure?” dialog for
    ordinary undoable delete.
11. **Isolate:** persistent viewport chip reads “Isolated: N” with **Exit**;
    it survives panel/ribbon changes, takes no Escape rung, and disappears in
    the first frame after exit/project replace. A canonical Show that remains
    isolate-hidden displays the exact §3.5 status and Exit action.
12. **Placement dependants:** moving the real-data cloud never shows an old
    locked-box bake as current; **Rebuilding locked box**, stale drape
    suppression, recomputed/unresolved measurement, Plan **Stale**, and attached-
    reference placement states match §2.1.1 in the same captured sequence.

## 8. Current implementation delta

**Exists and stays:** canonical entity placement and `hcad.group@1` model;
exact revision/hash refs; atomic create/update/delete/restore transactions;
generic writable Name/Owner/Placement properties; renderer placement-aware
compilation, tile selection, clipping and picking; transient buffer-sharing
translation ghost; tree selection and local visibility toggling.

**Changes:** Select tab buttons move to View and gain handlers; selection store
adopts UIP-D15–D18 before fences consume it; move preview commits through the
canonical document rather than the ADR-0019 migration viewer journal; current
merged/local visibility splits into VD-D8/D13 canonical and session layers;
`visibility.locked` becomes a projection of canonical effective lock including
layer causes, not a hard-coded false; command registry eventually supplies
ribbon/context/console/automation after the registry-owner reconciliation.

**New:** shared transform gizmo and adapters; transform-capability query;
rotation/scale/mirror and multi-selection preview; entity fence query over the
Pointcloud-built overlay; same-project clipboard/paste/paste-in-place and
duplicate; delete-plan query plus delete/group/ungroup/lock/visibility/isolate/
renumber commands; independent isolate predicate and persistent chip; named
gate contracts and E1 review states.

**To be created before implementation/release promotion:**

- `scripts/bench-builder-transform-gizmo.mjs`,
  `scripts/bench-builder-selection-overlay.mjs`, and
  `scripts/bench-builder-entity-fence-query.mjs`, using
  `scripts/benchmark-builder-viewing-box.mjs` as the self-launching template,
  plus `browser-gpu`/`real-data` verifier routing that fails missing capability;
- shared light/dark `--hc-axis-x/y/z`, hover, and active tokens exported by
  `@himmelcad/theme`, with G-SE-E1 checks;
- all non-deferred REGISTRY rows, shortcut/gesture entries, F2/F5b closure,
  F8 command-name normalization, and a clean consistency report.

**Cataloged-deferred external prerequisite:** cross-project fragment pack/
import and clipboard exchange. The versioned profile is planned in
`docs/PROJECT-FORMAT.md`; schema admission and implementation remain outside the
current implementation delta.

## 9. Owner-decision items

None. The required escalation protocol dissolves every candidate: D2 resolves
View/contextual placement (SE-D2); X1/X2 plus ADRs 0016/0019 resolve cloud
placement without point rewrites (SE-D3); X3/P1 make lock canonical (SE-D9);
VD-D13/UIP-D3 make isolate session-only (SE-D10); X1, PROJECT-FORMAT and FP-D15
resolve same-project behavior and require cross-project deferral until the
format owner adds its manifest (SE-D7); C4 dissolves Exit restore scope into the
isolated predicate alone; X6/P3 delegate measurable smoothness while the absent
scripts keep implementation unverified (SE-D13); X1/X7 and owner adapters resolve mixed
transform capability and deletion plans without guessing (SE-D14/SE-D15);
C2/X5 plus Access/PC-D2 resolve fence modes (SE-D16); contract A2 and doctrine
auditability make native-vs-reference labeling mandatory (SE-D17); and the
DESIGN-SYSTEM shared-token/accessibility rules plus X6 resolve axis semantics
without choosing local chrome (SE-D18). Registry and sibling-source amendments
are owner-of-record work under the cite-and-revise rule, not owner questions.
No candidate exposes an axiom conflict, reserved owner boundary, or product-
identity question. Zero owner-decision items remain.

## 10. Disposition — demanding-user review 2026-09-02

| Finding     | Disposition                                                                                                                                                                                                                                                                                                                                    | Spec section / decision                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1 (blocker) | **Resolved reciprocally.** Placement increments the exact consumed entity version; locked bake preview/rebuild, drape, measurement, Plan capture, and attached-reference rules are enumerated; VB-D3 now carries the exact revision and preview suspend/rebuild boundary.                                                                      | §2.1.1, §3.2 E2, SE-D3, VB-D3, G-SE-CORE/G-SE-1, criterion 12  |
| 2 (blocker) | **Resolved.** Gizmo is keystroke-complete: From/pivot, axis/plane/free constraints, exact incompatible-snap rejection, DR-D12 priority/override, typed-during-drag capture transfer, UIP-D14 ladder, trailing pointer-up suppression, and one-entry undo.                                                                                      | §2.1, §3.2 C1/C4, §4, SE-D1, G-SE-INPUT                        |
| 3 (blocker) | **Resolved at specification level; implementation evidence pending.** The absent scripts are not cited as runnable; exact paths are marked **to be created** and template/routing/fail-not-skip behavior is specified.                                                                                                                         | opening status, §3.1/3.2 D1, SE-D13, §6, §8                    |
| 4 (blocker) | **Resolved by scope-safe deferral.** Current clipboard is same-project with exact lifetime/GC pins. Cross-project exchange is disabled and cataloged-deferred pending the owning format profile; future manifest, spool, CRS/unit, identity, Attach separation, cancellation and recovery rules are fixed without claiming an artifact exists. | catalog, §1.1, §2.3, §3.3, SE-D7, G-SE-CLIPBOARD/G-SE-FRAGMENT |
| 5 (blocker) | **Resolved.** The consolidated registry contains the rows, gesture and shortcut assignments, closes F2/F5b/F8, and uses the schema convention. The fragment implementation, runnable benchmarks, and shared tokens remain implementation deltas.                                                                                               | opening status, catalog note, §1.3, SE-D17, §8                 |
| 6 (major)   | **Resolved.** One canonical capability query, mixed-selection intersection, no skipping, and an initial owner-adapter matrix cover project references, boxes, measurements, Draw content, groups, survey sources, roots, and screen-sized labels.                                                                                              | §3.2 E2, SE-D14, G-SE-CORE/UI/SDK                              |
| 7 (major)   | **Resolved.** Isolate is an independent allow-root predicate with operation identity; Exit removes only it, new/restored entities are scoped, replacement uses the full universe, independent hides survive, and Show reports remaining isolate scope.                                                                                         | §1.1, §3.5, SE-D10, G-SE-P4, criterion 11                      |
| 8 (major)   | **Resolved.** Entity self/ancestor and effective layer locks feed one command-layer predicate with all causes; source-specific unlock cannot mask remaining causes; UI/SDK parity is required.                                                                                                                                                 | §3.4 C2/C3/E2, SE-D9, G-SE-CORE/UI/SDK, criterion 9            |
| 9 (major)   | **Resolved.** Registry-fed delete plans define group subtree, protected state, domain adapters, dependent-unresolved behavior, exact preflight counts, object reachability, undo and selection effects.                                                                                                                                        | §3.4 E2, SE-D11/SE-D15, G-SE-CORE/UI, criterion 10             |
| 10 (major)  | **Resolved.** The false Ctrl+C/V adoption is withdrawn. Scale, mirror, duplicate, lock, and isolate are explicitly native with repo-resident doctrine/sibling derivations rather than invented dossier evidence; status no longer claims research completeness.                                                                                | opening status, §1.2, §3.2/3.3 A2, SE-D17                      |
| 11 (major)  | **Resolved.** Combine and Hit rule are orthogonal for Box/freehand/Polygon; accessible Polygon gestures and the Access-vs-freehand evidence boundary are explicit and tested.                                                                                                                                                                  | §2.2, §3.1, §4, SE-D16, G-SE-P4                                |
| 12 (minor)  | **Resolved.** Placement schema evidence is distinguished from actual exact-target/revision validation with corrected citations.                                                                                                                                                                                                                | `edit.move` catalog row                                        |
| 13 (minor)  | **Resolved at specification level; implementation evidence pending.** Exact future shared token ids, theme/export/non-color/contrast requirements and implementation work are named; absent tokens fail E1 and block an implemented/verified claim.                                                                                            | opening status, SE-D18, §6 G-SE-E1, criterion 3, §8            |

## Cross-spec reconciliation 2026-09-02

| Item                   | Disposition                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File attach            | FP-D15 cites SE-D1 as the shared gizmo and supplies its translate/rotate adapter.                                                                                                                                             |
| UI quick surface       | UIP-D13 activates `edit.clipboard.paste_in_place` through the command registry.                                                                                                                                               |
| Viewing-box bake       | VB-D3 keys exact source/placement revision and suspends/rebuilds during SE-D1 previews.                                                                                                                                       |
| Measure/BIM            | Measurements route only to MI-D6 anchors/plane; BIM-generated object transforms follow BS-D20/BS-D21 placement-override/regeneration rules.                                                                                   |
| Civil/P10 invalidation | SE-D20 emits the typed invalidation set once at gesture end; CIV-D15, DR-D20, RA-D15, BS-D24, and MT-D25 consume it and selection never regenerates a sibling product.                                                        |
| Fragment/data model    | `docs/PROJECT-FORMAT.md` now contains the transactional `.hcadx` fragment profile; REGISTRY §4.4 mirrors the edit-lock and segment-locator pending admissions without writing an ADR.                                         |
| Semantic cursor        | Select/Edit cites UIP-D24/§9.7 and declares pick, move/rotate/scale handles, prohibited, and wait; a target appears only through an owning transform adapter.                                                                 |
| GAP §6 Civil inbound   | SE-D3/SE-D9/SE-D10 are amended by SE-D19/SE-D20 citations to CIV-D2–CIV-D12/CIV-D15 for P9 eligibility and one gesture-end invalidation graph.                                                                                |
| Re-walk 2026-09-02     | P5/P6 and current C4/D1/X3/B1/A2 are explicit. P7: renumber/layer/default naming remains an editable mechanism/default, not an office mandate. The README registry gate is clean; SE-D13/SE-D18 remain implementation deltas. |

## Owner statements batch 2 — 2026-09-02

This section amends C2/E2 and SE-D3/D9/D10. One resolver computes effective P9
state from entity, ancestors, layer, kind, cloud class, attached project, session
isolate, and global overlays. Precedence is Hidden (not rendered/candidate), Inert
(rendered, no select/snap/edit), Reference (rendered/selectable/snappable, no edit),
then Editable; the query returns every cause and the command layer rechecks it.
There is no second lock/visibility store.

Support geometry is an explicit Draw role shown by UIP-D21 and included/excluded by
the Support overlay without changing the role. Eligible BIM anchor/corner/edge refs
come from BS-D23; heavy components remain bounded. Whole/Segments and selectable-
kind filters are view-local selection modes. A segment selection token is
`{parent_id,parent_revision,locator}`; source change either deterministically remaps
the same semantic segment with disclosure or prunes it, never selects a neighbor.
Selection has its own bounded/coalesced history and explicit undo/redo query/actions;
Ctrl+Z never targets it.

Civil consumers join SE-D3 invalidation: alignment/edge transforms invalidate
profiles, station labels, corridor previews/surfaces, fit drafts, and Mesh hand-off
manifests at gesture end; slope/base and BIM face changes invalidate slope/pit
recipes. P10 determines live versus Stale and regeneration; selection never runs
domain regeneration itself.

Registry entries applied by the round-3 rebuild: `selection.granularity`,
`selection.kind-filter`, `selection.history`, and `interaction.state-explain`
expose `selection.granularity.get/set`, `selection.kind_filter.get/set`,
`selection.history.get/undo/redo/clear`, and canonical
`interaction.state.explain`; `selection.effective_state.explain` is a deprecated
compatibility alias only. Segment-aware edit commands carry the token but remain
their owning Draw/BIM/domain acts.

**SE-D19 — One effective-state resolver owns membership eligibility.** **Decision:**
the resolver, cause explanation, support/BIM eligibility, segment token lifecycle,
kind filter, and separate selection history above supersede “selection is not
undoable.” **Derivation:** P8, P9, S2/S3/S5, G3/G5/G6, X1, X3,
UIP-D19–D21, Draw DR-D18, BS-D23. **Rejected:** per-tool lock tests; exploded
polyline geometry; context-sensitive Ctrl+Z. **Tunable:** selection-history depth
and eligible-component LOD budget.

**SE-D20 — Civil edits invalidate typed consumers at gesture end.** **Decision:**
SE-D3 emits the invalidation set above once per committed gesture; owning domains
apply P10 and preserve last-good results. **Derivation:** P5, P10, Civil
CIV-D2–D12, MT-D25, X1. **Rejected:** mid-drag regeneration; selection-owned
rebuilds; silent stale consumers. **Tunable:** no.

Verification covers every P9 source and precedence pair, cause text, reference/inert
command refusal, 100,000-node bulk state, support overlays, BIM LOD manifests,
segment remap/prune, kind filters, selection undo independent of document undo, and
all Civil invalidation consumers. Cursor declarations: pick/snap/Fangkreis,
move/rotate/scale handles, Shared3DTarget, prohibited, and wait; no local glyphs.

| Work-order item                                        | Disposition                         |
| ------------------------------------------------------ | ----------------------------------- |
| S2/S3/S5 G3/G5/G6 resolver/support/granularity/history | Applied by SE-D19.                  |
| S7–S9/G9 Civil consumer invalidations                  | Applied by SE-D20.                  |
| S13/G11 cursor declaration                             | Applied as a UIP-D24/§9.7 consumer. |
