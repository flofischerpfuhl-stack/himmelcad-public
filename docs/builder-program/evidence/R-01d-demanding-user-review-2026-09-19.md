# R-01d demanding-user review — post-R-02d/R-02e visible-UI rerun

Date: 2026-09-19

Reviewer stance: demanding survey/Civil CAD user (15 years of Trimble
RealWorks, RIB Civil/STRATIS, Revit and Perspective)

Product snapshot at review start: `70d942e`; two concurrent documentation-only
commits advanced `HEAD` to `b6c9dc4` during the run without changing product
code

Result: **FAIL — the ordinary LAS intake has regressed to an unshipped
placeholder, so neither required road-scan spine can start. A boundary-first
fallback also published and reopened a DGM from a boundary alone although the
dialog says boundaries are 2D crops that never supply Z.**

## 1. Scope, method, machine and evidence limits

I read R-01c, R-02d and R-02e first, then the accepted direction, documentation
index, Design System and M-0.5 definition. The acceptance rule remains
[MASTER-PLAN M-0.5](../MASTER-PLAN.md): the owner and pilot offices must complete
the full real-scan workflow through visible UI without implementation
assistance; a partial path is not starter-level acceptance.

Builder was launched only through `scripts/ui-test-display.sh`, with a fresh
Electron profile on the private `DISPLAY=:90`. The launcher selected hardware
WebGL2 on the NVIDIA Quadro M2200 and recorded both GPU and process-display
proof. I never contacted or drove `DISPLAY=:0`. Product interaction used only
visible ribbon controls, panels, the viewport, construction bar, tree, context
state and keyboard entry. CDP was used for visible pointing, typing and page
screenshots, not the product console, automation protocol, SDK, sidecar RPC or
canonical commands.

The requested source and prepared hierarchy were present and unchanged:

```text
libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las
3,111,413,830 bytes; 103,713,735 points
.build/perf/viewer-baseline-datasets/PW_GHT_251215_Orscholz_Deponie-1-1-ff05d6cffc61/
```

At 18:39 CEST, before Builder:

```text
uptime: 1:06; load average 1.56, 1.76, 2.02
memory: 31 GiB total, 5 GiB used, 25 GiB available
swap: 1 GiB total, 0 GiB used
```

At 19:01 CEST:

```text
uptime: 1:28; load average 2.50, 3.08, 3.74
memory: 31 GiB total, 6 GiB used, 24 GiB available
swap: 1 GiB total, 0 GiB used
```

The owner-authorized PhotoLab documentation/test lane and remote Windows lane
were active. Available memory never approached the 8 GiB stop threshold. Per
the preamble I did not stop for `NOT IDLE`; all timings are informational. The
private-display frame rate is not judged as real-display performance.

The first two launcher starts were preflight retries after New and the primary
Import button produced no picker or feedback. Disabling portal use and adding a
window manager to the same private display did not change the result. The
third, final fresh profile exposed the decisive product state: **Import… ▾ →
Import files…** opens a product function panel saying **“Parameters for
file.import appear here once the function ships.”** This is not merely a hidden
native dialog. I therefore did not inject a path or use the prepared hierarchy
through a non-UI route.

The final project was the newly generated profile-local
`canonical-projects/builder-default.hcad`, not any reviewer's previous project.
Because the named LAS could not be selected, the required scan-first and
boundary-first road spines could not be repeated end to end. I continued only
with a strict visible-UI boundary-first fallback to establish independent
drafting, persistence and DGM behavior. It is not counted as a completed spine.

The run lasted about 22 minutes, inside the four-hour hard stop. Screenshots are
under `.build/r01d/` (4.2 MiB total); it contains no project or dataset copy and
no file larger than 1 GiB. No product code was changed and no commit was made.

## 2. Step record

### Pass 1 — required scan-first intent

