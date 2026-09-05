# BIM specifications and objects — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner
statements batch 2 and the D6/P7 revision.
Document class: plan. Walks `docs/FUNCTION-CONTRACT.md` including the current
2026-09-02 contract
(code-claim file:line, per-dossier-row catalog disposition,
extreme-class-member, input-gesture arbitration); every consequential
choice carries a `docs/DECISION-DOCTRINE.md` decision record. Resolution
per program README: **workflow level** for the specification editor
(incl. create-from-selection), apply-specification, and the entity
properties panel (§2), plus all five D6 workflows under the dated heading;
**contract level** for object placement, classification mapping, and schedules
(the latter deferred with reasons, BS-D13/BS-D14).

Input evidence: `docs/builder-program/dossiers/revit.md` (primary BIM
reference per contract A2), `dossiers/rib-civil.md` §2.3,
`dossiers/field-codes.md` §§1–7, owner decisions D2/D3/D6, doctrine P7, and
the current implementation: `packages/@himmelcad/specs`,
`apps/builder/renderer/src/SpecsIsland.tsx`,
`crates/himmelcad-core/src/{entity_model.rs,property_schema.rs,canonical_resources.rs}`,
`crates/himmelcad-io/src/ifc_provider.rs`. This spec implements owner
decisions D3/D6 and preserves the separation formerly mandated by
`docs/OPEN-QUESTIONS.md` Q2: user attributes stay separated from
geometry-driving parameters even now that specifications are generative.

E1 reference artifact: §7 of this document (in-repo failable written
criteria; no third-party screenshots per repository license discipline).

Registry rows (BIM tab per owner decision D2). Status is against audited
implementation, not this plan; a placeholder is not implementation:

| Id                        | Tab · group                    | Access paths                                                                             | Surface                                           | Perf                                    | Automation command/query                                     | Status vs current implementation                                                                                                                                                               |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bim.spec.editor`         | BIM · Specifications           | ribbon toggle; console; automation                                                       | dedicated resizable window                        | bounded + continuous preview            | `spec.definition.*`, `spec.type.*`, `spec.symbol.*`          | **partial, wrong host/model** — local island and flat records exist (`apps/builder/renderer/src/SpecsIsland.tsx:12-20`); no canonical definition/type commands                                 |
| `bim.spec.catalog`        | BIM · Specifications           | editor **Catalog** page; console; automation                                             | editor tables + import/export review              | bounded→long                            | `spec.catalog.get/page/update/import/export`                 | **missing** — current `SpecCode` is a fixed numeric type (`packages/@himmelcad/specs/src/types.ts:15-16`) and the library is localStorage (`packages/@himmelcad/specs/src/library.ts:6,22-40`) |
| `bim.spec.apply`          | BIM · Specifications           | ribbon on selection; entity menu; picker; Properties; console; automation                | inline + picker popover                           | bounded                                 | `spec.apply`, `spec.unapply`                                 | **missing** — current package says it is not wired to core entities (`packages/@himmelcad/specs/src/types.ts:2`)                                                                               |
| `bim.spec.from-selection` | BIM · Specifications           | entity context menu; console; automation                                                 | inline → editor window                            | bounded                                 | `spec.create_from_selection`                                 | **missing** — Builder's complete renderer command switch has no specification verb (`apps/builder/renderer/src/App.tsx:561-675`); only block-member substrate exists (BS-D17)                  |
| `bim.spec.shortcuts`      | BIM · Specifications           | ribbon toggle; right-panel tab; F9 focus; console; automation                            | detachable right function-panel tab               | bounded                                 | `spec.shortcuts.*`, `spec.current.get/set`                   | **missing** — current island's selected id is component-local state (`apps/builder/renderer/src/SpecsIsland.tsx:37-57`) and row clicks only change it (`:177-185`)                             |
| `entity.properties`       | right strip default tab        | always-present tab; entity menu **Properties**; automation                               | right panel tab                                   | bounded                                 | `properties.*`                                               | **partial** — count/Mixed UI exists, but specification sections and typed placement editing do not (`apps/builder/renderer/src/App.tsx:957-1105`)                                              |
| `bim.object.place`        | BIM · Objects                  | ribbon; quick surface **Place object here**; Draw symbol/fill paths; console; automation | viewport tool + type browser                      | bounded                                 | `bim_object.place`                                           | **missing** — specs are not wired to core (`packages/@himmelcad/specs/src/types.ts:2`) and Builder's command switch has no object-place verb (`apps/builder/renderer/src/App.tsx:561-675`)     |
| `bim.object.generate`     | BIM · Generate                 | ribbon; source-geometry entity menu; code-import completion review; console; automation  | detachable right panel + viewport completion tool | continuous preview; bounded→long commit | `bim_object.generate`, `bim_object.generation_plan`          | **missing** — no role/generator/source-provenance model in `packages/@himmelcad/specs/src/types.ts:184-214`                                                                                    |
| `bim.sewer.objects`       | BIM · Sewer                    | ribbon type gallery; compatible source entity menu; console; automation                  | type browser + generation panel                   | bounded→long                            | `bim_object.generate` with `manhole` / `pipeRun` definitions | **missing** — canonical built-ins have no manhole or pipe-run kind (`crates/himmelcad-core/src/entity_model.rs:20-159`)                                                                        |
| `bim.spec.library`        | Specification editor · Catalog | **Import table…**, **Export table…**; console; automation                                | OS picker + collision preview                     | bounded→long                            | `spec.catalog.import/export`                                 | **partial, obsolete format** — JSON serialize/download substrate exists (`packages/@himmelcad/specs/src/library.ts:8-20`); CSV/XML round-trip and canonical versions do not                    |
| `bim.classification.map`  | BIM · Classification           | editor section; console; automation                                                      | editor section                                    | bounded                                 | `spec.classification.*`                                      | **partial substrate** — IFC import writes classification (`crates/himmelcad-io/src/ifc_provider.rs:1642-1657`); no mapping surface                                                             |
| `bim.schedule`            | BIM · Reports                  | ribbon; console; automation                                                              | dedicated window (future)                         | bounded                                 | `schedule.*`                                                 | **missing/deferred** — no command in Builder's complete switch (`apps/builder/renderer/src/App.tsx:561-675`); BS-D14                                                                           |
| `bim.components`          | BIM · Objects                  | P C A; selecting/editing consumers                                                       | Properties + bounded manifest                     | bnd; paged                              | `bim.component.page/get`                                     | Not implemented — batch-2 (D7) capability; BS-D23                                                                                                                                              |
| `bim.strata`              | BIM · Objects                  | R P C A                                                                                  | editor/validation + Properties                    | bnd→long                                | `bim.strata.get/page/create/update/validate`                 | Not implemented — batch-2 (D7) capability; BS-D25                                                                                                                                              |

The code-driven `file.import` act remains owned and cataloged by
`specs/import-formats/import-formats.md` §1; this document contributes the
`spec.resolve_code` query and `bim_object.generate` command but does not create
a duplicate import registry row (BS-D21).

## 1. The specification model

### 1.1 Three levels: definition → type → instance

A **specification definition** is the generator: a required string `code`,
name, draw folder,
parameter schema, per-entity-kind presentation rules, optional parametric
symbol, optional IFC mapping, placement modes, and one or more semantic roles.
A **type** is a named row in the definition's value table with its own required
string `code` — exact values for its type-bound parameters ("Tree small",
"DN 200"). Definition codes are unique in the definition keyspace; type codes
are unique in the import-resolvable type keyspace. The durable lookup key is
`(catalog id, catalog version, row kind, exact code)`, while stable internal
ids preserve references if a user explicitly renames a code. An **instance** is a canonical entity
referencing definition + type, carrying instance-bound parameter values
and optional presentation overrides. This is Revit's family/type/instance
economics (revit.md §1 [S1, S2]; type catalogs [S9, S10] — "a generator
plus a value table, not a style record") without Revit's fixed category
level: kind-applicability plus the code hierarchy replaces categories
(revit.md §5 do-not-adopt; §4 pain "rigid category system"). Code syntax is
not part of that three-level model: the selected catalog declares it (BS-D2,
BS-D18).

Definitions, types, and the project's specification library are **canonical
journaled entities**, not app-local state. The current localStorage library
(`packages/@himmelcad/specs/src/library.ts:6`, key
`himmelcad.specs.library.v1`) is retired with a one-time import. (BS-D1)

### 1.2 Two parameter classes, one identity space

Per D3's separation mandate, every definition-declared parameter is one of:

- **Geometry-driving parameter** — drives the symbol/generator (crown
  diameter, spacing, module width). Declared type-bound (value lives in the
  type row) or instance-bound (value lives on the placed entity). Private to
  the generator unless explicitly exported to reporting.
- **Attribute** — user data with project-wide identity (species, install
  year, fire rating). Reportable, filterable, schedulable; never moves
  geometry.

Both live in one canonical identity space: Revit needs five parameter
kinds and external GUID files only because families, projects, tags, and
schedules are separate silos (revit.md §2.2 [S7, S8], "key structural
insight"); one canonical store keeps the _distinction_ — reportable
identity vs. generator internals — and deletes the seam machinery
(revit.md §5 do-not-adopt: shared-parameter GUID files). (BS-D3)
Attributes on the _least typical_ carriers (contract extreme-member
rule): a point-cloud or raster entity accepts attributes like any other
— the property machinery is kind-agnostic; only presentations are
kind-gated.

Parameters carry typed values with units (length, number, integer, boolean,
text, enum, material reference) and a **stable id**; the display name is
mutable, values are keyed by id, so a rename never orphans values (BS-D9).
Geometry-driving parameters may declare an optional domain — min/max for
numeric kinds, the value list for enums; the default is unbounded. Domains
feed validation and the auto-flex set (§1.2a). Formulas are allowed on
geometry-driving parameters: arithmetic, comparison, conditional,
references to sibling parameters of the same definition; evaluation is
directional (parameter drives geometry — revit.md §2.3 [S6]), cycles are
rejected at commit, and there is no free-form constraint solver.
Array/repetition counts may be any integer ≥ 0 — Revit's min-2 array with
the IF-workaround is a documented pain, not a behavior to adopt
(revit.md §2.3 [S15]).

#### 1.2a Auto-flex set

A definition commit evaluates the symbol over {every type row} × {every
instance-bound parameter at its default, and at its declared min and max
where a domain exists}. Undeclared domains contribute only the default —
flexing never invents bounds. When the combination count exceeds the
evaluation budget (tunable, X6), the editor shows the inline busy state
and evaluates in the background; commit is never blocked on flex
completion (BS-D8).

### 1.3 One placement concept, three modes

A definition with a symbol declares which placement modes it supports:
**point symbol** (one occurrence at a point entity or picked location),
**along-curve** (occurrences tiled along a curve at a spacing parameter),
**area fill** (occurrences filling an area at spacing/pattern parameters —
the owner's "spacing-based area fills", D3). Revit implements these as three
mechanisms with three portability behaviors (detail components, repeating
details, line-based array families — revit.md §2.4 [S12–S15]) and the
dossier's stated lesson is to offer one concept with placement modes
(revit.md §2.4, §5). (BS-D4)

Along-curve and area-fill occurrences are **derived data** owned by the host
entity, regenerated from parameters — not thousands of canonical entities.
The canonical record is the host entity plus its specification component;
spacing edits are single journaled parameter updates. (BS-D5)

Reconciliation with the Draw domain (review 2026-09-01 finding 1): a
placed object is a **canonical entity of the definition's applicable kind
carrying the specification component** — never a bare `hcad.block@2`
instance; occurrences of along-curve and area-fill modes are derived;
blocks are the render substrate only (§1.4). One canonical command,
`bim_object.place`, creates placed objects; the Draw tab's symbol/fill
tool entries are access paths resolving to it and to ordinary
entity-creation-plus-`spec.apply`, exactly as ribbon/console/automation
resolve to one command per the design system. draw.md DR-D7's
canonical-block-instance wording is amended on the Draw side; this spec's
model governs. (BS-D16)

### 1.4 Symbols compile onto the block substrate

A parametric symbol is authored as 2D/3D geometry over the definition's
parameters, on a canvas that hosts the **Draw toolset over the shared snap
pipeline and input bar** — there is no second drafting path (review
finding 3). Canvas primitives expose their intrinsic dimensions (circle
diameter, segment length, offset between members) as **bindable slots**:
the user binds a slot to a parameter or leaves it as a typed constant.
This is deliberately simpler than Revit's reference-plane skeleton with
locked constraints (revit.md §2.1 [S4, S5]) — the slot _is_ the
constraint. Canvas binding dimensions are a distinct, geometry-**driving**
kind and sit outside draw.md DR-D9's scope, which governs measuring
annotation dimensions whose values are derived and never overridable.

Every symbol declares its **space**: world (drawn at model scale) or
screen (fixed pixel size at a world anchor) — the `TextSpace` precedent
(`entity_model.rs:977–985`). A 2D symbol renders in-plane in 2D/2.5D
views and on its placement plane in 3D views; richer per-mode 3D
stand-ins are queued (BS-D15).

At evaluation time (definition × type × instance values) the symbol
compiles to the existing canonical block machinery —
`hcad.resource.block-definition@2` with `BlockMember`,
`BlockInstanceOverrides` (`crates/himmelcad-core/src/canonical_resources.rs:165–211`,
`entity_model.rs:961–974`) — one baked block definition per distinct
evaluated value set, content-addressed so identical evaluations share one
tessellation. No parallel symbol-instancing machinery is built. (BS-D6)

### 1.5 Presentation resolution

Resolved per entity, first match wins: instance presentation override →
type-level presentation values → definition presentation for the entity's
kind → entity `style_ref` → layer/app default. Presentation primitives
(linetype, hatch, texture, material) move from the localStorage library to
the existing canonical resource vocabulary
(`LineTypeResource`, `HatchPatternResource`, `TextureResource`,
`MaterialResource` — `canonical_resources.rs:30–46`), which already mirrors
the specs package shapes. This is the object-styles role — graphics resolved
by specification rather than per-element formatting (revit.md §2.5 [S16]) —
with `style_ref` kept as the manual, spec-independent override path.
(BS-D12)

## 2. Workflow narratives

### 2.1 Authoring a generative specification with a parametric symbol

A surveyor's office wants every surveyed tree to appear as a proper tree
symbol scaled by crown diameter. On the **BIM** tab the user presses
**Specifications**; the specification editor opens as a dedicated resizable
window (BS-D7) with the project still live behind it. The left side shows the
specification tree grouped by this office catalog's declared code hierarchy
(for this example, 2 "Vegetation", 21 "Tree"); the user selects code 21,
presses **New specification**, and enters definition code 211, name "Tree,
deciduous", draw folder "Vegetation / Trees". These digits are narrative
office data, not product grammar (P7/BS-D18).

On the **Parameters** page the user adds `crownDiameter` (length,
geometry-driving, instance-bound, default 4 m), `trunkDiameter` (length,
geometry-driving, type-bound), and the attributes `species` (text) and
`plantedYear` (integer). The two classes are visually separate lists —
attributes can never drive geometry (D3, §1.2).

On the **Symbol** page the authoring canvas offers the familiar Draw
tools — same snap pipeline, same input bar, same shortcuts (§1.4; no
second drafting dialect to learn). The user draws a circle; its diameter
appears as a bindable slot in the member's slot list, currently a
constant. One click binds it to `crownDiameter`; the trunk cross's size
binds to `trunkDiameter`; the crown offset stays a typed constant. The
symbol is declared world-space, and its placement modes: point symbol on,
area fill on (orchard planting), along-curve off. Every edit is a
journaled step on the **global** journal — Ctrl+Z in the editor window
undoes the last canonical step and the console names it ("Undid: bind
crownDiameter"); there is no window-local undo stack (C4). Escape in any
field reverts per `docs/DESIGN-SYSTEM.md` "Input consistency".

On the **Types** page every definition must commit an explicitly coded,
designated **Default** type row (initial values are the parameter defaults), so
a definition is applicable the moment it exists and no uncoded row is hidden.
The code field is suggested from the active catalog and must validate before
definition commit (BS-D1/BS-D18). The user adds coded rows "Young" (trunk
0.15 m) and "Mature" (trunk 0.4 m), typed or imported from a CSV file — the type-catalog
workflow (revit.md §3 W7 [S9, S10]) without the same-named-file
convention: Import value table… maps CSV columns to parameters in a
preview dialog. Committing a change to an existing type row shows
"affects N placed instances" first (BS-D9); the same copy guards
definition-level commits that regenerate placed geometry.

There is no flex button. On every commit the editor re-evaluates the symbol
against **all** types plus each parameter's min/max, and the window's error
list shows any failed evaluation with the offending parameter value —
automatic flexing replacing Revit's hand-run loop (revit.md §2.1/§4
"manual verification"; BS-D8). A live preview pane renders the symbol for
the selected type at project scale; selecting another type flexes the
preview instantly.

The **Presentation** page holds the per-entity-kind styling the current
island already models (color, linetype, hatch, …), now with working editors
for every applicable kind, and the **Classification** page optionally maps
the definition to an IFC class (system "IFC IFC4", code "IFCGEOGRAPHICELEMENT",
predefined type) reusing the existing `hcad.component.bim-classification@1`
shape (BS-D13). Closing the window (title-bar close, ribbon toggle, or
Escape outside a field) commits nothing extra — everything already
committed field by field; a half-typed field is discarded, never committed
(B2). The definition is immediately available to Draw tools, automation
(`spec.list` shows it), and colleagues via library export.

There is a second birth path: **New specification from selection**
(entity context menu, `spec.create_from_selection` — promoted from the
review's idea list, BS-D17). The user selects the hand-drawn manhole
lid — two circles and a cross — and invokes it: a new definition opens in
the editor with the selected geometry copied onto the symbol canvas via
the existing block-from-selection substrate
(`BlockMemberSource::EntityReference`, `canonical_resources.rs:171–183`)
and presentations seeded from the entities' styles. The user then binds
slots to parameters as in the first path. The selected source entities
are untouched.

### 2.2 Applying a specification; placing objects

The project contains 40 imported survey points on the "Vegetation" layer
— and the user's box selection accidentally caught one boundary curve.
Right-click, **Apply specification…** (also on BIM › Specifications for
the current selection). A compact picker popover shows the specification
tree filtered to the **union** of definitions applicable to any selected
kind, a type column, and a **"No specification"** entry at the top
(→ `spec.unapply`, the X5 pair of apply). Each definition row states its
applicable count: "Tree, deciduous — applies to 40 of 41". The user picks
"Tree, deciduous › Mature" and commits: one journaled `spec.apply`
attaches the component to the 40 applicable entities atomically, the
console logs "Applied 211 Tree, deciduous (Mature) to 40 of 41 entities —
skipped 1 curve", and Ctrl+Z removes all 40 assignments as one step —
never silent, never blocking on the stray kind (C2). The picker consumes
no viewport gestures: selection clicks pass through and the counts follow
live; it closes only on commit, Escape, its close affordance, or
activating another function surface — never on a stray outside click,
which would destroy the live-count contract (B2).

One tree is bigger: the user selects it and, in the properties panel's
Specification section, types `crownDiameter` = 7 m — an instance-bound
parameter, so only this tree's symbol grows. The user then drags an area
entity around the orchard, applies "Tree, deciduous" in **area fill** mode
with spacing 5 m: the area fills with derived tree occurrences; changing
spacing to 6 m in the panel regenerates the fill as one undo step (§1.3).

Standalone placement: **BIM › Place object** (also the quick-surface
entry "Place object here") opens the same picker as a gallery; choosing a
type arms a viewport placement tool — each click issues `bim_object.place`,
creating a canonical entity of the definition's kind with the
specification component attached (§1.3 reconciliation, BS-D16). The
drawing tools themselves (active specification while drawing, draw-folder
routing into the entity tree, the Draw-tab symbol/fill entries) belong to
the **Draw domain spec** as access paths; this domain owns the catalog,
the picker surfaces, and the single canonical command they all resolve
to.

Deleting a type that instances still reference is blocked with the count
("In use by 57 entities") and offers retype-to-sibling; deleting a
definition follows the same rule (E2).

### 2.3 Multi-select property editing

The user box-selects 12 trees and 3 fence curves. Properties is the right
strip's **default tab** per the ui-platform tab model: always reachable,
never closeable to nowhere, auto-restored whenever no function tab is
active (adopting ui-platform; its spec aligns to the same wording). It
shows the header "15 entities" with a **kind filter** drop-down
("All kinds · Point (12) · Curve (3)"), the multi-category narrowing
pattern proven in Revit's palette (revit.md §3 W3 [S28, S29]). Below,
three sections:

- **Entity** — the existing envelope rows (name, owner, layers, placement —
  placement gains typed numeric editing, closing today's read-only JSON
  gap, C1).
- **Specification** — shown for the common subset: the definition row
  ("Tree, deciduous" — or "Mixed" when definitions differ) with a clear
  affordance (×) that issues `spec.unapply` for the filtered selection
  (the picker's "No specification" twin, X5), a **type selector** that
  re-types every selected entity at once, instance-bound geometry
  parameters, and attributes. Only properties common to all filtered
  entities appear (intersection rule, revit.md §3 W3).
- **Display** — resolved presentation with per-entity overrides.

`species` shows the placeholder **"Mixed values"** because two values
differ (the core already aggregates Shared/Mixed —
`property_schema.rs:236–246`); the user types "Acer platanoides" and
presses Enter: one atomic canonical transaction assigns it to all 12
filtered entities (`compile_multi_entity_property_edit`,
`property_schema.rs:394`), the console logs it, Ctrl+Z reverts all 12 as
one step. Escape in the field reverts to the last committed text and keeps
the panel (design system). Switching the type from "Mature" to "Young" via
the type selector first shows the blast radius in the control itself —
"Retype 12 entities" — and, because type-_table_ edits in the editor
affect every instance project-wide, the editor shows "affects N placed
instances" before committing a type row change (BS-D9; improving on the
reference per revit.md §5, grounded in DESIGN-SYSTEM "Confirmation copy
names the actual consequence"). Type-level and instance-level values are
visually distinct sections, never a modal "Edit Type" detour (revit.md §5).

If another client edits a selected entity mid-edit, the CAS-guarded commit
fails cleanly (`VersionConflict`), the panel re-queries and shows the fresh
values with an explanatory error row — no partial application (E2; the
wire contract's exact-revision design already enforces this).

## D6 owner statement 2026-09-02

This heading is the in-place amendment for
`docs/builder-program/OWNER-DECISIONS.md` D6 and its owner correction,
`docs/DECISION-DOCTRINE.md` P7: office conventions are user data. It specifies a
mechanism, an editable **DEFAULT** catalog, and table exchange; none of the
example codes below is a product-mandated office grammar. Evidence is
`dossiers/field-codes.md`: feature libraries and distinct code/attribute/
stringing roles (§§1–2), STRATIS `*.SPZ` and F9 (§3.2), card_1 structured
alphanumeric codes (§3.3), ALKIS/ATKIS, OKSTRA, and ISYBAU structures (§4),
sewer formats (§5), conversion precedents (§6), and the D6 mapping (§7).

### D6.1 Specification codes are catalog keys

#### Workflow narrative

On BIM › Specifications the office CAD administrator opens **Catalog**. The
project currently uses **DEFAULT · revision 1**. At the top, **Code schemas**
lists independently editable prefix rules. One rule parses `09 | 41 | 100` as
kind `BIM object` | class `stormwater manhole` | parameter `nominal width =
1.00 m`; another recognizes a card_1-style alphanumeric prefix-number-postfix;
another permits declared free text. A schema states which segments classify
kind/class, which digits encode typed parameters, and whether a declared
suffix token encodes a typed attribute or the value instead comes from a named
attribute column. Digit-encoded parameters and attribute suffixes are both
first-class choices; a catalog may mix them by prefix. That catalog feature is
not confused with Trimble's differently purposed string suffix: `Fence01`
string identity, the `Fence` feature code, topology/control codes, and typed
attributes remain separate fields (`field-codes.md` §§1, 2.1, 7.1).

The administrator edits a row, previews every affected type and instance, and
publishes revision 2. Published revisions are immutable; editing creates a new
revision. Existing objects retain their resolved internal type id and recorded
catalog revision; their meaning is never changed by reparsing a display code.
A field import explicitly selects revision 2. Referenced revisions are project
reachability roots through objects, imports, undo, and snapshots; maintenance
may collect one only after every such reference expires. If a later edit
renames a code, an optional alias can preserve lookup of the old external code;
the alias is visible and collision-checked, never inferred.

**Import table…** accepts UTF-8 CSV or XML. CSV is a typed record stream with a
`record_kind` column (`catalog`, `schema`, `definition`, `type`, `parameter`,
`alias`, `presentation`, `role`) plus stable ids and parent ids; repeat records
carry parameter and segment rows, so no JSON is hidden in a cell. XML carries
the same records in a versioned namespace and is the full-fidelity canonical
exchange. Both previews validate schema version, code grammar, units,
references, required columns, duplicate keys, prefix ambiguity, and affected
instances before commit. Collisions use BS-D1's per-row **Keep existing / Replace
with incoming / Rename incoming code** choices; Replace states the blast
radius, and the whole accepted import is one atomic journaled step. **Export
table…** emits either representation with catalog id, human version, monotonic
revision, content hash, grammar, rows, aliases, and source notes, so an office
can round-trip its own convention rather than hand-edit product data.

The shipped DEFAULT table is ordinary editable project/user data. The packaged
seed is used only to create the user's editable **DEFAULT** on
first use. New projects snapshot the selected user-catalog version into their
canonical project catalog; later project edits do not mutate other projects,
and later user-default edits do not reinterpret existing projects. The editor
offers **Project catalog** and **User defaults for new projects** scopes with
the same validation/import/export mechanism; only project catalogs can be
current, pinned, or referenced by entities. Its initial seed is deliberately
small and provenance-labeled:

| Definition code | Type code | Kind / role                       | Seed values                                 | Source and status                                                                                                                                |
| --------------- | --------- | --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --------------------------------------------------------------------------------- |
| `0941`          | `0941100` | BIM manhole / `manhole.center`    | stormwater; nominal width 1.00 m            | owner D6 example, using the catalog-declared `09                                                                                                 | 41  | 100` layout; editable example, not a universal rule (`field-codes.md` §§7.1, 7.4) |
| `6130`          | `6130`    | point presentation / no generator | traffic signal presentation seed            | sourced STRATIS point specification example (`field-codes.md` §3.2 [R2]); the same text in the separate definition/type keyspaces is intentional |
| `5110`          | `5110`    | line presentation / no generator  | water-protection boundary presentation seed | sourced STRATIS line specification example (§3.2 [R2])                                                                                           |
| `2300`          | `2300`    | area presentation / no generator  | residential building presentation seed      | sourced STRATIS area specification example (§3.2 [R2])                                                                                           |

Bundled _schema examples_, not active meanings, demonstrate ALKIS/ATKIS
five-/six-digit hierarchy, OKSTRA Fachbedeutung free-text characters, card_1
prefix-number-postfix, and the ISYBAU positional **instance identifier**. The
last is explicitly not offered as a manhole type-code schema: it identifies
network instances, not product types (`field-codes.md` §§4.1–4.3).

#### Contract answers

**A1/A2/A3.** Outcome is a versioned, office-owned catalog that resolves an
external code without hard-coded product syntax. STRATIS grounds numeric keys,
current specification, and layer targeting; card_1 grounds numeric plus
alphanumeric structured keys; German catalogs prove schema-specific hierarchy,
not one grammar (`field-codes.md` §§3.2–4). Revit grounds definition/type rows;
BS-D1 remains the collision-preview sibling. **B1/B2/B3.** Catalog editing is
the editor's dedicated-window page; Import/Export are visible there, console,
and automation. The OS picker may cancel; preview x/Escape discards staging;
commit closes the preview and produces one project undo step or one restorable
user-default revision according to the visible scope. **C1/C2/C3/C4.** Segment
scales, offsets, and typed parameter decoders have numeric fields; no drag-only
value exists. Catalog edits ignore viewport selection. Published revisions and
content hashes freeze import interpretation; definitions/types/catalog
revisions in a project are canonical and journaled. User-default edits publish
atomic immutable user-catalog revisions with visible restore history; they are
not entries in an open project's Ctrl+Z chain. **D1/D2.** Validation of a small table
is bounded; a 100,000-row catalog/import impact scan is a UIP-D10 job with first
progress ≤250 ms, cancellation response ≤500 ms, bounded streaming memory, and
atomic publication. Weak hardware may virtualize rows, never skip validation.
**E1/E2/E3.** §7 criteria apply. Consumers are editor, shortcuts, Draw,
properties, code import, generators, layers/presentation, automation, and
export provenance. They read ids plus exact catalog revision, never reparse a
label. Extreme members: free-text `A` is the least structured valid key; a
100,000-row mixed-schema office table with leading-zero codes is the largest.
Tests in §6 cover both, prefix ambiguity, leading zeros, and CSV↔XML semantic
round-trip. Catalog pages claim no viewport gesture; typing stays in the
focused table field, Escape follows UIP-D14 field/menu/function order.

#### Catalog rows

| Id                 | Owner / access                                                 | Surface                    | Perf         | Automation                     | Resolution |
| ------------------ | -------------------------------------------------------------- | -------------------------- | ------------ | ------------------------------ | ---------- |
| `bim.spec.catalog` | BIM › Specifications › Catalog; console; automation            | editor tables              | bounded→long | `spec.catalog.get/page/update` | workflow   |
| `bim.spec.library` | Catalog **Import table… / Export table…**; console; automation | picker + collision preview | bounded→long | `spec.catalog.import/export`   | workflow   |

#### Decision record — BS-D18: catalog-declared codes and table exchange

**Decision:** every definition and type row has a required exact string code;
the selected versioned catalog declares its own per-prefix grammar, segment
meaning, digit decoders, attribute mappings, normalization, and optional
free-text rules. DEFAULT is editable data. CSV and XML import/export carry the
whole catalog; collisions use BS-D1 preview and atomic resolution.
**Derivation:** owner D6 corrected direction; P7; X1; `field-codes.md` §§1,
3.2–4, 7.1, and 7.4. **Rejected:** retaining the current 1–10 digit product
validator (`packages/@himmelcad/specs/src/types.ts:15-16`); mandating
`09|41|100`; preferring attribute
suffixes as a product rule; reparsing old objects after catalog edits. Each
would convert an office convention into product truth or silently change
meaning. **Tunable:** row virtualization and job thresholds only (X6); grammar
content is user data, not a calibration delegated to the product team.

#### Disposition rows

| Evidence row                                                             | Disposition                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Trimble FXL feature code + string suffix + typed attributes (§§2.1, 7.1) | adopted as separate catalog code, `string_id/control`, and attributes; no suffix conflation |
| STRATIS `*.SPZ`, numeric key, F9/current/layer (§3.2)                    | adopted into DEFAULT seeds, current-spec flow, and target layer; no seven-digit claim       |
| card_1 prefix-number-postfix (§3.3)                                      | adopted as an available catalog grammar                                                     |
| ALKIS/ATKIS hierarchy; OKSTRA Fachbedeutung (§4.1–4.2)                   | adopted as schema examples/aliases; not asserted as universal BIM type keys                 |
| ISYBAU positional identifier (§4.3)                                      | retained as an instance/network-id schema, rejected as evidence for a type-code grammar     |

### D6.2 Specification shortcuts panel

#### Workflow narrative

The user opens BIM › **Specification shortcuts**. It is a right-panel function
tab because the user keeps drawing while choosing a specification; like every
function tab it may detach and re-dock under ui-platform B3/UIP-D8 without
changing viewport behavior. The project has twelve pins. Eight compact slots
are visible at the default panel size and the rest scroll/virtualize; there is
no pin cap. Each slot shows code, concise name, point/line/area/role icon,
catalog-version warning, and current state. Pin, unpin, and reorder are
journaled project commands. A missing/deleted target remains as a repairable
**Unavailable pin**, never silently retargets by name or nearby code.
Publishing a catalog revision does not silently retarget the exact current
specification: affected pins show **Update available**, and clicking one (or an
explicit automation call) selects the new exact revision.

Clicking `0941100 · Stormwater manhole 1.00 m` calls the one
`spec.current.set` state transition. Draw reads that same state and captures
the specification/type and its target layer when a point/line/area tool starts,
just as DR-D4 captures target layer. On the finished Draw create command,
DR-D16's specification presentation is attached and DR-D4's exactly-one-layer
membership is replaced with the specification's target layer immediately and
atomically. If the specification has no target layer, the captured Draw layer
remains. If it is incompatible with the chosen Draw kind, the tool does not
start and names `IncompatibleSourceKind`; it never creates then repairs an
incorrect entity. Explicit `specification` and `layer` command parameters beat
ambient state and are validated together: when the specification declares a
target, a different explicit layer rejects with `SpecificationLayerConflict`;
when it declares none, the explicit layer wins. Automation therefore cannot
race a panel click or bypass the specification's declared routing.

F9 opens/focuses the shortcuts tab, matching the documented STRATIS F9
specification box (`field-codes.md` §§3.2, 7.2). Number keys do **not** select
slots: the complete `field-codes.md` dossier documents F9 and configurable
button grouping but contains no numbered-slot binding, pin count is unbounded,
and printable digits belong to Draw's numeric input while a tool is armed
(draw DR-D1; ui-platform §3.6). Screen-reader/keyboard users Tab to a pin and
activate it with Enter/Space; automation can page pins and set the exact id.

#### Contract answers

**A1/A2/A3.** The result is rapid, persistent selection of one specification
whose Draw effects are immediate. STRATIS grounds Set/Take/Apply, F9, and layer
routing; the unbounded set/eight visible is D6/X6, not attributed to a vendor
(`field-codes.md` §§3.2, 7.2). Draw DR-D4/DR-D16 own create-time layer/style;
ui-platform UIP-D8/UIP-D14 own hosting/Escape. **B1 reachability:**

| Path           | Present behavior / reason                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Ribbon         | BIM toggle opens/closes the function tab                                                                  |
| Entity context | **Pin specification** on a spec-bearing entity; no generic void action                                    |
| Quick surface  | absent: global catalog choice is not void-location context (UIP-D13)                                      |
| Console        | `spec shortcuts`, `spec current <catalog/type>`                                                           |
| Automation     | `spec.shortcuts.get/page/pin/unpin/reorder`; `spec.current.get/set`                                       |
| Keyboard       | F9 focuses; Tab + Enter/Space operates pins; number-slot shortcuts absent for the evidenced reasons above |

**B2/B3.** Tab x, ribbon re-toggle, and detached-island x close; a detached
function island occupies UIP-D14 rung 6 and a docked tab rung 7. Closing keeps
pins/current state and cancels no Draw tool. **C1/C2/C3/C4.** No direct numeric
manipulation; parameter badges open typed fields in the normal tool/generation
panel. Selection is unchanged. Pins are canonical project state and pin edits
undo; current specification is persisted and automation-writable but not
journaled/undoable, matching current layer DR-D10—Ctrl+Z must not silently
re-aim future drawings. **D1/D2.** Click/set and an eight-slot render are
bounded <100 ms; 100,000 pins is the extreme and must remain searchable/
virtualized without limiting data. No render-quality degradation changes the
chosen id. **E1/E2/E3.** Consumers are Draw, layer assignment, display,
Properties, console, automation, and persisted project state. Least typical is
an unavailable pin; largest is the 100,000-pin project. Tests assert one state,
explicit-parameter race immunity, DR-D4/DR-D16 atomic effects, keyboard focus,
detach parity, and no number-key claim. The panel claims no viewport gestures.

#### Catalog row

| Id                   | Owner / access                                                            | Surface                             | Perf    | Automation                                 | Resolution |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------- | ------- | ------------------------------------------ | ---------- |
| `bim.spec.shortcuts` | BIM › Specification shortcuts; entity pin action; F9; console; automation | detachable right function-panel tab | bounded | `spec.shortcuts.*`, `spec.current.get/set` | workflow   |

#### Decision record — BS-D19: one current specification and persistent pins

**Decision:** an unbounded, project-persisted pinned set (eight visible by
default) references catalog type ids; one project-persisted, automation-visible
current-specification state is the sole ambient state Draw consumes. Pins are
journaled; current selection uses SE-D19's separate P8 history, never document Ctrl+Z. F9 focuses the panel; numeric
slot shortcuts are absent. **Derivation:** D6; P1/X3; X6; `field-codes.md`
§§3.2/7.2; DR-D4, DR-D10, DR-D16; UIP-D8/UIP-D14 and §3.6.
**Rejected:** per-tool current specifications (state fork); eight-item cap
(D6 says unbounded); number keys (no X4 evidence and collision with numeric
entry); undoable current state (Ctrl+Z retargets future work). **Tunable:**
eight visible and compact-slot breakpoints (X6), never total pin count.

#### Disposition rows

| Candidate                                           | Disposition                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| STRATIS F9 Set/current + specification layer (§3.2) | adopted; F9 focuses the shared panel and create commits style/layer through Draw        |
| Trimble grouped/arranged code buttons (§2.1)        | adopted only as evidence for configurable rapid-access buttons, not number-key bindings |
| Number keys 1–8                                     | rejected: absent evidence, unbounded pins, Draw numeric-input conflict                  |
| Separate Draw and BIM current states                | rejected: violates D6's one canonical state and P1                                      |

### D6.3 Role-based BIM generation

#### Workflow narrative

Generation is D3's semantic completion step, not a styling side effect. The
user selects authoritative point, line, or closed-area geometry and chooses a
compatible catalog role. The right generation panel shows every required
typed parameter, its source (**code segment**, **attribute**, **catalog
default**, **picked geometry**, or **typed now**), and a view-local preview.
Nothing canonical is generated until all requirements validate. A missing
value blocks with a stable named reason such as
`MissingRequiredParameter(depth)`, `MissingAuthoritativeHeight`,
`OpenBoundary`, `IncompatibleSourceKind`, or `AmbiguousDirection`; Builder
never substitutes zero height, project north, a guessed side, or a nearby
coordinate (X1).

For `manhole.center`, the selected point has the role declared by the catalog
(for DEFAULT, plan center). The prompt **Pick measured cover point** uses the
shared exact snap pipeline; hidden or clipped candidates are absent under P4.
The panel shows typed diameter and depth fields live-synchronized with any
allowed handles (C1). The cover point supplies only the catalog-declared cover
position/elevation semantics; shaft axis, invert, and depth are derived only
when the role explicitly defines that relationship. With all requirements
valid, **Generate manhole** publishes one `bim_object.generate` command and one
full 3D manhole. Picking a point here is object completion, not an inspection
Measurement: Measure/Inspect owns persistent measurement artifacts and is not
invoked (`measure-inspect.md` §1 boundary).

For `wall.inner-edge`, the source is a line/polyline and the role declares it
as the inner location line. Thickness and wall height are typed or come from
visible catalog defaults; side is picked with a reversible arrow and
`fallDirection` is an explicit typed direction/vector twin. Neither is inferred
from vertex order. The result is a canonical wall object. For `room.floor` or
`room.ceiling`, the source is a closed planar area, the user declares which
surface it represents and types room height; unknown Z or a nonplanar/open
boundary blocks. The result is a canonical room volume, not an area plus label.

The command payload captures source entity ids and expected revisions,
catalog/type/role ids and catalog revision, resolved typed parameters, and
`sourceDisposition`. Default **Keep construction geometry** leaves sources
authoritative and linked; explicit **Replace construction geometry** changes
visibility/ownership in the same transaction and undo restores it. Ctrl+Z
removes the generated object and restores every source effect as one step.
Source edits mark the generated object **Source changed** and offer a fresh
preview; they never overwrite a manually edited result. A Select/Edit whole-
object transform composes only the generated object's placement per SE-D3 and
sets a visible manual-placement override; it never moves measured source
geometry. Regeneration then asks whether to keep or reset that override.

#### Contract answers

**A1/A2/A3.** Civil 3D network-from-object and Revit point/curve/wall placement
ground the explicit role/type/parameter completion step; Trimble/Leica ground
capture-versus-derived provenance but not complete BIM generation
(`field-codes.md` §§1, 3.1, 6). We deliberately extend their feature processing
to canonical BIM under D3/D6. Draw supplies geometry/snaps; Measure does not
own completion picks; Select/Edit SE-D3/SE-D14 govern later whole-object
transforms. **B1:** BIM › Generate and BIM › Sewer, compatible source-entity
menus, import review, console, and `bim_object.generation_plan/generate`; no
void quick entry because a source is required; no keyboard shortcut evidenced.
**B2/B3.** The detachable right panel is required while picking the viewport;
close/ribbon toggle keeps completed commands but discards the view-local plan.
Escape follows field revert → active pick/drag revert → placement tool cancel →
detached/tab close (UIP-D14). **C1/C2/C3/C4.** Every handle has typed twins;
one source object at a time for wall/room/manhole, while batch import uses the
same planner. Selection changes do not retarget the captured source. Evaluated
geometry is content-addressed like BS-D6; there is no user lock until a valid
object exists. One generate command/undo owns object plus optional source
effects; derived mesh is rebuildable.

**D1/D2.** Exact picks and previews are continuous and use Draw's snap/render
gates. A manhole/wall/room commit is bounded under 1 s normally. A 100,000-
vertex room or batch of >10,000 objects registers a UIP-D10 job: progress
≤250 ms, cancel acknowledgement ≤500 ms, memory bounded by streaming source
geometry plus one object build, no partial canonical result, discard-and-
restart after crash while the source plan remains. Weak hardware coarsens only
preview tessellation. **E1/E2.** Passive consumers:

| Consumer                            | Required effect                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layers / tree                       | generated object receives exactly one specification target layer under DR-D4; linked source remains separately identifiable                               |
| Display / render / pick / snap      | BS-D12 presentation and evaluated 3D geometry; all geometry acts and completion picks obey P4                                                             |
| Export / IFC                        | exporter receives semantic kind, type, parameters, topology, provenance; missing required mapping blocks that format, never degrades to a symbol silently |
| Measurements                        | Measure can snap/attach to generated geometry; no Measurement is created by generation                                                                    |
| Plan captures                       | linked captures become stale and pinned captures remain exact under the plan-editor lifecycle when object revision changes                                |
| Automation / properties / schedules | same ids, role, parameters, completeness, source refs, catalog revision, and named blockers are queryable                                                 |
| Select/Edit                         | SE-D3 placement-only transform; source observations untouched; manual override is visible before regeneration                                             |

Largest member is the 100,000-vertex room/batch threshold case; least typical
is a heightless 2D area, which remains valid CAD but is rejected for 3D room
generation with `MissingAuthoritativeHeight`. **E3.** §6 adds unit, browser,
automation, failure, P4, transform, and real-sewer fixtures. Gesture claims:
LMB click is claimed only during an explicit completion pick; LMB/RMB drags and
wheel retain platform navigation; RMB click remains the tool menu; Tab traverses
Draw input fields and Up/Down cycles candidates; typing focuses the panel/input bar; Escape uses the
ladder. No claim exists while merely reviewing parameters.

#### Catalog rows

| Id                    | Owner / access                                                             | Surface                            | Perf                      | Automation                                       | Resolution |
| --------------------- | -------------------------------------------------------------------------- | ---------------------------------- | ------------------------- | ------------------------------------------------ | ---------- |
| `bim.object.generate` | BIM › Generate; compatible entity menu; import review; console; automation | detachable panel + completion pick | continuous + bounded→long | `bim_object.generation_plan/generate`            | workflow   |
| `bim.sewer.objects`   | BIM › Sewer; compatible source menu                                        | same generator panel               | bounded→long              | same command with sewer definition/type/role ids | workflow   |

#### Decision record — BS-D20: validated role generation is one command

**Decision:** point/line/area + catalog role + complete typed parameters
produces one canonical BIM object through one CAS-guarded journaled command.
Planning/preview is view-local; missing or ambiguous domain truth blocks with a
named reason. Sources remain linked and authoritative by default; optional
replacement is atomic; later generic transforms affect object placement only.
**Derivation:** D3/D6; X1/X3; P4/P5; `field-codes.md` §§3.1, 6, 7.1/7.3;
DR-D4/DR-D12; MI §1 boundary; SE-D3/SE-D14. **Rejected:** style/block-only
output (not BIM); partial canonical placeholders presented as complete;
invented Z/direction/height; per-vertex journal entries; transform rewriting
survey sources. **Tunable:** job threshold and preview tessellation only (X6).

#### Disposition rows

| Reference workflow                                   | Disposition                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Trimble/Leica feature processing (§§2, 6)            | adopt source/derived provenance, attributes, diagnostics; reject claim that it proves full BIM generation |
| Civil 3D network from object (§§3.1, 6)              | adopt explicit parts/type/direction/elevation completion and preview                                      |
| Revit point/curve placement and wall Pick Lines (§6) | adopt compatible source geometry + visible type/height/location/orientation parameters                    |
| Measure/Inspect persistent measurement               | no overlap: completion picks create no measurement artifact                                               |
| Select/Edit generic transform                        | adopted after generation as placement-only, with source/manual-override disclosure                        |

### D6.4 Code-driven field import contract

#### Workflow narrative

In Import's existing XYZ/CSV mapping flow (`import-formats.md` §3.1,
IF-D5/IF-D8), the surveyor maps X/Y/Z, point number, **code**, optional
`string/control`, and named attribute columns, then chooses catalog **Office
2026 · revision 12**. Import owns bytes, delimiter/locale/encoding, column
mapping, exact row validation, CRS/placement, string/control assembly, staging,
loss consent, and the one import transaction. BIM supplies a pure,
revision-pinned `spec.resolve_code` preflight and the BS-D20 generation planner.

Preflight runs: raw code → selected catalog grammar → exact type row → allowed
source kind/role → decoded code parameters + mapped typed attributes → required
parameter validation → proposed entity kind, layer, presentation, and generator.
The review lists **Resolved**, **Incomplete**, **Ambiguous**, **Unknown**, and
**Invalid** counts and every row's named reason before commit. String/control
codes first assemble source point/line/area geometry; they are never parsed as
type parameters (`field-codes.md` §§2.1, 7.3–7.4).

Resolved and complete items call the same deterministic BS-D20 generator inside
Import's atomic batch envelope. Incomplete, ambiguous, unknown, or invalid code
observations are still committed as plain `hcad.point@1` survey points with raw
code, row/file provenance, and diagnostics, and appear in a persistent **Code
review** list; line-control participation does not erase those source points.
They are never silently dropped. The user may map a code, fill parameters, and
generate later. Cancellation leaves neither orphan generated objects nor a
half review list. Undo removes the imported source points, generated objects,
and review records as one import step. Re-running with another catalog revision
is an explicit reviewed update, never background reinterpretation.

#### Contract answers

**A1/A2/A3.** Trimble reports unknown codes but ignores their processing;
Himmel:CAD keeps every row and review record. Civil 3D/Trimble separate code
geometry processing from semantic conversion (`field-codes.md` §§2.1, 3.1, 6,
7.3). Import IF-D5/IF-D8 owns provider UI and ASCII meaning; IF-D4 owns later
identity-strict source updates. **B1/B2/B3.** All user access remains under
`file.import`; Code review is a stateful Import function tab/entity badge with
console/automation parity. Closing a waiting review keeps a Needs-input job;
Cancel follows IF-D7; BIM adds no second importer surface. **C1/C2/C3/C4.** All
decoded numbers/units are visible typed cells. Import selection is staged rows,
not viewport selection. Catalog revision/options/source hash are frozen.
Import/review/generation publishes atomically as one undo group with source
provenance. **D1/D2.** Prefix sampling never claims full counts; exact streaming
validation/resolution is bounded-memory and cancellable under IF-D8. A
three-row file is the least typical member and still gets review; a 100-million-
row coded file is the extreme and must show progress ≤250 ms, respond to cancel
≤500 ms, checkpoint only immutable staging, and publish nothing partial.
Quality may reduce preview points, never resolution correctness. **E1/E2/E3.**
Consumers are source entities, Code review, catalog, generation, layers,
display, tree/selection, update/undo, exporters, automation, and console.
Generated and fallback points publish in one visible generation. Code preflight
claims no viewport gesture; later completion uses BS-D20's reconciled map.
Tests in §6 cover leading zeros, mixed grammars, string/control separation,
unknown/incomplete fallback, cancel/crash, and exact catalog pinning.

#### Catalog row

| Owning Id                                         | BIM contribution                                                                                          | Surface                              | Perf | Automation                                                              | Resolution                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---- | ----------------------------------------------------------------------- | --------------------------------------------- |
| `file.import` (Import-owned; no duplicate BIM id) | code-column roles, catalog/version selection, `spec.resolve_code`, BS-D20 planner, persistent Code review | Import mapping/review + function tab | long | `spec.resolve_code`; generated result visible through canonical queries | workflow contract / source revision requested |

#### Decision record — BS-D21: Import parses; BIM resolves and generates

**Decision:** Import owns the file workflow and atomic batch. It calls the
selected catalog revision for code resolution and the one BIM generator.
Unresolved/non-generable observations publish as plain survey points plus a
persistent review list; no row is silently dropped and no guessed BIM object is
created. **Derivation:** D6; X1/X3; P1; `field-codes.md` §§2.1, 6, 7.3–7.4;
import IF-D5/IF-D7/IF-D8 and program README's single-owner rule. **Rejected:**
per-provider code tables; BIM parsing CSV; dropping unknown rows; committing
incomplete BIM placeholders; automatically reparsing after a catalog edit.
**Tunable:** preview sample and batch/job thresholds only (X6).

#### Disposition rows

| Import concern                                         | Disposition                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| XYZ/CSV code column (`import-formats.md` §3.1/IF-D8)   | cite-and-revise: add catalog id/revision, string/control and typed attribute mappings, preflight counts, Code review |
| Provider-neutral `columnMap` (IF-D5)                   | adopted; semantic roles extend the descriptor dialect, never a format-id branch                                      |
| Unknown Trimble code reporting (`field-codes.md` §2.1) | improve: retain plain point + persistent review instead of ignoring processed output                                 |
| IFC identity/update (IF-D4; BS-D13)                    | kept separate: code resolution never replaces valid IFC `GlobalId` identity or an explicit specification assignment  |

### D6.5 Sewer BIM objects and exchange

#### Workflow narrative

BIM › Sewer lists **Manhole (Schacht)** and **Pipe run (Haltung)** from the
active catalog. They are semantic BIM definitions, not symbols. A user can
generate a manhole through D6.3, then select two manholes and **Generate pipe
run**. The panel requires explicit upstream/downstream node order, invert
elevations or an explicit elevation rule, profile/size, material, drainage
system, and object identity. It previews flow direction and 3D centerline. A
missing node, invert, topology edge, size, or elevation semantics blocks with a
named reason. Completion creates linked node/edge objects atomically; undo
removes the run and its connection edits together.

The editable DEFAULT object rows are:

| Definition id / DEFAULT code                                              | Source geometry and role                                         | Typed type parameters                                                                  | Typed instance parameters, generation requirement, and derived values                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bim.manhole` / definition `0941`, type `0941100`                         | point; `manhole.center`                                          | profile/shape; nominal internal width/diameter; wall/base construction; material       | **generation-required:** authoritative plan center, measured cover point/elevation, depth **or** invert elevation with declared relation; **typed domain data:** object id, drainage system, function, connections, access/steps (individual exchange profiles may require more); **derived:** solid/volume |
| `bim.pipe-run` / definition `SEWER.HALTUNG`, type `SEWER.HALTUNG.DEFAULT` | directed line or upstream/downstream nodes; `pipeRun.centerline` | profile kind/library id; internal width/height or diameter; outside diameter; material | **generation-required:** upstream/downstream node refs, explicit order/direction, both invert elevations, valid profile size; **typed domain data:** object id, drainage system, optional cover rule; **derived:** 3D length/slope                                                                          |

