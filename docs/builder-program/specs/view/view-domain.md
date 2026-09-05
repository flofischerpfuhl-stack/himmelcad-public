# View domain — specification (View ribbon tab)

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2. Document class: plan.
Written against the current contract (incl.
the dossier-wide A2 absence rule and the E2 extreme-member and
gesture-map rules) and current doctrine (incl. P4). Covers every
View-tab function **except the viewing box** (`viewing-box.md`); this
document stays consistent with that sibling, reuses its decision records
where they bind a class (VB-D5 Escape ladder, VB-D6 chip, VB-D12 bake
threshold), and never duplicates it. Primary A2 evidence:
`docs/builder-program/dossiers/trimble-perspective.md`; secondary:
`dossiers/realworks.md`, `dossiers/revit.md` (§2.5/§2.6 for the display
layer model), `dossiers/rib-civil.md`. E1 artifacts:
`viewing-box-visual-criteria.md` for shared clip-family visuals plus the
failable criteria in §4 (in-repo per contract E1).

Cross-spec records (program README registry rules — cite and revise,
never re-disposition): **VD-D8** is the shared two-layer display record
(cited by the Pointcloud spec; revises PC-D11's View-tab accelerator
clause while PC-D11's canonical layer stands unchanged). **VD-D13**
specifies ViewState v2 for every protocol consumer. Gates reference
**VB-D7 as revised interval-based in `viewing-box.md`**; the reciprocal
revision is present there. P4 and
PC-D16 govern clip-scoped destructive applies; this spec cites them.

Workflow level (§2): section-plane clip family, view bookmarks, the
presentation model, and the diagnostics overlay (performance HUD). The
rest is contract level (§3); the station view is catalogued and deferred
with reason (VD-D11).

## 1. Function catalog (registry rows)

Registry rows per the program README: written at specification time; no
row below claims an act another spec's row claims — per-entity display
rows live in the Pointcloud spec's catalog (`pointcloud.display`,
`pointcloud.point_size`) and are only _referenced_ here via VD-D8.
Access-path key: R ribbon · X entity context menu · Q viewport quick
surface · C console · A automation (AI agent + Python SDK) · K keyboard.
Absent paths are per-function decisions recorded in §3; all paths
resolve to the same canonical command or query (B1).

| Id                                         | Access                                      | Surface                   | Perf class                           | Automation                        | Status                                                                                                                |
| ------------------------------------------ | ------------------------------------------- | ------------------------- | ------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `view.mode` (3D / 2.5D / 2D)               | R C A                                       | inline                    | bounded                              | `view.state.set` (navigationMode) | exists, wired (`App.tsx:432–436`) — contract                                                                          |
| `view.projection` (perspective / parallel) | R C A                                       | inline                    | bounded                              | `view.state.set` (camera)         | missing — contract                                                                                                    |
| `view.frame` (Frame All)                   | R C A                                       | inline                    | bounded                              | `view.frame`                      | exists, wired (`BuilderKernelViewport.tsx:278`) — contract                                                            |
| `view.frame-selection`                     | R X C A                                     | inline                    | bounded                              | `view.frame_selection`            | missing — contract                                                                                                    |
| `view.preset` (Top / Front / Right / Iso)  | R Q C A K(registry)                         | inline                    | bounded                              | `view.preset.apply`               | missing — contract                                                                                                    |
| `view.viewing-box`                         | see sibling spec                            | right panel               | continuous                           | `viewing_box.*`                   | **specified** — `viewing-box.md`                                                                                      |
| `view.section` (plane clip family)         | R X Q C A                                   | right panel               | continuous                           | `section.*`                       | console-only today (`App.tsx:560–679`) — **workflow**, §2.1                                                           |
| `clip.clear` (whole clip family)           | R(panel) C A                                | inline                    | bounded                              | `clip.clear`                      | broken semantics today — **workflow**, §2.1                                                                           |
| `view.bookmarks`                           | R X C A                                     | right panel               | bounded→long (extreme: rebake, §2.2) | `bookmark.*`                      | missing — **workflow**, §2.2                                                                                          |
| `view.background`                          | R C A                                       | anchored dropdown         | bounded                              | `view.presentation.set`           | dead button today (`App.tsx:941–945`) — **workflow**, §2.3                                                            |
| `view.color-mode` (view-level override)    | R C A                                       | anchored dropdown         | bounded                              | `view.presentation.set`           | dead button today; shared model VD-D8 — **workflow**, §2.3                                                            |
| `view.render-style` (polymorphic)          | A C; surfaced by owning Mesh/BIM properties | typed override            | bounded                              | `view.presentation.set`           | protocol-only today; Mesh values realistic/abstract/wireframe/shaded-edges per MT-D6                                  |
| `view.overlays` (grid, axes, compass)      | R C A                                       | inline toggles            | bounded                              | `view.presentation.set`           | protocol-only — contract                                                                                              |
| `view.point-size` (view × multiplier)      | R C A                                       | popover                   | bounded                              | `view.point_size.set`             | owner: pointcloud; exists as global px (`App.tsx:73`); becomes ×1.0 multiplier per PC-D11 (adopted, VD-D8) — contract |
| `view.navigation` (settings)               | R C A                                       | anchored dropdown         | bounded                              | `view.navigation.get/set`         | hardcoded today (`KernelNavigationController.ts:381–456`) — contract                                                  |
| `view.diagnostics` (performance HUD)       | R C A                                       | viewport overlay          | continuous (overlay)                 | `view.diagnostics.get/sample`     | telemetry unsurfaced — **workflow**, §2.4                                                                             |
| `view.station` (station / panorama view)   | R X — deferred                              | viewport mode             | continuous                           | `view.station.*`                  | owner: registration-stations; deferred — VD-D11 discharged by RS-D5                                                   |
| `view.section-create`                      | View · Clip                                 | R X(on selected line) C A | panel + viewport preview             | cont; bnd commit                  | `view.section.preview/create`                                                                                         |

Viewer Core performance, quality-governor and cancellable 3D↔2D/2.5D transition amendments are specified in `viewer-core-addendum.md` (VC-D1…VC-D12).

Ribbon layout proposal (placement tunable per owner decision D2): groups
**Camera** (Frame All, Frame Selection, 3D, 2.5D, 2D, presets,
projection), **Clip** (Viewing Box, Sections, Clear clips), **Measure**
(Measure split + Measurements toggle, MI-D1), **Style**
(Background, Color mode override, Point size), **Overlays** (Grid, Axes,
Compass), **Navigation**, **Diagnostics**. Today's View tab is Camera +
Style only (`apps/builder/renderer/src/ribbon.ts:74–95`).

## 2. Workflow narratives

### 2.1 Section planes — the clip family gets a face

Today the single clip planes are console incantations only:
`view.clip.horizontal <z>`, `view.clip.vertical-x <x>`,
`view.clip.vertical-y <y>`, `view.clip.clear` (`App.tsx:560–679`) — a
stated discoverability violation (`docs/DESIGN-SYSTEM.md`: every
capability needs a visible UI entry). The family is also semantically
broken: each command _replaces_ the one un-scoped clip volume (id
`builder-user-section`), and `view.clip.clear` empties only that channel
(`App.tsx:622–623`) while the viewing box lives in a separate scoped
channel (`BuilderKernelViewport.tsx:531, 589, 637`) and automation holds
a live _third_ value-typed channel (`setAutomationClipVolumes`,
`App.tsx:163–165`) — so "clear" leaves the box clipping and automation
clips invisible to the family. This spec unifies all three (VD-D1,
VD-D13).