| Step                                                   |        Works through UI? |           Informational time | Screenshot                                                                                                                                                                                         | Exact response and friction                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | -----------------------: | ---------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start fresh Builder profile                            |                  **Yes** | about 10 s after build/probe | [fresh default](../../../.build/r01d/00-final-start.png)                                                                                                                                           | Fresh profile opened a fresh empty `builder-default`; hardware WebGL2 was visible and the HUD said **“Idle — no frames presented.”** Startup still auto-opens a project rather than a start surface.                                                          |
| Create separately named fresh project                  |                   **No** |             >5 s observation | [New stayed in default project](../../../.build/r01d/01-new-no-dialog.png)                                                                                                                         | File → New focused the 56 × 47.5 px ribbon action but produced no visible dialog, activity, error or recovery. The shell stayed alive, so R-01c's blank-renderer symptom did not recur, but project replacement was not requalified.                          |
| Open the general import route                          |            **Regressed** |                    about 6 s | [visible menu](../../../.build/r01d/02-import-menu.png), [unshipped placeholder](../../../.build/r01d/03-import-no-dialog.png)                                                                     | The menu honestly lists **“Import files…”** and **“Choose LAS, LAZ, E57, or another supported format.”** Clicking it opens **“FUNCTION file import”** with **“Parameters for file.import appear here once the function ships.”** No picker or wizard appears. |
| Choose the named road LAS                              |         **No — blocker** |                      blocked | [placeholder](../../../.build/r01d/03-import-no-dialog.png)                                                                                                                                        | The source cannot be selected through the visible UI. No path was injected.                                                                                                                                                                                   |
| Registration / hierarchy / commit / first road frame   |                   **No** |                      blocked | same                                                                                                                                                                                               | The blocker is before registration; progress coalescing, atomic publication and first-frame fixes cannot be requalified.                                                                                                                                      |
| Scan-first box-lock → ground → segment → sample/raster |                   **No** |                      blocked | [explicit prerequisites](../../../.build/r01d/12-pointcloud-prerequisites.png)                                                                                                                     | With zero clouds all four Pointcloud actions are correctly disabled with **“Select one resident point cloud.”** The source prerequisite is honest but unavailable.                                                                                            |
| Breakline/boundary → checked/edited DGM                | **No valid road result** |                      blocked | —                                                                                                                                                                                                  | Drafting was probed separately below, but no scan-derived source exists.                                                                                                                                                                                      |
| DXF and LandXML, then reopened-file verification       |                   **No** |                      blocked | [export surface](../../../.build/r01d/24-export-panel.png), [LandXML units](../../../.build/r01d/25-landxml-units.png), [target still unset](../../../.build/r01d/26-landxml-target-no-dialog.png) | The LandXML Units control is present and honestly defaults to **Not set**. **Choose…** produced no visible target picker in the private lane, so Plan/Export stayed disabled. No DXF or LandXML was written or reopened.                                      |

### Pass 2 — required boundary-first intent, then bounded fallback

The required pass still begins with importing the road, so it is blocked by the
same intake regression. The following fallback uses the exact four R-01c
coordinates only to judge drafting and downstream source semantics:

```text
2538170.001 5486660.001 380.000
2538179.998 5486660.001 380.000
2538179.998 5486669.999 390.000
2538170.001 5486669.999 390.000
```