The manhole code is the owner-provided DEFAULT example. The pipe codes are
plain, visibly editable Himmel:CAD convenience seeds because the dossier found
no sourced universal pipe type code; they are not claimed as German practice
(P7). ISYBAU `Objektbezeichnung` is stored separately as instance identity.
The parameter split follows the documented ISYBAU node/edge/profile fields
(`field-codes.md` §5.1 [I1, I2]) and never claims that a code+coordinate is
sufficient for exchange.

#### Contract answers

**A1/A2/A3.** ISYBAU grounds nodes/edges, manhole/pipe fields, topology and
profiles; DWA sources distinguish current M 145-3 from legacy M 150;
`easyBAU` is unidentified (`field-codes.md` §§5.1–5.3). Import/Formats owns
adapters; BIM owns objects. **B1/B2/B3.** BIM › Sewer, compatible node/line
menus, console, and automation all call BS-D20; the detachable generator panel
closes/cancels as D6.3. **C1/C2/C3/C4.** Dimensions, inverts, depth, slope, and
direction all have typed fields and preview twins. Pipe generation captures
exact node revisions; selection changes do not retarget. Topology/profile
evaluation is cached; one command/undo includes both endpoints' connection
updates. **D1/D2.** Single objects are bounded; a 100,000-edge network is the
extreme long job with streaming validation, progress/cancel bounds from D6.3,
atomic generation, and discard/restart after crash. The least typical member
is an isolated manhole with no pipes: valid as an object when its own required
fields exist, but not export-complete for profiles requiring topology. Preview
LOD may degrade; topology/coordinates never do. **E1/E2/E3.** Consumers include
layers/render/pick/snap, connection graph, properties/schedules, measurement,
plan capture, IFC and sewer exporters, automation, update/undo. P4 scopes
interactive picks; full explicit network export is not clipped by view. Tests
in §6 cover isolated node, large network, topology undo, and format-required
field reports.

