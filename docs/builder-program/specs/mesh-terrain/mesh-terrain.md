# Mesh & Terrain domain — domain specification

Status: specified (registry 2026-09-02 incremental). Round-3 registry rebuild through batch 2; owner batch-3 catalog rows are registered. Shared-schema admissions and implementation gates remain. Revised 2026-09-02. Document class: plan. Walks `docs/FUNCTION-CONTRACT.md`
(current version, including the 2026-09-01 additions: evidence-precedes-spec with dossier citations, dossier-wide absence
checks, code claims by file:line with stubs-count-as-not-existing, per-dossier-row catalog dispositions, D1 whole-app
restart/resource/completion budgets, extreme-class-member and input-gesture arbitration rules, E1 in-repo artifact, E2
passive-consumer enumeration, A3 verified sibling semantics, C4
restore-scope). Every consequential choice carries a `docs/DECISION-DOCTRINE.md` decision record.

Primary evidence: `docs/builder-program/dossiers/rib-civil.md` §2.6 and §3 W5 (DGM build with breaklines and error fixing — the
domain's defining workflow) and `docs/builder-program/dossiers/realworks.md` §2.8 and §3 W7 (mesh creation and volume from
clouds). Sibling specs interlocked: `specs/view/viewing-box.md` (VB-D3/VB-D13), `specs/view/view-domain.md` (VD-D8 two-layer
display model; section-plane family §2.1/§3.2), `specs/draw/draw.md` (DR-D8 Civil boundary, DR-D12/DR-D13 snapping,
§3.3 breakline authoring), `specs/pointcloud/pointcloud.md` (PC-D7 provenance, PC-D10 inspection deferral, PC-D11
display-style class, domain handoffs at pointcloud.md §1), `specs/raster/raster.md` (RA-D5/RA-D7),
`specs/import-formats/import-formats.md` (IF-D4), `specs/select-edit/select-edit.md` (SE-D3/SE-D11),
`specs/file-project/file-project.md` (FP-D5/FP-D6), and `specs/ui-platform/ui-platform.md` (§3.6 gesture map,
UIP-D8/D10/D14/D15/D17). E1 reference artifact: §7 of this file (in-repo written criteria; no third-party screenshots per
repository license discipline).

**Recorded owner statement 2026-09-01.** Recorded here as its repo-resident source per doctrine auditability rule 1:

- _Surface creation is a dedicated resizable window: the user pre-selects the input entities (points, breaklines, clouds),
  launches the window, and fixes data errors there — e.g. a breakline not lying on points, or crossing breaklines — before
  committing the surface. Mesh display modes are realistic, abstract, and wireframe._

Resolution levels per `docs/builder-program/README.md`: **workflow level** for surface creation with error fixing (§2.1),
surface editing (§2.2), volumes (§2.3), and display modes (§2.4); **contract level** for contours (§3.3) and simplification
(§3.6); **catalog level** for mesh-from-cloud Poisson/Delaunay (§3.4) and texture handling (§3.7), with reasons in their
records. Cloud→DGM constrained-Delaunay input remains part of the workflow-level surface window (§2.1), not the catalog-only
3D mesh row. Owner batch 3 promotes region repair and terrain simplification to workflow level in §11; that later section is
more specific than the earlier contract-level simplification text where they differ.

## 1. Scope, boundaries, and function catalog (registry rows)

Canonical entity ids are `hcad.elevation-surface@1` and `hcad.surface-3d@1` exactly as declared in
`crates/himmelcad-core/src/entity_model.rs:33-36,81-84`; the unhyphenated “surface3d” wording is descriptive, not a second type id.

### 1.1 Boundaries (cited, never re-dispositioned)

- **Section planes and section entities** belong to the View domain (view-domain.md §2.1/§3.2; canonical sections VD-D13).
  This spec ships the _surfaces they cut_; the exact open-mesh section product already exists in render
  (`crates/himmelcad-render/src/section.rs:776-780`, `section_open_mesh` — "displayed as an exact DGM/profile trace") and stays the shared substrate.
- **Alignments, gradients, corridors, slopes/pits, and profile windows** are Civil-owned per Civil CIV-D2–D14 and Draw
  DR-D8. Mesh consumes typed corridor/pit manifests and remains sole surface publisher; it does not re-disposition Civil semantics.
- **Ortho-image generation** is Pointcloud-owned with Raster-owned output (pointcloud PC-D9); realworks.md §2.8 ortho rows
  stay there.
- **Cloud segmentation, extraction, sampling** are Pointcloud (pointcloud.md §1). Mesh-from-cloud consumes clouds; it never
  edits them.
- **Breakline and boundary authoring** is Draw: "drafted polylines serve as breaklines/boundaries without conversion"
  (draw.md:523, §3.3); height assignment/draping is `draw.assign_heights` under DR-D3 (draw.md §3.3). This spec consumes those
  entities and adds no second drafting path.
- **Surface-to-model and twin-surface inspection** remain Pointcloud catalog rows deferred by PC-D10 pending this spec; their
  follow-up is theirs (cited, not claimed — the registry must not double-book). Difference models are therefore not a Mesh
  backlog item. Pointcloud also owns cloud breakline finding; Mesh consumes the resulting Draw curves as ordinary breaklines.
- **Grid display and Grid→Tin arrival** follow Raster RA-D5 and RA-D7. Raster owns the `raster.to_dgm` source selection,
  spacing, P4 scope, and journaled creation; Mesh owns validation, editing, display, snap, contour, volume, and export behavior
  of the resulting Tin. No second conversion command is defined here.
- **Whole-entity placement** follows Select/Edit SE-D3 and SE-D11: transforms change placement, never mesh/source buffers, and
  multi-entity commits are all-or-none expected-revision transactions. Mesh consumes placement versions for invalidation.
- **Changed imports** follow Import Formats IF-D4: identity-strict matched updates, Keep as local for referenced removals,
  dependency-safe expected-revision publication, and exact undo. Mesh registers every draft and derivative as a dependent.
- **PhotoLab product arrivals** follow Import Formats IF-D19/IF-D20/IF-D23/IF-D25:
  prepared open `hcad.surface-3d@1` and closed `hcad.object-3d@1` become ordinary
  Mesh-owned entities with exact provenance/export/Plan/WeltView semantics. They
  are snapshot imports, not Attach references. With no admitted reproducible
  mapping they have no MT-D25 recipe and their PhotoLab ids never enter the recipe
  DAG or reverse index. Re-publishing one as a derived Mesh result creates the one
  output recipe governed by MT-D25; no Mesh import alias is added.

### 1.2 Function catalog

Ribbon tab: **Mesh** (owner decision D2: "Terrain/surface functions live in Mesh unless the dossiers show reference products
separate them" — checked: rib-civil groups DGM under one `<DGM>` menu (rib-civil.md §2.6) and realworks under one Surfaces
group (realworks.md §2.8); neither separates a Terrain surface set from a Mesh surface set, so one tab stands). Groups:
**Create**, **Edit**, **Analyze**, and **Display**. Entity display properties live in the right properties panel per the
PC-D11/VD-D8 class; Display contains only canonical Mesh entity styling. The View-owned `view.render-style` row is not
surfaced from Mesh until VD-D6/VD-D8 are extended by their owner (§2.4, §8). Protocol spellings below follow the
schema-verified dotted lower-case/`snake_case` convention (MT-D24). The round-3 registry includes the shared recipe,
hull, solid, strata, P9, and status delta in §10.5; implementation remains admission-gated.

