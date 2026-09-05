# Reference dossier: Autodesk Revit — specification management and BIM objects

Status: research dossier, 2026-09-01. Evidence for `docs/FUNCTION-CONTRACT.md`
A2 derivations in the BIM/specifications domain and for owner decision D3
(generative specifications, pending confirmation). Never normative by itself.

Scope: Revit is the named reference for **specification management and BIM
objects** only. Its building-design scope (walls, MEP systems, worksharing,
energy analysis) is out of scope. This dossier covers the family system,
parameters, object styles, view templates/filters, materials, schedules, and
properties/multi-select editing.

Claims are sourced in §6. Statements marked **[from memory]** are practitioner
knowledge not independently re-verified during this research pass and must be
re-checked before they justify a decision on their own.

---

## 1. Specification architecture: category → family → type → instance

Revit's entire object model is a four-level hierarchy [S1, S2]:

1. **Category** — a fixed, built-in classification (Doors, Windows, Pipes,
   Generic Models, Detail Items…). Users cannot add categories. Category
   determines default graphics (object styles), which schedules an element
   can appear in, and which tags apply. **[from memory]**: the category is
   chosen when a family template is picked and is hard to change later.
2. **Family** — a named definition holding a parameter set and (for geometry
   families) a parametric geometry recipe. Three kinds [S1, S2]:
   - **System families** (walls, floors, ceilings, ducts…): built into the
     project, cannot be created/deleted via the UI, not saved to external
     files; only their _types_ are user-editable. Transferable between
     projects only via "transfer project standards". **[from memory]** for
     the transfer mechanism name; the "cannot be stored externally" claim is
     sourced for repeating details [S12].
   - **Loadable families** (`.rfa` files): authored in the Family Editor
     against a category-specific template, stored in external libraries,
     loaded into projects. The main content-creation vehicle (doors,
     furniture, fixtures, detail items, annotation symbols) [S1, S2].
   - **In-place families**: one-off project-specific geometry that can
     reference and react to surrounding project geometry; not reusable, and
     a well-known performance hazard when overused [S2, S22].
3. **Type** — a named set of parameter values within a family ("900 x 2100",
   "DN200"). Types are created/duplicated/renamed by end users in the
   project without opening the Family Editor [S2, S3].
4. **Instance** — a placed element. It references a type and additionally
   carries **instance parameters** whose values vary per placement without
   affecting siblings [S2, S3].

The core economic property: _one_ parametric family definition generates an
unbounded set of concrete variants. **Type catalogs** push this further: a
`.txt` file (same base name, same folder as the `.rfa`) lists many types with
their parameter values; on load, Revit shows a filterable dialog and loads
only the types the user picks, keeping projects small [S9, S10]. This is the
strongest single argument that D3's "specifications are generative,
Revit-family-like" is how the reference actually works: a specification is a
generator plus a value table, not a style record.

**Nested families**: a family can nest other families (a window nests its
handle; a desk nests chairs). Parameter linking is **parent → nested only**
(host parameters drive nested parameters; never the reverse, avoiding
cycles) [S11]. A plain nested family is invisible to the project — it cannot
be selected, tagged, or scheduled independently. Marking the nested family
**shared** makes it a stand-alone family in the project that schedules and
tags independently — at the price that shared nested families cannot have
their _type_ parameters driven by the host (workaround: drive instance
parameters instead) [S11].

---

## 2. Function catalog

### 2.1 Family Editor

A separate editing mode with its own ribbon, opened per family. The canonical
authoring method ("bones, brains, balance, body") [S4, S5]:

- **Reference planes/lines** form the skeleton; geometry is _constrained_ to
  them (aligned + locked), not drawn free-form [S4, S5].
- **Dimensions with labels** turn distances into named parameters [S4].
- **Family Types dialog** lists all parameters, their values per type, and a
  **Formula** column; formulas reference other parameters (arithmetic,
  trigonometry, conditional `IF`) [S5, S6].
- **Flexing**: repeatedly changing parameter values and clicking Apply to
  verify the geometry follows without breaking — the de-facto test procedure,
  entirely manual [S4, S5].
