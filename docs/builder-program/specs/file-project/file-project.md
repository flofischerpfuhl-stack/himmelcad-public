# File & project — workflow-level specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner
statements batch 2 and doctrine P11.
Document class: plan. Walks
`docs/FUNCTION-CONTRACT.md` in full, including the 2026-09-01 additions
(C4 restore-scope, A3 verified sibling semantics, E2 extreme class
members, A2 code-claim citations); every consequential choice carries a
`docs/DECISION-DOCTRINE.md` decision record. Builds on owner decisions
**D1** (project lifecycle) and **D5** (project-as-block) in
`docs/builder-program/OWNER-DECISIONS.md`; both are working directions
here, not open questions.
Input evidence: `docs/builder-program/dossiers/rib-civil.md`,
`docs/builder-program/dossiers/realworks.md`, `docs/PROJECT-FORMAT.md`,
`file-project-spec-review-2026-09-01.md`, and the current
implementation (file/line citations in §4).
E1 reference artifact: the failable written criteria in §2 E1 of this
document are the **primary** reference (FP-D2/review finding 14);
in-repo surfaces are named only where they actually exist as themed UI.

## Function catalog (registry rows)

All functions live on the **File** ribbon tab (D2 taxonomy). Every access
path resolves to the same canonical command or query (B1).

