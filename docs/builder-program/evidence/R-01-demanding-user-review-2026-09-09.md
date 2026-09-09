# R-01 demanding-user review — Release 0.5 visible-UI spine

Date: 2026-09-09  
Reviewer stance: demanding survey/Civil CAD user (15 years of Trimble RealWorks, RIB Civil/STRATIS, Revit and Perspective)  
Result: **FAIL — the Release 0.5 spine cannot be completed through the visible UI.**

## 1. Scope, method and machine gate

I reviewed the accepted direction and contract first: `CURRENT-DIRECTION.md`, `README.md`, `FUNCTION-CONTRACT.md`, `DECISION-DOCTRINE.md`, `DESIGN-SYSTEM.md`, `AGENT-FEEDBACK.md`, `MASTER-PLAN.md` §0a and §6, the requested 0.5-01…0.5-08/0.5-02a/D-02/P-01/S-*/V-05/V-06 evidence, and the cited View, Viewing Box, Pointcloud, Draw, Mesh/Terrain, Measure/Inspect, Import/Formats, File/Project and UI Platform specifications. I also used the RealWorks and RIB Civil dossiers as the reference-user baseline.

At 16:16:58 CEST, before starting Builder:

```text
uptime: 3 days, 14:47; load average 3.07, 2.23, 1.86
memory: 31 GiB total, 3 GiB used, 2 GiB free, 25 GiB buff/cache, 27 GiB available
swap: 1 GiB total, 1 GiB used, 0 GiB free
```

No PhotoLab end-to-end run or Q-01 measurement was active. The machine gate therefore passed. A low-CPU PhotoLab implementation lane appeared after the live review had begun; it was not an e2e/Q-01 run and did not overlap the import finding. The live review ran from 16:21 to 16:53 CEST, well inside the four-hour stop.

Builder was started on `DISPLAY=:0`. All product actions were performed through visible ribbon controls, panels, viewport, construction bar, context menus, keyboard and native file-manager/file-picker surfaces. I did not invoke the product console, canonical commands, SDK, automation protocol, or edit product code. OS-level pointing/typing and capture were used only to operate and record the visible UI.

Target source: `libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las` (3,111,413,830 bytes; the requested 103,713,735-point road scan). The source remained present and unchanged. One initial file-manager drag was aimed at the wrong desktop target during review setup; the OS refused the move, I cancelled it, verified the source file, and excluded that attempt from the product finding. Two subsequent clean, visible file-manager drops into Builder are the attempts reported below.

The first live run started from a clean `r01-review-pass1.hcad` project. Because project creation blanked the renderer, reopening that project required restarting Builder. The second, boundary-first intent reused this clean review project after cancelling/unlocking the first-run tools: creating another project had already proved non-functional and a scan still could not be introduced. That is a constrained second attempt, not a successful second end-to-end run.

## 2. Executed step record

Times are observed wall-clock durations, not benchmark numbers. “Blocked” means I did not bypass the failed prerequisite with console, automation, filesystem injection, or code.

### Pass 1 — scan-first intent