| Id                      | Group                                      | Access paths (exact console alias)                                                                                          | Surface                                     | Perf                                    | Automation                                                                                                                                                                     | Status vs current code                                                                                                                                        |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mesh.create-surface`   | Create                                     | ribbon **Create surface…**; eligible-selection context; console `mesh surface create`; automation                           | dedicated resizable window                  | continuous canvas; preview bounded→long | `mesh.surface.draft.list/get/create/set/apply_fix/history/undo/redo/suspend/resume/discard`, `mesh.surface.check/create`                                                       | new; current entity commands are placement-only (`crates/himmelcad-core/src/entity_commands.rs:18-91`)                                                        |
| `mesh.edit-terrain`     | Edit                                       | ribbon/context **Edit terrain surface…** for Tin; console `mesh terrain edit`; automation                                   | same window, terrain mode                   | bounded→long                            | `mesh.surface.edit.add_point/remove_point/swap_edge/set_boundary/add_hole/remove_hole/fill_hole/add_breakline/remove_breakline/add_form_line/remove_form_line/set_source_role` | new; ElevationSurface Tin only; Grid offers RA-D7 **Convert to editable Tin…**                                                                                |
| `mesh.edit-3d`          | Edit                                       | ribbon/context **Edit 3D mesh…** for Surface3d; console `mesh 3d edit`; automation                                          | same window, 3D repair mode                 | bounded→long                            | `mesh.surface3d.edit.add_triangle/remove_triangles/fill_hole`                                                                                                                  | new; inline and resource-backed contract in §2.2/MT-D22                                                                                                       |
| `derived.recipe-manage` | Edit (shared act; Mesh contributes access) | Properties **Regenerate / Detach / Relink…**; context **Rebuild from sources…**; console `mesh surface rebuild`; automation | properties actions + job                    | bounded→long                            | common `derived.recipe.get/list/status/regenerate/regenerate_batch/detach/relink`                                                                                              | new common act; Mesh label/console are adapters, while old `mesh.rebuild` / `mesh.surface.rebuild` are retired before schema/SDK freeze (MT-D25)              |
| `mesh.convex-hull`      | Create                                     | ribbon **Convex hull…**; eligible-selection context; console `mesh hull create`; automation                                 | assistant + job                             | bounded→long                            | `mesh.hull.preview`, `mesh.hull.create` plus common recipe queries/actions                                                                                                     | new; checked 2D Area and/or 3D Surface3d outputs (MT-D28)                                                                                                     |
| `mesh.solid-between`    | Create / Analyze                           | ribbon/context **Solid between…**; console `mesh solid create`; automation                                                  | assistant + job                             | bounded→long                            | `mesh.solid.preview`, `mesh.solid.check`, `mesh.solid.create` plus common recipe queries/actions                                                                               | new; atomically publishes separate Cut/Fill or per-stratum solids (MT-D29/MT-D30)                                                                             |
| `mesh.from-cloud`       | Create, hidden until promoted              | none                                                                                                                        | deferred focused workspace                  | long                                    | deferred; reserved `mesh.from_cloud`                                                                                                                                           | cataloged-deferred; current Poisson/Delaunay dispatch is PhotoLab/COLMAP-only (`crates/himmelcad-sidecar/src/colmap_runtime.rs:71-72`)                        |
| `mesh.contours`         | Analyze                                    | ribbon/context **Contours…**; console aliases listed below; automation                                                      | right function panel                        | bounded→long                            | `mesh.contours.generate`; existing groups use common `derived.recipe.regenerate`                                                                                               | new                                                                                                                                                           |
| `mesh.volume`           | Analyze                                    | ribbon/context **Volume…**; exact console list below; automation                                                            | right function panel + File Export hand-off | long                                    | compact inventory below; export via `io.export.plan/execute`                                                                                                                   | new                                                                                                                                                           |
| `mesh.display`          | — (properties)                             | properties/context; console `mesh display set`; automation                                                                  | right properties panel                      | bounded                                 | `mesh.set_display`                                                                                                                                                             | new; no first-party Builder command/display surface contains `wireframe`; flat/lit GPU materials exist (`crates/himmelcad-render/src/gpu_frame.rs:4604,4625`) |
| `mesh.simplify`         | Edit                                       | ribbon/context **Simplify…**; console `mesh simplify`; automation                                                           | small panel + job                           | long                                    | `mesh.simplify.preview/check/bake`                                                                                                                                             | new; batch 3 promotes ElevationSurface Tin to workflow level (§11/MT-D34); prepared display LOD is not canonical decimation                                   |
| `mesh.texture`          | Edit, hidden until specified               | none                                                                                                                        | deferred texture workspace                  | long                                    | deferred; reserved `mesh.texture.apply/bake`                                                                                                                                   | cataloged-deferred; storage and prepared-texture construction exist, authoring does not (MT-D13)                                                              |

Expanded exact automation inventory (slashes in the compact table do not define protocol ids):

- Draft/create: `mesh.surface.draft.list`, `mesh.surface.draft.get`, `mesh.surface.draft.create`,
  `mesh.surface.draft.set`, `mesh.surface.draft.apply_fix`, `mesh.surface.draft.history`,
  `mesh.surface.draft.undo`, `mesh.surface.draft.redo`, `mesh.surface.draft.suspend`,
  `mesh.surface.draft.resume`, `mesh.surface.draft.discard`, `mesh.surface.check`, `mesh.surface.create`.
- Terrain edit/rebuild: `mesh.surface.edit.add_point`, `mesh.surface.edit.remove_point`,
  `mesh.surface.edit.swap_edge`, `mesh.surface.edit.set_boundary`, `mesh.surface.edit.add_hole`,
  `mesh.surface.edit.remove_hole`, `mesh.surface.edit.fill_hole`, `mesh.surface.edit.add_breakline`,
  `mesh.surface.edit.remove_breakline`, `mesh.surface.edit.add_form_line`,
  `mesh.surface.edit.remove_form_line`, `mesh.surface.edit.set_source_role`. **Rebuild from sources…** routes to
  common `derived.recipe.regenerate`; `mesh.surface.rebuild` is not a second protocol act.
- 3D repair: `mesh.surface3d.edit.add_triangle`, `mesh.surface3d.edit.remove_triangles`,
  `mesh.surface3d.edit.fill_hole`.
- Derivatives/display: `mesh.contours.generate`, `mesh.volume.compute`,
  `mesh.volume.save_report`, `mesh.volume.list_reports`, `mesh.set_display`, `mesh.simplify.preview`,
  `mesh.simplify.check`, `mesh.simplify.bake`. Volume CSV uses the
  separately owned exact commands `io.export.plan` and `io.export.execute`.
- Shared recipe surface: `derived.recipe.get`, `derived.recipe.list`, `derived.recipe.regenerate`,
  `derived.recipe.regenerate_batch`, `derived.recipe.detach`, and `derived.recipe.relink`. Mesh, Draw, Civil,
  Raster, and BIM UI/console adapters must dispatch these ids rather than register semantically duplicate
  domain transitions (MT-D25).
- Hull/solid: `mesh.hull.preview`, `mesh.hull.create`, `mesh.solid.preview`, `mesh.solid.check`, and
  `mesh.solid.create`. Large result/error lists use the shared paged query and UIP-D10 job status/cancel contracts.
- Reserved and uncallable until promotion: `mesh.from_cloud`, `mesh.texture.apply`, `mesh.texture.bake`.

Expanded exact console aliases: `mesh draft list`, `mesh draft new`, `mesh draft show <id>`,
`mesh draft history <id>`, `mesh draft undo <id>`, `mesh draft redo <id>`, `mesh draft suspend <id>`,
`mesh draft resume <id>`, `mesh draft discard <id>`, `mesh surface check <id>`, `mesh surface create <id>`,
`mesh terrain edit <surface-id>`, `mesh 3d edit <surface-id>`, `mesh surface rebuild <surface-id>` (console adapter to
`derived.recipe.regenerate`),
`mesh contours generate <surface-id>`, `mesh contours regenerate <group-id>` (console adapter to
`derived.recipe.regenerate`), `mesh volume compute`,
`mesh volume save`, `mesh volume list`, `mesh display set`, `mesh simplify`, `mesh hull create`, and
`mesh solid create`. CSV export deliberately uses File's
`export plan --entity <report-id> --format hcad.volume-report.csv@1` then `export execute <plan-id>`; Mesh defines no export
alias. Deferred rows have no console alias.

VD-D6/VD-D8 now carry the polymorphic upper-layer type and remain its state
owner; Mesh contributes compatible values but no second View control. Raster's
Grid ramp/hillshade path fans into this spec's lower-layer `mesh.display` row.

Not cataloged, recorded: control sections, slope-class plans as analysis overlays beyond the display mode, and drop-flow
analysis (deferred, dispositions below); LandXML surface import/export needs no row — it exists and is File-domain I/O
(`crates/himmelcad-io/src/landxml.rs:961-1052` import, `:2216-2310` complete points/faces/breakline writer, registered in
`crates/himmelcad-io/src/lib.rs:132-134`).

### 1.3 Dossier catalog dispositions

Per the contract's per-row rule, every row of the primary evidence sections. rib-civil.md §2.6 (DGM / terrain):

| Dossier row (rib-civil.md §2.6)                                                                                           | Disposition                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Punktdatenbank (selective point loading)                                                                                  | other domain — points are canonical entities managed by import/File and the entity tree; selective loading is superseded by the always-loaded canonical store + streaming (ADR 0003/0016 architecture); the _selection_ half survives as the window's captured input set (MT-D2)                                                                                                                       |
| Zwangslinien: Bruchlinienzug, Randlinienzug                                                                               | adopted only for **Breakline**, **Outer boundary**, and **Hole** — drafted curves receive those roles without conversion (MT-D5/MT-D26; draw.md:523 consumption contract). RIB makes constraint edges hard and documents no Form-line role. **Form line** is therefore the owner-derived S10 soft height-control role in MT-D26, not attributed to RIB.                                                |
| Vermaschung (modes: check only / no check / with error display / with correction; max edge length; named layer + horizon) | adopted — §2.1: check and mesh phases with the same parameter set, max-edge-length for the auto outer boundary, error display always on; "no check" rejected (X1 — silent bad data); auto-correction becomes reviewable proposed fixes (MT-D3)                                                                                                                                                         |
| Datenfehleranzeige (error list; per error Info + zoom-to-error; INFO.LST)                                                 | adopted — the window's error list with jump-to-error is the flagship surface (§2.1, MT-D3; rib-civil.md §4 lesson 3 "error lists must jump to the error location"); the file-log half becomes console entries                                                                                                                                                                                          |
| Höhenlinien (two simultaneous intervals, distinct specs, min/max report, label by click)                                  | adopted at contract level — §3.3, MT-D7 (dual interval, distinct styles, min/max report); label-by-click queued with annotation styling (needs Draw label styling, draw.md §3.4 class)                                                                                                                                                                                                                 |
| Kontrollschnitt (ad-hoc section between two points, exaggeration)                                                         | deferred with reason — an exaggerated profile _chart_ needs the profile-window infrastructure the civil subsystem owns (DR-D8 class); non-exaggerated cutting is covered by View section planes (view-domain.md §2.1) today. Queued to the civil subsystem                                                                                                                                             |
| Neigungsplan (triangles colored by slope class)                                                                           | adopted — as the **slope-classes** variant of the Abstract display mode (§2.4, MT-D6), user-defined ranges + colors as in the reference                                                                                                                                                                                                                                                                |
| Regen / Fließverfolgung (drop-flow tracing)                                                                               | deferred with reason — drainage analysis is a distinct analysis family with no consumer workflow specified yet; queued behind volumes/contours (completion discipline, `docs/CURRENT-DIRECTION.md`)                                                                                                                                                                                                    |
| Mehrere Horizonte / Bodenschichtmodelle                                                                                   | split and revised for batch 2 — multiple terrain horizons remain named `hcad.elevation-surface@1` entities; BIM BS-D25 owns authoritative observed borehole/interface/stratum semantics, Mesh MT-D30 owns checked solid interpolation/publication, and MT-D8/MT-D20 retain auditable numeric volume. Numeric horizon codes are not product truth; office codes/specifications remain editable P7 data. |
| Punktwolke app (profiles from clouds, breakline finder, digitizing, difference models, DGM triangulation)                 | split — profiles/digitizing and clouds remain Pointcloud/Draw hand-offs; **cloud → DGM triangulation** is adopted here (§2.1). Breakline finding is a Pointcloud producer whose output arrives as Draw curves consumed here. Difference/twin-surface inspection remains solely Pointcloud PC-D10; neither is in MT-D14                                                                                 |
| Volumen (quantity between horizons, prism method, accounting polygons)                                                    | adopted — §2.3/§3.5, MT-D8/MT-D20: surface-to-surface and surface-to-horizontal-plane-at-project-Z, prism overlay, optional boundary; the Pointcloud spec hands volume computation to Mesh, cited                                                                                                                                                                                                      |

realworks.md §2.8 (modeling, mesh, drawing deliverables):

| Dossier row (realworks.md §2.8)                                                                                    | Disposition                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mesh Creation / Editing (meshes from clouds incl. watertight; hole filling; Add Triangles; Move Mesh)              | split, with no translated-away operations — arbitrary cloud→3D mesh stays cataloged at §3.4; DGM cloud input is §2.1; Surface3d **Add triangle / Remove triangles / Fill hole** ship in `mesh.edit-3d` (§2.2, MT-D22); Tin hole filling ships in `mesh.edit-terrain`; Move Mesh is Select/Edit SE-D3/SE-D11 placement and is cited, not re-owned |
| Contouring                                                                                                         | adopted — §3.3 (the dossier row reads "contours from surfaces"; generation is a surface derivative and lands here; realworks.md §5 maps _cloud-referenced drafting_ contours to Draw — no conflict, Draw catalogs no contour tool (checked draw.md §1-§2), so the registry has one owner)                                                        |
| Profile & Cross section / Easy Profile / Profile Matcher                                                           | other domain — profile extraction from clouds is Draw (pointcloud.md §1 handoff, cited); cross-section _series_ along alignments are the civil subsystem (DR-D8)                                                                                                                                                                                 |
| Basic geometry fitting (planes, cylinders, spheres)                                                                | deferred with reason — fitted primitives are modeled solids feeding BIM handoff, the same family as the dossier's pipe/steel rows which map to BIM (realworks.md §5); the dossier's Mesh-tab hint for fitting is deviated from deliberately: a fitting tool without the BIM object model has no consumer. Queued to the BIM/modeling follow-up   |
| EasyPipe / Create Pipe / Cable Tray; Steel Beam / Steel Catalog; Auto-Extract Cylinders                            | other domain — BIM (realworks.md §5 mapping; bim-specs spec owns the object model)                                                                                                                                                                                                                                                               |
| Ortho-Projection / Multi Ortho Projection; Convert to Ortho-Image / rectification / matching / RealColor; Key plan | other domain — Pointcloud input + Raster output (PC-D9, cited)                                                                                                                                                                                                                                                                                   |

realworks.md §2.7 volume row ("Volume calculation — volumes from clouds/surfaces") — adopted here per the Pointcloud spec's
explicit handoff (see rib-civil Volumen row above). Volumes from _clouds_ run through a surface: mesh the region first (W7
order: mesh, then volume — realworks.md §3 W7 step 3), never a direct cloud integral (MT-D8).

Raster hand-offs are cite-and-revise adoptions, not new dispositions:

| Raster record                                       | Mesh-side arrival contract                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RA-D5 — hillshade and ramps do not alter height     | Adopted for ElevationSurface Grid in `mesh.display`: explicit ramp min/max; hillshade Off / View light / Fixed with typed azimuth and altitude; NoData remains uncolored and never becomes a low height. Raster may expose a contextual accelerator, but `mesh.set_display` and MT-D6 own the values.                                                            |
| RA-D7 — Grid→Tin command in Raster, product in Mesh | Adopted: `raster.to_dgm` creates an ordinary editable ElevationSurface Tin with exact source revision, placement, retained spacing, holes from NoData/excluded cells, and captured P4 scope. It immediately receives MT-D3/MT-D5 validation, `mesh.edit-terrain`, MT-D6 display, MT-D12 snapping, contours, volume, simplification, and LandXML/export behavior. |

Dossier-wide absence checks backing this spec's absence claims (contract A2 rule): neither dossier documents mesh _texture
authoring_, mesh _simplification/decimation_, or mesh _visual styles_ (realistic/abstract/wireframe) — checked against the
whole of realworks.md and rib-civil.md, not named sections; trimble-perspective.md §2.2 display modes are point-cloud-only
and revit.md contains no mesh rows (checked). Display modes therefore derive from owner statement 2026-09-01 and the VD-D8
class, not from a reference claim; simplification derives from X2; texture authoring is deferred partly _because_ the
reference evidence is a recorded dossier gap (MT-D11/MT-D13).

For batch 2, the same dossier-wide check records an absence: RIB Civil and RealWorks do not specify a common linked-recipe
lifecycle, the S10 Form-line soft topology, PC-D17 grid-mean cloud sides, the mathematical 2D/3D convex-hull contract,
separately specified Cut/Fill solid publication, or borehole-interface interpolation. RIB W5 remains evidence only for the
Breakline/boundary check-and-fix posture; RealWorks W7 remains evidence only for sample → mesh → volume ordering. The
batch-2 additions derive from S10/S11/S14, GAP-D7/GAP-D8, P9/P10, and the cited sibling records. Trimble Perspective's
Selectable/Visible/Off access state and RealWorks' product-specific picking aids are not P9 or generic cursor evidence;
Mesh consumes SE-D19/UIP-D20 and UIP-D16 instead of reinterpreting those dossiers.

## 2. Workflow narratives

### 2.1 Creating a DGM from points, breaklines, and clouds — the surface window

The user has imported a survey: a few thousand `hcad.point@1` points and, per draw.md §3.3, has traced breaklines (curb tops,
embankment edges) and a closed outer-boundary polyline as ordinary curves with heights. They select the points, the
breaklines, and the boundary — tree range-select or viewport fence, the platform's normal selection — and press **Mesh →
Create surface…** (or right-click the selection → "Create surface from selection…"). At launch Builder captures the visible
subset of that selection: explicit entity/class visibility and active clip volumes exclude geometry; natural occlusion does
not (P4). Excluded selected entities remain listed with the reason, so the visible-set rule never silently prunes survey
inputs. A **dedicated resizable window** opens (owner statement 2026-09-01; contract B3 names surface creation as this
surface class verbatim). The main viewport stays fully interactive behind it — the window arms no viewport tool and claims no
viewport gesture (§3.8).

The window has three regions: a **canvas** (2.5D plan view of exactly the captured inputs, with a 3D toggle), an **input
list** (every captured entity with its role: Points, Breakline, Form line, Outer boundary, Hole — roles are pre-guessed: open curves →
breakline, the closed curve containing the points → outer boundary, other closed curves → hole; every guess is editable per
row), and a **parameter + error strip** (surface name defaulting "Surface 1", max edge length for the auto outer boundary
when none is assigned — typed, project units — and the Check / Mesh buttons). The captured set is fixed at launch: changing
the main-viewport selection changes nothing here (C2, MT-D2). "Add from selection" and per-row remove adjust the set
explicitly (X5 pair).

If the captured input includes `hcad.point-cloud@1`, the cloud appears as one row with Spatial step, Existing point nearest
cell mean Z, and Synthetic cell center at mean Z (PC-D17), including typed cell size and result/resource estimate; checking
and triangulation stream only its P4-visible points into a bounded working set (realworks.md §3 W7 begins with segment/sample; X2).
This parameter edits no cloud and does not duplicate `pointcloud.sample`. A breakline vertex without an identical cloud
sample is admitted as an explicit constraint vertex and reported as a notice, not the surveyed-point error below: a cloud is
a sampled field, not a point database. Points, breaklines, and clouds may be combined in one DGM draft.

The user presses **Check**. The sidecar validates without meshing (rib-civil §2.6 Vermaschung "check only" mode) and the
**error list** fills — the window's reason to exist (owner statement 2026-09-01). Each row names the error class, the
entities involved, and carries a **jump** affordance that frames the error location in the window canvas and pulses a marker
(rib-civil.md §4 lesson 3: "error lists must jump to the error location"). The v1 error classes (MT-D3):

1.  **Breakline vertex off the point set** — a breakline vertex coincides with no input point within tolerance (rib-civil.md §3 W5
    rule "constraint-line points must belong to the horizon"; the owner's "breakline lying on points" case). Fixes offered:
    snap the vertex to the nearest point; insert the vertex position as a new point; exclude the breakline.
2.  **Crossing breaklines** — two constraint lines intersect away from a shared vertex (rib-civil.md §3 W5: "constraint lines may cross
    only in shared surveyed points"). The canvas marks the XY crossing and shows both independently evaluated elevations,
    source ids, and adjacent vertices. If an existing surveyed point supplies the shared XYZ, or both evaluations agree
    within the recorded Z tolerance, **Split both at surveyed/agreed XYZ** is a value-preserving safe fix. If they differ,
    the row has no selected default and Commit remains blocked. The explicit remedies are: **Split using elevation from…**
    with a required user-chosen line; **Interpolate elevation along…** with a required user-chosen line and the two bracketing
    vertices shown; or **Leave unresolved**. The same required line id is an automation argument and is stored in provenance.
    Exclude/reassign to another surface remains an individually reviewed role/input action for grade-separated geometry.
    The crossing fixer never offers a free guessed or silently typed Z; edit the source explicitly and Recheck when neither
    line is authoritative. These error/fix/jump conventions cite RIB Civil W5; W5 supplies no line priority, so none exists.
3.  **Duplicate XY, conflicting Z** — two input points share XY within tolerance with different heights (a Mesh validation
    class derived from X1, not attributed to W5's example field-error causes). Fixes: keep one (choice shown with both Z
    values); edit a Z (typed); exclude one.
4.  **Height-less vertex** — an input vertex has `z: null` (plan-only per ADR 0022; draw.md §3.3's stated consequence).
    Fixes: open the embedded drape/type/interpolate chooser backed by DR-D3's `draw.assign_heights` acquisition semantics; the
    default changes only the draft, while **Apply fix to source** invokes Draw's canonical command; or exclude the input.
5.  **Boundary defects** — outer boundary not closed, self-intersecting, or excluding input points; hole outside the
    boundary. Fixes: reassign roles; exclude the outlier points (listed).
6.  **Vertical/overhanging data** — inputs that would force a vertical triangle, invalid for a 2.5D surface by the data model
    (`crates/himmelcad-core/src/entity_model.rs:468` "vertical/overhanging triangles are invalid here"). Fixes as in class 3.

Fixes update a **recoverable named window draft**, not the selected source entities (MT-D2/MT-D18): split-at-crossing,
explicit source choices, inserted support points, roles, exclusions, and parameters update the constraints and error list.
Every draft has a stable id and generated editable name (`Surface draft 1`, …). A project may hold many suspended drafts; the
one window activates one at a time and serializes only that draft's compute work. **Suspend** closes the active view while
retaining it, **Resume…** selects any draft, and **Discard…** is the explicit destructive path. A second launch offers New or
Resume rather than stealing the active draft.

While a creation draft has focus, Ctrl+Z/Ctrl+Shift+Z operate only on its local fix stack: one manual fix is one step and
**Apply all safe** is one inspectable grouped step. Source commands are distinct global journal entries shown as linked
history markers; they are undone from the project undo surface, after which the draft refreshes and revalidates. Commit
collapses the final draft state into one canonical create command; after the window closes, global Ctrl+Z removes that
surface. Automation exposes draft identity, history, undo/redo, suspend/resume, and discard with the same routing.

The persisted draft itself is a small asynchronous manifest only: source ids/revisions/placements, effective scope,
parameters, fix deltas, local-history cursor, camera, job/checkpoint id, and completed content hashes. Check products, sampled
working sets, preview/canonical topology, and prepared hierarchies are immutable content-addressed staging artifacts written
only by registered jobs; canvas interaction performs zero heavy writes. Manifest writes are debounced and off the UI/render
thread. The header shows **Draft storing…** until fsync, **Draft stored** only after acknowledgement (target lag ≤ 2 s p95),
and **Draft NOT stored — <reason>** on failure; Suspend/quit then offers Retry or explicit Discard rather than claiming
recovery. An accidental close, renderer reload, sidecar crash, or app restart rehydrates the last acknowledged manifest and verified hashes;
**Discard** makes uncommitted artifacts unreachable for normal GC (MT-D17).
When a correction should also repair the survey source, **Apply fix to source** invokes the owning Draw/entity command as a
separate, immediately journaled step with its own undo; the window refreshes from the new source revision. This makes
preview/commit/discard symmetric and never changes a point or curve merely because it was used as triangulation input.

**Mesh** runs the triangulation (constrained Delaunay honoring breakline edges — the Tin variant's contract,
`crates/himmelcad-core/src/entity_model.rs:465-472`) as a cancellable UIP-D10 job with real phase/unit progress; remaining errors re-list; the canvas shows the preview
triangulation over the inputs. An **auto-remesh after fix** toggle recomputes the preview after each applied fix; for large
inputs the toggle automatically turns off when estimated work exceeds 5 s and explains **Preview updates are manual for this
input size**; the user may turn it back on (X6 tunable). RIB's "Vermaschung mit Fehlerkorrektur" (rib-civil.md §2.6) becomes
**Propose fixes**: the checker lists its resolutions as pending rows the user applies singly or **Apply all safe**. Safe means
coordinate- and membership-preserving topology normalization only: no XYZ change, source choice, exclusion, role reassignment,
or source edit. Silent auto-correction is rejected (X1; MT-D3/MT-D16).

**Commit** is enabled only after Check has no unresolved error and the topology plus prepared hierarchy artifacts are verified.
It creates the canonical `hcad.elevation-surface@1` (Tin) entity through one atomic journaled command carrying content hashes
and lightweight breakline/role/scope/provenance metadata — never vertex/index buffers (P5, MT-D17). Provenance includes source
ids, revisions, placements, all explicit crossing-authority choices, sampling parameters/count, and evaluator versions.
The window closes, the surface appears in the tree and the main viewport, the console logs vertex/triangle counts and min/max
heights (rib-civil.md §2.6 Höhenlinien reports min/max; adopted at commit time). The new surface immediately feeds the kernel terrain snap
producer (draw DR-D13 — cited; the surface side of that contract is this spec's delivery, §5) and renders through the
prepared-mesh path Builder finally wires up (§5). Ctrl+Z removes the surface and its committed draft corrections together;
any separately invoked **Apply fix to source** command remains its own earlier undo step. **Discard…** discards the named draft and
publishes no surface; the window x/Suspend retains it, making close distinct from Discard
(MT-D2).

For plausibility the user generates contours at 0.2/1.0 m (§3.3) and orbits the result — the DGM verification loop of rib-civil.md §3 W5.

### 2.2 Editing terrain and 3D meshes

A month later a re-survey adds twenty points along a corrected embankment top. The user selects the Tin, presses **Mesh →
Edit terrain surface** (or context **Edit terrain surface…**): the same window opens in **terrain mode** — canvas shows the committed
triangulation, the input list shows the recorded sources with an "Add from selection" to pull in the new points. Edit
operations commit through journaled commands; local changes preview immediately and larger re-triangulations become jobs:

- **Add point / remove point** — insert an input point into the triangulation (local re-triangulation honoring breaklines) or
  remove one (hole re-closed). Numeric twin: typed XYZ for add (C1).
- **Swap edge** — click a shared edge of two triangles to flip the diagonal; refused with a reason where the flip would
  violate a breakline or 2.5D validity (no numeric twin — a topological pick; recorded n/a with reason, C1).
- **Boundary and holes** — assign a different closed curve as outer boundary; add or remove a hole (building footprint);
  re-triangulates the affected region.
- **Fill hole** — choose one closed Tin boundary loop and triangulate it subject to the same breakline and 2.5D checks; the
  original hole remains until the preview passes and the atomic edit commits.
- **Breakline add/remove** — pull another drafted curve in as a breakline (checked through the §2.1 error classes first) or
  release one.

Edit mode has no unpublished multi-fix draft: each operation previews, then **Apply** commits one canonical command. Its
Ctrl+Z/Ctrl+Shift+Z therefore route to project undo/redo; an uncommitted operation preview is cancelled by Escape first.

Each committed edit bumps the surface revision; contours and saved volume reports referencing the surface show a **stale**
marker (§3.3, §3.5 — MT-D7 assigns an automatic budget of zero, so regeneration is explicit). Escape inside the window follows the inner rungs only (field
revert → armed fix/edit tool cancel); it never closes the window (MT-D1 — the window is workspace-class per UIP-D14, closed
by its x or the launcher toggle; an error-fixing session is data-loss-adjacent). Grid-variant surfaces do not pretend to be
editable: the properties/context surface explains **Convert to editable Tin…** and routes to Raster-owned `raster.to_dgm`
under RA-D7. The arriving Tin is an ordinary `mesh.edit-terrain` target.

For an arbitrary `hcad.surface-3d@1`, **Mesh → Edit 3D mesh…** opens the same window in **3D repair mode**, with exactly three
v1 operations adopted from RealWorks' repair loop: **Add triangle** between three existing boundary vertices, **Remove
triangles**, and **Fill hole** for one selected boundary loop. Inline or resource-backed inputs produce a staged immutable
replacement; Commit atomically swaps the geometry hash as one journaled edit. Untouched normals, materials, triangle slots,
and per-corner UVs retain their exact indices. On a single-material region with no UV seam, a new patch inherits that material
and existing boundary-corner UVs. A
patch whose boundary crosses a material or UV seam, has incompatible corner UVs, self-intersects, or would change the declared
manifold classification inconsistently is refused with the exact reason; v1 does not invent a material or UV projection. Fill
may change `closed_manifold` only when full validation proves the last open boundary was closed. Removing the last triangle is
refused; one triangle is the least valid editable member, and a one-loop/one-cell hole is the least fill member.
Resource-backed meshes rewrite only affected partitions plus ancestry into new content-addressed artifacts under MT-D17's
memory/disk/cancel contract. This is MT-D22; texture authoring remains MT-D13 and is not smuggled into repair.

### 2.3 Volumes

The user has "Ground 2025" (existing terrain) and "Platform design" (imported LandXML design surface) and needs cut/fill.
**Mesh → Volume…** opens the right function panel. **Base** and **Compare** accept named ElevationSurface entities, or Compare
may be **Horizontal plane at project Z** with a typed elevation and project unit. The panel always shows the project horizontal
CRS and vertical CRS; when no vertical CRS is configured it shows **Vertical CRS not set — project Z only** and never calls the
number a geodetic datum. Two operands explicitly recorded in the same project-local Z may compute under that warning. Any
operand claiming another vertical reference must resolve into the project's horizontal/vertical reference through a recorded
transform; missing, incompatible, or unresolved references block Compute with the exact source list. No offset or datum
transformation is guessed.

An optional existing closed curve bounds the accounting region (rib-civil §2.6). Compute captures
`common valid footprint ∩ accounting polygon (if any) ∩ P4-visible scope`; holes, Grid NoData cells, cells outside either
surface, and explicitly hidden/clipped geometry are excluded and their horizontal area is reported by reason. Natural
occlusion is ignored. Let `d = Compare Z - Base Z`: **fill** is the positive integral of `d`, **cut** is the positive integral
of `-d`, and **net = fill - cut**. A horizontal plane participates as the chosen Base or Compare operand under the same sign
rule, shown before Compute.

The method is versioned `hcad.volume.prism-overlay@1`: represent Tin faces directly; split each valid Grid cell along its
recorded deterministic diagonal; robustly overlay both piecewise-linear triangulations and the boundary in XY; evaluate both
Z fields at every overlay vertex in f64; and integrate the linear difference exactly per overlay triangle as triangular
prisms. Outward-rounded interval arithmetic encloses evaluation, clipping, and compensated accumulation error. The user types
**Maximum numerical error** in volume units; completion requires the reported interval half-width to be no larger, otherwise
the job fails without a savable result and explains how to tighten geometry/tolerance. This numerical bound describes only
computation. Every panel result and export states: **Computational tolerance is not source or survey accuracy.** Source
accuracy is reported only when present in source metadata, never inferred.

Compute is a cancellable registered job and journals nothing. Its result reports cut, fill, net, evaluated area, excluded
area by reason, interval error bound and requested tolerance. **Save report** creates immutable canonical
`hcad.volume-report@1` with name; both surface ids, geometry revisions and placement/version hashes; any detached source
revisions; captured scope and boundary id/revision/placement; method/version; project units and horizontal/vertical CRS state;
tolerance and error bound; evaluated/excluded areas; cut/fill/net; source accuracy metadata verbatim; and stale reason. It is
listable by automation and appears under Reports. Geometry, placement, IF-D4 update/removal, boundary, scope-reference, or CRS
change marks it stale without changing its numbers.

The workflow includes a deliverable: Reports context **Export…** opens File-owned Export (FP-D5/FP-D6) with this report
preselected and `hcad.volume-report.csv@1`. The UTF-8 CSV has one header row and one data row per report, using invariant decimal
points and explicit unit/CRS/method/tolerance/error/excluded-area/stale columns; stale export is blocked unless File's plan
shows a named stale-report warning that the user explicitly accepts. `io.export.plan/execute` owns review, path, atomic write,
progress, and loss consent. Promoting this adapter from FP-D14's generic list/report queue was a cross-spec request in §8;
FP-D5/FP-D6 now register it without creating a second export surface (MT-D20).

### 2.4 Display modes

The current View-owned VD-D8 Decision is adopted verbatim:

> Display resolves in two layers. **Below:** per-entity canonical display styles — color source, mode parameters, palette ref,
> per-entity point size — journaled, automation-visible, owned by the Pointcloud spec exactly as PC-D11 specifies (and by
> Mesh/BIM for their entities); **unchanged by this spec**. **Above:** un-journaled, project-persisted view presentation
> (VD-D5/VD-D6) with a **Color mode override** defaulting to **Follow entity display**; when set, it overrides every
> point-cloud entity's color source at render time without touching canonical state. The View tab's color-mode control _is_
> this override — revising PC-D11's clause that made it an accelerator issuing scene-wide canonical edits (scene-wide
> canonical recolor remains available through the Pointcloud multi-select path, PC-D12/PC-D13). **Point size** adopts PC-D11
> verbatim: per-entity canonical size (Auto default) × view-local unitless multiplier, default 1.0. The override is captured
> by bookmarks; the multiplier is **not** (explicitly decided: the multiplier compensates workstation display density —
> comfort, like theme — and capturing it would fight per-screen tuning; the override expresses view intent, which is what a
> bookmark names). Per-entity opacity/exaggeration/visibility stay canonical below; today's `view.opacity`/
> `view.exaggeration` console commands (`App.tsx:650–665`) migrate to Pointcloud canonical commands.

Accordingly, Mesh defines only its lower-layer values here. View owns upper-layer enum, applicability, bookmark capture,
persistence, and undo; Mesh ships no upper-layer control until VD-D6/VD-D8 are amended by their owner.

The selected Mesh entity's Properties **Display** group offers canonical mode **Realistic**, **Abstract**, or **Wireframe**,
plus **Shaded + edges**. Realistic uses source materials only when the admitted dataset actually supplies them, otherwise a
lit neutral material. Abstract provides uniform color; ElevationSurface additionally provides elevation ramp and user-defined
slope classes. ElevationSurface Grid also provides RA-D5 hillshade Off / View light / Fixed; Fixed has typed azimuth and
altitude, ramp min/max are explicit, and NoData is transparent/uncolored rather than a low value. Wireframe shows triangle
edges without changing silhouette or geometry. Breakline overlay visibility is another canonical per-entity field.

Multi-select follows UIP-D17: Mixed values and one all-or-none journaled assignment. `mesh.set_display` carries the identical
payload. Mode changes are bounded and require no re-preparation; if a provider/admission lacks materials, Realistic's neutral
fallback is reported in Properties. Current IFC and DXF providers create untextured Surface3d storage
(`crates/himmelcad-io/src/ifc_provider.rs:672-685`; `crates/himmelcad-io/src/dxf_provider.rs:1300-1331`). SLPK can carry a
textured prepared GLB through its provider/decoder test (`crates/himmelcad-io/src/slpk_provider.rs:784-870,1711-1760`), but a
first-party Builder admission-to-frame consumer is unverified and therefore not claimed complete (MT-D13).

## 3. Function contract answers by group

### 3.1 Surface creation and editing (`mesh.create-surface`, `mesh.edit-terrain`, `mesh.edit-3d`, shared `derived.recipe-manage`)

**A1.** §2.1–§2.2 in full.

**A2.** rib-civil.md §2.6 + §3 W5 is the reference workflow, adopted: constraint-line roles, meshing modes collapsed to
check/mesh with errors always surfaced, max edge length, the error list with jump-to-error, the two W5 constraint rules as
error classes 1–2, fix-and-remesh as the loop (dispositions §1.3). Deviations, each reasoned: no silent "no check" mode (X1);
auto-correction demoted to reviewable proposals (X1, MT-D3); horizon numbers replaced by named entities (§1.3 row).
realworks.md §2.8 contributes the 3D repair ops under their own honest Surface3d row (Add triangle / Remove triangles / Fill
hole, MT-D22); Move Mesh is cited to Select/Edit SE-D3/SE-D11 rather than re-owned. The dedicated-window surface choice matches rib's own precedent — its DGM/QP work happens in dedicated
windows (rib-civil.md §5 Mesh mapping: "The dedicated-window surface choice (B3) matches STRATIS's QP-Generator/profile
windows") — and owner statement 2026-09-01 fixes it.

**A3.** Nearest relatives, semantics verified: Builder import's island stages, previews, cancels, and commits a reviewed
candidate (`apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:269-371,373-412`), and its project adapter accepts
the committed journal entry atomically (`apps/builder/renderer/src/project.ts:181-184`). The Mesh window reuses that
review-before-commit posture and shared controls, not its source-specific lifecycle or component wholesale. **Draw's** vertex editing and `draw.assign_heights` are the fix-tool siblings: fixes
here compose the same canonical curve/point edits (draw.md §3.3; the registry treats surface-local
`mesh.surface.draft.apply_fix` and explicit source-edit commands as distinct intents — no act double-claimed, §3.8).
**Pointcloud extraction** (PC-D7) is the immutable-product sibling, not the dependency contract: both preserve a completed
artifact, but extraction intentionally stops at provenance while P10/MT-D25 adds an indexed live recipe to derived Mesh
products. The baked product is always the last successful regeneration and may remain visible only with its recipe state
shown. The **plan composer** is the other dedicated-window occupant per contract B3; no shared code claim is made for it.

**B1.** Exact ribbon/context/console/automation mappings are the catalog rows in §1.2. The window is UI over those commands:
an agent can list/create/resume/suspend/discard a named draft, inspect and undo its history, check/read errors, apply the same
fix with every authority argument, explicitly invoke the owning source command, and commit headless. Viewport quick surface:
no entry — surface creation needs a selection, and the quick surface is for
void-relevant commands (UIP-D13, recorded). Keyboard shortcut: none recommended — no reference binds one (rib uses menus,
realworks unbound here; checked both dossiers) and the registry owns the map (VB-D9 class, recorded absent).

**B2.** The window x, ribbon re-toggle, and **Suspend** all retain the active named draft and close the window; **Resume…**
reopens any draft. **Discard…** alone deletes one draft after naming it; Commit is the publication path. Escape never closes
the workspace-class window (MT-D1/UIP-D14). The former ambiguous Cancel label is replaced by **Discard…**.

**C1.** Every parameter is typed: max edge length, name, tolerances, non-crossing Z edits, add-point XYZ; units/precision from
project settings. Crossing rows always show both evaluated Z values and require an explicit line id for either non-agreeing
split remedy; default is none (§2.1, MT-D16). Canvas picks (jump targets, swap-edge, vertices) are topological choices, not
numeric values; ids are exposed to automation and all produced coordinates are displayed before apply.

**C2.** Operates on a **pre-selected set captured at launch** (owner statement 2026-09-01); later selection changes never
mutate the captured set; "Add from selection" / per-row remove are the explicit set editors (§2.1). P4 filters each
capture/add act to explicitly visible and clipped-in geometry; excluded rows show why, and natural occlusion is ignored.
Eligible creation kinds: `hcad.point@1`, `hcad.curve@1`, `hcad.point-cloud@1` (§3.4); edit targets split exactly by type in §2.2. Ineligible selected entities are listed grayed
with the reason, not silently dropped (an omission is a decision the user sees). Edit mode captures the surface plus its
recorded sources. Admission additionally calls SE-D19's sole effective-state resolver: Hidden and Inert are ineligible;
Reference and Editable may be immutable inputs; only Editable may receive a separately confirmed source-edit command. UI
and automation record the resolver's causes and recheck them at Check and publication. A mid-draft state change retains the
row and last-good preview but marks it **Ineligible — <cause>** and blocks publication until restored or removed (MT-D26).

**C3.** The committed surface geometry **is** the bake: it is the immutable product of the last successful MT-D25
regeneration and ships to render as a prepared mesh hierarchy and to snapping as an index. Its recipe remains live; source
change can regenerate within the owning budget or leave the baked product visibly **Stale**, never silently current. In-window, the
freezable state is the **preview**: auto-remesh-after-fix off = manual remesh (§2.1); it turns off automatically above the
5 s estimated-work threshold rather than relying on memory. The sampled working set and completed partitions are explicit
bakes, with chosen sample spacing/count reported.

**C4.** Canonical create/edit/regenerate and explicit source edits are journaled. Named drafts are project-persisted manifests
with a local undo/redo stack, never canonical journal entries (MT-D18). Commit is one canonical command; Discard deletes only
that draft. Regenerate replaces local geometry/provenance from captured current source id+revision+placement tuples and preserves
the surface's own placement, name, exactly-one-layer membership (DR-D4), style, and edit lock. It never edits sources or
dependent contours/reports; those go stale. These exemptions are safe because they are independently owned user state. This
adopts SE-D3/SE-D11: transform changes placement, not buffers, and stale expected revisions reject the whole publication.
The complete recipe/output restore set, including heavy-artifact roots and multi-output replacement, is MT-D25/MT-D32.

**D1.** Canvas navigation is continuous (G-MT-1). Check, mesh, regenerate, contour, volume, simplify, resource-backed repair,
role/exclusion/crop checks, hulls, Cut/Fill overlay, and strata interpolation
are UIP-D10 jobs. Fix-state apply updates the constraint/error state within one presented frame; triangulation may remain stale
and rebuild asynchronously. Commit is bounded because verified topology and prepared hierarchy already exist by hash; it
journals only refs/metadata. Multi-minute work follows MT-D17: deterministic partition checkpoints, paused-after-restart
resume, bounded cancellation, and explicit peak resources/completion. MT-D31 extends the budgets and partition keys to every
batch-2 class. G-MT-5 is the surface extreme-member gate; the named batch-2 gates remain explicitly unverified until their
in-repo launchers exist.

**D2.** Window canvas degrades preview fidelity first (input point decimation for display only, marked in the canvas), never
input responsiveness or the error list's correctness; the committed surface degrades through the existing LOD selector
(`crates/himmelcad-render/src/tile_selector.rs:1`) like any mesh. Checks and meshing are correctness paths and never degrade — they get slower, with
progress (X1).

**E1.** §7 criteria 1–4.

**E2.** Consumers of a surface entity and of its edits:

| Consumer                                     | Effect                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mesh render pass                             | new/updated prepared hierarchy; under a locked viewing box meshes keep the six clip planes (viewing-box VB-D3 — cited)                                                                                                                                                                                                                                |
| Terrain snap producer (Draw DR-D13 ↔ MT-D12) | surface registers on commit; edits/placement invalidate world indexes. Rust builds the BVH (`crates/himmelcad-render/src/mesh_picking.rs:229-285`), performs bounded ray queries (`:345-424`), refines surface/edge/vertex candidates (`:496-562,593-630`), and tests exact transformed results (`:1807-1856,1858-1933`); legacy TS stubs remain dead |
| Picking/selection                            | surfaces are pickable entities (ui-platform UIP-D15 "mesh, CAD/IFC… are pickable" — cited); P4 scopes picks to the visible set                                                                                                                                                                                                                        |
| Draw drape / assign-heights                  | consumes current surface revision; a drape mid-rebuild reads the pre-rebuild revision until the rebuild commits (journal serialization)                                                                                                                                                                                                               |
| Contours / volume reports                    | keyed to geometry revision plus placement/version hash, scope and other dependencies; named stale reasons on every trigger; common-recipe automatic budget is zero (MT-D7/MT-D21/MT-D25)                                                                                                                                                              |
| Section planes (view domain)                 | cut the surface via the existing product (`crates/himmelcad-render/src/section.rs:776-780`); Grid is rejected today (`:683-686`) and §5 closes the gap; placement change invalidates world-space products                                                                                                                                             |
| Exporters                                    | LandXML writes inline, unplaced Tin points/faces and 3D breaklines (`crates/himmelcad-io/src/landxml.rs:2216-2310`); File exports contours and `hcad.volume-report.csv@1` under explicit plan/loss/stale review                                                                                                                                       |
| Plan composer / file export                  | consume canonical surface and contour entities plus their resolved presentation; active viewport clipping is ignored unless an explicit scoped export command records it (P4 export exception)                                                                                                                                                        |
| PhotoLab / WeltView                          | consume the shared prepared-mesh/render path only; they gain no Builder commands, and renderer/style work must preserve their current dataset admission and visual behavior                                                                                                                                                                           |
| Viewing-box lock bake                        | unaffected — bake is point-pass-scoped (VB-D3)                                                                                                                                                                                                                                                                                                        |
| Automation                                   | full command parity (B1); `mesh.surface.check` returns the same error rows the window shows                                                                                                                                                                                                                                                           |
| Entity tree / properties                     | kind label exists (`apps/builder/renderer/src/projectProjection.ts:76-79`); gains display group and provenance section                                                                                                                                                                                                                                |

MT-D32 and the batch-2 E2 matrix in §10.7 extend this table for the shared recipe, both hull outputs, separate Cut/Fill
solids, and per-stratum solids. Unsupported passive consumption is an explicit refusal; no new product may disappear merely
because an older renderer/exporter/Plan/Measure path does not recognize it.

Every draft, committed surface, contour group, and volume report records indexed reverse relations discoverable by IF-D4.
A matched in-place source update cancels or supersedes affected in-flight work, retains the last completed preview marked
**Preview stale**, and requires Recheck before Commit. A removed source shows **Source removed** and blocks Commit until the
user removes it, maps a replacement, or chooses **Keep captured revision as detached snapshot**; the latter retains the
immutable source artifact/hash and records detachment in provenance. IF-D4's default is Keep as local for a referenced
removal—never silent input deletion. Rebuild with missing sources fails with the exact list and leaves the current surface
unchanged. Undo of the import update restores relations and revalidates. Every job publishes against project id, draft id, and
expected revisions; a late result for a replaced project/source is rejected and left unreachable.

Canonical commands serialize through journal/CAS; many named drafts may exist, one draft is active in the window, and only
incompatible compute against the same draft is serialized. Independent contour/volume jobs may run from immutable captured
revisions. On any accepted SE-D3 surface placement change, render may update the transform without retriangulation, while
world-space pick/section caches invalidate and contours/reports become stale. Transform preview uses the shared gizmo and
never remeshes. Crash/restart behavior is MT-D17, not an on-demand-from-zero promise.

Class extremes: **largest** is the 500M-logical-point streamed hierarchy in G-MT-5; the UI reports selected sample spacing and
count and says the DGM represents the sampled input, never full-cloud accuracy. **Least** includes a three-point/one-triangle
Tin; a Grid arrives through RA-D7 then converts to an editable Tin; a one-triangle Surface3d can be edited but not emptied;
and a one-cell hole can be filled subject to MT-D22.

**E3.** §6; unverified items listed there.

### 3.2 Display modes (`mesh.display`)

**A1.** §2.4. **A2.** No dossier documents mesh visual styles (dossier-wide absence check, §1.3) — the modes derive from
owner statement 2026-09-01; the slope-classes variant adopts rib Neigungsplan (§1.3 row). **A3.** The point-cloud display
group is the pattern sibling (PC-D11 — canonical per-entity style behind `SetStyleRef`, verified against pointcloud.md
§1/PC-D11; mesh styles ride the same mechanism with a mesh display-style resource kind, §5). **B1.** Properties panel group;
context **Display properties**; console `mesh display set`; `mesh.set_display` for canonical entity style. No upper-layer
accelerator ships until View owns and registers its polymorphic contract (§8).
**B2.** n/a — panel group/dropdown, no lifecycle beyond the panel's. **C1.** Slope-class ranges and colors, ramp bounds,
uniform color: all typed/pickable; mode itself is an enum control. **C2.** Selection-driven; multi-select per UIP-D17
(cited). **C3.** n/a — mode switch is bounded; nothing live to freeze. **C4.** Canonical journaled per-entity style (VD-D8
below layer); undo restores the previous style — defensible: restyling an entity is a deliberate act (P1 class). View owns
the upper layer unchanged by this spec. **D1.** Mode switch bounded — gate **G-MT-4**; the
prepared dataset carries positions+normals+UVs so no mode requires re-preparation (X2; wireframe renders from the same
hierarchy via edge/barycentric technique chosen at implementation — the _budget_ is the spec, the technique is not). **D2.**
Ramps/edges degrade with LOD like the mesh itself; color classification correctness never degrades at rest. **E1.** §7
criterion 5. **E2.** Consumers: render passes (per-entity material selection — the lit/flat split exists,
`crates/himmelcad-render/src/gpu_frame.rs:4604,4625`), bookmarks (capture only whatever upper layer VD-D8 owns; mesh canonical styles are below and
uncaptured by design), exporters (canonical geometry, never restyled — display modes do not leak into deliverables, X1),
automation renders (canonical styles apply; agents see what the mode shows). Extremes: largest — the 4.2M-triangle scene
(G-MT-2 rides `packages/@himmelcad/viewer/test/scale/viewer-scale-gate.mjs:69,356,405`); least typical — a constant-height
Grid with NoData and neutral hillshade, and an untextured IFC/DXF Surface3d whose Realistic mode honestly uses neutral lit
material. Textured SLPK Builder rendering remains explicitly unverified. **E3.** §6.

### 3.3 Contours (`mesh.contours`) — contract level

**A1.** The user selects a visible elevation surface, opens **Contours…**, types major/minor intervals, chooses an explicit
output layer and distinct major/minor style refs, reviews min/max elevation and P4 scope, then presses **Generate**. Builder
creates one named `hcad.group@1` of `hcad.curve@1` contours; every child has exactly the chosen layer (assignment replaces;
Default only when explicitly chosen, DR-D4) and the appropriate major/minor style ref. Later **Regenerate** atomically refreshes a stale group with its recorded
settings. **A2.** This adopts two simultaneous intervals, distinct line/ label specifications, and min/max reporting from
rib-civil.md §2.6 Höhenlinien, and surface contour generation from realworks.md §2.8; linear smoothing ships first, while
smoothed contours and click-labeling remain MT-D14. **A3.** Outputs are ordinary Draw curves: Draw snapping, styling, layer,
and export semantics apply without a mesh-only reader.

**B1.** Mesh ▸ Analyze ▸ Contours…; surface context menu; console `mesh contours generate` and the familiar
`mesh contours regenerate` adapter; creation uses `mesh.contours.generate` and regeneration uses common
`derived.recipe.regenerate`. No quick-surface or
shortcut (not void-relevant; no dossier binding). **B2/B3.** A closeable right function panel; closing leaves a registered
job running and posts its result to the jobs surface. **C1.** Both positive intervals and style/layer identifiers are
typed/selectable and carried in automation. **C2.** Launch may seed the surface; **Use selection** replaces it explicitly.
Generate captures surface id, geometry revision and placement/version hash, intervals, explicit layer/style refs, min/max,
scope references/geometry, and generator version; later selection changes do nothing. **C3.** No live preview to freeze.
**C4.** Group and provenance are canonical/journaled (P1); undo removes the whole group. Regeneration is one atomic replace
of generated children/provenance and preserves unrelated group name, owner, and the user's current layer/style choices unless
the user explicitly changes them. Missing/deleted layer or style blocks regeneration until mapped; it never silently selects
Default.

**D1.** Bounded→long by triangle count; real progress/cancel via UIP-D10/UIP-D11, no partial group. **D2.** Correct topology
and interval placement never degrade; weak hardware takes longer. **E1.** §7 criterion 7. **E2.** Render, Draw
snap/pick, layers/styles, exporters, tree/properties, stale tracker, and automation consume the curves/provenance. Active
clips and explicit visibility bound generated geometry under P4; natural occlusion does not. Grid surfaces contour through
`RasterConnectivity` sampling (`crates/himmelcad-core/src/entity_model.rs:617-646`); a flat surface returns a successful empty
result with explicit copy. Surface geometry or placement change, IF-D4 source update/removal, output layer/style deletion,
or scope-reference loss sets a named stale reason. File-owned DXF export must either preserve curve elevations, chosen layer,
major/minor style distinction, and supported grouping, or disclose each loss in FP-D5's plan; stale export is blocked absent
an explicitly reviewed stale warning. **E3.** §6 contour analytic and DXF round-trip gates (MT-D21).

### 3.4 Mesh from cloud (`mesh.from-cloud`) — catalog level

**A1.** Catalog outcome only: derive a named `hcad.surface-3d@1` from a P4-visible cloud by **Poisson** or **Delaunay**,
without modifying the cloud. Cloud→2.5D DGM is already the workflow-level `mesh.create-surface` path (§2.1); this row is the
arbitrary 3D mesh path. **A2.** RealWorks documents mesh creation including watertight output and the sample→mesh→repair flow
(realworks.md §2.8/§3 W7), but not those algorithm names; Poisson/Delaunay are grounded in the current COLMAP capability enum
(`crates/himmelcad-sidecar/src/colmap_runtime.rs:71-72`). **A3.** Pointcloud sampling/extraction remain separate commands; this reads a bounded working
set and records provenance, never publishes a cloud.

**B1.** No visible, console, shortcut, or callable automation path until workflow promotion; `mesh.from_cloud` is reserved
and no placeholder button ships. **B2/B3.** Deferred focused workspace with explicit commit/cancel; the catalog does not
guess its canvas. **C1.** Future quality/sampling values require typed parity. **C2.** Future Run captures cloud ids and P4
scope; hidden classes/entities and active clips exclude geometry, natural occlusion does not. **C3.** A sampled working set
is the required X2 precompute; full-precision source remains. **C4.** Future commit creates a journaled derived entity with
provenance; source is untouched. **D1.** Long-running, UIP-D10/UIP-D11 progress and cancel required. **D2.** Preview density
may degrade, source coordinates/topology may not. **E1.** No authoring E1 claim until promotion; untextured imported results
use criterion 5, while textured Builder results remain unverified.
**E2.** Future consumers are cloud streaming/visibility, clip scope, renderer, snap/pick, tree/properties, export, jobs, and
automation; empty visible input must fail atomically. **E3.** Current COLMAP tests prove only photogrammetry dispatch, not a
Builder command or output-quality contract; the catalog is explicitly unverified.

### 3.5 Volumes (`mesh.volume`)

**A1.** §2.3. **A2.** rib prism method between horizons with accounting polygons (rib-civil.md §2.6 Volumen; §2.8 Mengen aus
DGM) — adopted; realworks volume calculation (§2.7) — adopted via the Pointcloud handoff (§1.3). REB-conform proof output
(rib §2.8) deferred to the civil subsystem (regulation-grade billing needs cross sections, DR-D8 class). **A3.** Saved
measurement sets are the P1 sibling class; File FP-D5/FP-D6 owns export plan/execution. **B1.** Ribbon
Analyze ▸ Volume…; context preset; exact console/protocol ids are §1.2; CSV uses File `export plan`/`export execute` and
`io.export.plan`/`io.export.execute`, with no Mesh export alias. **B2.** Panel closes freely; a running compute continues as a registered UIP-D10 job.
**C1.** **Horizontal plane at project Z**, maximum numerical error, and units/CRS are explicit; surfaces/boundary are selected
by name/id. No unresolved or incompatible vertical reference can Compute. **C2.** Panel state, not
selection-bound beyond the launch preset; changing selection mid-compute changes nothing (inputs and the P4-visible scope are
captured at Compute). **C3.** n/a — compute is a job, not a live preview. **C4.** Compute journals nothing (query); Save
report is journaled canonical creation; undo removes it. The immutable report and exact fields are §2.3/MT-D20; stale is
derived state, not number mutation. **D1.** Long-running, region progress, MT-D17 checkpoint/cancel, no partial report.
**D2.** Never degrades — quantities are correctness. **E1.** §7 criterion 6. **E2.** Consumers: console, Reports tree,
File export (`hcad.volume-report.csv@1`), automation, CRS state, boundary/scope, and both source geometry+placement versions.
Surface deletion keeps the historical numbers and marks **Source removed**. Extremes:
identical surfaces → zero volume reported as zero, not error; disjoint footprints → the intersection area is empty and the
command fails with that explanation rather than reporting 0 (an empty overlap is almost always a picking mistake, X1
honesty); Grid×Tin uses the deterministic cell triangles in `hcad.volume.prism-overlay@1`; holes/NoData are excluded and
reported. **E3.** §6 analytic, CRS-refusal, NoData, mixed representation, error-interval, and CSV round-trip gates.

### 3.6 Simplification (`mesh.simplify`) — contract level

**A1.** The user selects one visible mesh/surface, opens **Simplify…**, types a target triangle count and/or the type-specific
error tolerance, sees estimated result and exact P4 scope, then creates a new named entity of the same type; source remains.
**A2.** Neither
primary dossier documents simplification/decimation (dossier-wide check, §1.3); this is an owner-scoped contract derived from
X1/X2, not attributed to a reference. **A3.** Pointcloud extract's derive-don't-mutate provenance (PC-D7) is the sibling;
automatic render LOD (`crates/himmelcad-render/src/tile_selector.rs:1,121`) is explicitly not canonical simplification. **B1.** Mesh ▸ Edit ▸ Simplify…;
entity context; console `mesh simplify`; the batch-3 lifecycle is `mesh.simplify.preview/check/bake`; no quick surface/shortcut. **B2/B3.** Closeable small panel; its registered job
continues after close. **C1.** Count/tolerance and output name are typed; count is best-effort under invariants, never a reason
to violate tolerance. **C2.** One source captured at Run; P4 clips/visibility scope it, natural occlusion does not. Intersected
triangles are geometrically clipped; that uncapped clip edge becomes an explicit output boundary recorded in scope. **C3.** The explicit derived result is the freeze/bake; there is no
expensive live preview. **C4.** Result and provenance are one journaled creation; undo removes it only. **D1.** Long-running,
MT-D17 checkpoint/progress/cancel, no partial entity. **D2.** Weak hardware takes longer; invariants never relax.
**E1.** §7 criterion 5 plus count/error/provenance copy. **E2.** ElevationSurface preserves outer boundary, holes,
breakline vertices/edges, 2.5D uniqueness, and scoped min/max vertices; its certificate is maximum vertical deviation in
project units. Surface3d preserves open boundaries, manifold classification, material/UV seams, protected vertices, and uses
a certified symmetric surface-distance bound. Both record requested/achieved count and error, exact scope, algorithm version,
and input geometry+placement hash; type is unchanged. Least member one triangle is refused as not simplifiable; largest
resource-backed member streams under G-MT-5. **E3.** §6 sharp-breakline, holes, seams, thin-triangle, clip-boundary,
type-preservation, and resource-stream gates (MT-D23).

### 3.7 Textures (`mesh.texture`) — catalog level

**A1.** Deferred: storage/provider paths may carry UV/material data, but first-party Builder admission-to-frame textured
rendering is unverified; there is no promised authoring workflow. **A2.**
Neither primary dossier documents mesh texture authoring (dossier-wide check, §1.3); RealWorks' image rows are ortho/Raster
work (realworks.md §2.8), not texture baking. **A3.** Raster owns images; BIM material resources and the prepared
textured-mesh path are consumers, not a second authoring surface. **B1.** No visible, console, keyboard, or callable
automation path until workflow promotion; reserved command ids are `mesh.texture.apply/bake`. **B2/B3.** Deferred; the
catalog anticipates a dedicated workspace because UV projection needs its own canvas. **C1/C2/C3/C4.** Deferred; no state or
gesture is shipped. **D1.** Expected long-running; exact budgets wait for researched inputs. **D2.** Existing
provider/prepared texture paths follow renderer LOD; canonical UV/material data never degrades. **E1.** No textured Builder
E1 claim until the admission-to-frame gate exists. **E2.** Storage capability
(`crates/himmelcad-core/src/entity_model.rs:421-454`), prepared textured construction
(`crates/himmelcad-sidecar/src/prepared_triangle_mesh.rs:286-299`), and the SLPK provider/decoder test are separate evidence;
none alone proves a Builder frame. No authoring writer exists. **E3.** Textured Builder display and all authoring remain
explicitly unverified and cannot be marked implemented.

### 3.8 Input arbitration (contract E2 gesture rule)

**Main viewport: this domain arms no viewport tool and claims no gesture in v1.** All spatially dense interaction lives in
the dedicated window (MT-D1); ribbon/panel/context launches are clicks on chrome. Every ui-platform §3.6 gesture keeps its
platform meaning while any Mesh surface is open — reconciled by construction; the registry gains no armed-tool row for this
domain. Volume/contour inputs are filled from dropdowns or **Use selection** after ordinary platform click-selection
(UIP-D2/D15); there is no pick-prompt mode and therefore no hidden LMB claim.

**Window canvas (window-local input, not the platform viewport map; conventions shared per DESIGN-SYSTEM "Input
consistency"):** LMB drag = orbit (3D) / pan (plan); wheel = zoom; RMB drag = pan; RMB click = local context/tool menu;
LMB click = pick (error marker, vertex, edge, or crop vertex — per armed op). While crop acquisition is armed it consumes
DR-D17's construction state: LMB click accepts the current visible candidate, RMB click opens **Finish / Back one / Cancel**,
Enter or **Finish** closes a valid boundary, Backspace removes one vertex, and Escape applies one rung (field revert → clear
candidate → end acquisition); ending with at least three valid non-collinear vertices closes the draft curve, otherwise it
cancels the empty/degenerate acquisition. Escape never closes the workspace (MT-D1). Tab/Shift+Tab only traverse fields and
never cycle geometry. Up/Down cycle the visible spatial candidate stack only while the canvas/crop tool owns focus and the
UIP-D16 indicator is live; when the error-list widget owns focus, Up/Down move rows and Enter jumps. The list never steals
arrows from a live canvas candidate. Typing affects only the focused field. These claims are the settled Mesh rule and must
replace every older Tab/arrow claimant in the Registry gesture map.

## 4. Decision records

**MT-D1 — Surface creation and editing live in one dedicated resizable window, workspace-class.** **Decision:** creation and
editing share one window with its own canvas, input list, and error list; the window is a workspace-class surface per UIP-D14
(never an Escape rung; closed by x, launcher toggle, or Suspend); the main viewport keeps all platform gestures while it is
open. A project may retain many stable-id named drafts; one window activates one draft at a time and only incompatible work
within that draft serializes. **Derivation:** owner statement 2026-09-01 (recorded above); contract B3 names "surface
creation" as the dedicated-window class verbatim; rib's DGM/QP dedicated-window precedent (rib-civil.md §5 Mesh mapping);
UIP-D14 island-class extremes (an error-fixing session is data-loss-adjacent like the Agent workspace); DESIGN-SYSTEM
supplies shared tokens and controls, while this is a true dedicated resizable window rather than UIP-D8's floating island.
**Rejected:** right function panel (the error list + role table + canvas outgrow it in §2.1's own narrative — the B3
self-test); armed viewport tool for editing (would claim LMB against the platform map for work the window canvas does
better); modal dialog (blocks the project during long checks). **Tunable:** no.

**MT-D2 — Inputs and fixes form a recoverable draft; Commit is atomic.** **Decision:** the P4-visible input set is captured
at launch and changes only through explicit add/remove actions. Fixes modify a project-persisted lightweight draft manifest,
never source entities implicitly. Heavy previews/topology are content-addressed job artifacts under MT-D17. Commit journals
hashes and metadata as one command; Discard removes the draft; close/Suspend keeps it for resume. **Apply fix to source** is an explicit
separately journaled Draw/entity command and refreshes the draft from the accepted revision. **Derivation:** owner statement
2026-09-01 (pre-select, fix, then commit); X1 (using an entity as input cannot silently corrupt another deliverable); X3 (the
draft and every command are automation-readable/writable); X5 and DESIGN-SYSTEM complete-flow rules (commit/discard,
suspend/resume symmetry); P5; the owned-copy TIN schema (`crates/himmelcad-core/src/entity_model.rs:465-471`) supports surface-local correction without
inventing linkage. **Rejected:** immediate implicit source edits (Discard would not cancel what the user did in the creation
workflow); volatile staged fixes (crash/close loses work); live-linked selection (mid-session selection churn changes the
input). **Tunable:** no.

**MT-D3 — Check/mesh with errors always surfaced; corrections are reviewable proposals, never silent.** **Decision:** two
phases share one parameter set: Check (validate only) and Mesh (triangulate, re-list residual errors); the error classes are
§2.1's six, each with jump-to-location and explicit fixes; "Propose fixes" lists the checker's resolutions for single or
apply-all-safe application. Safe is only value- and membership-preserving topology normalization; XYZ/source choices,
exclusions, roles, and source edits remain individual. There is no no-check mode or silent correction. **Derivation:** rib-civil.md §2.6
Vermaschung modes + Datenfehleranzeige and §3 W5 (adopted per §1.3); rib-civil.md §4 lesson 3 (jump-to-error is the loved
pattern); X1 — silently "corrected" survey data falsifies deliverables; owner statement 2026-09-01 names error fixing as the
user's act. **Rejected:** rib's "no check" mode (X1); fully automatic correction (rib ships it, we demote it — stated X4
deviation: corrections change survey data and must be seen). **Tunable:** tolerances per error class (coincidence radius,
duplicate-XY radius) — X6, recorded in the calibration table with the gate scripts.

**MT-D4 — Surfaces keep immutable last-good geometry plus a P10 dependency recipe.** **Decision:** a committed
surface refers to immutable triangulation/breakline artifacts plus MT-D25's indexed recipe (source ids, revisions, roles,
placements, scope, parameters, and evaluator versions; the current inline shape is `ElevationSurfaceGeometry::Tin`,
`crates/himmelcad-core/src/entity_model.rs:465-472`). Editing a source never mutates the published surface mid-gesture;
at gesture end the dependency is live-regenerated within budget or visibly Stale. Regenerate runs from current source
revisions/placements as a journaled command, replaces local geometry/recipe only, and preserves the surface's own placement,
name, exact layer, style, and lock. The baked geometry is precisely the last successful regeneration recorded in
`last_success`; Linked-Stale, Regenerating, and Error keep that same geometry visible with a non-color-only product badge and
never relabel it current. Directly authored or imported surfaces without a derived mapping have no recipe; imported recipes
are admitted only when their schema and sources validate. **Derivation:** X1/X2; PC-D7's immutable-product precedent;
P10/MT-D25; IF-D18.
**Rejected:** mid-drag or unbudgeted regeneration; provenance-only static derivatives; forcing recipes onto directly authored
or provenance-free imported surfaces; replacing the last good bake before validation succeeds.
**Tunable:** automatic-regeneration budget under MT-D25.

**MT-D5 — Roles, not conversions: curves stay Draw entities.** **Decision:** Breakline, Form line, Outer boundary, and Hole
are versioned roles in the draft and MT-D25 recipe; source curves remain ordinary Draw entities. Breaklines alone are copied
to `ElevationSurfaceGeometry::Tin.breaklines` as hard constrained edges. MT-D26 defines Form line as soft sampled height
control and stores its exact source/tessellation snapshot in `hcad.mesh-source-roles@1`, never in `breaklines`; boundaries and
holes clip the admitted triangulation. Draft and committed recipe editing expose add/remove/re-role pairs for all four roles.
**Derivation:** X1/X3/X5; S10/GAP-D7; RIB Civil §2.6 supports hard breakline/boundary roles only; the existing Tin
`breaklines` field is `Vec<CurveGeometry>` (`crates/himmelcad-core/src/entity_model.rs:465-472`); MT-D25/MT-D26.
**Rejected:** a breakline or Form-line entity kind (duplicates `hcad.curve@1`); aliasing Form line to Breakline; storing soft
samples as hard constrained edges; implicit source conversion.
**Tunable:** no; Form-line sampling tolerances are MT-D26 tunables.

**MT-D6 — Mesh display modes are per-entity canonical style: Realistic / Abstract (uniform, elevation ramp, slope classes) /
Wireframe (+ shaded-edges).** **Decision:** as §2.4; carried on the same canonical style mechanism as PC-D11 with a mesh
display-style resource kind; breakline overlay visibility is part of the style. Grid ramp/hillshade adopts RA-D5 including
typed bounds/light and NoData behavior. Raster ▸ Appearance contributes the
Grid **Elevation ramp / Hillshade** access path to this one `mesh.display` /
`mesh.set_display` owner. VD-D8's two layers are adopted without alteration;
VD-D6 now admits the compatible Mesh values realistic/abstract/wireframe/
shaded-edges without creating a second state owner. **Derivation:** owner statement 2026-09-01;
VD-D8's below-layer delegation; PC-D11; RA-D5; rib Neigungsplan; X1. **Rejected:**
global-only display mode (collides with VD-D8's architecture and multi-surface scenes: design mesh realistic, terrain
wireframe is a real drafting posture); owning a second view-override state/command here (would re-disposition VD-D8 and
create the registry defect class); prematurely changing View's enum from a consumer spec. **Tunable:** default mode and
palette/fixed-light defaults (X6).

**MT-D7 — Audited contours and reports use the common recipe with an automatic budget of zero.** **Decision:** contours/reports record source geometry
revision and placement/version plus scope, boundary, layer/style and CRS dependencies as applicable. Geometry or placement
change, IF-D4 update/removal, and dependent reference loss produce a named stale reason; regeneration/recompute is explicit.
They use MT-D25's envelope and transitions, but their owning automatic-regeneration budget is exactly zero because linework
and numeric reports are audited deliverables whose values/layer/style may have been reviewed. `Regenerate` and batched
regeneration remain journaled; failure retains the last-good group/report. **Derivation:** X1; P10 explicitly delegates the
automatic budget; MT-D25; a report's numbers are claims about a recorded revision; rib's static generate-then-inspect posture
(rib-civil.md §3 W5). **Rejected:** automatic deliverable churn; a separate contour/report dependency state machine; no stale
indication. **Tunable:** badge debounce and explicit batch size (X6); the zero automatic budget is a correctness rule, not a
performance calibration.

**MT-D8 — Volume compute is a pure query; the saved report is a canonical named record.** **Decision:** `mesh.volume.compute`
mutates nothing; `mesh.volume.save_report` creates the immutable named `hcad.volume-report@1` described in §2.3, listed under
Reports and automation-visible. The entity-model extension point permits the namespaced kind
(`crates/himmelcad-core/src/entity_model.rs:61-65`). MT-D20 owns calculation honesty and CSV arrival. **Derivation:** rib prism
method + accounting polygons (§1.3); P1 + X3 for
the canonical record; query/creation split follows X3's read-parity (agents may compute without littering the journal); X1
immutability (a quantity proof must not drift). **Rejected:** console-only results (violates P1 — not restorable); a new
built-in enum variant for reports (schema churn where the extension point exists precisely for this); journaling every
compute (undo spam for a side-effect-free query). **Tunable:** maximum numerical error default (X6; user value remains explicit).

**MT-D9 — Cloud→DGM is workflow-level; cloud→3D mesh stays catalog-level.** **Decision:** `mesh.create-surface` accepts
clouds and produces constrained 2.5D `hcad.elevation-surface@1` through the error-fixing window; the separate
`mesh.from-cloud` row reserves Poisson/Delaunay creation of `hcad.surface-3d@1` without shipping placeholders.
**Derivation:** RIB cloud→DGM triangulation (rib-civil.md §2.6) and the owner-stated surface window drive the first;
RealWorks mesh/watertight catalog + workflow (realworks.md §2.8/§3 W7) and the current COLMAP method enum (`crates/himmelcad-sidecar/src/colmap_runtime.rs:71-72`)
ground the second; completion discipline and PC-D10 reject invented workflow depth. **Rejected:** one generic "mesh it"
command (2.5D validity and arbitrary 3D topology differ, `crates/himmelcad-core/src/entity_model.rs:457-471` vs `:440-454`); shipping Poisson/Delaunay
UI over a photogrammetry-only dispatcher. **Tunable:** future quality presets (X6).

**MT-D10 — Long work is UIP-D10 jobs; whole-app recovery is MT-D17.** **Decision:** check, mesh, rebuild, contours, volumes,
simplify, and resource-backed repair register in UIP-D10 with real phase/unit progress and UIP-D11 cancel; window progress
mirrors the registry. Close/Suspend does not cancel. Project replacement rejects late publication by project/draft/expected
revision. Multi-minute restart/checkpoint, resource, cancel, and completion guarantees are MT-D17. **Derivation:** UIP-D10/
UIP-D11; P5; DESIGN-SYSTEM progress/cancellation/app-shutdown rules; X2/X6. **Rejected:** window-modal waits; renderer-only
jobs; rebuilding all 20-minute work from zero after restart. **Tunable:** registration/checkpoint thresholds (X6).

**MT-D11 — Display LOD is automatic and free; canonical decimation is explicit and creates a new entity.** **Decision:** as
§3.6. **Derivation:** X2 (prepared hierarchies exist for display — `crates/himmelcad-render/src/tile_selector.rs:1,121`; canonical data is never silently
thinned); X1 (decimating the survey surface in place falsifies it); PC-D7 class (derive-don't-mutate). **Rejected:** in-place
simplify (destroys survey data under its deliverables); conflating display LOD with canonical resolution (the confusion this
record exists to prevent). **Tunable:** default target ratio (X6).

**MT-D12 — Surfaces enter the shared snap/pick pipeline through the Rust BVH; the TS stubs stay dead.** **Decision:**
committed surfaces register with the kernel ranked snap pipeline as Draw DR-D13's terrain producer input and with entity
picking via BVH build/query/refinement (`crates/himmelcad-render/src/mesh_picking.rs:229-285,345-424,496-562,593-630`) and
its exact transformed snap tests (`:1807-1856,1858-1933`); the
`packages/@himmelcad/viewer/src/snapping/DgmSnapProvider.ts:6` and
`packages/@himmelcad/viewer/src/snapping/MeshSnapProvider.ts:6` stubs ("STUB… returns no
candidates") are never revived (both live in the deprecated surface, `packages/@himmelcad/viewer/src/legacy.ts:1`). P4 applies: picks and
snaps against surfaces respect active clip volumes and visibility. **Derivation:** draw DR-D13 (cited — the producer contract
is Draw's; the _data registration_ is this spec's delivery, forming the required DR-D13 ↔ MT-D12 mutual citation); contract A2 code rule; P4; the
spatial crate's own roadmap comment names the missing index (`himmelcad-spatial/src/lib.rs:7-16` "Coming: triangle BVH (mesh
snap), grid index for DGM") — cited as intent evidence, not existence. **Rejected:** reviving the TS stubs (DR-D13 already
rejected it; cited); display-depth snapping (violates full-precision, DR-D13's own rejection). **Tunable:** no.

**MT-D13 — Texture authoring and Builder textured-display completion stay catalog-level.** **Decision:** storage supports UV/
materials (`crates/himmelcad-core/src/entity_model.rs:421-454`) and prepared textured construction exists
(`crates/himmelcad-sidecar/src/prepared_triangle_mesh.rs:286-299`); SLPK proves provider→prepared-decoder texture data
(`crates/himmelcad-io/src/slpk_provider.rs:784-870,1711-1760`). IFC/DXF Surface3d are explicitly untextured. No cited path
proves first-party Builder admission→frame, so textured Realistic rendering remains unverified; texture authoring remains
deferred. **Derivation:** contract A2 evidence-precedes-spec; completion discipline; dossier-wide authoring gap. **Rejected:**
claiming end-to-end display from storage capability or inventing projection workflow. **Tunable:** no.

**MT-D14 — Queued Mesh-owned backlog (one list, evidence attached).** **Decision:** queued behind this spec: smoothed contours and
contour label-by-click (rib-civil.md §2.6 Höhenlinien); DXF/DWG surface export mapping (DGMs as 3DFACE/MESH, rib-civil.md
§2.10); drop-flow analysis (Regen, §1.3 row); control sections (§1.3 row, civil-subsystem class); richer PDF/text quantity
layouts beyond shipping CSV. Breakline finder and difference models are excluded because Pointcloud PC-D10 owns them;
hole filling is promoted into MT-D22. A reviewed multi-surface contour/simplify job group and named parameter preset are
explicitly deferred until the single-surface workflows pass G-MT-5 and repeated use supplies P1 evidence; exact automation
commands remain the interim repeat path. **Derivation:** completion discipline; each retained row's evidence cited; X3/P1.
**Rejected:** bundling into v1 (delays the flagship window). **Tunable:** no.

**MT-D15 — Every geometry-consuming Mesh act captures the P4-visible set.** **Decision:** create/add-input, contour
generation, volume Compute, simplification, and future cloud meshing capture explicit visibility/class state and active clip
geometry at the act boundary; natural occlusion never scopes them. The UI names exclusions and active scope, and
commands/reports carry camera-free scope arguments for deterministic replay. **Derivation:** doctrine P4 applies to "anything
that acts on geometry," including measurement and destructive applies; X1 prevents invisible terrain, contour, or quantity
changes; pointcloud PC-D16 supplies the camera-free replay class. **Rejected:** applying to full canonical geometry while
clipped (violates P4); reading live camera/visibility during a job (nondeterministic replay); silently omitting excluded
selected inputs (looks like data loss). **Tunable:** no.

**MT-D16 — A crossing breakline never acquires an inferred elevation.**
**Decision:** §2.1 is exhaustive. Agreement within tolerance or an existing surveyed shared XYZ permits a value-preserving
split. Otherwise both evaluated elevations remain visible and the user/automation must name one line for **Split using
elevation from…** or **Interpolate elevation along…**; default is none, the choice is provenance, and unresolved blocks Commit.
Apply-all-safe can never choose Z, exclude input, change roles, or edit a source.
**Derivation:** X1; owner statement 2026-09-01; rib-civil.md §3 W5 supplies shared-surveyed-point and fix/jump conventions but
no priority; contract C1/E2.
**Rejected:** higher-priority line (no such input exists); average/highest/lowest Z (fabricated terrain truth); silent bulk
exclusion; free typed intersection Z inside this fixer (not tied to an authority—explicit source edit and Recheck is honest).
**Tunable:** Z agreement tolerance only (X6), always recorded.

**MT-D17 — Mesh job artifacts are content-addressed, checkpointed, and restart-safe.**
**Decision:** checks, sampled working sets, previews, canonical topology, repair replacements, contour intermediates, volume
partitions, simplification certificates, and prepared hierarchies are immutable staging artifacts written only by UIP-D10
jobs. Drafts/journal commands carry hashes and small metadata only. Jobs estimated at ≥ 60 s checkpoint deterministic
partitions and a durable descriptor. After sidecar/app restart, opening the same project re-registers the job as **Paused after
restart**; Resume verifies hashes and continues after the last verified partition, while Discard makes staging unreachable.
Shorter non-checkpointed work is labeled **Restart required** and restarts explicitly, never silently.
App shutdown requests **Pause**, waits at most the 2 s hard cancellation bound for the current bounded unit, fsyncs the
descriptor, and then may terminate; an incomplete partition is discarded on reopen while every previously verified hash
survives. Project replacement cancels publication but may leave verified artifacts reachable from its suspended draft.

For the 500M-logical-point gate: time to first truthful phase/unit progress ≤ 500 ms; completion ≤ 20 min on the calibrated
active tier; concurrent canvas presented-frame-interval p95 ≤ 2× target frame time and error-list input-to-highlight p95
≤ 100 ms; additional process RSS ≤ `min(4 GiB, 25% of physical RAM)`; peak staging disk ≤ `3 × (retained sampled-input
bytes + final topology/prepared-output bytes) + 2 GiB`. Source streaming is bounded. Cloud sampling is a recorded XY-grid step
and explicit representative policy (`nearest-to-cell-center`, `lowest`, or `highest`; default nearest-to-cell-center), with
every explicit point and breakline vertex retained. UI/report show source count, retained count/spacing/policy and state that
the DGM represents sampled input; cloud-only features below the step may be absent.

Cancel is polled at ≤ 250 ms units, acknowledged ≤ 250 ms p95 and ≤ 2 s hard outside a declared atomic publication boundary;
that boundary is ≤ 500 ms and cancellation takes effect immediately after it. Cancel publishes no entity and leaves staging
unreachable. Preview completion means every captured partition is verified, all constraints pass, and topology plus prepared
hierarchy hashes are readable. Commit completion means the hash/provenance refs are durably journaled and reachable; no later
background preparation is needed to render the committed surface.
**Derivation:** P5 (heavy data only explicit jobs); X1/X2; X6/P3; UIP-D10/UIP-D11; FUNCTION-CONTRACT D1; DESIGN-SYSTEM
app-shutdown/cancellation rules.
**Rejected:** vertex/index buffers in journal/draft metadata; interaction-path writes; from-zero restart of 20-minute work;
publishing topology before its prepared result is usable; unbounded in-memory triangulation.
**Tunable:** all numeric budgets, the 2 s draft-manifest acknowledgement target, and the 60 s checkpoint threshold (X6),
calibrated only by G-MT-5 and the draft persistence component gate. MT-D31 is the more specific extension for recipe
cascades, Form-line/crop checks, hulls, signed solids, and strata; it reuses these publication/cancel/resource invariants and
adds their extreme members and checkpoint keys.

**MT-D18 — Named drafts have local history and coexist.**
**Decision:** projects may retain multiple stable-id named drafts; one is active in the single workspace window. Suspend/
Resume and Discard are explicit pairs. In creation-draft mode, focused Ctrl+Z/Ctrl+Shift+Z route only to one-step draft
history; committed edit mode uses project undo/redo. Apply all safe is one
inspectable group. Global source-edit commands appear as linked markers and remain in project history. Automation has the same
ids/history/routing. Commit collapses final draft state into one canonical command.
**Derivation:** X3/X5; P1 class (a deliberately retained 20-minute draft); P5; DESIGN-SYSTEM complete flows.
**Rejected:** one anonymous project session (prevents parking work); volatile draft; mixing draft fixes into global undo before
publication; a canonical draft entity (would publish unaccepted survey corrections and blur Commit's atomic boundary;
project staging remains named, durable, and automation-visible); best-effort grouped undo.
**Tunable:** generated-name sequence and manifest debounce only (X6).

**MT-D19 — Mesh provenance is an indexed IF-D4 dependency relation.**
**Decision:** drafts register their dependencies with IF-D4; committed surfaces, contours, and reports use MT-D25's one
project reverse index rather than a Mesh-private index. Matched source update supersedes in-flight work and requires Recheck.
For an open draft, removal blocks Commit until remove, replacement-map, or detached immutable revision is explicit; IF-D4
Keep-as-local is the default when it preserves a referenced source as a local entity. For a committed recipe, actual source
loss performs MT-D25 auto-detach/console/undo, while explicit regeneration with unresolved sources fails without changing the
last-good product. Late publication uses project/draft/recipe/output expected revisions and cannot enter replaced state.
**Derivation:** IF-D4 cite-and-revise; X1/X5; SYSTEM-001; SE-D11 CAS transactions.
**Rejected:** stale badge without a discoverable relation (import cannot protect it); silent input removal; mid-gesture or
unbudgeted automatic regeneration; a second Mesh reverse index; late-result last-writer-wins.
**Tunable:** stale-display debounce only (X6).

**MT-D20 — Volume is CRS-explicit bounded prism integration with a shipping CSV deliverable.**
**Decision:** §2.3 defines operand/reference admission, fill/cut/net sign, common valid footprint and excluded-area rules,
`hcad.volume.prism-overlay@1`, outward-rounded numerical interval, report schema and `hcad.volume-report.csv@1` File-export
arrival. The report distinguishes computational error from source/survey accuracy and records geometry+placement versions.
**Derivation:** X1; X3/P1; rib-civil.md §2.6/§2.8 prism/accounting evidence; FP-D5/FP-D6 export ownership; P4.
**Rejected:** unlabeled datum; guessed CRS/vertical offset; tolerance presented as survey accuracy; console/tree-only result;
silent NoData-as-zero; stale export without reviewed warning.
**Tunable:** default maximum numerical error and region partition size (X6); algorithm/schema versions are not tunable.

**MT-D21 — Contours are exact-layer/style derivatives with whole-dependency staleness.**
**Decision:** every generated curve has exactly the explicitly selected DR-D4 layer and major/minor style ref. Provenance
includes source geometry+placement, intervals, layer/styles, min/max, scope and generator version. All named triggers in §3.3
stale the group; regeneration atomically replaces generated children while preserving unrelated group state. File export
preserves or explicitly discloses elevation/layer/style/grouping loss and blocks unreviewed stale output.
**Derivation:** DR-D4; X1/X3/X5; rib-civil.md §2.6 Höhenlinien; FP-D5.
**Rejected:** ambient/default layer assignment; style by display-only heuristic; partial child replacement; silently current
world-space contours after placement change.
**Tunable:** none beyond user-specified intervals and style values.

**MT-D22 — Terrain Tin editing and Surface3d repair are separate typed contracts.**
**Decision:** `mesh.edit-terrain` applies only to ElevationSurface Tin; Grid converts through RA-D7. `mesh.edit-3d` owns Add
triangle, Remove triangles and Fill hole with the material/UV/manifold/refusal and resource-backed publication rules in §2.2.
**Derivation:** X1; entity types have different invariants (`crates/himmelcad-core/src/entity_model.rs:421-482`); RA-D7;
realworks.md §2.8/§3 W7 repair loop; P5.
**Rejected:** one generic edit command; claiming absent fill via add-point; rewriting resource meshes in place; invented
material/UV across seams.
**Tunable:** affected-partition and local-remesh thresholds (X6).

**MT-D23 — Simplification has type-specific certified error and invariant preservation.**
**Decision:** §3.6's ElevationSurface and Surface3d rules are mandatory; target count is best effort, error/invariants win.
Intersected P4 triangles are clipped and the uncapped clip edge becomes recorded output boundary. Output type is unchanged and
requested/achieved error/count plus algorithm/scope/input geometry+placement hashes are provenance.
**Derivation:** X1; P4; X2; PC-D7 derive-don't-mutate class.
**Rejected:** triangle-count-only decimation; one metric for 2.5D and arbitrary 3D; selecting whole triangles across clip;
crossing breaklines, holes, manifold boundaries, material/UV seams, or extrema.
**Tunable:** default error/count suggestions only (X6); user-requested bound never relaxes.

**MT-D24 — Protocol ids adopt the registry's schema convention.**
**Decision:** §1.2 is the complete command map, including draft history and report export. UI ids remain kebab
case and are not protocol ids. F8 selects dotted lower-case paths with `snake_case` segments; SDK/schema generation consumes
this set and runs uniqueness/staleness gates.
**Derivation:** X1 (a frozen ambiguous API is a compatibility defect); X7; Builder README registry ownership; REGISTRY F8.
**Rejected:** choosing a competing convention inside Mesh; retaining aliases with divergent semantics; generating SDKs
from mixed spellings.
**Tunable:** no. F8 owns the convention and this record consumes it, so no owner question remains.

## 5. Current implementation delta

**Exists and stays** (verified 2026-09-02): entity model — kind ids (`crates/himmelcad-core/src/entity_model.rs:33-36,81-84`),
`TriangleMeshStorage`/`TriangleMeshGeometry` (`:421-455`), `ElevationSurfaceGeometry::Tin{mesh,breaklines}/Grid`
(`:465-482`), geometry objects (`:1089-1094`); validation for inline meshes, TIN topology, breaklines
(`crates/himmelcad-core/src/entity_validation.rs:628-713`); LandXML TIN+breakline import and complete writer
(`crates/himmelcad-io/src/landxml.rs:961-1052,1068-1090,2216-2310`, registered
`crates/himmelcad-io/src/lib.rs:132-134`); sidecar prepared-mesh pipeline
(`crates/himmelcad-sidecar/src/prepared_triangle_mesh.rs:270-299`); render — TIN+breakline compilation, LOD/streaming,
sections, topology, lit/flat materials, and exact BVH build/query/refinement with tests (the full citations are §3.1 E2 and
MT-D12); viewer prepared-mesh/TIN admission; the 4.2M-triangle gate
(`packages/@himmelcad/viewer/test/scale/viewer-scale-gate.mjs:69,356,405`); tree kind labels.

**Known gaps in "exists" (stated, not glossed):** resource-backed TINs skip 2.5D validation (`crates/himmelcad-core/src/entity_validation.rs:715-725`
names the gap — the admission gate in §6 covers it); `ElevationSurfaceGeometry::Grid` neither compiles
(`crates/himmelcad-render/src/entity_compiler.rs:484-487` "elevation grid provider" unsupported) nor sections
(`crates/himmelcad-render/src/section.rs:683-686`); Builder never calls
`loadPreparedMesh`/`loadPreparedTin` (checked — only PhotoLab and viewer tests do); the TS snap providers are stubs
(`packages/@himmelcad/viewer/src/snapping/DgmSnapProvider.ts:6`,
`packages/@himmelcad/viewer/src/snapping/MeshSnapProvider.ts:6`) in the deprecated package
(`packages/@himmelcad/viewer/src/legacy.ts:1`) and count as not existing.

**Changes:** Builder ribbon gains the Mesh tab (extend `apps/builder/renderer/src/ribbon.ts:37-155`); Builder admits committed/imported surfaces
through the existing prepared-TIN/mesh viewer path (first Builder consumer of
`packages/@himmelcad/viewer/src/kernel/KernelPreparedTinDatasetAdmission.ts:64`);
properties panel gains the mesh Display group; entity context menus gain the §1.2 entries through the UIP-D6 command
registry; Grid support closes in the compile and section paths (the two cited gaps); resource-backed TIN admission gains the
2.5D proof the validator comment demands.

**New:** constrained-Delaunay triangulation + validation/error engine with the §2.1 classes and no-invented-Z guard;
`mesh.surface.draft.*`, `mesh.surface.check/create/edit.*/rebuild`, `mesh.contours.generate`,
`mesh.volume.compute/save_report/list_reports`, `mesh.set_display`, and the batch-3
`mesh.simplify.preview/check/bake` journaled/query commands and automation
surface; the dedicated window with multiple named draft manifests/local history; content-addressed staging/checkpoints and
whole-app resume; indexed IF-D4 provenance + stale tracking; Surface3d repair; robust prism-overlay/interval engine and CSV
adapter; exact-layer/style contour generation; certified type-specific simplification; mesh display-style resource;
terrain/mesh snap registration onto the kernel pipeline (with `himmelcad-spatial` gaining the indices its roadmap names,
`crates/himmelcad-spatial/src/lib.rs:7-16`); `hcad.volume-report@1`; gates G-MT-1…5 (§6).

**Cataloged, not in the implementation tranche:** `mesh.from_cloud` Poisson/Delaunay authoring and `mesh.texture.apply/bake`;
no placeholder UI or callable automation surface lands before workflow promotion (§3.4/§3.7).

## 6. Verification plan (per `docs/TEST-TIERS.md`)

Named agent-runnable launchers to add with implementation: GPU/browser gates run as
`node scripts/verify-mesh-terrain-gpu.mjs --gate G-MT-N`; compute calibration G-MT-3 runs as
`cargo bench -p himmelcad-sidecar --bench mesh_terrain -- G-MT-3`; the new extreme/recovery gate is
`node scripts/verify-mesh-terrain-scale.mjs --gate G-MT-5`. Each self-launches/generates its fixture and fails when the
capability or budget is absent.

- **changed (Rust core/sidecar unit):** triangulation — breakline edges present in output for every input class incl.
  collinear chains; boundaries/holes; W5 crossing detector. Agreeing/shared-survey-point split passes; conflicting-Z rows
  show both values and every check/fix/apply-all path proves byte-identical XYZ unless an explicit authority/source-edit
  argument exists. Duplicate-XY and vertical-triangle detection covers the model invariant. Draft manifest/history round-trip
  creates no journal/heavy interaction-path write; journal payload stays ≤ 64 KiB and contains hashes, never buffers. Rebuild
  determinism keys ids+revisions+placements; preserves own placement/name/exact layer/style/lock.
- **changed (volume/contour/simplify/repair):** analytic box/ramp/cone/Tin offset and mixed Grid×Tin volumes prove sign,
  interval bound, holes/NoData/excluded area and disjoint refusal; missing/incompatible vertical CRS refuses; CSV export
  plan/write/re-read reproduces every report field. Contours prove plane/cone/flat cases, exact DR-D4 layer + major/minor
  styles, all stale triggers, atomic regeneration restore set, and DXF export/re-import with every unsupported distinction
  named as an accepted loss. Simplify adversaries cover sharp breaklines, extrema, holes, seams, thin triangles, manifold and
  type preservation, certified bounds, and clipped uncapped boundary. Surface3d tests cover one triangle, one-cell hole,
  seam refusal, fill classification, and resource-partition replacement.
- **changed (component):** window — role pre-guessing, captured-set invariance under selection change,
  add/remove-from-selection, error list rendering + keyboard navigation, jump sync to canvas markers, session persistence
  round-trip, many named drafts, Suspend/Resume/Discard, draft-only undo/redo and grouped Apply all safe, Escape inner rungs,
  source-history marker routing, truthful Draft storing/stored/not-stored acknowledgement and failure recovery; fix
  application updates constraint/marker/row plus **Preview stale / Rebuilding** in one
  presented frame while old triangulation remains visibly stale. Display tests lower-layer values, Grid hillshade/NoData and
  UIP-D17 Mixed; no Mesh upper-layer accelerator exists. Volume panel proves project-Z/units/CRS/tolerance copy.
- **push (risk-triggered, browser):** launch-with-selection → check → apply draft fix (no journal entry) → mesh → commit (one
  journal entry) → surface picked/snap-visible in the main viewport (MT-D12, with the DR-D13 browser test); automation edit
  delete/matched-update/unmatched-removal/Keep-local/detached-snapshot/undo cases follow IF-D4; replaced-project/source late
  publication is rejected. Move → world-cache invalidation + contour/report stale → rebuild/regenerate and undo/redo prove
  SE-D3/SE-D11. Close-mid-job retains UIP-D10 state; display switch does not reprepare; main gestures remain unchanged.
- **push (risk-triggered) / release (always), capability `browser-gpu`:** **G-MT-1** — scripted pan/zoom/orbit burst in the
  window canvas over a 1M-point + 500-breakline session: presented-frame-interval p95 ≤ 2× target frame time (the VB-D7
  metric class — presentation cadence, never render-body cost). **G-MT-2** — main-viewport orbit burst over the existing
  4.2M-triangle mixed scale scene with one surface in each display mode: same p95 bound (extends
  `packages/@himmelcad/viewer/test/scale/viewer-scale-gate.mjs:69,356,405`). **G-MT-4** — display-mode switch commit→restyled-frame ≤ 300 ms
  p95 (tunable X6) on the G-MT-2 scene; Realistic fallback is neutral for IFC/DXF. Textured SLPK Builder admission-to-frame
  is a failing/absent gate and remains unverified, never silently counted as pass.
- **push / release, compute benchmark:** **G-MT-3** — the named Cargo benchmark checks and meshes 1M sampled points + 500
  breaklines in ≤ 60 s on the calibrated active tier, emits ≥ 4 genuine progress events, and acknowledges cancel within 250
  ms outside the atomic publish boundary; no cancelled run publishes a preview/entity. Values are tunable under X6.
- **release, capability `large-data`: G-MT-5** — generate a 500M-logical-point streamed hierarchy with explicit sub-cell
  feature, 500 breaklines and recorded sample policy. Assert every MT-D17 time/RSS/disk/progress/completion budget; navigation
  and error-list input remain responsive; early and late cancel meet bounds on both sides of atomic publication; forced
  sidecar/app restart resumes from the last verified partition with identical final hashes; canvas interaction causes zero
  heavy writes. Assert explicit points/breaklines survive, retained count/spacing/policy are reported, and the sub-cell
  cloud-only feature is either retained by the selected policy or disclosed as below sampling resolution.
- **release, capabilities `browser-gpu` + `real-data`:** the Brandenburg DGM real dataset (already exercised by
  `crates/himmelcad-sidecar/src/mesh_tiler.rs:1929-2041`) end-to-end: cloud → sampled Delaunay surface → contours → project-Z volume; LandXML round-trip
  (import → edit → export → re-import ⇒ equal TIN + breaklines, extending the existing io tests); locked viewing box + mesh
  scene keeps the surface clipped (rides VB-D8's mixed-scene gate — coordinated, not duplicated).
- **automation:** registry F8 is resolved; schema uniqueness/staleness generation must match §1.2 and the dotted
  lower-case/`snake_case` convention mechanically (MT-D24). The eventual parity script covers named draft list/history/undo/resume/discard,
  explicit crossing authority, create/edit/common-regenerate, contour generation/regeneration, volume list/export and simplify; deferred commands
  remain absent.
- **manual/visual:** both-theme screenshots of the window (empty, errors listed, jump-marker pulsed, preview meshed), the
  three display modes, shaded-edges variant, and slope classes over the real DGM, contour styling, stale badges, volume
  panel + report — compared against §7 at implementation review.

Explicitly unverified: subjective canvas feel beyond G-MT-1; Poisson output quality; textured SLPK first-party Builder frame;
progress-fraction accuracy on exotic inputs; slope-class color legibility beyond §7; and all batch-2 launchers/captures named
by MT-D31. The registry is now clean; shared schema admissions and runnable gates
remain implementation/release prerequisites.

## 7. E1 — visual and behavioral criteria (failable)

Grounded in `docs/DESIGN-SYSTEM.md` and theme tokens; every screenshot criterion is captured in both themes.

1.  **Window chrome:** the dedicated surface window uses DESIGN-SYSTEM tokens and shared controls — dark-island material,
    standard header with title ("Create surface — <name>" / "Edit surface — <name>"), x; tokens only (grep the modules for
    hardcoded hex ⇒ fail); resizable with a sane minimum that never clips the error list below three rows.
2.  **Error list:** rows show class, entities, and a jump affordance at ≥ 16 px hit target; the active error's canvas marker
    is visibly pulsed and legible over dense points in both themes; error copy names the consequence and the fix options,
    sentence case, no jargon-only labels ("Breakline crosses 'Curb west' away from a shared point").
3.  **Canvas:** input roles are visually distinct (points / breaklines / boundary / holes) via token styles, distinguishable
    in both themes at plan zoom; preview triangles render clearly under the inputs, never occluding error markers; the
    sampled-cloud state is labeled in-canvas ("Preview: sampled 1 of 25 points").
4.  **Fix application:** within one presented frame, the edited constraint/marker and row state update and the canvas shows
    **Preview stale** or **Rebuilding…**. The old triangulation remains visible but unmistakably stale until the registered
    remesh atomically publishes; only constraint/error feedback, not new triangulation, has a one-frame promise.
5.  **Display modes:** Realistic, Abstract, and Wireframe plus the shaded-edges variant are unmistakably distinct on the
    same surface screenshot set; slope-class colors follow the user-defined table exactly (sampled pixels vs table);
    wireframe edges remain legible over both themes' voids; no mode alters silhouette or extents (same-geometry diff).
6.  **Volume panel and report:** the plane label says **Horizontal plane at project Z**; horizontal/vertical CRS status,
    project units, cut/fill sign, evaluated/excluded area, requested tolerance, numerical interval and **Computational
    tolerance is not source or survey accuracy** are visible. The saved row names geometry+placement versions; stale copy
    names the exact changed/missing input. File Export shows CSV format and reviewed stale/loss warnings before write.
7.  **Contours:** major and minor lines are visually distinguishable on the same captured surface in both themes; Properties
    show the exact output layer and both style refs. A stale badge names geometry, placement, import, layer/style, or scope
    cause. Regeneration preserves the group name/layer/style choices and never flashes a partial replacement.
8.  **Batch-2 source-table storyboard (`G-B2-MESH-DRAFT-RULES`):** one capture at 100% and one at 150% in each theme show
    Points, hard Breakline, soft Form line, Outer boundary, Hole, Reference/Editable eligibility, source revisions, sampler,
    estimates, gross/overlap/net exclusion counts, and source-local/draft-only badges simultaneously. Fail if Form line and
    Breakline use the same line pattern/label, if long labels obscure role/count/state, or if source mutation is implied.
9.  **Crop/error storyboard (`G-B2-MESH-DRAFT-RULES`):** captures show an armed crop, DR-D17 input fields, the UIP-D16
    candidate indicator, a NoData interval (not merely a bad endpoint), and bidirectional canvas↔error-list focus. Fail if
    Tab cycles geometry, if arrows move error rows while a canvas candidate is live, if error state relies on color, if an
    ambiguous interval looks closed/valid, or if the minimum window hides Finish/Cancel/progress.
10. **Recipe-state storyboard (`G-B2-MESH-RECOVERY`):** the same product is captured as Linked/current, Stale,
    Regenerating, Error with last-good visible, Detached, and Auto-detached/source missing. Properties show recipe/output ids,
    generation, stale/error cause, Regenerate, Detach, and Relink where valid. Fail if stale/error geometry is labeled current,
    if Detach loses provenance, if color is the only distinction, or if close/reopen loses a recoverable action.
11. **Hull storyboard (`G-B2-SOLID`):** the assistant shows separately selected 2D Area and 3D Surface outputs, exact captured
    source revisions, tolerance/dedup counts, preview/final fidelity, estimates, and explicit one-point/collinear/coplanar
    refusal or planar result. Fail if a degenerate input receives fabricated area, thickness, or a success-colored empty row.
12. **Cut/Fill storyboard (`G-B2-SOLID`):** separate Cut and Fill rows show their own specification, stable output/part ids,
    `A-B` sign, zero tolerance, crossings, valid footprint, holes/NoData, source revisions, stale reason, and optional MT-D8
    report as a differently typed row. Fail if one specification controls both, negative regions silently swap, an empty sign
    class looks missing, a report is labeled Solid, or progress/cancel/recovery disappears during a long job.
13. **Strata storyboard (`G-B2-STRATA`):** each stratum row shows observed-interface coverage, interpolation method,
    host/support boundary, datum, uncertainty, missing/pinch/crossing state, specification, and derived-not-observed badge.
    Fail if outside-hull extrapolation looks valid, uncertainty is color-only, a one-borehole fallback occurs without the
    explicit constant-extrusion method, or missing observations appear as invented interfaces.
14. **Artifact and accessibility contract:** the written storyboard in criteria 8–13 is the committed in-repo comparison
    artifact until implementation supplies the corresponding capture set beside the named launchers. Implementation review
    must replace/add actual captures from the running product in both themes and 100%/150% scale, with keyboard focus,
    screen-reader names, long labels, minimum size, progress/cancel, close/resume, error recovery, and stale-last-good
    visibility checked. The named gates are currently **unverified** because no in-repo launcher exists; absence blocks an
    implemented/release-ready claim rather than waiving E1.

## 8. Owner-decision items

None. Candidates tested against the escalation protocol and dissolved in writing:

- _"Should terrain get its own ribbon tab?"_ — closed by owner decision D2's own rule plus the dossier check it demands
  (§1.2: neither reference separates terrain from mesh surfaces).
- _"Do window fixes edit real data or stage?"_ — closed by owner statement 2026-09-01 + X1/X3/X5/C4: draft fixes are
  recoverable on Suspend/close, discarded only by explicit Discard, and published atomically on Commit (MT-D2/MT-D18);
  heavy state follows P5/MT-D17 and source edits require their own command.
- _"Which Z wins at a crossing?"_ — no owner choice survives: X1 forbids a winner absent explicit authority; MT-D16 offers
  only agreeing/surveyed value preservation or a required line choice, default none, otherwise Commit remains blocked.
- _"Are contours entities or live display?"_ — closed by P1 + X2 + the reference's generate-posture (MT-D7/§3.3).
- _"Where do volume results live?"_ — closed by P1's verbatim "saved measurement sets" class + the entity model's extension
  point (MT-D8).
- _"Who owns the view-level mesh override?"_ — closed by VD-D6/VD-D8 and the cite-and-revise rule: View owns it; Mesh defines
  only lower-layer entity values, and the landed View amendment admits those values without transferring ownership (MT-D6).
- _"What survives a 20-minute job and how large may it get?"_ — P5/X2 require job-written immutable artifacts and restart
  safety; X6/P3 delegates the explicit G-MT-5 budgets (MT-D17), so no owner calibration remains.
- _"May quantity output proceed without vertical reference, accuracy proof, or an export?"_ — X1 answers no; MT-D20
  specifies refusal, computational interval vs source accuracy, complete provenance and File-owned CSV arrival.
- _"Does edit apply to Tin, Grid, or arbitrary 3D mesh?"_ — entity invariants + RA-D7 + RealWorks evidence split the class
  without scope escalation (MT-D22).
- _"Which automation naming convention wins?"_ — REGISTRY F8 is closed with the
  schema's dotted lower-case/`snake_case` convention; MT-D24 adopts it.

Cross-spec reconciliation results (2026-09-02):

1. View VD-D6/VD-D8 accepts the polymorphic Mesh values and retains upper-layer
   persistence/bookmark/undo ownership.
2. Draw DR-D13 cites MT-D12 and shares one browser gate.
3. Pointcloud PC-D10 records Mesh readiness and the breakline hand-off while
   retaining inspection ownership.
4. File FP-D5/FP-D6 admits `hcad.volume-report.csv@1` through plan/execute.
5. REGISTRY contains the pre-batch-2 and batch-2 Mesh rows, the common recipe,
   and schema-matching command spelling; §10.5 records the final transaction.

## 9. Disposition — adversarial review (2026-09-02, findings 1–16)

| Finding                                                       | Disposition                                                                                                                                                                                                                                                           | Spec section / decision                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1 — crossing Z and unsafe bulk fixes (blocker)                | Resolved in normative workflow: both Z values shown; surveyed/agreed split only is automatic; otherwise explicit line choice with default none or unresolved Commit block; Apply all safe cannot change truth/membership. W5 is cited only for its actual convention. | §2.1; MT-D3, MT-D16; tests §6                                    |
| 2 — heavy draft persistence and restart (blocker)             | Resolved: lightweight manifests and journal refs over content-addressed job artifacts; deterministic checkpoints/resume, discard/GC, publication boundary, cancel/resource/completion budgets and G-MT-5.                                                             | §2.1, §3.1 C4/D1; MT-D2, MT-D10, MT-D17                          |
| 3 — View render-style ownership (blocker)                     | Resolved reciprocally by adopting VD-D8's two-layer ownership unchanged and defining only Mesh lower-layer values; VD-D6/VD-D8 now accept the polymorphic Mesh values and ownership boundary.                                                                         | §1.2, §2.4, §3.2; MT-D6; VD-D6/VD-D8; §8.1                       |
| 4 — volume datum/accuracy/export (blocker)                    | Resolved: project-Z label, CRS admission/refusal, sign, valid footprint/NoData, f64 robust overlay-prism interval, computational-vs-source accuracy copy, full report provenance, and shipping CSV through File Export.                                               | §2.3, §3.5, §7.6; MT-D8, MT-D20; §8.4                            |
| 5 — one-sided hand-offs/registry/difference ownership (major) | Resolved reciprocally: RA-D5/RA-D7 arrivals, PC-D10 ownership, MT-D12↔DR-D13, File report admission, and the Registry rows are all landed; the clean registry restores `specified`.                                                                                   | §1.1–1.3; MT-D12/MT-D14; §8.2–5; cross-spec reconciliation table |
| 6 — source lifetime/update/removal (major)                    | Resolved with indexed IF-D4 reverse relations, matched-update supersession, removed-source choices, detached immutable revision, Keep-as-local default, missing rebuild refusal and late-publication CAS.                                                             | §3.1 E2; MT-D4, MT-D19                                           |
| 7 — draft undo and one anonymous session (major)              | Resolved with stable named coexisting drafts, Suspend/Resume/Discard, draft-local undo/redo, grouped safe-fix step, distinct global source history, and automation parity.                                                                                            | §2.1, §3.1 B1/B2/C4; MT-D1, MT-D18                               |
| 8 — 500M/20-minute extreme absent (major)                     | Resolved with automatic manual-preview threshold, recorded sampling limits/honesty, bounded streaming/RSS/disk, real progress/cancel/restart and named G-MT-5; G-MT-3 retained as calibration.                                                                        | §2.1, §3.1 C3/D1/E2, §6; MT-D17                                  |
| 9 — contour deliverable incomplete (major)                    | Resolved with DR-D4 exact layer, explicit style refs, complete provenance/stale triggers, atomic regenerate restore set, failable E1 criterion and DXF plan/round-trip verification.                                                                                  | §3.3, §7.7; MT-D7, MT-D21                                        |
| 10 — entity-class overclaim and absent 3D repair (major)      | Resolved by `mesh.edit-terrain` Tin-only + RA-D7 Grid conversion and separate shipping `mesh.edit-3d` Add/Remove/Fill contract including materials/UV/manifold/resource extremes.                                                                                     | §1.2, §2.2, §3.1; MT-D22                                         |
| 11 — evidence integrity (major)                               | Resolved: import lifecycle, BVH refine/tests and full LandXML writer citations corrected; IFC/DXF semantics narrowed; SLPK texture evidence separated and Builder frame marked unverified; wireframe absence scoped first-party Builder.                              | §1.2, §2.4, §3.1 A3/E2, §3.2, §3.7, §5; MT-D12, MT-D13           |
| 12 — simplification metric/invariants/scope (major)           | Resolved with type-specific certified errors/invariants, exact clipped boundary, same-type output, requested/achieved values and adversarial gates.                                                                                                                   | §3.6; MT-D23; §6                                                 |
| 13 — placement semantics and stale products (major)           | Resolved by citing SE-D3/SE-D11; rebuild preserves placement/name/layer/style/lock; placement invalidates world products and derivatives; gizmo preview never remeshes; tests cover move/stale/rebuild/undo.                                                          | §1.1, §3.1 C4/E2; MT-D4, MT-D7, MT-D19                           |
| 14 — unstable command naming (minor)                          | Resolved in the 2026-09-02 registry rebuild: F8 selects the schema's dotted lower-case/`snake_case` convention and the catalog adopts it; uniqueness/staleness checks pass.                                                                                           | §1.2; MT-D24; §6; §8.5                                           |
| 15 — one-frame remesh contradiction (minor)                   | Resolved: one frame applies only to constraints/marker/row/stale state; old preview remains marked stale; registered remesh publishes atomically under job budgets.                                                                                                   | §3.1 D1, §6 component gate, §7.4                                 |
| 16 — 40-surface batch idea (idea)                             | Deferred until single-surface correctness and G-MT-5 pass: no dossier/observed repetition yet justifies a new batch/preset surface; P1 permits a named preset when repeated use proves it. Automation can loop exact commands meanwhile.                              | MT-D14 backlog boundary; X3, P1, completion discipline           |

## Cross-spec reconciliation 2026-09-02

| Item                      | Disposition                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raster                    | MT-D6 cites RA-D5 for ramp/hillshade and accepts the Raster-tab fan-in; RA-D7 arrivals receive Mesh edit/display/snap/contour/volume semantics.                                                                        |
| Draw                      | MT-D12 and DR-D13 cite each other and share one terrain-snap gate.                                                                                                                                                     |
| View                      | VD-D6/VD-D8 admit Mesh realistic/abstract/wireframe/shaded-edges values while retaining upper-layer ownership.                                                                                                         |
| Pointcloud                | PC-D10 records Mesh readiness and breakline hand-off; inspection stays Pointcloud-owned.                                                                                                                               |
| File                      | FP-D5/FP-D6 register `hcad.volume-report.csv@1`.                                                                                                                                                                       |
| PhotoLab product arrivals | IF-D19/IF-D23/IF-D25 open Surface3d and closed Object3d products become ordinary Mesh entities without a recipe unless Mesh re-publishes a reproducible derivative; IF-D20 remains the sole generated import exposure. |
| P10/G12 dependency        | MT-D25 is the sole common envelope/transition/command record; DR-D20/CIV-D15/RA-D15/BS-D24 supply typed output obligations and SE-D20/IF-D18/FP-D22/AG-D22 cite it reciprocally.                                       |
| Semantic cursor           | Mesh/Terrain cites UIP-D24/§9.7 and declares pick/snap/Fangkreis, crop handle, prohibited, and wait in the main viewport; its dedicated form window uses ordinary form cursors.                                        |
| GAP §6 Civil inbound      | MT-D1–MT-D5/MT-D12/MT-D17/MT-D19 are amended by MT-D25/MT-D26 citations to CIV-D5/CIV-D9/CIV-D15 for typed manifests, source lifetime, draft persistence, and sole Mesh publication.                                   |
| Re-walk 2026-09-02        | Complies with P5/P6 and current C4/D1/X3/B1/A2 rules; draft gestures publish once, long work checkpoints/restarts, and no office convention is mandated (P7).                                                          |

## 10. Owner statements batch 2 — revised after adversarial review 2026-09-02

This section is normative and more specific than earlier text where they conflict. It amends the boundary, §2.1,
§3.1/§3.8, MT-D1–D5/D7/D8/D16/D17/D19/D20, and the catalog. Mesh remains the sole owner of surface drafts,
Check, Mesh-owned geometry jobs, and checked surface/solid publication. Pointcloud PC-D17 owns immutable mean-grid
sampling, BIM BS-D25 owns observed borehole-stratum semantics, Select/Edit SE-D19 owns P9 eligibility, Plan PE-D21 and
Measure MI-D14 are passive consumers, and Raster RA-D14 owns the signed difference Grid/legend. GAP-D7 governs the
extended Mesh workspace; GAP-D8 governs the report/solid/raster ownership split.

### 10.1 MT-D25 — the common derived-recipe contract

MT-D25 applies only to an output produced by a reproducible mapping. A directly authored object or an imported object with
no admitted mapping has no recipe. Every derived output or atomic output group has exactly one persisted
`hcad.derived-recipe@1` envelope:

```text
DerivedRecipeV1 {
  recipe_id, recipe_kind, schema_version = 1, generation,
  state: linked-current | linked-stale | regenerating | detached | error,
  output_group_id,
  outputs[{slot_id, role, output_id, type_id, locator,
           current_revision, current_content_hash, status: present | empty}],
  sources[{entity_id, revision, content_hash, placement_revision, role}],
  parameter_type_id, parameters, algorithm_id, algorithm_version,
  dependency_recipe_ids[], stale_causes[],
  last_success{generation, source_fingerprint,
               outputs[{slot_id, output_id, revision, content_hash}], completed_at},
  last_error{code, phase, message_key, source_refs[], error_list_ref}?,
  detach{cause: manual | source_missing, source_refs[], detached_at_generation}?
}
```

`recipe_id`, `output_group_id`, every output `slot_id`, and every reserved `output_id` are stable. A one-output derivative
has one slot. A multi-output recipe, including Cut/Fill, retains its role slots across regeneration; an empty sign class has
`status: empty`, publishes no entity, and keeps the reserved id so that a later non-empty generation does not change identity.
The ordered source references include identity, exact entity revision, content hash, placement revision, and a typed role.
Parameters are a versioned typed payload, not an untyped JSON convention. The last-successful set is the last good baked
product; `linked-stale`, `regenerating`, and `error` keep it visible with the product badge specified in §7.10.
`generation` is strictly monotonic and never reused. Undo/redo restores a prior logical snapshot as a new generation; it
does not roll the counter backward, and `last_success.generation` continues to identify the generation that produced the bake.
Initial creation publishes the envelope and output group together only after Check succeeds, so a canonical recipe always has
`last_success`; a failed first creation remains a recoverable draft/error list and publishes neither recipe nor output.

One project service owns a reverse index from source/output/recipe ids and one recipe DAG. Every create, relink, source-edit,
import replacement, automation transaction, source deletion, undo, and redo validates expected revisions and the DAG in
command preflight; any cycle rejects the whole command. Source/placement or dependency-generation changes invalidate once at
gesture/transaction end, never per frame. A regeneration starts from an immutable source snapshot and publishes only after
CAS of project id, recipe generation, all source revisions/content/placements, dependency generations, algorithm/schema
versions, and every current output revision. Failure moves to `error`, records the domain's typed creation error list, and
retains `last_success`; no partial output group becomes reachable.

P10's transitions are exact:

- successful creation or regeneration → `linked-current`; a relevant settled change → `linked-stale` with typed causes;
- automatic regeneration is a system-authored journaled transaction only within the owning spec's X6 budget; otherwise the
  product remains Stale until explicit or batched regeneration;
- `derived.recipe.detach` removes dependency edges, sets `detached`, keeps every recipe field and last-good hash as
  provenance, and never edits or deletes a source;
- committed source loss runs the same journal service, auto-detaches with `cause: source_missing`, preserves the last good
  output, and writes a console event naming recipe, missing source/revision, output group, and Relink action;
- `derived.recipe.relink` supplies an exact replacement mapping, validates types/revisions/DAG, journals the new edges, and
  enters `linked-stale`; successful regeneration is separate unless it fits the owning automatic budget;
- reload validates schema, hashes, edges, source identities, recipe generation, and any resumable job before showing
  `linked-current`. A valid persisted job may restore `regenerating` as **Paused after restart**; otherwise it becomes
  `linked-stale` or `error` with an explanation, never silently current.

The one canonical surface is `derived.recipe.get`, `.list`, `.regenerate`, `.regenerate_batch`, `.detach`, and `.relink`.
Reads are bounded/paged; mutations require recipe generation and expected output/source revisions. Automatic regeneration,
explicit/batched regeneration, Detach, auto-detach, and Relink are journaled document transactions. One batch is one undo
root with stable per-item results. Undo/redo restores as one affected-state set: the prior logical recipe state/stale causes/
error and detach metadata as a new monotonic generation; all dependency/reverse-index edges; output slots and entity
revisions; last-success refs/hashes; layer/
style/specification ids owned by the output, report/Plan/reverse relations, and resumable checkpoint reachability. Camera,
selection, display history, and unrelated sources are exempt because P8 owns them separately. Recipe, draft, active job,
checkpoint, journal undo, named snapshot, pinned Plan capture, and retained report refs are physical GC roots for immutable
artifacts; peak disk follows MT-D17/MT-D31 and roots release only when their undo/snapshot/consumer reachability ends.

All domain drafts are output-local and never modify sources. A source edit is a separate owning-domain command with its own
eligibility/confirmation and then invalidates recipes at transaction end. MT-D25 guarantees the envelope, index/DAG,
transitions, common commands, journal/CAS behavior, last-good/error rules, persistence/reload validation, batch semantics,
restore set, and heavy-artifact roots. A consuming spec supplies only:

| Consumer obligation   | Required domain-specific content                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Typed meaning         | `recipe_kind`, typed parameter schema, ordered source roles, output slot/type/locator semantics, algorithm/schema versions                |
| Correctness           | complete creation/check error list, admission rules, and stale triggers beyond source/dependency revision and placement                   |
| Cost                  | an explicit live/automatic regeneration budget (including zero), estimate, long-job threshold, partition/checkpoint key, and extreme gate |
| Editing               | inverse mapping or explicit `none`; whether direct output edits require Detach; exact pending-edit view-switch confirmation scope         |
| Presentation/exchange | layer/style/specification preservation, Properties copy, export/loss rules, and passive consumers                                         |

Mesh supplies these values as follows. Surface Tin automatic regeneration is allowed only when the estimator predicts
≤ 50 ms worker CPU, ≤ 16 MiB additional RSS, no external sampler, and a clean deterministic Check; otherwise it is explicit.
Hull uses the same budget and additionally requires ≤ 10,000 captured samples. Contours, volume reports, canonical
simplifications, Cut/Fill solids, and strata solids have an automatic budget of zero because they are audited or separately
specified deliverables. Mesh has
no inverse from output topology to sources: starting direct topology edit on a Linked surface/hull/solid offers **Detach and
edit** or **Cancel**; placement/style/specification edits are output overrides preserved by regeneration and do not edit a
source. View-switch confirmation occurs only for an open draft with pending edits, never for staleness alone. Surface stale
triggers additionally include role/exclusion/boundary/sampler/evaluator changes; hull triggers include sample/tolerance scope;
solid triggers include evaluator/boundary/sign/specification/topology parameters; strata triggers include set/catalog/datum/
method/host revisions. All use their creation error list for regeneration.

**MT-D25 — One common recipe envelope and transition service governs derived entities.** **Decision:** the envelope,
responsibility split, operations, transitions, CAS, restore set, persistence, and budgets above are the complete common P10
contract cited by Draw, Civil, Raster, BIM, and Mesh. DATA-MODEL and PROJECT-FORMAT must admit this exact envelope before an
implementation claim; domain-prefixed UI/console spellings may adapt to the common ids but may not define another transition
machine. **Derivation:** P10's complete current text; P5; C4 heavy-undo retention; X1–X3/X5–X7; S14/G12; SE-D20, FP-D22 and IF-D18
consumer contracts. **Rejected:** Civil's richer private envelope as a second common truth; one recipe per directly authored
object; gesture-only invalidation; cascade deletion; provenance loss on Detach; implicit relink; partial multi-output publish;
domain-specific lifecycle commands. **Tunable:** owning automatic budgets, batch/page ceilings, checkpoint threshold, and
retention horizon under X6; identities, transition atomicity, DAG/CAS, and restore membership are not tunable.

### 10.2 MT-D26 — source roles, eligibility, exclusions, and boundaries

Every UI and automation admission calls SE-D19 and stores its cause explanation. Hidden and Inert rows are ineligible;
Reference and Editable rows may be immutable recipe inputs; only Editable sources may receive the separate confirmed
**Apply fix to source** command. Check and publication re-evaluate eligibility. If an ancestor/layer/kind/project state changes
while the draft is open, the row and last-good preview remain but show **Ineligible — <cause>** and publication blocks until
the state is restored or the row is removed. Mesh adds no visibility/lock store. A later P9 display-state change does not
rewrite an already published recipe's captured source set (P8); it controls selection/edit eligibility and blocks a new
regeneration while required sources are currently ineligible. Import/source revision changes still stale through MT-D25.

The five source roles are exact:

- **Points** contribute their authoritative finite XYZ.
- **Breakline** retains every authored XYZ vertex and deterministically tessellated curved segment as a hard constrained TIN
  edge; every resulting segment must be a triangle edge.
- **Form line** is soft height control: retain every authored authoritative XYZ vertex and add deterministic curve samples to
  the point set, but constrain no segment and clip no boundary. Analytic extrema are retained; recursive tessellation stops
  only when maximum XY chord deviation is ≤ 10 mm and sample spacing is ≤ 1 m (recorded X6 defaults). Form samples live in
  `hcad.mesh-source-roles@1` with curve/revision/placement/tolerance/sample hashes, never in Tin `breaklines`.
- **Outer boundary** clips outside; **Hole** clips inside. Their project-XY topology and derived drape are recorded.

Draft and committed recipe operations add/remove/re-role all roles, including `mesh.surface.edit.add_form_line`,
`.remove_form_line`, and `.set_source_role`; exact source revisions are captured, draft undo groups a role change, and source
geometry remains unchanged. Native project round-trip preserves the associated role resource. LandXML/DXF export may emit
Form line as ordinary 3D linework only after a loss plan says its soft-role/tessellation semantics are lost; re-import never
silently upgrades it to Breakline or Form line. Rendering, selection, and snapping distinguish Form line from Breakline in
the draft; after publication only the role overlay is optional presentation and the baked TIN is authoritative.

Exclusions operate over immutable admitted point/sample ids and are a deterministic set union, not sequential mutation:

- `outside_outer_boundary`: exclude points strictly outside the active project-XY valid outer components; points on a
  boundary within the recorded XY tolerance remain admitted;
- `within_breakline_distance(d)`: exclude points whose project-XY shortest distance to the selected exact/tessellated
  Breakline geometry is `<= d`; Breakline constraint vertices themselves remain admitted;
- explicit row/point exclusions join the same union. Each rule shows its gross count, overlaps with every other rule, and the
  net union count; row order is presentation only. Recompute uses exact role/source/evaluator revisions. Nothing writes the
  Pointcloud; a cloud edit requires its own confirmed Pointcloud command.

**Auto boundary** is deterministic: build the checked provisional project-XY TIN, discard every triangle with any XY edge
longer than the typed maximum, polygonize the union of the remaining triangles, retain all outer component rings and their
inner holes, and derive boundary Z from those accepted TIN edges. No valid triangle blocks Check; no largest-component guess
silently discards islands. The recipe stores the 2D rings, derived 3D rings, parameter, input fingerprint, and component/
excluded counts.

**Draw crop boundary** stores a closed project-XY 2D polyline, exact evaluator id/revision, and its derived draped 3D boundary.
The evaluator splits every segment at known TIN edges, Grid/mean-cell edges, discontinuities, and NoData boundaries, then
adaptively subdivides until both XY chord length ≤ 0.50 m and midpoint-vs-linear Z error ≤ 0.01 m (recorded X6 defaults).
Any ambiguous or NoData interval blocks Check and becomes a typed error interval linked bidirectionally to canvas and list;
endpoints alone can never validate the segment and ambiguity is never averaged. Closure snaps only inside a recorded 1 mm XY
tolerance; fewer than three distinct vertices, a closing sliver/edge below tolerance, area ≤ tolerance², self-intersection,
or incompatible CRS/evaluator blocks. The complete 2D curve and derived samples persist; evaluator revision change marks the
preview/recipe stale. Crop gesture focus follows §3.8 exactly.

Typed Civil corridor/pit manifests populate the same role table with exact semantic/source revisions under CIV-D5/CIV-D9;
they never bypass Check or create a Civil publication act. Cloud rows use PC-D17's Spatial step, Existing point nearest cell
mean Z, or Synthetic cell center at mean Z with pre-Run count/time/RSS/disk estimates and immutable product hashes.

**MT-D26 — Mesh owns one non-destructive, P9-admitted surface draft contract.** **Decision:** the role topology, Form-line
sampling/resource, set-union exclusions, auto boundary, fully draped crop, P9 rechecks, Civil manifest admission, commands,
and source-immutability rules above extend MT-D1–D5/D16/D17. **Derivation:** S7/S9/S10; GAP-D7/GAP-V7/GAP-V8; X1/X3/X5;
P4/P5/P9/P10; C1/C2/E2; SE-D19/UIP-D20; PC-D17/PC-D18; Civil CIV-D5/CIV-D9; Draw DR-D17. **Rejected:** aliasing Form line
to Breakline; soft lines in Tin `breaklines`; sequential exclusions; endpoint-only crop validation; largest-component auto
boundary; editing clouds/sources from a draft; Mesh-local P9 state; separate Civil publication. **Tunable:** Form/crop chord,
spacing/Z/closure tolerances, exclusion distance, maximum auto-boundary edge, and restart partition size under X6; role
semantics, boundary equality, set-union logic, and source immutability are not tunable.

### 10.3 MT-D28 — two explicit convex-hull outputs

One assistant captures a P4-scoped, SE-D19-eligible revision/placement set and lets the user select either or both outputs.
Points contribute authoritative XYZ. Curves contribute exact authored vertices, analytic extrema supported by their curve
kind, and deterministic samples with a typed maximum 10 mm chord error and 1 m spacing defaults; the UI states that the hull
is of this recorded sample set, not an unbounded claim about an unsampled analytic curve. A closed loop contributes the
closing position once; its repeated endpoint is handled by the same dedup rule. Coincident samples are deduplicated
within a typed 1 mm project-space tolerance after a deterministic stable-id tie break, and input/unique counts are shown.

- **2D footprint** is the mathematical convex hull of sample project XY and publishes `hcad.area@1` with no holes. One point,
  two points, or all-collinear XY publishes no Area and reports the exact degeneracy. Three or more non-collinear XY samples
  publish even when their Z values differ because this output is explicitly a project-XY footprint.
- **3D hull surface** is the true spatial convex hull of the authoritative XYZ sample set and publishes
  `hcad.surface-3d@1`. At least four non-coplanar unique samples produce a closed, outward-oriented manifold triangle boundary
  (`closed_manifold = true`). Three or more non-collinear coplanar samples produce a planar triangulated Surface3d with no
  fabricated thickness and `closed_manifold = false`. One/two/collinear samples produce no Surface3d. Stable face/part ids
  derive from output slot plus sorted supporting sample ids; changes disclose remaps rather than selecting a neighbor.

Preview uses the same deduplicated samples and predicates as final creation; display decimation may reduce drawn edges but the
UI labels it and numeric area/degeneracy comes from final predicates. Estimates name sample count, predicted time/RSS/disk,
bounded/long class, and tolerance before Run. Check captures exact sources/placements/tolerances and refuses stale or
ineligible inputs. The two outputs are independent recipe slots and atomic when requested together: either all requested
non-degenerate outputs publish or none; a deliberately unrequested/degenerate slot is reported, not silently missing.

**MT-D28 — Convex hull means project-XY Area and/or spatial sample hull Surface3d.** **Decision:** the types, sample
contract, degeneracies, coplanar behavior, identity, preview fidelity, and atomicity above define the assistant. **Derivation:**
S11; X1/X3; P4/P9/P10; canonical Area/Surface3d types in `entity_model.rs:30,33,372-381,440-454,1085-1094`; MT-D25.
**Rejected:** one ambiguous "3D hull surface"; fabricated thickness for coplanar input; a Solid merely because the hull is
closed; hull of unspecified curve interiors; success with an empty entity. **Tunable:** sampling/dedup tolerances, bounded
threshold, and preview display LOD under X6; mathematical output/type and no-thickness rule are not tunable.

### 10.4 MT-D29/MT-D30 — signed and strata solids

#### Signed Cut/Fill overlay

`mesh.solid.create` captures evaluator **A** and **B**, optional project-XY host boundary, exact revisions/placements/datum,
and the sign `delta = z_A - z_B`. `delta > epsilon` is **Cut** with A as top and B as bottom; `delta < -epsilon` is
**Fill** with B as top and A as bottom;
`abs(delta) <= epsilon` is zero thickness and belongs to neither. The assistant always displays A/B labels, sign, epsilon,
and a Swap action. Cut and Fill each require their own specification id, layer, and style before Check. One shared signed-
overlay recipe has stable Cut and Fill output slots and atomically publishes up to two `hcad.object-3d@1` entities backed by
`SolidGeometry::ClosedMesh` (`entity_model.rs:819-849,1103-1104`). Empty Cut or Fill publishes no entity, keeps its stable
slot/id, and reports **No Cut** or **No Fill** with evaluated area.
If both sign classes are empty, Check reports **No solid volume in the valid footprint** and Create publishes no recipe or entity.

The valid footprint is the intersection of A-valid, B-valid, and the optional host boundary, minus all input/host holes and
NoData regions. Evaluator topology edges and all `delta = +/-epsilon` crossings split the overlay; no sign is inferred across
NoData. Every connected component is a stable named part of its sign solid. For each part, the appropriate evaluator patches
form top and bottom, crossing curves meet at zero, valid-footprint/NoData/hole rings receive side walls, and all faces are
tessellated, welded, outward-oriented, and proven closed two-manifold before publication. A non-manifold edge, unresolved
crossing, ambiguous vertical value, open cap, or incompatible CRS/datum is a creation error and blocks the entire group.
Part ids derive from the output slot plus the canonical sorted boundary support/cell ids. An unchanged component keeps its
id; a split/merge receives deterministic new ids and publishes the old→new/removed remap so downstream selection never
silently lands on a neighboring component.

When either side is PC-D17 **Synthetic cell center at mean Z**, the authoritative cloud evaluator is the piecewise cell mean:
each valid cell contributes that mean-Z face; cell edges, NoData edges, and mean discontinuities are explicit topology.
Deterministic cell faces, vertical step faces, and boundary tessellation are derived storage needed for ClosedMesh only; no
triangle-interpolated cloud height may replace a mean. The other evaluator may be tessellated inside each cell, but every
sample/provenance record retains the mean cell id/count/variance/hash. MT-D8's numeric report is an optional separate query/
record and may cross-check volume; it is never an output slot or label of the solid recipe.

**MT-D29 — One checked overlay publishes separately specified Cut and Fill solids.** **Decision:** the sign, footprint,
topology, types, stable parts/empty slots, cloud storage derivation, specifications, and atomic replacement above are exact.
**Derivation:** S11; GAP-D8/GAP-V9; X1/X3/X5; P10; PC-D17; canonical ClosedMesh; MT-D8/MT-D20/MT-D25. **Rejected:** one
mixed-sign solid; one shared specification; swapping sign silently; NoData-as-zero; partial Cut without Fill on failure;
triangle-interpolated cloud truth; relabeling a report as geometry. **Tunable:** epsilon, overlay cell/tessellation tolerance,
and worker budget under X6; A-B sign and separate specifications are not tunable.

#### Borehole-strata solids

A strata recipe requires an explicit project-XY host boundary, one exact validated BIM `BoreholeStratumSet@1` revision,
catalog/specification revisions, a declared project horizontal/vertical CRS and datum transformation version, and an explicit
interpolation method with versioned parameters. Datum mismatch or an absent declared transform blocks; Mesh never invents a
collar elevation or datum offset. The UI default, persisted as an explicit choice, is `hcad.strata.interface-tin@1`: for each observed interface, build a
deterministic project-XY TIN from at least three non-collinear finite collar observations, resolving cocircular predicates by
lexicographic stable observation id as the recorded Delaunay tie rule.
Its support is that interface's 2D collar convex hull clipped by the host boundary. A stratum's support is the intersection of
its top and bottom interface supports and host boundary; outside is NoData, never extrapolation.

Different interface counts are allowed only through explicit missing flags: each published cell still requires both bounding
interfaces. Duplicate/inverted observations, undeclared faults/discontinuities, missing support inside the claimed support,
or top/bottom crossings beyond tolerance block the affected stratum job and therefore atomic group publication. Deterministic
pinching is allowed only where the two interpolated bounding interfaces meet within the recorded Z tolerance; the boundary is
clipped there and no negative thickness is flipped. One borehole never silently becomes an interpolated region. A separate
explicit `hcad.strata.constant-extrusion@1` method may use one borehole only when the user supplies a typed closed host boundary;
it carries that observation unchanged across the boundary and is labeled **Constant extrusion from one borehole — derived**.
It is never an automatic fallback.

The command atomically publishes one `hcad.object-3d@1` ClosedMesh per non-empty stratum, each with the BS-D25 specification,
stable stratum output/part ids, layer/style, outward manifold proof, and a shared recipe. Provenance retains every observation
id/revision/content hash, collar transform, uncertainty/missing flags, support hull, method/version/parameters, catalog/spec
revision, and output cells. Properties and exports say **Interpolated/derived from observations**, never observed. Absent
observations never become vertices or interfaces.

**MT-D30 — Strata geometry is explicit bounded interpolation, never invented geology.** **Decision:** host, support,
datum, minimum observations, normal TIN method, one-borehole opt-in method, pinch/block rules, one-solid-per-stratum,
specification, and provenance above define v1. **Derivation:** X1/X3; S11; GAP-D8; P7/P10; BIM BS-D25's exact observed
semantic hand-off and stated dossier absence; MT-D25/MT-D29 topology rules. **Rejected:** automatic one-borehole fallback;
extrapolation outside collar hulls; filling missing interfaces; crossing correction by sorting; fault interpolation without
fault semantics; Mesh-owned office strata conventions. **Tunable:** interpolation/grid, collinearity, pinch, and equality
tolerances under X6; observed values/order, method selection, and no-extrapolation rule are not tunable.

**MT-D27 — Mesh owns checked hull/surface/solid publication, not all input semantics.** **Decision:** MT-D28–D30 are Mesh
computations and canonical commands; Pointcloud retains immutable sampling (PC-D17), BIM retains observed strata (BS-D25),
Raster retains signed difference Grid/legend (RA-D14), and MT-D8 retains the optional numeric report. This ownership derives
from GAP-D8, not GAP-D7. **Derivation:** S11; GAP-D8; X1/X3/X7; P10; PC-D17; BS-D25; RA-D14. **Rejected:** moving mean-grid,
strata semantics, or raster legend ownership into Mesh; calling a report or Grid a solid; inferred source semantics.
**Tunable:** no; concrete numerical budgets live in MT-D28–D31.

### 10.5 Registry and access delta

`mesh.create-surface` gains Form line, local exclusions, auto/crop boundaries, Civil manifests, and the common recipe actions.
`mesh.convex-hull` uses `mesh.hull.preview/create`; `mesh.solid-between` uses `mesh.solid.preview/check/create`. All long calls
return UIP-D10 job ids and use shared status/cancel. **Rebuild from sources…** and console `mesh surface rebuild` are retained
as familiar P6 access spellings but dispatch `derived.recipe.regenerate`; `mesh.surface.rebuild` is retired. Recipe recovery
is discoverable in Properties and the entity context menu; no shortcut is added. The Agent/Python schema mirrors common
recipe queries/actions and Mesh create/check calls, pages large lists, requires expected revisions, and cannot bypass Check.

The round-3 REGISTRY rebuild registers these rows, Civil and all batch-2 acts,
retires duplicate recipe/rebuild ids, and replaces Tab-candidate remnants with Tab/Shift+Tab fields,
Up/Down live candidates, and focused-list arrow exceptions. `G-B2-CATALOG` must scan duplicate semantic acts, missing mutation/automation parity, dangling
decision ids, contradictory guarantees, and mutual citations.

### 10.6 MT-D31 — calibrated batch-2 work and recovery

Before Run every job reports captured logical work, predicted time/RSS/temp disk, and whether it is bounded or long. Predicted
work `< 1 s` is bounded and shows busy state if perceptible; `>= 1 s` is a UIP-D10 job. Every long job shows first truthful
phase/unit progress within 500 ms, polls cancel at ≤ 250 ms units, acknowledges at ≤ 250 ms p95 and ≤ 2 s hard outside
the ≤ 500 ms atomic publication boundary, and publishes nothing on cancellation. Additional process RSS is bounded by
`min(4 GiB, 25% of physical RAM)` and peak staging disk by
`3 * (captured immutable input bytes + final output bytes) + 2 GiB`. Jobs predicted `>= 60 s` checkpoint; shorter work is
**Restart required** after crash. Completion includes verified topology/artifact hashes, prepared render/index data,
provenance, and one successful MT-D25 CAS journal transaction—not merely a finished compute kernel.

| Job class and extreme gate member                                                               | Completion budget on calibrated active tier | Deterministic partition/checkpoint key                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Surface/recovery: 500M logical cloud points, 500 Breaklines/Form lines                          | 20 min (existing G-MT-5/G-B2-MESH-RECOVERY) | recipe generation + sampler hash + source id/revision + spatial Morton tile           |
| Roles/exclusions/crop: 10,000 source rows, 1M curve vertices, 100,000 boundary/NoData intervals | 5 min (`G-B2-MESH-DRAFT-RULES`)             | draft/recipe generation + role/rule id + source revision + curve segment/spatial tile |
| Hull: 10M captured samples after curve tessellation/dedup                                       | 2 min (`G-B2-SOLID`)                        | recipe generation + sample-manifest hash + deterministic sample range/Morton bucket   |
| Signed solid: 100M evaluator cells, 1M sign crossings, 100,000 disjoint/hole/NoData rings       | 20 min (`G-B2-SOLID`)                       | recipe generation + evaluator hashes + host-boundary hash + overlay tile/sign         |
| Strata: 100,000 boreholes, 50 interfaces (5M observations), 100 strata outputs                  | 20 min (`G-B2-STRATA`)                      | recipe generation + set/method/host hashes + stratum id + spatial tile                |

Resume verifies every partition/input hash and discards only an incomplete partition. A settled source/import/recipe change
cancels or supersedes in-flight work; a late result fails CAS and remains unreachable. Independent immutable-revision jobs may
run concurrently; jobs sharing a draft or output group serialize. Atomic multi-output replacement is one journal root.
Weak hardware may reduce preview display LOD and worker parallelism first; estimates and completion time change, while
sampling formulas, role topology, sign, NoData, manifold checks, source responsiveness, and cancellation bounds do not.

**MT-D31 — Every batch-2 job has an extreme, resource bound, checkpoint key, and completion definition.** **Decision:** the
thresholds/table and MT-D17 recovery/publish invariants apply to recipe cascades, source rules/crop, hull, Cut/Fill, and
strata. **Derivation:** FUNCTION-CONTRACT D1/D2/E3; P5/P6; X1/X2/X6; MT-D17; UIP-D10/UIP-D11; GAP gate table. **Rejected:**
"very quickly" as acceptance; noun-only jobs; unbounded RAM; restart-from-zero multi-minute work; partial canonical results;
claiming prose gate names are runnable. **Tunable:** all numeric thresholds/resources/extreme sizes under X6; correctness,
progress truth, cancellation, checkpoint validation, and atomic CAS are not tunable.

No launcher for `G-B2-MESH-DRAFT-RULES`, `G-B2-MESH-RECOVERY`, `G-B2-SOLID`, or `G-B2-STRATA` currently exists under
`scripts/`; these budgets and E1 captures are explicitly **unverified** and block an implemented/release-ready claim until real
in-repo launchers/fixtures run. `G-B2-MESH-RECOVERY` includes the 500M PC-D17 mean-grid path; `G-B2-SOLID` includes analytic
planes, crossings, holes, disjoint/NoData/non-manifold, empty sign classes and cloud means; `G-B2-STRATA` includes ordered,
missing, crossing, pinch, datum, one-borehole opt-in, and absent-observation cases.

### 10.7 MT-D32 — batch-2 passive consumers and atomic restore

| Product                 | Canonical/admission and interaction                                                                                                                                                                                | Analysis/properties                                                                                                                                                                                                            | Persistence, exchange, Plan, automation, siblings                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hcad.derived-recipe@1` | Project metadata; never rendered, clipped, picked, snapped, selected, transformed, or sectioned. Properties/entity relations expose state/causes/actions; SE-D19 gates source/output edits, not recipe visibility. | Inspect ids, generations, sources, parameters, dependencies, last success/error, and recovery. Measure refuses recipe-as-geometry.                                                                                             | FP-D22 native round-trip/unknown-version preservation and GC roots; IF-D18 invalidates but never regenerates. Export either preserves the envelope or declares dependency loss. Plan does not capture a recipe alone. Paged common queries/actions serve Agent/Python. Sibling apps may read state but gain no Builder mutation UI.                                   |
| 2D hull                 | `hcad.area@1`; ordinary Area renderer/clip/P4 pick/snap/select and SE-D19 transform. Source P9 changes do not rewrite the capture; new regeneration rechecks eligibility.                                          | Measure area/perimeter; section consumes only where the View Area intersection contract exists, otherwise explicitly refuses. Properties show sample/tolerance/revisions and no-hole hull rule.                                | Native round-trip exact; DXF-like boundary export may lose recipe/sample semantics only through reviewed loss. PE-D21 exact/pinned or linked capture. Automation pages sources/parts. Shared Area renderer must not regress PhotoLab/WeltView; unsupported sibling admission is explicit.                                                                             |
| 3D hull                 | `hcad.surface-3d@1`; prepared mesh render/clip, face/edge/vertex pick/snap, entity select, SE-D19 transform; coplanar output remains open and has no volume semantics.                                             | View sections the mesh; Measure exposes surface area/bounds, not Solid volume. Properties disclose full-dimensional/coplanar state, support samples, stale/error.                                                              | Native exact; mesh-capable exports declare recipe/part loss; formats requiring a Solid refuse. PE-D21 capture and paged automation use stable parts. Shared Surface3d renderer/index paths preserve sibling behavior.                                                                                                                                                 |
| Cut / Fill              | Separate `hcad.object-3d@1` ClosedMesh entities in one group; solid renderer/clip, boundary pick/snap, entity/part select, SE-D19 transform after linked-output rules.                                             | View sections closed boundary; Measure returns each solid's geometric volume and provenance while MT-D8 remains separate. Properties show own specification/layer/style, sign, footprint, parts, empty peer slot, stale/error. | FP-D22 stores group/recipe/entities/parts/specs; IF-D18 invalidates on source replacement. Native exact; unsupported export refuses or explicitly offers tessellated-surface loss, never silently flattens. PE-D21 captures exact generation. Automation pages parts/errors. Sibling renderers admit canonical Solid or explicitly report unsupported, never omit it. |
| Per-stratum solid       | One `hcad.object-3d@1` ClosedMesh per stratum, with the same render/clip/pick/snap/select/transform contract as Cut/Fill.                                                                                          | View/Measure operate per solid. Properties add observed set, method, host/support, datum, uncertainty/missing/pinch, derived badge, and BS-D25 specification.                                                                  | Native set/recipe/solids exact; export must preserve stratum/spec/observation semantics or name every loss/refuse. PE-D21 exact capture; paged automation. BIM remains semantic owner and receives no geometry mutation from Mesh; sibling Solid behavior as above.                                                                                                   |