| Id                 | Access paths                                                                                                                                                    | Surface                                                                                                                  | Perf class                                           | Automation command                                                                | Status                                                                                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file.new`         | ribbon File · New; console `ribbon.file.new`; automation                                                                                                        | floating island (name + location)                                                                                        | bounded                                              | `project.create`                                                                  | specified                                                                                                                                                                                                                |
| `file.open`        | ribbon File · Open (split button: directory picker; dropdown "Open archive…" for `.hcadx`); window drag-drop of `.hcad`/`.hcadx`; console; automation           | OS pickers; progress island for archives                                                                                 | bounded → long-running                               | `project.open`                                                                    | specified                                                                                                                                                                                                                |
| `file.recent`      | Open split-button dropdown; no-project start screen; automation                                                                                                 | menu list                                                                                                                | bounded                                              | `project.recent_list` (query)                                                     | specified                                                                                                                                                                                                                |
| `file.save`        | ribbon File · Save (split button: dropdown "Save snapshot…", "Save As…"); Ctrl+S; console; automation                                                           | inline control + status-bar state/toast                                                                                  | bounded by pending group-commit flush                | `project.flush`                                                                   | specified                                                                                                                                                                                                                |
| `file.save-as`     | ribbon File · Save As; console; automation                                                                                                                      | OS save dialog + progress island                                                                                         | long-running                                         | `project.save_as`                                                                 | specified                                                                                                                                                                                                                |
| `file.snapshots`   | ribbon File · Snapshots (toggle); Save dropdown · Save snapshot…; automatic "Session start" marker on open; console; automation                                 | floating island (list + create + restore)                                                                                | bounded; restore bounded → long-running              | `snapshot.create / list / rename / restore / delete`                              | specified                                                                                                                                                                                                                |
| `file.export`      | ribbon File · Export; entity context menu "Export…"; console; automation                                                                                        | floating island, two steps (setup → plan review)                                                                         | long-running                                         | `io.export.plan / execute / formats`, `io.export.preset.save / list / delete`     | specified                                                                                                                                                                                                                |
| `file.attach`      | ribbon File · Attach project; console; automation                                                                                                               | OS open dialog → canonical entity; placement gizmo + numeric twins; overrides via properties panel + entity context menu | long-running (bake)                                  | `project_reference.attach / detach / resync / set_display / set_placement / list` | specified                                                                                                                                                                                                                |
| `document.history` | persistent Document history menu plus Undo/Redo in the quick-access strip beside every tab; File · History; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; console; automation | inline + strip menu                                                                                                      | bounded; undo of bulk restore bounded → long-running | `document.history.get`, `document.undo` / `document.redo`                         | owner: ui-platform; FP-D11 access path; specified; one act shared with UIP-D19/UIP-D23                                                                                                                                   |
| `file.settings`    | ribbon File · Settings; console; automation                                                                                                                     | dedicated resizable window, Project + Global sections                                                                    | bounded                                              | `settings.get / set` (project scope), `preferences.get / set` (global)            | specified (framework; content out of scope)                                                                                                                                                                              |
| `file.maintenance` | Settings window · Project · Storage; console; automation                                                                                                        | Settings page (preview → run)                                                                                            | long-running                                         | `project.maintenance.describe / run`                                              | specified                                                                                                                                                                                                                |
| `file.import`      | ribbon File · Import…; multi-file drop; console; automation (owned workflow: import-formats §1/IF-D12)                                                          | OS dialog/drop → registration flow, PhotoLab product chooser, or Raster georeferencing hand-off                          | bounded probe → long-running                         | public `io.probe`, `io.import`, `io.import.product_dataset.list/register`         | owner: import-formats; File-tab access path; **partial** — providers/registration substrate exist, but review-before-publication, lifecycle, staged plain-image hand-off, and IF-D19–IF-D25 generated SDK surface remain |

Plain TIFF/PNG/JPG and optional TFW/JGW companions are admitted only to the
Import-owned staged-source lifecycle. They remain outside world space until
Raster `raster.georeference.apply` publishes a truthful mapping; close/cancel/
restart recovery follows RA-D13, and neither File nor Import invents placement.

Shortcut recommendations to `REGISTRY.md` (the registry owns the map):

| Shortcut              | Function       | Contract                                                                                              |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| Ctrl+N                | `file.new`     | `project.create`                                                                                      |
| Ctrl+O                | `file.open`    | `project.open`                                                                                        |
| Ctrl+S                | `file.save`    | `project.flush`; force pending group commits durable, then affirm verified stored state (§1.3, FP-D2) |
| Ctrl+Shift+S          | `file.save-as` | `project.save_as`                                                                                     |
| Ctrl+Z                | `file.undo`    | `document.undo`                                                                                       |
| Ctrl+Shift+Z / Ctrl+Y | `file.redo`    | `document.redo`; Ctrl+Y is the conventional alias claimed in registry reconciliation F9               |

## 1. Workflow narratives

### 1.1 New project, and where it lives

The user starts Builder for the first time. A project opens immediately —
there is no blocking "create a project first" wall; the default project
lives in the app data area exactly as today. When the user wants a real
project, they press **New** on the File tab. A floating island asks for two
things: a **name** and a **location**. The location field is pre-filled
with the last-used projects directory (first run: the user's documents
folder); **Browse…** opens the OS folder picker. The island shows the
resulting path — `<location>/<name>.hcad` — as it will exist on disk,
because D1 deliberately respects the user's file-management expectations:
the project is a folder the user can see, back up, and put under their own
ordering. **Create** builds the store, opens it, and the title bar now
shows the project name. The console logs the full path. Escape or the
island's close affordance cancels without creating anything.

If the chosen path already contains a project or any files, Create is
disabled with an explaining message — never a silent merge or overwrite
(X1). Creating never migrates or touches the previously open project;
that project simply closes (its journal is already durable — closing
loses nothing, §1.3).

### 1.2 Open, recent projects, and archives

**Open** is a split button. Clicking it opens the OS **directory**
picker for `.hcad` project folders; the dropdown carries **Open
archive…**, which opens a file picker for `.hcadx`. Two pickers, not
one, because a combined file-and-directory dialog does not exist on
Windows or Linux — Electron honors `['openFile','openDirectory']` only
on macOS, and PhotoLab's combined dialog
(`apps/photolab/electron/main.ts:1159`) is a live defect on Linux
today; its fix is a recorded share-back (FP-D14). Dropping a `.hcad`
folder or `.hcadx` file onto the Builder window opens it through the
same command. Opening a `.hcad` folder is direct: the store locks, the
residency bootstraps, entities and viewport state return exactly as
they were — including an active, locked viewing box (P1 class state
replays from the journal). If the project is already open in another
Builder or PhotoLab process, the exclusive project lock refuses with a
message naming the conflict (SYSTEM-001: two writers are rejected, not
coordinated).

Opening a `.hcadx` **archive** never works in place — an archive is a
portable copy, not a working directory (`docs/PROJECT-FORMAT.md`
"Formats"). The dialog flow asks where to unpack (pre-filled from the
projects directory preference), then a UIP-D10 registered job shows real
phases and bytes in the progress island and through the status-bar chip/shared
jobs island, cancellable from either; publication happens only
after complete validation, so a cancelled or failed unpack leaves no
half-project (`docs/PROJECT-FORMAT.md` "`.hcadx` archive"). The unpacked
project then opens normally.

The split button's dropdown lists **recent projects** — name, path,
last-opened time — newest first. The list renders immediately from the
cached preference; path liveness is probed asynchronously with a short
timeout, so a dead network mount or sleeping drive never freezes the
menu (finding 11) — entries confirmed missing grey out in place with a
per-entry remove affordance; clicking a live entry opens it directly.
On startup Builder reopens the last project (the `lastProjectPath`
preference pattern, `apps/photolab/electron/preferences.ts:85`); if it
is missing or locked, Builder opens the default project and says so in
the console instead of failing to start.

### 1.3 Visible Save control over journal-implicit persistence

There is no dirty flag and no unsaved-document lifecycle (D1), but the
File tab retains a visible **Save** split button (P6). Its primary action,
Ctrl+S, the console path, and automation `project.flush` are one canonical
operation: force every pending group commit through the durability boundary,
wait for the store's acknowledgement without blocking the UI/render thread,
then set the status bar and a transient toast to **`All changes stored · <time>`**
using the acknowledged durability time. If nothing is pending,
the same operation reaffirms the latest verified durable generation. The
dropdown offers **Save snapshot…**, which opens the existing Snapshots flow
with its name field focused (§1.4), and **Save As…**, which opens the existing
archive-copy flow (§1.5). Save therefore remains familiar without pretending
that ordinary editing depends on manual saving (FP-D2).

Ordinary command appends are asynchronous group commits off the UI/render
thread (P5). While durability acknowledgement is pending, the
indicator says **"Storing…"**; continuous gestures journal once at gesture
end and never per frame. Crash, power loss, and force-quit preserve every
acknowledged group; an uncommitted drag preview or group still shown as
storing has not yet entered the claimed durable state. The title bar shows
the project name with no asterisk-state. The stored claim is made only after
the canonical store acknowledges durability, never when a command is merely
queued or visible. This is a flush affordance over an always-journaled store,
not a classic dirty-document Save.

The indicator earns its trust by having a failure state. If a journal
append or explicit flush fails — disk full, permissions, dying drive —
the indicator flips to a loud error state:
`Changes are NOT being stored — <reason>`, with the design-system error triple
(what failed, what is safe, what to do next), and every command that cannot
journal is rejected
with the same message rather than executing unjournaled (X1: an
unjournaled edit is silent data loss wearing a success face). Ctrl+S in
this state attempts the real flush and, on failure, preserves and reaffirms
the failure state; it never emits "All changes stored". The state clears
only after the store verifiably crosses the durability boundary. A green
light that cannot turn red is decoration, not information (FP-D2;
injected-failure test in §5).

### 1.4 Snapshots — restorable points in the journal

Before trying a risky segmentation pass, the user presses **Snapshots**
on the File tab. The island lists existing snapshots (name, creation
time, author — UI, agent, SDK, or system — and "N commands since" with the
last command's name, read from the journal) and has one **New snapshot**
field: type "Before segmentation cleanup", Enter, done — bounded, no
dialog. A snapshot is a canonical named entity (P1: state the user
deliberately creates and wants back) marking the current journal
generation; it travels inside `.hcadx` archives and is visible to
automation from the moment it exists.

Every successful project open also creates an automatic snapshot marker
named **"Session start"** after recovery and lock acquisition and before
user or automation commands are accepted. It marks the exact open-time
generation, so "discard everything since I opened" is one restore away
(D1, P5, FP-D19). It is an automatic marker in the existing snapshot
entity/list and retention class, not a store copy or a separate recovery
mechanism.

**Restore** on a list entry rolls the project back to that snapshot's
state. Its affected-state set is defined exactly (contract C4
restore-scope rule): restore rolls back **every canonical entity and
project setting** to the marked generation — with one class exempt:
**snapshot entities themselves**. Snapshots are markers _about_ the
history line, not points _on_ it — VCS-tag semantics: restoring an old
Git state does not delete newer tags. The exemption is what makes
restore safe: without it, restoring to snapshot A would erase every
later snapshot including the safety snapshot created seconds earlier to
guard this very restore. Nothing else is exempt; view-local state
(camera, panels) is untouched because it was never canonical. Restore
does not touch external files Builder has written (exports, archives) —
those are deliverables, outside the journal's authority (C4).

Mechanically restore is a single compensating transaction — the journal
never rewinds (`docs/PROJECT-FORMAT.md` "Canonical journal"); it moves
forward to a state equal to the snapshot's. Because restore is itself a
journaled command, **Ctrl+Z undoes a restore** — no confirmation dialog
is needed, exactly like viewing-box removal (viewing-box spec §1.7).
Before executing a restore, Builder automatically creates a safety
snapshot named "Before restoring '<name>'" — which, by the exemption
above, survives the restore it guards. Restoring a large delta registers
under UIP-D10, shows an inline progress state plus the status-bar chip and
jobs-island path, and is cancellable; cancel publishes nothing
partial; undoing a bulk restore is the same size of operation and gets
the same progress treatment (§2 D1). Rename and delete are journaled
commands on the snapshot entity; deleting a snapshot never deletes
project data, only the marker.

Retention: manual snapshots are never auto-deleted. Automatic safety and
"Session start" snapshots older than a tunable retention window (start: 30
days or the 20 newest, whichever keeps more) are garbage-collected as an
explicit maintenance operation, never implicitly in an unrelated command
(`docs/PROJECT-FORMAT.md` "Immutable object store"). Auto-snapshot
cadence beyond safety and session-start markers is tunable and starts
**off** (D1 marks retention/cadence tunable; the journal already makes
work loss-free, so cadence snapshots add naming convenience, not safety).

### 1.5 Save As — the archive copy

**Save As** opens the OS save dialog for a `.hcadx` path (pre-filled from
the export directory preference). Before packing begins it runs the same
durability flush as `file.save`; a failed flush leaves the loud failure state
and starts no archive job. Packing is a UIP-D10 registered job that
streams with real phase/bytes progress and remains visible and cancellable
through the status-bar chip and shared jobs island; the archive is written as
a sibling candidate and published by atomic replacement, so a cancelled or
failed pack leaves an
existing archive at that path intact (`docs/PROJECT-FORMAT.md` "`.hcadx`
archive" — implemented: `pack_hcadx_with_cancel`,
`crates/himmelcad-sidecar/src/project_archive.rs:106`). Save As is a
**copy**: the user keeps working in the current project; the console
logs the archive path and size. It does not switch the working project
to the copy — the archive is for sharing, backup, and WeltView, not a
second working location (FP-D3). Everything canonical travels: entities,
snapshots, viewing boxes, attached-project references — including their
baked datasets — and project settings. When references are present, the
Save As island states it plainly: "Includes baked content of N attached
projects. Their source projects are not included." — the recipient can
view and measure the attached content but cannot re-sync it (§1.7,
FP-D7); no one discovers that at the client's office.

Save As is also the **supported way to copy a live project**. A
file-manager copy of an open `.hcad` folder is not corrupted — the
append-only journal and immutable objects mean the copy is a valid
project at some recent prefix of the history, minus any transaction
mid-write — but it is a lucky snapshot, not a guarantee, and the spec
says so where users will look (the Settings · Storage page, §1.9,
carries the one-line explanation). Archive while open = Save As;
folder copy = only with the project closed. A warning surface for
cloud-sync folders (Dropbox/OneDrive watching a live journal) is
queued as an idea (FP-D14).

### 1.6 Export

The user has imported a DXF site plan, drawn on top of it, and owes the
client the updated DXF. **Export** opens a floating island with two
steps.

**Step 1 — setup.** Scope: _Whole project_, _Current selection_ (live
count shown), or _One import_ (dropdown of import packages by source
name). Format: the list comes from the same registry the backend uses —
today DXF, LandXML, IFC (2x3/4/4.3), Gaussian-splat PLY, and GeoTIFF
(`crates/himmelcad-io/src/lib.rs:113`); formats that cannot represent
the chosen scope are disabled with a reason, not hidden. Today that
reason matters: DXF and LandXML have real writers (points, curves,
surfaces, blocks, text; alignments and elevation surfaces respectively),
while IFC, GeoTIFF, and splat PLY are **exact-passthrough exporters** —
they re-deliver the byte-identical imported source and refuse anything
else (`crates/himmelcad-io/src/ifc_provider.rs:320`), so they enable
only for a matching unmodified import scope, and the disable reason says
so. Synthetic writers for these formats are queued (FP-D14). Target path
via the OS save dialog, pre-filled from the export directory preference.
Format options render from the provider's declared option contract — no
hand-built per-format forms.

**Step 2 — plan review.** Before anything is written, Builder calls the
export **plan** and shows the result: the exact files that will be
created, and — the part that matters — the **semantic losses**. Loss
codes are namespaced and versioned (e.g.
`hcad.loss.dxf.unsupported-hatch@1`,
`crates/himmelcad-io/src/dxf_provider.rs:67`); the island renders each as
a human sentence with the affected entity count, with the code itself in
a tooltip for reports. A loss code the UI has no sentence for — a newer
provider version, an extension provider — renders as the raw code plus
its count, never dropped: an unknown loss is still a loss (finding 12). An empty loss list is stated as "Lossless export"
— a claim the backend actually verifies (plan/execute loss parity,
`crates/himmelcad-io/src/canonical_provider.rs:1101`). Confirming a
lossy plan is not a soft "OK": it writes the reviewed codes into the
provider's `acceptedLossCodes` option, and execution rejects any loss
that was not explicitly accepted (`dxf_provider.rs:330`) — the consent
the UI collects is the consent the backend enforces. **Export** runs
the accepted plan as a UIP-D10 registered job with real progress and cancel
(`io.operation.status` / `io.operation.cancel`); its status-bar chip opens
the shared jobs island, and closing the Export island never hides or cancels
the job. Cancel or failure leaves no partial file
published, and the console records the outcome with the loss summary, so
the deliverable's caveats are on the record. The viewing box never
silently scopes an export (viewing-box spec E2): export reads canonical
data; the box-scoped variant remains the explicit extract queued there.

The extreme members of the export-scope class behave honestly (contract
E2 extreme-class rule): select only a billion-point cloud and every
format disables — no exporter can represent it today (FP-D14) — so the
island shows one plain empty-state sentence, "The selection contains
only point-cloud data; no installed export format can represent it.",
instead of a wall of disabled rows; select a project reference and it
is excluded by default with the explicit include toggle (§2 E2).

**Export presets.** The same deliverable ships every week, so the setup
is worth naming (P1: deliberately created state the user wants back).
**Save as preset…** in step 1 stores scope rule, format, options, and
target-directory pattern under a name — a canonical entity, in the
snapshots' and viewing boxes' class, visible to automation; the setup
step gains a preset dropdown, and `io.export.plan` accepts a preset
reference, so "run the weekly DXF handover" is one agent sentence
(FP-D17; the reference precedent is RIB's reusable per-project file
presets, rib-civil.md §3 W1 Dateivorbelegung). Presets travel in
archives; a preset whose format or options no longer validate opens
the setup step with the offending field marked, never silently
"nearest-match" exported.

Escape follows the standard ladder: in a field it reverts the field;
otherwise it closes the island (setup state is kept for the session —
reopening resumes step 1 with the same choices; a running export
continues in the background with its progress chip and is not abandoned
by closing the island).

### 1.7 Another project as a block (D5)

A surveyor has the neighborhood scan as one project and the new site as
another. **Attach project** opens the OS dialog for a `.hcad` folder (or
`.hcadx`, which unpacks read-only into managed storage first). Before
anything is created, Builder compares the two projects' **coordinate
reference and units**: identical → the content lands at identity, where
the survey says it is; different or missing on either side → attach
**refuses with the mismatch named** and offers an explicit transform
choice (pick the interpretation, or attach at identity anyway, stated
as such) — never a silent reprojection or a silent guess
(`docs/PROJECT-FORMAT.md` safety invariant: "never silently transform
coordinates or units"; X1 — two correct surveys silently misaligned is
the worst outcome this feature can produce, finding 2). The accepted
choice is recorded on the reference.

Attaching is one canonical journaled command that creates a **project
reference entity** — xref-like, named after the source project, visible
in the left entity area like any entity, and fully visible to
automation (X3, P1). The reference carries a journaled **placement
transform** (translation/rotation, identity by default): the shared
Select/Edit gizmo (SE-D1) moves the attached block with numeric twins for every
component (C1), and automation sets it via
`project_reference.set_placement` — a non-georeferenced source project
can therefore still be positioned deliberately. The gizmo claims
viewport gestures only while the reference is selected and the gizmo
armed, per the platform gesture map (contract E2 gesture rule; FP-D15 supplies
the translate/rotate-only capability adapter to SE-D1, not a new gizmo).

Its content renders from the source project's **prepared datasets**:
read-only means Builder bakes/streams the already-prepared data rather
than re-importing — attach cost is bounded by dataset preparation
state, and interaction afterwards performs like native data (X2; D5
derivation). The bake lives in the **host** project's prepared-data
store, keyed on the source's manifest revision, retained until no
journal state (including undo history) references it, and it **travels
inside `.hcadx` archives** — which is what makes §1.5's "everything
canonical travels" true for references and lets a recipient without the
source view and measure the attached content (FP-D7). A progress state
covers the initial bake; the bake is a UIP-D10 registered job exposed through
the status-bar chip, shared jobs island, and its cancel action. Cancel removes
the reference cleanly.

The reference is selectable but its content is not editable and not
individually selectable — picking, snapping, and measurement see its
geometry (a surveyor measures against the neighbor's wall), but
segmentation, deletion, and property edits are rejected with "content of
an attached project — open the source project to edit" (viewing-box
VB-D13 class: tools see what the user sees; E2 table below).

**Display overrides** live in the properties panel when the reference is
selected, and in its context menu: _Original colors_ or _Uniform color_
(shared color control), plus a block-wide **transparency** slider with a
numeric twin (0–100 %, C1). Overrides are journaled per-reference
canonical properties — an agent can restyle an attached project exactly
like the user (X3).

**Re-sync**: when the source project changed since attach, the entity
shows a stale badge (checked cheaply on project open by comparing the
source manifest revision — FP-D8; no mid-session polling). The context
menu's **Re-sync** re-bakes from the source as a UIP-D10 registered job with
progress and cancel;
until it completes, the old state keeps rendering — never a half-synced
mix. If the source is missing (unplugged drive, moved folder), the
reference persists in an unresolved state that still shows the data:
the **last bake renders read-only** — it lives in the host project
(above), so nothing visual is lost — with a warning badge, a console
entry naming the missing path, and a **Relocate source…** action; only
re-sync is unavailable until the source returns. Attached content is
never silently dropped (`docs/PROJECT-FORMAT.md` "unknown future
content opens read-only when safe rather than being silently
discarded", same doctrine). **Detach** deletes the reference entity in
one click; Ctrl+Z brings it back with its overrides, placement, and
sync state.

### 1.8 Undo and redo, on every tab

A user who just mis-dragged a gradient point is on the Draw tab, not on
File — undo that requires a tab switch punishes exactly the moment it
exists for. Undo/Redo therefore live in a **persistent quick-access
strip** beside the ribbon tab headers, visible on every tab (the
established quick-access-toolbar position; within D2's letter — D2
fixes tab taxonomy, not the strip — reported as a vetoable derived
decision, FP-D11); the File tab's History group may duplicate them for
discoverability. Both surfaces, Ctrl+Z, and Ctrl+Shift+Z/Ctrl+Y dispatch the
same commands, wired to the canonical compensating-transaction undo
that exists in the core
(`crates/himmelcad-core/src/canonical_document.rs:468`) but is dead in
the UI today (`apps/builder/renderer/src/App.tsx:450`). One linear
stack per project, shared by UI, console, agent, and SDK commands (X3):
undoing after an agent placed a viewing box undoes the agent's command —
the tooltip names it ("Undo: Place viewing box"), so the shared stack is
legible, not surprising. Buttons disable with a reason when nothing is
un/redoable. Undo/redo are themselves journaled entries and replay after
a crash. View-local state (camera, panel layout, uncommitted field text)
is not on this stack — the C4 split follows viewing-box VB-D2, and it is
defensible to a Ctrl+Z user: every committed step is a step; camera moves
are not.

### 1.9 Settings entry points

**Settings** opens one dedicated resizable window with two top-level
sections — a framework; the detailed pages are each domain's scope:

- **Project** — settings that change project meaning (units, precision,
  coordinate reference, display defaults that specs consume). These are
  canonical journaled state: they travel in archives, agents read and set
  them through the same commands, and changing them is undoable (X3).
- **Global** — preferences of this installation (theme, remembered
  directories, recent projects, hardware/quality tier). These live in a
  versioned Builder preferences file with atomic writes, exactly the
  PhotoLab backend pattern (`apps/photolab/electron/preferences.ts:68`),
  and are deliberately not canonical: they are not project state (X3's
  justified exception), but they remain readable/writable through
  automation (`preferences.get/set`) so agent parity holds.

A third scope exists and is named so nobody smuggles state through the
gaps (finding 13): **project view state** — camera, panel layout,
active tab, last-open islands. It is stored in the project (so a
project reopens looking as it was left, §1.2) but **not journaled**:
restoring it is not undoable and never appears in the command history,
because no user counts "I orbited the camera" as a document step (C4).
It is automation-readable through the existing `view.state.get` class
of queries. The FP-D10 rule set is therefore three-valued: changes
project meaning → canonical journaled; per-installation → preferences
file; per-project but not meaning — reopen convenience — → project
view state, non-journaled.

**Project · Storage** is the settings page where the project's disk
footprint lives (finding 9): size by category (canonical objects,
prepared datasets, attach bakes, journal, previews/index), and one
action — **Clean up unreachable data** — with a preview of what would
be reclaimed before anything runs. An immutable object store plus an
append-only journal never shrinks by itself; without this surface the
answer to "why is my project 40 GB?" would be "use a file manager on
internals we told you never to touch". Cleanup is explicit,
long-running as a UIP-D10 registered job with status-bar chip, shared jobs
island, progress, and cancel, journaled as a maintenance
operation, and removes **only unreachable content**
(`docs/PROJECT-FORMAT.md`: GC "removes only unreachable content and is
never implicit in an unrelated command") — it can never remove
anything a snapshot, undo step, or reference still reaches, and it
says so (FP-D16; automation: `project.maintenance.describe / run`).

The window opens from File · Settings, closes via its close affordance or
Escape (no unsaved-state limbo: each change applies on commit, per-field,
with the standard Enter/blur–Escape input contract). Which scope a future
setting belongs to is decided by one question — "does it change what the
project means?" — recorded as FP-D10 so the next domain does not re-ask.

## 2. Function contract (A1–E3)

**A1 — User outcome.** §1 in full.

**A2 — Reference behavior.** RIB Civil/STRATIS project setup
(`dossiers/rib-civil.md` §3 W1): projects are folders switched via
Projektverwaltung, with per-project file presets and periodic
AUTOSAVE.SDA. We adopt the project-folder model and user-visible
locations (D1); we deliberately drop the classic dirty-document
save/autosave pair and the keep-old/overwrite/ask merge — the
journal-implicit store makes the data-loss problem they solve structurally
absent. The visible Save/Ctrl+S affordance remains under P6, but its honest
effect is a durability flush rather than document serialization (D1; stated
deviation).
The dossier's File mapping (rib-civil.md §5 "File") names the
import/export scope expectation: DXF/DWG, LandXML, PDF, raster, list
output; its data-exchange catalog (rib-civil.md §2.10) is the long-term
export target list — PDF and DWG export are queued honestly (FP-D14),
not implied. STRATIS UNDO (rib-civil.md §2.1) and RealWorks per-vertex
Ctrl+Z (realworks.md §2.3) ground multi-step undo as a baseline
expectation. RealWorks (realworks.md §2.1, §2.9, §5 mapping "File"):
import with per-format options and export dialogs live with project
I/O; the Publisher's read-only shareable package is the reference for
the archive-copy habit (Save As → send `.hcadx`) and, together with the
owner-named AutoCAD-xref behavior recorded in D5's derivation
(`OWNER-DECISIONS.md` D5), for read-only attached content; RealWorks
Preferences under `Support > Preferences` (realworks.md §2.2) and
STRATIS `<Extras><Grundparameter>` (rib-civil.md §2.2) ground a single
central settings surface. No dossier documents a snapshot/named-restore
feature — snapshots rest on D1 (owner-decided) plus P1, which needs no
reference support.

Dossier File-row dispositions (contract A2 catalog rule — omissions are
decisions): rib-civil.md §5 "File" — project-folder model **adopted**
(§1.1); database-vs-drawing split **rejected** (one canonical store is
the architecture, `docs/PROJECT-FORMAT.md`); keep/overwrite/ask save
merge and classic autosave **rejected**, structurally obsolete under D1;
the visible Save/Ctrl+S affordance is **retained as a durability flush**
under P6 (§1.3);
per-project file presets **adopted as export presets** (§1.6, FP-D17);
DXF/LandXML export **adopted** (§1.6); DWG/PDF export and list/report
output **deferred** (FP-D14); raster georeferencing → Raster domain
spec. realworks.md §5 "File" — import dialogs **adopted** (existing
`file.import`); "export all formats" **partially adopted** — the five
real exporters now, LAS/E57 **deferred** (FP-D14); Publisher packages
**deferred** (FP-D14).

**A3 — Sibling functions.** PhotoLab is the nearest relative — with its
actual semantics stated, per the contract's verified-sibling rule,
because they are **the opposite lifecycle**: PhotoLab is archive-first
with a real Save — `photolab.project.save/autosave`
(`crates/himmelcad-sidecar/src/main.rs:3023`) write explicit state, and
`photolab.project.saveAs` (`main.rs:3025`) packs the archive the user
"is in". Builder under D1 is journal-implicit with a visible
Save/`project.flush` affordance but no dirty-document save lifecycle.
"Match PhotoLab" is therefore deliberately **narrow**: Builder adopts
the sidecar archive machinery (`pack_hcadx`/`unpack_hcadx`), the
preferences backend pattern (`preferences.ts:68`), the `lastProjectPath`
reopening habit, and PhotoLab's progress presentation and dialog copy
tone — and explicitly does **not** adopt its explicit state-writing
save/autosave lifecycle. Builder's Save flushes pending journal group
commits; it does not serialize a document anew.
The divergence runs the other way in time: D1 names journal-implicit
persistence as the direction, so PhotoLab's migration to it is queued
as a share-back (FP-D14), as are the PhotoLab combined-dialog fix
(finding 4) and the `photolab.project.snapshot` rename (finding 15 —
that RPC captures a _session state blob_, not a document checkpoint;
two meanings of "snapshot" across siblings is a collision).
Within Builder: the snapshots island reuses the Saved-boxes list
pattern (viewing-box §1.4); export's two-step plan-review reuses the
import registration review posture (review before commit); the shared
color control, the platform transform gizmo, and the slider+numeric
pattern serve the attach overrides and placement. Improvements flow
back: recent-projects MRU and snapshot naming for PhotoLab (FP-D14).

**B1 — Reachability.** Per the catalog table: every function has ribbon
presence on the File tab, a console path (today via the `ribbon.<id>`
dispatch, `apps/builder/renderer/src/App.tsx:667`; dedicated console
verbs arrive with the command registry), and an automation command; the
project-reference entity additionally has context-menu commands
(re-sync, display overrides, placement, relocate, detach) and export
appears in the entity context menu for selection-scoped export.
Undo/redo are additionally reachable from every tab via the persistent
quick-access strip (§1.8); Ctrl+Shift+Z and Ctrl+Y are equal redo aliases.
The visible `file.save` split button, Ctrl+S, console, and automation
`project.flush` all force the same durability flush; its dropdown reaches
the existing Save snapshot and Save As flows (§1.3). Maintenance is
reachable from the Settings window's Storage page, the console, and
automation (§1.9). Absent by decision: quick-surface entries (no File
action is a viewport-spatial action) and a keyboard shortcut for
snapshots/attach (low frequency; registry may assign later).
Automation queries: `project.info` (current project name, path, journal
generation), `project.recent_list`, `snapshot.list`,
`project_reference.list`, `io.export.formats`, `io.export.preset.list`,
`project.maintenance.describe`.

**B2 — Open/close symmetry.** The Save primary action has no open state:
it resolves only when the pending durability flush succeeds or fails, then
the transient toast closes on its timer while the status-bar truth remains.
Its dropdown follows shared menu dismissal; choosing Save snapshot or Save
As opens the existing child flow, whose own close/cancel contract applies.
New, Snapshots, Export islands: ribbon
button toggles, explicit close affordance, Escape ladder (field revert →
close), closing is _cancel_ for New, _keep-alive_ for Export (running
operation continues with a progress chip; setup state kept) and
_keep-alive_ for Snapshots (list state is canonical anyway). Export, archive
pack/unpack, attach bake/re-sync, bulk restore, and maintenance remain visible
and cancellable through UIP-D10's status-bar chip and jobs island after their
launching surface closes. The
Settings window closes via affordance/Escape; committed changes stay
(each field commits individually — closing is not cancel, and the spec
says so in the window's design, not in a warning dialog). OS dialogs
(Open, Browse, Save As target) follow platform close semantics — allowed
native surfaces per `docs/DESIGN-SYSTEM.md` "Shared controls".

**B3 — Surface choice.** New/Snapshots/Export: floating islands —
focused multi-step work, no need to interact with the viewport
mid-flow; none outgrows the island in §1 (export's two steps are
sequential, not dense). Settings: dedicated resizable window — it owns
navigation and many pages (the one File-domain surface that would
outgrow an island). Attach: no surface of its own — an OS picker plus
canonical command; its ongoing controls live in the properties panel
where every entity's properties already live. Undo/redo: inline.

**C1 — Numeric parity.** The domain's direct manipulations: the attach
transparency slider (numeric twin, typed percent, project precision)
and the reference **placement gizmo** — every gizmo component
(translation X/Y/Z, rotation) has a live-synchronized typed field in
the properties panel, both directions, units and precision from project
settings (§1.7, finding 2); every path field is typed text with a
Browse twin — both directions always work. Snapshot names, project names:
typed, validated on commit (filesystem-safe, non-empty), Enter/blur
commit, Escape revert per the design-system input contract.

**C2 — Selection semantics.** Export honors _Current selection_ as a
scope captured when the plan step is entered; changing the viewport
selection while reviewing the plan does not silently change the plan —
the island states the captured count, and going back to step 1 re-reads
the live selection. Attach ignores the selection. The project-reference
entity participates in selection as a single unit (select the reference,
never its interior); tools treat its geometry as visible, measurable,
non-editable (§1.7). New/Open/Save/Save As/snapshot commands are
selection-independent. Multi-select export of mixed exportable and
non-representable entities lists the omitted ones as a named loss in
the plan, never a silent drop.

**C3 — Freezability.** The attached project **is** the frozen state of
this domain: read-only by definition, so the implementation bakes and
streams prepared datasets and skips all editability costs (X2, P2 class
— the D5 derivation's stated payoff). No additional lock is offered on
top (nothing cheaper than read-only exists to buy). Snapshots freeze
nothing at runtime; they are markers. Export plans are frozen by design:
execute runs the _accepted_ plan and fails loudly if the world changed
(plan parity check, `canonical_provider.rs:1101`) rather than exporting
something the user did not review.

**C4 — Persistence and undo.** Canonical and journaled (undoable):
project settings changes, snapshot create/rename/delete/restore,
export presets (P1-class named state, FP-D17), project-reference
attach/detach/set-display/set-placement/re-sync commit, maintenance
runs, and every document command the undo stack replays. Restore's
affected-state set is defined in §1.4 per the contract's restore-scope
rule: everything canonical rolls back except snapshot entities
(marker-about-history exemption — the exemption is what keeps the
safety snapshot alive through the restore it guards). Not canonical,
by justified exception: global preferences and the recent list
(installation state, not project state — X3 exception, still
automation-readable), OS dialog state, island layout; and the named
third scope, project view state — stored in the project, restored on
open, deliberately non-journaled (§1.9). Not undoable, stated in the
UI: Save As (a written external file is outside the journal's
authority — the console entry is the record; deleting the file is the
user's filesystem action), export outputs (same), New/Open (project
switches close one journal and open another; the previous project
reopens losslessly from Recent — that is the undo). This split is
defensible to a Ctrl+Z user: inside the project, everything is a step;
files the user asked Builder to write onto their own disk are
deliverables, not steps; camera moves are neither.

`project.flush` is not an undo step: it changes no canonical state and only
advances the verified durability boundary of already-issued commands.

**D1 — Performance budget.** Persistence participates in every domain's
continuous interaction and is governed by P5/FP-D19: a scripted drag produces
zero journal writes before gesture end and exactly one group-eligible append
at commit; gesture-end → durable group-commit acknowledgement is ≤ 100 ms p95
on interaction-tier hardware, and acknowledgement → truthful stored-indicator
update is ≤ 50 ms p95. Both numeric budgets are initial X6 calibrations and
tunable. The transparency slider otherwise inherits the viewer's existing
interaction budget and needs no separate gate. Bounded
(< 1 s, busy state only if perceptible): New, Open (folder case, small
projects), snapshot create/rename/delete, ordinary undo/redo, settings
commits, recent-list open (renders from cache; liveness probes are
async and never block the menu, §1.2). Bounded → long-running: undo or
redo of a **bulk restore** — the same delta size as the restore itself,
so it gets the same inline progress and cancel treatment (finding 10).
Long-running (registered under UIP-D10 with status-bar chip → shared jobs
island → cancel, plus real progress per `docs/DESIGN-SYSTEM.md`): archive
pack/unpack (real phases and bytes — already implemented in
`project_archive.rs`), export execute, attach bake, re-sync, large
restores, maintenance cleanup, large-project open (streamed residency).
Every long-running feature registers in the main-process job registry or
fails review (UIP-D10); closing a feature island cannot orphan its progress
or cancel path. Runnable gates for the long-running class are correctness
gates (§5:
cancel-cleanliness, no partial publication), not frame-time gates; the
one calibration number — restore/open progress-threshold (show progress
above ~300 ms expected duration) — is tunable (X6).

**D2 — Degradation.** On weak hardware nothing here degrades in quality;
these are I/O-bound operations that simply take longer, and the UI must
stay responsive during all of them (operations run in the sidecar;
the renderer never blocks). An attached project's rendering degrades
under the existing quality governor exactly like native datasets —
never below the correctness line (its geometry stays pickable and
measurable). Never degraded: journal integrity, archive atomicity, loss
reporting completeness.

**E1 — Visual quality.** The **written criteria below are the primary
reference artifact** (finding 14: PhotoLab's project open/save surfaces
are largely native OS dialogs and the viewing-box Saved-boxes list is
itself an unimplemented spec — neither can serve as a screenshot
reference). What does bind as existing chrome: the shared
`@himmelcad/ui` island, dialog, progress, and form patterns, and
PhotoLab's progress/copy tone — design tokens only. Failable criteria
for implementation review: (1) the New island shows the final on-disk
path before Create, and the shown path equals the created path; (2) the
export plan step legibly separates outputs from losses, each loss as
one plain-English line with entity count, code in tooltip — a reviewer
who cannot tell from the screenshot whether an export is lossy fails
the build; (3) unknown loss codes render as raw code + count, and the
all-formats-disabled state shows the single §1.6 empty-state sentence,
not a wall of disabled rows; (4) the stale/unresolved badges on a
project reference are distinguishable at a glance in both themes;
(5) the visible Save split button is present in the File tab; its normal
state and toast say exactly `All changes stored · <time>` only after verified
durability, "Storing…" is visibly distinct, and its failure state is
unmissable: error-status color, plain words, visible from across the room;
(6) Undo/Redo disabled states carry the reason tooltip. Screenshots of all
six, both themes, are
compared at implementation review.

**E2 — Conflicts, failure, and consumers.** Consumers of the state this
domain manipulates, and each function's effect:

| Consumer                         | Effect                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer / residency               | Open/New/close swap the residency bootstrap atomically; restore and re-sync invalidate affected datasets only after commit — no frame ever mixes old and new state                                                                                                                                                      |
| Entity area / properties         | Snapshots and project references are entities: they list, select, rename, and show properties like any entity                                                                                                                                                                                                           |
| Picking / snapping / measurement | See attached-project geometry (read-only); see restored state immediately after restore commits                                                                                                                                                                                                                         |
| Tools (segment, draw, …)         | Reject edits inside a project reference with the §1.7 message; running tools are cancelled by project close/open (Complete-user-flows rule: incompatible operations serialized or rejected explicitly)                                                                                                                  |
| Exporters                        | Export reads canonical data; scope captured at plan time; plan/execute parity enforced; attached-project content is **excluded** from export by default and offered as an explicit include toggle whose plan names the source project (never a silent re-export of someone else's data)                                 |
| Measurement reports              | `hcad.measurement-report.csv@1` contributes selected/all scope, unresolved-warning policy, and MI-D8 provenance through this same plan/execute surface; File owns target/loss/publication chrome                                                                                                                        |
| Mesh volume reports              | `hcad.volume-report.csv@1` contributes MT-D20 semantics and stale-report warnings through `io.export.plan/execute`; File owns publication only                                                                                                                                                                          |
| Plan sheets/captures             | PE-D5/PE-D7 sheets and viewports are journaled restore-scope state; linked captures are content-addressed artifacts retained while reachable from journal/undo/snapshots                                                                                                                                                |
| Sibling apps (PhotoLab)          | Same store, same lock: concurrent open of one project is rejected by the exclusive project lock (`canonical_project_store.rs:259`); archives are cross-product                                                                                                                                                          |
| Automation / agent               | Every command and query in the catalog; `project.info` reports name, path, generation; one Agent-presented mutation is one FP-D11 root with AG-D14 child audit records and one-step undo; handle-bound export publication adopts AG-D17; automation sessions are revoked on project close (implemented: `main.rs:1398`) |
| WeltView                         | Consumes `.hcadx` archives produced by Save As (`docs/PROJECT-FORMAT.md`)                                                                                                                                                                                                                                               |

Failure and crash: journal commits are atomic per store contract;
mid-operation failure of pack/unpack/export/bake publishes nothing
partial and reports what failed, what is safe, and what to do next
(design-system error rule); a crash during any of them leaves the
project consistent on next open (journal replay + pending-transaction
validation, `canonical_project_store.rs:243`). Two concurrent exports to
different paths may run; two to the same path are rejected at plan time.
Attach of a project into itself, or a reference cycle A→B→A, is rejected
at attach time with a named reason.

Project switch or app quit while an export, pack, bake, or maintenance
run is in flight prompts **once**, naming the running operations, with
wait or cancel-and-proceed; an automation-initiated close in the same
situation gets a named rejection error, never a hanging prompt
(finding 17; design-system rule: incompatible operations are rejected
explicitly). A file-manager copy of an open project yields a valid
recent-prefix project, not corruption — but Save As is the supported
live backup (§1.5).

Extreme members of the classes these rules govern (contract E2
extreme-class rule): _restore scope_ — largest member: a
billion-point import; its prepared dataset stays referenced by the
journal's undo history, so restore is a metadata-sized transaction and
maintenance cannot collect the dataset while any history step reaches
it; least typical member: snapshot entities — the one exemption,
stated in §1.4. _Attachable projects_ — largest: a source project
bigger than its host; the bake streams prepared datasets, it does not
load them (X2), so attach cost scales with preparation state, not
size; least typical: an empty project attaches successfully and lists
normally (nothing renders — not an error), and a source that itself
contains references renders those from its own bakes read-only:
chains display, re-sync never recurses past the direct source.
_Export scope_ — largest: point-cloud-only selection → the honest
§1.6 empty state; least typical: a project reference in scope →
excluded by default with the explicit include toggle (table above).

**E3 — Verification plan.** §5. Unverified claims are listed there.

## 3. Decision records

**FP-D1 — Startup opens the last project; the fixed default project
becomes ordinary.** **Decision:** Builder reopens the last project on
start (preferences-backed); the hardcoded
`builder-default.hcad` root becomes just another project — the fallback
when nothing else exists, listed in Recent like any other.
**Derivation:** D1 (location choice); A3 sibling precedent
(`lastProjectPath`, `preferences.ts:85`); X4 (rib-civil.md §3 W1 —
project switching is a first-class habit). **Rejected:** always opening
the default project (hides the user's own projects behind an extra
click); a blocking project chooser on startup (slower to first pixel for
zero benefit). **Tunable:** no.

**FP-D2 — A visible Save control flushes journal durability and reports
only verified state** (owner-corrected 2026-09-02; supersedes the
no-Save-button clause from review findings 6 and 8). **Decision:** the File
tab contains `file.save`, a visible split button whose primary action,
Ctrl+S, console path, and automation `project.flush` force all pending group
commits across the durability boundary. Success sets the status bar and toast
to `All changes stored · <time>` using the acknowledged durability time;
failure preserves the loud `Changes are NOT being stored — <reason>` state
and never emits the stored claim. The dropdown opens the existing Save
snapshot and Save As flows. There is still no dirty flag or unsaved-document
lifecycle. **Derivation:** owner decision D1 as amended 2026-09-02; P6
(universal affordances survive mechanism changes); P5 (the flush observes,
but never moves persistence cost onto, the interaction path); design-system
UI-copy rule (never claim unverified state); X1 (an unjournaled edit or false
durability claim is data loss disguised as success). **Rejected:** removing
Save (contradicts P6); a no-op affirmation (cannot force or verify pending
group commits); binding Save to Save As (teaches the wrong archive-copy
model); classic dirty-flag Save (reintroduces preventable work loss); an
indicator without a failure state (unfalsifiable decoration). **Tunable:**
yes — toast auto-dismiss time under X6; flush semantics and verified copy are
not tunable.

**FP-D3 — Save As is a copy; the working project does not switch.**
**Decision:** §1.5. **Derivation:** `docs/PROJECT-FORMAT.md` (archive =
sharing/backup/publication format, not a working directory); X5 is not
violated — the pair of Save As is Open-archive, and both exist.
**Rejected:** switch-to-copy (silently moves the journal authority to a
new location mid-session; contradicts the archive's purpose).
**Tunable:** no.

**FP-D4 — Snapshots are canonical entities; restore is one compensating
journaled command, snapshot-exempt, with automatic safety and session-start
markers** (revised per review finding 1 and owner correction 2026-09-02).
**Decision:** §1.4; every successful open creates a "Session start" marker
before accepting commands; restore's
affected-state set is all canonical state at the marked generation
**except snapshot entities**, which are markers about the history line
(VCS-tag semantics) and survive every restore — including the safety
snapshot created to guard the restore itself. Plan sheets/viewports are
ordinary journaled state in this affected set;
PE-D7 linked captures remain content-addressed and are restored by exact
reference. Measurement entities likewise restore as ordinary canonical state
(MI-D11). **Derivation:** D1 as amended
2026-09-02 and P5 (one-step recovery from the session boundary); P1
(named restorable state), X3 (agent parity), `docs/PROJECT-FORMAT.md`
(journal never rewinds; undo/redo append compensating transactions —
restore generalizes the same mechanism); X5 (snapshot/restore is a
pair; restore/undo-restore is a pair); contract C4 restore-scope rule
(this spec's review is its motivating case). **Rejected:**
checkpoint-by-copying-the-store (duplicates gigabytes and falls
outside the journal); restore including snapshots (erases its own
safety net — the finding-1 blocker); confirmation dialog on restore
(undo plus safety snapshot make it needless — viewing-box §1.7
precedent). **Tunable:** yes — automatic safety/session-marker retention
(30 days / 20 newest) and auto-cadence beyond those markers (off), per D1's
tunable clause.

**FP-D5 — Export always shows its plan; losses are disclosed before a
byte is written.** **Decision:** two-step island; lossy plans list every
namespaced code as plain language; execute runs only the accepted plan.
Publication adopts AG-D17's brokered destination-handle identity,
execute-time collision revalidation, sibling-temp flush, and honest disclosure
that a multi-file export cannot be globally atomic.
**Derivation:** X1 (a deliverable with undisclosed losses is a
correctness failure toward the client); the backend already enforces
plan/loss parity (`canonical_provider.rs:826,1101`) — the UI matching
it is the honest surface; design-system confirmation-copy rule.
**Rejected:** one-click export with a post-hoc report (user learns of
losses after the file exists); hiding lossless plans' review step
(review also confirms scope and outputs — kept, one Enter to pass).
**Tunable:** no.

P11 applies to this record without a File-specific exposure variant: **Product
operations reach automation and the console from one generated command table:
every product capability (Builder, PhotoLab, WeltView read-only queries) is a
canonical command or query with the validate/status/cancel lifecycle, generated
from a single command table that also drives the console vocabulary and the Python
SDK; allowlisting raw RPCs is never the exposure mechanism; approval,
confirmation-grant, and credential surfaces stay user-only (ADR 0024).** Thus
`io.export.plan/execute` and their status/cancel lifecycle are generated from that
table, while execute confirmation remains user-only.

**FP-D6 — Export scope is user-level (project/selection/import); the
package-scoped backend is extended, not exposed.** **Decision:** the UI
never asks the user for an import commandId; Builder maps scope to
packages internally and the backend gains selection-scoped package
assembly. **Derivation:** X1/X4 — reference products export "what I
selected / everything" (realworks.md §2.9 export dialogs; rib-civil.md
§2.10 model-level exchange), not internal transaction ids; the current
`reconstruct_import_package` (`canonical_app_runtime.rs:438`) is an
implementation seam, not a user concept. **Rejected:** shipping the UI
over import-package scope only (cannot export drawn-on-top content —
the §1.6 workflow's whole point). **Tunable:** no.

**FP-D7 — The attach bake lives in the host project, keyed on source
revision, and travels in archives; a missing source renders the last
bake** (revised per review finding 3). **Decision:** the bake is
published into the **host** project's prepared-data store keyed on the
source manifest revision, retained while any journal state (including
undo history) references it, and packed into `.hcadx` — Save As
disclosing "includes baked content of N attached projects (sources not
included)". A missing source is therefore a _sync_ problem, not a
display problem: the last bake renders read-only under a warning badge
with Relocate; only re-sync is unavailable. **Derivation:** X2 (the
bake is the reference's performance substance; a host project must be
self-sufficient to render what it shows); X1/`docs/PROJECT-FORMAT.md`
("never publish a reference to missing content" binds the _archive_ to
carry the bake it references; reading tolerates source absence
read-only rather than discarding); design-system error rule (what
failed, what is safe, what next). **Rejected:** bake-in-source or
re-bake-on-open-from-source (archives would arrive blind and
unmeasurable at the recipient — the §1.5/§1.7 contradiction the review
caught); bounds-box placeholder on missing source (throws away data
the host verifiably has); auto-detach on missing source (destroys user
state on a transient condition like an unmounted drive).
**Tunable:** no.

**FP-D8 — Re-sync is manual, with a staleness check on project open.**
**Decision:** stale badge from a manifest-revision compare at open;
re-sync only on explicit command; old bake renders until the new one
commits. **Derivation:** D5 marks the policy tunable and this is the
conservative start; X2 (no mid-session polling cost); SYSTEM-001 (a
source project being edited concurrently must not push half-states into
consumers). **Rejected:** auto-resync on open (surprise long operation
at open time); live watching (concurrency and cost for no asked-for
benefit). **Tunable:** yes — the check-on-open may later add an opt-in
auto-resync.

**FP-D9 — Display overrides are canonical per-reference properties.**
**Decision:** original/uniform color + transparency journaled on the
reference entity, applied render-pass-wide to its content.
**Derivation:** D5 (names exactly these overrides); X3/P1 (restyling is
deliberate, restorable state; agents restyle too); C1 (slider+numeric).
**Rejected:** view-local overrides (invisible to automation, lost on
reload — the exact class P1 forbids). **Tunable:** no.

**FP-D10 — Settings scope rule: three named scopes** (revised per
review finding 13). **Decision:** (a) changes project meaning →
canonical journaled project setting; (b) per-installation → versioned
local preferences file (PhotoLab backend pattern) exposed read/write
to automation; (c) per-project reopen convenience that is not meaning
— camera, panel layout, open islands — → **project view state**:
stored in the project, restored on open, deliberately non-journaled,
automation-readable. **Derivation:** X3 and its justified-exception
clause; A3 (`preferences.ts:68` is the working precedent, atomic
writes and schema versioning included); C4 (nobody counts a camera
move as a document step — the same split viewing-box VB-D2 drew for
drag previews). **Rejected:** everything-canonical (theme choices
would sync into archives and other machines' UIs; camera moves would
spam undo); everything-local (units/precision must travel with the
project and bind automation); leaving scope (c) unnamed (state finds
the gaps — the review's point). **Tunable:** no — the rule;
individual settings classify under it per domain.

**FP-D11 — One shared undo walk for UI and automation, with named
steps, reachable from every tab** (revised per review finding 7 and registry
finding F9).
**Decision:** §1.8; Ctrl+Z walks the most recent still-active
root command, Ctrl+Shift+Z and Ctrl+Y are equal aliases that redo the most
recently undone one — a linear UI
over a core that is deliberately more capable: undo is field-scoped and
conflict-aware, so unrelated later edits survive
(`canonical_document.rs:464`). Undo/Redo sit in a persistent
quick-access strip beside the ribbon tab headers, visible on every
tab; File · History may duplicate. The strip stays within D2's letter
(D2 fixes the tab taxonomy; the strip is not a tab) and is reported as
a vetoable derived decision. Tooltips name the target command;
undo/redo become `document.undo/redo` automation commands and new
sidecar RPCs over the existing `commit_undo`/`commit_redo`
(`canonical_project_store.rs:407`), which today have zero callers.
One Agent result presented as one action contributes exactly one all-or-none
root with AG-D14 child audit records; Ctrl+Z and **Undo Agent turn** compensate
that root once, preserving unrelated later fields.
**Derivation:** X3 (one command authority — `docs/PROJECT-FORMAT.md`
forbids a second one); X5 (the do/undo pair is currently shipped half:
implemented in core and WASM, absent from ribbon, shortcut, sidecar,
and SDK — a defect by doctrine, which this spec closes); P6/X4 (both
conventional redo gestures reach the same honest effect). **Rejected:**
per-origin stacks (UI-only undo that skips agent commands makes Ctrl+Z
lie about document history); File-tab-only buttons (undo is needed at
the moment of the mistake, which is never on the File tab — X4: every
reference product keeps undo globally visible); omitting Ctrl+Y (leaves a
universal platform alias dead for no benefit); exposing targeted
undo-any-command in the UI now (the core supports it; a selective-undo
surface is a follow-on, FP-D14, not a default behavior users expect
from Ctrl+Z). **Tunable:** no.

**FP-D12 — Recent projects live in preferences; dead entries are shown,
not hidden; liveness never blocks** (revised per review finding 11).
**Decision:** §1.2; MRU capped (start: 15), rendered synchronously from
the cached preference; path liveness probed asynchronously with a
short timeout (start: 500 ms) so a dead network mount cannot freeze
the menu; entries confirmed missing grey in place with a remove
affordance; exposed as `project.recent_list`. **Derivation:** FP-D10
rule (installation state); X4 (rib-civil.md §3 W1 project switching);
X1 (a hung UI on a sleeping drive is an availability defect);
design-system empty-state rule. **Rejected:** silently pruning missing
paths (a user's unplugged archive drive would erase their history);
synchronous stat on open (the freeze the finding names).
**Tunable:** yes — cap and probe timeout.

**FP-D13 — Archives never open in place.** **Decision:** §1.2 unpack
flow. **Derivation:** `docs/PROJECT-FORMAT.md` (working directory vs
archive contract; staging + validated publication).
**Rejected:** transparent in-place archive mounting (a second, slower,
lock-incompatible working mode). **Tunable:** no.

**FP-D14 — Queued follow-ons.** **Decision:** keep one backlog per completion
discipline: PDF scale-true export and DWG export (rib-civil.md §2.10,
§5 File); LAS/E57 point-cloud export (realworks.md §2.9 — the largest
honest gap in the current exporter set); synthetic (non-passthrough)
IFC, GeoTIFF, and splat writers (§1.6); list/report output
(rib-civil.md §2.9); Publisher-style viewer package and WeltView
publish flow (realworks.md §2.9); project **templates** (rib-civil.md
§3 W1 Dateivorbelegung — the export-preset half is promoted, FP-D17);
auto-cadence snapshots (FP-D4 tunable, off); selective undo of a
non-latest command as a surface (FP-D11); a cloud-sync-folder warning
for live project directories (review finding 16 idea).
The ui-platform-queued **"apply answers to similar imports"** item is
recorded as a hand-off to the **import-formats specification** (ui-platform
§1/§3.5 A3, registry §4.2 F3); this file-project spec does not specify it.
**PhotoLab share-backs** (recorded here; PhotoLab code is untouched by
this spec): fix the combined `['openFile','openDirectory']` dialog
(`apps/photolab/electron/main.ts:1159` — non-functional outside macOS;
review finding 4); rename `photolab.project.snapshot` to a
`project.state`-style name so "snapshot" means one thing family-wide
(finding 15); migrate PhotoLab to the D1 journal-implicit lifecycle —
its explicit save/autosave is now the divergent sibling (finding 5);
MRU and snapshot naming once Builder ships them (A3).
**Derivation:** `docs/CURRENT-DIRECTION.md` completion discipline —
these are catalog items, not defects in this spec's workflows.
**Rejected:** bundling now. **Tunable:** no.

**FP-D15 — Attach checks CRS/units and carries a journaled placement
transform** (new per review finding 2). **Decision:** §1.7 — identical
CRS/units → identity; different or missing → refuse with the mismatch
named and an explicit choice (transform interpretation, or
attach-at-identity stated as such), recorded on the reference; every
reference carries a placement transform (identity default), edited by
the shared Select/Edit SE-D1 gizmo with numeric twins and a translate/rotate-
only adapter, settable via
`project_reference.set_placement`. **Derivation:** X1 and
`docs/PROJECT-FORMAT.md` safety invariant ("never silently transform
coordinates or units" — and its dual: never silently _not_ transform
when frames differ); C1 (gizmo ↔ numeric); X3 (placement is
deliberate, restorable state). **Rejected:** silent identity attach
(two correct surveys, silently misaligned — the finding's blocker
scenario); silent automatic reprojection (violates the invariant
verbatim); no placement transform (dead-ends every
non-georeferenced source). **Tunable:** no.

**FP-D16 — Storage stewardship is a first-class surface** (new per
review finding 9). **Decision:** Settings · Project · Storage shows
size by category and offers preview-then-run "Clean up unreachable
data": explicit, journaled, long-running with progress/cancel,
removing only content unreachable from any journal state, snapshot, or
reference, including IF-D4 re-import baselines, PE-D7 capture artifacts,
measurement provenance, and Agent batch/transcript roots; automation
`project.maintenance.describe/run`.
**Derivation:** `docs/PROJECT-FORMAT.md` (GC is explicit, never
implicit, only unreachable); X1 (a "cleanup" that could eat a
snapshot's data is corruption with a button); X2 tolerates the growth
but not the opacity — disk is spent for speed, and the user deserves
the ledger. **Rejected:** automatic background GC (violates the
explicit-GC rule and can race archives); no surface (sends users into
store internals with a file manager). **Tunable:** yes — the category
breakdown granularity.

**FP-D17 — Named export presets are canonical entities** (promoted
from review idea 18; P1-class). **Decision:** §1.6 — scope rule,
format, options, and target pattern under a name; canonical, journaled,
archived, automation-visible; `io.export.plan` accepts a preset; stale
presets reopen setup with the offending field marked.
**Derivation:** P1 (deliberately created, wanted back — the weekly
deliverable is the class case); X3; X4 (rib-civil.md §3 W1
Dateivorbelegung — per-project reusable I/O presets are established
reference behavior); cheap by construction on the plan/execute split.
**Rejected:** preferences-file presets (invisible to automation and
lost to the archive — the exact class P1 forbids);
silent nearest-match execution of a stale preset (an unreviewed lossy
export). **Tunable:** no.

**FP-D18 — Open splits into directory picker and archive picker; both
paths also accept drag-drop** (new per review finding 4).
**Decision:** §1.2. **Derivation:** platform fact — Electron honors
`['openFile','openDirectory']` only on macOS, so one combined dialog
is a defect on the other platforms (PhotoLab's live instance:
`apps/photolab/electron/main.ts:1159`, share-back in FP-D14); X1
(a picker that cannot pick is broken reachability). **Rejected:** one
combined dialog (works only on macOS); a custom in-app file browser
(design system keeps file selection OS-owned). **Tunable:** no.

**FP-D19 — Persistence never interrupts continuous interaction; every open
marks its session boundary.** **Decision:** continuous gestures journal once
at gesture end and never per frame; journal appends use asynchronous group
commit off the UI/render thread; heavy immutable content and derived work are
written by explicit background, coalesced, cancellable progress-reporting
jobs; and the stored indicator follows acknowledged durability, with
"Storing…" while pending and the FP-D2 failure
state on error. Runnable gates on interaction-tier hardware are: gesture-end
to durable group-commit acknowledgement ≤ 100 ms p95; zero journal writes
during a scripted drag (then exactly one group-eligible append at gesture
end); and durability acknowledgement to truthful indicator update ≤ 50 ms
p95. Every successful project open creates the §1.4 "Session start" snapshot
before commands are accepted. **Derivation:** P5 (persistence cost never
occupies the interaction path); D1's 2026-09-02 non-interruption guarantees;
X1/X2 (durability remains correct while interaction stays fast); X6/P3
(agents choose and tune gate values). **Rejected:** synchronous appends on
the UI/render thread (input stalls); per-frame gesture journaling (unbounded
write amplification); writing heavy datasets on ordinary edits (classic-save
cost under another name); an optimistic stored indicator (false durability);
no open-time marker (makes the named session-recovery outcome needlessly
manual). **Tunable:** yes — 100 ms p95 and 50 ms p95 are initial X6 values,
to tighten with measured tier evidence; zero mid-drag writes, one gesture-end
append, and truthful indicator semantics are not tunable. The 100 ms value
keeps normal acknowledgement inside the UI platform's instant-response class;
50 ms keeps post-acknowledgement truth propagation well below the progress-
indicator threshold.

**FP-D20 — Every long-running file/project operation uses UIP-D10's shared
job lifecycle.** **Decision:** archive pack/unpack, export execute, attach
bake/re-sync, bulk restore/undo, maintenance cleanup, and large-project open
register in the main-process UIP-D10 registry. Their operation-specific
surface may show progress, but the persistent chain is status-bar chip →
shared jobs island → per-job cancel → completion/failure toast → console;
closing a launching surface never orphans progress or cancellation.
**Derivation:** UIP-D10 (every long-running feature registers or fails
review); SYSTEM-001 (execution owner and lifecycle owner must match);
`docs/DESIGN-SYSTEM.md` progress/cancellation contract. **Rejected:**
feature-local progress only (closing or renderer reload can orphan the job);
console-only progress (not discoverable); a second file-domain job registry
(split ownership and drift). **Tunable:** no — UIP-D10 owns its chip debounce
and toast timing calibrations.

## 4. Current implementation delta

**Exists and stays:** the canonical store with exclusive lock,
hash-framed journal, transactional publication
(`crates/himmelcad-sidecar/src/canonical_project_store.rs:259,354`);
core undo/redo with compensating transactions
(`crates/himmelcad-core/src/canonical_document.rs:468,491`);
`canonical.project.open/close` RPCs (`main.rs:1385`); the full archive
machinery with phases, progress, cancel, atomic publication
(`project_archive.rs:84–258`) — today called only by PhotoLab RPCs
(`project_runtime.rs:1307,7782`); the complete export backend:
registry of 5 exporters (`himmelcad-io/src/lib.rs:113`),
`io.formats.page`, `io.export.plan/execute`,
`io.operation.status/cancel` (`main.rs:1927–2084`), namespaced loss
codes with plan parity; the PhotoLab preferences service as the pattern
(`apps/photolab/electron/preferences.ts`); the ribbon buttons
themselves (`ribbon.ts:44–56`).

**Changes:** Electron main drops the fixed-root assumption
(`main.ts:36,446,649,817` — `defaultCanonicalProjectRoot` becomes
fallback-only; the `hcad-project://` protocol and residency handlers key
on the _open_ project root); ribbon ids move `project.*` → `file.*`
under the D2 File tab and the dead Save button becomes the working visible
`file.save` split control (FP-D2); the
`App.tsx` catch-all (`App.tsx:450`) gains real handlers; export UI maps
user scope onto packages (FP-D6 backend extension in
`canonical_app_runtime.rs:438`); Builder gains a preferences service
(pattern copy, Builder-scoped keys: projects/export directories, MRU,
last project). **Archive generalization:** the Builder canonical store
writes no `manifest.json`, and `pack_hcadx`/`unpack_hcadx` currently
validate a _PhotoLab_ manifest (`project_archive.rs:526` requires
`PhotolabProjectManifest`) — Save As and Open-archive need the
canonical store to publish the `docs/PROJECT-FORMAT.md` manifest and
the archive validation to accept it; this is the largest single delta
item in the domain. Switching projects also needs an explicit
`canonical.project.close` before `open` (`canonical_app_runtime.rs:118`
rejects a different root with ProjectAlreadyOpen; Builder today never
calls close — the lock is released only by process death).