- Visibility controls per geometry element: detail level (coarse/medium/fine)
  and view-direction visibility. **[from memory]** for the exact dialog; the
  coarse/medium/fine mechanism is corroborated by materials behavior in [S17].

### 2.2 Parameter kinds

| Kind              | Defined                         | Scope                            | Schedulable | Taggable | Notes                                                                                                        |
| ----------------- | ------------------------------- | -------------------------------- | ----------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| Built-in/system   | Autodesk                        | everywhere                       | yes         | yes      | fixed semantics [S7]                                                                                         |
| Family parameter  | in a family                     | that family                      | no          | no       | drives geometry/formulas [S7, S8]                                                                            |
| Project parameter | in a project                    | categories of that project       | yes         | **no**   | attached to categories; not portable [S7, S8]                                                                |
| Shared parameter  | external `.txt` definition file | any project/family that loads it | yes         | yes      | the GUID-identified portability mechanism [S7, S8]                                                           |
| Global parameter  | in a project                    | project-wide, not element-bound  | no          | no       | named project-level values that _drive_ element instance/type parameters ("flex once, update many") [S7, S8] |

Orthogonally, every parameter is **type** or **instance** [S3], has a data
type (length, number, text, material, yes/no, …) and a discipline/group
placement in the properties UI. **[from memory]** for data-type list details.

Key structural insight for Himmel:CAD: Revit needs the _shared parameter_
machinery only because family files, projects, tags, and schedules are
separate silos that must agree on parameter identity via an external
GUID file. A system with one canonical store does not need this seam —
but it does need the _distinction_ the seam encodes: parameters with
project-wide identity (reportable, taggable) vs. private family internals.
This matches D3's required separation of geometry-driving parameters from
ordinary user attributes.

### 2.3 Constraints and formulas

Formulas live in the Family Types dialog per parameter; they must reference
constraint-bound parameters to have any geometric effect [S6]. Conditional
logic exists (`IF(...)`) and is routinely used defensively, e.g. clamping
array counts to ≥ 2 because Revit rejects arrays of one [S15]. Global
parameters extend the same idea to the project level [S8]. There is no
constraint _solver_ in the CAD sense — relationships are directional
(dimension drives geometry), which is simpler and more predictable than
free-form 2D constraint solving. **[from memory]** for the "no solver"
characterization.

### 2.4 Symbols and repeated elements (the owner's "point symbols / area fills" analog)

- **Detail components**: 2D loadable families (category Detail Items) placed
  in views — the direct analog of a **point symbol** [S13].
- **Repeating details**: a _system family type_ that tiles one detail
  component along a drawn path at a set spacing — draw two clicks, get a
  spaced row. Spacing, rotation, and fill behavior are type properties.
  Cannot live in external libraries (system family) [S12, S13].
- **Line-based detail components** with **array parameters**: a loadable
  alternative — the array count is labeled with a parameter and driven by a
  formula (`Length / module`), giving library-storable, keynotable,
  spacing-driven repetition [S13, S14, S15].
- **Fill patterns** (drafting vs model patterns) applied as material
  **surface/cut patterns** or filled regions — the analog of a hatch-style
  **area fill**. Model patterns represent real-world tiling and are
  snappable/alignable; drafting patterns are symbolic. [S18, S19; the
  model-vs-drafting distinction is **[from memory]**, corroborated by S18.]

Lesson: Revit implements "symbol + spacing rule + area fill" three different
ways with three different storage/portability behaviors, and practitioners
must know which to pick [S13]. Himmel:CAD should offer _one_ specification
concept with placement modes (point / along-curve with spacing / area fill),
per D3.

### 2.5 Object styles

A project-wide table: per category and subcategory, line weight, line color,
line pattern, and material [S16]. Subcategories let one family's geometry
carry different graphics (frame vs glass) [S16]. View-level overrides
(Visibility/Graphics) sit above object styles per view [S16, S20]. At coarse
detail level the object-style material wins over the type material [S17].
This is Revit's equivalent of a layer/style system — resolved by category,
not by a user-managed layer key.

### 2.6 View filters and view templates