| Step                              |                  Works through UI? | Informational time | Screenshot                                                                                                                                                                                            | Exact response and friction                                                                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------: | -----------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open Boundary polygon             |                            **Yes** |               <1 s | [tool](../../../.build/r01d/04-boundary-tool.png)                                                                                                                                                     | The panel opens with Role Boundary, six icon-only snaps and exact X/Y/Z entry.                                                                                                                                                                                                                           |
| Enter exact boundary              |                            **Yes** |         about 20 s | [first vertex](../../../.build/r01d/05-boundary-first-vertex.png), [four vertices](../../../.build/r01d/06-boundary-four-vertices.png)                                                                | Each tuple committed only on Enter; there was no partial-tuple publication.                                                                                                                                                                                                                              |
| Close/publish boundary            |                        **Partial** |          about 2 s | [published boundary](../../../.build/r01d/07-boundary-closed.png)                                                                                                                                     | `Boundary polygon 1` appears in the tree and survives reopen, fixing the R-01c stale-residency failure. After Close, however, the panel changed Role to **Plain**, retained all four vertices, left Finish armed and emitted no success line. Selecting the tree row re-armed a new empty Boundary tool. |
| Derive Viewing Box                |   **Yes, UI contract still wrong** |        about 2.3 s | [entry](../../../.build/r01d/09-viewing-box-from-boundary.png), [created](../../../.build/r01d/10-viewing-box-created.png)                                                                            | From selection created exact extents, but the already-canonical tree node coexists with **Save as entity** and only raw Min/Max fields.                                                                                                                                                                  |
| Lock box                          |                  **Wrong success** | console says 0.2 s | [empty-cloud lock](../../../.build/r01d/11-empty-box-lock.png)                                                                                                                                        | At **Clouds: 0**, Lock completed and claimed **“Kept region is most of the cloud; clip planes remain active.”** This directly reconfirms R-01c D-03.                                                                                                                                                     |
| Extract ground                    |                             **No** |            blocked | [disabled actions](../../../.build/r01d/12-pointcloud-prerequisites.png)                                                                                                                              | Correctly disabled because no resident cloud exists.                                                                                                                                                                                                                                                     |
| Breakline                         |                        **Partial** |          about 8 s | [two vertices](../../../.build/r01d/15-breakline-two-vertices.png), [after Finish](../../../.build/r01d/16-breakline-finished.png)                                                                    | Finish now stores a tree entity, so the exact inert R-01c symptom is fixed. The tree calls it **Polyline 2**, the panel still says Role **Breakline**, both vertices and the active Finish button remain, and no completion feedback appears.                                                            |
| Point measurement                 |                            **Yes** |          about 4 s | [Point 1](../../../.build/r01d/13-measure-point.png)                                                                                                                                                  | Exact typed input stored `Measurements / Point 1` and survived reopen.                                                                                                                                                                                                                                   |
| Save, Close, Recent reopen        |                        **Partial** |     about 3 s each | [saved](../../../.build/r01d/17-saved.png), [closed](../../../.build/r01d/18-project-closed.png), [Recent](../../../.build/r01d/19-recent-menu.png), [reopened](../../../.build/r01d/20-reopened.png) | Boundary, `Polyline 2`, box and Point 1 persist. Close leaves the old Measurements panel and **Storing… measurement.list** in a **No project** shell; later reopen repeatedly re-arms Measure point. Project-owned UI state is not isolated.                                                             |
| Check boundary-only DGM           |                     **Wrong pass** |          about 1 s | [boundary-only sources](../../../.build/r01d/21-dgm-no-points.png), [Check passed](../../../.build/r01d/22-dgm-check-no-points.png)                                                                   | One source exists: `Boundary polygon 1`, Role Boundary. Check reports **“0 errors · 0 fixable”** and **“✓ Check passed”** even though there is no point, cloud or grid source.                                                                                                                           |
| Create/reopen boundary-only DGM   | **Wrong durable result — blocker** |        about 4.5 s | [created contradiction](../../../.build/r01d/23-dgm-boundary-only-create.png), [reopened](../../../.build/r01d/27-dgm-reopened.png)                                                                   | The dialog says **“Boundary role is 2D crop”** and **“They never supply Z.”** Create nevertheless publishes **2 triangles · 99.95 m² · Z 380.00–390.00 m**, then reopen restores one inline mesh. The invalid semantic result is durable and visibly uses the boundary heights.                          |
| Set LandXML units / choose output |           **Partial then blocked** |          about 4 s | [Units Not set](../../../.build/r01d/25-landxml-units.png), [no target](../../../.build/r01d/26-landxml-target-no-dialog.png)                                                                         | The R-02e Units control exists. I did not export the boundary-only DGM as if it were a valid road result; the output picker was also unreachable.                                                                                                                                                        |
| Settled viewer                    |                        **Partial** |        10 s settle | [idle HUD](../../../.build/r01d/28-settled-hud.png)                                                                                                                                                   | HUD says **“Idle — no frames presented”**, supporting the R-02e rest governor in this small scene. It still has no close affordance. Three one-second GPU samples were 0%, 16%, 16%; this active-tool, non-road scene does not requalify the real-road performance gate.                                 |

## 3. Diff against every R-01c finding

“Still open” includes findings whose required real-road evidence is unavailable
because the intake blocker occurs earlier. I do not convert an unexecuted gate
into a pass.