#### Catalog rows

| Id / object definition               | Owner / access                              | Surface         | Perf         | Automation            | Resolution |
| ------------------------------------ | ------------------------------------------- | --------------- | ------------ | --------------------- | ---------- |
| `bim.sewer.objects` / `bim.manhole`  | BIM › Sewer; point menu; import review      | generator panel | bounded→long | `bim_object.generate` | workflow   |
| `bim.sewer.objects` / `bim.pipe-run` | BIM › Sewer; line/nodes menu; import review | generator panel | bounded→long | `bim_object.generate` | workflow   |

#### Decision record — BS-D22: sewer semantics and honest exchange claims

**Decision:** Manhole and pipe run are typed canonical BIM definitions with
explicit node/edge topology and the parameters above. Primary sewer exchange
target is ISYBAU XML-2024; DWA-M 145-3 is the current DWA interface to research
and disposition separately; DWA-M 150 is legacy only. `easyBAU` remains an
unidentified evidence gap and receives no compatibility claim or format row.
Import/Formats owns all adapter rows.
**Derivation:** D6 corrected through A2 silence; X1; P7;
`field-codes.md` §§4.3, 5.1–5.3, 6. **Rejected:** symbol-only sewer objects;
export from code+XYZ alone; calling M 150 current; treating `easyBAU` as a
product/format without vendor/schema evidence; inventing a mandatory pipe
code. **Tunable:** implementation tranche and network job threshold (X6), not
required format truth.