| Step | Works through UI? | Time | Screenshot | What I did, exact response and friction |
|---|---:|---:|---|---|
| Start Builder | Partial | 0:05 to usable UI | [initial project](../../../.build/r01/00-start.png) | Builder opened an existing default project rather than a no-project/start surface. It was responsive, but I had to create a clean review project before touching the user's existing entities. |
| Create clean project | **No** | 3:16 to choose/create; then >10 s blank; 4:50 total to forced restart/recovery | [blank immediately](../../../.build/r01/01-new-project.png), [still blank](../../../.build/r01/01-new-project-10s.png), [reopened](../../../.build/r01/02-relaunch-after-new.png) | File → New opened the native `Create HimmelCAD project` picker. After creating `r01-review-pass1.hcad`, the complete renderer went blank with no copy, activity, cancel or recovery action. Waiting did not help. Closing the application normally did not complete, so I stopped and relaunched Builder. The new project then reopened; no visible recovery explanation appeared. |
| Import the road LAS using File → Import | **No** | 1:00 | [Import menu](../../../.build/r01/03-import-menu.png) | The only entry was **“PhotoLab product dataset”** with **“Choose a PhotoLab project or published package”**. There was no LAS/LAZ/E57 file-picker entry. This contradicts D-02's claimed visible picker and `import-formats.md`/`file-project.md` `file.import` reachability. |
| Import the road LAS using visible drag/drop | **No** | 7:13 for two clean retries and checks | [clean retry](../../../.build/r01/07-drop-road-scan-retry.png), [second clean retry](../../../.build/r01/08-drop-road-scan-clean.png), [result](../../../.build/r01/09-import-blocked-clean.png) | I selected the requested LAS in the visible file manager and dropped it into the Builder viewport twice. Both times the UI remained at **“Clouds: 0”**. No job, needs-input card, progress, error or drop rejection appeared. Because OS drag synthesis can differ from a physical drag, this is reported as “two visible drops produced no reaction,” not by itself as proof that every physical drop is broken. The absent ribbon picker is sufficient to block the workflow. |
| Empty-viewport contextual recovery | **No** | 0:49 | [viewport context menu](../../../.build/r01/04-empty-viewport-context.png) | RMB offered **“Frame all”**, **“Top”**, **“Front”**, **“Right”**, **“Perspective”** only. There was no `Import point cloud…` or empty-state action. I had to guess that File → Import and drop were the only routes. |
| Fluid view and HUD on the imported scan | **No** | 0:36 | [View tab](../../../.build/r01/10-view-tab-no-data.png), [HUD](../../../.build/r01/11-hud-no-data.png) | The scan was absent, so real-data navigation could not be judged. The HUD correctly began with **“Idle — no frames presented”** and **“quality I-full budget: — · backlog —”**, but it had no visible own close control promised by the View diagnostics contract. |
| Place a viewing box | Partial | 0:41 | [placement panel](../../../.build/r01/12-viewing-box-no-data.png), [created draft](../../../.build/r01/14-viewing-box-created-empty.png) | With no cloud, Viewing Box still offered default extents and **“Create from extents”**. Creation produced **“Viewing Box 1”** plus a **“Save as entity”** action. The box did not enter the tree until that second action. The accepted Viewing Box evidence says every placed box is immediately canonical, so the live UI exposes a second, contradictory persistence step. |
| Save and lock the viewing box | Partial | 0:27 to save; 1.2 s reported lock | [saved](../../../.build/r01/15-viewing-box-saved.png), [lock progress](../../../.build/r01/16-viewing-box-lock-empty.png), [locked](../../../.build/r01/17-viewing-box-lock-empty-5s.png) | **“Save as entity”** created the tree node but remained available afterwards. Lock showed **“Preparing resident dataset”**, `0%`, and **“Cancel bake”**, then the console reported **“Lock Viewing Box 1 completed · 1.2 s”** despite **“Clouds: 0”**. The panel then said **“Locked — unlock to edit”** and displayed clipped copy beginning **“Kept region is most of the cloud; clip …”**. A successful empty bake is not useful proof of the real 104 M-point lock. |
| Extract ground | **No** | Blocked; 0:02 UI probe | [Pointcloud tab](../../../.build/r01/25-boundary-first-pointcloud-tab.png), [after click](../../../.build/r01/26-boundary-first-extract-ground-no-cloud.png) | The Pointcloud tab exposed **“Extract ground”**, **“Rasterize mean height”**, **“Segment”**, **“Sample”**. Clicking Extract ground with no cloud produced no panel, toast or explanation. The source prerequisite was unavailable. |
| Segment/clean ground | **No** | Blocked | [Pointcloud tab](../../../.build/r01/13-pointcloud-tab-no-data.png) | Not executable without an imported cloud. I did not substitute the synthetic evidence fixture. Prior 0.5-02a evidence also leaves `G-RW-SEGMENT` unmeasured and the required excluded-point alpha preview undelivered. |
| Sample / rasterize | **No** | Blocked | [Pointcloud tab](../../../.build/r01/13-pointcloud-tab-no-data.png) | The buttons were visible, but no source existed. Prior 0.5-03 evidence has backend real-data timings; this review could not reach those commands from the requested visible import flow. |
| Draw breaklines/boundary with snap and tri-modal input | **No** | See pass 2 | [Draw tab](../../../.build/r01/18-draw-tab.png) | The visible catalog is only **Line**, **Polyline**, **Boundary polygon**. Boundary execution was moved to the second intent and failed independently there. |
| Create/check/fix DGM | **No** | Blocked; 0:21 UI probe | [Create surface window](../../../.build/r01/27-boundary-first-create-surface-no-source.png) | Mesh → Create surface opened **“Create surface — DGM · checked TIN”** with Sources, Rules and Check results. It said **“Select points, clouds, grids, or polylines.”**, **“0 errors · 0 fixable”**, and **“Run Check before publishing.”** Check/Create were unavailable because no valid source was selectable. |
| Edit DGM (region smoothing/downsample) | **No** | Blocked | [Mesh tab](../../../.build/r01/19-mesh-tab.png) | **“Edit surface”** was visible, but no DGM could be created. Prior 0.5-06 evidence explicitly did not execute the real-road DGM gate. |
| Export DXF/LandXML | **No** | 0:31 to inspect | [export panel](../../../.build/r01/33-export-menu.png), [format list](../../../.build/r01/34-export-format-menu.png) | The export panel was reachable and honestly said **“The current scope has no entity kind supported by an installed exporter.”** LandXML appeared disabled beside DXF/IFC/GeoTIFF/splat. There was no DGM to plan or write, so no output was produced. |
| Measurement basics | Partial | 0:31 | [point tool](../../../.build/r01/35-measure-point-no-data.png), [typed values](../../../.build/r01/36-measure-point-typed.png) | Inspect → Point exposed **“Pick or type start point”**, **“Exact”**, **“Input Fixed coordinate”**, and X/Y/Z fields. After entering `1.000 / 2.000 / 3.000 m` and pressing Enter, the panel still showed **“Measurements 0”** and **“No saved measurements”**, without validation copy. No cloud pick could be tested. |