| R-01c finding                                                      | R-01d status                                                               | Visible evidence and assessment                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-01 — general LAS import unreachable                              | **Regressed**                                                              | The general entry exists but opens an explicit unshipped `file.import` placeholder rather than a picker. [Menu](../../../.build/r01d/02-import-menu.png), [placeholder](../../../.build/r01d/03-import-no-dialog.png).                                                                                                                             |
| B-02 — New blanks the renderer                                     | **Fixed (exact symptom)**                                                  | New did not blank the shell. It also did not create a project or give feedback, so replacement itself is not qualified. [No response](../../../.build/r01d/01-new-no-dialog.png).                                                                                                                                                                  |
| B-03 — default-layer collision blocks boundary                     | **Fixed**                                                                  | Boundary, breakline and Point 1 published without `default-layer` errors and reopened. [Reopen](../../../.build/r01d/20-reopened.png).                                                                                                                                                                                                             |
| B-04 — whole real-data acceptance spine unqualified                | **Still open**                                                             | Both required spines stop before file selection.                                                                                                                                                                                                                                                                                                   |
| D-01 — Viewing Box persistence contradicts “immediately canonical” | **Still open**                                                             | `Viewing Box 1` is already in the tree while **Save as entity** remains visible. [Evidence](../../../.build/r01d/10-viewing-box-created.png).                                                                                                                                                                                                      |
| D-02 — raw Min/Max instead of accepted box editor/management       | **Still open**                                                             | Six Min/Max fields remain; Center/Size/Rotation groups are absent. [Evidence](../../../.build/r01d/10-viewing-box-created.png).                                                                                                                                                                                                                    |
| D-03 — Lock reports success with zero clouds                       | **Still open, directly reconfirmed**                                       | Clouds: 0, yet lock completes and claims most of “the cloud” is kept. [Evidence](../../../.build/r01d/11-empty-box-lock.png).                                                                                                                                                                                                                      |
| D-04 — HUD samples/close behavior                                  | **Still open**                                                             | Rest copy is improved to **Idle — no frames presented**, but the 334.8 × 63.5 px HUD has no close control. [Evidence](../../../.build/r01d/28-settled-hud.png).                                                                                                                                                                                    |
| D-05 — unavailable actions fail silently                           | **Still open**                                                             | New and export **Choose…** accept input without activity, error or recovery. The import submenu is explicit but leads to an unshipped placeholder.                                                                                                                                                                                                 |
| D-06 — typed Measure Point does not create measurement             | **Fixed**                                                                  | Exact Point 1 stores and reopens. [Evidence](../../../.build/r01d/13-measure-point.png), [reopen](../../../.build/r01d/20-reopened.png).                                                                                                                                                                                                           |
| D-07 — clipped/colliding core controls                             | **Still open**                                                             | Large-coordinate box inputs are 70.5 px wide and visibly elide their 14-character values; function tabs overflow behind `⋯`. Construction fields no longer overlap at 1488 px, but the finding is not closed. [Box](../../../.build/r01d/10-viewing-box-created.png).                                                                              |
| F-01 — no empty-project import CTA                                 | **Still open**                                                             | The 846 × 464 px empty viewport has no central import action. The no-project shell only says **No project open** at left. [Fresh](../../../.build/r01d/00-final-start.png), [closed](../../../.build/r01d/18-project-closed.png).                                                                                                                  |
| F-02 — pointcloud prerequisites hidden                             | **Fixed**                                                                  | All four actions are disabled with **Select one resident point cloud.** [Evidence](../../../.build/r01d/12-pointcloud-prerequisites.png).                                                                                                                                                                                                          |
| F-03 — snap controls are icon-only                                 | **Still open**                                                             | Six 24 × 24 px icon-only buttons expose no visible active snap names or candidate source. [Evidence](../../../.build/r01d/16-breakline-finished.png).                                                                                                                                                                                              |
| F-04 — unsafe auto-open of mutable work                            | **Still open / not requalified**                                           | Fresh profile auto-opens `builder-default`; there is still no safe start surface. A prior user's mutable project cannot exist in a fresh profile, so the exact cross-session case is untested.                                                                                                                                                     |
| N-01 — published road is visually blank                            | **Still open / not requalified**                                           | Road publication is unreachable because B-01 regressed.                                                                                                                                                                                                                                                                                            |
| N-02 — cloud row cannot enter selection state                      | **Still open / not requalified**                                           | No cloud can be imported.                                                                                                                                                                                                                                                                                                                          |
| N-03 — bounded Viewing Box Lock remains at 0%                      | **Fixed exact 0%-stall symptom only**                                      | Empty lock completed in 0.2 s, and R-02d has road evidence; this run cannot requalify a bounded road box. The zero-cloud success remains D-03.                                                                                                                                                                                                     |
| N-04 — exact boundary input commits a partial tuple                | **Fixed**                                                                  | Four tuples appear only after explicit Enter. [Evidence](../../../.build/r01d/06-boundary-four-vertices.png).                                                                                                                                                                                                                                      |
| N-05 — View exposes unshipped placeholders                         | **Fixed for Color Mode/Background**                                        | Those commands remain absent. A new unshipped placeholder now appears under File → Import instead.                                                                                                                                                                                                                                                 |
| N-06 — import progress/state truth                                 | **Still open / not requalified**                                           | Import never starts; the R-02e 10 Hz/coalescing correction cannot be observed.                                                                                                                                                                                                                                                                     |
| N-07 — removing the last box auto-arms placement                   | **Still open / not requalified**                                           | The box was retained for recovery evidence. The ordinary Viewing Box command still starts **Pick in view…** as the primary state.                                                                                                                                                                                                                  |
| R01c-N01 — New/project replacement leaks old state                 | **Still open**                                                             | Canonical entities reopen correctly, but Close leaves the Measurements panel and **Storing… measurement.list** in the no-project shell; reopen re-arms Measure point and logs repeated prompts. New itself is unreachable. [Closed](../../../.build/r01d/18-project-closed.png), [reopened active tool](../../../.build/r01d/27-dgm-reopened.png). |
| R01c-N02 — failed Boundary Close leaves invalid canonical curve    | **Fixed**                                                                  | Boundary Close publishes once and save/reopen remains valid. [Evidence](../../../.build/r01d/07-boundary-closed.png), [reopen](../../../.build/r01d/20-reopened.png).                                                                                                                                                                              |
| R01c-N03 — height grid writer/reader mismatch                      | **Still open / not requalified**                                           | Rasterize is unreachable without the road. R-02d evidence says the implementation changed, but R-01d cannot supply fresh visible proof.                                                                                                                                                                                                            |
| R01c-N04 — box restore duplicates dataset after Ground             | **Still open / not requalified**                                           | Ground is unreachable.                                                                                                                                                                                                                                                                                                                             |
| R01c-N05 — DGM Bake fails provider contract                        | **Fixed exact provider error; replaced by a blocker**                      | A surface publishes and reopens without the old contract error. It is semantically invalid because a boundary alone supplied the surface Z. [Created](../../../.build/r01d/23-dgm-boundary-only-create.png), [reopened](../../../.build/r01d/27-dgm-reopened.png).                                                                                 |
| R01c-N06 — Exclude source makes Check misleading                   | **Still open / not requalified**                                           | No road diagnostic set exists. A separate misleading Check now passes a boundary-only source.                                                                                                                                                                                                                                                      |
| R01c-N07 — Breakline Finish is inert                               | **Fixed exact inert result; replacement friction**                         | Finish adds `Polyline 2` and it reopens, but gives no completion message, retains the two vertices and leaves Finish active. [Evidence](../../../.build/r01d/16-breakline-finished.png).                                                                                                                                                           |
| R01c-N08 — idle renderer saturates CPU                             | **Fixed in the small-scene rest-state observation; road gate unqualified** | HUD reaches **Idle — no frames presented** instead of continuous p50/p95 frames. The named road was unavailable, so no claim is made for the real-road gate. [Evidence](../../../.build/r01d/28-settled-hud.png).                                                                                                                                  |