#### Disposition rows

| Format / claim                           | BIM disposition and Import/Formats request                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ISYBAU-Austauschformat Abwasser XML-2024 | adopt as primary current sewer import/export contract after canonical objects; validate published XSD version, preserve unknown fields, report missing topology/metadata |
| DWA-M 145-3 (December 2025)              | adopt for current-interface research/contract row; exact exchange syntax/profile remains unclaimed until primary material and fixtures are admitted                      |
| DWA-M 150                                | legacy adapter row only, clearly labeled withdrawn/replaced; do not use as current compatibility headline                                                                |
| `easyBAU` / `EasyBAU XML`                | unidentified evidence gap; no compatibility claim and no format row until vendor, schema, and fixtures identify it                                                       |
| IFC                                      | BS-D13 owns classification/type mapping; synthetic IFC export must map semantic sewer objects honestly or report unsupported, never emit only their display blocks       |

## 3. Function contract (A1–E3)

**A1 — User outcome.** §2 covers the original workflow-level functions; the
dated D6 heading adds complete workflows for catalog/table exchange,
shortcuts, role generation, coded field import, and sewer objects.

**A2 — Reference behavior.** Revit is the named reference for this
domain. Adopted: family/type/instance economics and value tables
(revit.md §1 [S1, S2, S9, S10]), dimension-bound parameters and formula
semantics (§2.1–§2.3), the multi-select contract — common-parameter
intersection, varies-placeholder, category filter, whole-selection type
selector (§3 W3 [S28, S29]) — object-styles-by-specification (§2.5), and
the schedule model for the deferred function (§2.8 [S25–S27]).
Deliberately different, each on the dossier's own evidence: one placement
concept instead of three repetition mechanisms (§2.4 lesson); no fixed
categories, shared-parameter GUID files, in-place families, or separate
family-editor mode (the §5 do-not-adopt list); automatic flexing
replacing the manual loop (§2.1/§4); visible blast radius (§5). RIB Civil
contributes the second leg: integer-code specification tables driving
point/line/area/text styling (`*.spz`, F9 Spezifikation box —
rib-civil.md §2.3) and extensible object-meaning catalogs
(Fachbedeutungen — rib-civil.md §2.7). The current numeric-only validator is an
implementation delta, not the desired model. D6 is grounded in
`field-codes.md` §§1–7: Trimble libraries, STRATIS `*.SPZ`/F9, card_1, German
catalog structures, role-conversion precedents, and sewer exchange are
dispositioned row-for-row under the dated heading. No claim that field coding
itself creates complete BIM is made; dossier §6 expressly limits the evidence.
Section 3a gives every revit.md catalog row a disposition and D6 gives the
field-codes dispositions.

**A3 — Sibling functions.** Viewing-box panel conventions bind field
behavior (Enter/blur commit, Escape revert, units/precision —
`specs/view/viewing-box.md` §1.2); the block machinery is the instancing
sibling (BS-D6); layers and `style_ref` are the styling siblings (§1.5
resolution order keeps them meaningful); the plan composer consumes
resolved presentation (D4); the Draw domain consumes the catalog (§2.2).
The properties panel improvements (typed placement editing, sectioning) apply
to every entity kind, not only spec-bearing ones. Import/Formats IF-D5/IF-D8
owns coded CSV parsing and UI; Measure/Inspect owns persistent measurements,
not generator completion picks; Select/Edit SE-D3 owns placement-only
transforms of generated objects. D6 records the exact handoffs.

**B1 — Reachability.** Specification editor: BIM ribbon toggle, console,
automation (`spec.*` — full CRUD for definitions, types, symbol,
classification, library; X3 parity so an agent can author a complete
specification; the symbol payload for `spec.symbol.set` is a JSON body
`{space, members: [{primitive, slots}], bindings: [{slotId,
parameterId}]}` so the parity test in §6 is writable). New specification
from selection: entity context menu + `spec.create_from_selection`.
Apply/unapply: ribbon (acts on selection), entity context menu, the
picker's "No specification" entry, the panel's clear affordance, console,
`spec.apply`/`spec.unapply`. Properties: the right strip's default tab
(ui-platform model); its query/edit contract is already on the automation
protocol (`canonicalProtocol.ts:128–151`) — this domain extends the
schemas, not the wire paths. Place object: ribbon, quick-surface "Place
object here" (over geometry; hidden over void where no placement point
resolves), console, `bim_object.place` — with the Draw-tab tool entries
as additional access paths (BS-D16). No quick-surface entries for editor,
apply, or library (they act on catalogs or selections, not viewport
locations — absence recorded). D6 reachability is binding: the shortcuts panel
has ribbon/tab/entity-pin/console/automation paths, F9 focuses it, and
number-slot shortcuts are absent; role generation has BIM ribbon, compatible
entity-menu, import-review, console, and automation paths. `file.import`
remains Import-owned (BS-D21).

**B2 — Open/close symmetry.** The ribbon button strictly toggles the
editor window; the window has a close affordance; Escape ladder: focused
field → revert, canvas tool/drag → cancel per Draw conventions, otherwise
→ close window. Closing keeps all committed data and discards uncommitted
field text. The apply picker closes only on commit, Escape, its close
affordance, or activation of another function surface — viewport clicks
pass through as selection (§2.2). Properties, as the default tab, closes
only _to_ another tab and auto-restores when none is active — reachable
from everywhere, closeable to nowhere (ui-platform tab model); its fields
obey field-level Escape.
The shortcuts and generation tabs follow UIP-D8/UIP-D14: tab/island x and
ribbon re-toggle agree; closing shortcuts keeps pins/current state; closing
generation discards only its view-local uncommitted plan.

**B3 — Surface choice.** Specification editor: **dedicated resizable
window** — it owns a symbol canvas, a parameter table, a value table, an
error list, and a preview; the contract names exactly this profile for a
window, and the narrative in §2.1 would overflow any island (the current
475-line island already cannot host editors for more than two of eleven
kinds). Live-project preview keeps it from becoming Revit's separate
family-editor mode (revit.md §5). Apply: picker popover (single decision,
viewport stays primary). Properties: right panel (continuous viewport
interaction while editing). Place object: viewport tool + gallery. (BS-D7)
Shortcuts and role completion use detachable right function-panel tabs because
their narratives require continued viewport interaction; catalog authoring
remains inside the dedicated editor window (D6.1–D6.3).

**C1 — Numeric parity.** Every symbol-canvas manipulation binds to a named
parameter with a typed field (dimension-first authoring, §2.1); spacing and
fill parameters are typed in panel and picker; the properties panel gains
typed placement editing (today `optionalTransform3d` is excluded from
editing, `App.tsx:1001–1003` — a C1 defect this spec closes). Units and
precision follow project settings everywhere; drag and type stay
live-synchronized in the symbol preview.
Code segment decoders, sewer dimensions/inverts, and generator parameters are
typed; every completion handle or direction arrow has the field/enum twin
named under D6.

**C2 — Selection semantics.** Apply and retype act on the selection at
commit time with a live target count; mixed-kind selections apply to the
applicable subset with per-definition counts and console-named skips
(§2.2). The properties panel follows the live selection; the kind filter
narrows the edited subset; commits go to exactly the filtered, queried
revisions. The editor operates on the catalog, independent of selection;
its preview selection is editor-local. Extreme class members (contract
rule): the _largest_ — a selection containing a point-cloud entity —
shows envelope rows and the pointCloud presentation section; apply offers
only pointCloud-applicable definitions and counts the cloud in "N of M".
The _least typical_ — a D5 reference (xref) entity — is read-only by its
own decision: the panel renders values without editors and apply skips it
with the console naming why; it never silently succeeds. Selection acts
on the visible set per precedent P4: entities hidden or clipped away are
not in the selection and therefore not in any apply/retype target count.
Role generation captures one visible source and its revision at launch;
selection changes do not retarget it. Code import operates on staged rows, not
viewport selection, and is scoped by the accepted import set rather than P4;
subsequent interactive completion picks do obey P4.

**C3 — Freezability.** Evaluated symbols are content-addressed baked block
definitions (§1.4): identical (definition revision × values) share one
cached tessellation, so a placed forest costs one symbol bake plus
transforms — X2 spent at evaluation time, never during navigation. An
explicit "approved/locked" flag on library definitions (office standards
protection) is queued (BS-D15); the cache needs no user-facing lock because
content addressing already keys invalidation exactly.

**C4 — Persistence and undo.** Definitions, types, assignments, parameter
values, attribute values, and presentation overrides are canonical and
journaled (BS-D1/BS-D5); each field commit, table-row commit, apply,
retype, and library import is one undo step. Undo in the editor window is
**global-journal undo** — Ctrl+Z reverts the last canonical step wherever
it happened and the console names it; a window-scoped undo stack is
rejected (two histories over one journal cannot both be truthful; X1). Derived fill occurrences and
baked tessellations are derived data — rebuilt, never journaled. D6.1 replaces
the old JSON-only library idea with full CSV/XML table exchange. Catalog
revisions, pins, generator provenance, code-review records, and sewer objects
travel inside `.hcadx`. Pin/model changes undo; current specification is
persisted but non-undoable like current layer (DR-D10). Each generation is one
undo step; an Import batch is one parent undo group (BS-D18–BS-D22).

**D1 — Performance budget.** Continuous, two distinct gates: (a) viewport
interaction over spec-styled scenes — the spec-render benchmark (orbit
over a calibrated scene with ≥ 10 000 symbol occurrences incl. one live
fill, p95 frame interval ≤ 2× target frame time, agent-runnable,
mirroring the viewing-box gate convention VB-D7); (b) editor preview
flexing — the editor-preview benchmark drives scripted type-switch and
parameter-typing bursts in the _open editor_ and asserts p95 preview
update latency ≤ one frame budget; its state samples also assert §7
criterion 3 (the orbit benchmark measures the wrong surface for this —
review finding 8). Bounded (< 1 s, busy state where perceptible):
apply/retype up to 10⁴ entities, definition commit incl. the §1.2a flex
set within the evaluation budget, property query/edit on large selections
— gate: scripted 10⁴-entity apply and multi-edit benchmark. Long-running
(progress + cancel): catalog-table import, over-budget flex sets, regeneration
cascades touching > 10⁴ instances — each registers with the platform job
registry (ui-platform UIP-D10: chip → jobs island → toasts → console);
cancellation publishes nothing partial. All thresholds tunable (X6).
D6 adds exact extreme classes and bounds: 100,000 catalog/pin/room members and
a 100-million-row coded import stream, with first progress ≤250 ms and cancel
acknowledgement ≤500 ms; a 100,000-edge sewer network follows the same atomic
job contract. Multi-minute generation discards derived staging and restarts
after crash; committed source/catalog state remains.

**D2 — Degradation.** During interaction the quality governor may thin
area-fill occurrence rendering (draw fewer, farthest first) and drop symbol
detail to the coarse presentation; on commit the full set renders. Never
degraded: parameter evaluation correctness, assignment atomicity, input
responsiveness, journal integrity. Weak hardware never changes what a
specification _means_ — only how densely its derived occurrences draw
during motion.

**E1 — Visual quality.** §7 (in-repo criteria). Implementation review
compares actual screenshots of the editor, picker, styled viewport, and
properties panel against §7 in both themes. Design tokens only; the editor
window uses the shared window/island chrome, no one-off styling.

**E2 — Conflicts, failure, and consumers.** Consumers of specification
state and the effect on each:

| Consumer                            | Effect                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render passes                       | resolve presentation per §1.5; draw baked symbol blocks and derived fills; re-render on definition/type/instance commit                                                                                           |
| Picking/snapping/selection          | symbol and fill occurrences hit-test to their **host** entity; snapping sees evaluated geometry; a hidden or clipped-away host removes its occurrences from picking/snapping/selection (precedent P4)             |
| Entity tree                         | draw folders group spec-created entities; assignment shows as a property, not a tree move                                                                                                                         |
| Properties panel & automation       | specification namespaces appear in `propertySchemas`; unknown namespaces stay opaquely preserved (existing `UnknownProperty` path)                                                                                |
| Plan composer (D4)                  | consumes resolved presentation; no separate plan styling fork                                                                                                                                                     |
| Exporters                           | DXF writes baked symbols as blocks (block path exists in `dxf_provider.rs`); IFC export is passthrough-only today — spec-to-IFC writing is explicitly out of scope until a synthetic IFC writer exists (delta §5) |
| IFC import                          | already writes `hcad.component.bim-classification@1` + `hcad.ifc-import@1` attributes; mapping (BS-D13) turns these into readable spec/classification data instead of opaque blobs                                |
| Schedules (future)                  | read attributes + exported parameters; dependency ordering per BS-D14                                                                                                                                             |
| Draw current specification / layers | one current type; Draw captures it and target layer at tool start, applies BS-D12 style and DR-D4 exactly-one-layer membership atomically                                                                         |
| Code import / review                | Import owns parsing and atomic batch; BIM resolves the exact catalog revision; unresolved observations remain plain points with diagnostics                                                                       |
| Generated-object sources            | source ids/revisions and role provenance remain; source edits mark stale, never silently overwrite; SE-D3 transforms object placement only                                                                        |
| Sewer topology / exchange           | manhole nodes and pipe-run edges expose typed topology/parameters; exporters report missing required format data rather than emit a styled proxy                                                                  |