Least members are a three-point 2D Area, a three-point coplanar Surface3d, a one-part/one-cell Cut or Fill, and one explicitly
bounded constant-extrusion stratum. Largest members are MT-D31's extremes. Every row applies unchanged: a least member cannot
bypass type/manifold/specification checks and a largest member cannot disappear from picking, File, Plan, Measure, properties,
or automation merely because it is paged/resource-backed.

On settled source/import change, MT-D25 stales or auto-detaches the complete product. Render/pick/section/Measure continue to
read only `last_success` with the same Stale/Error badge; no consumer observes partial replacement. Pinned Plan captures and
reports keep the old immutable hashes as roots; linked captures become stale and recapture explicitly. One replacement/undo
atomically advances generation while restoring the prior recipe state/error/edges, all output entities and stable parts,
layer/style/specification ids,
last-good artifact refs, report/Plan links, reverse relations, and prepared render/pick hashes. Independent P8 histories and
unrelated entities remain exempt.

**MT-D32 — New products have explicit consumers and one multi-output restore set.** **Decision:** the matrix, extremes,
invalidation behavior, refusal rules, and restore membership above are the Mesh-owned E2/C4 contract. **Derivation:** E2;
C4; SYSTEM-001; X1–X3/X5; P8/P9/P10; FP-D22/IF-D18/PE-D21/MI-D14/AG-D22; MT-D25. **Rejected:** relying on type existence
without admission; partial replacement; silent exporter/sibling omission; Plan or Measure taking regeneration ownership;
GC of pinned last-good generations. **Tunable:** paging/preview LOD and retention horizon under X6; consumer type distinctions
and atomic restore membership are not tunable.