## 4. New R-01d findings

### R01d-N01 — Blocker: the shipped LAS front door opens an unshipped placeholder

The File ribbon's primary Import action is at x=528.3, y=79.0,
63.3 × 47.5 px in the 1488 × 924 app surface. Its dropdown visibly promises
**Import files…** at x=543.3, y=137.5 with the subtitle **Choose LAS, LAZ, E57,
or another supported format**. Activation opens a right function panel at
x=1156, y=166, 320 × 726 px. The only body copy is at x=1169, y=253,
294 × 39.4 px: **Parameters for file.import appear here once the function
ships.**

Expected per Design System discoverability, complete-flow and copy rules: the
same visible command must open the general file picker and registration flow or
be disabled with a truthful, actionable reason. An enabled shipped entry must
not advertise a capability and then call it unshipped. Resolution: **fix code**
and gate the exact private-display path with the named LAS; also gate New,
Open, output-target Choose and reopened-file selection in the same lane.

Evidence: [menu](../../../.build/r01d/02-import-menu.png),
[placeholder](../../../.build/r01d/03-import-no-dialog.png).

### R01d-N02 — Blocker / data integrity: a boundary-only DGM passes Check and supplies Z

The Create surface dialog visibly says **Boundary role is 2D crop** at
x=674.7, y=452.4, 140.6 × 15.6 px, and the explanatory block at x=650.7,
y=487.2, 177.5 × 72.8 px ends **They never supply Z.** With no point, cloud or
grid source, the success card at x=853.3, y=307.4, 233.8 × 44.8 px says
**✓ Check passed**. Create then publishes 2 triangles, 99.95 m², Z
380.00–390.00 m and the reopened viewport visibly shows the sloped surface.