**New:** New/Open/Recent flows and dialogs (Builder-side `dialog:*` IPC
already exists for import/transform, `main.ts:740` — extended for
project paths); `project.flush` with asynchronous group-commit acknowledgement,
truthful stored/storing/failure states, and File/shortcut/console/automation
wiring; Save As over `pack_hcadx_with_cancel` via new Builder RPC; snapshot
entity + `snapshot.*` journaled command set, automatic "Session start" marker,
and island;
restore as compensating bulk transaction with safety snapshot; undo/redo
sidecar RPCs + ribbon/shortcut/automation wiring with named tooltips
(`journal.read` already exposes the journal to automation); project
reference entity (new `GeometryObject` kind beside `Block`,
`entity_model.rs:1080`, plus `BuiltInEntityType` variant, validation
arms, and regenerated TS bindings, schema-versioned per
`docs/PROJECT-FORMAT.md`), attach/detach/resync/set-display commands,
cross-project prepared-dataset streaming (a new residency branch —
today the renderer handles only `potree@2` datasets and canonical
packages, `App.tsx:1385`), stale/unresolved states — the overrides
reuse render plumbing that exists view-local today
(`RenderStyle`/`ColorMode::{Uniform,Source}`, `setEntityStyle`;
`himmelcad-render/src/render_world.rs:231`,
`KernelViewerSession.ts:623`), so canonicalizing the override is the
new part, not the rendering;
export island (two-step) with loss rendering and named preset entities
(FP-D17); CRS/units comparison at attach plus the journaled placement
transform over the platform gizmo (FP-D15); archive packing of
host-resident attach bakes with the Save As disclosure (FP-D7);
settings window framework with project-scope canonical settings
commands, global preferences surface, the non-journaled project
view-state scope (FP-D10), and the Storage page with
preview-then-run unreachable-data cleanup (FP-D16); journal-append
failure detection feeding the indicator's error state and command
rejection (FP-D2); UIP-D10 registration for every long-running operation
(FP-D20); the persistent undo/redo quick-access strip with Ctrl+Y redo alias
(FP-D11); `project.info` /
`project.recent_list` / `io.export.formats` / `io.export.preset.list` /
`project.maintenance.describe` automation queries; status-bar stored
indicator with failure state.