The user wants a horizontal cut through a multi-storey scan. On the View
tab they press **Sections**; the right panel opens — same panel pattern,
Escape ladder, and chip behavior as the viewing-box sibling (VB-D5/VB-D6
class rules; the ladder is UIP-D14's). The panel offers three families:
**Horizontal**, **Vertical X**, **Vertical Y**. They press Horizontal
and either click the model — the plane lands at the picked elevation —
or type the coordinate into the already-focused field (RIB F5-Box norm:
every mouse construction has a numeric twin, `rib-civil.md` §2.2). The
cut applies immediately: the discarded side disappears, the plane
renders as an outlined rectangle with a normal arrow, and it is a
canonical entity named "Horizontal 12.40" from that second (VB-D1 class;
P1). Dragging the arrow moves the plane along its normal at full frame
rate, the field counting along; typing commits on Enter/blur, Escape
reverts. **Flip** swaps the kept side (X5 keep-pair); **± step** nudges
by a typeable increment — walking storeys plane-by-plane, the semantics
Trimble Access documents for storey slicing with its limit box
(`trimble-perspective.md` §2.4 [S7], adapted from slab to plane; slab
mode queued, VD-D12).

Up to one section per family is active at once; active sections compose
by intersection with each other and the active viewing box (VD-D2) — a
horizontal plus a vertical cut isolates a quadrant without a box. The
panel lists all stored sections with active ones marked; activation,
rename, and removal are journaled and undoable, removal without
confirmation (VB §1.7 pattern). Closing the panel keeps the cuts alive;
the shared clip chip shows a single active clip's name, or "3 clips"
with names in the tooltip when several are active (VD-D1). Everything
that acts on geometry acts on the visible set — **P4**: picking,
snapping, measurement, selection, _and destructive applies_ exclude
clipped-away content; a segmentation fence delete with an active section
must not eat the hidden storeys (the apply-side mechanics are PC-D16's;
the §7 cross-test asserts it against sections).

**Clear clips** — in the panel, console `clip.clear` (old
`view.clip.clear` becomes an alias), and automation `clip.clear` —
deactivates _every_ active clip, sections and viewing box alike, as one
journaled step. Deactivation changes activation only: a locked box keeps
its lock flag and its revision-keyed bake cache (VB-D3) untouched, so
clear→undo is instant and lossless. Re-activating a locked box whose
bake key went stale (source edits since) runs the VB §1.3 auto-rebake —
long-running, with its progress and cancel, never silently (finding 4).
Nothing is deleted; Ctrl+Z brings the cut state back. Reference
grounding: RealWorks ships a positionable cutting plane distinct from
its limit box (`realworks.md` §2.5 [5] — flagged thin there, used as
existence evidence only); Perspective and Access have no standalone
plane (their limit box fills the role, `trimble-perspective.md`
§2.3–2.4, checked) — the per-axis family is a stated deviation kept
because kernel and console already support it and it costs only the UI
this spec adds.

### 2.2 View bookmarks — named views that come back

The user orbits into the exact angle that shows the bridge-bearing
damage, sets an elevation color override and a horizontal section, and
wants this view back next week and in the agent's report. View tab →
**Bookmarks**; the panel opens with **Capture view**. One click creates
"View 1", renamed inline to "Bearing detail". A bookmark is a canonical,
journaled entity (P1 — which names view bookmarks verbatim) capturing
the **view layer only** (VD-D3): camera pose and projection, navigation
mode, presentation including the view-level display overrides of VD-D8,
the active clip set _by entity reference_, and a snapshot of
**canonical** entity visibility by reference. Deliberately not captured:
selection (task state), per-entity canonical display styles (they belong
to the entity — restoring a view must not revert later style edits),
view-local automation hides (App.tsx:153–161 — session state), and the
view point-size multiplier (workstation comfort, VD-D8).

Clicking a bookmark restores it: the camera animates over ≤ 200 ms
(design-system animation budget), presentation applies, and the
referenced clips and visibility re-apply as one journaled step (VD-D4).
Restore is bounded in the typical case; its extreme member (contract E2
extreme-member rule) is re-activating a locked viewing box whose bake
key went stale — that path is long-running and shows the VB §1.3
progress state with cancel; cancel leaves the box active and unlocked-
rendering per VB-D3's cache rules, never a partial bake. If a referenced
clip or hidden entity was deleted since capture, the rest restores and
the console names each missing entity — never a silent partial restore
claiming success (design-system UI copy). **Recapture** updates a
bookmark to the current view; rename and remove are journaled and
undoable. Bookmarks appear under a Views group in the left entity area
with a context menu (restore / recapture / rename / remove), travel in
`.hcadx` archives (owner decision D1), and are fully automation-visible:
`bookmark.list / capture / restore / rename / remove` — "return to the
bearing detail view and screenshot it" is an executable agent
instruction (X3), chaining `bookmark.restore` with `view.screenshot`
(`view.ts:176–179`).

Reference grounding (re-grounded per review finding 3): RealWorks
2026.10 attaches saved camera **view stations** and screen captures to
annotations (`realworks.md` §2.6 [6]) — we adopt named, restorable saved
camera views as first-class items rather than annotation attachments
(stated difference: P1 makes them entities in their own right). Revit
**view templates** bundle view properties — scale, detail level,
visibility/graphics, filters — applied per view (`revit.md` §2.6
[S22, S23]) — we adopt the bundling of presentation with the view;
deviations: no include/exclude matrix and no assigned-template locking
(single-viewport product today; queued consideration rides multi-view
work, VD-D12), and clip capture by entity reference has no documented
reference equivalent — grounded in P1/X3.

### 2.3 Presentation — replacing the assert with a two-layer model

Today `view.background` and `view.color-mode` are dead ribbon buttons
opening a "parameters appear here once the function ships" placeholder
(`App.tsx:941–945`), and `assertSupportedBuilderPresentation`
(`App.tsx:1312–1323`) _throws_ whenever automation requests anything but
black background, source colors, no grid, no axes, outline on. The
assert is deleted and replaced by a typed presentation state (VD-D6) on
the two-layer display model (VD-D8, shared with the Pointcloud spec).

The layers, from the Revit reference architecture — object styles
below, per-view visibility/graphics overrides above (`revit.md` §2.5
[S16, S20], §2.6 [S20–S23]): **below**, per-entity canonical display
styles — color source, mode parameters, per-entity point size — exactly
as the Pointcloud spec specifies them (PC-D11: journaled, canonical,
automation-visible; unchanged by this spec). **Above**, un-journaled
view-level presentation: background, overlays, render style, and a
**Color mode override** whose default is **Follow entity display** —
render every cloud by its own canonical style. Selecting Intensity,
Elevation (typed min/max, auto by default — Access documents
color-by-elevation with typed min/max, `trimble-perspective.md` §2.2
[S8]), Uniform, or Source overrides all point-cloud entities at render
time for this view without touching any entity's style; switching back
to Follow entity display drops the override. Per-scan/per-station
coloring is queued with registration (dossier §5 binding; VD-D12). The
override is captured by bookmarks; canonical styles are not (§2.2).
Switching is reload-free and bounded — attributes are resident, matching
the dossier's W6 observation (flagged as inference there; the §6 gate
makes it a verified property here).

**Background** is the neighboring dropdown: **Theme** (follows the app
theme; RealWorks precedent for theme-linked viewing, `realworks.md`
§2.10), **Black**, **White** (Perspective offers background black/white,
[S2]). `transparent` is dropped from interactive view state in ViewState
v2 (VD-D13) and remains a screenshot-request option only (`view.ts:103`).
Grid and axes toggles live in the Overlays group. **Point size** on the
View tab becomes the view-local unitless **× multiplier** (default 1.0)
over per-entity sizes, adopting PC-D11 verbatim; it is
automation-visible in v2 presentation and _not_ captured by bookmarks
(VD-D8).

Presentation is project-persisted view state: restored exactly on
reopen, readable and writable through `view.state.get/set` with full
parity, but **not** journaled — Ctrl+Z never reverts a background switch
(VD-D5). PhotoLab ships the identical assert
(`apps/photolab/renderer/src/App.tsx:4076–4085`); the class disposition
is recorded in VD-D13: the typed model replaces both, PhotoLab surfacing
its subset behind its release priority.

### 2.4 Diagnostics overlay — the performance HUD

The renderer measures everything and shows nothing: robust frame
percentiles, upload and residency, and workload peaks live in
`FrameTelemetrySnapshot`
(`crates/himmelcad-render/src/hardware_policy.rs:450–471`; p50/p95/p99
distributions for CPU, GPU, and effective time, :436–448), streaming
lifecycle counters in `KernelStreamingTelemetrySnapshot`
(`packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts:139`),
and governor state in `RuntimeQualityState` (`hardware_policy.rs:587`);
the viewer session already observes frame telemetry
(`KernelViewerSession.ts:785`). The `view.performance` ribbon button,
meanwhile, opens the point-size slider (`App.tsx:908–927`) — a
misassignment this spec retires (VD-D10).

One metric is missing and is added by this spec (review finding 2): a
**presented-frame-interval distribution** — time between frames actually
presented to the user, sampled at presentation cadence (the viewport
already exposes presentation timing: `waitForNextPresentedFrame`,
`App.tsx:140,166`). Render-cost timings cannot see presentation-side
jank (React/DOM sync between kernel frames); interval p95 can. The HUD
shows both, and **every D1 gate in this domain runs on presented-
interval p95 ≤ 2× target frame time** — the same metric class as VB-D7
in its interval-based revision (owned by `viewing-box.md`).