### 10.8 Verification and zero-owner-question dissolution

Verification adds exact Form-line-vs-Breakline topology and native/loss round trips; set-union exclusion gross/overlap/net
counts; long-edge crop crossings over TIN/Grid/NoData/discontinuity; auto-boundary islands; every SE-D19 state/cause and a
mid-draft change; UI/automation parity; all MT-D25 transitions, relink/inverses/undo/reload/DAG/CAS/error reuse/GC; hull
degeneracies and identity; separate Cut/Fill specs/parts/empty classes/cloud mean cells; strata support/datum/minimum/pinch/
missing/fault/refusal; consumer least/largest members; and multi-output restore with pinned Plan/report roots. §7.8–7.14 is
the in-repo failable batch-2 E1 artifact. MT-D31 names the unverified runnable-gate obligations.
The Form-line fixture assigns the same curved source first as Form line and then Breakline: Form line must change the admitted
height samples without forcing any segment, Breakline must force every tessellated segment as a Tin edge, and neither role may
clip the boundary.

No owner question survives. Form-line softness, boundary math, signed output, strata support, performance numbers, and
consumer/restore scope derive from X1/X3/X5/X6, P4/P5/P8–P10, S10/S11/S14, GAP-D7/D8, canonical types, and sibling owners.
The apparent question "which borehole interpolation truth should Mesh invent?" dissolves by refusing invention: v1 exposes
an explicit versioned TIN method plus a separately chosen constant extrusion and blocks when their declared prerequisites do
not hold. The apparent question "should audited outputs auto-update?" dissolves under X1/P10 by assigning a zero automatic
budget while retaining explicit/batched synchronization. These are derived, vetoable decisions, not escalation items.

