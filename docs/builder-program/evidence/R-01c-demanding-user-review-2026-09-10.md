# R-01c demanding-user review — post-R-02b/R-02c visible-UI rerun

Date: 2026-09-10  
Reviewer stance: demanding survey/Civil CAD user (15 years of Trimble
RealWorks, RIB Civil/STRATIS, Revit and Perspective)  
Review snapshot: `f7814ef`, with the already-present R-02c workspace state;
R-02b is `0c9ef0b`  
Result: **FAIL — more of both spines is reachable, but neither produces an
editable DGM or LandXML deliverable, and New/project replacement can corrupt
the reopened project.**

## 1. Scope, method and machine state

I read R-02c, R-01b and R-02b first, then the accepted direction and the
authoritative records for M-0.5, project replacement, import, Viewing Box,
Pointcloud, Draw, Mesh, Measure/Inspect, export, visible feedback, and the
RealWorks/RIB reference workflows. The controlling milestone is
[MASTER-PLAN §0a and M-0.5](../MASTER-PLAN.md): the owner and 2–3 pilot offices
must complete the full real-data visible-UI workflow, with no open blocker.

I drove Builder through its visible UI only. Product console commands, the
automation protocol, the Python SDK, canonical calls and sidecar calls were not
used. The in-app browser runtime again had no attachable browser, so I used the
documented V-01b fallback: Builder on `DISPLAY=:0`, Electron CDP only for
DOM-visible pointing/typing/screenshots, native X11 input for the native file
picker and viewport pointing, and root-window captures. Builder was launched
with `pnpm --filter @himmelcad/builder dev`.

Target source:
`libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las`
(3,111,413,830 bytes; 103,713,735 points). The prepared hierarchy under
`.build/perf/viewer-baseline-datasets/` was present and treated as read-only.

At 08:33 CEST, before starting Builder:

```text
uptime: 4 days, 7:03; load average 0.10, 0.30, 1.37
memory: 31 GiB total, 3 GiB used, 27 GiB available
swap: 1 GiB total, 1 GiB used
disk: 25 GiB available (95% used)
```

No PhotoLab e2e or Q-01 process was running. The lane was sufficiently idle to
proceed. At 09:43, after the derived jobs, Builder's own GPU process was using
about 500% CPU, the HUD showed `0.0 M pts` with roughly 47–53 ms p50, load was
`6.02, 5.92, 7.06`, memory still had 25 GiB available, and disk had 14 GiB
available. Therefore timings are **informational**; the correctness,
reachability, persistence and copy findings remain valid. No unrelated heavy
job invalidated the run.

The review ran from 08:33 to 09:43 CEST, inside the four-hour hard stop. It
changed no product code and made no commit. Screenshots are under
`.build/r01c/`.

One ordering deviation is recorded rather than hidden: once fresh-import box
placement failed, I probed Ground, Sample and Rasterize before returning to the
Segment fence. This establishes downstream reachability but is not counted as
a successful strict-order spine. The boundary-first pass then ran in the same
project, as R-01/R-01b did, with a new boundary intent and recovery restart.

## 2. Executed step record

### Pass 1 — scan-first intent