### 4a. Disposition — spec review (2026-09-01, findings 1–19)

| #   | Finding                                                            | Disposition                                                                                                                                                           |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Restore erases its own safety snapshot; scope undefined            | Snapshot-exempt restore scope defined: §1.4, C4, FP-D4; tests §5                                                                                                      |
| 2   | Attach: no CRS/units contract, no placement                        | FP-D15; §1.7 refuse-on-mismatch + journaled placement with gizmo/numeric twins; C1; tests §5                                                                          |
| 3   | Bake residency/archive travel unspecified; §1.5/§1.7 contradiction | FP-D7 revised: bake in host store, revision-keyed, archived, Save As disclosure; missing source renders last bake; §1.5, §1.7, E2                                     |
| 4   | Combined file+dir dialog impossible on Win/Linux                   | FP-D18 split pickers + drag-drop; §1.2, catalog; PhotoLab fix queued FP-D14                                                                                           |
| 5   | "Match PhotoLab" untenable — opposite lifecycle                    | A3 rewritten with verified semantics; match narrowed; PhotoLab lifecycle migration queued FP-D14                                                                      |
| 6   | Ctrl+S unhandled                                                   | Initially resolved as affirmation + double-press snapshot; superseded by the 2026-09-02 owner correction in §4b: FP-D2 now makes Ctrl+S the real `project.flush` path |
| 7   | Undo/Redo only on File tab                                         | FP-D11 revised: persistent quick-access strip, every tab; §1.8; reported as vetoable derived decision                                                                 |
| 8   | Stored indicator has no failure state                              | FP-D2 revised: loud NOT-stored state + command rejection; §1.3, E1 criterion 5; injected-failure test §5                                                              |
| 9   | No disk-space stewardship                                          | FP-D16 `file.maintenance`; §1.9 Storage page; catalog row; tests §5                                                                                                   |
| 10  | Undo of bulk restore misclassified                                 | D1: bounded → long-running with inline progress; §1.4                                                                                                                 |
| 11  | Recent-list liveness can block on dead mounts                      | FP-D12 revised: cached render + async probe with timeout; §1.2                                                                                                        |
| 12  | Unknown loss codes; all-disabled empty state                       | §1.6 raw-code rendering + empty-state sentence; E1 criterion 3                                                                                                        |
| 13  | Third settings scope unnamed                                       | FP-D10 revised: project view state named; §1.9, C4                                                                                                                    |
| 14  | E1 references overreach                                            | E1 rewritten: written criteria are the primary artifact                                                                                                               |
| 15  | `snapshot.*` naming collision with PhotoLab                        | PhotoLab RPC rename queued FP-D14; A3 states the two meanings                                                                                                         |
| 16  | File-manager copy semantics unstated                               | §1.5: recoverable journal prefix; Save As is the live backup; cloud-sync warning queued FP-D14                                                                        |
| 17  | Quit/switch during running operations                              | E2: one prompt naming operations; automation gets named rejection; tests §5                                                                                           |
| 18  | Named export presets (idea)                                        | **Promoted**: FP-D17 canonical preset entities; §1.6, catalog, C4; tests §5                                                                                           |
| 19  | Snapshots list context (idea)                                      | Adopted: "N commands since (last: …)" from the journal; §1.4                                                                                                          |