### 10.9 Cross-spec cite-and-revise results and external gates (2026-09-02)

1. DATA-MODEL and PROJECT-FORMAT must admit `hcad.derived-recipe@1`, its reverse-index/persistence rules, and the Mesh
   `hcad.mesh-source-roles@1` associated resource before implementation; strict readers preserve unknown versions or fail
   closed as FP-D22/IF-D18 require.
2. **Applied:** Civil CIV-D15, Draw DR-D20, Raster RA-D15, BIM BS-D24,
   File/Import, Agent, and this MT-D25 record use the common ids and split owner payloads from the one lifecycle.
3. **Applied:** REGISTRY contains the Civil/new Mesh rows, common recipe operations,
   retired `mesh.surface.rebuild`, and the settled Tab/Up/Down/focused-list map.
4. **Applied:** Raster RA-D14 and BIM BS-D25 cite GAP-D8 and their named gates;
   GAP-D7 remains scoped to MT-D26. The standing reciprocal/dangling checks are clean.
5. Implementation must add real in-repo launchers/fixtures for the four MT-D31 gates and commit the §7 batch-2 capture set;
   until then the promises remain unverified, not silently passed.

| Work-order item                                          | Disposition                                                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| S7/S9 Civil corridor/pit manifests                       | Applied by MT-D26; Civil derives semantics, Mesh checks/publishes.                                  |
| S10 roles, exclusions, auto-boundary/crop, mean sampling | Applied by MT-D26 with PC-D17 and SE-D19.                                                           |
| S11 convex hull and solids, including cloud/strata sides | Applied by MT-D27–D30; MT-D8 report and RA-D14 Grid remain distinct.                                |
| S14/G12 shared dependency                                | Applied once and completely by MT-D25; all domains cite and supply the listed consumer obligations. |