| Step | Works through UI? | Observed time | Screenshot | What I tried, exact response and friction |
|---|---:|---:|---|---|
| Start Builder | Partial | about 2 min 17 s including dev build | [auto-opened prior work](../../../.build/r01c/00-start.png) | Builder automatically opened mutable `r01-review-pass1.hcad`, with two selected clouds and a prior Viewing Box. There is still no safe start surface. |
| Create clean project | **Partial** | about 6 s after submit | [New dialog](../../../.build/r01c/02-new-project-dialog.png), [new shell](../../../.build/r01c/04-new-project-alive.png) | File → New created `/home/oem/Dokumente/r01cscanfirsthcad.hcad` and kept the shell alive: R-01b's blank-renderer symptom is fixed. However, `Viewing Box 2` leaked from the replaced project and Builder immediately tried to rebuild/store it, then reported that the box no longer existed. This contamination later became a data-integrity blocker. The clean empty view still had no import CTA. |
| Open the general import route | **Yes** | about 20 s | [File front door](../../../.build/r01c/05-import-front-door.png), [native picker](../../../.build/r01c/06-import-picker.png) | File → Import opened the native picker and accepted the exact road LAS. |
| Resolve registration input | **Yes** | about 15 s | [wizard](../../../.build/r01c/07-import-selected.png), [choice](../../../.build/r01c/08-no-transformation.png) | The wizard showed **“Point cloud detected”**, **“LAS/LAZ to Potree 2”**, **“Transform coordinates?”** and four choices. I chose **“No transformation.”** The later commit surface showed **“CRS: EPSG:31466 · offset 0 0 0 · source units Not declared”** and **“ready to commit.”** |
| Prepare hierarchy | Partial | about 4 min visible; converter itself about 62 s | [57%](../../../.build/r01c/09-import-progress.png), [64% hashing](../../../.build/r01c/10-import-late.png), [event backlog](../../../.build/r01c/13-import-event-backlog.png) | Visible cancellable progress worked, but the sidecar was ready well before the wizard caught up with thousands of hash events. The bottom status still said **Needs input** while preparation was running. |
| Commit/register/publish | Partial | 264.3 s commit; 563.4 s total import | [registering](../../../.build/r01c/15-import-commit-progress.png), [journal](../../../.build/r01c/18-import-journal.png), [99%/published](../../../.build/r01c/21-import-99.png) | Publication was atomic and the tree showed 103.7 M. Console copy said **“Registered import committed and loaded”** and **“Import … completed · 563.4 s.”** Phase counters changed denominator and 94–99% covered long journal work; status still said **Needs input**. |
| See and frame the road | **No** until restart | >2 min of direct checks; about 30 s restart recovery | [Frame All blank](../../../.build/r01c/25-frame-all-result.png), [context Zoom blank](../../../.build/r01c/29-context-zoom-result.png), [hardware retry blank](../../../.build/r01c/33-retry-hardware-rendering.png), [visible only after restart](../../../.build/r01c/77-reopen-visible.png) | Fresh import completed and exposed a 103.7 M row, but Frame All, toast Frame, context-menu Zoom to and **Try hardware rendering again** all left the viewport blank. Hardware retry began reporting a real XYZ under the pointer but rendered no road. Only a full application restart produced visible road pixels. “Committed and loaded” and “First frame” therefore overstate the user-visible result. |
| Select the imported cloud | **Yes** | under 5 s | [selected cloud and Properties](../../../.build/r01c/26-cloud-selected.png) | The row entered selection state, `Selected: 1` appeared, Properties populated, and contextual actions were enabled. R-01b N-02 is fixed. |
| Place/edit a Viewing Box from the blank fresh view | **No** | about 1 min | [command](../../../.build/r01c/31-viewing-box-open-retry.png), [blank pick](../../../.build/r01c/32-viewing-box-blank-pick.png) | View → Viewing Box said **“Viewing Box: click the model to place the box.”** A viewport click created neither a box nor a panel and gave no reason. This contradicts VB-D10's view-centred seed for a void invocation. |
| Extract ground without a box | **Yes, but wrong scope** | 401.1 s | [progress](../../../.build/r01c/40-ground-progress-within-2s.png), [result](../../../.build/r01c/47-ground-outcome.png) | The selected cloud admitted Extract Ground despite the missing box. Progress and Cancel appeared promptly. It produced 76,024,884 ground points (73.3%), residual σ 0.204 m, with a deterministic SHA-256. The command worked, but only as an expensive whole-source fallback after the intended bounded prerequisite failed. |
| Sample ground | **Yes** | 262.0 s | [progress](../../../.build/r01c/52-sample-progress.png), [result](../../../.build/r01c/56-sample-mid2.png) | Sample produced 368,482 of 76,024,884 points at 0.25 m with a deterministic hash. Progress and Cancel were visible. Function tabs required guessing because the new panel first opened behind an already-active tab. |
| Rasterize mean height | **Partial** | 117.9 s | [panel](../../../.build/r01c/57-raster-panel-opening.png), [progress](../../../.build/r01c/60-raster-mid.png), [result and warning](../../../.build/r01c/61-raster-status.png) | Rasterize created a 201×201, 1 m height grid with 15.1% empty cells, then immediately warned: **“Canonical dataset … uses unsupported bootstrap format hcad.pointcloud.height-grid@1.”** The result is published but not a supported reopened/rendered product. |
| Fence segmentation | **No** | about 1 min | [fence panel](../../../.build/r01c/64-panel-overflow.png), [failed fence](../../../.build/r01c/65-segment-fence-attempt.png) | Four deliberate viewport clicks registered only one vertex. Enter then showed **“A fence needs at least three vertices.”** Three missed picks had no feedback. Keep/Remove remained unavailable, so no segmented cloud was produced. |
| Boundary / exact tri-modal entry | **Partial, then blocker** | about 35 s entry; immediate Close failure | [four exact vertices](../../../.build/r01c/70-boundary-four-complete.png), [Close failure](../../../.build/r01c/72-boundary-close-retry.png) | X/Y/Z committed atomically on Enter and the panel showed all four exact source-authoritative vertices. Close failed: **“canonical residency inventory is invalid: draw curve … is stale, missing, or has the wrong type.”** The draft nevertheless appeared in the tree. I checked the R-02c record once at this point to confirm that the entered tuple exactly matched its accepted boundary; it did. |
| Save/restart recovery | **No clean recovery** | about 35 s | [reopen errors and road](../../../.build/r01c/77-reopen-visible.png) | After Cancel, Save and full restart, road pixels finally appeared, but open reported **“Canonical project failed to open: CAD curve geometry is invalid or degenerate”** plus the same failures for development import and mixed scene. The invalid boundary remained selected. Undo reported **“Undo committed”** but did not remove it. The project was not restored to a clean state. |
| Breakline | **No** | about 2 min | [role menu](../../../.build/r01c/128-breakline-role-menu.png), [two exact vertices](../../../.build/r01c/129-breakline-two-typed.png), [Finish still armed](../../../.build/r01c/132-breakline-finish-wait.png) | The role can be changed to Breakline before the first vertex. Two exact vertices were accepted, but repeated visible Finish attempts produced no console, toast, error or stored result. Six snap modes remain icon-only and the construction prompt/fields overlap. |
| Measurement basics | **Yes** | under 10 s | [stored typed Point 1](../../../.build/r01c/119-measure-point-typed.png) | Inspect → Point accepted the exact typed anchor and stored `Measurements / Point 1`; the overlay showed the intended coordinate. R-01b D-06 is fixed. |