### 4b. Disposition — owner correction 2026-09-02 / registry reconciliation

| #   | Correction / finding                                                               | Disposition                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Owner D1 + P6: retain visible Save and give Ctrl+S an honest effect                | FP-D2 superseded its no-Save clause; catalog adds `file.save` → `project.flush`; §1.3 defines verified flush/affirmation and the Save snapshot/Save As dropdown; B1/B2, E1, delta, and §5 aligned                                 |
| 2   | Owner D1 + P5: persistence must not interrupt work; add open-time recovery marker  | FP-D19 records async group commit, zero mid-drag writes, 100 ms commit-latency p95 and 50 ms indicator-lag p95 tunables; §1.4/catalog add automatic "Session start"; D1 and §5 carry the runnable gates                           |
| 3   | Registry F3: ui-platform's "apply answers to similar imports" hand-off was dropped | FP-D14 now records the hand-off to the **import-formats specification** by name and deliberately does not specify it                                                                                                              |
| 4   | Registry F7: file-project long-running work lacked UIP-D10 registration            | FP-D20 and D1 require archive pack/unpack, export, attach bake/re-sync, bulk restore/undo, maintenance, and large open to use the main-process registry with chip → jobs island → cancel/toast/console; narratives and B2 aligned |
| 5   | Registry F9: Ctrl+Y was unassigned                                                 | Shortcut table, catalog, §1.8, and FP-D11 claim Ctrl+Y as an alias of Ctrl+Shift+Z for `document.redo`; §5 verifies both paths                                                                                                    |

