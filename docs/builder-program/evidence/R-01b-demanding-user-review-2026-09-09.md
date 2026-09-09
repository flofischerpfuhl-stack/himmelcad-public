# R-01b demanding-user review — post-R-02 visible-UI rerun

Date: 2026-09-09  
Reviewer stance: demanding survey/Civil CAD user (15 years of Trimble RealWorks, RIB Civil/STRATIS, Revit and Perspective)  
Review snapshot: `4535681` at review start, containing R-02 commit `99ea7a8`  
Result: **FAIL — R-02 restores the general LAS front door, but both Release 0.5 user spines still stop before ground extraction.**

## 1. Scope, method and machine state

I read R-01 and R-02 first, then the accepted direction and authoritative
records for M-0.5, project replacement, import/registration, Viewing Box,
point-cloud operations, drawing, terrain/DGM, measurement, export, visible
feedback and the RealWorks/RIB reference workflows. I repeated the R-01
scan-first and boundary-first intents through visible Builder UI only. Product
console commands, canonical/sidecar calls, the Python SDK and automation
protocol were not used. The V-01b Electron CDP path and native X11 input were
used only as pointing, typing and screenshot machinery for the visible UI.

The in-app browser runtime had no attachable browser. I therefore used the
documented V-01b fallback: Builder on `DISPLAY=:0`, CDP for DOM-visible controls,
native X11 input for OS dialogs and viewport pointing, and root-window captures.
Builder was launched with `pnpm --filter @himmelcad/builder dev`.

Target source:
`libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las`
(3,111,413,830 bytes; 103,713,735 points). The prepared hierarchy under
`.build/perf/viewer-baseline-datasets/` remained present and read-only. The
source remained unchanged.

At 20:59:50 CEST, before starting Builder:

```text
uptime: 3 days, 19:30; load average 2.14, 1.72, 4.00
memory: 31 GiB total, 4 GiB used, 16 GiB free, 26 GiB available
swap: 1 GiB total, 1 GiB used
```

The initial load was below 6, so the rerun proceeded as instructed. No COLMAP
or PhotoLab A7 process was visible at that gate. Heavy unrelated work appeared
after the import had begun: a PhotoLab Rust test build, the Windows COLMAP
cross-build and a separate headless-browser lane. At 21:52 the load average was
`16.67, 16.50, 16.32`; at 22:09 it was `11.45, 12.26, 14.39`. Memory remained
adequate (23–24 GiB available). Consequently all timings below are
**informational only**. Reachability, copy, state transitions, cancellation and
data-integrity failures do not depend on those timing numbers.

The live review ran from 20:59 to 22:10 CEST, inside the four-hour hard stop.
One initial native-picker attempt used an incorrectly synthesized path on the
German keyboard and was cancelled. It is excluded from product findings. The
correct picker attempt and every subsequent action are the evidence below.

## 2. Executed step record

“Blocked” means I did not inject data, invoke hidden commands or substitute a
fixture after a visible prerequisite failed.

### Pass 1 — scan-first intent