Because fresh-import box placement and Segment failed, this is not a complete
strict-order scan-first spine even though Ground, Sample, Rasterize, exact
measurement and exact tuple input are now individually reachable.

### Pass 2 — pilot-office boundary-first intent

As in R-01/R-01b, I reused the road project. The boundary intent began before
creating the pass-2 box. The boundary Close failure forced the visible
save/restart recovery above; I did not edit the project file or inject a
fixture.

| Step | Works through UI? | Observed time | Screenshot | What happened |
|---|---:|---:|---|---|
| Draw site boundary | **No durable result** | about 35 s plus restart | [four vertices](../../../.build/r01c/70-boundary-four-complete.png), [canonical failure](../../../.build/r01c/72-boundary-close-retry.png), [reopen failure](../../../.build/r01c/77-reopen-visible.png) | Exact entry is atomic now, but Close left a stale/invalid canonical curve and the reopened project failed validation. |
| Derive Viewing Box from boundary | **Partial** | under 10 s | [exact extents](../../../.build/r01c/89-box-from-corrupt-boundary.png) | Despite the invalid boundary, From selection created `Viewing Box 1` with exact extents X 2538170.001–2538179.998, Y 5486660.001–5486669.999, Z 380–390. The panel still says **Save as entity** and still exposes raw Min/Max rather than the accepted always-visible Center/Size/Rotation groups. |
| Lock box | **Yes** | 15.2 s | [locked box](../../../.build/r01c/91-box-lock-10s.png) | Lock completed and showed **“Locked — unlock to edit”** and **Prepared dataset**. This fixes R-01b N-03 for this bounded real-road case. |
| Extract bounded ground | **Partial** | 221.6 s | [start](../../../.build/r01c/96-boundaryfirst-ground-start.png), [result plus rebuild failure](../../../.build/r01c/101-boundaryfirst-ground-final.png) | Ground produced 145,377 points (34.7%), residual σ 0.154 m, deterministic hash. Immediately afterwards **Rebuild Viewing Box 1 failed** because `datasetId is already registered`; the UI claimed the canonical project remained safe. |
| Check/fix DGM | **Partial** | about 1 min | [correct sources](../../../.build/r01c/104-dgm-boundary-ground.png), [553 fixable errors](../../../.build/r01c/105-dgm-check-start.png), [Exclude source](../../../.build/r01c/106-dgm-fix-menu.png), [Check passed](../../../.build/r01c/107-dgm-boundary-excluded.png) | The modal correctly classified boundary and 145.4 k ground sources. Check found 553 errors, starting with the invalid boundary and outside points. The only visible repair for the first error was **Exclude source**. Choosing it made Check say **passed** while the boundary remained visibly listed as a Boundary source, so the semantic result was unclear. |
| Create DGM | **No** | about 1 s to failure after 82% Bake | [provider-contract failure](../../../.build/r01c/109-dgm-create-start.png) | Create Surface ran Triangulate/Constrain/Validate/Bake, then failed exactly as R-02c: **“canonical staged import is invalid: canonical provider output: canonical representation contract is invalid.”** No DGM was published; Edit Surface was blocked. |
| Export LandXML | **No** | about 1 min | [format list](../../../.build/r01c/115-export-format-open-physical.png), [LandXML selected, Export disabled](../../../.build/r01c/116-landxml-no-surface.png) | File → Export lists and allows selecting LandXML, but Export remains disabled because no surface exists. No output was written and the modal provides no local reason. Output ribbon still contains only Specifications and Plan: [Output ribbon](../../../.build/r01c/122-output-ribbon.png). |