Failure and concurrency: all commits are CAS-guarded canonical
transactions — concurrent edits serialize through the journal, stale
revisions fail with `VersionConflict` and a clean re-query (§2.3). A
definition whose evaluation fails for some type marks those types invalid
in the error list; placed instances keep last-good geometry and the console
names the definition (BS-D8). Type/definition deletion with live
references is blocked with the count and a retype offer (§2.2). Parameter
lifecycle (BS-D9): deleting a parameter that live values reference is
blocked with the count and offers an explicit journaled "delete parameter
and its N values"; rename touches only the display name (stable ids);
retype maps instance values by parameter id and reports dropped ones with
a console count — no silent data loss anywhere in the chain (X1). The
editor subscribes to canonical change events: an external commit to a
definition it displays re-queries and refreshes tables and preview while
preserving uncommitted field text — no stale-view editing over dead
revisions. Canvas gesture claims while a canvas tool is armed (contract
input-arbitration rule): LMB draw/pick, RMB context/cancel, wheel canvas
zoom, Up/Down snap-candidate cycling, Tab input traversal, Escape ladder rung, typing → input bar
— all identical to the Draw toolset's claims and scoped strictly to the
canvas surface inside the editor window; the main viewport keeps the
platform gesture map untouched, so no shared-slot conflict exists.
Crash: canonical records replay from the journal; baked tessellations and
fill occurrences are derived data, rebuilt on demand.

**E3 — Verification plan.** §6. Unverified claims listed there.

### 3a. Reference catalog disposition (per-dossier-row rule)

Every revit.md §2 catalog row, dispositioned:

| Dossier row                                                                                                          | Disposition                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1 Family Editor (reference planes, labeled dimensions, Family Types dialog, flexing, visibility per detail level) | adopted as the editor window with bindable slots replacing plane/lock skeletons (§1.4); flexing automated (BS-D8); per-detail-level visibility deferred to BS-D15 with the coarse/fine governor note (D2)        |
| §2.2 Built-in/system parameters                                                                                      | adopted as the existing `hcad.entity@1` envelope schema                                                                                                                                                          |
| §2.2 Family parameters                                                                                               | adopted as geometry-driving parameters (§1.2)                                                                                                                                                                    |
| §2.2 Project parameters                                                                                              | rejected as a distinct kind — attributes cover the role without the category attachment (BS-D3)                                                                                                                  |
| §2.2 Shared parameters (GUID files)                                                                                  | rejected — single canonical store (BS-D3)                                                                                                                                                                        |
| §2.2 Global parameters                                                                                               | deferred — project-level named values, queued BS-D15                                                                                                                                                             |
| §2.3 Formulas and constraints                                                                                        | adopted, directional, cycle-rejected; counts ≥ 0 (§1.2)                                                                                                                                                          |
| §2.4 Detail components                                                                                               | adopted as point-symbol mode (BS-D4)                                                                                                                                                                             |
| §2.4 Repeating details                                                                                               | adopted as along-curve mode (BS-D4)                                                                                                                                                                              |
| §2.4 Line-based arrays with formulas                                                                                 | adopted as along-curve/area spacing parameters (BS-D4)                                                                                                                                                           |
| §2.4 Fill patterns (drafting/model)                                                                                  | adopted — hatch primitives exist (`types.ts:59–71`), model-pattern snappability deferred with the plan-composer analog (BS-D15)                                                                                  |
| §2.5 Object styles / subcategories                                                                                   | adopted as definition-level presentation with §1.5 resolution; subcategories deferred until a symbol needs per-member styling beyond member style overrides (BS-D6 substrate already carries `BlockMemberStyle`) |
| §2.6 View filters                                                                                                    | deferred to the plan-composer domain (BS-D15; revit.md §5 assigns them there)                                                                                                                                    |
| §2.6 View templates                                                                                                  | deferred, same target                                                                                                                                                                                            |
| §2.7 Materials (identity/graphics/appearance split)                                                                  | adopted at primitive level (`SpecMaterial` → `MaterialResource`); appearance/PBR split deferred to the render domain                                                                                             |
| §2.8 Schedules                                                                                                       | contract level, deferred with reason (BS-D14)                                                                                                                                                                    |
| §1 Nested families / shared nesting                                                                                  | deferred — nested symbols queued with parent→nested-only driving (BS-D15)                                                                                                                                        |
| §1 Type catalogs                                                                                                     | adopted as CSV value-table import (§2.1)                                                                                                                                                                         |
| §1 In-place families                                                                                                 | rejected — ordinary modeling covers it (revit.md §5)                                                                                                                                                             |

## 4. Decision records

**BS-D1 — Specifications and versioned catalogs are canonical project entities.**
**Decision:** definitions, types, assignments, and the project library are
canonical journaled entities; the localStorage library (`library.ts:6`)
is retired via a per-project migration prompt on first open (import /
skip, never silent). The legacy JSON is migration input only; BS-D18's
versioned CSV/XML catalog tables are the exchange formats. Import shows a
collision preview per code — keep / replace / rename — before anything commits,
extended to code grammar, aliases, and affected instances. Every definition
commits with an explicitly coded,
designated **Default** type row so apply never dead-ends on an empty value table.
**Derivation:** X3/P1 (deliberately created, restorable, automation-visible
state); the current store is invisible to automation, absent from
`.hcadx`, and silently replaced when corrupt (`library.ts:22–32`) — three
P1/X1 violations.
**Rejected:** keeping an app-local library with a sync bridge (two stores,
the exact forked-persistence P1 forbids). **Tunable:** no.

**BS-D2 — Definition → type → instance; no fixed category or code grammar.**
**Decision:** three levels per §1.1; kind-applicability + code hierarchy
replace categories; the current flat `Specification` record becomes the
type-plus-presentation fragment of a definition. “Code hierarchy” means only
the hierarchy declared by the selected catalog under BS-D18/P7; it is not a
product integer layout.
**Derivation:** D3; revit.md §1 [S1, S2] and §5 (current record "corresponds
to a Revit type plus fragments of object styles"; the recommended split is
exactly this); the fixed-category rigidity is sourced at §1 [S1, S2]
("users cannot add categories") — the §4 "rigid category system" pain
item is dossier-flagged **[from memory]** and is cited only as
corroboration, per the dossier's own re-check rule; rib-civil.md §2.3
(code tables as the domain tradition). **Rejected:** style-only flat
records (rejected by D3 itself); adopting fixed categories
(do-not-adopt, revit.md §5). **Tunable:** no — data-model direction
confirmed by D3.

**BS-D3 — Two parameter classes in one identity space.**
**Decision:** geometry-driving parameters (type- or instance-bound) vs.
attributes per §1.2; no external identity files; typed values with units;
directional formulas, cycle-rejected, counts ≥ 0 allowed.
**Derivation:** D3's separation mandate; revit.md §2.2 structural insight

- do-not-adopt (GUID files); §2.3 [S6, S15]. **Rejected:** one
  undifferentiated parameter bag (loses the D3 separation and makes
  reporting scrape generator internals); five Revit-style parameter kinds
  (concept sprawl, revit.md §4). **Tunable:** value-type list may grow.