### 10.10 Disposition — batch-2 adversarial review (6 blockers, 7 majors, 1 minor)

| Finding                                                      | Disposition                                                                                                                                                                                                                                                                                                           | Spec section / decision                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1 — common recipe incomplete (blocker)                       | Resolved in normative text with the versioned envelope, stable multi-output identity, exact states/transitions, reverse index/DAG, CAS, common commands, reload, restore/undo, relink, GC roots, and consumer-vs-common responsibility split. Shared schema admissions are requested rather than edited out of scope. | §10.1; MT-D25; request 1–2                            |
| 2 — duplicate rebuild and lifecycle contradictions (blocker) | Resolved: one common regeneration act; familiar Mesh UI/console adapter retained; protocol duplicate retired; A3/C3/C4 and MT-D4 reconcile immutable last-good bake with live recipe; MT-D7 assigns audited outputs automatic budget zero.                                                                            | §1.2, §3.1 A3/C3/C4, MT-D4/MT-D7, §10.1/§10.5; MT-D25 |
| 3 — Form line unspecified (blocker)                          | Resolved as soft sampled height control distinct from hard Breakline, with deterministic tessellation, associated role resource, add/remove/re-role, draft/source behavior, render/snap/selection and export-loss contract.                                                                                           | §1.3, MT-D5, §10.2; MT-D26                            |
| 4 — crop/exclusions and key arbitration incomplete (blocker) | Resolved with project-XY 2D plus derived 3D storage, evaluator topology/adaptive drape, interval errors, closure/self-intersection rules, set-union/equality/count semantics, exact revisions, auto-boundary math, and settled focus/gesture ownership.                                                               | §3.8, §10.2; MT-D26                                   |
| 5 — Cut/Fill solid result underdefined (blocker)             | Resolved with A-B sign/epsilon, separate required specifications, stable slots/parts, empty classes, valid footprint/holes/NoData/crossings, cloud mean-cell authority, canonical ClosedMesh, manifold proof, and atomic replacement/undo.                                                                            | §10.4/§10.7; MT-D29/MT-D32                            |
| 6 — borehole solids invent geology (blocker)                 | Resolved with explicit host/datum/method, collar-hull support/no extrapolation, observation minimum, TIN and opt-in one-borehole methods, missing/crossing/pinch/fault rules, one specified solid per stratum, and derived provenance.                                                                                | §10.4; MT-D30                                         |
| 7 — convex hull ambiguous/no budget (major)                  | Resolved with separate Area/Surface3d outputs, authoritative sample contract, degeneracy/coplanarity/dedup rules, identities, preview/final parity, estimates and extreme gate budget.                                                                                                                                | §10.3/§10.6; MT-D28/MT-D31                            |
| 8 — P9 source eligibility absent (major)                     | Resolved by adopting SE-D19/UIP-D20 exactly for UI/automation admission, Reference/Editable input rules, recheck, and mid-draft state changes without a Mesh-local store.                                                                                                                                             | §3.1 C2, §10.2; MT-D26                                |
| 9 — performance/recovery uncalibrated (major)                | Resolved in text for every new job with thresholds, progress/cancel/resource/completion budgets, extremes, checkpoint keys, restart/CAS and degradation. Gate execution is explicitly deferred because launchers do not yet exist and implementation is outside this spec-only revision.                              | §10.6; MT-D31; request 5                              |
| 10 — passive consumers/restore missing (major)               | Resolved with a per-product E2 matrix, least/largest members, render/clip/pick/snap/select/transform/section/Measure/properties/File/export/Plan/automation/sibling/GC behavior and one atomic restore set.                                                                                                           | §3.1 E2, §10.7; MT-D32                                |
| 11 — Registry obligations/Tab contradictions (major)         | Resolved: Mesh-local duplicate ids and Tab/arrow claims are aligned, and the round-3 Registry records the rows and clean checks.                                                                                                                                                                                      | §1.2, §3.8, §10.5; request 3                          |
| 12 — dossier disposition stale (major)                       | Resolved by narrowing the RIB constraint row, revising horizons/soil layers to BIM→Mesh→report ownership, preserving W5/W7, and adding the dossier-wide batch-2 absence statement without manufacturing Trimble/RealWorks support.                                                                                    | §1.3; MT-D26/MT-D30                                   |
| 13 — batch-2 E1 artifact absent (major)                      | Resolved at spec level with committed written storyboards and exact fail criteria for both themes/scales/states, bound to named gates. Actual captures/launchers are explicitly unverified until implementation and block an implemented/release-ready claim.                                                         | §7.8–7.14, §10.6/§10.8; request 5                     |
| 14 — sibling derivations cite wrong GAP record (minor)       | Resolved reciprocally: MT-D27, RA-D14, and BS-D25 cite GAP-D8 and the named gates; GAP-D7 remains only for MT-D26.                                                                                                                                                                                                    | §10 introduction, MT-D27, §10.9 request 4             |