Expected: Check must produce a blocking typed diagnostic such as **A DGM
requires at least one point, cloud, or grid source.** Create surface must be
disabled until that diagnostic is resolved. A boundary may crop/drape only
after an evaluated surface exists and must not become its elevation source.
This violates Mesh source truth, the dialog's own copy, Design System truth and
the no-invented-domain-truth principle. Resolution: **fix code**, invalidate
existing checked drafts when their participating source roles change, and add
boundary-only, exclusion-only and breakline-only negative gates plus
save/reopen rejection of an invalid result.

Evidence: [Check passed](../../../.build/r01d/22-dgm-check-no-points.png),
[durable result](../../../.build/r01d/23-dgm-boundary-only-create.png),
[reopened](../../../.build/r01d/27-dgm-reopened.png).

### R01d-N03 — Major lifecycle defect: project Close does not retire project-owned tool UI

After File → Close, the center says **No project open**, but the right panel at
x=1156, y=166, 320 × 726 px still shows the previous Measurements function and
the bottom status says **Storing… measurement.list**. After Recent reopen, the
right tab becomes **Measure point**, the construction bar is armed and the
console contains repeated **Point: pick or type an exact anchor.** lines.

Expected: the project close boundary must atomically retire active tools,
function tabs, construction state and storing/activity state before showing
No project. The no-project shell should show Idle and no project-owned function
surface. Resolution: **fix code** at the same reset boundary used for New and
Close; gate close while each Draw/Inspect/View tool is armed, then reopen and
assert one clean restored document with no prompt replay.

Evidence: [closed](../../../.build/r01d/18-project-closed.png),
[reopened active Measure point](../../../.build/r01d/27-dgm-reopened.png).

### R01d-N04 — Major UI/semantic defect: Breakline publishes under a generic name and leaves an ambiguous completed draft

After selecting Role **Breakline**, two exact vertices and Finish, the left
tree displays **Polyline 2** while the 320 px right panel still displays Role
**Breakline**, Vertices **2**, an enabled primary **Finish** button and no
success message. The six snaps in that panel are each 24 × 24 px at x=1169,
1197, 1225, 1253, 1281 and 1309 (y=314.4), with no visible text.

Expected: the entity row should read **Breakline 1** (or another explicit
breakline name); Finish should visibly confirm publication and either reset to
a clearly empty next draft or close the tool. Snap names and the active
candidate/source must be visible in the panel or construction bar; aria labels
alone do not satisfy ordinary discovery. Resolution: **fix UI and command
result state**; retain accessible labels, add compact visible snap names/state,
and gate role → Finish → reopen identity.

Evidence: [two vertices](../../../.build/r01d/15-breakline-two-vertices.png),
[after Finish](../../../.build/r01d/16-breakline-finished.png).

## 5. Pixel-precise UI disposition for carried findings

These are implementation-ready descriptions for the UI findings not already
fully specified in §4:

- **Empty intake state:** the central canvas is x=297, y=167, 846 × 464 px and
  has no action. Add one shared primary Button centered in the empty state,
  proposed 160 × 32 px, copy **Import point cloud…**, invoking the same
  `file.import` command. Keep File → Import as the parallel visible route.
- **Viewing Box semantics:** the panel is x=1156, y=166, 320 × 726 px.
  **Save as entity** occupies x=1169, y=414.9, 294 × 24 px despite the tree
  entity already existing; remove it after canonical creation or rename it to
  a truthful distinct act. Each large-coordinate extent input is only
  70.5 × 27 px (x=1223/1361), so `2538170.001000` cannot be read. Replace the
  raw-only layout with the accepted always-visible Center, Size and Rotation
  groups; if Min/Max remain as an advanced group, use at least 118 px per
  numeric input at this panel width or a single-column layout with the full
  committed value visible.