## 3. Diff against every R-01b finding

Status is based on the literal R-01c visible behavior, not an implementation
claim. “Fixed” closes the exact R-01b symptom; replacement failures are listed
under new findings.

| R-01b finding | R-01c status | Visible evidence and assessment |
|---|---|---|
| B-01 — general LAS import unreachable | **Fixed** | File → Import reaches the native picker, typed registration wizard and atomic 103.7 M publication. [Picker](../../../.build/r01c/06-import-picker.png), [published](../../../.build/r01c/21-import-99.png). |
| B-02 — New blanks the renderer | **Fixed** | New kept the shell alive and created the target. [New shell](../../../.build/r01c/04-new-project-alive.png). A new cross-project viewing-box leak replaces the original blank-shell failure. |
| B-03 — default-layer collision blocks boundary | **Fixed** | Neither boundary tuple entry nor typed Point hit `default-layer`; Point 1 stored. [Boundary tuple](../../../.build/r01c/70-boundary-four-complete.png), [Point 1](../../../.build/r01c/119-measure-point-typed.png). Boundary persistence now fails for a different stale-residency reason. |
| B-04 — whole real-data acceptance spine unqualified | **Still open** | More stages run, but Segment, durable boundary/breakline, DGM Create/Edit and LandXML all fail. |
| D-01 — Viewing Box persistence contradicts “immediately canonical” | **Still open** | The canonical tree node and **Save as entity** coexist without an explanation. [Panel](../../../.build/r01c/89-box-from-corrupt-boundary.png). |
| D-02 — raw Min/Max instead of accepted box editor/management | **Still open** | Resize/Rotate mode buttons exist, but the editor still lacks the accepted always-visible Center/Size/Rotation fields and coherent named-box creation flow. [Panel](../../../.build/r01c/89-box-from-corrupt-boundary.png). |
| D-03 — Lock reports success with zero clouds | **Still open** | The exact zero-cloud Lock case was not requalified. New did expose an empty project, but leaked an old box before import; no clean evidence closes the finding. |
| D-04 — HUD samples/close behavior | **Still open** | HUD has no own close affordance and showed 0.0 M points at 47–53 ms p50 while Builder's GPU process saturated CPU. [HUD](../../../.build/r01c/121-hud.png). |
| D-05 — unavailable actions fail silently | **Still open** | Fresh Viewing Box placement gave no result, three Segment picks vanished silently, and Breakline Finish stayed armed without feedback. [Box pick](../../../.build/r01c/32-viewing-box-blank-pick.png), [Segment](../../../.build/r01c/65-segment-fence-attempt.png), [Breakline](../../../.build/r01c/132-breakline-finish-wait.png). |
| D-06 — typed Measure Point does not create measurement | **Fixed** | Exact typed entry stored `Measurements / Point 1`. [Evidence](../../../.build/r01c/119-measure-point-typed.png). |
| D-07 — clipped/colliding core controls | **Still open** | Pointcloud labels touch, construction-bar fields/prompt overlap, function tabs hide behind overflow, and Console branding remains distorted. [Pointcloud ribbon](../../../.build/r01c/37-pointcloud-ribbon-selected.png), [Draw bar](../../../.build/r01c/125-polyline-two-typed.png). |
| F-01 — no empty-project import CTA | **Still open** | New now reaches an empty project, proving the viewport still has no import CTA. [Empty state](../../../.build/r01c/04-new-project-alive.png). |
| F-02 — pointcloud prerequisites hidden | **Fixed** | With only a boundary selected, all four commands are disabled with exact tooltip **“Select one resident point cloud.”** [State](../../../.build/r01c/120-pointcloud-prereq.png). |
| F-03 — snap controls are icon-only | **Still open** | Boundary/Polyline still show six icon-only snap toggles and no active snap names/candidate source. [Breakline](../../../.build/r01c/128-breakline-role-menu.png). |
| F-04 — unsafe auto-open of mutable work | **Still open** | Startup again auto-opened mutable `r01-review-pass1`, carrying selection and a Viewing Box into the replacement path. [Startup](../../../.build/r01c/00-start.png). |
| N-01 — published road is visually blank | **Still open** | Fresh import remained blank after Frame All, Zoom and hardware retry; only an application restart revealed pixels. [Fresh blank](../../../.build/r01c/33-retry-hardware-rendering.png), [after restart](../../../.build/r01c/77-reopen-visible.png). |
| N-02 — cloud row cannot enter selection state | **Fixed** | Row selection, count and Properties work. [Selected](../../../.build/r01c/26-cloud-selected.png). |
| N-03 — bounded Viewing Box Lock remains at 0% | **Fixed** | The boundary-derived 10 m box locked in 15.2 s with visible final state. [Locked](../../../.build/r01c/91-box-lock-10s.png). A new restore/duplicate-registration failure follows ground extraction. |
| N-04 — exact boundary input commits a partial tuple | **Fixed** | Inter-field entry no longer committed partial X-only vertices; four complete tuples appeared only after explicit Enter. [Four tuples](../../../.build/r01c/70-boundary-four-complete.png). |
| N-05 — View exposes unshipped Color Mode/Background placeholders | **Fixed** | Those placeholder commands are absent from the R-01c View ribbon. [View ribbon](../../../.build/r01c/87-view-after-reopen-physical.png). |
| N-06 — import progress/state truth | **Still open** | **Needs input** persisted through active hashing/commit, event backlog delayed ready-to-commit, and phase denominators reset. [Backlog](../../../.build/r01c/13-import-event-backlog.png), [commit](../../../.build/r01c/18-import-journal.png). |
| N-07 — removing the last box auto-arms placement | **Still open** | R-01c did not remove the last box after the new lock; no new visible evidence closes the prior finding. The ordinary no-box command still auto-arms **Pick in view** rather than presenting a neutral management state. [No-box invocation](../../../.build/r01c/31-viewing-box-open-retry.png). |