## 5. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** Rust unit tests — snapshot create/rename/delete/restore
  journal round-trip; successful open creates exactly one "Session start"
  marker at the recovered open-time generation before later commands, and
  automatic-marker retention follows the stated policy; **restore preserves
  every snapshot including the just-created safety snapshot** and
  restore-then-undo round-trips to
  the pre-restore state bit-for-bit (FP-D4/finding 1);
  restore-of-restore; retention GC touches only auto-snapshots;
  project-reference attach/detach/set-display/set-placement/resync
  round-trip; **CRS/units-mismatch attach is refused with the mismatch
  named, and the recorded transform choice round-trips** (FP-D15);
  placement transform journal round-trip and undo; self/cyclic attach
  rejection; missing-source open yields the last bake read-only (never
  drops, never re-bakes); bake retention while referenced by undo
  history; selection-scoped export package assembly (FP-D6); loss-code
  completeness per exporter fixture; export-preset entity round-trip
  and stale-preset validation failure (FP-D17); maintenance preview
  equals subsequent run, and cleanup can never remove content
  reachable from any journal state, snapshot, or reference (FP-D16);
  recent-list MRU cap and missing-path retention; preferences schema
  parse/fallback (pattern parity with PhotoLab tests); undo/redo RPC
  over `commit_undo`/`commit_redo` including
  CommandAlreadyUndone/NotUndone errors; `project.flush` drains all pending
  group commits, returns only an acknowledged durability time, and propagates
  append/flush failure without a success result.