| Step | Works through UI? | Observed time | Screenshot | What I tried, exact response and friction |
|---|---:|---:|---|---|
| Start Builder | Partial | about 5 s | [existing project](../../../.build/r01b/00-start.png) | Builder again opened the mutable `r01-review-pass1` project rather than a safe start surface. |
| Create clean project | **No** | about 32 s to submit; >10 s blank; about 2 min to restart | [native New dialog](../../../.build/r01b/01-new-project-dialog.png), [blank renderer](../../../.build/r01b/03-new-project-alive.png), [still blank](../../../.build/r01b/04-new-project-still-blank-10s.png), [relaunch](../../../.build/r01b/05-relaunch-after-new.png) | File → New accepted `/home/oem/Dokumente/r01b-scan-first.hcad`, then the entire renderer became empty. No typed failure, old-project recovery or **Retry open** appeared; normal close did not finish. The target file was not created. Restart reopened the old project. This directly regresses R-02 P0-2. |
| Open the general import route | **Yes** | about 5 s | [File ribbon](../../../.build/r01b/06-import-menu.png), [native picker](../../../.build/r01b/07-import-picker.png) | File → **Import…** now opens a normal multi-file picker. The named LAS can be selected. R-01 B-01's missing front door is fixed. |
| Resolve registration input | **Yes** | about 1 min | [needs input](../../../.build/r01b/09-road-las-needs-input.png), [choice accepted](../../../.build/r01b/11-placement-after-click.png), [registration ready](../../../.build/r01b/27-import-progress.png) | The wizard showed **“Point cloud detected”**, **“LAS/LAZ to Potree 2”**, **“Transform coordinates?”** and the four transform choices. I chose **“No transformation”**. The commit screen truthfully showed **“CRS: EPSG:31466 · offset 0 0 0 · source units Not declared”** and **“ready to commit”**. `Check placement` was disabled until a transform choice, but no visual placement preview was presented before commit. |
| Prepare hierarchy | Partial | 1,893 s total import; heavily contended | [early progress](../../../.build/r01b/15-import-progress-contended.png), [late progress](../../../.build/r01b/27-import-progress.png) | A visible cancellable job reported **“Preparing hierarchy · hashing prepared dataset: octree.bin”**. This is a material improvement over R-01. Progress advanced under load, but a job still labelled **Needs input** while background work was running. |
| Commit/register/publish | Partial | 807 s commit; heavily contended | [commit begins](../../../.build/r01b/28-import-commit-result.png), [99%](../../../.build/r01b/44-import-publish.png), [tree published](../../../.build/r01b/45-import-publish.png), [completion](../../../.build/r01b/46-first-frame-wait.png) | Publication was atomic: `Clouds: 0` remained until the final publish, then the tree showed the named cloud and **103.7 M**. Visible byte counters reset between sub-phases and overall progress held at 94–99%, making the remaining work hard to interpret. Console copy reported **“Registered import committed and loaded”** and **“Import … completed · 1893.0 s”**. |
| See and frame the imported road | **No** | >4 min of visible checks | [old box active](../../../.build/r01b/47-viewing-box-old-active.png), [box removed](../../../.build/r01b/49-cloud-after-box-remove.png), [Frame All](../../../.build/r01b/51-frame-all-result.png), [HUD](../../../.build/r01b/52-hud-cloud-blank.png), [context Zoom to](../../../.build/r01b/60-zoom-to-cloud.png) | An old persisted Viewing Box initially clipped the new source. I removed it. The full cloud remained visually blank after Frame All and the cloud context-menu **Zoom to**. The tree said 103.7 M, the status said `Clouds: 1`, and the HUD reported about `0.1 M pts` with backlog 0, so this is not merely an empty registration result. There was no rendered road on which to judge fluid navigation or color. |
| Select the imported cloud | **No** | about 2 min | [selection remains zero](../../../.build/r01b/67-cloud-selected.png), [context menu](../../../.build/r01b/59-cloud-context-menu.png) | Clicking the visible tree row repeatedly left **“Selected: 0”** and the Properties panel at **“Select one or more entities…”**. Its context menu exposed Zoom, measurements, Export, Display properties, Extract ground, Sample, Rasterize, Segment and Create surface, but selection never became canonical UI state. |
| Change display/background | **No** | about 1 min | [Color Mode placeholder](../../../.build/r01b/56-cloud-selected-properties.png), [Background attempt](../../../.build/r01b/54-background-control.png) | View → Color Mode opened **“FUNCTION view color mode”** with **“Parameters for view.color-mode appear here once the function ships.”** Background likewise had no usable control. These live placeholders contradict the shipped View workflow and offer no recovery for the invisible scan. |
| Place/edit a Viewing Box | Partial | about 2 min | [picked in the blank view](../../../.build/r01b/72-viewing-box-click-blank-scan.png), [editor](../../../.build/r01b/74-viewing-box-selected.png), [10 m extents](../../../.build/r01b/77-viewing-box-small-extents.png) | A viewport click placed **“Viewing Box 1”** and console copy said **“Viewing Box placed (232.61 m cube at the current zoom).”** I reduced it using the visible HUD coordinate to a deliberate 10 m test cube. The editor still exposes raw Min/Max only, retains **Save as entity**, and lacks the accepted Center/Size/Rotation/named-box flow. |
| Lock Viewing Box | **No** | 67 s initial cube; 114 s bounded cube, both cancelled | [initial lock](../../../.build/r01b/75-viewing-box-locked.png), [10 m lock at 0%](../../../.build/r01b/80-small-lock-progress-70s.png) | Lock showed **“Preparing resident dataset”**, `0%`, **“Cancel bake”** and a bottom job chip. The first 232.61 m cube was cancelled after 67 s. The deliberately bounded 10 m cube still showed 0% after 70 s and was cancelled at 114 s. Cancellation completed with visible toast/console copy. Load invalidates speed judgement, but progress never left zero and the box never reached locked state. |
| Extract ground | **No** | immediate UI probe | [ribbon action](../../../.build/r01b/85-scan-extract-no-selection.png) | The button looked available. Clicking it with the published cloud and **Selected: 0** did nothing: no panel, disabled reason, selection guidance or toast. The context-menu action also did nothing. |
| Segment/clean | **No** | immediate UI probe | [Segment](../../../.build/r01b/86-scan-segment-no-selection.png) | Same silent result. The invisible/unselectable source and uncompleted lock prevent the promised clean/classify step. |
| Sample / rasterize | **No** | immediate UI probes | [Sample](../../../.build/r01b/87-scan-sample-no-selection.png), [Rasterize](../../../.build/r01b/88-rasterize-no-selection.png) | Both commands remained visually available and produced no panel or prerequisite explanation. |
| Create/check/fix DGM | **No** | about 1 min | [Create surface](../../../.build/r01b/92-file-export-menu.png) | Mesh → Create surface opened **“Create surface — DGM · checked TIN”**. Sources said **“Select points, clouds, grids, or polylines.”** Check results said **“0 errors · 0 fixable”** and **“Run Check before publishing.”** With no selectable source, Check/Create could not produce a DGM. Edit surface was therefore blocked. |
| Export DXF/LandXML | **No** | about 1 min | [export panel](../../../.build/r01b/94-export-panel.png), [disabled formats](../../../.build/r01b/95-export-formats.png) | File → Export is reachable and honestly says **“The current scope has no entity kind supported by an installed exporter.”** DXF/LandXML/IFC/GeoTIFF/splat are listed, but LandXML is disabled because no DGM exists. |
| Measurement basics | **No** | about 1 min | [typed point](../../../.build/r01b/70-measure-typed-enter.png) | Inspect → Point accepted the visible HUD coordinate, rendered a blue marker, but saved no measurement. Each Enter produced **`Measurement failed … canonical entity EntityId("default-layer") already exists or is tombstoned`**. This is more explicit than R-01's silence, but the operation still fails. |