## 4. New R-01c findings

| ID | Class / severity | Finding | Violated record or spec gap | Proposed resolution |
|---|---|---|---|---|
| R01c-N01 | **Blocker — data integrity** | New/project replacement leaked the old Viewing Box into the new project, attempted to rebuild/store a now-nonexistent box, and left residency state that later rejected Draw publication. | File-project replacement/recovery; canonical project isolation; doctrine P2/P11; M-0.5 persistence/recovery. | **Fix code.** Make replacement one transaction: old viewer/project state remains isolated until the new project is opened; clear box, selection and resident registries together; rollback to the old project on failure. Gate New → import → draw → save/reopen on one process. |
| R01c-N02 | **Blocker — data integrity/recovery** | Boundary Close failed because the draw curve was stale/missing/wrong type, yet the invalid draft remained canonical. Reopen then failed with **CAD curve geometry is invalid or degenerate**; Cancel/Undo did not restore a valid project. | Draw DR-D1/DR-D5 atomic publication and cancellation; canonical all-or-none mutation; project reopen/recovery gate. | **Fix code.** Drafts must remain noncanonical until Finish/Close validates and commits. On failure, compensate completely or preserve a valid last-good document. Add this exact New → four tuples → Close failure → restart sequence to recovery tests. |
| R01c-N03 | **Major defect** | Rasterize publishes a height grid and then declares its own canonical bootstrap format unsupported; the warning repeats on reopen. | M-0.5 step 3; Pointcloud PC-D8/PC-D17 and Mesh MT-D26 hand-off; persistence truth. | **Fix code.** Ship the height-grid reader/renderer with the writer or refuse publication before commit. Gate create → visible use → save/reopen → DGM source. |
| R01c-N04 | **Major defect** | After a successful locked-box ground extraction, Viewing Box rebuild failed because its dataset ID was already registered. | VB-D3/VB-D8 restore and mixed-scene residency; lifecycle coordination after derived publication. | **Fix code.** Make restore idempotent or unregister/replace atomically; keep the locked box and all resident datasets usable after every point-cloud result publishes. |
| R01c-N05 | **Blocker** | DGM Check can pass, but Create Surface fails at Bake with **canonical provider output: canonical representation contract is invalid**. This exactly reproduces R-02c. | M-0.5 step 5; Mesh `G-B2-MESH-DRAFT-RULES`, `G-MT-1/3/5`, and recovery contract. | **Fix code.** Repair the staged surface representation/provider contract, retain the checked draft on failure, and gate successful publish/reopen/edit on the exact 145,377-point road subset. |
| R01c-N06 | **Major defect / misleading repair** | DGM Check reported 553 fixable errors. Choosing the only visible fix, **Exclude source**, changed the result to Check passed while the boundary remained displayed in Sources as role Boundary. | Mesh check/fix source truth; Function Contract state must be legible and canonical. | **Fix code/UI.** Mark excluded rows explicitly or remove them, summarize every applied repair, and require a new check when source participation changes. Never let “passed” coexist with an apparently participating invalid boundary. |
| R01c-N07 | **Major defect** | Two exact Breakline vertices were accepted, but Finish was inert: no publication, typed error, job, toast or recovery action. | Draw DR-D1/DR-D5 and M-0.5 step 4; Design System visible feedback. | **Fix code.** Finish must commit exactly once or return a typed reason while preserving the editable draft. Cover role-before-first-vertex and project-reopen state. |
| R01c-N08 | **Major performance/interaction defect** | After jobs were idle, the Builder GPU process sustained about 500% CPU while HUD showed 0.0 M points, p50 about 47–53 ms, and the clipped viewport was blank. | M-0.5 fluid-view/HUD requirement; viewer presented-frame and idle-resource gates. | **Fix code and measure.** Stop continuous work when no points are presented, expose renderer degradation honestly, and re-run the idle real-road presented-frame gate on both laptop and Windows GPU lane. |