- **Zero-cloud Lock:** when status is **Clouds: 0**, the 294 px Lock action must
  be disabled with copy **Add or select a resident point cloud before locking.**
  It must not show **Kept region is most of the cloud**. If an empty geometric
  box is intentionally allowed, use a separate non-baking **Save box** state
  and never claim resident preparation.
- **HUD:** the HUD is x=305, y=175, 334.8 × 63.5 px. Add the shared 24 × 24 px
  icon close control at its top-right (x≈608, y≈179) with aria/title **Close
  HUD**; View → HUD remains the reopen path. Preserve the corrected idle copy.
- **Large-coordinate construction:** X/Y/Z inputs are 68.1 × 20 px at x=516.2,
  618.0 and 719.3. The current prompt fits at 1488 px, but the fields cannot
  display the committed 10-digit coordinates plus decimals. Use at least
  104 px per X/Y field or a two-row responsive construction bar; the active
  field must show the full value without horizontal guessing.

## 6. What a RealWorks / RIB Civil user would miss most

1. **A dependable scan front door.** The product visibly promises LAS/LAZ/E57
   but routes to “once the function ships,” so the RealWorks starting act is
   unavailable.
2. **A trustworthy Limit Box → clean/classify loop.** The box can be created
   and locked with zero clouds, and it claims most of a nonexistent cloud is
   kept. No real source can reach Ground, Segment, Sample or Rasterize.
3. **A source-honest DGM → exchange loop.** Builder accepts a boundary-only
   DGM despite saying the boundary never supplies Z, persists it, and cannot
   reach the output target picker for LandXML/DXF verification.

## 7. Verdict against M-0.5

**Release 0.5 is not usable at starter level. Verdict: FAIL.**

This is not a timing judgement and not a marginal polish failure. The ordinary
visible Import command explicitly leads to an unshipped function surface, so a
pilot cannot select the named road scan. Both mandated spines fail before their
first domain step. The pass rule requires both spines to complete without
implementation assistance and to produce reopened DXF and LandXML; neither
file was written.

The fallback does confirm material R-02d/R-02e progress: exact tuples are
atomic; Boundary and Breakline publish; Point 1 persists; a DGM provider result
can publish/reopen; LandXML Units exists; and the small settled viewer reports
no presented frames. Those improvements cannot offset two blockers: intake is
unreachable, and DGM source validation now permits a durable result that
contradicts its own boundary semantics.

## 8. Prioritized next list

### Blocks the pilot hand-over

1. **Restore and physically gate File → Import files…** with the named LAS on
   `ui-test-display.sh`; remove the unshipped placeholder, then require visible
   registration, atomic publication and a first road frame.
2. **Fix DGM source validation:** Boundary/Exclusion are 2D crop roles only;
   require an evaluated point/cloud/grid source, reject and prevent persistence
   of the boundary-only 2-triangle result.
3. **Make every native file boundary work in the official private lane:** New,
   Open, import selection, export target selection and exported-file reopen
   must appear on the private display or return an actionable typed failure.
4. **Retire project-owned UI state atomically on Close/New:** no Measurements,
   Measure point, construction bar, storing state or prompt replay in the
   no-project/replacement shell.
5. **Rerun both complete road spines without fallback:** named LAS → visible
   scan → box-lock → Ground → fence segmentation → Sample/Rasterize →
   Boundary/Breakline → checked/fixed/edited DGM → DXF and LandXML → reopen
   each export, plus save/restart recovery.
6. **Requalify the carried real-road lifecycle gates:** height-grid residency,
   post-Ground box restore, cloud selection, first frame, DGM repair semantics,
   edit/undo and the settled real-road renderer.

### Polish

1. Remove or truthfully rename Viewing Box **Save as entity** and implement the
   accepted Center/Size/Rotation editor with readable large-coordinate fields.
2. Disable or separate empty-cloud Lock and replace the false “most of the
   cloud” copy.
3. Rename stored breaklines as Breakline entities and give Finish a clear
   completion/reset state.
4. Add visible snap names/current candidate source while preserving the six
   accessible buttons.
5. Add the central **Import point cloud…** empty-state action.
6. Add a 24 × 24 px **Close HUD** control and keep View → HUD as the reopen
   action.

No product code was changed, no repository or dataset was copied, no file over
1 GiB remains under `.build/r01d/`, and no commit was created.