### Pass 2 — pilot-office boundary-first intent

New could not create a separate clean project, so—as in R-01—the second intent
had to reuse the review project. The existing pass-1 box is not counted as a
successful boundary-first box step.

| Step | Works through UI? | Observed time | Screenshot | What happened |
|---|---:|---:|---|---|
| Start Boundary polygon | Yes, tool opens | about 20 s | [Draw ribbon](../../../.build/r01b/81-boundary-first-draw-ribbon.png), [tool panel](../../../.build/r01b/82-boundary-armed.png) | The panel exposes Role **Boundary**, six icon-only snap controls, live polar, Vertices, Finish, Close, Undo vertex and Cancel. The bottom prompt is clipped. |
| Type the first site-boundary coordinate | **No** | about 35 s | [typed failure](../../../.build/r01b/83-boundary-first-vertex.png) | Moving through X/Y/Z created an unintended partial vertex `2538126.000 0.000 0.000` before the complete coordinate, then displayed **`canonical entity EntityId("default-layer") already exists or is tombstoned`**. Exact-entry focus/commit behavior is unsafe, and the R-01 canonical collision remains. |
| Place boundary by viewport | **No** | about 25 s | [four visible picks, zero vertices](../../../.build/r01b/84-boundary-four-view-picks.png) | After cancelling and restarting the tool, four visible viewport picks left **Vertices 0**. The scan was invisible and the UI gave no “no pick surface” reason. |
| Close/store boundary | **No** | blocked | [zero vertices](../../../.build/r01b/84-boundary-four-view-picks.png) | Finish/Close stayed unavailable. No boundary entity was stored. |
| Box-lock after boundary | **No** | blocked at boundary | [boundary failure](../../../.build/r01b/83-boundary-first-vertex.png) | A boundary-first box cannot be derived or validated without the boundary. The pass-1 box's resident bake also never left 0%. |
| Extract ground | **No** | blocked | [silent Extract](../../../.build/r01b/85-scan-extract-no-selection.png) | The cloud cannot be selected and the boundary/locked region does not exist. |
| Create/edit DGM | **No** | blocked | [no eligible source](../../../.build/r01b/92-file-export-menu.png) | The DGM dialog is discoverable but has no valid source and no boundary. |
| Export LandXML | **No** | blocked | [LandXML disabled](../../../.build/r01b/95-export-formats.png) | The exporter is discoverable but disabled because no DGM exists. No output was written. |