## 5. What a RealWorks / RIB Civil user would miss most

1. **Immediate visual trust in the scan.** RealWorks treats large-cloud
   navigation, visible sampling, segmentation and the Limit Box as its working
   surface ([realworks dossier §§1, 2.3, W3–W4](../dossiers/realworks.md)).
   Builder still says the scan is committed/loaded while showing a blank view
   until restart, then can return to 0.0 M visible points after box work.
2. **A coherent Limit Box → clean/classify → derived-cloud loop.** RealWorks'
   box is manipulable, storable and directly feeds extraction; segmentation is
   stable on the visible region. Builder can now lock and extract, but fresh
   placement and fence picks fail, and post-extraction box restore breaks.
3. **A trustworthy boundary/breakline → checked DGM → repair → LandXML loop.**
   STRATIS exposes breaklines/boundaries, check/error-display/correction and
   named DGM publication, while RIB exchanges LandXML
   ([rib-civil dossier §§2.6, W5 and exchange](../dossiers/rib-civil.md)).
   Builder's boundary can corrupt reopen, Breakline Finish is silent, DGM
   publication fails after Check passed, and LandXML cannot execute.

## 6. Verdict against M-0.5

**Release 0.5 is still not usable at starter level.**

R-02b/R-02c made material, visible progress:

- New no longer blanks the whole shell.
- The named road is selectable and contextual predicates explain what is
  missing.
- Exact X/Y/Z tuples commit atomically.
- A bounded boundary-derived Viewing Box locks in 15.2 s.
- Whole-source and bounded ground extraction, Sample, Rasterize and typed Point
  measurement all produce visible results.

Those improvements do not satisfy the outcome. A pilot still cannot complete
either spine without implementation knowledge and recovery guesses:

- the fresh road is blank until a full restart;
- Segment cannot close a fence;
- boundary publication contaminates the canonical project and clean reopen;
- the height grid is unsupported by its own reader;
- box restore fails after ground extraction;
- Breakline Finish is silent;
- DGM creation fails after Check passed;
- no DGM can be edited or exported to LandXML.

M-0.5 requires the whole visible real-data workflow and all persistence,
recovery and correctness gates, not a collection of individually reachable
panels. There are multiple open blockers. Verdict: **FAIL; fix and rerun.**

## 7. Next prioritized list

1. **P0 — Repair New/project replacement isolation and add a one-process visible gate:** prior boxes/selection/residency never enter the new project; New → road import → draw → save/reopen remains valid.
2. **P0 — Make first publication visibly real:** the exact road must render immediately after commit/Frame/Zoom without restart, with presented-frame evidence and bounded idle GPU work.
3. **P0 — Make Draw publication all-or-none:** exact Boundary Close and Breakline Finish either store valid geometry once or preserve a noncanonical draft with a typed recovery; restart must open cleanly.
4. **P0 — Fix DGM staged-provider publication:** checked road-subset surface creates, reopens, edits and remains undoable; retain a usable checked draft after failure.
5. **P0 — Rerun both literal spines end to end:** named LAS → visible box-lock → ground → fence segment → sample/raster → boundary/breakline → checked/fixed/edited DGM → DXF/LandXML → measurement.
6. **P1 — Make raster output consumable:** created height grid renders, survives reopen and is accepted as a DGM source; never publish an unsupported format.
7. **P1 — Make Viewing Box lifecycle idempotent:** no stale cross-project box, no duplicate dataset on restore, neutral state after removal, and reliable fresh-void placement.
8. **P1 — Make DGM repair semantics explicit:** excluded sources visibly leave participation, fixes are summarized, Check invalidates on source changes, and error rows support jump/review.
9. **P1 — Finish fence interaction:** every accepted/rejected pick is visible, closed Polygon/Rectangle fences drive Keep/Remove, and the exact road path is qualified.
10. **P2 — Repair progress and chrome truth:** remove Needs-input/running contradictions, phase counters remain meaningful, tabs/prompts/fields do not collide, snaps have names, and HUD has a close affordance.

No product code was changed, nothing was committed, and unrelated dirty
worktree files were preserved.