## 11. Owner batch 3 — 2026-09-02

This section promotes two S15 workflows and is more specific than §2.2,
§3.1, §3.6, MT-D11, and MT-D23 where they differ. It reuses, rather than
re-dispositions, the existing Mesh decisions: MT-D1's dedicated surface
workspace, MT-D2/MT-D18's recoverable draft and local history, MT-D3's typed
error list, MT-D4/MT-D25's immutable last-good recipe model, MT-D5/MT-D26's
hard Breakline and boundary roles, MT-D10/MT-D17/MT-D31's job/recovery
contract, MT-D12's exact surface picking, MT-D15's P4 capture, MT-D19's
dependency index, and MT-D23's certified type-specific error rules.

### 11.1 Catalog amendments (registry rows)

These rows amend the catalog; they do not create alternative lifecycle or job
commands. The familiar `mesh simplify` console spelling remains a P6 adapter.

| Id                   | Group | Access paths                                                                                                      | Surface                                                                   | Perf                                         | Canonical automation                                                                        | Status                                                                                                                              |
| -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `mesh.repair-region` | Edit  | ribbon **Repair region…**; Tin context **Repair region…**; console `mesh terrain repair <surface-id>`; automation | MT-D1 surface window, terrain repair mode + shared DR-D1 construction bar | continuous mark/preview; bounded→long repair | `mesh.surface.repair.preview`, `.check`, `.commit`, `.cancel` plus UIP-D10 status/cancel    | workflow-level, new; ElevationSurface Tin only (MT-D33)                                                                             |
| `mesh.simplify`      | Edit  | ribbon/context **Simplify…**; console `mesh simplify <surface-id>`; automation                                    | closeable right function panel + viewport preview + job                   | continuous parameter preview; long bake      | `mesh.simplify.preview`, `.check`, `.bake`; result lifecycle uses common `derived.recipe.*` | promoted from §3.6 contract level to workflow level for ElevationSurface Tin; Surface3d retains §3.6/MT-D23 contract depth (MT-D34) |