- **Rule-based filters** select elements by category + parameter predicates
  ("all walls with Fire Rating = 2h") and apply graphic overrides in a view:
  projection/cut line color, pattern, weight, surface/cut patterns,
  transparency, visibility [S20, S21].
- **View templates** bundle view properties (scale, detail level, V/G
  settings, filters, …). Per template, each property is included or excluded;
  included properties override and **lock** the view's own settings while the
  template is _assigned_; a one-time "apply" copies values without locking
  [S22, S23]. Templates are the standardization backbone of Revit offices
  [S22].

### 2.7 Materials

A material is Identity (description, manufacturer, cost) + Graphics
(shading color, surface pattern, cut pattern for unrendered views) +
Appearance (rendering asset), plus optional Physical/Thermal assets
[S17, S18, S24]. Graphics and Appearance are deliberately decoupled: the
symbolic 2D representation and the photoreal representation are separate
specifications on one asset [S24].

### 2.8 Schedules

A schedule is a live tabular _view_ of the model: pick a category, choose
**fields** (parameters incl. calculated values with formulas), then
**filter** (all conditions ANDed), **sort/group** (with headers, footers,
totals; grouping collapses identical rows into counted rows) [S25, S26,
S27]. Schedules are bidirectional — editing a cell edits the element
**[from memory]**; sourced material stops at "schedule properties" [S26].
Only shared and built-in parameters can appear in both tags and schedules;
project parameters schedule but do not tag [S7, S8].

---

## 3. Core workflows

### W1 — Create a loadable family with parameters [S4, S5]

1. New Family → pick a category template (fixes category + hosting behavior).
2. Draw reference planes for every dimension that will flex.
3. Dimension the reference planes; label dimensions to create parameters
   (choosing type vs instance per parameter).
4. Open Family Types, create 2–3 types with different values, add formulas.
5. **Flex**: change values, Apply, watch geometry; fix broken constraints.
6. Only now model geometry, locked to the reference planes.
7. Assign subcategories and material parameters; set visibility per detail
   level; Load into Project.

### W2 — Type vs instance editing in a project [S2, S3]

1. Select an element → Properties palette shows instance parameters; edits
   affect only this element.
2. Edit Type → type parameters; edits affect **every** instance of the type
   project-wide (with no preview of how many — a classic pitfall,
   **[from memory]**).
3. Duplicate the type first to create a variant instead of mutating a shared
   one.

### W3 — Multi-select property editing [S28, S29]

1. Select several elements. Palette header shows category and count; mixed
   selections show "Multiple Categories/Families/Types Selected".
2. Only instance parameters **common to all** selected elements display.
3. A category drop-down filter narrows the selection view to one category
   (or the view itself) for editing.
4. Parameters with differing values show **`<varies>`**; typing a value
   pushes it to the whole selection.
5. The Type Selector re-types every selected element at once when a common
   family applies.

### W4 — Repeating detail / spacing-driven symbol row [S12, S13, S14]

1. Author a detail component (the symbol) as a 2D family.
2. Either: create a Repeating Detail type referencing it, set spacing;
   draw a line → tiled symbols. Or: build a line-based detail family whose
   array count = `Length / spacing` formula, load it, draw its two points.
3. Adjust spacing via type properties (repeating detail) or instance
   parameters (line-based family).

### W5 — Apply a view filter + template [S20, S21, S22, S23]

1. Create a rule-based filter: categories + parameter rules.
2. In a view's Visibility/Graphics → Filters tab: add filter, define
   overrides (color, patterns, transparency, visibility).
3. Create/edit a view template; tick exactly the properties it should
   control (including the filter set).
4. Assign the template to views; assigned properties become read-only in
   those views, guaranteeing office-wide consistency.

### W6 — Build a schedule [S25, S26, S27]

1. New Schedule → pick category.
2. Fields tab: add parameters; add calculated values with formulas.
3. Filter tab: predicates (ANDed).
4. Sorting/Grouping tab: sort keys, headers/footers/totals, "itemize every
   instance" off to collapse identical rows into counts.
5. Place the schedule on a sheet; it stays live with the model.