## 3. Diff against every R-01 finding

Status compares the live R-01b product behavior with the original R-01
finding, not merely with R-02's implementation claim.

| R-01 finding | R-01b status | Visible evidence and assessment |
|---|---|---|
| B-01 — general LAS import unreachable | **Fixed** | File → Import opens the native general picker; the named LAS reaches a typed registration wizard and is published as a 103.7 M-point entity. [Picker](../../../.build/r01b/07-import-picker.png), [wizard](../../../.build/r01b/09-road-las-needs-input.png), [published tree](../../../.build/r01b/46-first-frame-wait.png). A new post-import rendering blocker replaces the old front-door blocker. |
| B-02 — New blanks the renderer | **Regressed** | The exact blank-shell failure recurred. There was no typed failure, preserved old project or Retry action, and the target was not created. [Blank](../../../.build/r01b/03-new-project-alive.png), [still blank](../../../.build/r01b/04-new-project-still-blank-10s.png). |
| B-03 — default-layer collision blocks boundary | **Still open (R-02 regression on persisted-project lifecycle)** | Boundary and fixed-coordinate measurement both hit `EntityId("default-layer") already exists or is tombstoned`. [Boundary](../../../.build/r01b/83-boundary-first-vertex.png), [measurement](../../../.build/r01b/70-measure-typed-enter.png). R-02's clean-project test does not cover this persisted R-01 project state. |
| B-04 — whole real-data acceptance spine unqualified | **Still open** | Import now runs, but the named road never becomes visible/selectable and both spines stop before ground extraction. Lock stays at 0%; DGM and LandXML have no source. |
| D-01 — Viewing Box persistence contradicts “immediately canonical” | **Still open** | Placement creates a tree node, yet the editor still exposes **Save as entity** without explaining whether it duplicates or persists. [Editor](../../../.build/r01b/74-viewing-box-selected.png). |
| D-02 — raw Min/Max instead of accepted box editor/management | **Still open** | Only six Min/Max fields are present; Center/Size/Rotation and a coherent named-box/new-box flow are absent. [Editor](../../../.build/r01b/74-viewing-box-selected.png). |
| D-03 — Lock reports success with zero clouds | **Still open / not requalified** | New could not supply a zero-cloud project, so the exact empty-cloud case could not be cleanly repeated. With one real cloud, Lock instead stayed at **Preparing resident dataset 0%** until cancellation. [0%](../../../.build/r01b/80-small-lock-progress-70s.png). There is no evidence to close D-03. |
| D-04 — HUD samples/close behavior | **Still open** | The HUD reports plausible point counts but still lacks its own visible close control. It also spiked to `1030.6 ms p95` during tools; load makes that timing non-diagnostic. [HUD](../../../.build/r01b/72-viewing-box-click-blank-scan.png). |
| D-05 — unavailable actions fail silently | **Still open** | Extract, Segment, Sample and Rasterize accept clicks with the cloud present but unselected and produce no reason. Four boundary picks also leave zero vertices without guidance. [Rasterize](../../../.build/r01b/88-rasterize-no-selection.png), [boundary](../../../.build/r01b/84-boundary-four-view-picks.png). |
| D-06 — typed Measure Point does not create measurement | **Regressed** | The operation now emits a canonical error and draws a transient marker, but still stores zero measurements. The failure is the supposedly repaired default-layer lifecycle. [Typed point](../../../.build/r01b/70-measure-typed-enter.png). |
| D-07 — clipped/colliding core controls | **Still open** | Pointcloud labels still touch, the bottom construction prompt truncates, right-panel labels/values clip, and the Console brand remains visually corrupt/oversized. [Pointcloud](../../../.build/r01b/65-pointcloud-ribbon.png), [boundary](../../../.build/r01b/84-boundary-four-view-picks.png). |
| F-01 — no empty-project import CTA | **Still open / clean state unreachable** | New blanks before a clean empty state can be evaluated. No R-02 change or R-01b evidence closes the missing CTA. |
| F-02 — pointcloud prerequisites hidden | **Still open** | Commands look available while `Selected: 0`; clicking them is silent. [Pointcloud ribbon](../../../.build/r01b/65-pointcloud-ribbon.png), [silent action](../../../.build/r01b/85-scan-extract-no-selection.png). |
| F-03 — snap controls are icon-only | **Still open** | Boundary still presents six unlabeled icon toggles with no active snap names/candidate source in the construction bar. [Boundary panel](../../../.build/r01b/82-boundary-armed.png). |
| F-04 — unsafe auto-open of mutable work | **Still open** | Builder opened `r01-review-pass1` automatically; New then failed, so the user again had no safe clean start. [Start](../../../.build/r01b/00-start.png), [relaunch](../../../.build/r01b/05-relaunch-after-new.png). |