### Pass 2 — pilot-office boundary-first intent

| Step | Works through UI? | Time | Screenshot | What happened |
|---|---:|---:|---|---|
| Start Boundary polygon | Yes, tool opens | 0:20 | [tool start](../../../.build/r01/22-boundary-first-start.png) | The right panel showed Role **Boundary**, six unlabeled snap-icon buttons, live polar readout, Vertices, Finish, Close, Undo vertex and Cancel. The construction prompt was truncated to **“Boundary polygon — pick or type fir…”**. |
| Place boundary by pointer | **No** | 1:20 | [pointer attempt](../../../.build/r01/29-boundary-first-unlocked-pointer.png) | Three clicks in the empty viewport, first while the box was locked and then after unlocking it, left **“Vertices 0”**. There was no “no pick surface” explanation. I had to guess whether lock state, missing cloud depth, or tool focus was responsible. |
| Place boundary by exact coordinates | **No** | 2:33 | [first vertex](../../../.build/r01/30-boundary-first-exact-first-vertex.png), [failure](../../../.build/r01/31-boundary-first-exact-three-attempt.png) | The input bar became overcrowded after the first point: Dir/Dist/ΔZ/Slope and X/Y/Z controls overlapped or clipped. Two vertices were accepted. Each next attempt failed with **`Error invoking remote method 'sidecar:call': SidecarRpcError: canonical document: canonical entity EntityId("default-layer") already exists or is tombstoned`**. Finish/Close remained unavailable. I cancelled; no completed boundary remained. |
| Box-lock after boundary | **No** | Blocked | [boundary failure](../../../.build/r01/31-boundary-first-exact-three-attempt.png) | The boundary prerequisite did not exist. A box had been created and empty-locked in pass 1, but that is not the requested boundary-first sequence and proves nothing about a clipped scan. |
| Import, ground, DGM, LandXML | **No** | Blocked at two independent prerequisites | [Import menu](../../../.build/r01/03-import-menu.png), [LandXML disabled](../../../.build/r01/34-export-format-menu.png) | The pilot path was independently blocked by both the boundary/default-layer error and the missing visible LAS import route. No implementation assistance or hidden path was used. |