### W7 — Distribute a family with many variants (type catalog) [S9, S10]

1. In the Family Editor define parameters; export Family Types → `.txt`, or
   author the catalog in Excel/Notepad.
2. Ship `.rfa` + same-named `.txt` in one folder.
3. On load, the user filters the catalog dialog and loads only needed types.

---

## 4. What practitioners praise and hate

**Praise**

- The family/type/instance model itself: one parametric definition, many
  variants, consistent everywhere — the reason "Revit family" is the
  industry term for a parametric BIM object [S1, S2, S30].
- Type catalogs and shared parameters make manufacturer content ecosystems
  possible [S9, S10].
- Filters + view templates give rule-based, standards-enforcing graphics
  instead of per-element formatting [S20, S22].
- Live schedules tied to model data [S26].

**Pain**

- **Steep authoring curve**: family creation is "daunting", "nerve-wracking",
  concentrated in a few specialists; firms outsource it — content creation
  is an organizational bottleneck [S30, S31].
- **Manual verification**: flexing is a hand-run test loop with no automated
  regression checking [S4, S5].
- **Concept sprawl**: five parameter kinds [S7, S8], three repetition
  mechanisms with different portability [S12, S13], shared-vs-nested rules
  with asymmetric driving constraints [S11], and array counts that cannot be
  1 without an IF-formula workaround [S15]. Correct choices demand
  encyclopedic knowledge.
- **Rigid category system**: fixed categories; template choice locks
  category and hosting early. **[from memory]**, consistent with S1/S2.
- **Performance traps**: in-place family overuse degrades models [S22-g2,
  S31].
- Silent blast radius of type edits (no "affects N instances" feedback)
  **[from memory]**.

Himmel:CAD's stated goal — the power without the pain — translates to:
keep the generator/type/instance economics; delete the silo-driven concept
sprawl (shared parameter files, three repetition mechanisms, system-vs-
loadable portability rules); make flexing automatic (property-driven
regeneration is just re-evaluation in a canonical store).

---

## 5. Mapping hints for Himmel:CAD

- **BIM ribbon tab (D2)**: candidate groups derived from the Revit catalog —
  Specifications (open SpecsIsland/editor), Place (point symbol, along-curve,
  area fill placement modes), Schedules/Reports, and View Rules (filters +
  templates analog). Revit splits these across Architecture/Annotate/View/
  Manage tabs; Himmel:CAD can co-locate them because the domain tab is BIM.
- **Specifications system (D3, `apps/builder/renderer/src/SpecsIsland.tsx`,
  `@himmelcad/specs`)**: the current `Specification` record (code, name,
  drawFolder, per-entity-kind presentations, attributes) corresponds to a
  Revit _type_ plus fragments of object styles. The Revit lesson: split the
  model into (a) a **definition** level = family analog (parameter schema +
  optional geometry/symbol generator + presentation rules) and (b) a
  **value** level = type analog (named parameter-value sets, potentially
  table-imported like type catalogs), with (c) instance-level overrides on
  placed entities. Keep D3's separation: `attributes` (user data, reportable)
  vs geometry-driving parameters (private to the generator unless exported).
  One placement concept with three modes replaces detail component /
  repeating detail / line-based array.
- **Global-parameter analog**: project-level named values that specification
  parameters may reference — cheap to add once formulas exist, high leverage
  for "change the module size once" workflows [S8].
- **View filters/templates**: the analog for Himmel:CAD is rule-based
  presentation overrides per viewport/plan view, driven by specification
  membership and attribute predicates — relevant to the plan composer (D4)
  rather than a separate paper-CAD.
- **Entity properties / multi-select (FUNCTION-CONTRACT C-section)**: adopt
  Revit's proven contract [S28, S29]: show the intersection of common
  parameters; `<varies>` placeholder that commits to all on overwrite;
  selection header with category + count and a category filter drop-down;
  a type-selector that re-types the whole selection. Improve on Revit:
  preview blast radius before type-level edits, and keep type vs instance
  editing visually distinct rather than behind a modal "Edit Type" dialog.