The R-01 persona's top three gaps therefore change only slightly:

1. The **scan front door is now present**, but dependable scan intake is still
   missing because a published 103.7 M-point cloud is invisible and
   unselectable.
2. The coherent **Limit Box → clean/classify → sample/raster** flow is still
   missing: box Lock does not complete, cloud commands have silent predicates,
   and no ground result can be produced.
3. The trustworthy **boundary/breakline → checked DGM → edit → LandXML** loop is
   still absent because exact boundary entry collides with canonical layer
   state and pointer entry has no pickable road.

## 4. New R-01b findings

| ID | Class / severity | Finding | Contract/spec impact | Proposed resolution |
|---|---|---|---|---|
| N-01 | **Blocker** | The named 103.7 M-point LAS publishes into the tree but is visually blank after removing the old clip, Frame All and context Zoom to. HUD says about 0.1 M points and backlog 0. | M-0.5 real-scan visible workflow; View/renderer LOD continuity and first-frame truth; Pointcloud visible source requirement. | **Fix code.** Reproduce with this exact imported entity and persisted project. Gate publish on an actually visible first frame, or show a typed renderer/source error rather than “committed and loaded.” Add screenshot/pixel evidence to the real-road gate. |
| N-02 | **Blocker** | The published cloud row cannot enter selection state: clicks leave `aria-selected=false`, **Selected: 0** and empty Properties. Downstream ribbon and context actions therefore have no source. | Function Contract selection predicates; Pointcloud source workflows; M-0.5 reachability. | **Fix code.** Make point-cloud rows selectable independently of the editable/visible checkbox; preserve selection across Frame/Zoom and route context commands against their target. Add visible selection → Properties → Extract regression coverage. |
| N-03 | Major defect | A deliberately bounded 10 m Viewing Box Lock remains at **Preparing resident dataset 0%** for more than 70 s (cancelled at 114 s); the initial box did the same for 67 s. | Viewing Box VB-D7/VB-D8, visible meaningful progress and bounded cancel. | **Fix code and remeasure idle.** Report actual bytes/nodes scanned during preparation, move above 0% promptly, and verify the exact road source on the idle Windows/GPU lane. Because the machine was loaded, do not use this run as a duration gate; the zero-information state is still a UX failure. |
| N-04 | Major defect | Exact boundary input commits an unintended partial vertex when focus leaves X, before Y/Z are entered, then the canonical default-layer error appears. | Draw DR-D1/DR-D5 typed twin and atomic coordinate entry; data integrity. | **Fix code.** Treat X/Y/Z as one draft tuple and commit exactly once on explicit Enter/Apply, never on inter-field blur. Cover keyboard Tab and Enter with large CRS coordinates. |
| N-05 | Major defect | View → Color Mode and Background expose unshipped/empty function surfaces; Color Mode explicitly says parameters appear **“once the function ships.”** | View specification claims these controls as product behavior; UI must not advertise unavailable capabilities as shipped. | **Fix code or fix the live spec/catalog.** Ship usable controls or disable/remove the commands with an honest reason. |
| N-06 | Moderate friction | Import progress resets byte counters across internal phases and keeps a **Needs input** label during active hashing/commit; 94–99% spans many minutes under load. | Design System activity/progress truth; registration/job state machine. | **Fix code/UI.** Give each phase a stable name and local counter, distinguish waiting-for-user from running, and avoid percent values whose denominator changes mid-job. |
| N-07 | Moderate friction | Removing the last persisted Viewing Box immediately arms placement and says **“Viewing Box: click the model to place the box.”** A user trying only to unclip the imported scan is unexpectedly put into a creation tool. | Viewing Box complete-flow/cancellation and predictable state transitions. | **Fix code/UI.** Removing the last box should leave clipping off and the panel empty; require an explicit New/Draw action to arm placement. |