## 3. Findings

### Blockers — the spine cannot be completed through visible UI

| ID | Severity | Finding | Contract/evidence violated or gap | Proposed resolution |
|---|---|---|---|---|
| B-01 | **Blocker** | File → Import exposes only PhotoLab product datasets; the requested LAS cannot be selected. Two clean visible drops produced no reaction or feedback. | `MASTER-PLAN.md` §0a/§6 M-0.5; `import-formats.md` catalog/IF-D12 and LAS/LAZ adoption; `file-project.md` `file.import`; D-02 outcome claiming visible picker/drop. | **Fix code.** Make the primary Import action open the general multi-file picker (LAS/LAZ/E57 included), keep PhotoLab as a submenu choice, and create a visible needs-input/job card immediately on picker selection/drop. Add a physical visible-UI gate for the literal Electron picker and file-manager drop. |
| B-02 | **Blocker** | Creating a clean project blanks the entire renderer and strands the user without activity, cancel, recovery or normal close. Only restarting Builder made the project usable. | P-01 outcome; File/Project complete-flow and replacement lifecycle; Function Contract B2/D1/E2; Design System long-work/failure feedback. | **Fix code.** Make New transition atomically to a usable project or retain the old project with a typed failure. Add a packaged visible-UI create/open/restart recovery gate. |
| B-03 | **Blocker** | Boundary polygon cannot reach three vertices in the clean review project because vertex creation repeatedly collides with `EntityId("default-layer")`. | Release 0.5 line/boundary requirement; Draw `draw.boundary`, `draw.vertex.type`, DR-D1/DR-D5; canonical data-integrity rules C4/D1; 0.5-04's implemented claim. | **Fix code.** Make default-layer bootstrap/idempotence correct across New/reopen/cancel and never reuse a tombstoned identity. Add a visible-UI regression: new project → typed three-point boundary → close → save/reopen → continue drawing. |
| B-04 | **Acceptance blocker** | Even without B-01–B-03, the landed evidence does not qualify the whole real-data spine: Viewing Box VB-D7/VB-D8 remained open after a >61-minute zero-output run; segmentation's 104 M gate was not measured; real-scan drafting and DGM create/edit gates were not run; V-06's measured Class-I transition is 206 ms p95 versus 33.4 ms. | M-0.5 explicitly rejects partial UI and unexecuted gates as “starter level”; 0.5-01, 0.5-02a, 0.5-04, 0.5-05, 0.5-06, V-05 and V-06 admissions. | **Fix code and execute the gates.** Do not change the acceptance definition. One scripted/backend success is not a substitute for owner/pilot completion through the product UI. |

### Defects — visible behavior disagrees with the accepted contract