- **What to deliberately not adopt**: shared-parameter GUID files (single
  canonical store removes the need), fixed category taxonomy (specifications
  - entity kinds already play this role, user-extensible), in-place families
    (ordinary modeling covers it), separate family-editor application mode
    (SpecsIsland with live viewport preview instead).

---

## 6. Sources

- [S1] Autodesk Help, "About Families" — https://help.autodesk.com/cloudhelp/2020/ENU/Revit-Model/files/GUID-6DDC1D52-E847-4835-8F9A-466531E5FD29.htm
- [S2] Autodesk Knowledge Network, "About the Different Kinds of Families" — https://knowledge.autodesk.com/support/revit-products/learn-explore/caas/CloudHelp/cloudhelp/2019/ENU/Revit-Model/files/GUID-403FFEAE-BFF6-464D-BAC2-85BF3DAB3BA2-htm.html
- [S3] Cursa, "Understanding Families: Types, Instances, and Parameters" — https://cursa.app/en/page/understanding-families-types-instances-and-parameters-in-a-beginner-workflow
- [S4] Autodesk University, "Revit Families: A Step-By-Step Introduction" — https://www.autodesk.com/autodesk-university/article/Revit-Families-Step-Step-Introduction-2018
- [S5] Revit Gamers, "Create Revit parametric family: Step-by-Step" — https://revitgamers.com/create-revit-parametric-family/
- [S6] Autodesk Help, "Use Formulas in the Family Editor" — https://help.autodesk.com/cloudhelp/2024/ENU/Revit-Customize/files/GUID-EEC4A03D-1EE8-49C0-8390-91C0BF649AE4.htm
- [S7] ATG USA, "Types of Revit Parameters" — https://atgusa.com/types-of-revit-parameters/
- [S8] April Kane, "Shared Parameters vs Global Parameters" — https://aprilkane.com/2023/06/27/shared-parameter-vs-global-parameters/ ; Paul F. Aubin, "Revit Parameters" — https://paulaubin.com/blog/revit-parameters/
- [S9] GRAITEC, "Revit Type Catalogs" — https://graitec.com/uk/blog/revit-type-catalogs/
- [S10] BIMsmith, "How to Load a Revit Family Using a Type Catalog" — https://blog.bimsmith.com/How-to-Load-a-Revit-Family-Using-a-Type-Catalog
- [S11] Kinship, "Nested Families: To Share or Not to Share?" — https://kinship.io/blog/nested-families-to-share-or-not-to-share ; Modelical, "Nested Families" — https://www.modelical.com/en/gdocs/nested-families/
- [S12] Arkance UK, "Revit Repeating Detail Components, Part 2" — https://ukcommunity.arkance.world/hc/en-us/articles/21565717072402-Revit-Repeating-Detail-Components-Part-2
- [S13] Arkance UK, "Revit Repeating Detail Components, Part 3" (line-based alternative) — https://ukcommunity.arkance.world/hc/en-us/articles/21565749557394-Revit-Repeating-Detail-Components-Part-3
- [S14] Autodesk Help, "Video: Create a Line-Based Detail Component" — https://help.autodesk.com/cloudhelp/2021/ENU/RevitLT-DocumentPresent/files/GUID-2E2F3E90-C3CD-4A3D-B099-3AA06E51CE25.htm
- [S15] Arkance UK, "Revit Repeating Detail Components, Part 4" (array formulas, min-2 IF workaround) — https://ukcommunity.arkance.world/hc/en-us/articles/21565763056914-Revit-Repeating-Detail-Components-Part-4
- [S16] Autodesk Help, "Object Styles" — https://help.autodesk.com/cloudhelp/2023/ENU/Revit-Customize/files/GUID-01DE5723-A5DD-41FE-B7C7-3C9B37B5C8C2.htm ; CADnotes, "Controlling Revit Appearance: Object Styles" — https://www.cad-notes.com/revit-object-styles/
- [S17] CADnotes, coarse-detail material behavior — https://www.cad-notes.com/revit-object-styles/
- [S18] Autodesk Help, "About Fill Patterns for Material Graphics" — https://help.autodesk.com/cloudhelp/2019/ENU/Revit-Customize/files/GUID-EBD9E8E6-AF83-4579-8D9A-9B9E23DCAA52.htm
- [S19] CADnotes, "Understanding Surface and Cut Patterns in Revit" — https://www.cad-notes.com/understanding-surface-and-cut-patterns-in-revit/
- [S20] Novedge, "Using Revit View Filters for Consistent Model-Based Graphics" — https://novedge.com/blogs/design-news/revit-tip-using-revit-view-filters-for-consistent-model-based-graphics
- [S21] ZenTek Consultants, "Working with View Filters in Autodesk Revit" — https://zentekconsultants.net/working-with-view-filters-in-autodesk-revit/
- [S22] Novedge, "Standardize Revit Views Using View Templates" — https://novedge.com/blogs/design-news/revit-tip-standardize-revit-views-using-view-templates ; LazyBim, "View Template Revit" — https://lazybim.com/view-template-revit/
- [S23] Revit Families Hub, "Revit View Templates Explained" — https://revitfamilieshub.com/revit-view-templates-explained/
- [S24] Autodesk Help, "About Material Properties and Assets" — https://help.autodesk.com/cloudhelp/2019/ENU/Revit-Customize/files/GUID-8D1A49AB-849C-49DF-A7B9-34C596E0C6F2.htm ; "Change the Graphics Properties of a Material" — https://help.autodesk.com/cloudhelp/2019/ENU/Revit-Customize/files/GUID-5DFA9F47-B6FF-4D79-A240-FA27BEA7C7AB.htm
- [S25] Autodesk Help, "Create a Schedule or Quantity" — https://help.autodesk.com/view/RVT/2024/ENU/?guid=GUID-6D4DBBDA-3611-40CD-9A45-BE40EB07188A ; "Filter Data in a Schedule" — https://help.autodesk.com/view/RVT/2024/ENU/?caas=caas%2FCloudHelp%2Fcloudhelp%2F2024%2FENU%2FRevit-DocumentPresent%2Ffiles%2FGUID-C5140A8E-EDB3-4C99-84F0-9299D5136369-htm.html
- [S26] CADnotes, "Revit Schedules 101: Organizing the Data" — https://www.cad-notes.com/revit-schedules-101-part-3-organizing-the-data/
- [S27] Modelical, "Model Schedules" — https://www.modelical.com/en/gdocs/model-schedules/
- [S28] Autodesk Help, "Properties Palette" — https://help.autodesk.com/cloudhelp/2019/ENU/Revit-GetStarted/files/GUID-A764EA7A-FE26-469B-857C-F3A70812FC34.htm
- [S29] Novedge, "Bulk Editing in Revit: Multi-Select with the Properties Palette" — https://novedge.com/blogs/design-news/revit-tip-bulk-editing-in-revit-multi-select-with-the-properties-palette
- [S30] Majenta, "Pros & Cons of Parametric Revit Families" — https://www.majentasolutions.com/news/pros-cons-of-parametric-revit-families---and-when-to-use-them
- [S31] Virtual Building Studio, "Revit Family Creation for Modern AEC Firms" (outsourcing/bottleneck) — https://www.virtualbuildingstudio.com/blog/revit-family-creation-for-aec-firms/ ; SoftwareSuggest Revit reviews (performance complaints) — https://www.softwaresuggest.com/revit/reviews

### Evidence quality statement

Architecture, parameter kinds, filters/templates, schedules, type catalogs,
nested/shared families, repeating-detail mechanics, and multi-select behavior
are backed by Autodesk documentation or established practitioner sources
found in this research pass (web search summaries plus the linked pages; the
pages themselves were not all fetched in full — claims rest on search-result
extracts of those pages). Sentiment in §4 draws on a thinner base (vendor
blogs, review aggregators) than the feature claims and should be treated as
directional. All unverified practitioner-knowledge statements are explicitly
marked **[from memory]** (family category lock-in, transfer project
standards, bidirectional schedule editing, model-vs-drafting patterns,
no-constraint-solver characterization, silent type-edit blast radius); none
of them alone should decide a Himmel:CAD design question without a
verification pass.