**BS-D4 — One placement concept with three modes.**
**Decision:** point / along-curve / area fill, declared per definition
(§1.3). **Derivation:** D3 (owner named point symbols and spacing fills);
revit.md §2.4 lesson and §5 (three mechanisms with three portability
behaviors is the reference's documented pain). **Rejected:** separate
repeating-detail-style system types (portability split, [S12]).
**Tunable:** future modes (e.g. grid) may be added.

**BS-D5 — Repetition occurrences are derived, not canonical.**
**Decision:** along-curve/area-fill occurrences are derived data of the
host entity; the canonical record is host + assignment + parameters.
**Derivation:** X2 (spend evaluation, keep interaction fast); C4 split —
users undo parameter edits, not 4 000 generated trees; X3 exception clause
(derived data is the justified non-canonical case).
**Rejected:** materializing occurrences as entities (journal spam, delete
anomalies, selection noise). **Tunable:** an explicit "convert fill to
entities" command is queued (BS-D15) for when users need individual trees.

**BS-D6 — Symbols compile onto the block-definition substrate.**
**Decision:** evaluated symbols bake to `hcad.resource.block-definition@2`
content-addressed per (definition revision × evaluated values).
**Derivation:** the machinery exists complete and unused by any UI
(`canonical_resources.rs:165–211`; DXF producer only); X2 caching; A3
sibling reuse over parallel machinery. **Rejected:** a new symbol-instance
geometry kind (duplicates blocks; two instancing paths to keep correct).
**Tunable:** bake granularity (per-type vs per-instance-values) is an
implementation calibration.

**BS-D7 — Authoring in a dedicated window; consuming in light surfaces.**
**Decision:** specification editor = dedicated resizable window with
catalog tree, parameter/value tables, symbol canvas, error list, live
preview; apply = popover picker; properties = permanent panel.
**Derivation:** contract B3 names this exact profile for a window; the
current island demonstrably outgrew (two of eleven kind editors fit,
`SpecsIsland.tsx:345–475`); revit.md §5 rejects a separate _application
mode_, satisfied because the project stays live behind the window — no
load-back roundtrip (§3 W1 step 7 is deleted, not relocated).
**Rejected:** growing the island (B3 violation by its own narrative);
separate editor mode (reference pain, revit.md §4). **Tunable:** no.

**BS-D8 — Automatic flexing with last-good fallback** (revised per
spec-review finding 4). **Decision:** every definition commit evaluates
the §1.2a flex set — {type rows} × {instance-bound parameters at default,
plus declared min/max} over the optional per-parameter domains of §1.2;
undeclared domains contribute only defaults. Failures go to the editor
error list, failing types are marked invalid, placed instances keep
last-good geometry, console names the failure; commit never blocks on
flex completion, and over-budget sets run as a registered background job.
**Derivation:** revit.md §2.1 (flexing is a hand-run loop, [S4, S5]); X1
(never render wrong geometry silently); DESIGN-SYSTEM error rules; X6 for
the budget. The earlier phrasing evaluated "min/max bounds" the parameter
model never declared — fixed by making domains a declared, optional part
of §1.2. **Rejected:** blocking commit on any failure (loses work
mid-authoring); silent acceptance (X1); mandatory domains (busywork for
parameters that never flex). **Tunable:** evaluation budget (X6).

**BS-D9 — Blast radius and parameter lifecycle** (extended per
spec-review finding 5). **Decision:** type-row _and definition-level_
commits that regenerate placed geometry show "affects N placed instances"
before committing; the panel's type selector labels its commit "Retype N
entities". Parameters have stable ids — rename changes only the display
name, values stay keyed by id. Deleting a parameter with live values is
blocked with the count and offers the explicit journaled "delete
parameter and its N values". Retype maps instance values by parameter id
and drops non-matching values with a console count. **Derivation:**
DESIGN-SYSTEM "Confirmation copy names the actual consequence"; X1 (each
of parameter-delete, rename-identity, and retype-mapping is otherwise a
silent data-loss hole); revit.md §5's improve-on-reference
recommendation — the underlying "silent type-edit blast radius" dossier
claim is flagged **[from memory]** there and serves as corroboration
only. **Rejected:** confirmation dialogs (undo exists; the count informs,
it does not gatekeep — sibling precedent: viewing-box removal, VB spec
§1.7); rename-as-delete+create (orphans values by construction).
**Tunable:** no.

**BS-D10 — Specification data rides the existing property wire contract.**
**Decision:** each definition contributes a generated property namespace
schema (parameters + attributes, typed, with editability); the panel and
automation read/edit spec data through the same
`queryProperties`/`compilePropertyEdit` path as envelope fields;
`PropertyValueType` grows number/boolean/enum/unit-bearing variants.
**Derivation:** the contract was built for this — namespaced schemas,
opaque preservation of unknown namespaces, atomic multi-entity compile
(`property_schema.rs:1–5, 236–246, 394–435`); E2 (one path means every
consumer inherits multiselect semantics); X3 (automation parity for free).
**Rejected:** a parallel spec-edit API (two aggregation/mixed
implementations to keep consistent). **Tunable:** no.

**BS-D11 — Multi-select contract.**
**Decision:** common-parameter intersection; "Mixed values" placeholder
committing to all; header with count; kind filter drop-down; type selector
re-types the filtered selection; type-level vs instance-level values in
visually distinct sections, no modal type editor. Assignment applies
uniformly and atomically to the exact queried revisions. Mixed-kind apply
uses the union filter with per-definition applicable counts and
console-named skips (§2.2, spec-review finding 7).
**Derivation:** revit.md §3 W3 [S28, S29] (adopted contract) + §5
improvements; existing core semantics already implement
Shared/Mixed/atomic-uniform (`property_schema.rs:333–435`).
**Rejected:** per-entity divergent edits in one commit (no reference
precedent, murky undo semantics). **Tunable:** filter granularity
(kind vs definition) may be refined.

**BS-D12 — Presentation resolution order and resource unification.**
**Decision:** instance override → type → definition → `style_ref` →
layer/default (§1.5); presentation primitives live in canonical resources.
**Derivation:** revit.md §2.5 [S16] (category styles below view overrides
— same shape); the canonical resource vocabulary already exists
(`canonical_resources.rs:30–46`) and duplicating it in a package-local
store is the current defect. **Rejected:** spec styling replacing
`style_ref` (breaks non-spec workflows and IFC-imported styling later);
view-level override tiers now (that is the filters/templates analog,
queued to the plan-composer domain, revit.md §5). **Tunable:** no.

**BS-D13 — IFC classification mapping at contract level.**
**Decision:** definitions may declare an IFC mapping (system, code in
STEP spelling, predefined type) reusing
`hcad.component.bim-classification@1`; import offers "derive
specifications from IFC classes" — one definition per encountered class,
property sets landing as attributes; the classification component becomes
readable in the panel. Full depth (round-trip fidelity, predefined-type
capture, type-object linkage — all currently dropped, §5) is specified
with the IFC/import domain, which owns the importer. On changed-source update,
Import IF-D4 owns identity and merge: a valid IFC `GlobalId` preserves the
canonical entity id; classification/property fields use its three-way merge;
an explicit specification assignment remains; and a newly derived
classification-to-specification mapping is a reviewed proposal, never a silent
replacement. Code-driven field import under BS-D21 never substitutes for IFC
identity.
**Derivation:** X4 (the importer already writes classifications,
`ifc_provider.rs:1645–1657`); Import IF-D4 and its passive-consumer matrix;
program README cross-domain boundary; the
exporter is passthrough-only today, so promising round-trip now would
violate A2's evidence-precedes-specification rule. **Rejected:**
specifying IFC export mapping here (no writer exists to bind it to).
**Tunable:** no.

**BS-D14 — Schedules deferred to contract level, with reason.**
**Decision:** `bim.schedule` enters the registry now (model per revit.md
§2.8: category/kind + fields incl. calculated values + ANDed filters +
sort/group with collapse-to-count [S25–S27]; quantity outputs oriented at
RIB REB conventions, rib-civil.md quantities section), but workflow depth
is deferred until (a) attributes and spec assignment exist in the store
and (b) sheet placement lands in the plan composer (owner decision D4).
Plan-editor PE-D10 now owns that placement through `plan.schedule.place`; BIM
retains schedule definition/data semantics and hands the typed table artifact
to Plan for pagination and sheet output.
**Derivation:** dependency order — a schedule of properties that cannot
yet be attached to entities is unspecifiable against E3;
`docs/CURRENT-DIRECTION.md` completion discipline (no speculative depth).
**Rejected:** full schedule spec now (would repeat the pilot's
spec-before-evidence failure, spec-review 2026-09-01 finding class).
**Tunable:** no.

**BS-D15 — Queued follow-ons** (one backlog): project-level named values
referencable by spec parameters (global-parameter analog, revit.md §2.2
[S8]); nested symbols with parent→nested-only driving (revit.md §1
[S11]); approved/locked library flag; convert-fill-to-entities
(occurrence conversion stays queued even with BS-D17 in core);
per-placement-mode 3D stand-ins beyond the §1.4 in-plane rule;
per-detail-level symbol visibility; office library sharing beyond file
exchange. **Derivation:** each is additive to §1; bundling delays the
core (sibling precedent VB-D11). **Tunable:** no.

View filters/templates are no longer in this backlog: Plan-editor PE-D6 owns
their rule model, include/exclude fields, assignment, locking, and viewport
application. BIM supplies specification/property fields to those rules without
owning a second template surface.

**BS-D16 — One placement model, reconciled with Draw** (new per
spec-review finding 1). **Decision:** a placed symbol/fill is a canonical
entity of the definition's applicable kind carrying the specification
component; along-curve/area occurrences are derived (BS-D5); `hcad.block@2`
serves as render substrate only (BS-D6). One canonical command
`bim_object.place`; Draw-tab symbol/fill tool entries are access paths
resolving to it. draw.md DR-D7's "instances are canonical block/fill
entities" wording is amended by the Draw author; this spec records the
agreed model. **Derivation:** the review's adjudication (this model has
the stronger derivation chain: D3 separation, C4 undo semantics, X2
derived-data economics); DESIGN-SYSTEM "Ribbon, context-menu, console,
Python, and AI access must resolve to the same underlying command".
**Rejected:** canonical block instances per placement (spams the journal
and the entity tree with occurrence rows; retype and spacing edits stop
being single steps); two commands for one act (the registry-defect class
the review's system feedback names). **Tunable:** no.

**BS-D17 — New specification from selection is core** (promoted per
spec-review finding 17 and coordinator direction). **Decision:**
`spec.create_from_selection` seeds a new definition from the selected
entities — symbol members via the existing block-from-selection substrate
(`BlockMemberSource::EntityReference`, `canonical_resources.rs:171–183`),
presentations from the entities' styles; sources are untouched; the
editor opens on the result for slot binding (§2.1). **Derivation:** the
substrate exists and is producer-less today (code-claim rule: DXF import
is its only writer); the draw-then-formalize workflow is how survey
symbol catalogs actually grow — authoring-from-scratch-only reproduces
Revit's content-bottleneck pain (revit.md §4 [S30, S31]). **Rejected:**
leaving it queued (cheap, high-leverage, and the reviewer's parity case);
converting sources into the symbol (destroys user geometry). **Tunable:**
no.

## 5. Current implementation delta

**Exists and stays:** the `@himmelcad/specs` per-kind presentation types and
material/linetype/hatch/texture primitives (`types.ts:46–214`) are carried over
as vocabulary. Its fixed numeric `SpecCode` (`types.ts:15–16`) and numeric sort/
lookup (`library.ts:53–55,71–72`) are explicitly superseded by BS-D18. The
property wire contract end to end:
Shared/Mixed/Unavailable aggregation, atomic CAS-guarded multi-entity
compile, opaque preservation of unknown namespaces (`property_schema.rs`),
protocol and client (`canonicalProtocol.ts:128–151`,
`clients.ts:562–592`), renderer two-step compile+execute
(`project.ts:201–213`), and the panel's count header + Mixed placeholder +
"Apply to all" (`App.tsx:957–1105`). Block machinery
(`canonical_resources.rs:165–211`, `BlockInstanceGeometry`), canonical
style resources, IFC import's classification component and attribute
capture (`ifc_provider.rs:1645–1684`).

**Changes:** specification store moves localStorage → canonical entities
with one-time import (BS-D1); the flat `Specification` record splits into
definition/type (BS-D2); SpecsIsland is replaced by the editor window —
today it edits only a type-level record, has working field editors for
only curve and area, silently mis-stores seven kinds via an `as never`
cast (`SpecsIsland.tsx:157–162`), never surfaces `attributes`, and cannot
import what it exports; ribbon entry moves from Output › `output.specs`
(`ribbon.ts:150`) to the BIM tab (D2); presentation primitives merge into
canonical resources (BS-D12); `PropertyValueType` grows numeric/boolean/
enum/unit variants and the panel gains sections, kind filter, type
selector, typed placement editing, and field-level Escape revert (none
exist today, `App.tsx:998–1105`). `Specification.code` becomes an exact string,
definition and type rows both require it, and the canonical catalog adds
versioned grammar/role/parameter schemas (BS-D18).

**New:** parameter schemas with stable ids, domains, formulas, and
auto-flex; symbol authoring canvas (Draw toolset + bindable slots) and
bake pipeline onto blocks; create-from-selection (BS-D17); placement
modes incl. derived fills; `spec.*` / `bim_object.*` command families and
journaled assignment (today **zero** linkage exists: no spec property, no
draw tools, no create-with-spec command — the specs package is imported
by exactly one component); apply picker incl. unapply entry and
mixed-kind counts; place-object gallery/tool; per-definition property
namespaces on the wire; classification mapping surface; migration prompt
and collision-preview library import; UIP-D10 job registration for
long-running spec work; spec-render, editor-preview, and apply/multi-edit
benchmarks.
Also new under D6: editable DEFAULT data; CSV/XML full-table round-trip;
catalog revision/alias/collision commands; persistent shortcuts and one current
specification; role/generation plans with named blockers and source provenance;
manhole/pipe-run canonical definitions and topology; code-resolution/review
integration for Import. No current role/generator/source-provenance fields exist
in the flat `Specification` shape (`types.ts:184–214`), and no canonical
manhole/pipe-run kind exists (`entity_model.rs:20–159`).

**Known gaps recorded for sibling domains:** IFC importer never reads
`IFCRELDEFINESBYTYPE` or `PredefinedType` and flattens mapped-item
instancing; property sets stay untyped blobs under `hcad.ifc-import@1`;
IFC export refuses non-passthrough (`ifc_provider.rs:331`). These bound
what BS-D13 may promise and belong to the IFC/import domain spec.

### Disposition — spec review (2026-09-01, findings 1–17)

| #   | Finding                                                                  | Disposition                                                                                                            |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Draw/BIM contradict on what a placed symbol is; duplicate commands       | BS-D16; §1.3 reconciliation; §2.2; registry row; Draw DR-D7 now carries the reciprocal access-path/entity-owner split  |
| 2   | Picker outside-click close vs live count                                 | §2.2, B2: gestures pass through; closes on commit/Escape/affordance/other function only                                |
| 3   | Symbol canvas under-specified                                            | §1.4 (Draw toolset, bindable slots, constants, DR-D9 boundary sentence); §2.1; E2 gesture claims                       |
| 4   | Auto-flex evaluates undeclared bounds; instance params had no flex value | §1.2 domains; §1.2a flex set + budget; BS-D8 revised                                                                   |
| 5   | Definition-level blast radius; parameter delete/rename/retype data loss  | BS-D9 extended (stable ids, blocked delete with journaled override, id-mapped retype); §2.1, E2                        |
| 6   | `spec.unapply` automation-only                                           | §2.2 "No specification" entry; §2.3 clear affordance; B1 (X5)                                                          |
| 7   | Mixed-kind apply unspecified                                             | §2.2 union filter, "40 of 41", console skips; C2; BS-D11                                                               |
| 8   | Editor preview flexing had no runnable gate                              | D1 editor-preview benchmark (type-switch + typing bursts, p95 ≤ frame budget); §6; §7 criterion 3 rewired              |
| 9   | "Never closes" contradicts ui-platform tab model                         | Adopted ui-platform default-tab model: registry row, §2.3, B1, B2                                                      |
| 10  | A2 hygiene: Fachbedeutungen §2.7; [from memory] flags in BS-D2/BS-D9     | A2 fixed; BS-D2/BS-D9 derivations carry the flag + sourced primary                                                     |
| 11  | Symbol space and 3D behavior unspecified                                 | §1.4 world/screen per `TextSpace` precedent; in-plane 2D/2.5D, placement plane 3D; stand-ins → BS-D15                  |
| 12  | Quick-surface rows missing; symbol payload unsketched                    | B1: "Place object here" + recorded absences; `spec.symbol.set` payload shape                                           |
| 13  | Long-running ops must register with UIP-D10                              | D1: library import, over-budget flex, >10⁴ regeneration register with the job registry                                 |
| 14  | Editor stale-view on external commits                                    | E2: change-event subscription, re-query, uncommitted text preserved                                                    |
| 15  | Migration/collision/empty-type-table gaps                                | BS-D1/BS-D18 revised: per-project prompt, keep/replace/rename preview, explicitly coded designated Default type (§2.1) |
| 16  | Editor undo semantics unstated                                           | C4 + §2.1: global-journal undo, console names step, window-scoped stack rejected                                       |
| 17  | Promote create-from-selection; occurrence conversion queued              | BS-D17 in core (§2.1, B1, registry row); conversion stays in BS-D15                                                    |

## 6. Verification plan (per `docs/TEST-TIERS.md`)

- **changed:** core unit tests — definition/type/instance model CRUD and
  journal round-trip; parameter evaluation (units, domains, formulas,
  cycle rejection, count 0/1 arrays); §1.2a flex-set composition
  (undeclared domains contribute defaults only) and last-good fallback;
  stable parameter ids under rename, id-mapped retype with dropped-value
  counting, blocked parameter delete with journaled override (BS-D9);
  explicitly coded designated Default type row; presentation resolution order (§1.5) incl.
  `style_ref` fallback; assignment attach/detach incl. unapply; blocked
  deletion with live references; mixed-kind apply subset + skip report;
  bake key = (definition revision × values); create-from-selection seeds
  members and leaves sources untouched (BS-D17); extended
  `PropertyValueType` round-trip; generated spec namespaces in
  `propertySchemas`; multi-entity spec edits compile atomically and
  preserve foreign namespaces (extends the existing preservation test);
  catalog import collision resolution keep/replace/rename; string-code leading
  zeros; per-prefix digit/free-text/card_1 grammars; segment decoder units and
  ambiguity; stable id across explicit code rename; exact revision pinning;
  CSV→catalog→XML→catalog semantic round-trip for every record kind (BS-D18).
- **changed:** editor and panel component tests — field commit/Escape
  semantics (design-system contract), error-list rendering, CSV
  value-table import preview, blast-radius copy ("affects N", "Retype N"),
  kind filter narrows edits, Mixed placeholder commit-to-all, type
  selector, section visibility per selection.
  D6 additions: catalog grammar/impact tables; shortcut virtualization,
  unavailable-pin repair, F9 focus and Tab/Enter/Space access; generation
  required-source labels and named blocker copy; code-review status/count rows;
  sewer topology/profile fields.
- **push (risk-triggered by core/schema/renderer paths):** browser
  interaction tests — apply picker end-to-end incl. live count under
  pass-through selection clicks, close only on the B2 events, "No
  specification" unapply, mixed-kind counts; retype blast-radius copy;
  instance parameter edit affects one entity; concurrent-edit
  `VersionConflict` re-query path; editor stale-view refresh preserving
  uncommitted text; migration prompt on first open; window open/close
  symmetry, Escape ladder, and canvas gesture containment (viewport
  gestures unaffected while a canvas tool is armed); long-running spec
  jobs appear in the UIP-D10 chip/island chain.
  D6 browser flows: detach/re-dock shortcuts and generation with identical
  viewport behavior; no number-key slot activation; current-spec click followed
  by Draw point/line/area commit applies BS-D12 style and replaces DR-D4 layer
  atomically; cover-point, wall-side, and room-height completion; P4 excludes
  hidden/clipped completion candidates; Escape follows field → pick/tool →
  function; SE-D3 transform leaves source observations fixed and shows the
  manual-placement override before regeneration.
- **push (risk-triggered) / release (always), capability `browser-gpu`:**
  spec-render gate — orbit over the calibrated ≥ 10⁴-occurrence scene
  with one live area fill, p95 frame interval ≤ 2× target frame time;
  editor-preview gate — scripted type-switch and parameter-typing bursts
  in the open editor, p95 preview update ≤ one frame budget, state
  samples feeding §7 criterion 3; bounded gates — 10⁴-entity apply and
  multi-edit under 1 s on the reference tier (thresholds tunable, X6).
- **release, capability `real-data`:** IFC ingest of a real model →
  derive-specifications flow produces one definition per class with
  attributes populated; classification component readable in the panel.
  Add coded CSV fixtures with leading-zero/free-text/mixed schemas, string and
  control codes distinct from attributes, unknown/ambiguous/incomplete rows,
  and cancel/crash: every unresolved row must survive as a plain point plus one
  review record. Add ISYBAU XML-2024 node/edge/profile fixtures for isolated
  manhole and connected Haltung; export completeness reports every missing
  topology/elevation field. DWA-M 145-3 and legacy M 150 fixtures remain
  unverified until Import/Formats admits their exact adapters.
- **automation:** SDK parity — an agent authors a definition with symbol
  (via the B1 `spec.symbol.set` payload) and types, creates one from a
  selection (`spec.create_from_selection`), applies and unapplies it,
  edits a Mixed attribute across a selection, and restores via undo,
  entirely through `spec.*`, `bim_object.place`, and the property protocol.
  Extend it to import/export a catalog table, manage/page 100,000 pins, set the
  one current type, resolve a code at an exact revision, generate/undo each D6
  object, and receive the same named blocker as the UI.
- **manual/visual:** screenshots (editor, picker, styled viewport,
  panel; both themes) against §7 at implementation review.

Explicitly unverified: subjective symbol-canvas authoring feel beyond the
component tests; CSV mapping ergonomics on exotic files; fill-thinning
aesthetics under the governor; the exact DWA-M 145-3 exchange syntax/profile;
any identity or format behind the term `easyBAU`. The last two are evidence
gaps, not product questions or compatibility claims.

## 7. Visual criteria (E1 artifact)

Failable criteria; comparison is against these statements, not taste:

1. The editor window uses shared window chrome and design tokens; a diff
   of its palette against `@himmelcad/theme` tokens shows zero one-off
   colors.
2. Parameter table separates geometry-driving parameters from attributes
   by grouped sections with headers — not by suffix or color alone.
3. The symbol preview flexes visibly within one frame budget of a type
   switch; no stale-geometry flash (state-sample assertion from the
   editor-preview benchmark, D1 gate b).
4. Every enabled entity-kind presentation exposes a working editor — no
   enabled-but-uneditable card (the current island fails this for nine of
   eleven kinds).
5. Error list entries name definition, type, parameter, and value; copy
   follows DESIGN-SYSTEM error rules (what failed, what is safe, next
   step).
6. Panel sections (Entity / Specification / Display) render with the
   shared section pattern; "Mixed values" is a placeholder style, never a
   committed-looking value.
7. Blast-radius copy states the real number ("Retype 12 entities"), never
   a generic verb.
8. Symbols render crisply at plan scales: the baked tree symbol at 1:250
   matches the preview rendering (same tessellation source, §1.4).
9. The shortcuts tab shows eight complete slots at default width without
   truncating code or current-state indication; overflow scrolls/virtualizes,
   and detached rendering is pixel-equivalent except for host chrome.
10. Every generated-object preview labels each parameter source and blocks with
    the exact missing reason; no incomplete preview uses completed-object
    styling.
11. Code review keeps unresolved rows visible with raw code, file/row, and next
    action; resolved and unresolved counts always sum to the exact validated
    input count.

## 8. Cross-spec cite-and-revise results

The owning-source revisions below landed in the consolidated 2026-09-02
reconciliation; the table preserves the cite-and-revise trace.

| Owning source                              | Applied disposition                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `specs/draw/draw.md`                       | **Applied:** DR-D4/DR-D16 consume the single `spec.current` state, capture catalog/type revision and target layer, preserve explicit-argument precedence, and cite BS-D19; F9 focuses the shortcuts panel without taking number typing from DR-D1.                                               |
| `specs/import-formats/import-formats.md`   | **Applied:** IF-D5/IF-D8 carry catalog/code/string/control/attribute review, invoke `spec.resolve_code`/BS-D20 within BS-D21's transaction, and distinguish ISYBAU XML-2024, DWA-M 145-3, and DWA-M 150 without an `easyBAU` claim.                                                              |
| `specs/ui-platform/ui-platform.md`         | **Applied:** UIP-D8/UIP-D14 remain owners; Specification shortcuts and Generate are detachable-function consumers, F9 focuses shortcuts, and number slots remain absent so Draw typing retains ownership.                                                                                        |
| `specs/measure-inspect/measure-inspect.md` | **No capability revision requested.** Retain §1's sole ownership of persistent Measurement artifacts. A manhole cover/source completion pick uses the shared snap pipeline and creates no measurement; this no-overlap disposition should be cited if its consumer matrix enumerates generation. |
| `specs/select-edit/select-edit.md`         | **Applied:** the BIM-object consumer changes placement only, leaves linked observations fixed, records manual override, asks Keep/Reset on regeneration, and leaves parameter/content edits BIM-owned.                                                                                           |
| `REGISTRY.md`                              | **Applied:** all BIM/D6 rows are registered, `file.import` remains one shared act, F9 and gesture/state arbitration are recorded, and the standing checks pass.                                                                                                                                  |

## 9. Owner-decision items

**None.** Candidates tested against the escalation protocol and dissolved
in writing: "may specifications generate geometry?" — decided by owner
decision D3 before this spec; "where does the specification library
persist?" — closed by P1/X3 (BS-D1); "is a dedicated editor window
allowed?" — closed by contract B3's own surface taxonomy plus the
reference's do-not-adopt evidence (BS-D7); "how deep do schedules go
now?" — closed by CURRENT-DIRECTION completion discipline plus dependency
order (BS-D14); "which IFC fidelity to promise?" — closed by A2's
evidence rule against the implemented importer/exporter (BS-D13); "who
decides the Draw/BIM placement contradiction?" — tested by the reviewer
against the escalation protocol and closed by axiom-level adjudication
(BS-D16), a spec correction, not an owner question. No axiom conflict,
scope boundary, or reserved question remains. “What does `easyBAU` refer to?”
is recorded as an A2 evidence gap under BS-D22, not a design question; until a
vendor/schema/fixture identifies it, the product makes no compatibility claim.

## Cross-spec reconciliation 2026-09-02

| Item                    | Disposition                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan ownership          | BS-D14 now cites PE-D10 schedule placement; BS-D15 removes Plan filter/template ownership and cites PE-D6.                                                                                                             |
| D6 consumers            | Draw DR-D4/DR-D16 consume BS-D19 current specification; Import IF-D5/IF-D8 consume BS-D20/BS-D21 code resolution/generation; UI Platform UIP-D8/UIP-D14 registers shortcuts/Generate as detachable-function consumers. |
| IFC/update              | BS-D13 and IF-D4 cite each other for `GlobalId` identity, classification merge, and reviewed specification proposals.                                                                                                  |
| P10/G12 dependency      | BS-D24 supplies BIM generation/face recipe payload and output rules while MT-D25 alone owns `derived.recipe.*`; SE-D20/IF-D18 source and import invalidations are reciprocal.                                          |
| Semantic cursor         | BIM cites UIP-D24/§9.7 and declares pick/snap/Fangkreis, stable admitted semantic handles, prohibited, and wait; BS-D23's manifest bounds component identity.                                                          |
| Batch-2 GAP attribution | BS-D25 derives the BIM-owned observed-strata/Mesh-consumer split from GAP-D8 and cites G-B2-STRATA; GAP-D7 remains Mesh-window-only.                                                                                   |
| GAP §6 Civil inbound    | BS-D19/BS-D20 are amended by BS-D23/BS-D24 citations to CIV-D8/CIV-D9: BIM owns stable semantic faces/strata and Civil/Mesh consume them.                                                                              |
| Re-walk 2026-09-02      | Complies with P5/P6 and current contract rules. P7 is explicit in BS-D18–BS-D22: code grammar, tables, symbol/catalog defaults, and exchange profiles are mechanisms plus editable data, never fixed office truth.     |

## Owner statements batch 2 — 2026-09-02

This section amends BS-D12/D18/D19/D20 and generation/source records. BIM exposes
stable semantic subcomponent ids for a wall's anchor, corners, edges, and outer
faces. Its eligible-component manifest is revisioned, paged, and LOD-bounded for
complex objects; it never promises every IFC primitive. UIP-D21 renders selection,
and SE-D19 decides effective P9 eligibility. Symbol selection emphasizes only the
referenced anchor. The Type taxonomy supplies P9 nodes/capabilities and consumes
UIP-D20's Mixed/propagation protocol; BIM keeps no separate interaction-state store.

Role-generated objects are P10 linked recipes by default. Their recipe records
source geometry ids/revisions, semantic role, definition/type/catalog revisions,
parameters, and generator version and follows MT-D25's linked/stale/regenerate/
detach/auto-detach/error/DAG state machine. A generic placement transform remains
the existing visible manual override and regeneration asks Keep/Reset. Stable outer
face refs are handed to Civil CIV-D8/CIV-D9 for slopes/pits and to Mesh MT-D26 as
surface-role inputs; BIM retains semantic identity and never publishes a surface.

`BoreholeStratumSet@1` is the semantic hand-off for height-layer solids: borehole
ids/revisions and authoritative XYZ; ordered interface records with stratum id,
specification id, absolute elevation or depth datum, units, source observation,
uncertainty/missing flag, and catalog revision. Validation reports missing,
duplicate, inverted, and crossing interfaces. Office layer/specification tables
remain editable P7 data. Mesh MT-D27 consumes only validated sets and never infers
an absent interface. This schema is an owner-statement specification, not an
unsupported reference-product claim; the dossier has no borehole-strata evidence.

Registry entries applied by the round-3 rebuild: `bim.components` is a paged query/capability
(`bim.component.page/get`), existing `bim.object.generate` contributes access to
MT-D25's `derived.recipe.get/list/status/regenerate/detach/relink`, and new `bim.strata` uses
`bim.strata.get/page/create/update/validate` with expected revisions.

**BS-D23 — BIM exposes bounded semantic components and consumes P9.** **Decision:**
stable anchors/corners/edges/faces and the Type-node protocol above are BIM outputs;
UI/Select retain rendering/membership authority. **Derivation:** S2/S5/G5, P9,
X1, X2, UIP-D20/UIP-D21, SE-D19. **Rejected:** indiscriminate IFC primitive picks;
BIM-owned selection state. **Tunable:** manifest page/LOD budget.

**BS-D24 — Generated objects and outer faces keep linked recipes.** **Decision:**
generation and face hand-offs cite MT-D25/P10 and preserve exact semantic refs;
Detach retains provenance and missing sources auto-detach with console notice.
Source/import/placement/catalog changes invalidate the recipe once at the owning
transaction boundary under SE-D20/IF-D18; BIM never regenerates a sibling source.
**Derivation:** S7/S14, G9/G12, P10, Civil CIV-D8/D9, MT-D25, SE-D20, IF-D18. **Rejected:** copied
anonymous faces; bespoke BIM dependency lifecycle; cascade deletion. **Tunable:**
automatic-regeneration cost budget.

**BS-D25 — Borehole strata are explicit semantic inputs.** **Decision:** the
versioned schema/validation above is BIM-owned and Mesh-consumed. **Derivation:**
S11, P7, P10, X1, GAP-D8, G-B2-STRATA. **Rejected:** invented layers between incomplete logs;
Mesh-owned office semantics; claiming dossier evidence that does not exist.
**Tunable:** warning thresholds for uncertainty, not observed values/order.

Verification covers stable ids across edits/import update, wall and complex-object
manifest bounds, anchor-only symbol highlight, every P9 state/Mixed, generated
recipe lifecycle/DAG, face invalidation into Civil/Mesh, and valid/missing/crossing
stratum fixtures.

| Work-order item                            | Disposition                                        |
| ------------------------------------------ | -------------------------------------------------- |
| S2/G5 wall components and anchor selection | Applied by BS-D23.                                 |
| S5 Type taxonomy P9 nodes                  | Applied by BS-D23; no second store.                |
| S7 BIM outer faces to Civil/Mesh           | Applied by BS-D24.                                 |
| S11 height-layer semantic inputs           | Applied by BS-D25; dossier absence disclosed.      |
| S14/G12 role-generated recipes             | Applied by BS-D24, citing the single MT-D25 model. |
