# Draw ribbon tab — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; DR-D22's executable gates remain unimplemented and unverified. Revised 2026-09-02
after the adversarial review of owner-statements batch 2 (disposition in §10);
previously specified at contract level for the full catalog and workflow level for
polyline drafting, layer management, drawing on clouds, and dimensioning after the demanding-user spec review
(`draw-spec-review-2026-09-01.md`, findings 1–20 — disposition table in
§9) and after the cross-spec reconciliation with the BIM/specifications
domain (bim-specs review finding 1, resolved in BIM's favor — DR-D7).
Document class: plan. Walks `docs/FUNCTION-CONTRACT.md` including the
2026-09-01 additions (code-claim file:line rule, per-dossier-row catalog
disposition, input-gesture arbitration, extreme-class members); every
consequential choice carries a `docs/DECISION-DOCTRINE.md` decision
record. Ribbon placement follows owner decision D2
(`docs/builder-program/OWNER-DECISIONS.md`): the **Draw** tab is one of
the domain tabs File / View / Pointcloud / Draw / Mesh / BIM / Raster.

Primary reference evidence: `docs/builder-program/dossiers/rib-civil.md`
(RIB Civil / STRATIS is the named CAD/civil reference per contract A2).
Secondary: `dossiers/revit.md` §2.4 (repetition mechanisms, for the
specification-consumption boundary), `dossiers/realworks.md` §2.6/§2.8
(drawing on clouds). Data-model grounding:
`crates/himmelcad-core/src/entity_model.rs`; view-mode grounding:
`docs/adr/0022-shared-3d-2d-and-2-5d-view-modes.md`; platform gesture and
Escape grounding: `specs/ui-platform/ui-platform.md` (UIP-D1/D2/D5/D14).

The RIB F5-Box norm — "every mouse construction has a numeric twin"
(rib-civil.md §2.2 F5-Box, §4 design lesson 1) — is contract question C1
made law for this entire domain: no tool in this catalog is specifiable
without its typed twin, and the twin is one shared mechanism (DR-D1), not
a per-tool afterthought.

## 1. Scope and boundaries

In scope: drawing primitives on the canonical entity types (point, curve —
line/polyline/arc/circle/clothoid, area, text, dimension incl. chains,
label), post-commit drafting edits (vertex grips, text content, dimension
placement), the drafting snapping system, the shared construction input
bar and cursor readout, construction aids (offset, trim/extend, fillet,
divide — catalog level), layer management (the left-panel Layers tab),
drawing on point clouds and terrain in 2.5D incl. height assignment, the
_consumption_ side of generative specifications (point symbols,
spacing-based area fills, owner decision D3), and alignments at catalog
level (create-from-curve, stationing).

Explicit boundaries:

- **Symbol/specification authoring — and the placed object itself — are
  BIM-domain.** Draw provides _access paths_ to placement; the placed
  symbol or fill is an entity of its definition's canonical kind carrying
  a specification component, per the reconciled model (DR-D7; bim-specs
  BS-D4/D5/D6). Defining symbols, parameters, and spacing rules (the
  Revit-family analog, revit.md §1, §2.4) belongs to the BIM/
  specifications domain spec. Reconciliation recorded on both sides
  (bim-specs review finding 1, 2026-09-01, resolved in BIM's favor).
- **Alignment engineering semantics are Civil-owned.** Element-wise
  axis construction and naming (rib-civil.md W3) remain fully draftable with
  this catalog (DR-D8). Civil CIV-D2–D14 now owns best-fit/classic alignments,
  bands, gradients, corridors, slopes/pits, profiles, station labels, and
  station/offset semantics, including the chainage/equation identity of
  CIV-D15/CIV-D16; Draw supplies primitives, snaps, support geometry,
  and ordinary point/curve commits. Civil dossier rows outside that admitted
  scope remain Civil backlog rather than a Draw deferral. `hcad.alignment@1`
  (`entity_model.rs:946-959`) and LandXML alignment import
  (`landxml.rs:484-486, 603-663` — Line/Curve/clothoid-Spiral, vertical
  profiles) exist, so catalog-level creation writes into a proven model.
- **Whole-entity transforms** (move, copy, rotate — rib-civil.md §2.1
  Kopieren/Rotieren/Verschieben) operate on any selection and belong to a
  **select-edit domain spec, registered as owed in `REGISTRY.md`** — a
  named obligation, not a pointer into fog (review finding 7). The
  journaled transform command layer exists
  (`entity_commands.rs:21-35` `TransformEntityCommand`). Vertex-level and
  content-level editing of drafted entities stays _here_ (draw.edit).
- **Paper-space drafting** stays plan-composer content per owner decision
  D4; everything in this spec is model space.

## 2. Function catalog

Surface legend: VT = viewport tool with shared construction input bar
(§4 B3) + right function panel for tool options; LP = left panel Layers
tab. Perf: cont = continuous, bnd = bounded. Status: GF = greenfield UI
over existing canonical type; entity types, journal, LandXML import, and
the kernel snap pipeline exist today (§6, all claims file:line).

| Id                    | Function                                                                                                                                                                                                              | Access paths                                                                                                                   | Surface                    | Perf                                | Automation command                                                                                                                | Status vs current                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draw.point`          | Point: pick/constrained pick/typed; visible modes **Point**, **3D target**, and **Point by station/offset**; intersection/perpendicular-foot placements via snap (rib-civil.md §2.1 Punkt, Schnittpunkt, Lotfußpunkt) | ribbon split button; console; automation; quick surface "Add point here"; selected-alignment context "Point by station/offset" | VT                         | cont preview, bnd commit            | `draw.point.create` with `mode=coordinate\|manual_3d_target\|neighbour_fit\|station_offset`                                       | GF over `hcad.point@1` (`entity_model.rs:26`); target/support/station components are new (§6)                                                                                                                                                                                                                                                |
| `draw.line`           | Line: free (AP-EP), tangent from point to curve (AP-TE), tangent between two arcs (TA-TE) (rib-civil.md §2.1 Gerade)                                                                                                  | ribbon; console; automation                                                                                                    | VT                         | cont preview                        | `draw.curve.create` (lineSegment)                                                                                                 | GF over `LineSegment` (`entity_model.rs:230-235`)                                                                                                                                                                                                                                                                                            |
| `draw.polyline`       | Polyline with line and arc segments, open/closed, join/reverse (rib-civil.md §2.1 Linienzug)                                                                                                                          | ribbon; console; automation; shortcut (registry)                                                                               | VT                         | cont                                | `draw.curve.create` (polyline/composite)                                                                                          | GF over `Polyline`/`Composite` (`entity_model.rs:237-242, 330-333`); mixed chains are `Composite` by design                                                                                                                                                                                                                                  |
| `draw.arc`            | Arc: 3-point, start-center-end, tangential couple onto element (TA-…), pivot (AP-TE-EP), buffer between two elements (TA-TE) with solution cycling (rib-civil.md §2.1 Bogen, §3 W3)                                   | ribbon; console; automation                                                                                                    | VT                         | cont                                | `draw.curve.create` (circularArc)                                                                                                 | GF over `CircularArc` (`entity_model.rs:244-251`)                                                                                                                                                                                                                                                                                            |
| `draw.circle`         | Circle: center+radius, 3-point                                                                                                                                                                                        | ribbon; console; automation                                                                                                    | VT                         | cont                                | `draw.curve.create` (circle)                                                                                                      | GF over `Circle` (`entity_model.rs:253-260`)                                                                                                                                                                                                                                                                                                 |
| `draw.clothoid`       | Clothoid connector line–arc / arc–arc; parameter, length, or A1/A2 fixable; Wendeklothoide (rib-civil.md §2.1 Klothoide)                                                                                              | ribbon; console; automation                                                                                                    | VT                         | cont preview                        | `draw.curve.create` (clothoid)                                                                                                    | GF over `Clothoid` (`entity_model.rs:302-315`); closes the author/import asymmetry with LandXML spirals (`landxml.rs:560-586`)                                                                                                                                                                                                               |
| `draw.area`           | Area/polygon: closed boundary + holes, from new sketch or existing curves (associative)                                                                                                                               | ribbon; console; automation; context menu on closed curves "Create area"                                                       | VT                         | cont                                | `draw.area.create`                                                                                                                | GF over `hcad.area@1` (`entity_model.rs:344-381`)                                                                                                                                                                                                                                                                                            |
| `draw.text`           | Text at anchor, world- or screen-sized                                                                                                                                                                                | ribbon; console; automation                                                                                                    | VT                         | bnd                                 | `draw.text.create`                                                                                                                | GF over `hcad.text@1` (`entity_model.rs:980-1002`); glyph-atlas layout exists (`himmelcad-render/src/text.rs:1-22`)                                                                                                                                                                                                                          |
| `draw.dimension`      | Dimension: linear, aligned, angular, radius, diameter, ordinate, and **chain mode** (Maßketten — sequential anchors, one journaled command; rib-civil.md §2.1) — associative, value always derived                    | ribbon; console; automation; context menu on entities "Dimension"                                                              | VT                         | cont placement                      | `draw.dimension.create`                                                                                                           | GF over `hcad.dimension@1` (`entity_model.rs:1042-1070`); compiler reserves 2 parts and awaits host-resolved anchors/styles (`entity_compiler.rs:179-182`)                                                                                                                                                                                   |
| `draw.label`          | Label with leader, associative anchor                                                                                                                                                                                 | ribbon; console; automation; context menu "Label"                                                                              | VT                         | cont placement                      | `draw.label.create`                                                                                                               | GF over `hcad.label@1` (`entity_model.rs:1026-1036`); leader slots compile, text path missing (`entity_compiler.rs:179`)                                                                                                                                                                                                                     |
| `draw.edit`           | Post-commit drafting edits: curve vertex grips, text content double-click edit, dimension/label placement drag (review finding 7)                                                                                     | context menu "Edit"; double-click on drafted entity; console; automation                                                       | VT                         | cont                                | `draw.edit.apply`                                                                                                                 | GF; whole-entity transforms are the select-edit spec's (registered owed, §1)                                                                                                                                                                                                                                                                 |
| `draw.offset`         | Parallel/offset curve, linked by default, from a whole curve or eligible stable segment reference                                                                                                                     | ribbon; console; automation; context menu on curve/eligible segment; Properties recipe actions                                 | VT + Properties status     | cont preview; bnd→long regeneration | `draw.offset.apply`; common `derived.recipe.get/status/regenerate/detach/relink`                                                  | GF; Draw payload profile of `hcad.derived-recipe@1` is new (DR-D20/MT-D25)                                                                                                                                                                                                                                                                   |
| `draw.trim`           | Trim/extend curve to intersection; cursor-nearest end modified (rib-civil.md §2.1 Trimmen; one tool, both directions — X5)                                                                                            | ribbon; console; automation                                                                                                    | VT                         | cont preview                        | `draw.trim.apply`                                                                                                                 | GF (catalog level)                                                                                                                                                                                                                                                                                                                           |
| `draw.fillet`         | Arc fillet between two curves, typed/dragged radius                                                                                                                                                                   | ribbon; console; automation                                                                                                    | VT                         | cont preview                        | `draw.fillet.apply`                                                                                                               | GF (catalog level)                                                                                                                                                                                                                                                                                                                           |
| `draw.divide`         | Division points along a curve without splitting it (rib-civil.md §2.1 Teilungspunkte)                                                                                                                                 | ribbon; console; automation; context menu on curve                                                                             | VT                         | bnd                                 | `draw.divide.apply`                                                                                                               | GF (catalog level)                                                                                                                                                                                                                                                                                                                           |
| `draw.snap`           | Snapping system: per-source enables (authored/cloud/terrain), per-kind toggles, intent-aware precedence, candidate cycling, one-shot override, markers (DR-D2/D12/D13/D15)                                            | ribbon toggle group; shortcut toggles (registry); automation                                                                   | toggle group + markers     | cont                                | `draw.snap_config.get` / `set`                                                                                                    | Authored semantic-snap schema/store exists (`crates/himmelcad-render/src/cad_curve.rs:58-75`), builders emit it (arc example `:571-574`), refinement consumes it (`:324-340`), and ranking exists (`crates/himmelcad-render/src/picking.rs:492-500`); `Intersection` ranked but unproduced; perpendicular and terrain producers missing (§6) |
| `draw.input-bar`      | Shared construction input bar + cursor readout with per-step prompts: the numeric twin of every mouse construction (rib-civil.md §2.2 F5-Box, Tachobox)                                                               | always visible during any Draw tool                                                                                            | viewport bottom bar        | cont                                | (carried by each `draw.*` command's typed parameters)                                                                             | GF; current status bar shows **snap kind only** (`apps/builder/renderer/src/App.tsx:681-700`); coordinate/input bar is new                                                                                                                                                                                                                   |
| `draw.layers`         | Layer manager: create, rename, set current, set requested P9 state, draw-order reorder, assign selection, delete (rib-civil.md §2.3 Folien, Folienhierarchie)                                                         | left panel Layers tab; console; automation; context menu "Move to layer"                                                       | LP                         | bnd                                 | `layers.create` / `rename` / `set_current` / `reorder` / `assign` / `remove` / `list`; shared `interaction.state.get/set/preview` | Left-panel tab is a placeholder (`EntityTree.tsx:130-154`); `hcad.layer@1` (`entity_model.rs:24`) + `layer_ids` (`entity_model.rs:1216`) exist; requested P9 state/order/current are new (DR-D4)                                                                                                                                             |
| `draw.assign-heights` | Assign heights to plan-only geometry: drape on DGM/cloud, typed constant, interpolate between known vertices — closes the ADR 0022 admission loop (review finding 8)                                                  | context menu on plan-only entity; ribbon; console; automation                                                                  | VT + panel                 | bnd–long                            | `draw.assign_heights`                                                                                                             | GF; plan-only admission exists (ADR 0022), nothing assigns heights today                                                                                                                                                                                                                                                                     |
| `draw.symbol`         | **Access path** to point-symbol / along-curve placement from a specification (consumption of D3; DR-D7)                                                                                                               | ribbon; console; context menu                                                                                                  | VT                         | cont preview                        | `bim_object.place` (BIM-owned single command)                                                                                     | Access path only; entity model per bim-specs BS-D4/D5/D6                                                                                                                                                                                                                                                                                     |
| `draw.fill`           | **Access path** to spacing-based area fill from a specification (consumption of D3; DR-D7)                                                                                                                            | ribbon; console; context menu on area                                                                                          | VT                         | bnd–long                            | `bim_object.place` (BIM-owned single command)                                                                                     | Access path only; occurrences are derived data (BS-D5)                                                                                                                                                                                                                                                                                       |
| `draw.alignment`      | Alignment from curve: name + start station; stationing labels; auto-layer from the editable office template (shipped seed `Achse <name>`) (rib-civil.md §2.3 auto layer per Achse, §2.4 Achse erzeugen, W3; P7)       | ribbon; console; automation; context menu on curve "Create alignment"                                                          | VT + dialog                | bnd                                 | `alignment.create_from_curve` / `set_station_origin` / `list`                                                                     | GF UI; `hcad.alignment@1` + LandXML import exist (§1 citations)                                                                                                                                                                                                                                                                              |
| `draw.support-role`   | Support role for defining geometry (blue support points/lines) — get/set/clear                                                                                                                                        | X P C A                                                                                                                        | Properties + viewport cues | bnd                                 | `draw.support_role.get/set/clear`                                                                                                 | Not implemented — batch-2 (D7) capability; DR-D18                                                                                                                                                                                                                                                                                            |

All `draw.*`, `layers.*`, and `alignment.*` families resolve to the same
canonical journaled commands the UI uses, carried over the automation
envelope (`schemas/automation/himmelcad-automation-v1.schema.json`; the
canonical control plane serves UI and automation identically —
`app_protocol.rs:5`). Every `draw.*.create` command accepts an optional
explicit `layer` parameter (DR-D4). Naming follows the automation schema's
dotted lowercase snake_case segments (`view.state.get`,
`registration.preview.point_pairs`, `automation.entities.page`); each new
method carries a capability string and pinned contract sources, and adding
methods triggers the deduplicated SDK staleness gate
(`docs/TEST-TIERS.md`). Ribbon action ids follow the `tab.action`
convention (`apps/builder/renderer/src/ribbon.ts:37-156`); every ribbon
action is console-invokable through the `ribbon.<id>` bridge
(`App.tsx:667-668`).

### 2.1 Dossier catalog disposition (per contract A2)

Every Draw-relevant dossier row disposed — omissions are decisions:

| rib-civil.md row                                                | Disposition                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §2.1 Punkt absolut/relativ/polar                                | adopted — draw.point                                                                                                                                                                                                                                                                                                                                   |
| §2.1 Kleinpunkt / Achskleinpunkt                                | **Civil-owned disposition** — Civil §2.5/CIV-D15/CIV-D16 adopts the station/offset semantics; Draw contributes the `draw.point.create` access mode and does not disposition the dossier row again (DR-D19)                                                                                                                                             |
| §2.1 Schnittpunkt/Mittelpunkt/Tangentenschnittpunkt/Lotfußpunkt | adopted — draw.point + intersection/perpendicular/center snaps (DR-D2)                                                                                                                                                                                                                                                                                 |
| §2.1 Teilungspunkte                                             | adopted — draw.divide                                                                                                                                                                                                                                                                                                                                  |
| §2.1 Gerade AP-EP/TA-EP/AP-TE/TA-TE (m. Kloth.)                 | adopted — draw.line modes; clothoid insertion via draw.clothoid                                                                                                                                                                                                                                                                                        |
| §2.1 Bogen variants (couple/pivot/buffer, m. Kloth.)            | adopted — draw.arc modes with DR-D6 solution cycling                                                                                                                                                                                                                                                                                                   |
| §2.1 Klothoide                                                  | adopted — draw.clothoid                                                                                                                                                                                                                                                                                                                                |
| §2.1 Linienzug (Erzeugen/Verbinden/Umdrehen)                    | adopted — draw.polyline + join/reverse                                                                                                                                                                                                                                                                                                                 |
| §2.1 Kreis                                                      | adopted — draw.circle                                                                                                                                                                                                                                                                                                                                  |
| §2.1 Spline                                                     | deferred — no W1–W8 workflow uses splines; `Spline` exists canonically (`entity_model.rs:317-328`) so automation can author them; UI tool queued                                                                                                                                                                                                       |
| §2.1 Text, Maßketten, Flächen, Schraffur                        | adopted — draw.text, draw.dimension chain mode, draw.area, draw.fill (via `bim_object.place`)                                                                                                                                                                                                                                                          |
| §2.1 Trimmen                                                    | adopted — draw.trim                                                                                                                                                                                                                                                                                                                                    |
| §2.1 Kopieren/Rotieren/Verschieben/Nummerieren/Ändern           | out of domain — select-edit spec (registered owed, §1); draw.edit covers vertex/content edits                                                                                                                                                                                                                                                          |
| §2.1 UNDO                                                       | adopted — journal (C4)                                                                                                                                                                                                                                                                                                                                 |
| §2.2 Fangkreis, Punktauswahl, Tachobox, Mehrdeutigkeit          | adopted — snap radius, Up/Down candidate cycling, readout, DR-D6                                                                                                                                                                                                                                                                                       |
| §2.2 F5-Box                                                     | adopted — the input bar, DR-D1                                                                                                                                                                                                                                                                                                                         |
| §2.2 F4-Box (named-object selection)                            | deferred — pays off with named axes/profiles; queued with the alignment subsystem (DR-D8)                                                                                                                                                                                                                                                              |
| §2.2 Hilfspunkte                                                | **adapted** — explicit `hcad.component.support-role@1`, DR-D18/UIP-D21. Unlike RIB's number/code-less point outside the point database, Himmel:CAD keeps an ordinary canonical point/curve with an explicit role, permits number/specification, and preserves the role through project/fragment round trips; absence of metadata never implies support |
| §2.3 Folien, Folienhierarchie, Elemente zuordnen                | adopted — draw.layers                                                                                                                                                                                                                                                                                                                                  |
| §2.3 Spezifikation (F9 pen/spec tables)                         | adopted as D3 consumption — drafting-time styling, DR-D16                                                                                                                                                                                                                                                                                              |
| §2.3 HV-Planverwaltung                                          | adapted through P9 **Reference** — visible, selectable/snappable, not editable; Hidden/Editable/Inert and composed causes are Himmel:CAD extensions owned by UIP-D20/SE-D19 (DR-D4)                                                                                                                                                                    |
| §2.3 Darstellung options (per-plan display toggles)             | boundary — per-kind display toggles are View domain; layer nodes consume the shared P9 requested/effective-state model here                                                                                                                                                                                                                            |
| §2.4 Achse erzeugen (+ auto layer per element, §2.3)            | adopted — draw.alignment incl. auto-layer (finding 19)                                                                                                                                                                                                                                                                                                 |
| §2.4–§2.7 alignment/profile/corridor rows admitted by Civil     | other domain — Civil CIV-D2–D14; Draw retains primitive construction only (DR-D19)                                                                                                                                                                                                                                                                     |

## 3. Workflow narratives

### 3.1 Polyline drafting with snapping and numeric entry

The user has a georeferenced raster and a handful of imported survey
points and wants to trace a site boundary. In the **Draw** tab they press
**Polyline**. The button stays lit while the tool runs; the right panel
shows the tool options (segment type line/arc, close on finish, **target
layer** — captured at tool start and changeable only here, DR-D4), and
the construction input bar docks along the viewport bottom: a per-step
prompt ("Polyline — pick or type first vertex"), a live cursor readout
(X, Y, and Z when known — the Tachobox analog, rib-civil.md §2.2), and
the typed fields of the running construction.

They click near a survey point: the snap system catches it inside the
snap radius — the marker highlights the candidate, the readout names the
source ("Point 114") — and the first vertex lands exactly on it. For the
second vertex no geometry exists, so they simply start typing. After a
first point, an unprefixed digit activates **horizontal length** in the
cursor-derived polar representation. A field click or the explicit `X`, `Y`,
`Z`, `L`, `D`, `DZ`, or `S` prefix selects another editable field; there is
no locale-dependent guessing. Endpoint Cartesian and polar are exclusive
horizontal representations: the chosen representation is editable and the
other remains a live-calculated readout. Absolute Z, relative ΔZ, and slope
are an exclusive vertical-mode selector with the inactive forms
live-calculated. Enter on a complete Polyline endpoint places that vertex
view-locally and returns viewport focus; viewport Enter finishes the already
placed chain without accepting the rubber-band endpoint. The transition table in §3.5 is
authoritative; no "last writer wins" rule remains.

While candidates are live, **the Up/Down arrow keys cycle snap
candidates** — two survey points inside the radius are cycled in the
stable order GPU picking already produces
(`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:138-144,
460-465`, today bound to Tab — rebinding is a round-3 delta), the readout naming
the armed one (rib-civil.md §2.2 Punktauswahl); Tab always goes to the
bar (to switch, say, ΔZ to slope before typing) and traverses its fields
(DR-D1 focus model — no key is double-booked, DR-D14). Because the trace runs over a dense scan, authored-geometry
candidates outrank raw cloud points at equal radius while a drafting
tool is armed (DR-D12) — closing the polygon onto its own first vertex
works over a billion-point cloud; holding the one-shot override key
forces the cloud sample when the user wants exactly that.

A rubber band previews the pending segment at full frame rate. Backspace
removes the last vertex (tool-local). Toggling **Arc segment** makes the
next span an arc — tangential continuation of the previous segment by
default, 3-point as the alternative (rib-civil.md §2.1 Bogen tangential
attach; finding 17); the finished mixed chain commits as one `Composite`
curve. A **right-click** (sub-threshold, per UIP-D1/D5 discrimination)
opens the tool menu — Finish / Close / Undo vertex / Cancel — the
discoverable finish path (DR-D14). The user finishes with Enter, the
tool menu, or by clicking the first vertex (closing ring on its marker).

**A tool-end action and Escape's pending-geometry rung are distinct.** Enter,
**Finish**, **Close**, and ribbon re-toggle end the construction and commit a
valid chain (≥ 2 placed vertices); with fewer than two vertices they commit
nothing. Escape never accepts the live rubber-band endpoint: it discards only
that pending segment. If at least two vertices have already been placed, those
vertices commit as the construction and the tool remains armed for the next
one. For the single-segment **Line** tool, one placed point plus a rubber band
therefore cancels and publishes nothing; for a Polyline, two or more placed
vertices commit without the pending span. A later Escape, with no pending
construction, reaches the platform's armed-tool close rung (DR-D5). **Cancel**
from the tool menu explicitly discards all placed vertices after showing that
consequence. The commit is **one** journaled command creating
one `hcad.curve@1` entity on the captured target layer; the console logs
entity name, layer, vertex count, and length. Ctrl+Z removes the whole
polyline. Escape follows the platform ladder (UIP-D14), innermost first:
focused bar text reverts; an active constraint or handle drag restores the
preceding valid preview; pending geometry follows the one DR-D5 rule above;
only then can the armed tool close. The tool stays armed for repeated tracing
without a ribbon round-trip.

### 3.2 Layer management

The user opens the left panel's **Layers** tab — today a placeholder
(`EntityTree.tsx:130-154`), now the layer manager. It lists all
`hcad.layer@1` entities bottom-to-top in draw order (rib-civil.md §2.3
Folienhierarchie), each row with the shared UIP-D20 four-state control
(Hidden / Reference / Editable / Inert), effective-state/cause indicator,
name, entity count, and current-layer marker; the **Default layer** always exists,
is never deletable, and is where unassigned entities live (DR-D4). A
**New layer** button creates "Layer 2"; the name is immediately editable
inline. Double-clicking the row (or context menu → "Set current") makes
it current: every subsequently _started_ tool captures it as target
(DR-D4). Dragging rows reorders the draw stack; the viewport reflects
the new order immediately. The row stores exactly one requested P9 state,
never separate visibility and lock truth. UI Platform owns state presentation
and parent propagation (UIP-D20); Select/Edit's SE-D19 domain-neutral resolver
composes layer, entity, ancestor, kind, cloud-class, attachment, isolate, and
global-overlay causes. Draw render, pick/snap, and command preflight consume
that one effective result through domain-neutral `interaction.state.explain`.
The current proposed `selection.effective_state.explain` name is a deprecated
compatibility alias returning the identical result until round-3 schema migration;
it owns no selection-specific predicate. Hidden is not rendered/picked/snapped; Reference is
rendered, selectable, and snappable but rejects edits; Editable behaves
normally; Inert renders but is neither selectable, snappable, nor editable.

Draw enforces **exactly-one-layer semantics**: "Move to layer" replaces
the membership, never appends; an entity without a layer belongs to
Default (`layer_ids` is a `Vec` in the model, `entity_model.rs:1216` —
the invariant is command-layer, reserving the Vec for future overlay
memberships, DR-D4). Deleting a layer that still carries entities moves
them to Default in the same journaled step and says so in the console
("Layer 'Sketch' removed — 14 entities moved to 'Default'"); Ctrl+Z
restores layer, membership, requested state, and order. Create, rename,
requested-state changes, reorder, assign, and remove are journaled canonical
commands. **Setting
the current layer is persisted, automation-writable project state but
not journaled** — Ctrl+Z never flips which layer new work lands on
(DR-D10, the UIP-D3 class). All of it is equally available as `layers.*`
automation commands — an agent told "put all curbs on a Curbs layer and
hide the sketch layer" invokes the shared `interaction.state.set` and needs
nothing the UI does not have. Renaming
follows inline-edit conventions; Escape reverts. The Layers tab is a
persistent panel: drafting continues while it is open, and the captured
target layer is always visible in the tool options, so a
`layers.set_current` from automation mid-trace can never silently
redirect the running construction (DR-D4).

### 3.3 Drawing on clouds and terrain (2.5D)

The user has a scanned street and wants the curb line as a 3D breakline
for the terrain model. They switch the view to **2.5D** (View tab; ADR 0022) and start **Polyline**. The camera is the locked plan camera;
snapping runs through the same ranked kernel pipeline as everywhere else
— no second drafting path (ADR 0022 "single-source"; DR-D2). Hovering
the curb, the cloud sample under the cursor is offered (cloud snaps are
enabled by default in 2.5D, DR-D12); the readout shows X, Y, **and Z**.
Every committed vertex retains the snapped point's source height —
`Position.z` is per-vertex optional (`entity_model.rs:174-181`, "None
never implies zero"), so a vertex snapped to the cloud carries its
height while a vertex over a data hole stays `z: null` — and the bar
makes that state impossible to miss: the Z field shows the pending
vertex's acquisition **before** the click ("Z 34.120" vs "Z —"), and a
height-less pending vertex renders a visually distinct marker (finding
8). A **Require height** tool option refuses commits of height-less
vertices for breakline work. Typing a Z is the numeric twin of snapping
one.

Over a triangulated terrain the same workflow snaps to the surface
through the **new kernel terrain producer** — ray intersection against
the DGM in the ranked pipeline (DR-D13). The legacy `DgmSnapProvider` is
a stub ("STUB", `DgmSnapProvider.ts:6`) in the deprecated package
(`legacy.ts:1`) and counts as not existing (contract A2 code rule); it
is cited as design evidence only. The pattern is RIB's cloud digitizing
(rib-civil.md §2.6 Punktwolke app: "object-oriented digitizing in the
cloud") and RealWorks' cloud tracing (realworks.md §2.6 feature coding /
polyline drawing over the cloud; §2.8 profile and contour deliverables).

In **2D** the identical tool authors `z: null` vertices (ADR 0022: same
winner, XY only) — a purely planimetric trace. The consequence is
stated, not hidden: entities whose support positions lack Z are
plan-only — visible in 2D/2.5D, admitted to 3D only once heights exist
(ADR 0022). The loop is closed by **Assign heights** (draw.assign-
heights): drape the entity on a DGM or cloud, type a constant, or
interpolate between height-carrying vertices — one journaled command,
after which the entity appears in 3D (finding 8). The status readout
shows the acquisition mode ("2.5D — heights from geometry"); switching
modes mid-polyline changes acquisition for subsequent vertices only. The
finished curb polyline is an ordinary `hcad.curve@1` on its layer; the
Mesh domain consumes it as a breakline without conversion.

### 3.4 Dimensioning

The user needs the width of a drawn access road on the plan. **Draw →
Dimension**, kind **Linear** (kinds per `DimensionKind`,
`entity_model.rs:1042-1055`: linear, aligned, angular, radius, diameter,
ordinate — selected in the tool options or by context). They pick the
first road edge: the snap system offers the curve vertex (authored
geometry outranking the cloud beneath it, DR-D12); the pick stores an
**associative anchor** — entity id, primitive, parameter
(`AnnotationAnchor::Entity`, `entity_model.rs:1012-1023`) — not a frozen
coordinate. Second pick on the opposite edge, then a third click places
the dimension line; during placement the line, extension lines, and live
value preview follow the cursor continuously, and the input bar's twin
accepts a typed placement offset. **Chain mode** (Maßketten,
rib-civil.md §2.1) keeps picking: each further point extends the chain,
and Finish commits the whole chain as one journaled command with
per-point anchors (finding 11). The displayed value is **always
derived** from the anchors (`entity_model.rs:1057` "displayed value is
always derived") — there is no override field, because a dimension
showing anything but the measured truth is a falsified deliverable
(DR-D9).

When the user later moves the road edge, the dimension follows and the
value updates — associativity is revalidated through the anchor's
`expected_version`; if a referenced entity is deleted, the dimension
enters an explicit broken state (marked in viewport and properties,
listed in the console) rather than silently freezing a stale number.
Post-commit, dragging the dimension line re-places it and double-click
opens text entities for content editing (draw.edit, finding 7).
**Ordinate** dimensions annotate heights: picking a cloud-snapped vertex
writes a height dimension; picking a `z: null` vertex is refused with
the reason ("No height at this position"). Labels share the anchor model
and placement interaction. Dimension text uses screen-space sizing by
default so plans stay readable at any zoom; world-space is a style
choice (`TextSpace`, `entity_model.rs:980-985`).

### 3.5 Deterministic Line and Point input state machine

Line and Point share one state machine. Acquisition/source, first-point values,
and the inactive numeric representation are read-only; Tab skips them. After a
Line first point, the default editable pair is **Direction + horizontal length**,
continuously seeded by the pointer. Point starts in endpoint Cartesian mode.
Choosing an endpoint axis field selects horizontal `cartesian`; choosing
Direction or Length selects `polar`. Only the active representation is editable;
the other is calculated from it. Choosing Z, ΔZ, or Slope selects exactly one
vertical mode; the other two are calculated. A user may switch representations
only after the focused text parses or is explicitly reverted. Conflicting
independent values are therefore impossible, not resolved by write order.

| Input/event                                          | Deterministic transition and effect                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Printable digit after Line point 1, viewport focused | Focus Length, preserve the cursor-derived direction as a preview constraint, and insert the digit.                                                                                                                                                                                         |
| `X`/`Y` or `L`/`D` prefix, or direct field focus     | Select Cartesian or polar respectively; parse using project locale/units; inactive horizontal fields become calculated/read-only.                                                                                                                                                          |
| `Z`/`DZ`/`S` prefix or vertical selector             | Select absolute Z, relative ΔZ, or slope exclusively; zero horizontal run with slope is `ZeroRunForSlope`.                                                                                                                                                                                 |
| Tab / Shift+Tab                                      | From viewport, enter the first editable field for the active representation; within the bar, traverse editable fields only. It never cycles a candidate.                                                                                                                                   |
| Up / Down                                            | Cycle the shared stable candidate list only while the UIP-D16 indicator is live; otherwise the focused control/list owns the key or it is unclaimed.                                                                                                                                       |
| Enter in a field                                     | Parse and validate the field set. If required values remain absent, retain valid constraints and return viewport focus without creating geometry. A complete Line/Point commits once; a complete Polyline endpoint becomes one placed, still view-local vertex and returns viewport focus. |
| Enter, viewport focused                              | Line/Point: commit once when complete. Polyline: finish the already placed chain per DR-D5; the live rubber-band endpoint is not accepted by Finish. Invalid state stays pending with the typed error.                                                                                     |
| LMB click with clean/validated fields                | Accept the current constrained preview as the next point; Line/Point commit when that completes their single result, while Polyline stays armed.                                                                                                                                           |
| LMB click with uncommitted invalid/partial text      | Do not commit or discard. Show **Use pointer and discard typed edit / Keep editing**; the first choice reverts text then commits the pointer preview, the second returns field focus.                                                                                                      |
| Backspace, viewport focused                          | Polyline removes the last placed vertex; Line removes point 1 and returns to first-point acquisition; Point has no earlier step. It never journals.                                                                                                                                        |
| Escape                                               | Field text → revert; active constraint/handle drag → restore preceding valid preview; pending geometry → apply DR-D5 once; no pending geometry → armed-tool close rung.                                                                                                                    |
| Candidate/source invalidation                        | Clear the candidate, keep valid typed constraints, and mark the preview invalid until another authoritative source or complete typed coordinate exists. Never reuse a stale world point.                                                                                                   |

Direction locks are explicit toggles beside Direction, not inferred merely from
typing a length. A locked direction makes pointer movement update length only;
an unlocked direction follows the pointer. Point uses the same coordinate and
vertical transitions without a first-point-relative polar default. Accessibility
announces the active representation, editable field, lock state, validation error,
and candidate index.

### 3.6 Point with a 3D target

**Point ▾ → 3D target** starts UIP-D22's `Shared3DTarget`. Two acquisition
modes are honest and distinct:

- **Manual 3D target**: picked, typed, translated, or rotated origin is the
  proposed coordinate. Orientation is only a construction aid; no residual or
  confidence is shown. If the target is not bound to an exact snap, **Create
  estimated point** is the explicit commit action. It stores
  `acquisition=manual-estimate`, origin, orientation, project CRS/datum, and the
  user's confirmation; it never claims survey accuracy.
- **Fit from neighbours**: appears only after the user selects a registered
  Pointcloud evaluator. The request captures cloud id/revision, P4 scope,
  neighborhood shape/radius and admitted classes. The result returns source point
  ids or immutable sample identity, sample count, fitted primitive kind,
  rank/degeneracy result, RMS orthogonal residual in project units, evaluator
  version, and `confidence = clamp(1 - rms/residual_limit, 0, 1)` only after rank
  and minimum-count checks pass. The user sees these inputs and may commit the fit
  or switch to Manual. NoData, stale revision, too few samples, or degenerate rank
  disables **Create fitted point** but never dead-ends Manual.

Both modes invoke only `draw.point.create`; the request carries `mode`, final
coordinate, target transform, acquisition provenance, captured source revisions,
and explicit estimate confirmation when applicable. Console/SDK expose the same
fields in versioned `hcad.component.point-acquisition@1`. Escape follows §3.5;
ribbon re-toggle/close cancels an uncommitted target.
Project replacement clears it. Preview transforms are view-local and never
journal; a successful create selects the ordinary point and its Properties show
the acquisition component.

### 3.7 Point by station/offset

**Point ▾ → Point by station/offset** consumes Civil's complete
`StationReferenceV1` from CIV-D16:

```text
StationReferenceV1 {
  alignment_id, alignment_revision, chainage,
  region_id, equation_id?, equation_side: none|back|ahead,
  captured_display_station
}
```

Displayed station is never geometry identity. A scalar display value is accepted
only when `alignment.stationing.resolve` returns exactly one candidate; repeated
values show every chainage/region/equation/side candidate and require selection.
The persisted Draw point carries the complete structure, signed offset, axis-side
and direction, and vertical mode/basis. `absolute_z` stores project Z directly.
For `delta_z` or `slope`, `vertical_basis` is either an exact alignment-profile
revision evaluated at chainage or an explicitly selected point/entity reference
and revision; slope uses the horizontal run from that basis point to the output.
Absent profile/reference or zero run blocks. No alignment/profile value is
invented.

Preview, bar, marker, Properties, console, automation, reload, undo, and loss
planning show the same chainage identity, perpendicular foot, signed side/offset,
display label, vertical basis, and source revisions. Station-equation edits retain
physical chainage and reformat the label. Alignment reversal maps chainage exactly
as CIV-D16 commands specify. Deleted/merged regions or stale axes produce a typed
unresolved recipe state with candidates/relink action; they never select nearest
or bake a guessed coordinate. The point participates in Civil's one recipe
lifecycle (CIV-D15); Draw owns only ordinary point publication.

### 3.8 Support roles and curve subentities

`hcad.component.support-role@1` is a versioned canonical component on ordinary
point/curve entities: `{role_kind: helper_point|defining_point|defining_curve,
defines[{entity_id, revision, semantic_role}]?, provenance}`. Role assignment and
removal are expected-revision journaled commands/queries available to UI and
automation as `support.role.get/page/set/remove`. It survives copy/paste,
same-project fragments, `.hcad/.hcadx`, undo,
reload, layer/specification changes, and strict-reader opaque round trips. Native
exports preserve it only when their profile has a mapped field; otherwise the
export plan names `support_role_omitted`. DXF/LandXML geometry still exports as
ordinary geometry, never disappears because it is support. The global Support
toggle changes only the effective P9 overlay; it does not mutate the component.

Segment selection is view-local `CurveSubentityRefV1`:

```text
{ parent_id, parent_revision, topology_kind, stable_member_id,
  directed_parameter_interval, loop_id?, use_id?, semantic_hash }
```

Line/circle/arc/clothoid/spline use the stable analytic member id and directed
parameter interval; polyline/Composite use the stable child-member id; an
associative area boundary additionally carries loop/use identity. Reversal changes
direction but preserves a member only when the stable id, semantic hash, and
geometric interval still match. A parent edit may remap only that surviving
semantic member; otherwise the token is pruned with **Segment no longer exists**.
No command widens silently to the parent. Remapping a 10,000-member Composite is
indexed by stable member id and bounded independently of member count; a missing
index refuses rather than scans on the interaction path.

| Command                                   | Whole curve                                           | Eligible segment token                                                                              |
| ----------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Offset/parallel                           | line, circle, arc, planar line/arc polyline/Composite | eligible line/arc member only; recipe stores the token                                              |
| Trim/extend                               | line, arc, clothoid, eligible planar Composite        | eligible line/arc/clothoid member                                                                   |
| Divide                                    | all analytically evaluable curves                     | selected member only                                                                                |
| Fillet                                    | eligible planar pair                                  | eligible line/arc member pair                                                                       |
| Vertex edit                               | polyline/Composite parent                             | member endpoints only when they are actual parent vertices                                          |
| Area/dimension/label whole-reference acts | accepted                                              | rejected with `WholeCurveRequired` unless that owning command explicitly declares subentity support |

### 3.9 Linked offset/parallel curve

The Draw offset/parallel payload profile of `hcad.derived-recipe@1` is governed
by MT-D25/P10. It persists:
recipe/output ids; whole-source or `CurveSubentityRefV1` plus exact source
revision/hash; construction plane/CRS; signed distance and side; join policy
(`miter|bevel|round`) with miter limit; end policy (`open|butt|round`);
self-intersection policy (`reject|split_regions`); algorithm/schema versions;
output layer/specification/style; dependency ids; generation; state
`linked-current|linked-stale|detached`; last-good output revision/content hash;
and last typed error.

Exact v1 geometry supports LineSegment, Circle, CircularArc, and planar
Polyline/Composite made only of line/arc members. A circle/arc whose signed offset
makes radius non-positive is `OffsetRadiusCollapsed`. Concave closed inputs apply
the chosen join and either publish explicitly split regions or reject; they never
discard loops silently. Non-planar/spatial curves reject
`NonPlanarOffsetUnsupported`; spline/clothoid whole offsets reject
`ExactOffsetKindUnsupported` until a canonical exact representation is admitted.
Eligible clothoid segments remain valid for Trim/Divide, not Offset. This explicit
limit is preferable to hidden flattening. End caps apply only to open results.

Source edits mark the recipe stale once at gesture end. The last-good curve stays
visible with shape+text **Stale**, is selectable/snappable only as a stale result,
and is rejected as a Mesh breakline/boundary or lossless/current export until
regenerated or detached. `regenerate`, `detach`, `relink`, auto-detach on source
loss, and their undo/redo atomically restore dependency edge/state, output
revision/hash, layer/spec/style, generation, and error. Failure retains last-good;
source loss retains it detached plus provenance and a console note. Reload
revalidates edges before showing Current. DAG/CAS checks and long-job cancellation
follow MT-D25; no partial or superseded generation publishes.

## 4. Function contract (A1–E3)

**A1 — User outcome.** §3 narratives cover the workflow-level functions,
including the batch-2 Line/Point, reticle, station, support/segment, and offset
lifecycles; each catalog row's outcome is its one-line description plus
the shared interaction model (input bar, snapping, journaled commit)
that §3.1 establishes for every tool.

**A2 — Reference behavior.** RIB Civil is the drafting reference
(rib-civil.md §5 maps this dossier to the Draw tab); §2.1 disposes every
Draw-relevant dossier row per the contract's disposition rule. Adopted:
the F5-Box numeric-twin norm (§2.2), Fangkreis snap radius with
candidate picker (§2.2), the permanent Tachobox readout (§2.2),
multi-solution cycling by cursor with click-commit (§2.2 Mehrdeutigkeit),
layer management with draw-order hierarchy and assign-to-layer (§2.3),
the full point/line/arc/clothoid construction families incl. couple/
pivot/buffer semantics (§2.1, W3), divide, trim, offset, dimension
chains (§2.1 Maßketten), drafting-time specification styling (§2.3
Spezifikation/F9, as D3 consumption — DR-D16), axis-from-polyline with
name, start station, and auto-layer (§2.3, §2.4, W3), and digitizing on
clouds (§2.6 Punktwolke). Deliberately different: STRATIS' modal wizard
rigidity — practitioners' top complaint ("starr wie ein Stück Stahl",
§4) — is replaced by direct manipulation with live rubber bands plus the
typed twin, exactly the loved part of their model (§4 lessons 1–2).
RealWorks contributes drawing on clouds (realworks.md §2.6, §2.8), which
our 2.5D acquisition generalizes. For the 3D target, RealWorks §8.1 evidences
constrained Cartesian/polar picking, UCS frames, smart/neighbour picks, and point
creation; §8.2 explicitly finds no single freely translatable/rotatable generic
point reticle. Himmel:CAD's UIP-D22 reticle is therefore a stated extension that
combines those building blocks, not attributed reference behavior. Revit contributes the repetition
lesson (revit.md §2.4): one specification concept with placement modes
(D3; the model itself is BIM-owned per DR-D7). Trimble Access is relevant to the
shared state/selection consumers: `trimble-perspective.md` §7.1 documents three
states and mixed parents; §7.2 documents blue selection and direction arrows
only in stakeout. P9's fourth Inert state, universal orange directed selection,
fixed point/support shapes, and Ctrl multi-select are explicit Himmel:CAD
owner/doctrine extensions (UIP-D20/UIP-D21), not Access claims.

**A3 — Sibling functions.** Measurement tools (Inspect distance/angle —
today unimplemented ribbon placeholders, `ribbon.ts:129-141`) must adopt
the same snap markers and readout. Dimension and Measurement are both
canonical and associative: Dimension is construction annotation, while
Measure/Inspect owns the persistent inspection entity, provenance, panel, and
report lifecycle (MI-D2). The viewing-box
panel establishes Enter/blur commit and Escape revert for numeric fields
(specs/view/viewing-box.md §1.2) — the input bar follows it. The
platform spec owns click/RMB/Escape arbitration (UIP-D1/D2/D5/D14);
Draw's armed-tool behavior slots into those records (DR-D14).
Whole-entity transforms are the select-edit spec's (registered owed,
§1). Plan composer consumes drafted content through viewports (D4). The
2D/2.5D/3D mode switch (View tab) governs acquisition (ADR 0022); Draw
adds no mode of its own.

**B1 — Reachability.** Per catalog table: every function has ribbon
presence in the Draw tab, a console command, and an automation command;
context-menu entries exist where a selected entity is the natural
operand, per design-system "Discoverability and contextual access".
`draw.symbol` and `draw.fill` are access paths resolving to the
BIM-owned `bim_object.place` — one canonical command, two ribbon homes
(B1 requires paths to converge, and the reconciliation forbids a
duplicate command family). Quick surface: "Add point here" only. The Point ribbon
split visibly exposes **Point**, **3D target**, and **Point by station/offset**,
all resolving to `draw.point.create`; Properties exposes offset recipe status and
Regenerate / Detach / Relink without creating a second act.
Keyboard shortcuts for polyline and snap toggles are recommended to
`REGISTRY.md` (VB-D9 precedent). Nothing in this domain is absent from
automation; the input bar needs no automation surface because its values
are exactly the typed parameters of each `draw.*` command.

**B2 — Open/close symmetry.** Ribbon tool buttons toggle: pressing the lit
button explicitly ends the tool. Enter, Finish/Close, and ribbon re-toggle
commit a complete construction and otherwise publish nothing. Escape follows
DR-D5's one pending-geometry rule: discard the unaccepted rubber-band segment;
commit only already placed vertices when at least two exist; a one-point Line
publishes nothing. It then leaves the tool armed. A later Escape with no pending
construction reaches the armed-tool close rung. Tool-menu Cancel is the explicit
discard-all path and states the number of placed vertices affected. The Layers tab closes with
the panel's standard affordance; closing it never changes layer state.
The right tool-options panel closes with its tool. Escape follows the
platform ladder (UIP-D14) with the tool rungs of §3.1.

**B3 — Surface choice.** Drafting tools are viewport tools: the pointer
must stay on geometry, so parameters live in the docked right panel and
the typed twin in the bottom construction input bar — the design
system's "tool parameters stay docked when the user must interact with
the viewport", extending the mandated persistent coordinate display.
Layer management is the left panel Layers tab. Alignment naming is a
small focused dialog at commit. Nothing in §3 outgrows these surfaces;
the profile-window surface class is exactly what the deferred alignment
subsystem will need and is one reason it is deferred (§1).

**C1 — Numeric parity.** The law of the domain (DR-D1/DR-D17 and §3.5).
Every mouse
construction has its typed twin in the input bar: vertex ↔ X/Y(/Z) or
distance/direction; radius drag ↔ radius field (sign = curvature side,
rib-civil.md §2.1 Bogen); clothoid ↔ parameter/length fields
(rib-civil.md §2.1 Klothoide); offset drag ↔ distance; fillet drag ↔
radius; dimension placement drag ↔ offset; spacing drag ↔ spacing
field. Angles follow new project settings: angle unit (gon/degrees) and
direction reference (north azimuth). Per P7 these are editable project/office
data: the shipped default is gon + north azimuth, never a fixed product
convention. Both directions stay live-synchronized;
fields commit on Enter, revert on Escape; conversely every displayed
readout value is typeable when it parameterizes the running construction.
Horizontal Cartesian/polar and vertical Z/ΔZ/slope are exclusive selectors
with calculated twins, never competing writers. Printable routing, locks,
field/viewport Enter, click-with-partial-text, Backspace, Escape, candidate
cycling, and source invalidation are exhaustively defined in §3.5.

**C2 — Selection semantics.** Creation tools ignore the current
selection; they create — and while armed they **capture LMB/RMB
clicks**, so construction picks never mutate the selection (DR-D14; the
UIP-D2 click-select rule applies only with no tool armed, reconciled
there). Operand tools (offset, trim, fillet, divide, area-from-curves,
dimension/label via context menu, move-to-layer, assign-heights) act on
the clicked or pre-selected entity; with a multi-selection,
move-to-layer, divide, and assign-heights apply to all,
offset/trim/fillet require one operand and say so. In Segments mode they receive
`CurveSubentityRefV1`; the applicability matrix in §3.8 governs and no command
widens to the parent. Selection changes
while a creation tool runs do not affect the construction. Newly
committed entities become the selection, so a draft→edit chain flows
without re-picking.

**C3 — Freezability.** The snap candidate set is the exploitable
invariant: authored geometry changes only through journaled commits, so
semantic snap candidates are precomputed per curve at tessellation/
commit time (`crates/himmelcad-render/src/cad_curve.rs:58-75` declares the
store; the same file `:571-574` emits arc snaps and `:324-340` consumes them)
and updated incrementally
per commit — never recomputed per frame (X2). Draw has no second layer lock/
visibility predicate: SE-D19's one P9 resolver controls render/pick/snap/edit
eligibility. Hidden leaves render and candidates; Reference stays rendered,
selectable, and snappable while edits reject; Editable behaves normally; Inert
renders but does not select/snap/edit. Requested state remains canonical while
global Support/Labels overlays are view-local and non-destructive (UIP-D20).
No expensive live-preview mode exists here that would warrant a bake
lock; the viewing-box lock (P2) covers the heavy-data case.

**C4 — Persistence and undo.** All drafted entities, layers,
alignments, and placed objects are canonical journaled entities (X3,
P1) and travel in `.hcadx` (D1). Journal granularity per DR-D5: one
committed construction = one undo step; rubber bands, half-typed
fields, armed candidates, and the running tool are view-local. The
current layer is **persisted, automation-writable, and excluded from
the undo chain** (DR-D10 — the UIP-D3 class: agent visibility does not
imply journaling, and undo flipping the commit target of future work is
a trap, finding 15). Snap toggles are user preference (DR-D10).
Defensible to a Ctrl+Z user: undo removes the polyline they finished,
never re-aims their next one. Support roles persist as canonical components while
segment tokens remain view-local with Selection history. Station/offset points
persist Civil's CIV-D15/CIV-D16 recipe/reference. Offset regenerate/detach/relink
restore the complete affected-state set in §3.9 atomically; last-good hashes and
recipe edges are physical retention roots until document/undo/recipe reachability
ends, with File FP-D22 owning archive and GC behavior.

**D1 — Performance budget.** Continuous: rubber-band preview, snap hover,
reticle translate/rotate/type, station/offset evaluation, segment highlight,
offset preview, fillet/trim preview, and dimension placement. The required gates
are specified below but **do not exist yet**; the behavior remains unverified
until the artifacts and verifier routes exist and pass:

- `G-DR-INPUT`: create `scripts/benchmark-builder-draw-input.mjs`, exposed as
  `pnpm benchmark:builder-draw-input`. It self-launches Builder and drives the
  exact §3.5 keystrokes plus a 200-vertex draft, reticle manual/fit move/rotate/
  type/cancel, every P9 state, and segment highlight over a deterministic sparse
  500-million-point-class streamed manifest plus 5,000 CAD entities. Fixture
  generator: `scripts/fixtures/generate-draw-batch2-fixture.mjs`, seed recorded in
  the result JSON. Fail: presented-frame interval p95 > 2× target, snap query
  > 4 ms p95, input-to-visible-preview > 100 ms p95, stale candidate published,
  > wrong authored-over-cloud winner, or any Tab candidate cycle.
- `G-DR-DERIVED`: create `scripts/benchmark-builder-draw-derived.mjs`, exposed as
  `pnpm benchmark:builder-draw-derived`. It crosses repeated station equations,
  rapidly edits/reverses the axis, targets line/arc/clothoid and a 10,000-member
  Composite, and edits sources during linked-offset preview/regeneration. Fail:
  superseded generation publishes; cancellation acknowledgment exceeds 250 ms;
  worker queue exceeds one running + one latest pending generation per recipe;
  additional resident memory exceeds 256 MiB for the fixture; stale state is
  unlabeled; or a revision/CAS mismatch writes the document.

Both targets require `browser-gpu`; their release real-data variants also require
`real-data`. Missing capability fails at the required tier, never skips. Each
writes `.build/verify/draw/<gate>.json` with capabilities, fixture hash, raw frame/
query/input/cancel/memory samples, winner/state assertions, and pass/fail reasons,
and must be registered in the verification planner and function registry during
round 3. Thresholds are initial X6/P3 tunables. Bounded: entity commit, layer
operations, divide, alignment creation (< 1 s; busy only if perceptible).
Bounded-to-long-running: neighbour fits, offset regeneration, area fills, and
height draping report real units, cancel within the bound above, checkpoint only
immutable work, and publish no partial/superseded result. Multi-minute work
discards unverifiable checkpoints on restart and restarts from the last verified
immutable partition.

**D2 — Degradation.** During drafting interaction the existing governor
path applies (interacting state, preview caps): cloud point budget and
overlay fidelity degrade first. Never degraded: input responsiveness,
snap correctness (a degraded display must not change which point wins —
candidates come from full-precision data, and within a locked viewing
box cloud snaps resolve against full-precision source points, DR-D15),
committed-geometry exactness, journal integrity. Snap radius and marker
rendering stay constant; only decorative preview density may drop.

**E1 — Visual quality.** References are existing Himmel:CAD surfaces
plus the failable criteria below (in-repo per the A2/E1 evidence rule;
no third-party screenshots per repository license discipline): panels,
tabs, and inline edit follow the entity tree and viewing-box panel; snap
markers and rubber bands use theme tokens only. Failable criteria: (1)
snap marker legibility — marker plus source name readable on light and
dark themes over dense cloud backdrops at 100% zoom; (2) marker
stability — the armed candidate marker does not jump between frames
while the cursor is stationary (asserted from benchmark state samples);
(3) rubber band contrast — pending segment distinguishable from
committed geometry in both themes; (4) layer rows — drag-reorder
affordance visible, current-layer marker, four requested states, Mixed, and
effective-cause state unambiguous;
(5) dimension rendering — extension lines, arrows, and text render
without overlap at default style in a screenshot of workflow §3.4; (6)
height state — the "Z —" pending state and the height-less vertex
marker are visually distinct from the height-carrying state in both
themes. **Input bar block** (finding 18 — the domain's most novel
surface): (7) fixed position and height, never overlapping viewport
chips or console; (8) focus state unmistakable — armed field
highlighted, viewport-focus vs bar-focus visually distinct, digit
auto-focus visibly moves focus; (9) every tool shows a per-step prompt
naming the expected input ("Pick or type second vertex"), and prompts
change on every step; (10) field order stable across tools (prompt,
X/Y/Z, distance/direction, tool-specifics). Batch-2 criteria adopt UIP-D21/
UIP-D22 semantics and must pass in both themes at 100% and 150% scale, with
shape/text in addition to color: (11) Manual target, valid neighbour fit,
degenerate/NoData target, and committed point cannot be mistaken for one another;
Manual never shows a residual and an estimate carries explicit text; (12)
station/offset preview shows axis direction, perpendicular foot, signed side, and
equation ambiguity candidates; (13) segment selection emphasizes the parent
lightly and the exact member strongly, retaining direction, while whole selection
is visibly different; (14) support role uses the shared support token/shape and
its Hidden/Reference/Inert outcomes are distinguishable; (15) linked-current,
linked-stale, detached, and failed-last-good offsets have distinct icon/line
pattern plus status text, never color alone. Draw supplies semantic adapter state;
UI Platform owns token values and shared glyphs.

**E2 — Conflicts, failure, and consumers.** Consumers of drafted state
and the domain's effect on each:

| Consumer                 | Effect                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render passes            | New curve/text primitives enter the existing tessellation/text path (`cad_curve.rs`, `text.rs`); dimensions/labels get the host-resolved parts the compiler reserves (`entity_compiler.rs:179-182`); layer order drives draw order; SE-D19 effective Hidden leaves the pass while Inert still renders |
| Picking/snapping         | Committed entities join the semantic candidate set in the same commit cycle — a just-drawn vertex is immediately snappable (§3.1 depends on it); SE-D19 Hidden/Inert leave candidates, Reference/Editable remain eligible; precedence per DR-D12                                                      |
| Viewing box (P4)         | An active box scopes drafting: clipped-away geometry and cloud regions are excluded from snap candidates and operand picks; a locked box resolves cloud snaps against full-precision source points inside the box (DR-D15)                                                                            |
| Selection                | Commit selects the new entity (C2); armed tools capture clicks so selection never changes mid-construction (DR-D14); layer delete/reassign updates membership                                                                                                                                         |
| 2D/2.5D/3D admission     | `z: null` support positions ⇒ plan-only: admitted in plan modes, hidden in 3D until `draw.assign_heights` or edits supply heights (ADR 0022) — stated in properties and the bar's Z field, never silent                                                                                               |
| Entity tree / Layers tab | Every commit appears in both; membership stays consistent through the same canonical layer entities and the exactly-one-layer invariant (DR-D4)                                                                                                                                                       |
| Mesh/terrain domain      | Drafted polylines serve as breaklines/boundaries without conversion (§3.3)                                                                                                                                                                                                                            |
| Exporters                | DXF/DWG (ADR 0026 boundary) and LandXML read canonical geometry and layers; plan-only entities export with true `z: null` semantics, never fabricated zeros                                                                                                                                           |
| Plan composer            | Consumes model content through viewports (D4); screen-space text composes at sheet scale. In an eligible selected viewport, **Model dimension…** is an access path to Draw-owned `draw.dimension.create/edit` (PE-D17/DR-D9), never a Plan pixel annotation                                           |
| BIM domain               | `draw.symbol`/`draw.fill` invoke `bim_object.place`; placed-object semantics, occurrence regeneration, and styling resolution are BIM-owned (DR-D7, BS-D4/D5/D6/D12)                                                                                                                                  |
| Automation               | Full `draw.*`/`layers.*`/`alignment.*` parity plus support-role, station-reference, subentity-ref and offset-recipe schemas/status; document reads and entity paging see every canonical component; explicit `layer` parameter beats ambient current layer (DR-D4)                                    |

Shared3DTarget consumers (UIP-D22 shell; Draw retains point authority):

| Consumer                             | Required behavior                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render/selection overlay             | Reticle is preview-only, clears on cancel/project replace, and is visually distinct from the selected committed point; P9 scopes its candidate sources.                                    |
| Picking/snapping/candidate indicator | Exact snaps may seed Manual; neighbour fit uses explicit captured sources; Hidden/Inert are excluded; Up/Down only with the live indicator.                                                |
| Properties/tree/layers/specification | No entity/tree row exists before create; after create the ordinary point receives captured layer/spec and Properties acquisition provenance.                                               |
| Draw/BIM/Civil/Mesh tools            | Orientation constrains only the running point. No consumer may treat Manual orientation/residual as surveyed surface/axis truth.                                                           |
| Plan/WeltView/PhotoLab               | Preview is Builder-session state and absent; after commit they read the ordinary point and preserve unknown acquisition metadata or reject the version explicitly.                         |
| File/journal/automation/recovery     | Preview never archives/journals; create is one command/undo root; SDK submits the same transform/provenance; crash/project replacement discards preview; stale fit workers cannot publish. |

Support-role consumers (`hcad.component.support-role@1`):

| Consumer                                       | Required behavior                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render/P9/selection overlay                    | Role selects the UIP-D21 support adapter; global Support only overlays/suppresses. SE-D19 Hidden/Reference/Editable/Inert remains sole eligibility truth.                                                                        |
| Picking/snapping/candidate indicator           | Reference/Editable support is selectable/snappable; Hidden/Inert is absent. Candidate source names the role; no missing number/spec inference.                                                                                   |
| Properties/tree/layers/specification shortcuts | Role is editable/viewable as canonical metadata; layer/spec application preserves it and never changes role implicitly.                                                                                                          |
| Draw/BIM/Mesh consumers                        | Draw applicability follows §3.8; BIM role generation and Mesh source-role assignment require explicit compatible role or an explicit mapping, never the name alone.                                                              |
| Export/fragment/Plan/WeltView/PhotoLab         | Geometry remains ordinary; native loss plans name omitted role; fragment/archive/strict readers preserve unknown component bytes; Plan/viewers render according to supported effective state and never infer defining relations. |
| Journal/undo/automation/recovery               | Assign/remove is expected-revision journaled and symmetric in SDK; undo/reload restores role/relations; corrupt refs become typed unresolved metadata without deleting geometry.                                                 |

Curve-subentity consumers (`CurveSubentityRefV1`, view-local):

| Consumer                                   | Required behavior                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render/selection overlay                   | Parent + exact member highlight per E1; token disappears or reports pruned after invalidation, never moves to a neighbor.                                                                                                                |
| P9/picking/snapping/candidate indicator    | Eligibility is recomputed by SE-D19; Hidden/Inert prune from live candidates; Up/Down cycles exact member candidates only while indicated.                                                                                               |
| Properties/tree/layers/specification       | Properties names parent/member/revision and pruned reason; it creates no tree/layer/spec entity or membership.                                                                                                                           |
| Draw/Mesh/BIM consumers                    | Only the §3.8 matrix may consume it. Mesh/BIM require their own explicit subentity-capability admission; no silent parent widening.                                                                                                      |
| Export/fragment/Plan/WeltView/PhotoLab     | View-local token is not exported/archived as document truth. A command result produced from it is ordinary canonical geometry with recipe provenance where applicable.                                                                   |
| Selection history/undo/recovery/automation | Selection history may restore only if parent revision/remap proof passes; document undo that restores the exact parent may revalidate. Automation may pass the versioned token only to declared commands; project replacement clears it. |

Station-reference and offset-recipe consumers (both are P10-derived but keep
their owning schemas):

| Consumer                               | Station/offset point                                                                                                                                                                                                                            | Linked offset curve                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render/selection/P9                    | Point renders at chainage-derived world coordinate with unresolved badge when invalid; effective P9 applies to point and sources separately.                                                                                                    | Last-good renders with Current/Stale/Detached/Failed text+shape; effective P9 applies; stale remains selectable only as disclosed stale output.                               |
| Picking/snapping/candidate indicator   | Complete CIV-D16 candidates; ambiguity blocks. An unresolved point is not a geometry snap.                                                                                                                                                      | Stale output may be picked/snapped only with stale status surfaced; it is ineligible as authoritative construction input until regenerated/detached.                          |
| Properties/tree/layers/specification   | Show complete station/basis/source identity; normal point layer/spec remains.                                                                                                                                                                   | Show full recipe, source/member, policies, generation/error; output layer/spec are restored atomically.                                                                       |
| Draw/Civil/Mesh/BIM                    | Draw publishes point; Civil resolves/invalidate/regenerates. Mesh/BIM cannot infer station meaning.                                                                                                                                             | Draw owns recipe geometry; SE-D20-style gesture-end invalidation applies. Mesh breakline/boundary and BIM generators reject linked-stale/failed output.                       |
| Export/fragment/Plan/WeltView/PhotoLab | CIV-D16/IF-D18/FP-D22 loss plan; chainage identity must survive or loss is explicit; strict readers preserve/reject version.                                                                                                                    | Current/detached exports per provider; linked-stale blocks a current/lossless claim; archive/fragment preserve recipe/last-good; Plan and viewers show status or fail closed. |
| Journal/undo/history/automation        | CIV-D15 one recipe root; equation edit preserves chainage; create/regenerate/relink/auto-detach restore complete state; SDK sees unresolved candidates.                                                                                         | MT-D25 lifecycle; create/regenerate/detach/relink/auto-detach are one atomic root each; cancel/superseded generations publish nothing; SDK sees state/error.                  |
| Failure/crash/project replacement      | Invalid region or stale axis/profile retains typed unresolved last-good recipe; no nearest guess. Missing alignment auto-detaches the last-good point/provenance with the CIV-D15 console event. Pending preview is discarded on crash/replace. | Failure retains last-good/error; source loss auto-detaches; reload CAS-validates; running preview/job cancels on replace and verified immutable partitions alone may resume.  |

Gesture map while a Draw tool is armed (contract E2 arbitration rule;
reconciled with ui-platform): LMB click = construction pick (captured;
UIP-D2 suspended by DR-D14); LMB drag ≥ threshold = navigation,
untouched (UIP-D1); RMB drag = pan, untouched; RMB click = tool menu
(replaces the context surface while armed, DR-D14; UIP-D5's event
routes here); wheel = zoom, untouched; Tab/Shift+Tab = focus/traverse
construction-bar fields without pointer motion (DR-D1); Up/Down = candidate
cycling while the indicator is live (DR-D6); printable typing = deterministic
§3.5 routing; Backspace = step back (viewport focus); Enter = field
validate/return or viewport commit/finish per §3.5; Escape = UIP-D14 ladder
with DR-D5 pending-geometry semantics; Space
= unclaimed (the legacy binding retires with the legacy package,
DR-D2). Draw contains no contrary Tab/candidate or Escape rule. The round-3
registry and every normative sibling gesture summary now reserve Tab/Shift+Tab
for input-bar focus traversal and Up/Down for live candidate cycling. The kernel
binding/comment and its executable UI test remain implementation work; DR-D22's
absent executable gates do not reopen the clean registry status.

When PE-D17 arms **Model dimension…** inside a selected Plan viewport, the same
Draw meanings are confined to that viewport: LMB semantic pick, RMB tool menu,
Tab/Shift+Tab construction-bar traversal, Up/Down candidate cycling, Enter finish, Backspace remove anchor, and
Escape the tool rung. Plan paper selection/navigation outside the viewport and
the main Builder viewport remain untouched.

Extreme class members (contract E2 rule): for the _snap source_ class,
the largest member is a streamed billion-point cloud — candidates come
from resident LOD data, but precedence (DR-D12) keeps authored geometry
reachable above it, and a locked viewing box upgrades resolution to
full-precision source points (DR-D15); the least typical is a
screen-space text entity (`TextSpace::Screen`) — snappable at its world
anchor only, its pixel glyphs are never snap geometry. For the _layer
member_ class, the largest is a layer holding an entire point cloud
(`layer_ids` binds any entity): requested Hidden removes its render/candidates
through SE-D19 while Inert retains render only; the least typical is the
empty Default layer — always present, never deletable, target of every
orphaned entity (DR-D4). For DR-D5, the least typical construction is a Line
with one placed point: Escape drops its rubber band and commits nothing. The
largest is a 10,000-vertex traced boundary: Escape drops only the live span and
commits the placed vertices as one journal entry/undo step; explicit Cancel
instead discards all after disclosure.

Concurrency and failure: canonical commits serialize through the
journal; an automation command landing mid-construction does not
disturb the view-local rubber band, and `layers.set_current` mid-trace
cannot redirect it — the tool committed to its captured target layer at
start (DR-D4, finding 10). Two surfaces editing layers concurrently
resolve through command serialization; both re-render from canonical
state. Deleting an entity referenced by dimensions/labels/associative
areas flips the referents to their explicit broken state in the same
transaction — never a dangling anchor. A crash loses at most the
un-committed construction; everything committed replays from the
journal. Drape/fill failure or cancellation publishes nothing partial
and logs the reason.

**E3 — Verification plan.** §7; unverified residue listed there.

## 5. Decision records

**DR-D1 — One shared numeric twin: the construction input bar, with a
deterministic focus model.** **Decision:** a single construction input
bar (per-step prompt + readout + typed fields of the running
construction) serves every Draw tool; no tool ships private coordinate
dialogs. Absolute and relative entry always both available for position
input. The complete routing/state table is §3.5. Focus model: printable input
uses that table; **Tab always means the input bar**: from the viewport it
focuses the first editable field of the active representation, inside the bar it
traverses editable fields (Shift+Tab backwards) without moving the cursor; **snap
candidates are cycled with the Up/Down arrow keys** while the UIP-D16
"1 of N under cursor" indicator is live — a list, cycled like every list;
Enter validates the field set and returns focus to the viewport; Escape in
the bar reverts and returns focus (review finding 4 — no key is
double-booked; owner statement S1 2026-09-02 and the owner's follow-up
"dann vielleicht mit Pfeiltasten" — one meaning per key, no
state-dependent Tab). Angle
entry follows new project settings: angle unit (gon/degrees) and
direction reference (north azimuth), gon default (finding 16).
**Derivation:** C1 made law via the F5-Box norm (rib-civil.md §2.2, §4
lesson 1); design-system persistent coordinate display; A3 consistency
with viewing-box field conventions; UIP-D14 ladder for the Escape rung.
**Rejected:** per-tool numeric dialogs (STRATIS-era modality, the §4
rigidity complaint); AutoCAD-style command-line syntax as primary path
(fields are self-describing; a console path exists per B1); a dedicated
focus-toggle key (typing _is_ the intent signal).
**Tunable:** compact layout/ordering and the shipped editable angle default per
X6/P7; key meanings and state transitions are not tunable.

**DR-D2 — One snapping pipeline: extend the kernel ranked pick path;
the legacy snapping package is not resurrected.** **Decision:** drafting
snaps extend the kernel refinement pipeline
(`crates/himmelcad-render/src/picking.rs:492-500` — ranked `SnapKind`
with dedup; `crates/himmelcad-render/src/cad_curve.rs:58-75` declares the
store, `:571-574` emits arc snaps, and `:324-340` consumes them). New producers: `Intersection`
(declared and ranked today, produced by nothing) and a new
perpendicular/foot-point kind, computed against tool context from
analytic curve data. Candidate cycling uses **Up/Down**; the current kernel Tab
binding (`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:460-465`)
and comment at `:138-144` are round-3 implementation deltas to rebind/rename. The deprecated
legacy `snapping/` package (`legacy.ts:1` `@deprecated`; its
`CadSnapProvider` and `DgmSnapProvider` are stubs and count as not
existing per contract A2) is design evidence only, and its Space
cycling dies with it (design system "Input consistency").
**Derivation:** ADR 0022 (single-source cursor providers); X2 (semantic
snaps precomputed at tessellation/commit time, as `cad_curve.rs`
already does); in-repo deprecation evidence; contract A2 code rule.
**Rejected:** implementing the legacy stubs (builds new drafting on a
deprecated path); a separate drafting snap engine (double
implementation of ranking, cycling, markers).
**Tunable:** snap pixel radius, index update batching (X6).

**DR-D3 — Heights follow ADR 0022 acquisition; per-vertex, always
visible, never invented — and assignable afterwards.** **Decision:** in
2D drafting authors `z: null`; in 2.5D each vertex retains the snap
winner's source Z when it has one; typed Z is the twin of a snapped Z.
Mixed-height polylines are legal (`Position.z` per-vertex optional,
`entity_model.rs:174-181`). The pending vertex's acquisition is always
displayed before commit ("Z 34.120" / "Z —") with a distinct
height-less marker; a per-tool **Require height** option refuses
height-less commits; `draw.assign_heights` (drape on DGM/cloud, typed
constant, interpolation) closes the plan-only→3D admission loop
(review finding 8). Mode switches affect subsequent vertices only.
**Derivation:** ADR 0022 ("No mode … invents zero height"; plan-only
admission); X1 — a fabricated height in survey output is a correctness
failure; X5 — an admission rule without an assignment path is half a
pair.
**Rejected:** forcing a reference plane per session (re-introduces the
implicit surface ADR 0022 removed); refusing height-less drafting
(kills the planimetric workflow, rib-civil.md W2); silent height gaps
(the finding-8 defect).
**Tunable:** drape sampling density (X6).

**DR-D4 — Layers consume P9 and retain exactly-one-layer targeting.**
**Decision:** the Layers tab manages canonical `hcad.layer@1` entities and an
explicit reorderable draw stack. Each layer stores one requested P9 state from
Hidden / Reference / Editable / Inert; Draw stores no independent visibility or
lock truth. UIP-D20 owns the control/propagation/Mixed presentation and SE-D19's
domain-neutral resolver is the sole effective render/select/snap/edit authority.
Legacy `{visible,locked}` migrates deterministically: invisible → Hidden;
visible+locked → Reference; visible+unlocked → Editable. Inert has no legacy
equivalent and is introduced only by an explicit user/command choice. Draw still
consumes domain-neutral `interaction.state.explain`; the former
`selection.effective_state.explain` is a compatibility alias only. It enforces
exactly one layer per entity: assign replaces; empty means the
always-present, never-deletable Default; `layer_ids: Vec`
(`entity_model.rs:1216`) remains reserved. Tools capture target layer at start;
each create accepts an explicit optional layer that beats ambient current layer.
Office names/templates are editable P7 data.
**Derivation:** P9, X1, X3, X7, GAP-D4, UIP-D20, SE-D19; X3/P1 for canonical
layer/order state; rib-civil.md §2.3 for hierarchy; E2 serialization for
capture-at-start.
**Rejected:** separate visibility/lock booleans or predicates (contradict P9 and
produce incoherent eligibility); guessing Inert during migration; multi-layer
drafting without a workflow; commit-time ambient targeting; deletable Default.
**Tunable:** shipped naming template and bulk-preview/page thresholds under their
owners; state meanings and migration mapping are not tunable.

**DR-D5 — Commit granularity and one Escape rule for pending geometry.**
**Decision:** rubber bands, unaccepted endpoints, half-typed fields, and armed
candidates are view-local; accepted vertices commit together as one journaled
construction. Enter, Finish/Close, and ribbon re-toggle are explicit tool-end
paths. Escape's pending-geometry rung never accepts the rubber-band endpoint: it
discards only that pending segment. Already placed vertices commit when they form
a valid construction (≥2) and the tool remains armed; therefore a one-point Line
cancels with nothing committed, while a multi-vertex Polyline commits its placed
chain without the pending span. With no pending construction, the next applicable
Escape reaches the armed-tool close rung. Tool-menu Cancel explicitly discards all
placed vertices after disclosing the count. Backspace is one view-local step back.
**Derivation:** X1 (never invent the pending endpoint and never discard accepted
survey construction), X5, P6, C4, UIP-D14's one-rung ladder, and owner workflow S1
(`OWNER-STATEMENTS-2026-09-02.md`).
**Rejected:** Escape committing the rubber-band endpoint (fabricates acceptance);
Escape discarding all placed vertices (data loss); a separate Line/Polyline Escape
rule (class inconsistency); journaling every vertex.
**Tunable:** no.

**DR-D6 — Ambiguity: cursor proposes, Up/Down cycles, click commits.**
**Decision:** when several snap candidates or geometric solutions exist
(fillet side, buffer-arc solution, trim end), cursor position selects
the default and the Up/Down arrow keys cycle alternatives before the
committing click (Tab is reserved for the input bar, DR-D1); the readout
names the armed candidate.
**Derivation:** X4 — rib-civil.md §2.2 Mehrdeutigkeit and Punktauswahl;
the kernel's ranked candidate stack (A3); DR-D1's focus model keeps Tab
unambiguous.
**Rejected:** modal candidate list dialogs (breaks flow).
**Tunable:** no.

**DR-D7 — Symbols and fills: Draw provides access paths; the placed
object is BIM's reconciled model.** **Decision:** a placed symbol or
fill is an **entity of its definition's canonical kind carrying a
specification component**; along-curve and area-fill occurrences are
**derived data** owned by the host entity, regenerated from parameters
(bim-specs BS-D5); blocks are **render substrate only** — evaluated
symbols compile onto the existing block machinery, never a parallel
instancing path (BS-D6, `canonical_resources.rs:165-211`).
`draw.symbol` and `draw.fill` are Draw-tab **access paths** resolving
to the single canonical `bim_object.place` command family owned by the
BIM domain (B1: same capability, same command). This supersedes this
spec's earlier "canonical `hcad.block@2` instances / fill entities"
wording — reconciliation resolved in BIM's favor (bim-specs review
finding 1, 2026-09-01; stronger derivation from D3's
attribute/geometry-parameter separation).
**Derivation:** owner decision D3; bim-specs BS-D4/D5/D6; revit.md §2.4
lesson (one concept, three placement modes); B1 single-command rule.
**Rejected:** two command families for one capability (the duplicated
`draw.symbol.place`/`bim_object.place` pair the review flagged);
block-instance-as-entity (loses the specification component and the
derived-occurrence economy of BS-D5).
**Tunable:** no.

**DR-D8 — Alignments: Draw drafts primitives; Civil owns semantics.** **Decision:** the construction catalog covers rib-civil W3
end to end — tangent-from-point lines, coupled/pivoted/buffered arcs
with solution cycling, clothoid connectors, trim, polyline join —
followed by curve-to-alignment (name, start station, stationing labels,
auto-layer from an editable office naming template whose shipped seed is
`Achse <name>` (rib-civil.md §2.3; P7 — review finding 19 adopted as a
mechanism, not a mandated name). Civil CIV-D2–D14 owns the admitted semantic
alignment/profile/band/corridor/slope/pit/station workflows; Draw owns primitives,
snaps, support roles, create-from-curve, and the ordinary point commit used by
station/offset construction.
**Derivation:** rib-civil.md W3 (the worked example this catalog now
reproduces move for move — review finding 6 resolved by adding the
constructions, closing the author/import asymmetry with
`Clothoid`/LandXML spirals); program README cite-and-revise rule;
`hcad.alignment@1` + `landxml.rs` prove the storage side.
**Rejected:** duplicating Civil semantics here; the previous re-scoped catalog
that could not draft W3 (an X5 defect against the spec's own primary workflow).
**Tunable:** no.

**DR-D9 — Dimension values are derived, never overridable.**
**Decision:** no text-override on dimension values; broken
associativity is an explicit visible state, not a frozen number.
Boundary: **symbol-canvas dimensions in the specification editor are a
distinct driving kind — they set geometry rather than report it — and
sit outside this record's derived-only scope** (mirrored in bim-specs;
canvas dimensions bind to parameters there).
**Derivation:** X1 (a dimension is a measurement claim; overriding it
falsifies deliverables); the data model already encodes it
(`entity_model.rs:1057`).
**Rejected:** AutoCAD-style text override (reference norm X4 —
overridden by X1, which outranks reference adoption).
**Tunable:** no.

**DR-D10 — Persistence tiers: snap toggles are user preference; the
current layer is persisted project state outside the undo chain.**
**Decision:** snap-kind/source toggles and snap radius persist per user
across projects; layer entities, order, and requested P9 state are journaled
project state; the **current layer** is persisted,
automation-readable and -writable project state that is **not
journaled and not undoable** (review finding 15).
**Derivation:** UIP-D3 (X7 class precedent: agent visibility does not
require journaling — selection proves it); C4's "defensible to a
Ctrl+Z user" — undo silently re-aiming _future_ commits is a trap;
rib-civil.md §2.2 stores the snap radius in global Grundparameter
(X4); X3 parity preserved through `layers.set_current`/`list`.
**Rejected:** journaled current layer (the trap; the earlier derivation
conflated agent parity with journaling — corrected at the source per
doctrine rule 2); per-project snap config (fights muscle memory).
**Tunable:** default-on snap kinds and sources per view mode (with
DR-D12).

**DR-D11 — Trim and extend are one tool.** **Decision:** one trim tool
shortens or extends the cursor-nearest end to the chosen boundary,
previewing the result; no separate extend button.
**Derivation:** X4 — rib-civil.md §2.1 Trimmen; X5 — the pair ships
together by construction.
**Rejected:** split trim/extend tools (two buttons for one gesture).
**Tunable:** no.

**DR-D12 — Snap precedence: per-source enables, intent-aware ranking,
one-shot override.** **Decision:** snap sources (authored geometry /
point cloud / terrain) are independently enableable with per-view-mode
defaults (all on in 2.5D; cloud off by default in 2D drafting). While a
drafting tool is armed (`draw` intent), **authored-geometry semantic
snaps outrank raw cloud samples at equal pixel radius**; a held
override key forces the otherwise-losing source for one pick. The
resting kind order stays `picking.rs:492-500`.
**Derivation:** review finding 1 (blocker): the kernel ranks kind
before pixel distance and `SnapKind::Point` (rank 0) — every cloud
sample — beats Vertex/Midpoint/Edge unconditionally, so closing a
polygon or dimensioning drafted vertices over a scan is impossible;
X1 (the user's construction must be able to reference itself); X4 —
Fangkreis catches _constructed_ geometry in RIB's cloudless drafting
world (rib-civil.md §2.2), and the cloud is our addition, so precedence
is ours to define; UIP-D1 class for the held-modifier pattern.
**Rejected:** global re-rank demoting cloud points (breaks cloud-first
picking for navigation/measurement intents); pixel-distance-only
ranking (a cloud point one pixel closer steals every endpoint);
per-tool snap dialogs (modality).
**Tunable:** yes — equal-radius tolerance, per-mode defaults,
override-key binding via `REGISTRY.md`.

**DR-D13 — A kernel terrain/cloud-surface snap producer.**
**Decision:** terrain snapping is a **new producer in the kernel ranked
pipeline**: ray intersection against DGM/elevation surfaces (and cloud
estimated-surface where the mesh does not exist), yielding
surface-kind candidates with full-precision positions. Mesh/Terrain MT-D12
owns surface BVH/refinement and registration; this producer consumes that
contract and shares its browser-GPU gate rather than registering a second
terrain path. The legacy
`DgmSnapProvider` ("STUB", `DgmSnapProvider.ts:6`, in the deprecated
package `legacy.ts:1`) counts as not existing (contract A2 code rule)
and is cited as design evidence only.
**Derivation:** review finding 2 (blocker — §3.3 previously rested on
the stub); DR-D2 (single pipeline); contract A2 code-claim rule, which
this finding produced.
**Rejected:** reviving the stub in the legacy package (DR-D2);
GPU-depth-only terrain snapping (display-resolution heights violate
D2's full-precision promise).
**Tunable:** intersection tolerance (X6).

**DR-D14 — Armed tools capture clicks; RMB opens the tool menu.**
**Decision:** while a Draw tool is armed, LMB and RMB _clicks_ (per the
UIP-D1 sub-threshold discrimination) belong to the tool: LMB picks
construction input and never changes the selection (UIP-D2 suspended
while armed, recorded in both specs); RMB click opens the tool menu —
Finish / Close / Undo vertex / Cancel — the discoverable finish path;
drag gestures (LMB navigation, RMB pan) and wheel zoom pass through
untouched. The full gesture map is in E2 and registers in
`REGISTRY.md`.
**Derivation:** review finding 5 and contract E2's gesture-arbitration
rule (which it produced); UIP-D1 (click-vs-drag threshold frees both
buttons), UIP-D5 (the context-surface event exists and routes to the
tool menu while armed); X5 — a multi-step tool without a discoverable
finish is a shipped half; rib-civil.md §4 lesson 2 (no modal rigidity —
the menu is one click, not a wizard).
**Rejected:** vertex picks also mutating selection (every polygon
trace shreds the user's selection); Escape as the only finish path
(hidden, and overloaded with cancel semantics — finding 3); a
persistent on-canvas finish button (chrome over content).
**Tunable:** shares the UIP-D1 threshold.

**DR-D15 — Drafting acts on the visible set: clip- and
visibility-aware snapping, full precision inside a locked box.**
**Decision:** an active viewing box scopes drafting exactly as it
scopes everything else: clipped-away authored geometry and cloud
regions leave the snap candidate and operand-pick sets; explicit
hidden state (hidden layers, hidden entities) does the same; natural
occlusion scopes nothing. Inside a **locked** box, cloud snap
candidates resolve against **full-precision source points within the
box** — the bake is a render economy and must not degrade snap
coordinates.
**Derivation:** **P4** (anything that acts on geometry acts on the
visible set — the precedent generalized from VB-D13, which this
finding instantiates for drafting); review finding 13; X2 — the
locked-box bake spends memory for speed, never for precision loss;
D2's never-degrade list.
**Rejected:** clip-unaware drafting snaps (snapping to an invisible
vertex behind the clip writes wrong survey geometry — the VB-D13
defect class); snapping against baked/decimated points while locked
(silently degrades committed coordinates).
**Tunable:** no.

**DR-D16 — Drafting-time styling: by layer by default, by
specification on demand.** **Decision:** a drafted entity's
presentation resolves through the BIM-owned chain (instance override →
type → definition-for-kind → `style_ref` → layer/app default,
bim-specs BS-D12); the Draw tool options expose the two user-facing
ends: the target layer's default style (ambient) and an optional
per-entity specification/style assignment at drafting time — the F9
half of RIB's W2 (rib-civil.md §2.3 Spezifikation, W2: "set line/point
specification (F9) and current Folie" before constructing).
Every tool also captures BIM's single `spec.current` catalog/type revision at
tool start (BS-D19), alongside its target layer. On commit, a specification
target layer replaces exactly-one membership atomically; absent target uses the
captured Draw layer. Explicit command arguments win, and a conflicting explicit
layer rejects with `SpecificationLayerConflict`.
**Derivation:** review finding 12; X4 (the reference pairs layer and
spec selection at drafting time); D3/DR-D7 split — Draw consumes
specifications, never defines them; BS-D12 owns the resolution order.
**Rejected:** per-entity manual formatting as the primary path
(re-creates the ad-hoc styling D3 exists to prevent); no drafting-time
styling (drops a documented reference workflow half — the finding).
**Tunable:** which style fields surface in tool options.

## 6. Current implementation delta

**Exists and stays:** all canonical entity types and payloads
(`entity_model.rs:22-58` type ids; curves incl. clothoid/spline/
composite `:228-334`; areas `:344-381`; text `:980-1002`; annotation
anchors `:1012-1023`; dimensions `:1042-1070`; alignments `:946-959`;
per-vertex optional Z `:174-181`; `layer_ids` `:1216`); the journaled
entity command layer (`entity_commands.rs:21-91`) and the canonical
control plane serving UI and automation identically
(`app_protocol.rs:5`); the kernel ranked snap pipeline
(`crates/himmelcad-render/src/picking.rs:492-500`) with semantic-snap storage
(`crates/himmelcad-render/src/cad_curve.rs:58-75`), builder emission (for
example arc snaps at `crates/himmelcad-render/src/cad_curve.rs:571-574`), and
refinement consumption (`crates/himmelcad-render/src/cad_curve.rs:324-340`);
the current kernel consumes Tab at
`packages/@himmelcad/viewer/src/kernel/KernelNavigationController.ts:460-465`
and its stale Tab-cycle comment is at the same file `:138-144`, both to be
rebound/renamed in round 3; 2D/2.5D/3D acquisition
semantics (ADR 0022 implementation); kernel curve tessellation
(`cad_curve.rs`) and glyph-atlas text layout (`text.rs:1-22`); LandXML
alignment import (`landxml.rs:484-486, 603-663`); the automation
envelope and generated Python SDK; the Builder status bar shows snap kind only
(`apps/builder/renderer/src/App.tsx:681-700`), not coordinates.

**Changes:** kernel snap producers for `Intersection` (ranked,
unproduced) and perpendicular; the new terrain producer (DR-D13);
intent-aware precedence and per-source enables over the kernel mask
(DR-D12); clip/visibility scoping of candidates and full-precision
locked-box resolution (DR-D15); the deprecated legacy `snapping/`
package and its Space binding retire (`legacy.ts:1`); the canonical
model gains one requested P9 layer state plus draw order, consuming UIP-D20/
SE-D19 rather than adding visibility/lock truth; legacy state migrates per DR-D4;
the non-journaled persisted current layer remains DR-D10; the exactly-one-layer command invariant with the Default
layer (DR-D4); the left panel Layers placeholder
(`EntityTree.tsx:130-154`) becomes the layer manager; ribbon gains the
Draw tab under the D2 remap (current taxonomy `ribbon.ts:37-156`,
restructured in coordination with the other domain specs); project
settings gain angle unit and direction reference (DR-D1); measurement
tools adopt the shared snap markers/readout when implemented (A3).

**New:** the drafting tool framework (tool lifecycle, rubber-band
preview, §3.5 construction-input state machine and prompts, UIP-D14 tool rungs,
Backspace step-back, RMB tool menu, DR-D5 pending-geometry Escape);
creation tools for point/line/polyline/arc/circle/clothoid/area/text/
dimension(+chains)/label incl. couple/pivot/buffer arc modes with
solution cycling; draw.edit (vertex grips, text content edit,
dimension/label re-placement); offset/trim/fillet/divide; the dimension
anchor/style resolver and derived dimension graphics (the compiler
reserves the parts and awaits resolved text/stroke,
`entity_compiler.rs:179-182`) plus label text and broken-anchor state;
`draw.assign_heights` (drape/typed/interpolated); layer commands
(`layers.*`) and draw-order render wiring; symbol/fill **access paths**
to `bim_object.place` (entity semantics BIM-owned, DR-D7); alignment
create-from-curve UI with auto-layer and `alignment.*` commands; P9 state
consumption; `hcad.component.support-role@1`, `CurveSubentityRefV1`,
the `hcad.derived-recipe@1` Draw offset/parallel payload profile, Point target acquisition metadata, and the complete
CIV-D15/CIV-D16 station reference adapter; snap config automation
(`draw.snap_config.*`); Reference/Inert command rejection; schema entries for
every new method (SDK staleness gate applies). `G-DR-INPUT` and `G-DR-DERIVED`
and their fixture generator are **to be created and registered**, not current
implementation evidence (D1).

Before implementation acceptance, the DATA-MODEL/accepted-ADR/project-format
owners must admit and version the point acquisition component,
`hcad.component.support-role@1`, and the `hcad.derived-recipe@1` Draw offset/parallel payload profile, including
migration, generated Rust/TypeScript/Python bindings, archive/fragment behavior,
unknown-version preservation, and strict sibling-reader failure. This spec defines
the Draw semantics but does not silently amend those owners; substitutes are not
permitted while admission is pending.

## 7. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** core unit tests — polyline/composite commit round-trip
  incl. per-vertex optional Z (DR-D3); clothoid connector geometry
  against LandXML-imported spirals (author/import symmetry, DR-D8);
  area loops with associative uses and hole validity; dimension anchor
  revalidation, chain commit as one command with per-point anchors, and
  broken-state transition on referenced-entity delete;
  **exactly-one-layer invariant** — assign replaces, empty falls back
  to Default, Default undeletable (DR-D4); alignment-from-curve station
  origin + auto-layer. Snap unit tests — semantic candidate updates on
  commit; intersection/perpendicular producers against analytic cases;
  terrain producer ray-intersection correctness (DR-D13);
  **intent-aware precedence** — authored vertex beats cloud sample at
  equal radius under `draw` intent, resting order unchanged otherwise,
  one-shot override wins (DR-D12); hidden-layer exclusion,
  Reference-layer inclusion, Hidden/Inert exclusion, and **clip scoping** — candidates inside a
  clipped region are absent, full-precision resolution inside a locked
  box (DR-D15/P4). Add `StationReferenceV1` repeated display station,
  equation edit, reversal, stale/deleted region, reload and undo cases;
  support-role copy/fragment/archive/export-loss cases; every
  `CurveSubentityRefV1` topology, reversal/remap/prune and 10,000-member indexed
  refusal; offset line/arc/circle/join/collapse/self-intersection/non-planar/
  unsupported-kind geometry plus DAG, source-delete, failure, last-good,
  detach/relink, undo/redo and reload.
- **changed:** component tests — every §3.5 state-table row for Line and Point,
  including digit→Length, prefixes, exclusive representations, locks, field-vs-
  viewport Enter, partial-text click confirmation, Backspace, one-rung Escape,
  source invalidation, and the invariant that Tab never cycles candidates;
  per-step prompts; angle units; Layers four-state/Mixed/cause/current behavior;
  Manual target with no residual, neighbour-fit rank/residual/confidence and
  Manual fallback; station identity/foot/side; support and segment status;
  offset Current/Stale/Detached/Failed Properties actions.
- **push (risk-triggered by viewer/kernel paths):** browser interaction
  tests — full §3.1 polyline flow; **snap to own linework over a dense
  cloud** (close a polygon onto its first vertex above a scan — the
  finding-1 blocker scenario); **DR-D5 Escape rule** — a Line with one placed
  point + live rubber band publishes nothing; a Polyline with ≥2 placed vertices
  commits only those vertices and discards the pending span; tool remains armed;
  next no-pending Escape closes; Enter/ribbon/Finish commit valid construction;
  Cancel discloses and discards all; RMB click opens the tool menu, RMB drag still
  pans, armed-tool LMB never changes selection (DR-D14); Escape ladder
  one rung per press incl. bar-focus revert; 2D vs 2.5D vertex Z
  acquisition over a seeded scene; **drafting over a cloud hole** —
  pending "Z —", distinct marker, require-height blocks commit
  (DR-D3); `draw.assign_heights` drape admits the entity to 3D;
  ordinate refusal on height-less vertex; dimension follows moved
  anchor; **layer race** — `layers.set_current` mid-trace does not
  redirect the running tool, explicit `layer` parameter beats ambient
  (DR-D4); a pick through a clipped region returns no clipped
  candidate (DR-D15); every batch-2 state and failure in §3.6–3.9.
- **push (risk-triggered) / release (always):** create and register the exact
  `G-DR-INPUT` and `G-DR-DERIVED` targets, fixture generator, commands,
  capability routing, output artifacts, thresholds, memory/worker/cancel/latest-
  generation/CAS assertions specified in D1. Until both files and routes exist,
  the required gate fails and the behavior remains unverified; prose is not a pass.
- **release, capabilities `browser-gpu` + `real-data`:** §3.3 end-to-
  end on a real scanned street — draft a cloud-snapped breakline,
  verify vertex heights against source-point coordinates (incl.
  inside a locked viewing box — full-precision assertion, DR-D15),
  feed it to terrain triangulation; drape cancellation publishes
  nothing partial.
- **automation:** SDK parity test — every `draw.*`, `layers.*`, shared
  `interaction.state.*`, and `alignment.*` contract callable; exact target
  acquisition, support-role, `CurveSubentityRefV1`, `StationReferenceV1`, and
  offset recipe schemas/results generated; create/regenerate/detach/relink and
  error/status parity; `bim_object.place` reachable and
  single (no duplicate draw-side command, DR-D7); scripted "trace
  these coordinates as a polyline on a new layer and dimension its
  longest edge" end-to-end; a document snapshot read returns the
  drafted entities with exact geometry (runs with the deduplicated SDK
  gate).
- **manual/visual:** both-theme screenshots at 100% and 150% of §3.1–3.9
  compared against every E1 criterion, including Manual/Fit/NoData target,
  equation ambiguity, parent+segment, support P9 states, and offset Current/
  Stale/Detached/Failed.

Explicitly unverified: `G-DR-INPUT`/`G-DR-DERIVED` do not yet exist (an
implementation/release blocker, not evidence of a registry finding); subjective rubber-band feel beyond the p95 gate;
snap-marker legibility over arbitrary user data beyond the two test
backdrops; drape quality on pathological clouds (calibration under X6)
— accepted as manual-review-only.

## 8. Owner-decision items

None. Candidates tested against the escalation protocol and dissolved:

- _"Which drafting syntax/interaction style?"_ — closed by X4 (RIB
  field model) plus the dossier's practitioner evidence (§4) selecting
  direct manipulation + typed twin (DR-D1); no axiom conflict.
- _"Are layers project data or view state?"_ — closed by X3/P1: agents
  must see and manage them, so canonical (DR-D4); the journaling
  nuance for the current layer is closed by the UIP-D3 class (DR-D10).
- _"May a dimension value be overridden?"_ — an X1-vs-X4 tension
  resolved by the priority order itself (DR-D9); a pre-decided
  trade-off is not a conflict. The canvas-dimension boundary is a
  scope split with bim-specs, decided by D3, not an owner call.
- _"Who wins between authored geometry and the cloud under the
  cursor?"_ — closed by X1 plus the reference's snap model (DR-D12);
  precedence values are X6 calibration.
- _"How much of the alignment subsystem ships now?"_ — D7/Civil dissolved the
  former deferral: Civil owns semantic alignment workflows while Draw owns the
  admitted primitives/access contribution (DR-D8/DR-D19).
- _"What is a placed symbol?"_ — the cross-spec contradiction was
  resolved by derivation strength inside the doctrine (bim-specs
  review finding 1; DR-D7), exactly as the escalation protocol
  demands: axioms and precedents decided it, not the owner.
- _"Should Escape cancel or commit?"_ — X1 distinguishes accepted vertices from
  the unaccepted rubber-band endpoint, while X5/P6/UIP-D14 require one class rule;
  DR-D5 dissolves the apparent binary choice without inventing either loss.
- _"Which typed representation wins?"_ — C1/X1/X5 and GAP-D2 require parity
  without contradiction; DR-D17 makes modes exclusive and calculated, so no
  product-identity choice survives.
- _"Which repeated station is meant?"_ — X1 and Civil CIV-D16 already decide
  chainage plus region/equation/side identity; Draw adopts it in DR-D19.
- _"Are support, layer state, segment identity, reticle fit, or offset lifecycle
  Draw-private models?"_ — P9/UIP-D20/SE-D19, UIP-D22, P10/MT-D25, P8, X3, and
  X7 assign the single shared owners and require the Draw adapters in DR-D4/
  D18/D20; no owner boundary remains.
- _"What budgets and exact-offset rollout are acceptable?"_ — X1 forbids
  approximations presented as exact; X6/P3 delegates gate and rollout calibration.
  The initial budgets and typed unsupported classes are recorded in D1/DR-D20.
- _"May the spec advance before registry/gates exist?"_ — Builder README gates
  `specified` on registered rows and a clean report; Function Contract D1/E3
  separately blocks implementation/release claims until the executable gates
  exist. The round-3 registry closes only the former.

All twenty 2026-09-01 review findings — two blockers, eleven majors, five minors,
and both ideas (one initially queued and activated by batch 2) — resolved from
X1/X2/X3/X4/X5/X6, P4, the UIP precedents, ADR 0022, and the amended
contract rules without an owner question; all calibration values are
delegated under X6/P3 and recorded as tunable.

## 9. Disposition — spec review (2026-09-01, findings 1–20)

| #   | Finding                                              | Disposition                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker: cloud wins every snap over drafted geometry | DR-D12 per-source enables + intent-aware precedence + one-shot override; §3.1/§3.3; D1 gate asserts the winner; §7 browser + unit tests                                                                                                 |
| 2   | Blocker: §3.3 rested on the `DgmSnapProvider` stub   | DR-D13 new kernel terrain producer; stub demoted to design evidence; §6 New; §7 tests; contract A2 code rule cited                                                                                                                      |
| 3   | Escape mid-polyline: commit or discard contradiction | **Preserved and clarified by revised DR-D5:** Escape rejects only the live span, commits already placed valid construction (≥2), and commits nothing for a one-point Line; §3.1/B2/§7 mirror the one rule; explicit Cancel discards all |
| 4   | Tab triple-booked                                    | Revised by batch 2: Tab/Shift+Tab always focus/traverse input fields; Up/Down cycles candidates; E2 gesture map                                                                                                                         |
| 5   | No armed-tool vs platform gesture arbitration        | DR-D14 click capture + RMB tool menu; E2 gesture map; reconciled with UIP-D1/D2/D5                                                                                                                                                      |
| 6   | Catalog cannot draft rib-civil W3                    | Added draw.line tangent modes, draw.arc couple/pivot/buffer, draw.clothoid; DR-D8 re-derived; §2.1 dispositions                                                                                                                         |
| 7   | No post-commit editing story; boundary points at fog | draw.edit row (grips, text edit, placement drag); select-edit spec registered owed in §1/A3                                                                                                                                             |
| 8   | Height gaps silent; nothing assigns heights          | DR-D3 revised: visible "Z —" state, require-height option, draw.assign-heights; §3.3; §7 over-hole test                                                                                                                                 |
| 9   | `layer_ids` Vec vs scalar assumption                 | DR-D4 exactly-one-layer command invariant, Vec reserved, Default layer specified; §3.2; §7 invariant tests                                                                                                                              |
| 10  | Commit-target layer races automation                 | DR-D4 capture-at-start + explicit `layer` parameter; §3.2, E2; §7 race test                                                                                                                                                             |
| 11  | Maßketten missing                                    | Chain mode on draw.dimension (one journaled command, per-point anchors); §3.4; §2.1 disposition                                                                                                                                         |
| 12  | No drafting-time styling (F9 half dropped)           | DR-D16 style-by-layer default + per-entity spec override via BS-D12 chain; A2                                                                                                                                                           |
| 13  | Viewing box missing from consumers; clip-aware snaps | DR-D15 citing **P4**; E2 consumer row; full-precision locked-box resolution; §7 test + benchmark variants                                                                                                                               |
| 14  | C3 citation overreach (HV pattern)                   | C3 rewritten: dossier supports visible+untouchable; snappability recorded as our derived extension                                                                                                                                      |
| 15  | Current-layer journaling derivation wrong            | DR-D10/DR-D4: persisted + automation-writable, excluded from undo (UIP-D3 class); C4, §3.2                                                                                                                                              |
| 16  | No angle convention                                  | DR-D1: project angle unit (gon default) + north azimuth; C1; component test                                                                                                                                                             |
| 17  | Arc-in-polyline default                              | Tangential continuation default, 3-point alternative; §3.1                                                                                                                                                                              |
| 18  | Input bar lacks E1 criteria; no step prompts         | E1 criteria 7–10 (layout, focus, prompts, field order); prompts in §3.1 and DR-D1                                                                                                                                                       |
| 19  | Idea: auto-layer per Achse                           | Adopted (X4, rib-civil §2.3); draw.alignment row, DR-D8                                                                                                                                                                                 |
| 20  | Idea: Hilfspunkte, station+offset points             | Activated by batch 2: explicit support role under DR-D18; station/offset access contribution consumes Civil CIV-D15/CIV-D16 under DR-D19; §2.1/§3.7–3.8                                                                                 |

Cross-spec reconciliation (bim-specs review finding 1) and the
canvas-dimension driving-kind boundary are recorded in DR-D7 and DR-D9
respectively.

## Cross-spec reconciliation 2026-09-02

| Item                        | Disposition                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terrain snapping            | DR-D13 cites Mesh MT-D12 and shares its browser gate; Mesh cites DR-D13.                                                                                                                                                                        |
| Persistent measurements     | A3 replaces transient wording with MI-D2's canonical inspection-entity boundary.                                                                                                                                                                |
| Effective interaction state | DR-D4 now adopts P9/UIP-D20 and cites SE-D19's sole effective-state resolver; legacy visibility/lock migration is explicit.                                                                                                                     |
| Plan dimensions             | PE-D17's **Model dimension…** is registered as a surface-local access path to DR-D9 with reconciled gestures.                                                                                                                                   |
| D6 current specification    | DR-D4/DR-D16 consume BIM BS-D19: capture `spec.current`, apply specification style, and route to the specification target layer atomically.                                                                                                     |
| P10/G12 dependency          | DR-D20 supplies Draw's typed offset/parallel payload and output rules while MT-D25 alone owns the common `derived.recipe.*` lifecycle; SE-D20/IF-D18 invalidations arrive once at gesture/transaction end.                                      |
| Semantic cursor             | Draw cites UIP-D24/§9.7 and declares pick/snap/Fangkreis, Shared3DTarget, prohibited, and wait for line/point/station-offset tools.                                                                                                             |
| GAP §6 Civil inbound        | DR-D6/DR-D8/DR-D12/DR-D13, amended by DR-D19, cite CIV-D1–CIV-D16 for candidate keys, snap truth, semantic ownership, and Mesh hand-off while Draw retains primitives.                                                                          |
| Re-walk 2026-09-02          | P5: continuous previews journal once at commit. P6: Escape/Enter/right-click finish/Undo remain honest. P7 fix: angle units/direction and alignment/layer naming are editable project/office defaults; `Achse <name>` is a seed, not a mandate. |

| S1 (owner statement 2026-09-02) — Tab must reach direction/slope fields without moving the cursor | **Resolved across specifications and Registry:** Tab/Shift+Tab only focus/traverse fields; Up/Down cycle candidates only with the UIP-D16 indicator. The obsolete kernel binding/comment remains implementation work under DR-D22. |

## Owner statements batch 2 — 2026-09-02

This section and §3.5–3.9 amend §2.1, §3.1, DR-D1/D2/D4/D5/D6/D8/
D12–D14 and E1–E3. §3.5 is the sole Line/Point input grammar; §3.6 separates
Manual from neighbour-fit acquisition; §3.7 adopts CIV-D15/CIV-D16; §3.8
defines support/subentity identity and applicability; §3.9 defines the
Draw-specific MT-D25 recipe and restore scope.

**Round-3 registry transaction applied:** the rebuilt registry keeps one
`draw.point` act and enumerate visible modes Point / 3D target / Point by
station-offset; keep one `draw.offset` act with recipe get/regenerate/detach/
relink; add support-role queries/commands as Draw contributions; add Civil rows,
UI/Select P8/P9 state/history rows, and `G-DR-INPUT`/`G-DR-DERIVED`; remove F6's
future-Civil closure; register `interaction.state.explain` and retain
`selection.effective_state.explain` only as a deprecated compatibility alias;
revise Escape rung 4 so Draw cites DR-D5's pending-geometry transition rather
than generic cancel; replace every normative idle/armed Tab-cycle statement;
and rerun duplicate-act, surface, state, shortcut, gesture, decision-citation,
and reciprocal-citation checks. The 2026-09-02 cross-spec reconciliation made
those documentation changes. Status is `specified` under the README registry
gate; DR-D22 still blocks any implemented/verified claim.

**DR-D17 — Construction input is one tri-modal state machine.**
**Decision:** §3.5's explicit representations, routing, locks, focus, commit,
click, Backspace, Escape, cycling, and invalidation transitions are mandatory for
Line and Point and the applicable subset for every coordinate-bearing Draw tool.
The panel may mirror but never own common coordinate truth.
**Derivation:** C1, owner S1/G1, X1, X5, GAP-D2, UIP-D16, DR-D1/DR-D5.
**Rejected:** tool-private dialogs; first-field/last-writer ambiguity; Tab candidate
cycling; independently writable Cartesian/polar or Z/ΔZ/slope values; silent
discard of partial text.
**Tunable:** compact field order and preview sampling only; transitions/key meanings
are not tunable.

**DR-D18 — Support and segment identity do not fork geometry.**
**Decision:** §3.8's `hcad.component.support-role@1` is explicit canonical
metadata on ordinary geometry; `CurveSubentityRefV1` is view-local, topology-aware,
revision/semantic-hash guarded, and consumed only by the declared matrix. Copy,
fragment, export-loss, P9, remap/prune, history, and extreme-Composite behavior are
part of the contract.
**Derivation:** owner S2/S3/G5/G6, P8, P9, X1, X3, UIP-D19/UIP-D21,
SE-D19, RIB Hilfspunkte evidence (`rib-civil.md` §2.2).
**Rejected:** inferring support from missing metadata; RIB's database exclusion as a
canonical-identity rule; index-only locators; materialized segment entities;
silent parent widening or nearest-member remap.
**Tunable:** semantic highlight cadence/LOD under UIP-D21; identity and eligibility
are not tunable.

**DR-D19 — Civil chainage identity is consumed, not deferred or duplicated.**
**Decision:** §3.7 passes the complete CIV-D16 `StationReferenceV1`, signed
offset, and explicit vertical basis into the ordinary `draw.point.create`; Civil's
CIV-D15 recipe owns interpretation/invalidation. A scalar display station is
accepted only after exactly-one resolution. Equation edits preserve chainage;
ambiguity/stale/deleted identity becomes typed unresolved state, never a guess.
**Derivation:** X1, X3, X7, P10, Civil CIV-D15/CIV-D16, program README's
cite-and-revise rule, `cross-spec-needs.md` "From civil.md".
**Rejected:** a Draw station schema/subsystem; scalar station identity; nearest
candidate; baked coordinates that silently survive a changed equation.
**Tunable:** display precision/label formatting under Civil; identity is not tunable.

**DR-D20 — Parallel/offset curves use a Draw recipe within MT-D25.**
**Decision:** §3.9's Draw payload profile in `hcad.derived-recipe@1` records exact source/subentity,
plane, signed distance/side, join/end/self-intersection policies, versions, output
presentation, generation, last-good/error, and full undo/reload/export state.
Linked/stale/regenerate/detach/relink/auto-detach/error/DAG/CAS behavior is the
single P10/MT-D25 lifecycle. Supported/refused curve classes and stale consumers
are explicit; preview is P5-transient and commit is one journal entry.
**Derivation:** P5, P10, owner S14/G12, X1, X3, MT-D25, SE-D19/SE-D20 class
behavior.
**Rejected:** silent live mutation; provenance-free copies; a Draw-private
dependency state machine; implicit planar flattening; publishing approximated
clothoid/spline offsets as exact.
**Tunable:** automatic-regeneration cost budget, join defaults, and worker/memory
budgets under X6; geometry identity and atomic restore scope are not tunable.

**DR-D21 — Manual target placement and neighbour fitting are distinct truth
claims.**
**Decision:** §3.6 separates Manual 3D target from an optional registered
neighbour-fit evaluator. Manual position is an explicit estimate with no
statistical residual/confidence; fitting exposes captured sources, algorithm,
rank, RMS residual, and the stated confidence formula, and always falls back to
Manual on NoData/degeneracy. Both converge on ordinary `draw.point.create` with
full acquisition provenance and one undo root.
**Derivation:** X1, X3, C1, UIP-D22 (reticle proposes but owns no authority),
Pointcloud batch-2 reticle lease, RealWorks dossier §8.1–8.2.
**Rejected:** fabricated confidence for manual transforms; requiring a fit before
point creation; silently promoting an inferred plane/sample to survey truth; a
reticle-private point command.
**Tunable:** named evaluator, neighborhood/minimum sample count, residual limit,
and display precision under X6; provenance and truth labeling are not tunable.

**DR-D22 — Batch-2 continuous behavior requires executable Draw gates before
implementation/release promotion.**
**Decision:** D1's exact `G-DR-INPUT` and `G-DR-DERIVED` scripts, fixture
generator, package commands, verifier routes, capability fail behavior, raw result
artifacts, and fail conditions must exist and pass before the behavior is called
implemented or release-ready. Until then no prose calls the gate agent-runnable.
**Derivation:** Function Contract D1/E3, X1, X6/P3, `docs/TEST-TIERS.md`, Builder
README's promotion rule.
**Rejected:** prose-only smoothness claims; optional skip on missing GPU/real-data;
a gate that samples frames without winner/state/latest-generation assertions.
**Tunable:** numeric thresholds and fixture scale under X6; executable presence,
capability failure, and semantic assertions are not tunable.

Required gates `G-DR-INPUT`/`G-DR-DERIVED` add line/point absolute-Z/ΔZ/slope
parity, zero-run refusal, panel/bar identity, sparse-cloud reticle failure, explicit
support role, segment invalidation, station/offset equation identity/stale-axis
refusal, and offset detach/DAG/latest-generation cases. They are specified in D1/
§7 but absent until round 3. Cursor declarations:
pick crosshair, snap-kind marker/Fangkreis, prohibited, wait, and Shared3DTarget;
Draw defines no cursor glyph.

| Work-order item                               | Disposition                                                      |
| --------------------------------------------- | ---------------------------------------------------------------- |
| S1/G1 line/point C1 workflow                  | Applied by DR-D17; old Tab remnants corrected.                   |
| S2/S3/G5/G6 support and segment consumption   | Applied by DR-D18.                                               |
| S4/G7 point reticle                           | Applied as adapter to `draw.point.create`.                       |
| S7–S9/G8/G9 Civil boundary and station/offset | Applied by revised DR-D8/DR-D19; Civil remains semantic owner.   |
| S14/G12 parallels/offsets                     | Applied by DR-D20, citing the one MT-D25 recipe model.           |
| S13/G11 cursor declaration                    | Applied as a UIP-D24/§9.7 consumer; vocabulary remains UI-owned. |

## 10. Disposition — batch-2 adversarial review (2026-09-02)

Disposition count: **13 resolved in this specification and the round-3
documentation transaction; 1 executable-artifact implementation delta.** The
delta does not waive the finding or imply that the behavior is implemented.

| Finding id  | Disposition                                                                                                                                                                                                                                                         | Spec section / decision id                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 (blocker) | **Resolved.** One Escape rule rejects only the pending rubber-band segment, commits already placed valid construction, and commits nothing for a one-point Line; workflow and test text now match.                                                                  | §3.1, §3.5, B2, E2, §7; DR-D5                                                        |
| 2 (blocker) | **Cross-spec documentation resolved.** Every normative spec and the rebuilt registry reserve Tab/Shift+Tab for fields and Up/Down for a live candidate list. The kernel binding/comment and executable UI test remain implementation work covered by DR-D22.        | §3.1, §3.5, E2 gesture map, §6, cross-spec reconciliation table; DR-D1/DR-D17/DR-D22 |
| 3 (blocker) | **Resolved.** Draw passes complete CIV-D16 `StationReferenceV1`, signed offset, and explicit vertical basis; ambiguity, equation edits/reversal, stale/deleted identity, reload and loss are deterministic.                                                         | §3.7, C4, E2 station matrix, §7; DR-D19 citing CIV-D15/CIV-D16                       |
| 4 (blocker) | **Registry portion resolved; executable gate portion remains.** The atomic row/access/state/gesture reconciliation is registered and the standing documentation checks are clean. DR-D22's missing artifacts block only implemented/verified claims.                | B1, D1, §6–7, cross-spec reconciliation table; DR-D22                                |
| 5 (blocker) | **Specification resolved; implementation evidence pending.** The nonexistent benchmark is not claimed runnable; exact script/fixture/command/capability/output/fail contracts are mandatory implementation/release prerequisites.                                   | D1, §6–7; DR-D22                                                                     |
| 6 (major)   | **Resolved.** Explicit Line/Point transition table defines representation selection, digit routing, locks, editable Tab order, field/viewport Enter, click with partial text, Backspace, Escape, candidate/source invalidation, and exclusive vertical modes.       | §3.5, C1, §7; DR-D17                                                                 |
| 7 (major)   | **Resolved.** A2 now uses corrected Access/RealWorks evidence and labels Himmel:CAD extensions; Hilfspunkte is adapted; Civil solely dispositions Achskleinpunkt while Draw cites its access contribution.                                                          | §2.1, A2; DR-D18/DR-D19                                                              |
| 8 (major)   | **Resolved.** Layer requested state is one P9 value; UIP-D20 presents it and SE-D19 alone resolves all effective causes; legacy migration/Inert are explicit; `interaction.state.explain` is canonical and the selection-named query is only a compatibility alias. | §3.2, C3, E2, §6–7; DR-D4                                                            |
| 9 (major)   | **Resolved.** Versioned support-role schema/lifecycle and topology-aware `CurveSubentityRefV1` with applicability, remap/prune proof, exports, history, and extreme fixture are specified.                                                                          | §3.8, C2/C4, E2 support/segment matrices, §7; DR-D18                                 |
| 10 (major)  | **Resolved.** Manual and neighbour-fit acquisition are separated; residual/confidence is fit-only, failure falls back to Manual, visible access and exact command/provenance/Escape/recovery are defined.                                                           | catalog, §3.6, B1, E1/E2, §7; DR-D21                                                 |
| 11 (major)  | **Resolved.** Draw-specific offset recipe defines geometry/policies/classes/refusals, MT-D25 lifecycle, stale consumers, last-good/error, source loss, atomic restore scope, reload/export, DAG/CAS, and tests.                                                     | catalog, §3.9, C4, E2, §7; DR-D20                                                    |
| 12 (major)  | **Resolved.** Four passive-consumer matrices cover Shared3DTarget, support role, subentity token, and station/offset recipe state across render, P9, snap, tools, siblings, export, journal, automation, and recovery.                                              | E2 matrices; DR-D18–DR-D21                                                           |
| 13 (minor)  | **Resolved.** Status-bar claim says snap kind only; semantic-snap declaration, emission, consumption, and actual kernel Tab binding now cite exact qualified ranges.                                                                                                | catalog, C3, §6                                                                      |
| 14 (minor)  | **Resolved.** Draw adopts UIP-D21/UIP-D22 and adds failable both-theme/150% criteria and exact screenshot states for target, station, segment, support, and recipe lifecycle.                                                                                       | E1, §7                                                                               |