The user whose orbit stutters on a 2-billion-point project presses
**Diagnostics**. A compact overlay island appears in the viewport's
top-right corner — mono typeface, theme tokens, both themes — showing:
presented-frame interval and FPS with p50/p95/p99; render cost
p50/p95/p99 with the CPU/GPU split; mean upload per frame; GPU residency
against budget; peak points/splats/triangles/draw calls; streaming per
class (in-flight, decoded, uploaded, failed); and the governor tier with
active degradations. When the render-on-demand viewport is idle the HUD
says **"Idle — no frames presented"** instead of counting zeros toward
the distributions or reading as a hang (finding 13). It refreshes at
~2 Hz from the telemetry window (tunable, X6). The island closes from
the ribbon toggle or its own explicit close affordance (design-system
open/close symmetry); it claims **no Escape rung and no viewport
gesture** — it holds no focus or input, so the UIP-D14 ladder never
reaches it (finding 8). The toggle is per-user app state.

The HUD is deliberately **view-local** — the justified X3 exception,
with parity through the same source of truth: `view.diagnostics.get`
returns the full snapshot (interval and cost distributions, streaming,
governor, hardware tier) as JSON, and
`view.diagnostics.sample { duration }` accumulates into a **private
window** — never resetting or writing to the HUD's own — and returns the
aggregate, reporting `frames: 0` cleanly when nothing was presented.
This is **the measurement hook of this domain**: benchmarks and gates
migrate their _measurement_ onto it — input driving and overlay-state
sampling stay in the benchmark harness (finding 2); "interval p95 ≤ 2×
target" becomes one automation call around a harness-scripted
interaction instead of scraping timings through debugging ports.
Console: `view.diagnostics` toggles, `view.diagnostics.get` prints.
Observer cost is gated: HUD-on vs HUD-off presented-interval delta
≤ 0.2 ms at p95 (tunable, X6) — a diagnostics surface that perturbs what
it measures is a correctness defect (X1). A2 absence: no reference
documents a diagnostics overlay — Perspective's dossier carries the
sourced absence line item (`trimble-perspective.md` §2.2, help-portal
view topics [S1–S4]); realworks.md §2.10, rib-civil.md §2, and revit.md
were checked and document none. The function derives from contract D1's
requirement that every continuous interaction have a runnable gate.

## 3. Contract answers by group

### 3.1 Camera: modes, projection, frame, presets, compass

**A1/A2.** Modes 3D/2.5D/2D exist and are wired (`App.tsx:432–436`);
Perspective's Map View validates 2D as a _locked_ cheap-navigation mode,
not merely a camera position (`trimble-perspective.md` §2.1 [S2], §5).
Presets Top/Front/Right adopt Perspective's Map toolbar presets [S2] —
a closed list there; **Iso** is a stated addition (the conventional CAD
home view, X4 deviation clause; no dossier documents one — checked all
four) — VD-D9. Projection perspective/parallel becomes an explicit
toggle ([S3] documents both); in 2D/2.5D the projection is
mode-determined, so the toggle is disabled there with an explaining
tooltip (finding 12). Frame All exists
(`BuilderKernelViewport.tsx:278`); **Frame Selection** is its missing X5
pair (VD-D9). The compass overlay adopts Perspective's orbit widget with
axis handles (§2.1 — evidence flagged thin there, treated as
existence-level): an axis triad whose clicks dispatch the same canonical
preset commands, never a second camera path. **A3.** One command family
behind presets, compass, and mode buttons; view-mode chips are the
sibling overlay pattern; quick-surface entries (frame, view presets) are
contributed through the UIP-D6 registry and conform to UIP-D13's
void-relevant scope. **B1.** Ribbon + console + automation for all;
Frame Selection also in the entity context menu ("Frame entity");
shortcuts are registry-level recommendations (console aliases
`view.top`/`view.orbit` stay). **B2.** Inline momentary actions —
nothing to close; 3D/2.5D/2D form a radio group. **B3.** Inline.
**C1.** Presets are named poses; their typed twin is `view.state.set`
with an explicit camera — recorded as the answer. **C2.** Frame
Selection uses the current selection; empty selection disables with a
tooltip. **C3.** Not applicable — no expensive live state. **C4.**
Camera is never journaled (VB-D2 class); mode and projection persist as
project view state (VD-D5). **D1.** Bounded: transitions animate
≤ 200 ms without dropping the interactive budget — gated on
presented-frame intervals via `view.diagnostics.sample` around a
scripted preset cycle (§7). **D2.** Transitions ride the existing
interaction path (`setInteracting`). **E1.** §4-1, §4-5. **E2.**
Consumers of camera state: navigation controller, clip overlays,
coordinate display, automation, screenshots; a preset applied mid-drag
cancels the drag and reverts its preview (VB class rule). No gestures
claimed (inline commands). **E3.** §7.

### 3.2 Section planes (clip family) — workflow §2.1

**A1/A2** §2.1. **A3** the viewing box is the defining sibling: panel
patterns, chip, Escape ladder (UIP-D14), activation model, shared
`VectorEditor` improvements (VB §1.2); segmentation applies share P4
scoping (PC-D16). **B1** ribbon Sections toggle; context menu on section
entities (activate / rename / remove); quick surface **"Section here"**
— a UIP-D13 place-here entry contributed via the UIP-D6 registry —
places a **Horizontal** section at the picked elevation (the family is
switchable in the panel afterwards); over void the entry is absent (a
plane needs a picked coordinate — stated deviation from VB-D10's
view-centered box seeding, which seeds a volume); console aliases
`view.clip.*`; automation `section.place / update / flip / step /
activate / deactivate / rename / remove / list` plus `clip.clear`;
`view.state.get` reports active clips as entity references (VD-D13).
**B2** panel toggle + close affordance; Escape ladder UIP-D14; closing
keeps cuts alive (chip). **B3** right function panel — dragging in the
viewport while typing coordinates, the box's justification. **C1** drag
↔ coordinate field, flip ↔ kept side, step ↔ typed increment,
live-synchronized; units/precision from project settings. **C2**
operates on its own entities; selection-independent (VB C2 class).
**C3** no bake-lock (VD-D2). **C4** canonical entities; all listed
commands journaled; drag previews and uncommitted text view-local
(VB-D2 class). **D1** continuous: plane drag and orbit with active
sections — gate: a section variant of the interval-based VB-D7 benchmark
(presented-interval p95 ≤ 2× target frame time, same tunable), measured
through `view.diagnostics.sample`; bounded: placement, flip, activation,
`clip.clear` (box re-activation after clear inherits the §2.1 rebake
extreme: long-running with progress). **D2** per VB D2; cut correctness
at commit and P4 scoping never degrade. **E1** §4-2; sections inherit
`viewing-box-visual-criteria.md` criteria 1–3 (legibility, active-state
highlight, grip stability under drag — asserted from benchmark state
samples), 5 (chip), and 7 (no one-off chrome); criterion 6 does not
apply — sections have no lock (finding 11). **E2** consumers match the
VB E2 table's unlocked column: all render passes get the composed plane
set; picking/snapping/selection/measurement/destructive applies scope
per **P4** (apply mechanics per PC-D16); exporters ignore sections —
box-scoped extract stays the only export scope (VB-D11); the box
composes by intersection; planes over a locked box apply on top of the
bake. Class extremes (E2 rule): largest member — locked box with stale
bake (rebake path, §2.1); least typical — an automation value-clip,
which materializes as a canonical section (VD-D13). Automation update
mid-drag cancels the drag. Crash: entities and activation replay from
the journal. **Gesture map while placement is armed** (contract E2
gesture rule, reconciled against the ui-platform gesture table):

| Gesture      | Claimed?        | Behavior                                                        |
| ------------ | --------------- | --------------------------------------------------------------- |
| LMB click    | yes, one-shot   | places the section, disarms capture                             |
| LMB drag     | no              | navigation (orbit/pan per mode)                                 |
| RMB          | no              | platform-owned: drag pans, click opens context surface (UIP-D5) |
| Wheel        | no              | zoom (navigation)                                               |
| Escape       | armed-tool rung | cancels placement only (UIP-D14)                                |
| Tab / typing | no              | typing goes to the focused panel field                          |

**E3** §7.

### 3.3 View bookmarks — workflow §2.2