| ID | Severity | Finding | Contract/evidence violated or gap | Proposed resolution |
|---|---|---|---|---|
| D-01 | Major | A placed Viewing Box is a draft until **“Save as entity”**; even after saving, that action remains. The evidence says every placed box is immediately canonical. | Viewing Box §1.1/§1.2 and 0.5-01 Outcome; C1/C4. | **Fix code/UI.** Commit placement once through the canonical path, remove the extra persistence ambiguity, and expose a separate explicit duplicate/store-as-new action only if wanted. |
| D-02 | Major | The box editor exposes raw Min/Max extents but not the promised Center/Size/Rotation groups, named-box management or a clear New box path. | Viewing Box workflows and visual criteria; RealWorks dossier §2.5 stored Limit Box workflow. | **Fix code/UI.** Implement the accepted field groups and saved-box flow; if raw extents are intentionally the product model, **fix the spec** and evidence rather than claiming both. |
| D-03 | Major | Lock succeeds against zero resident clouds, briefly promises a bake, then presents clipped cloud-specific success copy. | Viewing Box lock preconditions; Function Contract C3/D1/E2; truthful feedback. | **Fix code.** Disable/reject Lock with “No resident point cloud in scope,” or define and explain a geometry-only lock. Never report a cloud bake that processed no cloud. |
| D-04 | Major | HUD samples became meaningless after empty-scene tools: observed values included `39364.0 ms p95`, `41048.0 ms p95`, `22547.0 ms p95` and `0.0 M pts`. The HUD also lacks its own visible close affordance. | View diagnostics S-08/View B2 and V-06; Function Contract C2; accepted HUD close behavior. | **Fix code.** Reset/partition cadence samples across idle/tool/modal intervals, label insufficient/stale samples, and add the specified close control. |
| D-05 | Major | Unavailable actions often fail silently. Extract ground accepted a click with zero clouds and did nothing; viewport boundary clicks with no pick surface left zero vertices and no reason. | Function Contract C3/E2; Pointcloud/Draw visible workflows; Design System feedback rules. | **Fix code.** Disable with an accessible reason or show a concise prerequisite message; preserve the user's tool state and next action. |
| D-06 | Major | Typed Measure Point values did not create a measurement or show an error; the panel remained at **“Measurements 0”**. | Measure/Inspect typed-twin/Enter behavior; 0.5-08 completed claim. | **Fix code after reproduction.** Add a visible new-project fixed-coordinate measurement test, including Enter focus routing and saved-tree result. |
| D-07 | Major | Several core controls are visibly clipped/colliding at the 1823×1075 maximized window: **“Extract groundRasterize mean height”**, the construction prompt, overlapping Draw numeric fields, clipped lock explanation, and a large partially clipped brand above Console. This materially contributed to wrong coordinate entry. | Design System responsive layout/readability; Draw DR-D1 input bar; Function Contract B1/C3. | **Fix code/CSS.** Give ribbon items minimum separation, make the construction bar responsive/scrollable without overlap, clamp panel copy, and correct the Console header asset. Add 1440×900 and 1100×720 Builder visual gates, not gallery-only crops. |

### Friction — guessing, hidden state and weak flow

| ID | Severity | Finding | Contract/evidence violated or gap | Proposed resolution |
|---|---|---|---|---|
| F-01 | Major | A clean empty project has no “Import point cloud” call to action. The user must discover a small Import dropdown that leads only to PhotoLab. | UI Platform/import reachability; M-0.5 novice pilot flow. | **Fix code/UI.** Add a central empty-project action and keep it identical to File → Import. |
| F-02 | Major | Pointcloud commands look available when their source predicate is false; no disabled reason or selection guidance is visible. | P4/selection predicate behavior; Function Contract C3. | **Fix code/UI.** Surface “Select one resident point cloud” beside disabled commands and in the status/help surface. |
| F-03 | Moderate | Six Draw snap controls are icon-only in the persistent panel. The 0.5-04 evidence already admits ambiguous single-letter toggles; neither icons nor status made candidate priority discoverable during the boundary attempt. | Draw DR-D2/DR-D6/DR-D14; RIB dossier §2.2 candidate picker/Tachobox baseline. | **Fix code/UI.** Add concise labels/tooltips and show the active snap names and candidate source in the construction bar. |
| F-04 | Moderate | The project opened an existing working project by default. A careful user must first protect it, yet New is the failing path. | File/Project safe start and project-replacement flow. | **Fix code.** Provide a safe start/recent-project surface or make New reliable before auto-opening mutable user work. |

### The three things a RealWorks / RIB Civil user would miss most

