# UI platform — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner statements batch 2 and doctrine P11. Document
class: plan. Walks `docs/FUNCTION-CONTRACT.md` per capability group; every
consequential choice carries a `docs/DECISION-DOCTRINE.md` decision record.
Input evidence: the current implementation (cited by file:line throughout,
per the contract's code-claim rule),
`docs/builder-program/dossiers/trimble-perspective.md` (the viewing/navigation
reference per A2, including corrected Access evidence §7),
`docs/builder-program/dossiers/realworks.md` §8 (reticle-related researched
precedent/absence), `dossiers/revit.md` §W3 (multi-select properties),
`docs/DESIGN-SYSTEM.md` (normative for shell language and shared controls,
including the amended docked-default rule), `docs/history/BUILDER-MVP-PLAN.md`
§10b/§10c (historical intent, evidence not norm), owner decisions D1–D7,
`ui-platform-spec-review-2026-09-01.md` (findings 1–16, dispositioned in §5),
and `ui-platform-batch2-review-2026-09-02.md` (findings 1–14, dispositioned
at the end of §9).
E1 reference artifact: §7 of this file — in-repo written criteria concrete
enough to fail against; no third-party screenshots per repository license
discipline.

Domain: the shell capabilities every other Builder domain depends on. Other
domain specs may assume everything in §1 as platform-provided. §3.6 is the
platform gesture map that the contract's input-arbitration rule (E2) binds
every tool spec to reconcile against; conflicts between a domain spec and
this one are registry-level findings.

## 1. Function catalog

Surface abbreviations: RP = right function panel, VP = viewport, SB = status
bar, FI = floating island. Performance classes per contract D1: cont =
continuous, bnd = bounded (< 1 s), long = long-running. Status is measured
against the audited implementation (§5).

| Id                   | Capability                                                                | Access paths                                                                                  | Surface     | Perf | Automation command                        | Status                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------- | ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ui.tab.close`       | Close a function tab                                                      | x on tab; ribbon button re-toggle; Escape ladder                                              | RP header   | bnd  | `ui.function.close`                       | partial — toggle-close only, no x (`IslandTabs.tsx:52–68`)                                                                        |
| `ui.panel.detach`    | Detach function content into a floating island                            | detach affordance in tab / panel header; tab context menu                                     | RP → FI     | bnd  | `ui.panel.detach` (UIP-D8)                | missing                                                                                                                           |
| `ui.island.redock`   | Return island content to the right panel                                  | island header button; Escape ladder; drag island onto RP dock zone                            | FI          | bnd  | `ui.island.redock` (UIP-D8)               | missing                                                                                                                           |
| `ui.island.move`     | Drag an island; raise on focus                                            | island drag handle                                                                            | FI          | cont | absent — view-local pixel chrome (UIP-D8) | partial — drag exists, no z-raise/persistence (`FloatingTaskIsland.tsx:105–133`)                                                  |
| `ui.layout.persist`  | Layout survives restart                                                   | automatic                                                                                     | —           | bnd  | state visible via `ui.layout.get`         | missing — no persistence anywhere (`useLayoutStore.ts:68`, `main.ts:273–274`)                                                     |
| `ui.layout.reset`    | Reset layout to defaults (scope: UIP-D9)                                  | ribbon View ▸ Reset layout; console `layout.reset`                                            | ribbon      | bnd  | `ui.layout.reset`                         | missing                                                                                                                           |
| `select.pick`        | Click a pickable entity in 3D to select (pickable classes: UIP-D15)       | VP left click (sub-threshold)                                                                 | VP          | bnd  | `select.set`                              | missing — infra unwired (§5)                                                                                                      |
| `select.extend`      | Ctrl+click toggles a pickable entity in the set                           | VP ctrl+click; tree ctrl+click (present)                                                      | VP          | bnd  | `select.add` / `select.remove`            | partial — tree only (`EntityTree.tsx:198–223`)                                                                                    |
| `select.clear`       | Deselect everything                                                       | double-click void; Escape ladder; console `select clear`                                      | VP          | bnd  | `select.clear`                            | partial — automation path only (`App.tsx:162`)                                                                                    |
| `select.cycle`       | Cycle ambiguous pick candidates, with visible state                       | Up/Down arrow keys after a click; entity menu "Select under cursor ▸"; SB indicator (UIP-D16) | VP + SB     | bnd  | `select.list` + `select.set`              | partial — obsolete implementation consumes Tab invisibly and must be rebound to Up/Down (`KernelNavigationController.ts:460–465`) |
| `ui.context.entity`  | Entity context menu                                                       | VP right-click on entity; tree right-click (present); tap-hold                                | menu        | bnd  | hosted commands individually              | partial — tree-only, ad-hoc markup (`EntityTree.tsx:232–317`)                                                                     |
| `view.quick-surface` | Viewport quick surface / mini toolbar                                     | VP right-click on void; tap-hold on void                                                      | menu        | bnd  | hosted commands individually              | missing — RMB suppressed (`KernelNavigationController.ts:109`)                                                                    |
| `jobs.surface`       | Global job list with progress (registry of record: main process, UIP-D10) | SB jobs chip; console `jobs`                                                                  | SB → FI     | bnd  | `jobs.list`                               | missing — console rows only (`console/src/store.ts:11–19`)                                                                        |
| `jobs.cancel`        | Cancel a running job                                                      | per-job cancel button                                                                         | jobs island | bnd  | `jobs.cancel`                             | partial — import only (`BuilderImportRegistrationIsland.tsx:269–274`)                                                             |
| `ui.notify`          | Completion/failure toasts                                                 | automatic                                                                                     | toast layer | bnd  | events via `jobs.list`                    | missing                                                                                                                           |

### 1.1 Batch-2 catalog additions (registry-complete locally)

These are separate user acts, not the four aggregate placeholders used by the
first batch-2 amendment. UI Platform owns the shared strip, tree control,
reticle, and cursor presentation; the command/query owner named in the last
column remains authoritative. `REGISTRY.md` round 3 copies these rows without
merging them. Its duplicate-act/surface/gesture/state audit is clean, so this
spec is **specified**.

| Id                            | Capability                                                                                    | Access paths                                                                            | Surface                 | Perf       | Canonical command/query                                                                  | Status                            | Command/query owner; consumers                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------- | ---------- | ---------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `view.support-overlay`        | Show/hide the global Support geometry overlay without changing support roles or P9 permission | bottom strip; View menu; console; Agent/Python                                          | strip + VP              | bnd        | `view.support_overlay.get/set`                                                           | new                               | View VD-D14; Draw roles, renderer, pick/snap/measure consumers                                                        |
| `view.labels-global`          | Show/hide all eligible labels without changing per-entity policy                              | bottom strip; View menu; console; Agent/Python                                          | strip + label pass      | bnd        | `view.labels.global.get/set`                                                             | new                               | View VD-D14; render/Plan-capture consumers                                                                            |
| `view.labels-entity`          | Read/change one or many entities' canonical label policy                                      | Properties; entity context; console; Agent/Python                                       | Properties + label pass | bnd        | `view.labels.entity.get/set`                                                             | new                               | View; Document history owns the journal step                                                                          |
| `view.mode`                   | Change 3D / 2.5D / 2D mode                                                                    | existing View ribbon/shortcut/console/Agent/Python plus bottom-strip contribution       | ribbon + strip + VP     | bnd        | existing `view.mode.get/set`                                                             | existing View act; new strip path | owner: view-domain; View VD-D1/VD-D9; UI Platform contributes only strip access                                       |
| `selection.granularity`       | Change Whole / Segments selection                                                             | bottom strip; Selection menu; console; Agent/Python                                     | strip + VP              | bnd        | `selection.granularity.get/set`                                                          | new                               | Select/Edit SE-D19; all selecting/editing tools consume                                                               |
| `selection.kind-filter`       | Read/change selectable entity kinds                                                           | bottom strip popover; Selection menu; console; Agent/Python                             | strip + popover + VP    | bnd        | `selection.kind_filter.get/set`                                                          | new                               | Select/Edit SE-D19; selection candidates only                                                                         |
| `document.history`            | Inspect/undo/redo the canonical document journal                                              | persistent Document history menu; existing quick/ribbon/keyboard; console; Agent/Python | strip menu              | bnd→long   | `document.history.get`, `document.undo/redo`                                             | existing File act; new strip path | File FP-D10/FP-D11; every canonical command                                                                           |
| `selection.history`           | Inspect/undo/redo/clear selection-local history                                               | persistent Selection history menu; console; Agent/Python                                | strip menu              | bnd        | `selection.history.get/undo/redo/clear`                                                  | new                               | Select/Edit SE-D19; selection set/modes                                                                               |
| `display.history`             | Inspect/undo/redo/clear display-local history                                                 | persistent Display history menu; console; Agent/Python                                  | strip menu              | bnd        | `display.history.get/undo/redo/clear`                                                    | new                               | View VD-D14; renderer/tree/Plan capture                                                                               |
| `camera.history`              | Inspect/undo/redo/clear camera-local history                                                  | persistent Camera history menu; console; Agent/Python                                   | strip menu              | bnd        | `camera.history.get/undo/redo/clear`                                                     | new                               | View VD-D14; viewport/Plan capture                                                                                    |
| `interaction.state-explain`   | Read requested/effective permission, capability intersection, and every cause                 | tree/Properties explanation; console; Agent/Python                                      | tree + Properties       | bnd, paged | `interaction.state.explain`                                                              | new                               | Select/Edit SE-D19; UI Platform renders; `selection.effective_state.explain` is a deprecated compatibility alias only |
| `interaction.state-preview`   | Preview an all-or-none requested P9 permission change and affected/unsupported counts         | four-state tree control; Properties; console; Agent/Python                              | tree + preview popover  | bnd→job    | `interaction.state.preview`                                                              | new                               | Select/Edit SE-D19; UI Platform invokes                                                                               |
| `interaction.state-apply`     | Apply the previewed requested P9 permission change atomically                                 | preview Apply; console; Agent/Python                                                    | tree + progress/job     | bnd→long   | `interaction.state.apply`                                                                | new                               | Select/Edit SE-D19; command layer rechecks                                                                            |
| `ui.reticle.shared-3d-target` | Arm/manipulate the shared point/orientation proposal used by spatial tools                    | owning tool's ribbon/context/panel; viewport handles; typed construction bar            | VP + construction bar   | cont       | no component command; owning tool preview/commit command receives the proposed transform | new shared component              | UI Platform; Draw DR-D17, Viewing Box VB-D15, View VD-D15 consume                                                     |
| `ui.cursor.semantic`          | Resolve the platform cursor vocabulary and precedence for every armed surface                 | automatic from tool/hover/job state; accessibility description query                    | pointer + VP            | cont       | `ui.cursor.describe` query only; no state-changing cursor command                        | new shared presentation           | UI Platform; every armed tool/surface declares a row in §9.7                                                          |

Registry-fed consumers added by owning specs: `edit.clipboard.paste_in_place`
is now active on `view.quick-surface` through SE-D7/UIP-D13; Import's jobs
surface hosts `import.apply_to_similar` under IF-D2; BIM Specification
shortcuts and Generate are detachable function consumers under UIP-D8/UIP-D14,
with F9 focusing shortcuts and no number-slot bindings (BS-D19).

Clipboard is owned by Select/Edit SE-D7: `edit.clipboard.paste_in_place` is an
active quick-surface contribution when the captured token passes its CRS/unit
contract. The jobs-island "apply answers to similar imports" action is owned by
Import IF-D2 as `import.apply_to_similar`; neither is a UI Platform state store.

Shared-component inventory (`packages/@himmelcad/ui/src/index.ts`), audited
per DESIGN-SYSTEM "Shared controls" rule 1 (search before creating):

| Component                                                                                                                                                                                                                                       | State              | Evidence / first consumer                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| AppShell, TitleBar, Ribbon, EntityTree, FunctionPanel, StatusBar, Splitter, PanelToggles, EdgeStrip, IslandTabs, OverlayChip, ExpandChevron, Checkbox, Radio, Select, EmptyState, CrsTransformPair, ImportChat family, ImportRegistrationWizard | present            | barrel `index.ts:1–58`                                                                                                             |
| ProgressBar                                                                                                                                                                                                                                     | present but buried | exported from the ImportChat module (`ImportChat.tsx:297–321`); promote to a top-level shared control (UIP-D12)                    |
| Button                                                                                                                                                                                                                                          | missing            | raw `<button>` + per-module CSS everywhere; first consumer: every panel                                                            |
| Menu / ContextMenu                                                                                                                                                                                                                              | missing            | ad-hoc menu div in `EntityTree.tsx:232–317`; first consumer: §2.3                                                                  |
| Dialog                                                                                                                                                                                                                                          | missing            | modality is faked via `FloatingTaskIsland modal`; first consumer: destructive confirmations that are not undo-covered              |
| Toast                                                                                                                                                                                                                                           | missing            | first consumer: §2.4 job completion                                                                                                |
| Tooltip                                                                                                                                                                                                                                         | missing            | native `title=` only; first consumer: ribbon + chips (DESIGN-SYSTEM "UI copy")                                                     |
| Spinner                                                                                                                                                                                                                                         | missing            | only a `.spinner` CSS class (`ImportChat.module.css:799`); first consumer: bounded busy states                                     |
| Slider                                                                                                                                                                                                                                          | missing            | raw `<input type="range">` (`App.tsx:914–924`); first consumer: point size                                                         |
| NumberInput                                                                                                                                                                                                                                     | missing            | raw `<input type="number">` in `VectorEditor` (`App.tsx:1243–1254`); first consumer: viewing-box C1 fields (viewing-box spec §1.2) |

## 2. Workflow narratives

### 2.1 Detach, float, re-dock

The user is tracing a facade with the Draw panel open on the right while
comparing against the properties of a selected wall. Both live in the same
right-panel tab strip, so they fight for one slot. Functions always open
docked — DESIGN-SYSTEM "App composition": "Tool parameter surfaces default
to docked when the user must interact with the viewport; user-initiated
detach is permitted and remembered, and a function's viewport interactions
behave identically in either host." On the Draw tab the user presses the
detach affordance (also offered in the tab's context menu). The Draw content
lifts out of the panel into a floating island — same dark-island material, a
slim header with the function name, a drag handle, a re-dock button, and an
x. The right panel falls back to Properties, which is the panel's default
tab: always present, always reachable, never closeable — closing the last
function tab lands there (current fallback semantics,
`FunctionPanel.tsx:45–52`; the same model the BIM/specifications spec
adopts). Drawing in the viewport behaves exactly as it did docked — the
detached host changes chrome, never interaction. The user drags the island
by its header next to the facade; it clamps to the window so the header can
never leave reach, and clicking anywhere on it raises it above the other
islands. Double-clicking the header re-centers it (existing behavior,
`FloatingTaskIsland.tsx:135–137`). Escape pressed inside the island does not
teleport it — the current global recenter-on-Escape listener
(`FloatingTaskIsland.tsx:54–55`) is removed; Escape follows the ladder in
UIP-D14, where only _detached function_ islands are rungs: the Specs, Plan,
and Agent workspace islands (`App.tsx:844–860`) never close from a stray
Escape and are closed only by their own x or their launch toggle. Pressing
the re-dock button (or dragging the island onto the right panel, which shows
a dock hint) returns the function to the tab strip exactly where it was.
Closing the island via its x closes the function — identical to the tab's x,
one command underneath. On restart, a function the user detached reopens
detached, at its last position, clamped to the current monitor — that is the
"remembered" half of the design-system rule; positions are user-level app
state, never project content (§10b evidence, `BUILDER-MVP-PLAN.md:436–447`).
The four existing islands adopt the same header, drag, raise, and
persistence behavior; the import island keeps its modal focus trap. An agent
can do all of this too: `ui.panel.detach` and `ui.island.redock` wrap the
same state transitions (UIP-D8).

### 2.2 Selecting in the viewport

The user has a scan plus an IFC model loaded and wants the properties of one
wall. They click it. The press-release travels less than the drag threshold,
so it is a click, not an orbit: the kernel pick resolves the entity under
the cursor and the wall gets the geometry-class selection treatment from
§7.1/§9.6 (orange plus a non-color cue), via the kernel's built-in highlight
(`WgpuKernelViewer.ts:2740`, `{selected, hovered}`). The entity tree scrolls
to and marks the same wall; the Properties tab shows its properties; the
status bar count reads "Selected: 1". Clicking the bare scan around the wall
does _not_ replace the selection with the 500-million-point cloud: point
cloud and splat entities are not click-selectable in the viewport (UIP-D15)
— a click on bare points behaves exactly like a click on void, so a failed
micro-orbit against the cloud never destroys a built selection. The cloud is
selected deliberately instead: in the tree, or by right-clicking it in the
viewport (the menu's targeting rule selects it, §2.3); its selection
treatment is an orange, haloed outline on its bounding box, never a per-point
restyle. Moving the mouse over IFC and mesh entities shows a lighter hover
state once the cursor settles — hover never runs per-frame during camera
motion, and clouds/splats are never hover-restyled (UIP-D4, UIP-D15).
Ctrl+click on a second wall extends the selection; ctrl+click on a selected
wall removes it. Clicking the sole selected wall again keeps it selected —
idempotent desktop click; the reference's tap-again-deselect stays a _touch_
behavior (UIP-D2). A click that lands on overlapping geometry selects the
front candidate, and the ambiguity is visible: the status bar shows
"1 of 3 under cursor — ↑↓ cycles" while the candidate set is live
(UIP-D16); the Up/Down arrow keys cycle the pick candidates (Tab is
reserved for the construction input bar everywhere — draw DR-D1, owner
statement S1 and follow-up 2026-09-02: one meaning per key); the arrow
keys cycle the pick candidates in the stable order
the kernel guarantees in its executing sort/dedup path
(`crates/himmelcad-render/src/picking.rs:398–436`), consumed at
`KernelNavigationController.ts:485–540`, moving the
selection with them, and the entity context menu offers the same candidates
as a "Select under cursor ▸" list. Double-clicking empty space (or bare
cloud points) clears the selection; a single click there does nothing.
Clicking anywhere outside the viewport — ribbon, panels, status bar, island
chrome — never deselects (owner rule, recorded in UIP-D2): only explicit
selection gestures, tree clicks, Escape, and selection commands change the
set. Hiding a selected entity keeps it selected; deleting it — from any
surface, automation, or an undo/redo replay — prunes it from the set;
replacing the project clears the set (UIP-D18). Escape clears the selection
only as the last ladder rung (UIP-D14). With several entities selected, the
Properties tab shows the count in its header and the property set shared by
the selected types, marking mixed values as "Mixed"; committing a value into
a mixed field assigns it to the whole selection (UIP-D17, Revit precedent,
`dossiers/revit.md` §W3 [S28][S29]). Dragging with the left button still
orbits exactly as today — selection costs no navigation gesture (§3.6). An
agent doing the same work calls `select.set` and reads `select.get`; the
existing `view.state.set` selection path (`App.tsx:162`) resolves to the
same state.

### 2.3 Context menus

The user right-clicks the wall in the viewport. The press-release is below
the drag threshold, so it is a menu click, not a pan (right-drag still pans,
`KernelNavigationController.ts:381`): the wall is selected if it was not —
the same select-on-context rule the tree applies today, where a right-click
on an unselected row replaces the selection before opening the menu
(`EntityTree.tsx:219–221`) — and the entity context menu opens at the cursor:
a shared `Menu` component, dark-island material, token-styled,
keyboard-navigable, closed by Escape, outside click, or choosing an item.
Right-clicking bare cloud points targets the cloud entity the same way —
this is the deliberate viewport path for selecting a cloud (UIP-D15). Menu
content is generated from the command registry for the entity's kind and the
current selection — the same commands the tree menu, ribbon, console, and
automation expose (DESIGN-SYSTEM "Ribbon, context-menu, console, Python, and
AI access must resolve to the same underlying command"): Zoom to, Hide /
Show, Isolate, Rename, Properties, Export… for exportable products, "Select
under cursor ▸" when pick candidates overlap (UIP-D16), plus domain entries
other specs contribute (e.g. the viewing-box entity commands, viewing-box
spec B1). With multiple entities selected, the menu targets the whole set
and hides commands that cannot apply to it. The entity tree's hand-built
menu (`EntityTree.tsx:232–317`) is replaced by the same component fed by the
same registry, so tree and viewport can never drift apart. Right-clicking
empty viewport space opens the quick surface instead: a compact mini toolbar
of void-relevant commands — Frame all, view presets, "Place viewing box
here" (view-centered over void, viewing-box VB-D10), Clear selection when
one exists. (Paste-in-place is cut until a spec owns the clipboard —
finding 11; the quick surface gains it through the registry when that spec
ships.) It is selection-sensitive, following the reference's "softkey
changes meaning with selection" pattern (dossier §5,
Selection/deselection), and stays small: global configuration never enters
it (DESIGN-SYSTEM "Discoverability and contextual access"). Touch parity:
tap-hold opens the same menus (dossier §2.5 [S9]). The ribbon-tab RMB stays
reserved for the quick-bar (`Ribbon.tsx:115–118`) and is out of scope here.

### 2.4 The global job surface

The user drops three LAS files into the viewport. All three register as
jobs immediately: the first opens its import island; the other two appear
as "Needs input" jobs from birth — no file is silently parked (today they
queue invisibly in `registrationSourcePaths`, `App.tsx:421,881`). The jobs
chip appears in the status bar: a compact progress ring plus "3 jobs". The
user answers the first import's questions and presses "Run in background" —
the island hides (today's mechanism, `App.tsx:865`) and advances to the
next needs-input job. The registry of record for all of this lives in the
Electron main process, beside the sidecar it spawns; the renderer only
mirrors it and rehydrates the mirror on mount — a renderer reload or crash
recovery can therefore never orphan a running job: after reload, the chip,
progress, and cancel buttons reappear and keep working (UIP-D10,
SYSTEM-001). The sidecar's real progress lines (`sidecarProgress.ts:1–30`,
`progressKey`, fraction, message) drive the ring; nothing fabricates a
smooth percentage (DESIGN-SYSTEM "Progress, cancellation, and feedback").
Clicking the chip opens the jobs island: one row per job — label, phase
message, real progress bar (the promoted shared `ProgressBar`), elapsed
time, and a cancel button where the job is cancellable. Cancel routes to
the job's own cancellation (imports: `session.cancelRegisteredImport`,
`BuilderImportRegistrationIsland.tsx:269–274`); a job in a short atomic
phase says so and cancels at the next safe boundary; cancellation never
publishes partial canonical results. A job that needs input again shows
"Needs input" and clicking it restores its island. On completion a toast
appears — "Import committed: facade.las", click to frame the result — and
on failure the toast names what failed and what remains safe, linking to
the console entry; the console keeps the permanent record, with its
in-place progressKey rows retained as the log-side view
(`console/src/store.ts:11–19`, `Console.tsx:216–229`). The chip disappears
when no jobs run; the status bar never shows the static "Registering
import…" text again (`App.tsx:687`). The reference posture is Perspective's
capture workflow: capture, download, and registration overlap with the
operator walking — the user never waits at a progress bar to see data
(dossier §3, W1). Long-running work from any domain — viewing-box bakes
(which continue when their panel closes and register here, viewing-box spec
§1.3 as amended in coordination with this spec), exports, agent runs —
registers a job through the same platform API and inherits chip, island,
toast, cancel, and automation visibility (`jobs.list`, `jobs.cancel`) with
no per-feature surface code.

## 3. Function contract answers by capability group

### 3.1 Panels, islands, layout (`ui.tab.close`, `ui.panel.detach`, `ui.island.*`, `ui.layout.*`)

**A2.** The shell language is normatively ours: VS Code-inspired Dark
Islands (`docs/DESIGN-SYSTEM.md` "Visual language", "App composition";
`AppShell.tsx:29` "panels never share borders"). The viewing/navigation
dossier documents fixed UI areas — view toggle area F, display settings
area G, tools, list panels (dossier §2.1 [S1][S2]) — and no dockable,
floating, or user-rearrangeable panel behavior anywhere in §2; that checked
absence is the A2 evidence that no reference behavior exists to adopt here.
Layout persistence intent is repo-resident evidence:
`BUILDER-MVP-PLAN.md:430–459` (§10b).
**A3.** Siblings: the four existing islands (§2.1) — their close semantics
verified: Specs/Plan/Agent unmount on close and reopen fresh from their
File-ribbon toggles (`App.tsx:440–448,844–860`), the import island's close
is guarded by its own flow (`onRequestClose` no-op, `App.tsx:866`);
PhotoLab's diverged `FloatingTaskIsland` copy
(`apps/photolab/renderer/src/FloatingTaskIsland.tsx`) — the generalized
island is built in `@himmelcad/ui` and PhotoLab adopts it (DESIGN-SYSTEM
"extend the shared module first"); the console island's collapse/EdgeStrip
pattern stays the model for panel collapse.
**B1.** Detach/re-dock/close: visible affordances on tab and island header
plus tab context menu; console `layout.reset`; automation `ui.layout.get` /
`ui.layout.reset`, `ui.function.open/close`, and `ui.panel.detach` /
`ui.island.redock` (X3 — everything the user can do to function surfaces,
an agent can; finding 14). Island _pixel positions_ remain absent from
automation write commands: view-local chrome, readable via `ui.layout.get`,
recorded in UIP-D8.
**B2.** Every open surface closes from itself: tab x, island x, ribbon
button re-toggle (present toggle semantics, `useLayoutStore.ts:100–117`),
Escape per UIP-D14. The Properties tab is the exception by design: it is
the panel's default tab, always present, and has no close affordance —
closing the last function tab falls back to it
(`FunctionPanel.tsx:45–52`); it is never an Escape rung. Closing a function
means what the owning domain spec says (cancel vs keep-alive); the platform
guarantees only that close paths exist and agree.
**B3.** Tool parameter surfaces default to docked when the user must
interact with the viewport; user-initiated detach is permitted and
remembered, and a function's viewport interactions behave identically in
either host (DESIGN-SYSTEM "App composition", amended 2026-09-01 — cited,
not restated). Floating islands remain the home for focused multi-step
work. Detach exists precisely because the same content legitimately moves
between the two as the workflow changes; it never changes what the function
does in the viewport.
**C1.** n/a — no numeric manipulation surface; island positions are
drag-only chrome (typing coordinates for a window is not a CAD workflow;
recorded).
**C2.** Panels do not consume the selection; the Properties tab reflects it
(present behavior, `App.tsx:772–801`), including the UIP-D17 multi-select
model.
**C3.** n/a — no expensive live state to freeze.
**C4.** Layout is app state, never journaled, never project content:
user-level config per §10b (panel sizes/collapse, ribbon collapse, window
bounds, island positions, detached-function set), per-project overrides
later per §10b's manifest list. Not undoable; defensible: Ctrl+Z is for
model steps, and no reference product journals window chrome (X4). The
restore operation `ui.layout.reset` defines its affected-state set
explicitly in UIP-D9 (contract C4 restore-scope rule).
**D1.** Island drag and splitter drag are continuous — gate G-UIP-2 (§6).
Open/close/detach/re-dock are bounded and must feel instant (< 100 ms,
tunable X6); no busy indicators (DESIGN-SYSTEM: instant actions do not
flash).
**D2.** Chrome never degrades; it is not in the render budget. Input
responsiveness of drags is protected by the same rAF batching the Splitter
already uses (`Splitter.tsx:17–39`).
**E2.** Consumers of layout state: AppShell (sizes/collapse), FunctionPanel
(tab strip), ribbon (active highlight via `activeFunctionId`), EdgeStrips,
persistence writer, automation `ui.layout.get`, and every domain function
panel that assumes it is docked. Effect of detach on that last consumer:
function content receives the same React tree in either host — domain
panels must not read "am I docked", and their viewport interactions are
host-independent (B3). Class extremes (contract E2 extreme-member rule) for
the island rules: the _least typical_ island is the modal import island —
it keeps its focus trap, is excluded from Escape-rung order (it traps
Escape itself, `FloatingTaskIsland.tsx:82–85`) and from raise-on-focus
(modal is always top); the _largest_ is the Agent chat island with
unbounded conversation content — it is a persistent workspace island, never
an Escape rung, and its content scrolls rather than growing the island.
Failure: a corrupt layout file is discarded and defaults apply (that is
what `ui.layout.reset` does deliberately); persistence writes are debounced
and atomic so a crash mid-write cannot half-apply. Two windows are out of
scope (single-window product today, `main.ts:249–280`).

### 3.2 Shared components

**A2.** Normative source is DESIGN-SYSTEM "Shared controls" (no unstyled
native controls; semantic HTML, focus, keyboard, screen-reader labels
beneath custom styling). Reference products contribute nothing at component
grain; the existing `Select` (`Select.tsx:66–148`) is the in-repo pattern
for popup positioning, outside-click, and Escape handling that `Menu`,
`Tooltip`, and `Dialog` follow.
**A3.** Every existing raw control named in §1's inventory is the sibling
to replace; the viewing-box spec's committed `VectorEditor` rework
(viewing-box spec §1.2 — Enter/blur commit, Escape revert, close discards)
consumes `NumberInput`, so both surfaces share one commit/revert
implementation (DESIGN-SYSTEM "Input consistency"), not two.
**B1–B4.** n/a — components are not user-facing functions; their consumers'
specs answer access. Recorded as the class answer for the whole table.
**C1.** `NumberInput` and `Slider` are the numeric-parity building blocks:
every `Slider` instance pairs with a typed input (contract C1); shipping a
slider alone is a defect (X5).
**D1.** Menu/dialog/toast open are bounded-instant; `Spinner` exists for
bounded states, `ProgressBar` for long-running ones — components encode the
DESIGN-SYSTEM feedback ladder so features cannot pick wrong.
**E1.** §7 criteria 1–3. Design tokens only (`tokens.css:2–10`); no one-off
chrome.
**E2.** Consumers: all four products (DESIGN-SYSTEM scope). The layering
contract is explicit because it already leaks: `Select` hardcodes
`zIndex: 10050` above the islands' `1000`
(`Select.tsx:100–111`, `FloatingTaskIsland.module.css:1–9`) — the shared layer
scale (panel < island < menu/tooltip < toast < modal) becomes a token, and
components consume it (UIP-D12). Input-class extremes for the Escape
component behavior: the commit/revert extreme is `NumberInput` (revert on
Escape); the free-text extreme is the agent chat input — Escape never
discards its content (UIP-D14, finding 9).

### 3.3 Context menu and quick surface (`ui.context.entity`, `view.quick-surface`)

**A2.** Adopted from the reference: tap-and-hold context menu, context menu
carrying "Clear selection"-class actions, selection-sensitive quick
commands (dossier §2.5 [S9]; §5 Selection/deselection). Deviation: our
primary trigger is RMB-click (desktop pointer), with press-drag retained
for pan — stated in UIP-D5; the reference is touch-first and has no RMB at
all.
**A3.** Siblings: the tree's ad-hoc menu (replaced, §2.3 — verified
semantics: right-click replaces selection only when the row is unselected,
then opens; closes on outside pointerdown/blur, `EntityTree.tsx:219–228`
and `:71–80`), the ribbon's reserved tab-RMB (`Ribbon.tsx:115–118`,
untouched), the viewing-box quick entry ("Place viewing box here",
viewing-box spec B1) which becomes a quick surface item.
**B1.** Entity menu: viewport RMB-click on entity, tree RMB (present),
tap-hold. Quick surface: viewport RMB-click on void, tap-hold on void. No
ribbon path — menus are contextual by definition (recorded). Console and
automation reach the hosted commands directly; the menu itself has no
automation command (it is an access path, not a capability — recorded,
consistent with B1's "all paths resolve to the same canonical command").
**B2.** Escape, outside click, and item choice close; opening a menu never
changes model state except the select-on-context rule (§2.3).
**C2.** Entity menu operates on the selection set containing the clicked
entity; mixed sets hide non-applicable commands rather than disabling
silently where an explanation is impossible in a menu row (DESIGN-SYSTEM:
disabled needs explanation; a hidden inapplicable verb needs none).
**D1.** Menu open is bounded-instant. The RMB click-vs-pan discrimination
adds zero cost to pan (threshold check on pointerup).
**E2.** Gesture consumers per §3.6: RMB drag stays pan
(`KernelNavigationController.ts:381`); the `contextmenu` suppression at
`:109` becomes conditional (suppress only after a drag). Consumers of menu
commands: the command registry — ribbon, console, automation, tree — all
read the same definitions, so a command added anywhere appears everywhere
it declares surfaces (UIP-D6). Class extremes for the menu-target rule:
largest member — the point cloud entity: its menu targets the cloud
(Zoom to, Hide, Export…, viewing-box placement) and this is the deliberate
viewport path to select it (UIP-D15); least typical — tree-only entities
like `CameraImage`/GCP rows, whose menus exist only in the tree today
(`EntityTree.tsx:248–284`) and keep working unchanged through the registry.
Failure: a command that throws surfaces its error per DESIGN-SYSTEM error
copy; the menu itself never partially executes.

### 3.4 Viewport selection (`select.*`)

**A1.** §2.2 in full.
**A2.** Adopted from Trimble Access via the dossier's own mapping (§2.5
[S9], §5, and the corrected §7). Per the contract's catalog-disposition
rule, every dossier selection-model row gets a disposition:

| Dossier row (§2.5 [S9], §5)                                           | Disposition                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tap to select, blue highlight                                         | interaction adopted; blue rejected for selected geometry in favor of the owner's orange geometry token family (`trimble-perspective.md` §7.2 [A19–A22], DESIGN-SYSTEM "Visual language")                                                                                                                 |
| Tap again to deselect                                                 | adopted for touch; **rejected for mouse** — desktop clicks are idempotent, and consuming the second click forecloses double-click actions (UIP-D2, stated deviation)                                                                                                                                     |
| Double-tap empty space clears                                         | adopted — double-click void/bare-cloud clears                                                                                                                                                                                                                                                            |
| Rectangle / polygon drag selection                                    | deferred — Select ▸ Box/Lasso ribbon tools, own selection-tools spec (dossier §5 maps them to Builder's existing ribbon entries)                                                                                                                                                                         |
| Tap-and-hold context menu, "Clear selection"/"List selection"         | adopted — tap-hold + RMB menus; clear-selection in quick surface                                                                                                                                                                                                                                         |
| Ambiguous tap opens a disambiguation list                             | adapted — Up/Down cycling on the kernel's stable candidate order plus a visible SB indicator and a menu candidate list (UIP-D16); a modal list would fight the pointer-flow                                                                                                                              |
| Perspective object-tap (stations/annotations/measurements, §2.5 [S6]) | adopted in kind — we select entities; the dossier flags bare-cloud point tap-select as thin evidence, and Perspective fills that role with limit box/Magnify — supporting evidence for UIP-D15's cloud exclusion                                                                                         |
| Selection-sensitive softkeys (§5)                                     | adopted — quick surface content varies with selection (UIP-D13)                                                                                                                                                                                                                                          |
| Access Selectable / Visible / Off project-data states                 | adapted: Selectable supports the Reference approximation and Off supports Hidden; Visible supports only the displayed/nonselectable part of Inert. Editable and the stronger no-snap/no-edit Inert semantics are Himmel:CAD-native capability-bound extensions (`trimble-perspective.md` §7.1 [A15–A18]) |
| Parent propagation and two mixed summaries                            | adopted as affected-count preview plus Mixed cause summary; Access's two summaries remain distinguishable in explanation text, not writable states (`trimble-perspective.md` §7.1 [A15–A16])                                                                                                             |
| Arbitrary Ctrl/Shift multi-row apply                                  | native Builder extension; Access documents parent and All/None propagation but not arbitrary multi-row application (`trimble-perspective.md` §7.1 [A17–A18])                                                                                                                                             |
| Stakeout direction arrows                                             | adapted from stakeout-only to every directed selected/active curve by owner taste; the dossier does not support universal arrows or orange (`trimble-perspective.md` §7.2 [A19–A21])                                                                                                                     |
| Universal selected-point square                                       | no reference precedent claimed; Access supports configurable point glyphs, so the stable orange square is a Himmel:CAD-native extreme-case cue (`trimble-perspective.md` §7.2 [A19][A22])                                                                                                                |

**A3.** Siblings: EntityTree selection — verified semantics: plain click
replaces, ctrl/meta toggles, shift range-selects within siblings via
anchor (`EntityTree.tsx:198–223`); ctrl and plain click stay identical in
the viewport; shift-range has no 3D analogue and stays tree-only
(recorded); tree Ctrl+A selects the focused parent's existing children
(`EntityTree.tsx:183–190`)
— the registry shortcut recommendation below generalizes it; automation
`view.state.set` selection (`App.tsx:162`) becomes a wrapper over the same
store; the status-bar count (`App.tsx:684`).
**B1.** Viewport gestures per §2.2/§3.6; console `select <id…>` /
`select clear`; automation `select.set/add/remove/clear/get` plus existing
`view.state`; keyboard: Escape (ladder rung), Up/Down cycle visible candidates
per UIP-D16; Tab/Shift+Tab traverse fields/focus. Ribbon: none for plain click-select — it is the default mode,
a button would be noise (recorded); Box/Lasso remain the ribbon's selection
tools. Shortcut recommendation to `REGISTRY.md`: Ctrl+A = select all
visible (generalizes the tree sibling behavior); the registry owns
assignment (viewing-box VB-D9 class).
**C2.** Selection is one global set shared by tree, viewport, properties,
and automation; there are no per-surface selections. Multi-select property
behavior on the platform's own Properties surface is UIP-D17: shared
property set of the selected types, "Mixed" indication, count in the
header, commit-assigns-to-all. Functions capture or track the set per
their own C2 answers.
**C4.** Selection is view-local, not journaled (UIP-D3): Ctrl+Z never
un-selects, matching every reference product; it is still fully
automation-visible (X3 exception justified in the record). Its current state
and local history persist per project through FP-D21's versioned
ViewState/local-state store; reopening rehydrates and revalidates membership and
segment tokens. Project replacement unloads the active in-memory stream without
erasing that project's stored stream. Lifecycle pruning across delete/hide/
replace is UIP-D18, including the rule that undo/redo replay prunes but never
silently resurrects invalid membership.
**D1.** Hover highlight is the continuous member — gate G-UIP-1 (§6), run
over a scene whose entity under the cursor is a giant point cloud (the
extreme member must be in the gate, finding 1). The click→highlight path is
bounded: pick resolution plus one `setEntityInteractionState` upload;
budget 150 ms p95 on tier hardware (tunable X6), no busy indicator below
it.
**D2.** During camera motion, hover picking pauses (the controller already
defers picks to settle, `KernelNavigationController.ts:430–432`); selection
highlight itself never degrades — it is a per-entity style bit, not a
per-frame cost (`WgpuKernelViewer.ts:2740–2756` retains it across device
replacement via the replay map, `:1644`).
**E2.** Consumers of the selection set and the effect of viewport selection
on each: EntityTree (marks + scrolls to selection), Properties panel/query
(`App.tsx:461–492`, multi-select per UIP-D17), status bar count, kernel
highlight state, context-menu targeting (§3.3), automation
`view.state.get` report (`App.tsx:183`), delete/hide/export commands acting
"on selection", and future selection tools (Box/Lasso extend the same set).
Class extremes for the selectability rule: largest member — the
multi-hundred-million-point cloud: excluded from click-select and hover,
bounding-box selection treatment (UIP-D15); least typical — a GCP marker:
pickable, its tiny geometry covered by the pick radius
(`WgpuKernelViewer.ts:3153`, radius 4), tree menu entries unchanged.
Selection-building gestures act on the visible set — hidden and
clipped-away geometry is never click-selectable (P4, generalized from
viewing-box VB-D13). Explicit membership survives hiding (UIP-D18): P4
scopes _acts_ — picking, fencing, destructive applies — not the persistence
of a set the user built deliberately; any act on that set that resolves to
geometry still runs P4-scoped. An automation `select.set` naming a
nonexistent entity fails whole, changing nothing. Crash recovery restores the
last atomically acknowledged per-project selection state/history under FP-D21
and revalidates every entity/segment token before exposure (§9.4).

### 3.5 Jobs (`jobs.*`, `ui.notify`)

**A1.** §2.4 in full.
**A2.** Reference posture: Perspective overlaps capture, download, and
registration with the operator walking — "the user never waits at a
progress bar to see data" (dossier §3, W1). The dossier documents no job
list, queue, or task-management UI anywhere in its catalog (§2, checked) —
that checked absence is the A2 evidence; the surface design derives from
DESIGN-SYSTEM "Progress, cancellation, and feedback", which is normative
and complete for this.
**A3.** Siblings: console progressKey rows (kept as the log view —
verified: rows with the same `progressKey` replace in place,
`console/src/store.ts:11–19`), the import island's background mechanism
(verified: `onBackgroundStateChange` hides the island while the commit
continues, `BuilderImportRegistrationIsland.tsx:206–216`, `App.tsx:865` —
becomes the first registered job), the viewing-box bake (continues on panel
close and registers as a job, viewing-box spec §1.3 as amended), future
export and agent runs. Queued (finding 16): an "apply answers to similar
imports" affordance on needs-input jobs — owned by the file-project spec.
**B1.** SB chip (visible whenever jobs exist), console `jobs`, automation
`jobs.list` / `jobs.cancel`. No ribbon entry (status, not a command —
recorded). Keyboard: none initially; recorded absent.
**B2.** The jobs island closes freely; closing it never affects the jobs.
Cancel is per-job and explicit; the chip cannot be dismissed while jobs run
(state must stay discoverable, DESIGN-SYSTEM).
**C2/C3.** n/a — jobs are not selection-coupled and have no freezable
state.
**C4.** Job records are runtime state; completed-job history lives in the
console (present pattern). Job outcomes that create entities are journaled
by their own commands, not by the job surface.
**D1.** Chip/island updates are bounded UI refreshes throttled to the
progress event rate; job execution itself is long-running by definition and
owns real progress and cancellation per DESIGN-SYSTEM.
**E2.** The registry of record lives in the **main process** (UIP-D10):
jobs execute in the main-spawned sidecar and in main-side services, so main
is the only process whose lifetime matches theirs; the renderer holds a
mirror, rehydrated on mount over the bridge — a renderer reload mid-import
must reproduce chip, progress, and working cancel (browser test, §6).
Consumers: status bar, jobs island, toasts, console, automation
`jobs.list`, and the job-owning feature (island restore for needs-input).
Class extremes for the job rules: largest member — a multi-hour
photogrammetry-scale import: survives renderer reloads (main-owned), keeps
real phase progress, cancellable between phases; least typical — a job that
completes faster than perception: registration is still mandatory, but the
chip debounces so sub-threshold jobs produce a completion toast without
chip flicker (threshold tunable X6; DESIGN-SYSTEM: instant actions do not
flash indicators). Concurrency per SYSTEM-001: multiple jobs run freely;
two jobs mutating the same canonical scope serialize through the journal
like any commands; cancel mid-atomic-phase defers to the next safe boundary
and says so (DESIGN-SYSTEM). Failure of a job never leaves a partial
canonical result (import commit is already transactional; the platform
requires the same of every registered job). Crash of the whole app: running
jobs die with their sidecar; on next launch the main-process registry
reports the interruption to the console and the owning feature decides
recovery.

### 3.6 The platform gesture map

This table is the arbitration baseline the contract's input-gesture rule
(E2) binds tool specs to. "Idle" = no tool armed. An armed tool's spec must
list every gesture it claims and reconcile it against this map; unlisted
gestures keep their platform meaning. Navigation gestures (drags, wheel)
remain platform-owned unless a tool spec states an explicit deviation with
reason. At most one tool is armed at a time; two specs claiming the same
gesture in the same state is a registry-level defect.

| Gesture                                        | Idle meaning                                                                                        | Armed-tool rule                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| LMB click (< threshold)                        | select pickable entity; inert on void/bare cloud (UIP-D2/D15)                                       | claimable (e.g. vertex placement, viewing-box center pick); tool spec must state it                                  |
| LMB double-click on entity                     | unassigned — deliberately reserved (UIP-D2 keeps it free)                                           | claimable                                                                                                            |
| LMB double-click on void/cloud                 | clear selection                                                                                     | claimable only with a stated reason                                                                                  |
| LMB drag                                       | orbit (3D) / pan (plan) (`KernelNavigationController.ts:381`)                                       | platform-owned; deviation needs reason                                                                               |
| Ctrl+LMB click                                 | toggle selection membership                                                                         | claimable                                                                                                            |
| RMB click (< threshold)                        | entity menu / quick surface (UIP-D5)                                                                | platform-owned; tools get menu entries instead                                                                       |
| RMB drag                                       | pan (`:381–386`)                                                                                    | platform-owned                                                                                                       |
| MMB drag / click                               | pan / unassigned (`:381,386`)                                                                       | claimable (click only)                                                                                               |
| Wheel                                          | zoom (`:440`)                                                                                       | platform-owned                                                                                                       |
| Tab / Shift+Tab                                | normal focus traversal; when a coordinate tool is armed, focus/traverse its shared construction bar | never cycles candidates; the armed tool may declare only its C1 field order                                          |
| Up / Down                                      | ordinary focused-control behavior; no viewport action without a live indicator                      | cycle the stable candidate set only while its visible indicator is live; otherwise ordinary focused-control behavior |
| Escape                                         | ladder, UIP-D14                                                                                     | tools occupy exactly the ladder's tool rung                                                                          |
| Typing                                         | registry shortcuts                                                                                  | armed tool's numeric/text entry wins focus                                                                           |
| Touch: tap / tap-again / tap-hold / double-tap | select / deselect (touch only, UIP-D2) / context menu / clear (dossier §2.5 [S9])                   | same rules as their pointer equivalents                                                                              |

`Shared3DTarget` is the one platform-declared deviation set: handle-origin LMB
drag translates on an axis/plane or rotates on a ring; off-handle LMB drag,
RMB drag, MMB, and wheel remain camera navigation. Its LMB click, RMB click,
Tab/Shift+Tab, Up/Down, typing, Enter, Escape, `pointercancel`, focus-transfer,
and trailing-pointer-up meanings are exhaustive in §9.5. Consumers may narrow
admission/authority but may not redefine these gestures.

## 4. Decision records

**UIP-D1 — One click-vs-drag threshold frees both mouse buttons.**
**Decision:** a press-release with pointer travel under 4 px is a click;
at or over it, the existing drag gestures run untouched (LMB orbit/pan,
RMB pan, `KernelNavigationController.ts:381`). LMB click = select; RMB
click = context surface. **Derivation:** X4 (dossier §5 maps tap-select
onto this viewport; desktop needs a discrimination the reference's touch UI
gets free); X1 ordering — navigation smoothness is untouched because the
threshold is evaluated on pointerup only; the 4 px value joins the
viewing-box VB-D5 threshold class. **Rejected:** a selection mode/tool the
user must enter (reference has none; adds a mode for the most common
action); modifier-click select (hides the primary action behind a key).
**Tunable:** yes — the 4 px threshold (X6), shared with VB-D5.

**UIP-D2 — Selection semantics: Access mapping per modality, plus the
owner's outside-click rule** (revised per review finding 7). **Decision:**
click selects (replace); clicking the sole selected entity with the mouse
_keeps_ it selected — idempotent desktop click — while touch keeps the
reference's tap-again-deselect; ctrl+click toggles membership;
double-click on void clears; single click on void does nothing; clicking
any surface outside the viewport never changes the selection; only
selection gestures, tree clicks, Escape (UIP-D14), and selection commands
do. Mouse-only deselect paths: ctrl+click a selected entity, double-click
void, Escape, tree, commands. **Derivation:** X4 — the dossier's mapping
(§2.5 [S9], §5) adopted per modality; the tap-again row is a _touch_
gesture and porting it to the mouse contradicts the desktop convention the
same X4 protects and forecloses double-click actions (§3.6 reserves them);
owner statement 2026-09-01 ("clicking outside the view never deselects"),
recorded here as its repo-resident source per doctrine auditability rule 1;
the inert single-void-click protects against micro-orbit misfires (X1).
**Rejected:** click-again-deselect on mouse (finding 7 — against every
desktop reference and double-click-foreclosing); click-on-void clears
(violates the micro-orbit protection and the reference's double-tap
pattern); focus-loss deselection (violates the owner rule). **Tunable:**
double-click interval follows the OS.

**UIP-D3 — Selection is view-local, recoverable, and automation-visible.** **Decision:**
the selection set is excluded from the document journal but has its own P8
undo/redo history; it is readable and writable through `select.*` and `view.state`,
and the App's existing automation path becomes a wrapper over the same store.
**Derivation:** X3's justified view-local exception and P8; Ctrl+Z walking
selection steps would bury model undo (C4's "defensible to a Ctrl+Z user"), so
selection uses its explicit local path; parity is preserved because agents get
full read/write (`App.tsx:162,183` already ship it). **Rejected:** document-
journaled selection (undo spam); unrecoverable selection; automation-opaque
selection (X3 violation — and already contradicted by shipped code).
**Tunable:** no.

**UIP-D4 — Highlight through the kernel interaction state; hover on
settle, hoverable classes only** (revised per review finding 1).
**Decision:** selected and hovered render states use
`setEntityInteractionState` (`WgpuKernelViewer.ts:2740`); hover picking
runs only when the camera is settled, reusing the controller's existing
settle-pick (`KernelNavigationController.ts:430–432`), and only entities
click-selectable under UIP-D15 are ever hover-restyled — clouds and splats
never are; styling follows the geometry-class matrix in §7.1/§9.6 (orange
plus shape/arrow/outline for selected, neutral elevation for hover).
**Derivation:**
reuse-first (DESIGN-SYSTEM) — the kernel API exists, survives device
replacement via its replay map (`WgpuKernelViewer.ts:1644`), and is tested;
X1/X2 — no per-frame hover cost during navigation and no restyle of the
class's largest member (contract E2 extreme-member rule). **Rejected:**
renderer-side overlay highlight (duplicates a shipped kernel feature);
per-frame hover picking (spends interaction budget on cosmetics); hovering
clouds (restyling half a billion points for a cursor pass). **Tunable:**
hover settle delay (X6).

**UIP-D5 — RMB: drag pans, click opens the context surface.**
**Decision:** the unconditional `contextmenu` suppression
(`KernelNavigationController.ts:109`) becomes drag-conditional: after a pan
drag, suppressed; after a sub-threshold click, the host receives a
context-surface event with the pick result (entity → entity menu, void →
quick surface, bare cloud → the cloud's entity menu per UIP-D15). Touch:
tap-hold, same event. **Derivation:** X4 (dossier §2.5 [S9] tap-hold
context menu); X5 — a context menu system with no viewport trigger is a
shipped half; UIP-D1 supplies the discrimination. **Rejected:** giving up
RMB pan (breaks existing navigation contract); Shift+F10/menu-key only
(hidden). **Tunable:** shares the UIP-D1 threshold.

**UIP-D6 — One command registry feeds every contextual surface.**
**Decision:** context menus and the quick surface are generated from
command definitions (id, label, applicability predicate, surfaces) — the
same definitions the ribbon, console, and automation resolve to; the
EntityTree menu is regenerated from it, not hand-maintained.
**Derivation:** DESIGN-SYSTEM "must resolve to the same underlying command
or query"; E2 — hand-built parallel menus are drift generators (the tree
menu already encodes commands nowhere else has). **Rejected:** per-surface
menu code (the current state; guarantees divergence). **Tunable:** no.

**UIP-D7 — Function tabs close with x; the ribbon toggle stays; Properties
is the closeless default.** **Decision:** `IslandTabs` items accept an
optional close affordance; function tabs wire it to `closeFunction`
(`useLayoutStore.ts:118–126`); clicking a tab only activates; the ribbon
button keeps toggle semantics (`useLayoutStore.ts:100–117`) as the B2 pair
of its opener. The Properties tab has no x and is the fallback when the
last function tab closes (`FunctionPanel.tsx:45–52`) — the panel is never
closeable to nowhere, matching the BIM/specifications spec's adoption of
the same model. **Derivation:** B2 open/close symmetry — today the only
in-panel close is the undiscoverable re-click toggle; X5; the Properties
fallback is shipped behavior kept deliberately. **Rejected:**
tab-click-to-close toggle (destroys tab-switching); removing ribbon toggle
(breaks B2 for the ribbon path); closeable Properties (an empty panel slot
serves nobody). **Tunable:** no.

_UIP-D7 revision 2026-09-02 (architect, implementation finding, PhotoLab
lane commit be8bc6e):_ the close affordance is implemented by the shared
`FunctionPanel` tab control (one `role=tab` per function plus a
non-interactive close region, Escape rung 7 as the keyboard pair) behind
the opt-in `closeFunctionTabs`/`onCloseFunction` props, not as an
`IslandTabs` item property. Ruling: conformant — the guarantee of this
record is the affordance pair (x closes, ribbon toggles, Properties is the
closeless fallback), not the host component; `FunctionPanel` is already
the shared module, so DESIGN-SYSTEM "Shared controls" is satisfied. Two
obligations follow: (a) Builder enables `closeFunctionTabs` in S-02/S-06
(default off protects PhotoLab; a Builder build with the flag off violates
this record); (b) the tablist must stay ARIA-valid (`aria-required-
children`), which the PhotoLab lane's follow-up fix restores. The
"`IslandTabs` items accept an optional close affordance" mechanism sentence
above is superseded by this note.

**UIP-D8 — One dockable island primitive in `@himmelcad/ui`; docked by
default** (revised per review findings 3 and 14). **Decision:**
`FloatingTaskIsland` generalizes into a shared island with: standard header
(title, drag handle, re-dock where applicable, x), raise-on-focus
z-ordering within a tokenized layer scale, window clamping (existing,
`FloatingTaskIsland.tsx:43–50`), double-click-recenter (existing), modal
variant with focus trap (existing, `:65–103`), and position persistence
keyed by island id. The global Escape recenter listener (`:54–55`) is
removed (UIP-D14 owns Escape). Function surfaces open docked by default;
detach is user-initiated and remembered per function, and viewport
interactions are identical in either host (DESIGN-SYSTEM "App composition",
amended 2026-09-01). Automation gets `ui.panel.detach` / `ui.island.redock`
wrapping the same transitions plus `ui.layout.get` visibility; island
_pixel placement_ stays a drag-only, automation-readable-not-writable
concern — the one genuinely view-local remainder (X3 exception).
PhotoLab's diverged copy is superseded by the shared module.
**Derivation:** DESIGN-SYSTEM "extend the shared module first" and the
amended docked-default sentence (cited, not restated — doctrine rule 1);
reuse-first (drag, clamp, trap all exist and are kept); §10b evidence for
persistence intent; X3 for the detach/re-dock commands (finding 14).
**Rejected:** a third-party docking library (one-off chrome, token
violations); per-app island forks (the current state — already diverged);
automation-writable pixel positions (no user capability requires them for
parity). **Tunable:** clamp margins (X6).

**UIP-D9 — Layout persists in user-level config with an explicit,
scope-defined reset** (extended per contract C4 restore-scope rule).
**Decision:** layout state persists debounced and atomically to a
user-level JSON in the Electron user-data directory through a main-process
bridge; window bounds join it (replacing the hardcoded 1480×920,
`main.ts:273–274`); `ui.layout.reset` (ribbon View ▸ Reset layout, console,
automation) restores defaults in one step. Its affected-state set: panel
widths/heights and collapse flags, ribbon collapse, open/active function
tabs' docked-vs-detached flags, island positions, main-window bounds, and the
Plan dedicated OS-window bounds/monitor/maximized state (PE-D1). Exempt:
theme, units, console filter level, recent projects, import directory —
these are preferences, not spatial layout; the exemption is safe because
each remains independently visible and settable, and the reset's purpose is
recovering a messed-up spatial arrangement, not wiping preferences. A
corrupt or version-mismatched persistence file is discarded to the same
defaults. Per-project layout overrides (§10b manifest list) are deferred
until the project manifest carries view state. **Derivation:** §10b's
explicit user-level list (`BUILDER-MVP-PLAN.md:436–447`); X5 — persistence
without reset ships half a pair; contract C4 restore-scope rule; renderer
`localStorage` rejected because §10b binds this state to user-level config
and the main process already owns window bounds. **Rejected:** localStorage
(wrong owner, lost on webview data clear); project-embedded layout
(violates §10b's separation); reset wiping preferences (surprising loss
outside the operation's purpose). **Tunable:** debounce interval (X6).

**UIP-D10 — The job registry of record lives in the main process**
(revised per review finding 4). **Decision:** the job registry (id, label,
phases, fraction, cancellable, needs-input, owner) is owned by the Electron
main process, whose lifetime matches the main-spawned sidecar where jobs
actually run; the renderer holds a mirror over the bridge and rehydrates it
on mount, so a renderer reload or crash-recovery reload cannot orphan a
job — chip, progress, and cancel must reappear and work after reload.
Sidecar `progressKey` lines map onto registry entries; the import island's
background path registers the first job; queued imports register as
needs-input jobs at drop time (finding 13); every long-running feature
registers or it fails review. Surfaces chain status-bar chip → jobs island
→ toasts → console. Bounded work below the registration threshold does not
register; a registered job that finishes faster than perception completes
with a toast but no chip flicker (debounced). **Derivation:** SYSTEM-001
(`docs/AGENT-FEEDBACK.md`) — lifecycle ownership must match execution
ownership; the renderer-owned alternative is exactly the orphaned-state
defect class (finding 4, the review's second lifecycle-ownership
recurrence); DESIGN-SYSTEM "Progress, cancellation, and feedback"; dossier
§3 W1 for the never-wait posture. **Rejected:** renderer-owned registry
(reload orphans every job); console-only progress (the current state;
undiscoverable); per-feature progress surfaces (drift, the E2 consumer
lesson). **Tunable:** toast auto-dismiss and chip debounce times (X6).

_UIP-D10 revision 2026-09-04 (architect, cross-product convergence after
PhotoLab WP-H2 and Builder S-05 each built a status-bar jobs chip):_ one
shared chip and jobs island in `@himmelcad/ui` serve both products. Chip:
20 px pill at the right end of the status bar after the panel toggles, UI
11 px, 1 px tone border (accent running, warning needs-input, error failed
with error-tone text, success completed with a 4 s linger — tunable), left
slot 14 px spinner or 48×3 px progress when a fraction is known; label
grammar "1 job running · <label> 42 %", "n jobs running", "Needs input ·
<label>", "Cancelling…", "Job failed — <label>", "Job completed — <label>";
`aria-label` "Jobs: <label>"; click toggles the jobs island. Unknown units
render "in progress" with an indeterminate bar, never "0 %". PhotoLab
adopts the shared component and deletes its local chip (obligation recorded
in its plan at H2's landing); Builder's S-05b implements this record.

**UIP-D11 — Cancellation is a first-class job property.** **Decision:**
every registered job declares cancellable or names why not; cancel checks
between bounded units, never publishes partial canonical results, and a
temporarily uncancellable phase communicates itself and cancels at the next
boundary. **Derivation:** DESIGN-SYSTEM (verbatim requirements); X1 — no
partial canonical state. **Rejected:** best-effort kill (data integrity);
uniformly forbidding uncancellable phases (some atomic commits are real).
**Tunable:** no.

P11 is adopted without a UI-specific paraphrase: **Product operations reach
automation and the console from one generated command table: every product
capability (Builder, PhotoLab, WeltView read-only queries) is a canonical command
or query with the validate/status/cancel lifecycle, generated from a single
command table that also drives the console vocabulary and the Python SDK;
allowlisting raw RPCs is never the exposure mechanism; approval,
confirmation-grant, and credential surfaces stay user-only (ADR 0024).** UIP-D6's
context menus and quick surfaces consume that table; they do not create another
registry or an exposure allowlist.

**UIP-D12 — Component gap closes reuse-first, `Menu` first.**
**Decision:** build order by consumer need: `Menu`/`ContextMenu` (unblocks
§2.3), `Button`, `NumberInput` (shared with the viewing-box `VectorEditor`
rework — one commit/revert implementation), `Toast` + `Spinner` (unblocks
§2.4), `Tooltip`, `Slider`, `Dialog`; `ProgressBar` is promoted from
ImportChat to a top-level export; a z-layer token scale replaces the
hardcoded `10050`/`1000` pair (`Select.tsx:100–111`,
`FloatingTaskIsland.module.css:1–9`); existing raw controls (§1 inventory)
migrate as their surfaces are touched. All components: tokens only,
semantic HTML, keyboard and screen-reader behavior per DESIGN-SYSTEM
"Shared controls". **Derivation:** DESIGN-SYSTEM rules 1–4 (search, reuse,
extend shared first); A3 sibling-consistency; the `Select` implementation
is the in-repo pattern to extend. **Rejected:** adopting a component
library (one-off chrome, token conflicts, DESIGN-SYSTEM prohibition);
big-bang migration of all raw controls (churn without consumer need).
**Tunable:** no.

**UIP-D13 — Quick surface content is small, void-relevant, and
selection-sensitive.** **Decision:** the void quick surface carries only
commands meaningful over empty space (frame, view presets, place-here
class, clear-selection-when-any); entries are contributed through the
UIP-D6 registry with a `quickSurface` flag; global configuration is banned
from it. Select/Edit now owns clipboard, so **Paste in place** joins as
`edit.clipboard.paste_in_place` (SE-D7), enabled only when its CRS/unit contract
admits the captured token. **Derivation:** DESIGN-SYSTEM "Discoverability and contextual access"
(verbatim scope rule); dossier §5 selection-sensitive softkey precedent.
**Rejected:** a full command palette on RMB (unscoped, duplicates the
console); cataloging paste without an owner (a dangling capability).
**Tunable:** entry cap (X6).

**UIP-D14 — One platform Escape ladder, one rung per press** (revised per
review findings 2 and 9). **Decision:** Escape resolves innermost first:
(1) a focused _commit/revert_ field reverts to its committed value
(`NumberInput` class, DESIGN-SYSTEM "Input consistency") — free-text
surfaces (agent chat input, console input) are exempt: Escape never
discards their content, at most releases focus, and is consumed; (2) an
active drag reverts; (3) an open menu/quick-surface closes; (4) an armed
tool/placement cancels (the owning spec's rungs, e.g. viewing-box VB-D5,
slot here); (5) a modal island traps Escape for its own close (existing,
`FloatingTaskIsland.tsx:82–85`); (6) the topmost _detached function_
island closes — persistent workspace islands (Specs, Agent) are never Escape
rungs and close only via their own x or launch toggle; Plan is a dedicated OS
window under PE-D1 and likewise never participates in this ladder;
(7) the active function _tab_ closes, the panel falling back to Properties
(UIP-D7) — Properties itself is never a rung; (8) the selection clears.
The global recenter-on-Escape listener is removed (UIP-D8). Class extremes
(contract E2 rule): input class — `NumberInput` (reverts) vs the agent
chat's unbounded free text (never discarded, finding 9); island class —
the modal import island (traps its own Escape) vs the persistent Agent
island (no rung, finding 2) vs a detached function island (rung 6).
**Derivation:** DESIGN-SYSTEM "Complete user flows" and "Input
consistency"; X5; X1 — discarding a half-written agent prompt is data
loss; composes the viewing-box ladder (VB-D5) into a platform-wide order
so two specs can never both claim the same press. **Rejected:** Escape
clearing selection before closing surfaces (destroys selection while
backing out of chrome); a single ladder over all islands (finding 2 —
routine deselection would tear down the Agent workspace); global
input-revert (finding 9 — deletes prompts); per-feature ad-hoc Escape
handlers (the current state — the island listener already misfires
globally). **Tunable:** no.

**UIP-D15 — Point clouds and splats are deliberately selected, never
click-selected** (new per review finding 1). **Decision:** cloud and splat
entities are excluded from viewport click-select, ctrl+click, and hover
restyle; a sub-threshold click on bare points behaves exactly like a void
click (single: inert; double: clear). They are selected deliberately: tree
click, viewport RMB targeting (§2.3), console, automation. Their selection
treatment is an orange haloed outline on the entity's bounding box; per-point
restyle never happens. All other renderable entity classes (mesh, CAD/IFC,
raster, GCP and annotation-class markers) are pickable. **Derivation:**
contract E2 extreme-member rule — the class's largest member breaks every
naive selection rule: micro-clicks would replace a built selection with
the whole scan (X1, user-intent correctness), and hover would restyle
hundreds of millions of points (X2 — interaction budget spent on a
cursor pass); dossier support: bare-point tap-select is flagged
thin-evidence and Perspective fills the role with the limit box and
Magnify instead (dossier §2.5, §2.7); the tree/RMB paths keep X5's
select/deselect pair intact for clouds. **Rejected:** clouds fully
click-selectable (the finding-1 blocker scenario); clouds unselectable in
the viewport entirely (breaks RMB targeting and menu parity); per-point
selection semantics (a segmentation-domain concern, not entity
selection). **Tunable:** no.

**UIP-D16 — Ambiguity is visible: candidate indicator plus menu list**
(new per review finding 8). **Decision:** while a pick candidate set is
live, the status bar shows "N of M under cursor — Up/Down cycles"
(sentence-case, truncating entity names away; copy in §7.8); Up/Down
move the selection through the kernel's stable candidate order; the entity
context menu offers "Select under cursor ▸" listing the same candidates by
name and kind. The indicator clears when the set invalidates (camera move,
new click, tool cancel, permission/overlay/kind-filter change, render generation
change, device loss, focus leaving the viewport, or Escape). Tab/Shift+Tab never
changes candidates or selection; when a coordinate tool is armed it enters and
traverses the construction bar, and otherwise it performs normal focus traversal.
When a numeric field owns focus and no candidate indicator is live, Up/Down keeps
the field's ordinary step/list behavior. **Derivation:** C1, X7,
DESIGN-SYSTEM "Discoverability and
contextual access" (keyboard shortcuts are additional paths, not
replacements for visible UI — the bare key cycle violated it); X4 — the
reference resolves ambiguity with a visible list (dossier §2.5 [S9]);
mapping it onto SB + menu keeps the pointer flow modeless. **Rejected:**
invisible candidate cycling (finding 8); a modal disambiguation dialog
(interrupts the click flow the reference's tap-list tolerates only on
touch). **Tunable:** indicator copy length (X6).

**UIP-D17 — Multi-select properties: shared set, mixed markers,
assign-to-all** (new per review finding 5). **Decision:** with N > 1
selected, the Properties tab header shows the count; the body shows the
property set shared by the selected entity types; properties whose values
differ show a "Mixed" marker instead of a value; committing a value into
any field — including a mixed one — assigns it to every selected entity as
one journaled step. Type-disjoint selections show the shared-nothing state
with the count and per-kind breakdown. **Derivation:** X4 — Revit's
multi-select property editing: shared parameters shown, "Multiple
Categories/Families/Types Selected", an edit pushes to the whole selection
(`dossiers/revit.md` §W3 [S28][S29]); C2's mixed-property question asked
on the platform's own surface (finding 5); one journaled step per commit
follows VB-D2's granularity class. **Rejected:** first-entity-wins display
(silently lies about the rest); disabling editing on mixed values (Revit
precedent supports push-to-all, and it is the workflow's point).
**Tunable:** no.

**UIP-D18 — Selection lifecycle: prune on delete, survive hide, switch with the
project stream** (revised by batch 2). **Decision:** entity deletion —
from any surface, automation, or undo/redo journal replay — prunes the
entity from the selection set at journal-apply time; re-creating an entity
(e.g. undo of a delete) does not restore membership. Hiding never mutates
the selection (the set is explicit user intent; P4 scopes geometric acts,
not set persistence — §3.4 E2). Project replacement and project close
atomically store then unload the active in-memory set; opening another project
loads its own validated set/history, and reopening the first rehydrates its
stream under FP-D21. **Derivation:** X1 — a selection containing a deleted
entity id is a dangling reference that every "on selection" command would
trip over; pruning at journal-apply covers all writers in one place
(SYSTEM-001 single-owner lesson); P4 for the gesture/act scoping;
project switching follows from the set being project-scoped local state
(UIP-D3/UIP-D23). **Rejected:** resurrect-on-document-undo (the set is not
journaled — UIP-D3 — so replay must not write it); deselect-on-hide (the
review resolution and the tree's shipped behavior keep hidden entities
selected and inspectable, `App.tsx:536–557` mutates visibility without
touching selection). **Tunable:** no.

## 5. Current implementation delta

**Exists and stays:** the layout store's shape, clamps, and functional
adjusters (`useLayoutStore.ts`); AppShell/void composition and collapse
system; island drag mechanics, clamping, focus trap, double-click recenter
(`FloatingTaskIsland.tsx`); kernel pick with stable candidate order
(`crates/himmelcad-render/src/picking.rs:398–436`), the obsolete Tab binding
(`KernelNavigationController.ts:460–465`) to be removed/rebound to Up/Down,
settle-pick, orbit-around-pick;
`setEntityInteractionState` with device-loss replay; tree selection
modifiers and hide-keeps-selection behavior (`App.tsx:536–557`); console
progressKey in-place rows; import cancel and background mechanics; token
system and theme classes.

**Changes:** `IslandTabs` gains per-item close (UIP-D7); the `contextmenu`
suppression becomes drag-conditional and the controller emits a
context-surface event with pick payload (UIP-D5); the controller (or its
host) emits click-select events under the UIP-D1 threshold, filtered by
UIP-D15 pickability; the EntityTree menu is regenerated from the command
registry (UIP-D6); `FloatingTaskIsland` moves into `@himmelcad/ui` as the
dockable island, loses the global Escape listener, gains
header/raise/persistence (UIP-D8); the App's selection `useState`
(`App.tsx:70`) becomes the shared selection store with UIP-D18 lifecycle
hooks that tree, viewport, automation, and status bar consume;
`view.state.set` selection routes through it; the static "Registering
import…" status item is replaced by the jobs chip (UIP-D10); queued import
paths (`App.tsx:421,881`) become registered needs-input jobs; Electron
main persists window bounds and hosts the job registry (UIP-D9/D10).
The controller stops consuming Tab, consumes Up/Down only while its candidate
indicator is live, and exposes gesture-neutral **stable candidate order** wording;
the interface-intent comment at `WgpuKernelViewer.ts:3149–3152` is not execution
evidence and is renamed accordingly. Executing ordering evidence remains the Rust
sort/dedup plus the TypeScript consumption path cited above.

**New:** detach/re-dock plumbing between FunctionPanel and islands, with
`ui.panel.detach`/`ui.island.redock`; layout persistence bridge +
`ui.layout.reset`/`ui.layout.get` + console command; `select.*` automation
commands and console command; hover/selected highlight wiring incl. cloud
bounding-box treatment (UIP-D15); candidate indicator + menu list
(UIP-D16); multi-select Properties model (UIP-D17); entity context menu +
quick surface hosts; main-process job registry, renderer mirror, chip,
jobs island, toasts; the eight missing shared components plus `ProgressBar`
promotion and the z-layer token scale (UIP-D12); the platform Escape
ladder dispatcher (UIP-D14).

### Disposition — spec review (2026-09-01, findings 1–16)

| #   | Finding                                        | Disposition                                                                                                                                                        |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Selection model undefined for the point cloud  | UIP-D15 (not click-selectable/hoverable, void-like clicks, bbox treatment, RMB/tree paths); UIP-D4 revised; §2.2, §3.4 E2 extremes; G-UIP-1 giant-cloud scene (§6) |
| 2   | Escape ladder closes workspace islands         | UIP-D14 revised: only detached function islands are rungs; Specs/Plan/Agent close via x/toggle; Properties never a rung; §2.1                                      |
| 3   | Detach vs DESIGN-SYSTEM docked rule            | DESIGN-SYSTEM amended by the orchestrator; cited in §2.1/§3.1 B3/UIP-D8 (docked default, remembered detach, identical viewport interactions); §7.7 diff criterion  |
| 4   | Renderer-owned job registry orphans jobs       | UIP-D10 revised: main-process registry of record, renderer mirror + rehydrate; reload test in §6; SYSTEM-001 cited                                                 |
| 5   | Multi-select mixed properties unanswered       | UIP-D17 (shared set, Mixed markers, count header, assign-to-all, revit.md §W3); §2.2, §3.4 C2; component test in §6                                                |
| 6   | Selection after delete/hide/replace            | UIP-D18 (prune on journal apply incl. undo/redo, hide keeps, replace clears); §3.4 C4/E2; tests in §6                                                              |
| 7   | Click-again-deselect ports touch to desktop    | UIP-D2 revised: mouse idempotent, touch tap-again kept; double-click-on-entity reserved (§3.6); dossier-disposition row marks the rejection                        |
| 8   | Candidate cycling invisible                    | UIP-D16 (Up/Down only, SB indicator, menu candidate list); catalog row updated; §7.8 criterion; the later batch-2 review supersedes the former Tab wording         |
| 9   | Escape rung deletes free-text input            | UIP-D14 rung 1 scoped to commit/revert fields; free text never discarded; §3.2 E2 extremes; test in §6                                                             |
| 10  | A2 overreach ("single-surface", "single-task") | §3.1 A2 and §3.5 A2 reworded to the dossier-supported checked absences (fixed UI areas §2.1; no job-list UI in §2)                                                 |
| 11  | Paste-in-place has no owning spec              | cut from quick surface; queue note in §1/§2.3/UIP-D13 — joins via registry when an editing spec owns the clipboard                                                 |
| 12  | Viewing-box bake job claim vs its §1.3         | kept, now referencing viewing-box §1.3 as amended by its author (bake continues on close, registers as job) — coordinated cross-spec fix                           |
| 13  | Imports 2 and 3 birth state                    | §2.4: all drops register immediately as needs-input jobs; island advances; UIP-D10                                                                                 |
| 14  | Detach/re-dock absent from automation          | `ui.panel.detach`/`ui.island.redock` added (catalog, §3.1 B1, UIP-D8); only pixel placement stays read-only                                                        |
| 15  | E1 criteria theme coverage + docked-diff       | §7 criteria 2/5/6 now explicitly both themes; new §7.7 docked-vs-detached diff criterion                                                                           |
| 16  | Jobs "apply to similar" idea                   | queued to the file-project spec (§1 note, §3.5 A3)                                                                                                                 |

## 6. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** `@himmelcad/ui` component tests — Menu keyboard navigation,
  Escape/outside-click close, focus return; NumberInput commit on
  Enter/blur, Escape revert, close-mid-edit discards (DESIGN-SYSTEM rule);
  free-text inputs: Escape leaves content intact (UIP-D14); Toast queue
  and dismiss; IslandTabs close affordance calls `closeFunction`;
  Properties tab has no close and receives fallback on last-function close
  (UIP-D7); layout store round-trip serialize/deserialize, corrupt payload
  → defaults, reset affects exactly the UIP-D9 scope and exempts
  preferences (extends `packages/@himmelcad/ui/test/useLayoutStore.test.ts`);
  selection store semantics — replace/toggle/mouse-idempotent-reclick/
  touch-tap-again/clear, prune-on-delete incl. undo/redo replay,
  hide-keeps, replace-clears (UIP-D2/D18); Properties multi-select — shared
  set, Mixed marker, assign-to-all as one journaled step (UIP-D17); job
  registry — register (incl. needs-input at drop), progress mapping from
  `parseSidecarProgress`, cancel routing, mirror rehydration from a fresh
  mount (UIP-D10).
- **push (risk-triggered by viewer/viewport paths):** browser interaction
  tests — LMB sub-threshold click selects a pickable entity, ≥ threshold
  orbits with no selection change; clicks on bare cloud points behave as
  void (single inert, double clears) and never select the cloud (UIP-D15);
  RMB click opens menu (entity and cloud targeting), RMB drag pans with
  menu suppressed; ctrl+click toggles; clicks on ribbon/panel/status
  chrome never change selection (owner rule, UIP-D2); Up/Down moves selection
  through candidates only while the SB indicator is live and the indicator
  clears on every UIP-D16 invalidation; Tab/Shift+Tab traverses ordinary focus
  or the armed construction bar without changing selection/candidate index;
  Up/Down in a focused numeric field with no live indicator retains ordinary
  field behavior; full Escape ladder one rung per press —
  including: free-text content intact, Agent/Specs/Plan islands untouched,
  no island recenter; detach → island → re-dock preserves function state
  and viewport interaction identity (scripted identical interaction
  sequence in both hosts); island raise-on-focus order; renderer reload
  mid-job (mocked main-process registry): chip, progress, and cancel
  reappear (UIP-D10); hidden/clipped entities not click-selectable (P4,
  with viewing-box VB-D13 test).
- **push (risk-triggered) / release (always), capability `browser-gpu`:**
  gate **G-UIP-1** — scripted pointer-move burst over a scene whose entity
  under the cursor is a giant point cloud with hover enabled: p95 frame
  interval ≤ 2× target frame time (VB-D7 class), zero hover restyle events
  on the cloud (UIP-D15), and zero picks issued while the camera is
  unsettled; gate **G-UIP-2** — island drag and splitter drag bursts, same
  p95 bound; click→highlight latency sampled ≤ 150 ms p95 (UIP-D4 budget,
  tunable).
- **release, capability `real-data`:** three concurrent real imports —
  all three register at drop, chip count, per-job progress from real
  sidecar lines, one cancelled mid-run publishes nothing partial and the
  other two commit; renderer reload mid-import against the real main
  process reproduces chip and working cancel.
- **automation:** SDK parity — `select.set/add/remove/clear/get`,
  `jobs.list`/`jobs.cancel`, `ui.layout.reset`/`ui.layout.get`,
  `ui.function.open/close`, `ui.panel.detach`/`ui.island.redock` callable;
  `view.state.set` selection and `select.set` observe each other;
  `select.set` on a nonexistent id fails whole (runs with the deduplicated
  SDK gate).
- **manual/visual:** screenshots (both themes) of selection + hover
  highlight (incl. cloud bounding-box treatment), entity menu, quick
  surface, jobs island, toast, detached island, SB candidate indicator —
  compared against §7 at implementation review.

Explicitly unverified: subjective menu/toast feel beyond the
bounded-instant budget; multi-monitor island clamp edge cases
(manual-review-only); cross-product adoption of the shared island by
PhotoLab (tracked there, not gated here); touch tap-again behavior on real
touch hardware (pointer-emulated in tests, manual on hardware).

## 7. E1 — visual and behavioral criteria (failable)

Grounded in `docs/DESIGN-SYSTEM.md` and `theme/src/tokens.css:2–10`; each
criterion is pass/fail against a screenshot or scripted state sample; every
screenshot criterion is captured in **both themes**.

1. **Geometry selection:** selected viewport geometry follows the batch-2
   class matrix in §7.1: semantic orange plus an arrow/square/anchor/dash/
   outline cue, never UI accent blue and never a fill wash. A selected point
   cloud uses only its haloed orange bounding-box outline, with zero per-point
   restyle (UIP-D15). Hover is neutral and visibly distinct. The exact
   token/value table and dense-cloud/raster/dark-light contrast oracle below
   are part of this in-repo written E1 artifact.
2. **Menus (both themes):** entity menu and quick surface render as
   dark-island surfaces using only `--hc-*` tokens (no hardcoded hex —
   grep the modules); sentence-case labels; destructive entries carry the
   consequence in their label ("Remove from project…"); open within one
   frame of pointerup in the scripted test; never clipped by the window
   (clamped like the tree menu, `EntityTree.tsx:222–227`).
3. **Tabs and x:** the tab close affordance is visible on hover/active at
   most, never adds a permanent second row, and hits at ≥ 16 px target;
   the Properties tab shows no close affordance; the active tab remains
   the neutral/accent pattern already shipped by `IslandTabs` — no new tab
   chrome.
4. **Islands:** detached island shows title + drag handle + re-dock + x in
   one slim header; dragging never detaches the cursor from the header;
   the island can never be dragged to an unreachable position (clamp
   sample); focused island renders above all non-modal islands (z-order
   sample).
5. **Jobs chip and island (both themes):** the chip appears only while
   jobs exist and only after the debounce (no flicker for sub-perception
   jobs); shows real fraction (assert the rendered fraction equals the
   last `progressKey` event, never an animated fake); job rows show label,
   phase message, progress, cancel; a needs-input job is visually
   distinct.
6. **Toasts (both themes):** appear in one consistent corner, never
   overlap the status bar or steal focus; failure toasts name what failed
   and what remains safe (copy check), and link to the console entry.
7. **Docked vs detached:** screenshots of the same function docked and
   detached diff only in host chrome (panel header vs island header);
   the function content region is pixel-identical at equal size, and a
   scripted viewport interaction sequence produces identical results in
   both hosts (B3/finding 3).
8. **Candidate indicator:** while a candidate set is live the status bar
   shows "N of M under cursor — Up/Down cycles" (exact copy class; sentence
   case; no entity-name truncation artifacts); it disappears on camera
   move, new click, and Escape.

### 7.1 Batch-2 geometry visual artifact

This subsection is the committed written comparison artifact permitted by E1;
it is detailed enough for screenshot and pixel-sample failure. The tokens are
required additions to `@himmelcad/theme` (they do not exist in the current
`tokens.css`, so implementation remains missing). Values are X6-tunable only
after the named visual gate proves an equal-or-better result.

| Token                          | Dark      | Light     | Required use                                                  |
| ------------------------------ | --------- | --------- | ------------------------------------------------------------- |
| `--hc-geometry-selection`      | `#ff9f1c` | `#c65d00` | selected/active geometry foreground                           |
| `--hc-geometry-selection-halo` | `#101114` | `#ffffff` | 2 px contrast under-stroke around the 1–2 px selection stroke |
| `--hc-geometry-support`        | `#43b9ff` | `#006fae` | support points/lines only                                     |
| `--hc-geometry-support-halo`   | `#101114` | `#ffffff` | support contrast under-stroke                                 |
| `--hc-geometry-hover`          | `#f0f1f3` | `#2f333a` | neutral hover elevation/outline, never selection              |
| `--hc-geometry-active-preview` | `#ffd166` | `#7a5200` | uncommitted construction preview, always dashed               |
| `--hc-geometry-reticle`        | `#f0f1f3` | `#0f1115` | reticle body; active handle uses selection token              |
| `--hc-geometry-prohibited`     | `#f75464` | `#d63b4a` | invalid claimed input, paired with prohibited glyph           |

| Geometry class/state | Screenshot oracle and non-color cue                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Directed curve       | selected/active stroke is orange with arrowheads at ends and every 96 px; reverse direction reverses arrows                     |
| Point                | stable 9 px screen-space orange square with halo; the underlying glyph remains legible                                          |
| Symbol-bearing point | only its referenced anchor gets the square/halo; symbol fill is unchanged                                                       |
| Area/polygon         | orange haloed boundary plus corner ticks; no area fill tint                                                                     |
| Surface or solid     | orange silhouette and admitted boundary edges; no translucent surface wash                                                      |
| BIM body             | whole-body silhouette; an eligible subcomponent uses only its stable semantic edge/anchor/face boundary from BS-D23             |
| Raster               | orange frame and corner ticks; image pixels are never recolored                                                                 |
| Cloud/splat          | orange haloed bounding box only; no point hover/selection restyle                                                               |
| Support geometry     | blue dashed line or blue point circle with halo; selected support adds orange anchor/outline without removing the blue role cue |
| Hover                | neutral outline/elevation only; never arrow/square orange unless already selected                                               |
| Active construction  | orange committed-side geometry and dashed yellow preview; proposed and committed geometry cannot look identical                 |
| Reference            | ordinary render style plus tree/reference badge; it may show selection cues but never edit handles                              |
| Inert/disabled       | ordinary or subdued render style plus inert/prohibited cue; no pick, snap, selection, or edit response                          |
| Hidden               | no render/pick/snap/measurement candidate; selected membership may remain in the tree                                           |

The screenshot set contains both themes over (a) dense multicolor cloud, (b)
dark and light CAD/BIM geometry, and (c) a high-contrast raster. Pixel sampling
must show the exact token foreground and halo pair on every background; shape
recognition is checked in a desaturated copy. Access blue is deliberately not
adopted: the orange family is owner taste under DESIGN-SYSTEM, while Access's
blue and stakeout-only arrows are cited accurately in §3.4 A2.

## 8. Owner-decision items

None. Candidates tested against the escalation protocol and dissolved in
writing:

- _"May the viewport RMB open menus when it currently pans?"_ — closed by
  X4 (dossier §2.5 tap-hold precedent) plus the UIP-D1/VB-D5 threshold
  class; no axiom conflict since pan drags are untouched.
- _"Is selection undoable?"_ — closed by X3's justified view-local
  exception plus X4 (no reference journals selection); UIP-D3.
- _"Where does layout state persist?"_ — closed by §10b's explicit
  user-level list, which is repo-resident evidence
  (`BUILDER-MVP-PLAN.md:436–447`); UIP-D9.
- _"Does click-on-void deselect?"_ — closed by X4 (dossier double-tap
  pattern) and the owner's outside-click rule recorded in UIP-D2; the
  single remaining degree of freedom (inert single void click) derives
  from micro-orbit protection, X1.
- _"Are point clouds click-selectable?"_ — closed by the contract's
  extreme-member rule plus X1/X2 and the dossier's own thin-evidence flag
  (§2.5); UIP-D15 (review finding 1 dissolved without escalation).
- _"May Escape close the Agent island?"_ — closed by X1 (workspace
  teardown as data-loss-adjacent surprise) and the island-class extremes;
  UIP-D14 (review finding 2 dissolved).
- _"Who owns the job registry?"_ — closed by SYSTEM-001 lifecycle
  ownership; UIP-D10 (review finding 4 dissolved).
- _"Which components may we add to `@himmelcad/ui`?"_ — closed by
  DESIGN-SYSTEM "Shared controls" rules 1–4; UIP-D12 only sequences them.

All decisions in §4 derive from X1–X5 axioms, X6 delegation, precedent P4,
the design system (including its 2026-09-01 docked-default amendment), §10b
evidence, the trimble-perspective and revit dossiers, SYSTEM-001, and one
recorded owner statement; no genuine conflict, scope boundary, or reserved
question remains. All sixteen review findings resolved without an owner
question.

## Cross-spec reconciliation 2026-09-02

| Item                 | Disposition                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan window          | UIP-D9/UIP-D14 cite PE-D1: Plan is a dedicated OS window whose state persists and which Escape never closes.                                                                                                     |
| Clipboard            | UIP-D13 activates Select/Edit's `edit.clipboard.paste_in_place` quick-surface contribution.                                                                                                                      |
| Import               | Apply-to-similar routes to IF-D2's `import.apply_to_similar`; UIP-D10/UIP-D11 retain job/cancel ownership.                                                                                                       |
| BIM D6               | Specification shortcuts and Generate are registered detachable-function consumers; F9 focuses shortcuts and number slots remain absent.                                                                          |
| Doctrine P11         | UIP-D6 consumes the one generated command table verbatim for contextual UI, console, automation, and SDK exposure; raw-RPC allowlists and trust-response surfaces remain excluded.                               |
| P10/G12 surfaces     | MT-D25 owns the common recipe state/actions; UI Platform renders registry-fed Properties/context/job access only and makes no competing physical-record or command guarantee.                                    |
| Semantic cursor      | UIP-D24/§9.7 owns the one precedence resolver; every Builder owning spec now cites its exact subset or explicit `n/a`.                                                                                           |
| GAP §6 Civil inbound | UIP-D14/UIP-D16/UIP-D18, amended by UIP-D20/UIP-D22/UIP-D24, cite CIV-D1/CIV-D15/CIV-D16 for Escape, Tab/Up-Down, P9, reticle, and Civil cursor consumption.                                                     |
| Re-walk 2026-09-02   | P5: layout/continuous state persists debounced off the interaction path. P6: Escape/right-click/double-click remain honest. Current D1/X3/B1/A2 and P7 are satisfied; UI Platform mandates no office convention. |

## 9. Owner statements batch 2 — revised after adversarial review 2026-09-02

This section is normative and amends §2.2, §3.4, §3.6, §5–§7 and
UIP-D3/D4/D8/D12/D15/D16/D18. Earlier review dispositions remain standing
except where this section explicitly replaces stale Tab, selection-visual, or
selection-persistence wording.

### 9.1 Batch-specific A2 dispositions

Trimble Access has three project-data states, not four: Selectable, Visible,
and Off. It selects map geometry in blue; direction arrows are stakeout-only;
and it documents neither a universal selected-point square nor arbitrary
Ctrl/Shift multi-row state application (`dossiers/trimble-perspective.md` §7
[A15–A22]). We adopt its hierarchical cycling, parent propagation, explicit
nonselectable-visible state, and two distinguishable Mixed summaries. We adapt
Selectable → Reference, Visible → Inert, and Off → Hidden as behavioral
approximations only: Access does not establish snapping/edit behavior for
Visible. Editable and the stronger no-select/no-snap/no-edit Inert semantics are
capability-bound Himmel:CAD extensions. Arbitrary multi-row apply is also native.
Access blue is deliberately rejected for the
owner's orange viewport-geometry language; stakeout arrows are generalized to
all directed selected/active curves. The stable orange point square is our
non-color cue, not a claimed Access precedent. §3.4 and §7.1 carry the exact
dispositions and visual oracle.

RealWorks supports constrained coordinate picks, typed point positions, oriented
UCS frames, cloud smart-picks, and point construction. Its closest manipulator is
a translation-only flat-target gizmo; the reviewed evidence contains no single
generic point reticle that both translates and rotates
(`dossiers/realworks.md` §8.1–§8.2 [P1–P3]). `Shared3DTarget` therefore adopts
the constrained/oriented/smart-pick inputs but is an owner-requested
Himmel:CAD-native synthesis. This researched absence is the reason for the
deviation, not an unresearched attribution.

### 9.2 Persistent strip, compact behavior, and reachability

The viewport bottom strip always remains present. In its full form it contains
**Support**, **Whole / Segments**, **3D / 2.5D / 2D**, **Selectable kinds**,
**Labels**, and explicitly named **Document**, **Selection**, **Display**, and
**Camera** history menus. View owns mode, overlays, display, and camera state;
Select/Edit owns selection modes, selection history, and effective permission;
File owns the document journal/persistence; UI Platform owns only their shared
controls and invokes the canonical commands in §1.1.

At the compact breakpoint labels collapse to tokenized icons/chips and controls
may enter one explicit overflow. The strip itself, plus either a direct chip or a
distinct trigger badge for every active non-default mode/suppression/filter,
remain visible at all widths. The trigger uses separate badges for Support
hidden, Labels hidden, Segments, each kind-filter restriction, and nondefault
view mode, plus an accessible combined summary.
Mode-changing items remain keyboard reachable and have a tooltip/accessible
label. Minimum-width screenshots at 100% and 150% scale cover default and
all-non-default states. Breakpoints are X6 tunables; hidden mode state is not.

The following is the B1 reachability matrix for every batch-2 row. `—` means
deliberately absent for the stated reason, not unspecified.

| Act                           | Ribbon / strip                         | Viewport or entity context                 | Properties                                       | Console                                           | Agent                         | Python                        | Keyboard                                              |
| ----------------------------- | -------------------------------------- | ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------- | ----------------------------- | ----------------------------- | ----------------------------------------------------- |
| Support overlay               | View ribbon + persistent strip         | — global display overlay                   | — no per-entity mutation                         | get/set                                           | get/set                       | get/set                       | strip traversal only; no global shortcut              |
| Global Labels                 | View ribbon + persistent strip         | — global display overlay                   | — per-entity policy is separate                  | get/set                                           | get/set                       | get/set                       | strip traversal only                                  |
| Per-entity labels             | — contextual act                       | entity context entry                       | editable field                                   | get/set                                           | get/set                       | get/set                       | normal Properties traversal                           |
| View mode                     | existing View ribbon + strip           | — not entity-specific                      | read-only current mode where relevant            | existing get/set                                  | get/set                       | get/set                       | existing View binding; disabled meanings explained    |
| Whole/Segments                | Selection ribbon/menu + strip          | — mode is visibly global                   | read-only mirror where an edit consumes segments | get/set                                           | get/set                       | get/set                       | strip traversal only; Tab never changes mode          |
| Selectable kinds              | Selection ribbon/menu + strip popover  | — global candidate filter                  | — not an entity property                         | get/set                                           | get/set                       | get/set                       | popover traversal; no hidden shortcut                 |
| Document history              | existing quick/ribbon + strip menu     | — domain-wide journal                      | — history surface is global                      | get/undo/redo                                     | get/undo/redo                 | get/undo/redo                 | Ctrl+Z / Ctrl+Shift+Z only                            |
| Selection history             | strip menu; no ribbon duplicate        | — selection-local                          | — history surface is global                      | get/undo/redo/clear                               | same                          | same                          | menu traversal only; never Ctrl+Z                     |
| Display history               | strip menu; no ribbon duplicate        | — view-local                               | — history surface is global                      | get/undo/redo/clear                               | same                          | same                          | menu traversal only; never Ctrl+Z                     |
| Camera history                | strip menu; no ribbon duplicate        | — view-local                               | — history surface is global                      | get/undo/redo/clear                               | same                          | same                          | menu traversal only; never Ctrl+Z                     |
| Effective-state explain       | left tree control; no ribbon duplicate | entity context links to explanation        | full cause/capability list                       | explain                                           | explain                       | explain                       | tree/Properties traversal                             |
| Requested-state preview/apply | left tree control; no ribbon duplicate | selected-node context entry                | current-set preview/apply                        | preview/apply                                     | preview/apply                 | preview/apply                 | control traversal; Enter applies only a valid preview |
| Shared 3D target              | owning tool's ribbon/panel entry       | owning tool context entry where meaningful | owning tool transform fields                     | owning preview/commit command, no reticle wrapper | typed transform through owner | typed transform through owner | §9.5; Tab fields, Up/Down live candidates             |
| Semantic cursor               | automatic; no command button           | automatic state; accessible description    | — not editable state                             | `ui.cursor.describe` read only                    | describe                      | describe                      | no cursor-state mutation shortcut                     |

There is no trust-surface asymmetry for these acts. The reticle and cursor are
presentation/input components rather than alternate command stores; automation
provides typed owner-command parameters instead of simulating pointer motion.

### 9.3 Permission ceiling and orthogonal overlays

The four requested node values are **Hidden**, **Reference**, **Editable**, and
**Inert**. The effective value is a permission ceiling, not a promise that every
entity can render, snap, select, or edit in every nominal state. Select/Edit
SE-D19 is the sole resolver and command-layer recheck. Its inputs are entity,
ancestors, layer, taxonomy kind/class, cloud class, and attached-project
requested state; session isolate may additionally impose Hidden. Restrictiveness
is `Hidden > Inert > Reference > Editable`. The query returns the requested
value, effective ceiling, adapter capabilities, every cause, and unsupported
transition reasons. Mixed is a grey parent presentation of heterogeneous
children, never a fifth writable value; the two Access-like summaries
"some hidden" and "some nonselectable" remain distinct in its cause text.
Ctrl+click and Shift+click form an arbitrary node set as a native Builder
extension. Ctrl+A targets the disclosed focused taxonomy set, not merely the
currently rendered virtual page; preview names that scope and its exact digest
before Apply.

Capabilities intersect that ceiling:

| Entity extreme                        | Hidden                 | Inert                  | Reference                                                                | Editable request                                                     |
| ------------------------------------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Ordinary CAD/mesh with exact adapters | no render/candidate    | render only            | render/select/exact-snap, no edit                                        | adapter-supported edit/select/exact-snap                             |
| Attached project                      | no render/candidate    | render only            | maximum effective state; exact providers only                            | unsupported; preview/apply rejects                                   |
| Raster image                          | no render/candidate    | render only            | render/select, but no geometric snap because RA-D3 exposes none          | only adapter-supported placement/style edits; still no pixel snap    |
| Point cloud                           | no render/candidate    | render only            | entity select through deliberate paths; snap only from exact PC provider | adapter-supported cloud edits; no per-point entity-selection promise |
| 100,000-child parent                  | all children evaluated | all children evaluated | each child's real capabilities intersect                                 | any unsupported child rejects the whole apply with counts/reasons    |

`Reference is snappable` therefore means only that permission does not prohibit
snapping; a registered exact snap provider must still exist. A requested parent
change never skips or silently weakens an unsupported member. Preview captures
the taxonomy generation, membership digest, per-node requested/effective revision,
and capability versions. Apply uses those values as CAS preconditions and either
publishes every requested-state change or none. Canonical edit, import, delete,
attachment re-sync, taxonomy membership change, or adapter-version change makes
the preview stale and requires a new preview.

Global Support and Labels, per-entity label policy, and selectable-kind filtering
are orthogonal to P9:

- Support is a display overlay over an explicit Draw support role. Hiding it
  suppresses the support render pass and, by P4, removes that hidden support
  geometry from pick/snap/measurement candidates without changing its role or P9
  permission.
- Global Labels suppresses only the label/annotation render pass. It never changes
  geometry render, permission, snapping, selection membership, or per-entity label
  policy.
- Per-entity label policy is canonical document state. Global Labels is a
  nondestructive display ceiling above it.
- Selectable kinds removes only selection candidates. It never changes render,
  snap, measurement, editing, geometry, or P9 permission. A tool that needs a
  topological/entity input declares its own admitted kinds rather than borrowing
  this selection filter.

### 9.4 Four affected-state histories

The affected-state sets are exact and mutually exclusive:

| History   | Records                                                                                                         | Explicitly does not record                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Document  | canonical entity commands, including support-role changes and per-entity label policy                           | selection, P9 requested display/permission state, overlays, view mode/projection/camera |
| Selection | set membership, Whole/Segments, selectable-kind filter, segment tokens/remap/prune disclosures                  | entity edits, visibility/permission, labels overlay, camera                             |
| Display   | requested P9 permission/display changes, isolate, global Support/Labels, and other view visibility presentation | canonical support roles/per-entity label policy, selection, camera                      |
| Camera    | camera pose and pivot, projection, and 3D/2.5D/2D mode                                                          | display, selection, canonical entities                                                  |

Ctrl+Z/Ctrl+Shift+Z always traverses Document. Each local stream exposes the
named `get/undo/redo/clear` API and visible menu in §1.1; invoking one stream
never triggers another. A continuous gesture contributes exactly one entry at
gesture end (P5). Repeated wheel/orbit or toggle actions may coalesce only while
the same stream, target set, and gesture session remain open. Undo followed by a
new action truncates only that stream's redo branch. `clear` removes history
entries without changing the current state and is itself not recorded.

FP-D21 is authoritative for storage: current state plus Selection, Display, and
Camera histories persist per project in versioned ViewState/local-state streams.
Project close/replacement clears active in-memory streams; reopening rehydrates
that project's streams after entity/revision validation. App restart and crash
restore the last atomically acknowledged stream head. Corruption, unknown
incompatible version, or an invalid head resets only the named local stream to a
valid current-state baseline, preserves the other three histories, and records a
console explanation. Document-history recovery remains File-owned. Default local
depth is 256 entries per stream; wheel/orbit coalescing closes after 400 ms idle.
Both are X6 tunables, not semantic scope.

### 9.5 `Shared3DTarget` complete contract

`Shared3DTarget` is armed and owned through Draw point placement (DR-D17),
Viewing Box center/orientation (VB-D15), or View section-plane placement
(VD-D15). Only one owning tool may arm it. Its phases are `idle → armed →
candidate-live/field-edit/handle-drag → valid-preview | invalid → confirmed |
cancelled`. Arming snapshots owner id, project/taxonomy/render generations, and
the owner's admission policy. It creates no entity and journals nothing.

**Coordinate frame and typed twins.** Origin is stored as f64 project/world XYZ.
Orientation is stored as a normalized right-handed quaternion about the origin
pivot. The user chooses World, Local (the owner's current object/section frame),
or View-aligned axes; changing frame changes controls, not the world transform.
An unavailable Local frame is `Invalid`, never silently World. View-aligned axes
follow the settled camera only while no handle drag or field edit is active; an
active edit pins its basis, and subsequent camera motion changes the handles after
settle without changing the world transform.
Translation handles are X/Y/Z axes plus XY/YZ/ZX planes. Rotation rings rotate
about those frame axes. Typed fields expose absolute XYZ and frame-relative
ΔX/ΔY/ΔZ. Orientation exposes intrinsic Z-Y-X yaw/pitch/roll in that
order and an axis+angle editor backed by the same quaternion; editing either
updates every handle/field and avoids silently resolving an Euler singularity.
Fields use project linear/angular units and display precision while commands retain
f64/quaternion precision. Conflicting absolute/delta or Euler/axis-angle edits are
blocking errors until the user chooses one source; last-edited never wins silently.

**Acquisition/provenance.** The visible state is exactly one of:

- `Exact`: source entity/component id, source and placement revisions, exact snap
  provider/kind, and full-precision coordinate;
- `Estimated`: method, source ids/revisions, residual, confidence, and sample count;
- `Typed`: explicit user value and frame;
- `NoData`/`Invalid`: named missing coverage, conflict, stale generation, or
  capability reason.

An estimate is always badged **Estimated** and never becomes Exact merely because
it looks plausible. NoData cannot confirm. An owning domain may admit an Estimated
value only after an explicit user/automation option says so and the committed
provenance remains Estimated; otherwise the user must acquire Exact or type the
coordinate. This is the X1 boundary against inferred authority.

**Gesture arbitration against §3.6.** A sub-threshold LMB click off a handle asks
the owning domain to acquire/cycle the current candidate and updates preview; it
does not idle-select. LMB drag that begins on an axis handle translates along that
axis; on a plane handle it translates in that plane; on a rotation ring it rotates
about that ring's frame axis. Handle-origin drag owns pointer capture exclusively.
LMB drag beginning off any handle retains platform orbit (3D) or pan (plan).
RMB drag, MMB drag, and wheel retain platform pan/pan/zoom. RMB click routes the
owning tool menu; it never rotates/translates the target. A sub-threshold click on
a handle merely makes that axis/plane/ring the active typed constraint; it neither
changes the transform nor commits. Tab/Shift+Tab focuses and traverses origin,
delta, orientation, and owner fields without moving the pointer.
Up/Down cycles only while the shared candidate indicator is live. Printable input
focuses the matching construction-bar field and freezes pointer preview. Enter in
a field accepts that field into the preview; Enter with tool focus asks the owning
domain to confirm. The component cannot commit by itself.

Escape follows UIP-D14 with three relevant rungs: focused field revert, active
handle-drag revert, then armed-target/tool cancel. `pointercancel`, capture loss,
device loss, or owning-surface destruction during a drag equals drag revert and
leaves the target armed if the owner still exists. Owner close/project replacement
cancels. Keyboard confirmation marks the pointer sequence consumed so its trailing
pointer-up is ignored. Focus transfer keeps the valid preview but ends candidate
cycling; returning to the viewport requires a fresh candidate.

**Confirm/revalidation and consumers.** On confirm the owning command revalidates
once against pinned source/placement revisions, P9 capability, P4 visibility,
taxonomy generation, and exact-provider result. Any mismatch rejects without
publication and leaves a visibly stale/invalid preview. Draw consumes origin (and
orientation only when its point/symbol schema declares it) for one ordinary
`draw.point.create`; Viewing Box consumes origin/quaternion as box center/frame;
View consumes origin and local normal for a section plane. No consumer may treat a
reticle proposal as authority, fork gestures, or add a component-owned command.

### 9.6 Selection/reticle visual contract

§7.1 is the batch-2 in-repo visual artifact and exact token/class oracle. It
supersedes the former generic accent-outline criterion in UIP-D4/UIP-D15. The
semantic token family is absent from current `tokens.css`; implementation must add
it to `@himmelcad/theme` and pass both-theme/dense-cloud/raster pixel and
desaturation checks before this spec can be certified. BIM component manifests are
revisioned, paged, and LOD-bounded per BS-D23. No symbol flood, IFC-primitive
explosion, or point-cloud point restyle is allowed.

### 9.7 Cursor precedence and declaration matrix

Precedence at one pointer is deterministic: (1) **prohibited** for an invalid
claimed input; (2) active hittable **move/rotate/scale handle**; (3)
**Shared3DTarget** while target placement is armed and no handle is hit; (4) pick
crosshair plus at most one ranked endpoint/midpoint/intersection/cloud-point/
surface marker and Fangkreis for a valid candidate; (5) bounded-work **wait** only
over the surface whose input is blocked. Wait never replaces a still-available
navigation cursor. Cursor state invalidates on camera motion, tool cancel/close,
P9/overlay/kind/admission change, render/taxonomy revision, device loss, stale
candidate, or focus transfer. The next presented frame must show the recomputed
cursor or the neutral navigation cursor.

This is the platform's complete round-3 registry cursor matrix. `n/a` is explicit
inapplicability, not omission. Every Builder owner cites its applicable row in
its 2026-09-02 cross-spec reconciliation table; this remains the authoritative
platform matrix for certification.

| Armed tool/surface                           | Declared subset or `n/a`                                                                            | Notes                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Idle Builder viewport                        | pick crosshair + one snap marker/Fangkreis                                                          | no reticle/handle/wait without state                                                                  |
| Draw line/point/station-offset               | pick/snap/Fangkreis, Shared3DTarget, prohibited, wait                                               | DR-D17–D19; point owns commit                                                                         |
| Select/Edit fence/transform                  | pick, move/rotate/scale handles, prohibited, wait                                                   | SE-D19; no target unless an owning transform adapter requests it                                      |
| Measure/Inspect                              | pick/snap/Fangkreis, anchor/plane handle, prohibited, wait                                          | MI §7.2; point info remains passive                                                                   |
| View section/clip                            | pick/snap/Fangkreis, direction/plane handle, Shared3DTarget, prohibited, wait                       | VD-D15                                                                                                |
| Viewing Box                                  | move/rotate handles, Shared3DTarget, prohibited, wait                                               | VB-D15; no point creation                                                                             |
| Civil construction/profile                   | pick/snap/Fangkreis, Civil handle, Shared3DTarget where point/plane input applies, prohibited, wait | CIV §5.1; platform Tab/Up-Down                                                                        |
| Pointcloud fence/sample/reticle producer     | pick/snap/Fangkreis, Shared3DTarget when borrowed, prohibited, wait                                 | PC-D17/D18; producer never commits a Draw point                                                       |
| Raster georeference/crop                     | pick/snap only from non-raster exact providers, move/crop handle, prohibited, wait                  | RA-D3/D10; raster pixels never snap                                                                   |
| Mesh/Terrain main viewport or crop-in-window | pick/snap/Fangkreis, crop handle, prohibited, wait                                                  | dedicated window otherwise uses ordinary form cursor; no target by default                            |
| BIM component/generation pick                | pick/snap/Fangkreis, stable semantic handle, prohibited, wait                                       | BS-D23 manifest only                                                                                  |
| File/Attach placement                        | move/rotate handle, prohibited, wait                                                                | SE-D1 adapter; no Shared3DTarget                                                                      |
| Import registration                          | n/a to Builder armed viewport vocabulary                                                            | modal registration owns its documented 2D control cursors; still uses platform prohibited/wait tokens |
| Agent requested user pick                    | pick/snap/Fangkreis, Shared3DTarget when the owning domain requires it, prohibited, wait            | Agent cannot simulate or confirm the pointer gesture                                                  |
| Plan canvas                                  | n/a to 3D target/snap markers; move/scale/prohibited/wait tokens apply to paper objects             | dedicated 2D canvas, PE-D20/D21                                                                       |
| WeltView                                     | pick/snap presentation where read-only inspection supports it; prohibited/wait; no edit handles     | read-only product                                                                                     |
| PhotoLab                                     | n/a to Builder taxonomy/selection modes/reticle in current workflow                                 | shared cursor tokens still apply to future shared viewer surfaces                                     |
| Cap                                          | n/a to desktop Builder strip/reticle                                                                | field app keeps its documented touch contract                                                         |

### 9.8 Consumers, races, export, and recovery

Render, pick, snap, measure, tree/Properties, active tools, and automation read one
immutable, versioned effective snapshot containing P9 result/capabilities,
orthogonal overlays, selection modes, taxonomy generation, and relevant entity
revisions. They do not recompute different subsets independently.

| State/control  | Render passes                                                            | Pick/snap/measure                                                            | Active tools and selection                                                              | Tree/Properties/automation                         | Capture/export/sibling apps                                                        |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Hidden         | suppress point/splat, mesh/CAD, raster, BIM/component, annotation passes | no candidates; existing measurement row remains with hidden-cause disclosure | pinned candidate invalidates; membership survives but edits reject with all causes      | requested/effective/cause remain visible/queryable | view/Plan capture may omit as displayed; canonical export retains it               |
| Inert          | all applicable passes render                                             | no pick/snap/measure acquisition                                             | no new selection/edit; existing membership remains inspectable                          | inert cause and capability shown                   | capture honors display; canonical export retains                                   |
| Reference      | renders                                                                  | selection and exact capability-bound snap/measure only                       | no edit; prohibited cursor on edit claim                                                | cause names ceiling/provider absence               | attached/WeltView read-only behavior preserved; export retains canonical data/link |
| Editable       | renders                                                                  | only registered providers contribute                                         | adapter-supported edit; command rechecks snapshot                                       | full capability/reason query                       | export retains canonical state                                                     |
| Support hidden | only support role pass suppressed                                        | support removed from all P4 geometry acts                                    | armed support candidate invalidates; ordinary geometry unaffected                       | role/policy still shown                            | view capture hides it; canonical export retains role/geometry                      |
| Labels hidden  | only label pass suppressed                                               | geometry pick/snap/measure unchanged                                         | selection and edits unchanged                                                           | per-entity policy remains readable/editable        | view/Plan capture hides labels; canonical export retains label policy              |
| Whole/Segments | no render change except segment highlight                                | no snap/measure change                                                       | selection token is parent or `{parent_id,parent_revision,locator}`; edit consumes token | query exposes granularity/token status             | canonical export never splits geometry merely because Segments was active          |
| Kind filter    | no render change                                                         | removes selection candidates only                                            | active selection candidate invalidates; tool-specific input admission unchanged         | filter/history queryable                           | no export effect                                                                   |

Draw point/line, Select/Edit Move, Viewing Box, View Section, Civil construction,
Measure, Raster registration/crop, and BIM placement all follow the same rule: an
active tool pins candidate identity, source/placement revision, snapshot id, and
acquisition provenance. Any state change may update the visible preview on the
next frame, but commit revalidates against the current snapshot. If eligibility
disappears, the preview becomes **Unavailable — <all causes>** and commit rejects;
it never substitutes a neighbor. Segment tokens remap or prune only under SE-D19's
deterministic parent-revision rule. A simultaneous parent propagation, canonical
edit, import, delete, or attachment re-sync is resolved by the preview/apply CAS
contract in §9.3; no partial child state is visible even after crash.

View screenshots and Plan captures may intentionally honor the displayed snapshot
and must embed its id/settings as provenance. Canonical project export/archive may
not silently omit Hidden, Support-suppressed, label-suppressed, kind-filtered, or
unselected data; format-specific loss remains File/Import-owned and explicit.
WeltView consumes render/display snapshots but exposes no Editable command. PhotoLab
does not currently expose Builder taxonomies, histories, selection modes, or the
reticle, so those controls are inapplicable there; it must reuse semantic tokens if
a shared viewer surface gains them. Cap's touch workflow is likewise outside the
desktop strip. Unknown shared-state versions fail closed to Hidden with a visible
tree/console explanation and recovery action, never to an editable or inferred
state.

### 9.9 Performance and verification gates

`scripts/benchmark-builder-interaction-vocabulary.mjs` defines **G-UIP-3**, a
self-launching push (risk-triggered) and release (always) `browser-gpu` gate. It
drives target translation/rotation, segment/component highlight, candidate/cursor
changes, and camera coexistence over dense cloud, raster, CAD/mesh, and complex BIM
fixtures. Presented-frame-interval p95 must be ≤ 2× target frame time; cursor and
reticle response must appear by the next presented frame; committed coordinates
must contain zero stale snapshot/source revisions; component-manifest paging may
spend at most 4 ms main-thread time in one frame and 2,048 visible semantic entries
per page. Missing GPU capability fails the release route.

`scripts/benchmark-builder-interaction-tree.mjs` defines **G-UIP-4**, a
deterministic 100,000-node push/release gate. First cached page and Mixed summary
render in ≤ 100 ms p95; a state preview returns its first exact count/progress in
≤ 250 ms; UI-side additional peak memory is ≤ 128 MiB; no frame task exceeds
8 ms. An apply estimated to exceed 1 s is a UIP-D10 registered job, not "bounded
UI": time to first progress ≤ 250 ms, batches ≤ 50 ms, cancellation acknowledged
within 250 ms between batches, restart discards uncommitted staging and requires a
fresh preview, and atomic publication occurs only after final CAS. Failure,
cancellation, crash, or revision race publishes no child change. Values are X6
tunables; atomicity and exact counts are not.

Changed/component and browser tests additionally prove:

- four history affected-state sets, independent branch truncation/coalescing,
  clear-without-state-change, project switch/reopen/restart, and isolated corrupt
  stream recovery;
- every P9 precedence/capability pair including attachment, raster, cloud, and
  unsupported member in a 100,000-child apply;
- Support/Labels/kind-filter orthogonality across every consumer in §9.8;
- reticle frame conversion, translation planes/axes, rotation order/quaternion,
  exact/estimated/typed/NoData, field/drag Escape rungs, pointercancel, trailing
  pointer-up suppression, focus transfer, and confirm-time revalidation;
- Tab causes focus traversal and zero candidate/selection change; Up/Down cycles
  only with a live indicator and retains normal field behavior otherwise;
- every cursor-matrix row, precedence pair, and invalidation reason by stateful
  interaction assertions, not glyph screenshots alone;
- §7.1 both-theme/minimum-width/150% screenshots, exact token samples,
  desaturated non-color cues, and default/all-non-default compact-strip states;
- races against canonical edit/import/delete/attachment re-sync and crash at every
  staging/publication boundary.

The scripts are required additions (absent today), registered at push/release as
stated; a missing script or capability is a failure, not a skip. G-UIP-1/G-UIP-2
remain for inherited hover/island behavior.

### 9.10 Revised and new decision records

**UIP-D19 — The strip exposes domain-owned state without wrapping it.**
**Decision:** the persistent strip and four named history menus invoke the separate
canonical/query surfaces in §1.1/§9.2; compact mode always exposes every active
non-default state. UI Platform owns presentation only. **Derivation:** P8, X3,
X5, S3/G2/G4/G6, FP-D21, VD-D14, SE-D19, DESIGN-SYSTEM discoverability.
**Rejected:** four aggregate `ui.*` wrappers (duplicate stores/acts); temporal
mega-history; focus-sensitive Ctrl+Z; hiding active modes in an unlabeled overflow.
**Tunable:** compact breakpoint and local menu density only.

**UIP-D20 — P9 is a capability-bound permission ceiling.** **Decision:** the
four-state control, Mixed/cause presentation, all-or-none preview/apply, and
orthogonal-overlay rules are exactly §9.3. Select/Edit SE-D19 remains sole resolver
and command recheck; UI Platform owns no permission state. **Derivation:** P9's
node-state class sharpened by P4's visible-set rule, D5, X1, X3, X7, S5/G3/G4,
and SE-D19. **Rejected:** folding Labels, Support,
isolate, or selectable-kind filtering into one state; treating Reference snapping
as universal; silently weakening unsupported child transitions. **Tunable:** page
size and job threshold only.

**UIP-D21 — Geometry selection uses a semantic class adapter and committed
artifact.** **Decision:** §7.1's tokens and class matrix amend UIP-D4/UIP-D15;
selection/support is always paired with non-color cues, and component manifests
are stable/revisioned/LOD-bounded. Orange is owner taste; Access blue is not
adopted. **Derivation:** DESIGN-SYSTEM "Visual language", S2/G5, E1, X1, X2,
`trimble-perspective.md` §7 [A19–A22], BS-D23. **Rejected:** generic UI accent
outline for every geometry; symbol flood; universal point-shape or orange Access
claim; every IFC primitive/cloud point. **Tunable:** exact colors/arrow cadence/
screen sizes only after G-UIP-3/E1 evidence.

**UIP-D22 — One shared target proposes, owning domains authorize.** **Decision:**
the state machine, frames, typed twins, gestures, provenance, Escape lifecycle,
confirm revalidation, and consumer boundary in §9.5 define `Shared3DTarget`.
**Derivation:** C1, E2, UIP-D14, S4/G7, X1, X5, DESIGN-SYSTEM shared controls,
`realworks.md` §8 [P1–P3], DR-D17, VB-D15, VD-D15. **Rejected:** per-tool
reticles; a reticle-owned point command; off-handle drag capture; inferred exact
Z/orientation; representing an estimate as authority. **Tunable:** handle size,
Fangkreis radius, contrast, and animation timing.

**UIP-D23 — Four histories have disjoint affected-state and recovery scopes.**
**Decision:** the exact table/lifecycle in §9.4 governs recording, branch
truncation, coalescing, persistence, project replacement/reopen, crash, and
isolated corruption. **Derivation:** P8, C4, P5, X3, X5, FP-D21, VD-D14, SE-D19.
**Rejected:** "local history" without affected-state; clearing current state when
clearing history; losing local history on restart; one corrupt stream resetting all.
**Tunable:** depth 256 and 400 ms coalescing idle window.

**UIP-D24 — Cursor vocabulary has one precedence resolver.** **Decision:** §9.7
is the complete resolver/declaration matrix; tools declare subsets and never ship
local glyphs or precedence. **Derivation:** G11, E1/E2, X7, DESIGN-SYSTEM input
consistency, registry single-owner rule. **Rejected:** screenshot-only glyph tests;
per-tool cursor stacks; wait cursor blocking still-available navigation.
**Tunable:** glyph dimensions/animation, not precedence/invalidation.

**UIP-D25 — Shared interaction consumers read one versioned snapshot.**
**Decision:** §9.8's consumer effects, commit revalidation, CAS races, capture/
export boundary, and sibling-app applicability are mandatory. **Derivation:**
SYSTEM-001, P4, P5, P9, X1, E2, SE-D19, FP-D21. **Rejected:** passive consumers
independently interpreting flags; substituting a candidate after invalidation;
canonical export following temporary display suppression. **Tunable:** snapshot
cache/paging strategy only.

**UIP-D26 — Extreme interaction budgets are executable gates.** **Decision:**
G-UIP-3/G-UIP-4 and their push/release routing and budgets are required as in
§9.9; >1 s propagation is a registered atomic job. **Derivation:** D1, E3, P3,
X1, X2, X6, TEST-TIERS. **Rejected:** prose-only "paged/bounded/smooth" claims;
static glyph screenshots; long work disguised as bounded UI. **Tunable:** numeric
budgets, recorded here under X6; required scenarios/atomicity are not.

### 9.11 Zero-owner-question audit

No batch-2 question survives escalation. Permission versus overlays derives from
P9/P4/X1 and SE-D19; history scope from P8/C4/FP-D21; Tab from current C1/X7;
reticle arbitration/authority from C1/E2/X1/X5; reference deviations from X4 plus
the sourced dossiers and DESIGN-SYSTEM's owner-taste record; visual values and
budgets from X6/P3; consumer races from SYSTEM-001/P4; and compact visibility from
DESIGN-SYSTEM discoverability. None is an axiom conflict, product identity/scope/
money/licensing choice, or owner-reserved boundary. The recipe ambiguity in
§9.12 is not escalated: P10/X7 derive the answer and MT-D25 plus the four typed
owner records publish it.

### 9.12 Cross-spec cite-and-revise results (2026-09-02)

1. `REGISTRY.md` round 3: copy §1.1 one act per row; add Civil and P8–P10 to
   the audit basis; remove the old Civil deferral; add §3.6/§9.7 gesture and
   cursor matrices; normalize commands; rerun duplicate-act/surface/gesture/state
   checks and publish counts. Applied by the clean round-3 rebuild.
2. Tab round 3: replace Measure/Inspect §2.3 lines 189–190; REGISTRY shortcut/
   baseline/tool rows at lines 310, 374, 386, 391, and 397 (and its false clean
   verdict); `KernelNavigationController.ts:138,460–465`; the viewer test at
   `kernel-navigation-controller.test.ts:137`; `picking.rs:373–379,518`;
   `cad_curve.rs:63`; and `WgpuKernelViewer.ts:3149–3152`. All must use
   gesture-neutral **stable candidate order** and Up/Down for live cycling. The
   normative specs and Registry are aligned; the listed kernel/test changes
   remain implementation work. Tab/Shift+Tab remains focus/construction-bar traversal. Civil already records
   the spec-side request at CIV §10 item 9. Historical review/evidence files keep
   their quotations as history and are not normative claimants.
3. Mesh MT-D25, then Draw DR-D20, Civil CIV-D15, Raster RA-D15, and BIM BS-D24:
   revise "one recipe record/state machine" to one shared versioned **derived-
   recipe lifecycle protocol**. Every derived output has exactly one owning recipe
   envelope with a typed domain payload. A separately published Mesh surface is a
   second output with one Mesh recipe referencing the upstream Civil recipe id/
   generation, never a second recipe for the same output. The common
   `derived.recipe.*` commands stay solely with MT-D25; each output owner supplies
   only its typed payload, validation, and output semantics. This is derived from P10/X1/X3/X7 and is now cited reciprocally
   by MT-D25, DR-D20, CIV-D15, RA-D15, and BS-D24.
4. Draw, Select/Edit, Measure/Inspect, View, Viewing Box, Civil, Pointcloud,
   Raster, Mesh/Terrain, BIM, File/Attach, Import, Agent, Plan, WeltView,
   PhotoLab, and Cap: the round-3 Registry and every Builder owning spec cite the
   applicable §9.7/UIP-D24 cursor subset or explicit `n/a`. Sibling-app runtime
   implementations retain their stated applicability boundaries.
5. **Applied:** Select/Edit SE-D19 and View VD-D14 use the exact §1.1 commands
   and §9.3–§9.4 affected-state/overlay split; File FP-D21 owns persistence.
6. **Applied:** current doctrine P9 contains the permission-ceiling,
   capability-intersection, and orthogonal-overlay text consumed by UIP-D20 and
   SE-D19; the round-3 re-walk used that current wording.

### Disposition — batch-2 adversarial review (2026-09-02)

Primary dispositions: **14 resolved across this spec and the round-3 reciprocal
transaction; 0 deferred to owning Builder specs.** Remaining kernel, visual, and
gate artifacts are implementation work, not hidden owner questions or registry findings.

| Finding                                                       | Disposition                                                                                                                                                                                                                                                                             | Spec section / decision id                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1 (blocker) catalog/registry absent + clipboard contradiction | **Resolved:** §1.1 catalogs every act separately, names owner/consumer/access/command/status, activates SE-D7 clipboard, and the round-3 registry records every act once.                                                                                                               | §1.1, §9.2, UIP-D19; §9.12 item 1; REGISTRY §1.3                       |
| 2 (blocker) Tab contradiction                                 | **Resolved across normative documentation:** every target spec/Registry occurrence uses Tab/Shift+Tab for focus and Up/Down only for a live candidate set; field/no-indicator behavior and invalidation are explicit. The obsolete kernel/test binding remains an implementation delta. | §2.2, §3.4/§3.6, UIP-D16, §5–6, §9.5/§9.9; §9.12 item 2                |
| 3 (blocker) reticle incomplete                                | **Resolved:** full state machine, gestures, navigation coexistence, frames, typed twins, provenance, authority, Escape/pointercancel/focus/trailing-up lifecycle, revalidation, and three consumers. RealWorks deviation is sourced.                                                    | §9.1/§9.5, UIP-D22                                                     |
| 4 (blocker) incoherent P9 state                               | **Resolved:** permission ceiling/capability intersection is separate from Support/Labels/kind overlays; exact-snap capability, attachment/raster/cloud extremes, all-or-none preview/CAS, and sole SE-D19 authority are specified.                                                      | §1.1, §9.3/§9.8, UIP-D20/UIP-D25                                       |
| 5 (blocker) history scope/restoration absent                  | **Resolved:** exact affected-state table, named APIs, gesture entries, branch/coalescing, project/restart/crash/corruption lifecycle, and FP-D21 persistence replace stale non-survival prose.                                                                                          | §3.4 C4, §9.4, UIP-D23                                                 |
| 6 (major) corrected dossiers ignored                          | **Resolved:** Access three-state/blue/arrow/point/multi-row facts and RealWorks constrained/UCS/smart-pick/translation-only facts are dispositioned with explicit native deviations.                                                                                                    | §3.4 A2, §9.1, UIP-D20–D22                                             |
| 7 (major) contradictory/incomplete visual contract            | **Resolved:** generic accent oracle removed; exact token values, class extremes, non-color cues, both-theme dense-cloud/raster artifact and missing-token implementation status are explicit.                                                                                           | §2.2, UIP-D4/UIP-D15, §7.1, §9.6, UIP-D21                              |
| 8 (major) no automation twins                                 | **Resolved:** every act has a canonical get/set/preview/apply/history path plus a full presence/absence reachability matrix; components do not create duplicate state commands.                                                                                                         | §1.1, §9.2, UIP-D19/UIP-D20                                            |
| 9 (major) no runnable extreme gate                            | **Resolved at specification level:** named self-launching scripts, exact frame/latency/memory/page/cancel/restart/atomic budgets, tier routing, and missing-capability failure are required; implementation remains new.                                                                | §9.9, UIP-D26                                                          |
| 10 (major) passive consumers/races absent                     | **Resolved:** consumer matrix, single snapshot, tool/candidate revalidation, segment lifecycle, propagation CAS, export boundary, sibling-app applicability, crash/failure rules, and race tests are explicit.                                                                          | §9.3/§9.8–§9.9, UIP-D25                                                |
| 11 (major) MT-D25 recipe ambiguity                            | **Resolved reciprocally:** UI Platform adopts one lifecycle protocol/one recipe per output, and MT/Draw/Civil/Raster/BIM cite the shared owner/payload split.                                                                                                                           | §9.11, §9.12 item 3; P10/X1/X3/X7; MT-D25/DR-D20/CIV-D15/RA-D15/BS-D24 |
| 12 (major) cursor declarations/precedence incomplete          | **Resolved reciprocally:** precedence, invalidation, and the complete per-tool/product matrix are normative; every Builder owning spec cites its UIP-D24/§9.7 subset or explicit `n/a`.                                                                                                 | §1.1, §9.7/§9.9, UIP-D24; §9.12 item 4                                 |
| 13 (minor) active modes disappear in overflow                 | **Resolved:** strip and every active non-default mode remain visibly summarized; overflow badges/accessibility and 100%/150% minimum-width artifacts are required.                                                                                                                      | §9.2/§9.9, UIP-D19                                                     |
| 14 (minor) stale code citations                               | **Resolved:** executing Select/EntityTree/Rust ordering/TypeScript consumption lines replace stale citations; comments are interface intent only and their gesture-neutral rename is in the delta.                                                                                      | §1, §2.2, §3.2/§3.4, §5; §9.12 item 2                                  |