**A1/A2** §2.2 (RealWorks view stations, realworks.md §2.6 [6]; Revit
view templates, revit.md §2.6 [S22, S23]; differences stated there).
**A3** Saved boxes list (VB §1.4), entity-tree grouping,
`view.screenshot` chaining. **B1** ribbon toggle; context menu on
bookmark entities; console and automation `bookmark.*`; no quick-surface
entry (bookmarks are not spatial picks — recorded); registry may assign
restore shortcuts. **B2** panel toggle + close affordance; Escape per
UIP-D14 (field rung, then panel). **B3** right panel — list + capture;
nothing outgrows it. **C1** rename fields only — a bookmark's "numbers"
are the camera state, whose typed twin is `view.state.set` (recorded).
**C2** selection-independent; selection deliberately excluded from
capture (VD-D3). **C3** not applicable — no live-preview cost. **C4**
canonical entities (P1); capture/recapture/rename/remove journaled;
restore per VD-D4 (canonical effects one journal step; camera and
presentation view-local). **D1** capture instant; restore bounded
(≤ 200 ms animation + activation < 1 s) with the long-running extreme
member named in §2.2 (stale-bake re-activation → VB §1.3 progress +
cancel). **D2** restore animation may cut on weak tiers; the final state
never degrades. **E1** §4-3. **E2** a restore touches: camera
controller, presentation state (incl. VD-D8 override), clip activation
(journal), canonical entity visibility (journal), chip, automation
state. It never touches: per-entity canonical styles, view-local
automation hides (must not be promoted to canonical edits — VD-D3;
today's `view.state` merges both hide kinds, `App.tsx:153–176`, fixed by
VD-D13's split). Missing referents degrade per §2.2; restore during a
drag cancels the drag; concurrent restores serialize through the
journal. Class extremes: largest — restore with stale locked-box bake
(long-running path); least typical — restore of a bookmark whose every
referent was deleted (camera + presentation apply, console lists all
referents, nothing journals). **E3** §7.

### 3.4 Presentation, display layers, point size — workflow §2.3

**A1/A2** §2.3 (revit.md §2.5/§2.6 layer architecture; [S2]/[S8]
catalogs; realworks.md §2.10 theme). **A3** Pointcloud display
properties (PC-D11 — the canonical layer under VD-D8), theme system,
screenshot pipeline, quality governor; PhotoLab's twin assert
(`apps/photolab/renderer/src/App.tsx:4076–4085`) — class disposition in
VD-D13 per X7. **B1** ribbon dropdowns + console
(`view.background <preset>`, `view.color-mode <mode|follow>`,
`view.point-size <factor>`) + automation `view.presentation.get/set`
(and the `view.state` superset); grid/axes as Overlays toggles; render
style automation-only (VD-D6); `showSelectionOutline` automation-only,
default true (VD-D13); no context-menu entries — global configuration
does not belong in entity menus (design-system rule). **B2** dropdowns
close on selection, Escape, or outside click; selection applies
instantly, so closing is never a cancel (recorded); the point-size
popover keeps its close affordance. **C1** elevation min/max typed;
point-size multiplier slider ↔ typed factor (today slider-only with a
readout, `App.tsx:908–927`) — RIB F5-Box norm. **C2** global view state;
selection-independent (per-entity edits are the Pointcloud panel's,
PC-D12). **C3** not applicable — preset switches are bounded; the
freeze concept lives in the clip family. **C4** project-persisted view
state, not journaled (VD-D5); the canonical layer below is journaled and
owned by PC-D11; automation parity via `view.state`. **D1** override or
background switch bounded < 1 s on the largest supported cloud —
`real-data` gate (§7). **D2** color correctness never degrades; ramp
resolution may quantize on weak tiers. **E1** §4-4. **E2** consumers:
all render passes (override resolution: view override, else entity
style, else source — render fallbacks per PC-D12 note); screenshot
`background: 'view'` resolves the active preset; theme changes
re-resolve the `theme` background live; exporters unaffected —
presentation never leaks into exports (recorded); bookmarks capture the
override, never the canonical layer (VD-D3); automation. The deleted
asserts' callers switch to the typed model; `view.state.set` with any
valid v2 presentation must succeed (regression-gated, §7). Class
extremes: largest — override active over a mixed scene (clouds recolor;
mesh/CAD/raster unaffected by the _cloud_ override — recorded); least
typical — an entity whose style lacks the override's data (render-time
fallback with panel note, PC-D12 class). **E3** §7.

### 3.5 Navigation settings

**A1/A2.** The defaults already behave like the reference: orbit pivots
at the picked cursor point with screen-center fallback
(`KernelNavigationController.ts:381–410`), zoom anchors at the cursor
(:441–456) — the dossier's "orbit around the tapped position" pattern
(§2.1 [S3], §5). User-configurable (VD-D7): **zoom direction invert**,
**orbit/pan sensitivity** (slider with typed value; today hardcoded
0.005), **double-click Zoom Extents** on/off (RealWorks documents this
as configurable, `realworks.md` §2.10). Pivot behavior stays a fixed
default; RealWorks' pivot-around-camera on right-click (§2.10) is not
adopted — RMB is platform-owned (drag pans, click opens the context
surface, UIP-D5); §3.8 records the remaining RealWorks §2.10
dispositions. **A3** shared input contract across
Builder/PhotoLab/WeltView (design-system input consistency) — changed
defaults must propagate or be justified per product. **B1** ribbon
Navigation dropdown; console `view.navigation`; automation
`view.navigation.get/set` (scripting agents must read active
sensitivities — X3). **B2** dropdown semantics as §3.4. **C1**
sensitivity slider ↔ typed value. **C2/C3** not applicable (global
user-scoped settings). **C4** user-scoped app settings — not project
state, not journaled; navigation feel follows the person, not the file
(recorded; automation-visible regardless). **D1** application instant;
the _result_ is gated by the interval-based orbit gates. **D2** not
applicable. **E1** §4-5 (chrome only). **E2** the navigation controller
reads settings at interaction start; mid-drag changes apply from the
next gesture — no live re-tuning of an in-flight drag. No gestures
claimed (settings surface only). **E3** §7.

### 3.6 Station / panorama view — catalogued, deferred

Catalog row `view.station`: a station-centric view on a Panorama entity
— constrained 2-DOF rotation around the station origin, image-backed
rendering with the linked station cloud (`PanoramaGeometry` exists:
equirectangular raster + optional `stationPointCloud` link,
`packages/@himmelcad/data/src/generated/PanoramaGeometry.ts`), exit via
a corner thumbnail — the pattern Perspective documents as Station View
(§2.1 [S4], W2: image-backed density, no pivot hunting) and the
dossier's §5 recommendation as the reference answer to first-person
inspection. **Deferred with reason (VD-D11):** workflow depth requires
the station data model — origins, capture linkage, per-station
visibility (§2.7 [S2, S11]) — which is Pointcloud-domain scope not yet
specified; specifying the view half first would fix an interface the
data half has not earned. The row, entity evidence, and grounding are
recorded so the Pointcloud spec inherits a ready contract entry.
Free-roaming modes: RealWorks documents Examiner/Walkthrough navigation
and Shift+click "Fly to" (`realworks.md` §2.10) — not adopted now;
Perspective, the primary viewing reference, constrains first-person
viewing to Station View (§2.1 [S1–S4] catalog), and we follow it;
walkthrough/fly-to queue with the station work (VD-D12, revising the
earlier false absence claim — finding 10).

### 3.7 Diagnostics — workflow §2.4

Beyond §2.4: **A3** console degraded-fallback logging is the sibling;
benchmarks are the primary consumers. **B2** ribbon button toggles; the
island carries its own close affordance; **no Escape rung** — the
overlay holds no focus or input, so the UIP-D14 ladder never reaches it
(finding 8). **B3** viewport overlay island — a panel would leave the
viewport it measures. **C1** not applicable — read-only; every number's
typed twin is `view.diagnostics.get` (recorded). **C2**
selection-independent. **C3** not applicable — the HUD _is_ the
measurement of others' cost. **C4** toggle is user-scoped app state;
snapshot data is derived, never persisted (recorded). **D2** the HUD
never degrades to wrong numbers; weak tiers may drop refresh rate
(tunable), never accuracy; idle shows the §2.4 idle state, never fake
zeros. **E2** telemetry consumers: quality governor (existing), HUD,
`view.diagnostics.*`, benchmarks/CI gates; the HUD is a pure passive
reader and the observer-cost gate proves it stays one. `sample` windows
are private per call — no hidden writes to the HUD's window (finding
13); a `sample` during a running `sample` rejects with a clear error
(SYSTEM-001: rejected explicitly). Class extremes: largest — sampling
during a heavy streaming burst (distributions and counters must stay
consistent snapshots); least typical — sampling an idle viewport
(`frames: 0`, no division-by-zero percentiles). No gestures claimed.
**E3** §7.

### 3.8 A2 dispositions — remaining RealWorks viewing rows (finding 10)

Per the dossier-wide A2 rule, the RealWorks §2.10 catalog rows not yet
dispositioned above:

| RealWorks §2.10 row                             | Disposition                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Examiner/Walkthrough, Shift+click Fly-to        | not adopted now; queued with station work (§3.6, VD-D12)                           |
| Pivot rotation around camera (RMB, 12.4)        | rejected — RMB is platform-owned (UIP-D5); §3.5                                    |
| Cloud transparency button                       | per-entity opacity — Pointcloud domain (PC-D11 layer; VD-D8 boundary)              |
| Display shortcuts Ctrl+W/E, Alt+E, Ctrl+R/Alt+R | shortcut-map candidates recorded to `REGISTRY.md` (VB-D9 pattern); none bound here |
| Dark/light theme switch                         | adopted as the Theme background preset + app theme (VD-D6)                         |
| Configurable Zoom Extents double-click          | adopted (VD-D7)                                                                    |
| Station 3D markers scaled by view distance      | station-view scope, deferred with it (VD-D11)                                      |

## 4. Visual criteria (E1, failable)

In-repo written criteria per contract E1; sections are additionally
bound by `viewing-box-visual-criteria.md` criteria 1–3, 5, and 7 as a
class (criterion 6 — locked state — does not apply; sections have no
lock). Theme tokens only; both themes; no third-party screenshots
(license discipline).

1. **Mode/preset controls.** The active navigation mode is identifiable
   from the viewport chip row alone; preset buttons are momentary and
   never stay "lit"; the projection toggle in 2D/2.5D renders disabled
   with a tooltip. Fails if 2D and 2.5D are indistinguishable in a
   screenshot.
2. **Section overlay.** Plane rectangle and normal arrow legible over a
   dense true-color cloud in both themes (dual-stroke/halo per VB
   criterion 1); kept vs discarded side distinguishable from the
   viewport alone after Flip. Fails if two flip states differ only in
   point content.
3. **Bookmarks list.** Each entry shows name and restore affordance; a
   bookmark with missing referents shows a warning glyph with a naming
   tooltip. Fails on silent normality for broken referents.
4. **Presentation dropdowns.** Each background/color-mode entry carries
   a preview swatch; the active entry is marked — **Follow entity
   display** is visibly the default state, distinct from an active
   override; elevation shows its min/max fields inline when active.
   Fails if the active state cannot be read from the open dropdown in a
   screenshot.
5. **Diagnostics overlay.** Mono typeface tokens; all values legible
   over light and dark viewport content at 100% zoom; p95 above the
   frame budget renders in the warning status color (status colors for
   status only); the idle state shows "Idle — no frames presented", not
   zeros. Fails on unreadable overlap or one-off chrome; a grep for
   literal colors in the HUD surface returns none.

## 5. Decision records

**VD-D1 — One clip family; `clip.clear` clears everything,
lock-preserving; one chip** (revised per review finding 4).
**Decision:** sections are canonical, journaled, named entities in the
same clip class as viewing boxes, sharing activation semantics, the
UIP-D14 Escape ladder, and P4 visible-set scoping. `clip.clear`
deactivates every active clip — sections _and_ box — as one journaled,
undoable step; **deactivation touches activation only**: lock flags and
the revision-keyed bake cache (VB-D3) survive, and re-activating a
locked box with a stale key runs the VB §1.3 auto-rebake (long-running,
progress, cancel). Console `view.clip.*` verbs become aliases of the
canonical commands. One shared clip chip: a single active clip shows its
name (+ lock glyph, VB-D6); several show "n clips" with names in the
tooltip; click opens the most recently activated clip's panel.
**Derivation:** X5 (a "clear" that clears half the clips ships half a
pair); P1/VB-D1/VB-D6 class; P4; design-system discoverability;
split-channel evidence (`App.tsx:622–648` vs
`BuilderKernelViewport.tsx:531–637`).
**Rejected:** per-channel clear verbs (guarantees the "cleared but still
clipped" support case); clear-as-delete or clear-as-unlock (destroys
lock/bake state the user paid for — finding 4); one chip per clip
(unbounded overlay row).
**Tunable:** chip truncation length (X6); otherwise no.