1. **A dependable front door for scan data.** RealWorks puts scan import in File/Home with format options and immediately establishes the workspace object. Here the only visible Import choice is PhotoLab, so the job never starts.
2. **One coherent Limit Box → clean/classify → full-density/sampled extraction flow with visible state.** RealWorks users expect F4/toolbar access, named boxes, in/out controls, extraction density options and a clear result. Himmel:CAD exposes fragments, but the named-box contract disagrees with the live UI and no real scan can reach ground/segment/sample.
3. **A trustworthy DGM authoring loop.** RIB users expect boundary/breakline drafting with exact entry and snap feedback, triangulation with error list/zoom-to-error, correction/remesh, plausibility checks and then LandXML. The boundary fails on the default layer, so the strongest 90%-of-daily-work path never reaches the DGM window.

## 4. Verdict against M-0.5

**Release 0.5 is not “usable at starter level.”**

The acceptance definition requires the owner and 2–3 pilot offices to complete the entire workflow through visible UI on real scan datasets without implementation assistance. In this review, one demanding user could not import the named real dataset at all. A clean project required an application restart, and the alternative boundary-first intent failed on canonical default-layer state before a third vertex. Consequently zero real points were viewed, clipped, classified, segmented, sampled, rasterized, triangulated, edited, measured or exported.

This is not a borderline usability judgement. It is a reachability failure at the first domain step plus an independent drafting/data-integrity failure. Prior unit, fixture, command-parity and backend real-data evidence remains useful implementation evidence, but it does not satisfy M-0.5. The prior evidence also contains explicit unrun gates and one measured performance failure, so it cannot fill the live-run gap.

Contract questions, answered plainly:

- Can a pilot start with the named LAS through visible UI? **No.**
- Can the same pilot recover from New without implementation assistance? **No; restarting the app was required, without product guidance.**
- Can a boundary-first pilot complete the first canonical boundary? **No.**
- Can I assess “fluid view” on the 103.7 M-point road scan from this run? **No; the dataset never entered Builder.**
- Can I reach ground extraction, DGM review/edit and LandXML as one visible workflow? **No.**
- Is there any defensible path to pass M-0.5 on this evidence? **No. Fix and rerun.**

## 5. R-02 priority list

1. **P0 — Restore general scan import reachability:** primary File → Import picker for LAS/LAZ/E57, physical drag/drop, immediate job/needs-input feedback, and a packaged visible-UI test using the named road scan.
2. **P0 — Fix New/project replacement:** never blank the renderer; retain/recover atomically with visible failure and packaged create/reopen/restart coverage.
3. **P0 — Fix default-layer lifecycle:** new/reopened projects must support a three-vertex typed boundary, cancel/restart, save/reopen and a second drawing without duplicate/tombstone errors.
4. **P0 — Rerun R-01 twice:** scan-first and boundary-first, through only visible UI, with the same road LAS, screenshots, timings and no hidden setup.
5. **P1 — Align Viewing Box UI with its contract:** immediate canonical placement, Center/Size/Rotation, named-box management, honest zero-source preconditions and real 104 M-point lock/cancel evidence.
6. **P1 — Make Pointcloud prerequisites explicit:** selection guidance plus end-to-end ground → segment → sample/raster hand-off with visible progress/cancel and real-data acceptance.
7. **P1 — Qualify the actual DGM loop:** road-scan boundary/breakline snap, Check/fix/jump, Create, smoothing/downsample, undo/recovery and LandXML unit/CRS preflight/output verification.
8. **P1 — Fix and rerun viewer performance gates:** V-06 Class-I transition, VB-D7/VB-D8, real LOD continuity/EDL cost and segmentation parity on an idle qualified lane.
9. **P2 — Repair responsive chrome and feedback:** construction-bar overlap, ribbon label collision, Console header, clipped panel copy, stale HUD samples and missing HUD close.
10. **P2 — Verify typed measurement in a clean project:** Enter must commit once or display a specific validation reason; retain it through save/reopen.

This review changed no product code and made no commit. Concurrent, unrelated
PhotoLab-lane worktree changes were left untouched.