- **changed:** component tests — New island path preview and
  occupied-target disable; export island step-2 loss rendering incl.
  lossless copy, **unknown-code raw rendering, and the
  all-formats-disabled empty state** (finding 12); preset dropdown and
  save-as-preset flow; snapshots island Enter-commit/Escape-revert and
  the "N commands since" line; recent menu renders instantly from cache
  while a probe against a hanging path times out without blocking
  (finding 11); stale and unresolved badges; undo tooltip names target
  command; visible File-tab Save split button, primary-action and dropdown
  routing, and stored/storing/failure indicator + toast copy; Ctrl+Shift+Z and
  Ctrl+Y both dispatch `document.redo`.
- **push (risk-triggered by electron/sidecar/store paths):** integration
  — open/close/reopen cycle restores exact state incl. project view
  state; second-process open rejected by lock with named message;
  archive pack cancel leaves existing archive intact; unpack
  cancel/failure leaves no half-project; archive round-trip carries
  attach bakes and the recipient renders/measures them without the
  source (FP-D7); export execute cancel publishes no partial file;
  **Ctrl+S during a pending group commit completes the durability flush and
  only then shows `All changes stored · <time>` with the acknowledged time;
  Ctrl+S with a failed journal keeps the loud failure state and never shows
  "stored"** (FP-D2); injected journal-append failure flips the indicator to
  the error state and rejects further commands (finding 8); quit/switch
  during a running export prompts once and an automation-initiated
  close receives the named rejection (finding 17); each file/project
  long-running class (archive pack/unpack, export, attach bake/re-sync, bulk
  restore/undo, maintenance, large open) registers in UIP-D10, survives
  launching-island close and renderer reload in the chip/jobs island, and its
  cancel path still works without partial publication (FP-D20);
  the undo/redo strip is present and enabled-consistent on every
  ribbon tab (finding 7); crash-sim (kill between ready-boundary
  phases) recovers per store contract; project close cancels running
  tools and revokes automation sessions.