**VD-D2 — One active section per family, intersected; no bake-lock.**
**Decision:** at most one active section per family; active sections and
the active box compose by intersection. Sections offer no lock; over a
locked box they apply as live planes on top of the bake. Arbitrary
orientation and slab modes queued (VD-D12).
**Derivation:** the kernel already composes a volume list
(`BuilderKernelViewport.tsx:468`); three families cover the storey and
facade cuts the references document ([S7]; realworks.md §2.5); no lock
per VB-D12's rationale — a half-space keeps most of the cloud, so a bake
spends memory for no payoff (X2 spends _for_ speed).
**Rejected:** unlimited planes (complexity, no evidenced workflow);
replace-on-place (today's behavior — loses composition); plane lock with
VB-D12 fallback (a lock that is almost always the fallback is dead
weight).
**Tunable:** no.

**VD-D3 — Bookmark capture boundary: the view layer only, referents by
reference** (revised per review findings 3, 6, 9).
**Decision:** a bookmark captures camera + projection + navigation mode

- presentation (including the VD-D8 color-mode override) + active-clip
  entity references + a snapshot of **canonical** entity visibility by
  reference. Excluded, each deliberately: selection (task state);
  per-entity canonical display styles (entity state — restore must not
  revert later style edits); view-local automation hides (session state —
  restore must never promote them into canonical edits; today's
  `view.state` merges both hide kinds, `App.tsx:153–176`, split by
  VD-D13); the view point-size multiplier (workstation comfort, VD-D8).
  Deleted referents — clips or hidden entities — degrade identically:
  restore the rest, console names each missing entity.
  **Derivation:** P1 (bookmarks verbatim); X3 (capture = the restorable
  view layer of VD-D13's v2 state); VD-D8 layer boundary; X1 (promoting
  session hides to canonical edits corrupts project state); revit.md §2.6
  (view templates bundle view-level properties, not element styles).
  **Rejected:** camera-only bookmarks (restores the angle, not the view
  the user named); capturing per-entity styles (a bookmark would silently
  revert canonical edits); capturing merged hidden sets (the finding-9
  promotion bug).
  **Tunable:** no.

**VD-D4 — Restore journals canonical effects; camera stays view-local;
extreme member long-running** (revised per review finding 4).
**Decision:** `bookmark.restore` applies camera/presentation view-
locally and journals clip-activation and canonical-visibility changes as
one step. Classification: bounded; its extreme member — re-activating a
locked box with a stale bake key — is long-running and runs the VB §1.3
progress/cancel path.
**Derivation:** VB-D2 class (camera and presentation never journaled;
clip activation is); one step per user-perceived action (C4); contract
E2 extreme-member rule; VB-D3 cache semantics.
**Rejected:** journaling nothing (changes journaled state with no undo
step); journaling the camera (undo-walks through poses no other camera
motion records); classifying restore "< 1 s" flat (hides the rebake —
finding 4).
**Tunable:** no.

**VD-D5 — Presentation and mode persist with the project, un-journaled.**
**Decision:** background, color-mode override, render style, overlays,
point-size multiplier, navigation mode, and projection persist as
project view state, restored on open, exposed via `view.state`, excluded
from journal and undo. (The canonical display layer below is journaled —
that is PC-D11's, under VD-D8.)
**Derivation:** X4 — no dossier documents display-settings undo (checked
all four); X3 satisfied by full automation parity; owner decision D1
(project state travels in `.hcadx`).
**Rejected:** journaled presentation (background flips interleaving with
geometry undos); app-global presentation (projects with different
deliverable styles would fight).
**Tunable:** no.

**VD-D6 — Typed presentation model replaces the asserts.**
**Decision:** delete `assertSupportedBuilderPresentation`
(`App.tsx:1312`); presentation becomes typed v2 state (schema in
VD-D13): background presets theme/black/white (transparent
screenshot-only), the VD-D8 color-mode override (follow / RGB /
intensity-gray / intensity-color / elevation(min,max) / uniform),
grid+axes toggles, point-size multiplier; render style is a polymorphic typed
union: generic source/monochrome/x-ray plus Mesh/Terrain MT-D6
realistic/abstract/wireframe/shaded-edges values, surfaced only by compatible
entity owners. BIM may add its own typed values without changing this ownership.
**Derivation:** X4 (catalog from [S2]/[S8]; revit.md §2.6 override
precedence); the protocol types presentation (`view.ts:76–82`) — the
assert rejects its own protocol; per-station/per-scan deferral follows
the dossier's registration binding (§5).
**Rejected:** surfacing render style now (its primary subjects have no
domain spec; a cloud-only x-ray button misrepresents scope); shrinking
the protocol to match the assert (inverts X3).
**Tunable:** color-ramp definitions (X6).

**VD-D7 — Navigation configurables; pivot fixed.**
**Decision:** exactly three user settings — zoom invert, orbit/pan
sensitivity, double-click Zoom Extents — user-scoped,
automation-readable/writable; pick-point pivot and zoom-at-cursor remain
non-configurable defaults.
**Derivation:** X4 — the pivot default is the dossier's explicit hint
(§5 [S3]); double-click-extents configurability has RealWorks precedent
(§2.10); sensitivity/invert are personal calibration (X6).
**Rejected:** pivot-mode option (multiplies navigation states without
evidenced need; RealWorks' RMB pivot variant conflicts with UIP-D5);
project-scoped settings (feel follows the user).
**Tunable:** default sensitivity value and range (X6).

**VD-D8 — Two-layer display model: canonical entity styles below,
view-level overrides above** (rewritten per review finding 1; the shared
record — the Pointcloud spec cites this id, and this record revises
PC-D11's View-tab accelerator clause).
**Decision:** display resolves in two layers. **Below:** per-entity
canonical display styles — color source, mode parameters, palette ref,
per-entity point size — journaled, automation-visible, owned by Pointcloud
PC-D11, Mesh/Terrain MT-D6, Raster RA-D5, and BIM BS-D12 for their respective
entities; Raster images are another canonical lower-layer owner and the
view-level render-style override never recolors them. **Above:** un-journaled,
project-persisted view presentation (VD-D5/VD-D6) with a **Color mode
override** defaulting to **Follow entity display**; when set, it
overrides every point-cloud entity's color source at render time
without touching canonical state. The View tab's color-mode control _is_
this override — revising PC-D11's clause that made it an accelerator
issuing scene-wide canonical edits (scene-wide canonical recolor remains
available through the Pointcloud multi-select path, PC-D12/PC-D13).
**Point size** adopts PC-D11 verbatim: per-entity canonical size (Auto
default) × view-local unitless multiplier, default 1.0. The override is
captured by bookmarks; the multiplier is **not** (explicitly decided:
the multiplier compensates workstation display density — comfort, like
theme — and capturing it would fight per-screen tuning; the override
expresses view intent, which is what a bookmark names). Per-entity
opacity/exaggeration/visibility stay canonical below; today's
`view.opacity`/`view.exaggeration` console commands (`App.tsx:650–665`)
migrate to Pointcloud canonical commands.
**Derivation:** X4 — revit.md §2.5/§2.6 [S16, S20–S23] is the reference
architecture for exactly this split (object styles below, per-view
visibility/graphics overrides above); PC-D11 (canonical layer + X3/P1
derivation + multiplier exception); X7 (one shared record closes the
class for both specs).
**Rejected:** all-global view display (the pre-review model here —
collides with PC-D11 and breaks classification workflows that depend on
per-entity styles); all-canonical with a scene-wide accelerator and no
override (PC-D11's original clause — bookmarks then cannot capture a
view look without mutating entities, and a "just show me elevation for a
minute" glance becomes a journaled edit); capturing the multiplier in
bookmarks (screen comfort is not view intent).
**Tunable:** multiplier clamp range (X6, shared with PC-D11).

**VD-D9 — Presets as bounded camera commands; Frame Selection added.**
**Decision:** Top/Front/Right/Iso applied as animated bounded camera
commands within the current mode (in 2D only Top applies — others
disabled with explanation, as is the projection toggle); Iso is a stated
deviation-addition; Frame Selection joins Frame All.
**Derivation:** X4 ([S2] Top/Front/Right, Zoom Extents); X5 (frame
all/selection pair); design-system disabled-with-explanation rule.
**Rejected:** presets as mode switches (conflates pose with navigation
model); omitting Iso (the common CAD home pose unreachable in one click
for no saving).
**Tunable:** animation duration ≤ 200 ms (X6).

**VD-D10 — Diagnostics: interval metric added; view-local overlay;
measurement-only migration; observer cost gated** (revised per review
findings 2, 8, 13).
**Decision:** the telemetry window gains a **presented-frame-interval
distribution** (p50/p95/p99, `FrameTimeDistribution` class,
`hardware_policy.rs:436`), sampled at presentation cadence
(`waitForNextPresentedFrame` evidence, `App.tsx:140`); all D1 gates in
this domain assert on interval p95. The HUD overlay is view-local;
parity through `view.diagnostics.get/sample`; `sample` accumulates a
private window and returns `frames: 0` cleanly when idle; the HUD shows
an explicit idle state. Gates and benchmarks migrate **measurement
only** onto `sample` — input driving and overlay-state sampling stay in
the benchmark harness. The HUD closes via toggle or its close
affordance, claiming no Escape rung and no gesture. Observer-cost gate:
HUD-on vs HUD-off interval delta ≤ 0.2 ms p95. `view.performance` is
retired; the point-size popover is reachable only via `view.point-size`.
**Derivation:** X3 exception clause (diagnostic readout) with parity
through data; contract D1 (agent-runnable gates — today's benchmark
scrapes a hand-started dev app via CDP, viewing-box implementation
review E3/D1 major); finding 2 — render-cost metrics cannot see
presentation-side jank, so gating on them would silently change the
metric VB-D7 guards (VB-D7's interval revision is owned by
`viewing-box.md`, doctrine rule 2); X1 (a HUD that perturbs or fakes
measurement lies); UIP-D14 (Escape claimants are registered — the HUD
is not one).
**Rejected:** gating on effective render time (blind to React drag-sync
jank — the finding-2 blocker); migrating input driving into the sidecar
sample (it cannot drive browser input); canonical journaled HUD state
(undo for a readout is noise); Escape-closes-HUD (an unregistered
ladder claimant).
**Tunable:** refresh rate, observer-cost threshold, interval-gate
multiplier (X6/P3).

**VD-D11 — Station view deferred to the Pointcloud station model.**
**Decision:** catalog row recorded (§3.6); workflow specification
deferred until the Pointcloud domain specifies stations/registration;
walkthrough/fly-to queued with it (VD-D12), not silently absent.
**Derivation:** owner decision D4's philosophy (no speculative
specification without the driving data model); [S4] evidence and
`PanoramaGeometry` recorded so nothing is lost; realworks.md §2.10
documents Walkthrough/Fly-to (the earlier absence claim was false —
finding 10 — and is withdrawn), while the primary viewing reference
constrains first-person viewing to stations ([S1–S4]).
**Rejected:** specifying the view half now (fixes an interface the data
model has not earned); dropping the row (loses the A2 catalog
derivation); adopting walkthrough now (no station model to anchor it,
and the primary reference deliberately omits it).
**Tunable:** no.

**VD-D12 — Queued follow-ons (one backlog with VB-D11).**
**Decision:** queued: arbitrary-orientation cutting plane and
slab/thickness slicing with storey stepping (realworks.md §2.5 [5][6];
trimble-perspective.md §2.4 [S7]); per-scan/per-station color modes
(with registration, trimble-perspective.md §5); walkthrough/fly-to modes
(realworks.md §2.10, with the station model — VD-D11); bookmark thumbnails
(realworks.md §2.6 [6] screen
captures; `view.screenshot` exists — review idea 15); a "Copy
diagnostics" button on the HUD (review idea 16); normal-based point
filtering ([S2] — Pointcloud candidate); bookmark export/share;
Magnify-style local densification ([S11] — Pointcloud candidate).
Plan-editor PE-D6 owns view templates, rule filters, include/exclude fields,
and assignment/locking; they are therefore removed from this backlog. View
retains canonical bookmarks/ViewState ownership only.
**Derivation:** completion discipline (`docs/CURRENT-DIRECTION.md`);
each entry carries its dossier evidence for later derivation.
**Rejected:** bundling now (delays the discoverability fixes this spec
exists for).
**Tunable:** no.

**VD-D13 — ViewState v2: entity-referenced clips, split hides, extended
presentation; sibling adoption** (new per review findings 6, 7, 9, 14).
**Decision:** the view protocol bumps to `version: 2`
(`himmelcad.view-state`): (a) value-typed `scopedClips`
(`view.ts:51–74`) are replaced by **`clipRefs`** — entity references
with activation and readable lock state; an automation `state.set` that
supplies a value-typed clip **materializes it as a canonical section or
viewing-box entity** through the same journaled commands, eliminating
the third clip channel (`setAutomationClipVolumes`, `App.tsx:163–165`);
(b) `hiddenEntityIds` splits into **`hiddenEntityIds`** (canonical
visibility) and **`sessionHiddenEntityIds`** (view-local, automation-
settable, never journaled) — fixing today's merge (`App.tsx:153–176`)
and making the VD-D3 capture boundary expressible; (c) presentation
gains `colorModeOverride` (follow | mode + params) and
`pointSizeMultiplier`; `background` drops `transparent` (screenshot
requests keep it, `view.ts:95–106`); `showSelectionOutline` stays,
automation-only, default true — automation can disable it for clean
captures; no ribbon surface (recorded). SDK and host changes are listed
in §6. **Sibling adoption (X7):** the shared parser and SDK speak v2;
PhotoLab's duplicate assert
(`apps/photolab/renderer/src/App.tsx:4076–4085`) is disposed the same
way — typed model, PhotoLab's product subset — with implementation
queued behind PhotoLab's release priority
(`docs/CURRENT-DIRECTION.md`); until then PhotoLab rejects unsupported
v2 fields with the same typed error surface, not a thrown assert.
**Derivation:** finding 6 (the "protocol already carries it" premise was
false three ways); X3 (one canonical channel for clips); X1 (session
hides must not masquerade as canonical); X7 (the class includes
PhotoLab); doctrine rule 2 (fix the schema, not the call sites).
**Rejected:** keeping value clips alongside entities (a permanent
invisible clip channel — the §2.1 disease reborn); merging hides
(finding 9's promotion bug); dropping `showSelectionOutline` (breaks
clean-capture automation for no gain).
**Tunable:** no.

## 6. Current implementation delta

**Exists and stays:** view modes wired end-to-end (`App.tsx:432–436`,
console :608–621); Frame All (`BuilderKernelViewport.tsx:278`);
pick-point orbit + zoom-at-cursor defaults
(`KernelNavigationController.ts:381–456`); kernel clip-volume
composition; presented-frame await (`App.tsx:140,166`); the telemetry
substrate (`hardware_policy.rs:404–650`, `KernelStreamingDriver.ts`,
`KernelViewerSession.ts:785`); the canonical per-entity display plan
(Pointcloud spec §5, unchanged).

**Changes:** console `view.clip.*` re-routed onto canonical `section.*`
commands, `view.clip.clear` → lock-preserving family `clip.clear`
(VD-D1); the un-scoped `builder-user-section` volume and replace-on-set
behavior removed; the automation clip channel
(`setAutomationClipVolumes`, `App.tsx:163–165`) removed in favor of
VD-D13 materialization; `assertSupportedBuilderPresentation`
(`App.tsx:1312`) deleted for the typed model (VD-D6);
`view.background`/`view.color-mode` dead buttons become working
dropdowns (color mode = VD-D8 override, default Follow entity display);
`view.point-size` relabeled/re-ranged to the ×1.0 multiplier (PC-D11
adopted; `App.tsx:73,908–927` gains a typed field); `view.performance`
retired (VD-D10); `view.top`/`view.orbit` aliases re-pointed at true
presets/modes; navigation sensitivities lifted from constants into user
settings (VD-D7); viewing-box benchmarks migrate measurement onto
`view.diagnostics.sample` per the interval-revised VB-D7 (harness keeps
driving input).

**New — protocol/SDK (VD-D13):** ViewState v2 types and parser
(`view.ts:45–93` superseded; v1 `get` readable during transition, v1
`set` rejected with a versioned error); `clipRefs` + materialization;
hidden split; `colorModeOverride`, `pointSizeMultiplier`; Python SDK
type regeneration; PhotoLab host switches parsers with its subset
(assert at `apps/photolab/renderer/src/App.tsx:4076–4085` replaced by
typed rejection).

**New — features:** section-plane canonical entities +
`section.*`/`clip.clear` command set, panel, quick-surface entry, P4
scoping with PC-D16; bookmark entities + `bookmark.*` + panel +
entity-tree group; presentation dropdowns with elevation min/max;
grid/axes toggles; projection toggle (disabled in 2D/2.5D);
Top/Front/Right/Iso presets, Frame Selection, compass overlay;
navigation settings dropdown + `view.navigation.get/set`;
presented-frame-interval distribution in the telemetry window;
diagnostics HUD + `view.diagnostics.get/sample` + observer-cost gate;
clip-chip aggregation.

## 7. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** command-layer unit tests — section journal round-trip
  (place/update/flip/step/activate/rename/remove), one-per-family
  invariant, intersection composition incl. active box; `clip.clear`
  deactivates sections _and_ box in one undoable step **preserving lock
  flag and bake cache**, and re-activation with a stale key schedules
  the rebake (VD-D1); bookmark capture equals the VD-D3 boundary
  (canonical hides only — a session-hidden entity never enters a
  bookmark and restore never journals a visibility edit for it), restore
  re-activates referenced clips, missing-referent restore degrades with
  console entries; v2 round-trip — value-clip materialization creates a
  canonical section, hidden split, override + multiplier fields,
  interactive `transparent` rejected, v1 `set` rejected with versioned
  error (VD-D13); navigation settings persist user-scoped. Component
  tests — sections panel numeric parity (Enter/blur commit, Escape
  revert, close-mid-edit discards — VB-D5/UIP-D14 class), flip and
  ± step; bookmarks panel (capture, recapture, rename, remove+undo,
  warning glyph); dropdowns (Follow-entity default state, active mark,
  elevation min/max, instant apply); point-size multiplier typed field;
  HUD renders fixture snapshots incl. the idle state and warning color
  at over-budget p95.
- **push (risk-triggered by viewer/viewport paths):** browser
  interaction tests — plane drag ↔ field live sync, Escape ladder
  one-rung-per-press incl. armed-placement rung and **no HUD rung**
  (§3.2 gesture table honored: RMB pans/opens context per UIP-D5 while
  placement is armed), chip aggregation and reopen, preset animation
  lands exactly, mode radio state, projection toggle disabled in 2D; a
  pick through a plane-clipped region returns no clipped point, and a
  **fence apply with an active section excludes the clipped region**
  (P4/PC-D16 cross-test); concurrent `diagnostics.sample` rejected
  cleanly; `sample` leaves the HUD window untouched.
- **push (risk-triggered) / release (always), capability
  `browser-gpu`:** continuous gates on **presented-frame-interval p95 ≤
  2× target frame time** (VB-D7 interval revision, shared harness;
  measurement via `view.diagnostics.sample`, input driven by the
  harness) — section-drag + orbit-with-active-sections burst;
  preset-cycle transition burst; HUD observer-cost interval delta
  ≤ 0.2 ms p95 (VD-D10).
- **release, capabilities `browser-gpu` + `real-data`:** color-mode
  override switching on the largest supported cloud reload-free and
  < 1 s per switch (verifies the dossier's W6 inference); elevation
  ramp min/max correctness against known geometry; bookmark restore
  triggering a stale-bake re-activation shows progress and cancels
  cleanly (VD-D4 extreme member).
- **automation:** SDK parity — every `section.*`, `bookmark.*`,
  `clip.clear`, `view.presentation.*`, `view.navigation.*`,
  `view.diagnostics.*` command callable; end-to-end "restore the
  bearing detail view and screenshot it"; `view.state.get` reports
  clips as entity references with lock state, both hide sets, and the
  presentation incl. override; idle `sample` returns `frames: 0`.
- **manual/visual:** screenshots (both themes) against §4 criteria 1–5
  and the inherited `viewing-box-visual-criteria.md` criteria (1–3, 5, 7) at implementation review.

Explicitly unverified: subjective color-ramp aesthetics beyond §4-4;
absolute accuracy of HUD numbers against external profilers (the HUD is
the project's own measurement standard; cross-profiler calibration is
manual-only); animation feel beyond the transition gate; PhotoLab's
eventual presentation subset (deferred behind its release priority,
VD-D13 — listed unverified until that work runs).

## 8. Owner-decision items

None. Candidates tested against the escalation protocol and dissolved in
writing: "who owns display state, View or Pointcloud?" — closed by the
two-layer model, derivable from X4 + revit.md §2.5/§2.6 with X7 binding
both specs to one record (VD-D8); "may `clip.clear` deactivate the
viewing box?" — closed by X5 + the P1/VB-D1 class and lock-preserving,
non-destructive journaling (VD-D1); "may this spec change VB-D7's
metric?" — closed by doctrine rule 2: the revision lands in
`viewing-box.md` by its owner, this spec only supplies the interval
instrument (VD-D10); "is display state undoable?" — closed by X4 with X3
parity (VD-D5); "which color modes ship?" — closed by X4's catalog and
the dossier's registration binding (VD-D6); "do we build walk/fly?" —
closed by X4 posture of the primary reference plus queueing with the
station model (VD-D11/VD-D12); "how fast must the HUD be, and how fast
is 'smooth'?" — calibration, delegated by P3/X6 (VD-D10). No axiom
conflict, product-identity, money, or reserved-boundary question
remains.

## 9. Disposition — spec review 2026-09-02 (findings 1–16)

| #   | Finding                                                                | Disposition                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Color mode / point size double-owned vs pointcloud spec                | VD-D8 rewritten as the shared two-layer record (canonical below per PC-D11 unchanged; view override above, Follow-entity default, un-journaled, bookmark-captured; multiplier adopted, explicitly not captured); §2.3, §3.4, §1 rows |
| 2   | `sample` migration silently changes the gate metric                    | presented-frame-interval distribution added; all D1 gates run on interval p95; measurement-only migration, harness keeps driving input (VD-D10, §2.4, §7); VB-D7 now carries the reciprocal metric wording                           |
| 3   | Absence claims refuted (revit view templates; realworks view stations) | bookmarks re-grounded on realworks.md §2.6 + revit.md §2.6 with stated differences (§2.2, VD-D3); presentation layering grounded on revit.md §2.5/§2.6 (VD-D8)                                                                       |
| 4   | `clip.clear`/restore vs locked box; "<1 s" hides rebake                | lock-preserving deactivation, stale-key re-activation runs VB §1.3 rebake (VD-D1); restore reclassified with named long-running extreme member (VD-D4, §2.2, §7)                                                                     |
| 5   | VB-D13 picking-only phrasing; destructive applies                      | P4 cited throughout as the class rule; apply mechanics deferred to PC-D16 (cite, not re-disposition); §7 fence-with-section cross-test                                                                                               |
| 6   | ViewState v2 unspecified; "protocol already carries" false             | VD-D13 specifies v2 (clipRefs + materialization, hidden split, presentation fields, transparent dropped); §6 lists schema + SDK changes; VD-D3 premise corrected                                                                     |
| 7   | PhotoLab ships the identical assert                                    | class disposition in VD-D13 (X7): typed model + subset, queued behind PhotoLab release priority; cited at `apps/photolab/renderer/src/App.tsx:4076–4085`                                                                             |
| 8   | HUD Escape unregistered; placement gestures unmapped                   | HUD closes via toggle/close affordance, no Escape rung (VD-D10, §3.7); §3.2 gesture table reconciled with UIP-D5/UIP-D14                                                                                                             |
| 9   | Bookmark display-state boundary untested; hide merge                   | VD-D3 capture boundary record (view layer only, canonical-visibility snapshot, exclusions each decided); VD-D13 hidden split fixes `App.tsx:153–176`; §7 tests                                                                       |
| 10  | RealWorks §2.10 rows undispositioned; walk/fly claim false             | §3.8 disposition table; §3.6/VD-D11 rewritten (claim withdrawn, walkthrough queued VD-D12)                                                                                                                                           |
| 11  | E1 criteria mapping wrong for sections                                 | §4 header: inherit criteria 1–3, 5, 7; criterion 6 excluded (no lock)                                                                                                                                                                |
| 12  | Quick-surface row underspecified; projection in 2D                     | "Section here" = Horizontal at picked elevation, family switchable (§3.2 B1, UIP-D13-conformant); projection toggle disabled in 2D/2.5D with tooltip (§3.1, VD-D9, §4-1)                                                             |
| 13  | HUD idle reads as hang; `sample` side effects                          | idle state "Idle — no frames presented"; private sample windows, `frames: 0` (§2.4, §3.7, VD-D10, §7)                                                                                                                                |
| 14  | `showSelectionOutline` homeless in typed model                         | kept in v2, automation-only, default true, recorded (VD-D13, §3.4 B1)                                                                                                                                                                |
| 15  | Idea: bookmark thumbnails                                              | queued with evidence (realworks.md §2.6, `view.screenshot`) — VD-D12                                                                                                                                                                 |
| 16  | Idea: Copy diagnostics button                                          | queued — VD-D12                                                                                                                                                                                                                      |

## Cross-spec reconciliation 2026-09-02

| Item                 | Disposition                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ribbon               | Measure group inserted between Clip and Style under MI-D1.                                                                                                                                                         |
| Lower display layer  | VD-D8 cites Raster RA-D5 and Mesh MT-D6 alongside PC-D11/BIM; Raster is not affected by Mesh/BIM render-style overrides.                                                                                           |
| Render style         | VD-D6 admits Mesh realistic/abstract/wireframe/shaded-edges values while View keeps upper-layer persistence.                                                                                                       |
| Plan templates       | VD-D12 removes include/exclude/locking ownership and cites PE-D6; bookmarks/ViewState remain VD-D3/VD-D13.                                                                                                         |
| P10 rigid sections   | VD-D15 owns the cheap unambiguous live section mapping and unresolved state; it cites Civil's profile boundary and does not create a second MT-D25 entity-recipe act.                                              |
| Semantic cursor      | View cites UIP-D24/§9.7 and declares pick/snap/Fangkreis, direction/plane handles, Shared3DTarget, prohibited, and wait for section/clip tools.                                                                    |
| GAP §6 Civil inbound | VD-D1/VD-D3/VD-D13 are amended by VD-D15's explicit CIV-D7/CIV-D12 profile boundary; View owns rigid sections and Civil owns alignment profiles.                                                                   |
| Re-walk 2026-09-02   | P5: camera/section gestures journal once or stay view-local; persistence is off-frame. P6 preserves Escape/double-click/Undo meanings. Current D1/X3/B1/A2 and P7 are satisfied; no office convention is mandated. |

## Owner statements batch 2 — 2026-09-02

This section amends VD-D1/D3/D8/D13. Display/visibility and camera each retain a
bounded, coalesced local history exposed through UIP-D19; neither enters the
document journal and Ctrl+Z remains document-only. Global Labels and Support
geometry are non-destructive overlays above canonical per-entity choices and P9's
effective state. Persist/restore keeps the domains separate and corruption resets
only the affected local history with a console explanation.

**Create section** accepts one selected Draw line, captures its revision, shows an
arrow that can be reversed, and accepts optional depth by pick, constrained pick,
or typed C1 input. Before commit the plan shows the named section specification and
two direction arrows. Create journals one canonical section definition and opens a
View whose local X follows the line, local Y is project up/elevation, and depth clips
only when specified. The rigid transform is live under P10; an invalid/deleted line
shows **Unresolved section** rather than old geometry. Close hides the view but
retains the definition; Delete is explicit. This does not rename/replace VD-D1 axis
clip planes and does not own Civil profiles (CIV-D7/CIV-D12).

The rigid mapping updates on the next settled presented frame within View's
existing interactive frame budget; `G-VD-SECTION-LIVE` fails if it misses that
frame or shows old geometry as current. Work exceeding the gate enters visible
Stale state and uses explicit synchronization rather than blocking interaction.

Registry entry applied by the round-3 rebuild: `view.section-create` (ribbon/selected-line
context/console/automation; panel plus viewport preview;
`view.section.preview/create` and existing view lifecycle queries). `view.section`
remains the separate clip-plane family. Display/camera history actions join
`history.local` rather than new View acts.

**VD-D14 — View owns recoverable display and camera histories.** **Decision:** the
two local histories and non-destructive overlays behave as above and expose query/
action parity through UIP-D19. **Derivation:** P8, P9, S3/G2/G4, X3, UIP-D19,
FP-D21. **Rejected:** document-journaling camera/display; destructive global
labels; focus-sensitive Ctrl+Z. **Tunable:** history depth/coalescing.

**VD-D15 — A line-derived rigid section is a named live View entity.** **Decision:**
direction, optional depth, arrowed plan specification, exact local frame, and
live/unresolved lifecycle are as above. **Derivation:** S8/G8, C1, P10, X1, X5,
Draw DR-D17, Civil CIV-D7/CIV-D12. **Rejected:** treating the section as VD-D1's
clip plane; copying frozen projected geometry; owning Civil profiles. **Tunable:**
default arrow/depth presentation only.

Verification covers separate display/camera undo after document edits, overlay
round-trip without entity mutation, line reversal/local axes/depth, live source
move, deleted-source unresolved state, close/reopen/delete, both themes and
GAP-V6. Cursor declaration: pick crosshair, line snap marker/Fangkreis, direction
arrow handle, prohibited, and bounded-work wait from UIP-D22.

| Work-order item                                | Disposition                                                    |
| ---------------------------------------------- | -------------------------------------------------------------- |
| S3/G2/G4 display/camera histories and overlays | Applied by VD-D14.                                             |
| S8/G8 rigid line-picked section                | Applied by VD-D15; Civil profiles cited, not re-dispositioned. |
| S13/G11 cursor declaration                     | Applied as a UIP-D24/§9.7 consumer.                            |