## 5. Verdict against M-0.5

**Release 0.5 remains not usable at starter level.**

R-02 materially fixes one prerequisite: a pilot can now choose the named LAS
through the ordinary File ribbon, resolve its registration decision and watch a
cancellable job publish a 103.7 M-point entity. That is genuine progress and
closes R-01 B-01.

It does not close the milestone. The accepted M-0.5 definition requires a
pilot to complete the whole real-data workflow through visible UI without
implementation assistance. In R-01b:

- New again destroyed the visible shell instead of preserving/recovering the
  previous project with typed failure and Retry.
- The published road scan was not visible and could not be selected.
- Viewing Box Lock did not reach locked state.
- Extract/Segment/Sample/Rasterize had no actionable source and failed
  silently.
- Boundary-first exact entry again hit the canonical `default-layer`
  collision; pointer entry had no pickable model.
- No ground entity, DGM, DGM edit or LandXML output could be produced.

Thus both spines fail before their first derived civil result. The loaded
machine prevents a fair performance verdict, but it does not explain a blank
renderer after New, an invisible/unselectable published entity, canonical
identity errors, silent source predicates or unshipped function panels. M-0.5
is an unambiguous **FAIL; fix and rerun**.

## 6. Next prioritized list

1. **P0 — Fix and visibly gate New/project replacement again:** old shell/viewer stays alive, typed target failure is shown, Retry works, and the target is actually created/reopened.
2. **P0 — Make the exact imported road visible and selectable:** remove old clips, Frame All, context Zoom, selection, Properties and first-frame/pixel proof in one visible gate.
3. **P0 — Repair `default-layer` for legacy/persisted projects and atomic exact entry:** measurement and boundary must each commit once after reopen/cancel, including the actual R-01 project state.
4. **P0 — Rerun both R-01b spines end to end on an idle lane:** named LAS → box-lock → ground → segment/sample/raster → boundary/breakline → checked/edited DGM → verified LandXML.
5. **P1 — Complete Viewing Box resident bake:** meaningful phase progress, bounded cancellation and idle qualified evidence for a small box and the required real region.
6. **P1 — Make source predicates explicit and contextual:** selectable cloud row, disabled reasons, “Select one resident point cloud,” and context actions that operate on their invoked entity.
7. **P1 — Qualify the DGM loop with the road:** Check/fix/jump, Create, region smoothing/downsample, undo/recovery, units/CRS preflight and reopened LandXML verification.
8. **P1 — Ship or remove View placeholders:** working Background/Color Mode controls, truthful catalog state and a visible recovery path for bad cloud contrast.
9. **P2 — Make import state truthful:** waiting-versus-running status, phase-local byte counters and monotonic meaningful progress.
10. **P2 — Repair responsive chrome and input legibility:** ribbon spacing, construction-bar prompt/fields, panel value clipping, snap labels, Console brand and HUD close affordance.

This review changed no product code and created no commit. The only authored
repository file is this evidence report; screenshots are under `.build/r01b/`.
Concurrent unrelated PhotoLab/COLMAP worktree changes were left untouched.