- **push, interaction-tier performance:** scripted pointer drag over the tier
  dataset records zero journal writes before pointer-up and exactly one
  group-eligible append at gesture end; across the run, gesture-end → durable
  acknowledgement is ≤ 100 ms p95 and acknowledgement → correct indicator
  state is ≤ 50 ms p95 (FP-D19; both values tunable under X6). The harness
  fails on UI/render-thread blocking, fabricated acknowledgement, or any
  mid-drag append.
- **release, capability `real-data`:** archive round-trip on a real
  large project (pack → unpack → open → byte-identical canonical
  objects, snapshots and references intact); attach of a real prepared
  project renders and measures against baked datasets; re-sync after a
  real source edit shows no stale mix.
- **automation:** SDK parity — every catalog command/query callable,
  including `project.flush`; Ctrl+Y/Ctrl+Shift+Z command parity asserted;
  scripted end-to-end: create project → import → edit → flush pending commit
  and assert its acknowledged generation → snapshot → destructive edit →
  restore (asserting snapshots survive) → save export preset → export DXF via
  preset with loss assertions → attach second project → set placement →
  restyle → detach; runs under the deduplicated SDK gate.
- **manual/visual:** screenshots of the six E1 criteria, both themes,
  at implementation review, compared against the written E1 criteria and
  shared design tokens.

Explicitly unverified: subjective legibility of loss sentences beyond
E1 criterion 2 (copy review only); the 100 ms commit-latency p95, 50 ms
indicator-lag p95, 300 ms progress threshold, and retention numbers (tunable
calibration, X6); cross-product archive
compatibility with future PhotoLab schema versions beyond the fixture
matrix (`docs/PROJECT-FORMAT.md` fixture rule covers supported
boundaries).

## 6. Owner-decision items

None. The domain's two structural questions were decided by the owner
before this spec and D1 was explicitly corrected on 2026-09-02 (D1 lifecycle,
D5 project-as-block); every remaining choice — including all nineteen review
findings and the registry reconciliations in §4b — derived from X1–X7,
P1–P6, D1/D5, `docs/PROJECT-FORMAT.md`, the design system, UIP-D10, or
dossier evidence, with rejections recorded in §3.
Three candidates were tested against the escalation protocol and
dissolved: "does Save As switch the working project?" — closed by the
archive's format contract (FP-D3); "may automation share the user's
undo stack?" — closed by X3 plus the single-command-authority rule
(FP-D11); "is the missing point-cloud exporter a blocker for the Export
UI?" — closed by completion discipline: the UI ships over the real
registry and the gap is queued visibly (FP-D14), not papered over.
One decision is flagged for easy veto rather than asked: the
persistent undo/redo quick-access strip (FP-D11) touches ribbon-level
chrome beyond the File tab; it stays within D2's letter (D2 fixes tab
taxonomy, not the strip), so per the doctrine it is decided and
reported, not escalated — the owner reads it in §1.8 and can veto it
in one line.

## Cross-spec reconciliation 2026-09-02

| Item                      | Disposition                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Import/Raster             | `file.import` is partial and links IF-D12; plain images/sidecars remain staged until Raster RA-D13/`raster.georeference.apply`, with no invented placement.                                                                                            |
| Shared gizmo              | FP-D15 consumes Select/Edit SE-D1 with a translate/rotate-only project-reference adapter.                                                                                                                                                              |
| Reports                   | FP-D5/FP-D6 admit MI-D8 measurement CSV and MT-D20 volume CSV through one plan/execute surface.                                                                                                                                                        |
| Restore/reachability      | FP-D4 includes Plan/Measurement state; FP-D16 protects PE-D7 captures, IF-D4 re-import roots, measurement provenance, and Agent roots.                                                                                                                 |
| Agent                     | FP-D11 adopts AG-D14 batch roots; FP-D5 adopts AG-D17 publication identity.                                                                                                                                                                            |
| PhotoLab product datasets | IF-D23 defines snapshot Import rather than D5 Attach; IF-D21 defines Save As `.hcadx` as the WeltView parity artifact; IF-D24 supplies the non-mutating source-package reader; FP-D5 consumes IF-D25's provenance-preserve/loss-or-refuse export rule. |
| Doctrine P11              | FP-D5 exposes `io.export.*` from the one generated command table; no raw-RPC allowlist is a File exposure mechanism and confirmation grants remain user-only.                                                                                          |
| P10/G12 persistence       | FP-D22 round-trips MT-D25 plus DR-D20/CIV-D15/RA-D15/BS-D24 typed payloads, last-good/recipe/undo roots and explicit export loss; File never regenerates them.                                                                                         |
| Semantic cursor           | File/Attach cites UIP-D24/§9.7 and declares move/rotate handles, prohibited, and wait for attached-project placement; it has no Shared3DTarget.                                                                                                        |
| GAP §6 Civil inbound      | FP-D4–FP-D6/FP-D11/FP-D16 are amended by FP-D22 citations to CIV-D2–CIV-D16/CIV-D23 for persistence, archive, restore, reachability, and export-loss behavior.                                                                                         |
| Re-walk 2026-09-02        | Complies with P5/P6 and current C4/D1/X3/B1/A2 rules through FP-D19, real Save/Ctrl+S, snapshot-exempt restore, extreme budgets, and one-step Agent undo. No office convention is mandated (P7).                                                       |

## Owner statements batch 2 — 2026-09-02

This section amends FP-D4–D6/D10/D11/D16. Ctrl+Z/Ctrl+Shift+Z traverse only the
document journal, including one-root Agent batches. Selection, Display, and Camera
histories persist/restore as independent local-state streams with bounded depth and
their own actions; they never become document commands. Corruption or incompatible
local history resets only that stream and records the reason.

Project save/archive/migration/reachability now admits Civil entities/recipes/views,
VD-D15 section definitions, MT-D25 surface recipes and draft/checkpoint roots,
MT-D27 solids, RA-D14 difference Grids/legends, BS-D25 stratum sets, and every
linked/detached recipe state. GC protects last-good products, provenance recipes,
undo/snapshot roots, and resumable checkpoints until their owning reachability ends.
Export loss plans name unsupported Civil circular vertical segments, slopes,
sections, solids, dependency links, difference Grids/legends, and strata rather
than flattening silently.

**FP-D21 — Four undo paths persist without four Ctrl+Z meanings.** **Decision:**
document history and the three local histories have independent storage, restore,
queries/actions, and corruption scope. **Derivation:** P8, X3, X5, UIP-D19,
VD-D14, SE-D19, FP-D10/FP-D11. **Rejected:** a mega-history; discarding local
recoverability on reopen; focus-routed Ctrl+Z. **Tunable:** local history depth and
coalescing.

**FP-D22 — Derived-domain state is first-class lifecycle data.** **Decision:** the
types, recipes, local histories, last-good products, checkpoints, archive behavior,
and explicit export losses above extend FP-D4–D6/D16. **Derivation:** P10, X1, X2,
MT-D25–D27, VD-D15, RA-D14, BS-D25, Civil CIV-D2–D14. **Rejected:** provenance-
free flattening; GC of reachable regeneration/checkpoint data; silent export loss.
**Tunable:** archive/checkpoint compaction thresholds.

Verification adds four-history round trips and isolated corruption, old/new archive
migrations, missing/unknown recipe versions, linked/detached/auto-detached recovery,
checkpoint resume/discard, reachability/GC, and per-format loss-plan fixtures.

| Work-order item                                             | Disposition        |
| ----------------------------------------------------------- | ------------------ |
| S3/G2 document-vs-local history boundary                    | Applied by FP-D21. |
| S7–S11/P10 persistence, archive, checkpoints and loss plans | Applied by FP-D22. |