`mesh.surface.repair.commit` is the one document mutation for a repair. The
preview/check/cancel operations mutate only recoverable staging. The old broad
protocol id `mesh.simplify` is retired before schema/SDK freeze in favor of the
preview/check/bake lifecycle; the console alias remains and dispatches
`mesh.simplify.bake`. No callable placeholder exists before the workflows and
their checkers are implemented.

### 11.2 Workflow — mark and repair one terrain region

The user selects an editable `hcad.elevation-surface@1` Tin, opens **Repair
region…**, and sees the committed surface in the existing Mesh workspace. They
press **Mark region**. A temporary closed marking line is drawn with the shared
construction input bar from Draw DR-D1/DR-D17: every vertex can be picked,
constrained, or typed; the live rubber band and Cartesian/polar values stay
synchronized. The line is an operation-local construction object, not a Draw
entity and not a breakline. It is projected and validated against the exact
target-surface revision through MT-D12. The user can finish with Enter,
double-click, or the RMB tool-menu **Finish** entry; **Back one** and **Cancel**
complete the pair.

The closed line bounds the connected surface region to replace. The panel
shows triangle count, boundary length, source revision, hard constraints met,
estimated time/RSS/disk, and one of two explicit strategies:

1. **Excise and refill from marking-line heights.** Remove only the target
   triangles inside the marked region. Split intersected triangles exactly at
   the marking line, evaluate the unchanged surface height along every line
   segment and topology crossing, and triangulate the interior using those
   recorded boundary heights. Adaptive line samples stop only when both the
   typed maximum XY chord and maximum vertical interpolation error are met.
   There are no retained interior source vertices unless the user explicitly
   marks one **Keep as control point**.
2. **Fit surrounding triangle slopes.** Use an outside-only annulus of
   unchanged adjacent triangles with typed width, maximum residual, and
   smoothing strength. Fit a deterministic C0-continuous height field to the
   marking-line heights and weighted surrounding triangle planes, then
   triangulate it. The preview reports sample count, excluded/outlier triangle
   count, RMS/max residual, and whether the slope system is rank-deficient.
   Rank deficiency or residual above the typed limit blocks Commit; the tool
   never substitutes an average plane silently.

Both strategies preserve the exact outer/hole boundary, every hard Breakline
edge and vertex, and all geometry outside the closed marking line. **Preview**
is live in the MT-D25 sense: a source or parameter change marks the last-good
preview **Preview stale** at gesture end, starts automatic recomputation only
inside the §11.5 budget, and otherwise leaves an explicit **Update preview**
action. Preview computation is a temporary derived job keyed by target id,
revision, placement, marking-line revision, strategy, parameters, algorithm,
and evaluator versions. Its hashes may be restart-safe staging roots under
MT-D17, but it publishes no canonical recipe or entity.

The source cloud is never edited. The target surface is also unchanged during
marking, checking, preview, cancel, close, restart, or failure. **Commit
repair** first revalidates the exact target revision and every constraint, then
atomically swaps the verified Tin/prepared-index hashes as one journaled
command. A directly authored or detached Tin is updated in place. For a
MT-D25-linked Tin, launch offers **Detach and repair** or **Cancel**; choosing
the former records detachment and the geometry replacement in that same one
undo root while retaining the complete recipe as provenance. There is no
inverse mapping from the repaired topology to the cloud/breaklines. Ctrl+Z
restores the exact previous geometry, prepared indices, recipe state, and
reverse relations; Ctrl+Shift+Z reapplies them. The temporary line and local
preview history disappear after Commit, while Cancel/Discard leaves the
surface and source relations byte-identical.

Repair-specific Check rows reuse MT-D3's jump/pulse/fix grammar:

| Error class                              | Detection and consequence                                                                                                                                                                                            | Offered resolution                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `repair.region.crosses_breakline`        | The marking line crosses or encloses only part of a hard MT-D5/MT-D26 Breakline; smoothing would erase or kink authoritative feature geometry. Commit blocked.                                                       | edit the line; or **Split region at breakline**, which creates independently checked subregions and retains every breakline segment exactly |
| `repair.region.crosses_surface_boundary` | The marking line crosses an outer boundary or hole boundary, leaves the valid footprint, or traverses Grid/NoData after an invalid target conversion. Commit blocked. Touching at a proven shared vertex is allowed. | edit the line or select the exact valid boundary arc as part of the marking line; no clipping or outside height is guessed                  |
| `repair.region.invalid_loop`             | Fewer than three distinct vertices, self-intersection, repeated sliver, non-finite point, or no enclosed triangle. Commit blocked.                                                                                   | jump to the segment/vertex and edit, Back one, or Cancel                                                                                    |
| `repair.fit.underdetermined`             | The surrounding-slope annulus has too few independent triangle planes, crosses a discontinuity, or exceeds the typed residual. Commit blocked.                                                                       | widen/narrow the annulus, change typed tolerance, split at the discontinuity, or choose the marking-line strategy                           |
| `repair.source_stale`                    | Target geometry/placement, hard-role resource, or linked source revision changed after preview. Commit blocked; last-good preview remains visibly stale.                                                             | **Update preview** against current revisions or Cancel                                                                                      |

#### C1 and gesture arbitration

Every marking vertex and later vertex edit has the same DR-D1 typed twin. The
bar exposes project X/Y/Z, polar direction/length, and vertical Z/ΔZ/slope;
typed or constrained positions must resolve onto the selected surface within
the typed membership tolerance. **Use surface height** copies the exact current
surface evaluation and identifies that authority. A conflicting typed Z stays
invalid and visible; it is never projected silently. Annulus width, chord and
vertical tolerances, residual, smoothing strength, output name, and all
displayed numeric parameters are typed project-unit fields. Sliders are only
accelerators synchronized with those fields.

The focused surface canvas follows ui-platform §3.6; unlisted gestures retain
their platform meaning. This is the sole batch-3 Mesh construction claim and
amends §3.8 only while **Mark region** is armed:

| Gesture                              | Repair-mark meaning                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LMB click below threshold            | accept the current exact surface candidate as a vertex; this claims ordinary selection only while armed                                                                       |
| LMB drag on a visible marking vertex | move that one temporary vertex; its DR-D1 numeric fields update live                                                                                                          |
| LMB drag off a marking vertex        | platform orbit in 3D / pan in plan; never changes the line                                                                                                                    |
| LMB double-click                     | accept the candidate and Finish when the loop is valid; otherwise retain the draft and announce the error                                                                     |
| RMB click                            | platform tool menu with **Finish / Back one / Cancel** entries; no immediate mutation                                                                                         |
| RMB drag / MMB drag / wheel          | platform pan / pan / zoom, including with a partial line                                                                                                                      |
| Tab / Shift+Tab                      | focus/traverse only the shared construction-bar fields in the declared DR-D1 order; never cycle candidates                                                                    |
| Up / Down                            | cycle the stable surface/snap candidate set only while the UIP-D16 indicator is live; otherwise focused-control behavior                                                      |
| Enter / Backspace                    | Finish a valid loop / remove one temporary vertex                                                                                                                             |
| Escape                               | field revert → active vertex-drag revert → pending candidate clear → cancel the unfinished line → close the armed marking tool; one rung per press, never close the workspace |
| Typing                               | construction-bar entry wins focus; no shortcut fires                                                                                                                          |

Touch pointer equivalents follow ui-platform §3.6. `pointercancel`, focus loss,
project replacement, or target deletion restores the preceding valid preview
or cancels staging and never commits. Only one geometry-acquisition tool may be
armed; opening Draw, Select, Viewing Box, or another Mesh acquisition cancels
or is rejected through the central arbiter before it can receive a gesture.

### 11.3 Workflow — intelligent terrain triangle downsampling

The user selects one Tin and opens **Simplify…**. The panel shows the source
triangle/vertex counts, hard Breakline/boundary/hole counts, detected candidate
feature lines, P4 scope, and output name. The required **Maximum vertical
deviation** is typed in project units. An optional target triangle count or
ratio is best effort only. **Preserve hard breaklines and boundaries** is
locked on. **Preserve detected terrain features** defaults on and exposes typed
minimum slope-change angle, minimum feature length, and feature-merge distance;
detected ridge/valley/grade-change lines are explicitly labeled algorithmic,
not survey-authored Breaklines. The user may inspect and include/exclude those
candidate feature groups without altering the source.

**Update preview** runs deterministic constrained simplification over the exact
P4-captured footprint. Intersected triangles are clipped as MT-D23 specifies;
the clip edge becomes an output boundary. The viewport overlays retained hard
constraints, detected features, achieved triangle count, and a vertical-error
heat map with jump-to-maximum-error. A certificate proves the maximum absolute
vertical difference between original and candidate Tin over their shared XY
domain is no greater than the requested tolerance; sampled-only evidence is
insufficient. Outer boundaries, holes, Breakline vertices/edges, protected
feature chains, 2.5D uniqueness, and scoped extrema remain exact. If those
invariants prevent the requested count, the candidate succeeds at the higher
achieved count and explains why; the tolerance is never relaxed.

**Bake simplified surface** is the only publication step. It atomically creates
a new named `hcad.elevation-surface@1`, prepared render/pick indices, and one
MT-D25 `hcad.derived-recipe@1` with kind
`hcad.mesh.simplify-terrain@1`. Ordered sources contain the original Tin and
scope references; typed parameters contain error/count/feature policy and exact
constraint hashes. The immutable simplified geometry is its `last_success`
bake, linked by default; the source remains unchanged. Its automatic
regeneration budget is zero because the simplification is a reviewed
deliverable. Source change makes it Stale; **Regenerate**, **Detach**, and
**Relink** use only `derived.recipe.*`. Starting direct topology repair on the
linked result invokes MT-D25's **Detach and edit / Cancel** rule. Undo removes
the new surface, recipe, reverse edges, and prepared hashes as one root; redo
restores them without recomputation while their retained hashes remain GC
roots.

### 11.4 Function-contract answers

#### Region repair (`mesh.repair-region`)

**A1.** §11.2 is the complete user outcome. **A2.** This is owner S15/G13;
neither existing primary dossier row defines regional DGM smoothing, so no
reference behavior is claimed and no dossier row is re-dispositioned. RIB's
error-list/jump convention already adopted by MT-D3 supplies only the review
grammar, not either fill algorithm. **A3.** MT-D1 surface editing supplies the
workspace; DR-D1/DR-D17 supply line entry; MT-D25 supplies last-good/stale/CAS
semantics. Draw gains no entity and source Pointcloud commands are never called.

**B1.** Exact ribbon/context/console/automation paths are §11.1; no quick
surface or global shortcut. **B2.** Closing/re-toggling suspends a recoverable
preview; **Cancel repair** discards it; only **Commit repair** publishes. Escape
obeys §11.2 and never closes the workspace. **B3.** MT-D1's dedicated window is
required because line, errors, strategies, residuals, and before/after canvas
must stay visible together.

**C1.** §11.2's DR-D1 parity and typed strategy parameters. **C2.** One selected
Tin is captured at launch; later selection changes do nothing. P4 and SE-D19
are rechecked at preview and commit. **C3.** The immutable last-good preview is
the temporary bake; manual Update is available above budget. **C4.** Local line
and preview undo never enter the document journal; Commit is exactly one
journal root with the restore set stated in §11.2.

**D1.** §11.5; marking and parameter interaction are continuous, small previews
bounded, larger previews long-running and restart-safe. **D2.** Weak hardware
reduces preview tessellation/heat-map density first. It never changes exact
Check, the committed topology, residual/certificate, cursor response, or source
immutability. **E1.** The gate captures both themes at 100%/150%: orange
temporary line with direction marks, distinct hard Breakline, hatched replaced
region, before/after split, strategy/residual/error rows, stale-last-good state,
and progress/cancel. Any state that relies only on color fails. **E2.** Render,
pick/snap, section, contour/report recipes, Plan captures, File export, Measure,
tree/Properties, automation, and sibling viewers switch together only after
the CAS commit; dependents stale once, pinned products retain old hashes, and
no consumer observes a partial patch. Independent jobs may read the old
revision; repair against the same output revision serializes, while late
results reject. **E3.** §11.5.

#### Terrain downsampling (`mesh.simplify`)

**A1.** §11.3 is the full workflow. **A2.** Owner S15 promotes the already
specified, dossier-gap-declared §3.6 capability; no RealWorks/RIB behavior is
invented. **A3.** PC-D7/PC-D8 supply derive-don't-mutate precedent, automatic
render LOD remains distinct, and MT-D25 owns the derived lifecycle.

**B1.** §11.1; no shortcut or quick-surface entry. **B2.** Closing the panel
leaves a registered preview/bake job in UIP-D10; Cancel publishes nothing.
**B3.** A right panel is sufficient because inspection remains in the main
viewport and there is no separate error-edit canvas. **C1.** Every tolerance,
feature threshold, count/ratio, and name is typed; viewport legend/heat-map
values are read-only results with a jump action, not manipulation inputs.
**C2.** One Tin plus P4 scope is captured at Run; selection changes do not
retarget it. **C3.** Preview artifacts are reusable precompute and the Bake is
the natively fast immutable product. **C4.** §11.3 defines one create/undo root,
MT-D25 recipe state, and heavy-hash retention.

**D1/D2.** §11.5; preview LOD and heat-map sampling may degrade during
interaction, never the certified final error or protected topology. **E1.** The
gate capture overlays source/candidate counts, mandatory constraints, detected
features, requested/achieved error, worst-error jump, and an explicit higher-
than-target explanation. **E2.** MT-D32's ElevationSurface consumers apply to
the new product; native/LandXML export preserves geometry and hard breaklines
but exports without recipe semantics must disclose that loss. Least member (one
triangle) is refused as not simplifiable. Largest member is §11.5. Source
delete auto-detaches last-good output per MT-D25 rather than deleting it.
**E3.** §11.5.

### 11.5 Decision records and named gates

**MT-D33 — Region repair is one checked temporary derivative and one atomic
surface edit.** **Decision:** §11.2's surface-bound DR-D1 line, two exact fill
strategies, error classes, last-good preview, linked-output detachment, source
immutability, gesture claims, and single commit/undo root are mandatory. The
temporary job uses MT-D25's source fingerprint, staleness, CAS, last-good,
checkpoint, and error-list semantics without publishing a second recipe.
**Derivation:** owner S15/G13; X1–X3/X5/X6; P4/P5/P8/P10/P11; C1/D1/E2;
DR-D1/DR-D17; MT-D1–D5/MT-D10/MT-D12/MT-D15/MT-D17–D19/MT-D25/MT-D26/MT-D31.
**Rejected:** brush edits that journal every stroke; smoothing across a hard
breakline; editing a source cloud; committing a partial or stale patch; a
second dependency state machine. **Tunable:** marking membership/chord/Z,
annulus, residual, smoothing, and job thresholds under X6; source immutability,
hard constraints, one commit, and CAS are not tunable.

**MT-D34 — Intelligent terrain downsampling is a certified MT-D25 product with
an explicit bake.** **Decision:** §11.3 promotes ElevationSurface Tin
simplification to workflow level. Maximum vertical error and all boundaries,
holes, Breaklines, selected feature chains, extrema, type, and P4 scope outrank
target count. Bake creates a new linked surface and recipe; it never edits the
source and never conflates canonical resolution with render LOD. This amends
MT-D11/MT-D23 only by adding the workflow, MT-D25 lifecycle, feature policy,
and explicit bake name; their derive-don't-mutate and certificate rules stand.
**Derivation:** owner S15; X1–X3/X5/X6; P4/P5/P10/P11; MT-D11/MT-D17/MT-D23/
MT-D25/MT-D31/MT-D32. **Rejected:** in-place or count-only decimation;
vertex-sampled error as a certificate; weakening tolerance to meet count;
treating inferred features as authored breaklines; automatic regeneration of a
reviewed derivative. **Tunable:** default tolerance/count suggestions, detected-
feature thresholds, preview LOD, and job budgets; the requested bound and
preservation rules are not tunable.

Both gates are missing launchers today and therefore **unverified**:

| Gate                  | Runnable obligation and calibrated D1 budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `G-RW-DGM-SMOOTH`     | `node scripts/verify-mesh-terrain-scale.mjs --gate G-RW-DGM-SMOOTH`; on a real survey Tin plus synthetic crossing adversaries, exercise both strategies, C1 equivalence, breakline/boundary errors, one-command undo, cancel, forced restart, and exact outside-region identity. Continuous marking/parameter feedback keeps presented-frame interval p95 ≤ 2× target and marks preview stale within 100 ms p95. Extreme: 100M-triangle source, 10M affected triangles, 250k marking/topology intersections; completion ≤ 10 min on the calibrated active tier. |
| `G-RW-DGM-DOWNSAMPLE` | `node scripts/verify-mesh-terrain-scale.mjs --gate G-RW-DGM-DOWNSAMPLE`; real survey Tin plus analytic ridges/valleys/holes prove continuous vertical-error certificate, exact Breakline/boundary/feature preservation, deterministic hashes, best-effort count explanation, linked/stale/regenerate/detach, undo, cancel, and forced restart. Continuous controls keep p95 ≤ 2× target. Extreme: 100M triangles and 1M protected segments; verified bake ≤ 20 min on the calibrated active tier.                                                               |

For both, first truthful phase/unit progress is ≤ 500 ms; cancellation is
acknowledged ≤ 250 ms p95 and ≤ 2 s hard outside MT-D31's ≤ 500 ms atomic
publication boundary; additional RSS is ≤ `min(4 GiB, 25% of physical RAM)`;
peak staging disk is ≤ `3 * (captured input bytes + final output bytes) + 2
GiB`. Work predicted at ≥ 60 s checkpoints deterministic partitions keyed by
target/recipe generation, input hashes, strategy/parameter hash, constraint
hash, and Morton tile. After crash it returns **Paused after restart**, verifies
every hash, and resumes; cancellation/failure publishes nothing. Completion
means checked topology, error/residual certificate, prepared render/pick data,
provenance, and the one durable CAS journal transaction. Values are X6-tunable
only after the gate records hardware, fixture, p50/p95/max, and correctness
equivalence.

### 11.6 Current implementation delta (verified 2026-09-02)

**Exists and is reused:** the canonical Tin distinguishes 2.5D geometry and
stores hard Breaklines as triangle-edge curves
(`crates/himmelcad-core/src/entity_model.rs:457-472`); MT-D12's Rust BVH and the
MT-D17 prepared-artifact/checkpoint plan remain the substrate. The existing
generic entity command implementation journals placement only
(`crates/himmelcad-core/src/entity_commands.rs:18-91`), so it is not repair or
simplification evidence.

**New:** repair draft/check/fill kernels, DR-D1 marking-line adapter, error
rows, atomic geometry/detach transaction, exact affected-partition rewrite,
simplification feature detector and continuous vertical-error certifier,
`hcad.mesh.simplify-terrain@1` typed recipe parameters, preview/check/bake
commands, UI/catalog wiring, Agent/Python generation, and both gate launchers.
The current automation schema exposes generic app/view and command lifecycle
methods only (`schemas/automation/himmelcad-automation-v1.schema.json:77-145`),
so none of the batch-3 Mesh commands exists today. The Builder ribbon currently
contains View/Select/Segment/Inspect actions rather than the specified Mesh
entries (`apps/builder/renderer/src/ribbon.ts:90-145`). These are implementation
gaps, not partial feature claims.

### 11.7 Cross-spec requests and owner-statement disposition

1. `specs/draw/draw.md` and `specs/ui-platform/ui-platform.md` must cite MT-D33
   when their registry is next amended: DR-D1 remains the sole input bar and
   ui-platform §3.6 remains the sole gesture arbiter; Mesh owns only the
   temporary repair line and commit.
2. `REGISTRY.md` must add `mesh.repair-region`, expand `mesh.simplify` to the
   §11.1 lifecycle, retire the ambiguous protocol id, and index
   `G-RW-DGM-SMOOTH` / `G-RW-DGM-DOWNSAMPLE`. Until that re-walk is clean, this
   amended status is drafted rather than newly registry-verified.
3. DATA-MODEL/PROJECT-FORMAT admission for MT-D25 and the typed
   `hcad.mesh.simplify-terrain@1` parameter payload is a prerequisite. No new
   recipe envelope or Mesh-private DAG is requested.
4. Pointcloud PC-D19's ground-cloud output is an ordinary immutable cloud input
   to MT-D9/MT-D26 **Create surface…**. Mesh owns DGM Check/publication; it does
   not rerun or reinterpret the ground classifier.

| Owner batch-3 item                    | Disposition                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| S15/G13 marked-region smoothing       | Applied at workflow level by MT-D33 with both owner-named fill strategies, live last-good preview, typed errors/C1, one commit and `G-RW-DGM-SMOOTH`. |
| S15 intelligent triangle downsampling | Applied at workflow level by MT-D34, preserving MT-D11/MT-D23 and adding MT-D25 bake semantics plus `G-RW-DGM-DOWNSAMPLE`.                            |
| G14 M-RW outcome relation             | Cited as the milestone context only; this spec owns these two Mesh slices and does not disposition the other M-RW functions.                          |

No owner question remains. Numeric calibration belongs to X6 and the named
gates; hard-feature authority and source immutability follow X1, while P10 and
MT-D25 already decide last-good, staleness, detachment, regeneration, CAS, and
undo semantics.
