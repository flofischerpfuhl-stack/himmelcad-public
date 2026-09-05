# Import & formats — domain specification

Status: specified by the 2026-09-02 round-3 registry rebuild; amended for owner
statements batch 2 and PhotoLab product-dataset registration. IF-D19–IF-D25
implementation remains admission-gated.
Document class: plan. Workflow level covers XYZ/CSV mapping,
multi-file LAS apply-to-similar, changed-source update, and shared
registration; other format rows are contract level. This document walks the
current `docs/FUNCTION-CONTRACT.md`, including its heavy-data C4 retention
rule; doctrine changes require the program README re-walk.

Evidence: ADR 0018, 0021, 0023, 0024, 0025, and 0026; `docs/PROJECT-FORMAT.md`, `docs/TRANSFORMATIONS.md`, `docs/DEPENDENCY-POLICY.md`, `docs/DESIGN-SYSTEM.md`; the two dossiers and sibling records cited below; and current code at cited file:lines. E1 uses only §6 and existing `ImportChat`/`ImportRegistrationWizard` surfaces—never third-party screenshots.

Boundary: `../file-project/file-project.md` owns project lifecycle and Export
(FP-D5/D6/D17). This spec owns provider discovery, import, options,
registration, presets, batch reuse, source relocation, and changed-source
update. The single `file.import` registry act is revised here, not duplicated:
file-project supplies the File-tab location; this document owns end-to-end
guarantees. The 2026-09-02 reconciliation records current sibling ownership in
§10 without re-dispositioning it. Station-to-station scan registration/data
remain outside the current completion catalog pending a future **Registration &
Stations** owner spec; no current Registry row is implied.

## 1. Registry-compatible function catalog

Status means current implementation, not this plan. A placeholder, stub, or
deprecated path would count as missing.

| Id                     | Tab · group                | Access paths                                                                                                                        | Surface                                             | Perf                                      | Automation                                                                               | Status vs current implementation                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file.import`          | File · Import              | ribbon **Import…**; multi-file window drop; console `import <paths…>`; automation; no entity menu (creation is global); no shortcut | OS picker/drop → registration island → UIP-D10 jobs | bounded probe; long validate/stage/commit | public `io.probe`, `io.import`, `io.operation.status/cancel`; no public `registration.*` | **partial** — picker/console/drop enqueue a renderer FIFO (`apps/builder/renderer/src/App.tsx:406`, `:581`, `:833`); nine canonical providers and registration RPCs exist, but source-coordinate import auto-commits at `apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:223-235` and the wizard X dispatches cancel at `packages/@himmelcad/ui/src/ImportRegistrationWizard.tsx:257-269` |
| `import.apply-similar` | File · Import (contextual) | completion card; needs-input job; console; automation                                                                               | per-file review table + UIP-D10 jobs                | bounded dispatch; long children           | `import.apply_to_similar`                                                                | **missing** — current client exposes only probe/execute/registration (`packages/@himmelcad/app/src/clients.ts:629-776`); this spec owns the ui-platform finding-16 obligation                                                                                                                                                                                                                           |
| `import.preset`        | File · Import (contextual) | chooser and Manage actions in the flow; console; automation                                                                         | inline preset chooser/editor                        | bounded                                   | `import.preset.create/update/rename/delete/get/page`                                     | **missing** — no preset method in the current IO/registration client surface (`packages/@himmelcad/app/src/clients.ts:629-776`)                                                                                                                                                                                                                                                                         |
| `import.update`        | File · Import              | split-menu accelerator; imported-entity context menu/stale badge including **Relocate source…**; console; automation                | registration island, update-plan review             | long                                      | `import.update.plan`, `import.update.execute`, `import.relocate_source`                  | **missing** — current client has no source-status, plan, relocation, or update method (`packages/@himmelcad/app/src/clients.ts:629-776`)                                                                                                                                                                                                                                                                |
| `import.formats`       | Settings · Formats         | Settings page; console `formats` / `import.probe`; automation                                                                       | read-only settings page + query                     | bounded                                   | `io.formats.page`, `io.probe`                                                            | **partial** — descriptor paging and bounded prefix probe RPCs exist (`crates/himmelcad-sidecar/src/main.rs:1649-1685`, `:1945-1968`); no Builder page/console verb; generated Python SDK exposes neither (`sdk/python/src/himmelcad/client.py:22`)                                                                                                                                                      |

Wire methods use dotted lowercase snake_case namespace segments/leaves, matching
`schemas/automation/himmelcad-automation-v1.schema.json` (`view.state.get`,
`automation.entities.page`);
generated Python exposes idiomatic snake-case aliases. `io.import.execute`
remains an internal app facade, not a second public automation verb. No import
shortcut is proposed: File, drop, console, and automation cover it; Ctrl+O
remains project Open. Every long row registers with UIP-D10's main-process job
registry, discharging registry §4.2 F7 on this spec's side.

## 2. Format catalog and dispositions

### 2.1 Shipped import paths

The product has ten implemented import paths, but only nine registered canonical providers. The sole registration site (`crates/himmelcad-io/src/lib.rs:113`) registers nine importers and five exporters—DXF, LandXML, splat PLY, IFC, and GeoTIFF—at `:117-143`. `.hcap` is the tenth verified importer but remains a sidecar-called free function (`crates/himmelcad-io/src/hcap_import.rs:133`, call at `crates/himmelcad-sidecar/src/main.rs:1241-1245`), violating ADR 0018's one-provider-boundary rule. Export UX/backlog remain file-project FP-D5/D6/D14.

| Format             | Provider and registration evidence                                                          | Import options actually declared                          |
| ------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| LAS/LAZ            | `hcad.io.las-potree@1`; `crates/himmelcad-io/src/lib.rs:117`, descriptor `las_import.rs:97` | none (`las_import.rs:109`)                                |
| E57                | `hcad.io.e57-potree@1`; `lib.rs:120`, descriptor `e57_import.rs:89`                         | `coordinateResolutionMeters` (`e57_import.rs:98`)         |
| ASCII DXF          | `hcad.io.dxf-rs@1`; `lib.rs:123`                                                            | `acceptedLossCodes` (`dxf_provider.rs:329`)               |
| DWG                | `hcad.io.acadrust-dwg@1`; `lib.rs:126`, ADR 0026                                            | `acceptedLossCodes` (`dwg_provider.rs:271`)               |
| SLPK/I3S           | `hcad.io.slpk-i3s@1`; `lib.rs:129`                                                          | `layerId` (`slpk_provider.rs:81`)                         |
| LandXML            | `hcad.io.landxml@1`; `lib.rs:132`                                                           | `importNamespace` (`landxml.rs:148`)                      |
| Gaussian-splat PLY | `hcad.io.gaussian-splat-ply@1`; `lib.rs:135`                                                | three splat budgets (`gaussian_splat_provider.rs:82`)     |
| IFC 2x3/4/4.3      | `hcad.io.ifc-spf@1`; `lib.rs:138`                                                           | loss codes and namespace (`ifc_provider.rs:81`)           |
| GeoTIFF/COG        | `hcad.io.geotiff-rust@1`; `lib.rs:141`                                                      | interpretation and height jump (`geotiff_provider.rs:89`) |
| `.hcap`            | verified import function, not a provider; `hcap_import.rs:133`                              | no provider option contract                               |

The descriptor contract already carries schema/defaults
(`crates/himmelcad-io/src/canonical_provider.rs:42`) and validates closed
draft-2020-12 objects (`:81`). Provider selection is deterministic; tied top
confidence fails as `AmbiguousFormat` rather than using registration order
(`:984-1023`).

### 2.2 Missing-importer catalog

T1/T2/T3 are tunable implementation tranches under X6/P3, not promises that
weaken correctness. The order follows usable canonical consumers and verified
dependency/corpus readiness: T1 closes ASCII, `.hcap` registration, and the
existing IFC importer gaps; mesh exchange waits for the Mesh entity owner and
provider corpus; civil exchange waits for Point, Alignment, and
ElevationSurface admission. Every new parser must pass the exact-version,
transitive, attribution, and release-gate workflow in
`docs/DEPENDENCY-POLICY.md` before product use. Each provider/version has one
checked-in dependency-evidence record covering official source, lock and
artifact hashes, license identity, complete transitive/runtime closure,
models/datasets/native binaries/generated artifacts, attribution,
redistribution terms, source revision, and local modifications. Missing or
uncertain evidence keeps the provider out of product and release builds.

| Format                                       | Disposition and priority                                                                                                                                                                                                       | Derivation/evidence                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **XYZ/CSV/TXT/PTS point lists**              | **adopt T1** — `hcad.io.ascii-points@1`; mapping and dual interpretation in §3.1/IF-D8                                                                                                                                         | RIB imports common scan formats/ASCII (`rib-civil.md` §2.6 Punktwolke); RealWorks imports CSV survey networks (`realworks.md` §2.1)                                                                                                                                     |
| **glTF/GLB**                                 | **adopt T2**, only after the Mesh entity owner and provider corpus are ready; canonical mesh entities/resources, never a viewer-only overlay                                                                                   | Himmel:CAD addition enabled by the existing decoder/materializer (`crates/himmelcad-render/src/providers/gltf_content.rs:1`, `gltf_materialize.rs:1`) and Mesh MT-D13; RealWorks W8 evidences generic design-model import, not glTF specifically (`realworks.md` §3 W8) |
| **PLY mesh (non-splat)**                     | **adopt T2** after the same Mesh readiness gate; a distinct mesh provider because the splat probe rejects non-splat schemas (`gaussian_splat_provider.rs:105-132`)                                                             | Himmel:CAD addition; deterministic probing prevents extension collision (ADR 0018), and MT-D13 owns mesh texture/material depth                                                                                                                                         |
| **OBJ**                                      | **adopt T2** after glTF and mesh PLY, gated by the same owner/corpus readiness                                                                                                                                                 | Himmel:CAD addition; order prefers the already-invested glTF path, then simpler PLY, before another material grammar (X6 rationale)                                                                                                                                     |
| **3D Tiles 1.1 local directory/archive**     | **adopt T2** after a canonical prepared-hierarchy consumer is admitted; never a second renderer                                                                                                                                | Himmel:CAD addition based on ADR 0018's SLPK/I3S boundary and existing render consumer `crates/himmelcad-render/src/providers/tiles3d.rs:1`, not a claimed RealWorks format                                                                                             |
| **Remote 3D Tiles URL as “import”**          | **reject** — remote references are a separately permissioned reference-layer lifecycle, not immutable file import                                                                                                              | ADR 0024 separates filesystem and network capabilities; ADR 0018 requires staged, verified artifacts                                                                                                                                                                    |
| **PTX**                                      | **defer** to station-data readiness                                                                                                                                                                                            | RealWorks imports PTX by station (`realworks.md` §2.1); registry §5.7 owns station data and pointcloud PC-D15 owns Split per Scan                                                                                                                                       |
| **REB DA**                                   | **adopt staged T2 only after canonical consumers exist** — DA45 after Point admission, DA40 after Alignment admission, DA58 after ElevationSurface admission; defer DA21/22/23/49/50/66/67/68 until their civil entities exist | full types in `rib-civil.md` §2.10; REB proof role §2.8; implementing only data with a truthful consumer follows X1 and CURRENT-DIRECTION; sequence remains X6-tunable                                                                                                  |
| **OKSTRA-CTE/XML**                           | **defer after the first usable REB subset**                                                                                                                                                                                    | OKSTRA spans axes, bands, pavement books, DGMs, slopes, and land acquisition (`rib-civil.md` §2.10), so its consumer surface is broader and less ready than DA45/40/58; REB first also covers a narrower, testable German proof exchange. Order remains X6-tunable.     |
| **Shapefile / GeoPackage**                   | **defer T3 GIS tranche**; no order is claimed until a GIS-feature owner and verified provider evidence exist                                                                                                                   | RIB's cadastre need is evidenced by ALKIS (`rib-civil.md` §2.10); `crates/himmelcad-sidecar/src/raster_runtime.rs:549-565` only audits installed GDAL/OGR drivers and is not a canonical GeoPackage importer; `REGISTRY.md` §4.1 keeps GIS outside the current program  |
| **ALKIS-XML**                                | **defer with the GIS tranche**                                                                                                                                                                                                 | cadastral parcels and attributes (`rib-civil.md` §2.10); same missing semantic owner                                                                                                                                                                                    |
| **CityGML**                                  | **defer** until a city-object workflow and canonical mapping are specified                                                                                                                                                     | no reference behavior is asserted; CURRENT-DIRECTION forbids speculative canonical domains                                                                                                                                                                              |
| **ISYBAU Austauschformat Abwasser XML-2024** | **adopt after the BIM sewer objects BS-D22 and exact XSD/corpus gate**; preserve unknown fields and report missing topology/metadata                                                                                           | BIM now owns manhole/pipe-run semantics; Import owns the adapter (BS-D22)                                                                                                                                                                                               |
| **DWA-M 145-3 (December 2025)**              | **catalog for current-interface research; implementation deferred** until primary syntax/profile and fixtures are admitted                                                                                                     | BS-D22/field-codes dossier distinguish it from the legacy adapter                                                                                                                                                                                                       |
| **DWA-M 150**                                | **legacy adapter only**, clearly labeled withdrawn/replaced                                                                                                                                                                    | BS-D22; never marketed as current                                                                                                                                                                                                                                       |
| **easyBAU / EasyBAU XML**                    | **no row/compatibility claim** until vendor, schema, and fixtures identify it                                                                                                                                                  | A2 dossier-wide absence; BS-D22                                                                                                                                                                                                                                         |
| **PDF vector import**                        | **defer** with the Draw/Plan consumer                                                                                                                                                                                          | RIB supports scale-true PDF whose vectors become CAD (`rib-civil.md` §2.10); file-project FP-D14 already owns the export half                                                                                                                                           |
| **KML**                                      | **defer** until the WeltView publish/reference flow                                                                                                                                                                            | RIB exchange evidence (`rib-civil.md` §2.10); FP-D14 owns publish sequencing                                                                                                                                                                                            |
| **Messdaten/tachymeter traverses**           | **defer**; T1 CSV covers coded coordinates, not survey adjustment                                                                                                                                                              | RIB Messdaten scope (`rib-civil.md` §2.10) requires a survey-computation owner                                                                                                                                                                                          |
| **CPIXML import**                            | **reject direction**; do not infer a reverse contract                                                                                                                                                                          | dossier evidence is handoff _to_ iTWO 5D (`rib-civil.md` §2.10 and W8); export belongs to file-project if a billing workflow lands                                                                                                                                      |
| **TZF/TDX, ZFS, RCP, JXL, RVT**              | **reject as a class today** — reopen only when a documented format or dependency-policy-compatible decoder exists                                                                                                              | RealWorks' proprietary import list (`realworks.md` §2.1); ADR 0025's opaque `.dc` fail-closed precedent; dependency policy                                                                                                                                              |
| **`.hcap` provider registration**            | **adopt T1** — wrap the shipped verifier without changing its semantics                                                                                                                                                        | `docs/PROJECT-FORMAT.md` Formats says `.hcap` enters canonical IO; ADR 0018 forbids a side door; IF-D11                                                                                                                                                                 |

IFC fidelity obligation from `REGISTRY.md` §1.6/§1.13: T1 also closes typed property
sets, `IFCRELDEFINESBYTYPE`, `PredefinedType`, and mapped-item instancing before
BS-D13 can promise derived specifications. Current importer evidence is honest:
classification exists (`crates/himmelcad-io/src/ifc_provider.rs:1642`), while
the BIM spec records those four gaps at `bim-specs.md` §5.

### 2.3 Dossier-row dispositions

Because this domain catalog derives from both dossiers, every catalog row is
listed. Import-owned rows are decided here; all other rows cite their owning
specification or the registered owner and are not dispositioned again.

#### RealWorks dossier

| Dossier row                                                     | Disposition                                                                                                                                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1 Import scans                                               | **Adopt here**: E57, LAS/LAZ, CSV, DWG/DXF and per-format options; PTX deferred to station readiness; proprietary TZF/TDX, ZFS, RCP, JXL rejected today by IF-D10; image import remains Raster/PhotoLab-owned. |
| §2.1 Station sampling on import                                 | **Pointcloud-owned**: rejected for the canonical working cloud by PC-D8; prepared LOD governs interaction.                                                                                                     |
| §2.1 Sampling (spatial, intensity, range)                       | **Pointcloud-owned**: PC-D8 adopts explicit derived sampling; PC-D15 queues remaining methods.                                                                                                                 |
| §2.1 Split per Scan                                             | **Pointcloud-owned**: deferred by PC-D15 pending a future Registration & Stations identity contract; no current Registry row is implied.                                                                       |
| §2.1 Project tree (WorkSpace)                                   | **UI-platform-owned** entity tree; imports publish ordinary canonical entities, with no second tree (`ui-platform.md` §3.2).                                                                                   |
| §2.1 Scan Explorer                                              | **Registration & Stations-owned**, deferred outside the current completion catalog; Import preserves provider station/panorama semantics under ADR 0018.                                                       |
| §2.2 Auto-Extract Targets and Register                          | **Registration & Stations-owned**, deferred outside the current completion catalog.                                                                                                                            |
| §2.2 Target Analyzer                                            | **Registration & Stations-owned**, deferred outside the current completion catalog.                                                                                                                            |
| §2.2 Auto-Register using Planes                                 | **Registration & Stations-owned**, deferred outside the current completion catalog.                                                                                                                            |
| §2.2 Cloud-Based Registration                                   | **Partially adopt here** for source-to-project dual view, point pairs, reviewed ICP, and visual check under ADR 0025; station grouping remains deferred to Registration & Stations.                            |
| §2.2 Refine Registration using Scans                            | **Registration & stations-owned**; this spec adopts only bounded, reviewed import-placement ICP (ADR 0025).                                                                                                    |
| §2.2 Adjust Registration                                        | **Registration & Stations-owned**, deferred outside the current completion catalog.                                                                                                                            |
| §2.2 Bundle adjustment                                          | **Registration & Stations-owned**, deferred outside the current completion catalog.                                                                                                                            |
| §2.2 Georeferencing / Orientation / UCS                         | **Adopt here** for explicit import CRS, point-pair, and origin+north placement (IF-D6); general UCS creation is View/Draw-owned.                                                                               |
| §2.2 Registration report & visual check                         | **Adopt here** for hash-bound placement preview/audit; station-network reports remain deferred to Registration & Stations.                                                                                     |
| §2.3 Segmentation tool                                          | **Pointcloud-owned and adopted** by PC-D1–PC-D5/PC-D16.                                                                                                                                                        |
| §2.3 Auto-Segment Moving Objects                                | **Pointcloud-owned and queued** by PC-D15.                                                                                                                                                                     |
| §2.3 Auto-Segment Steel Beams                                   | **Pointcloud-owned and queued** by PC-D15.                                                                                                                                                                     |
| §2.3 Auto-Segment Reflection                                    | **Pointcloud-owned and queued** by PC-D15.                                                                                                                                                                     |
| §2.3 Remove Points from TZF Scans                               | **Pointcloud-owned; rejected for immutable external source mutation** by PC-D1/PC-D15; canonical mask edits are used instead.                                                                                  |
| §2.3 Noise Reduction                                            | **Pointcloud-owned and queued** by PC-D15.                                                                                                                                                                     |
| §2.3 Cloud merge                                                | **Pointcloud-owned and adopted** by `pointcloud.merge`/PC-D13.                                                                                                                                                 |
| §2.4 Auto-Classify Indoor                                       | **Pointcloud-owned and queued** by PC-D15.                                                                                                                                                                     |
| §2.4 Auto-Classify Outdoor                                      | **Pointcloud-owned and queued** by PC-D15.                                                                                                                                                                     |
| §2.4 Layer/class management                                     | **Pointcloud-owned and adopted** by PC-D6; Draw DR-D4 owns entity layers.                                                                                                                                      |
| §2.5 Limit Box                                                  | **View-owned and adopted** by viewing-box VB-D1–VB-D5.                                                                                                                                                         |
| §2.5 Show limit box / outside content                           | **View-owned and adopted** by VB-D4/VB-D6.                                                                                                                                                                     |
| §2.5 Store / manage limit boxes                                 | **View-owned and adopted** by VB-D1 and P1.                                                                                                                                                                    |
| §2.5 Limit Box Extraction                                       | **Pointcloud-owned and adopted** by VB-D11 + PC-D7/PC-D8.                                                                                                                                                      |
| §2.5 Limit box slices                                           | **View-owned and queued** by VD-D12.                                                                                                                                                                           |
| §2.5 Cutting plane                                              | **View-owned and adopted** by VD-D1/VD-D2.                                                                                                                                                                     |
| §2.5 Station markers vs. box                                    | **Registration & Stations-owned**, deferred outside the current completion catalog; P4 will scope visibility.                                                                                                  |
| §2.6 Measurement tools                                          | **Measure-owned and adopted** by MI-D1–MI-D13.                                                                                                                                                                 |
| §2.6 Annotations                                                | **Draw-owned**; dimensions/labels are separated from inspection measurements by DR-D9/MI-D2.                                                                                                                   |
| §2.6 Feature coding / Easy Line / polyline                      | **Draw-owned and adopted/queued** by DR-D4/DR-D8/DR-D16.                                                                                                                                                       |
| §2.6 Catenary drawing                                           | **Draw-owned and deferred** in the Draw backlog; no import behavior inferred.                                                                                                                                  |
| §2.7 Surface to Model Inspection                                | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 Twin Surface Inspection                                    | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 3D Inspection tool + analyzer                              | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 2D Inspection + map analyzer                               | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 Floor flatness and levelness                               | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 Wall Verticality Inspection                                | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 Tank calibration/inspection                                | **Pointcloud-owned and deferred** by PC-D10.                                                                                                                                                                   |
| §2.7 Volume calculation                                         | **Mesh-owned** by MT-D8; saved reports are canonical.                                                                                                                                                          |
| §2.8 Mesh creation/editing                                      | **Mesh-owned and adopted** by MT-D1–MT-D5.                                                                                                                                                                     |
| §2.8 Contours / profiles / cross sections                       | **Mesh/Draw/civil-owned**: contours MT-D7, profile/cross-section domain remains registered future work.                                                                                                        |
| §2.8 Basic geometry fitting                                     | **Pointcloud/Draw-owned and queued**; no importer-owned fit is created.                                                                                                                                        |
| §2.8 Pipe / cable-tray modeling                                 | **BIM-owned and deferred** by BS-D15.                                                                                                                                                                          |
| §2.8 Steel modeling                                             | **BIM-owned and deferred** by BS-D15.                                                                                                                                                                          |
| §2.8 Auto-Extract Cylinders                                     | **Pointcloud/BIM-owned and deferred** by PC-D15/BS-D15.                                                                                                                                                        |
| §2.8 Ortho-Projection                                           | **Pointcloud-owned tool, Raster-owned result**, adopted by PC-D9/RA-D8.                                                                                                                                        |
| §2.8 Ortho conversion / rectification / matching / RealColor    | **Raster-owned** by RA-D2/RA-D8; source-to-cloud colorization remains deferred.                                                                                                                                |
| §2.8 Key plan creation                                          | **Plan/Raster-owned**, with plan composition governed by PE-D1–PE-D7; not an import function.                                                                                                                  |
| §2.9 Cloud/scan export                                          | **File-project-owned** by FP-D5/FP-D6/FP-D14.                                                                                                                                                                  |
| §2.9 CAD/BIM export                                             | **File-project/BIM-owned** by FP-D5/FP-D6 and BS-D13; current IFC is passthrough-only.                                                                                                                         |
| §2.9 Publisher                                                  | **File-project/viewer-owned and deferred** by FP-D14.                                                                                                                                                          |
| §2.9 Publish to TRCPS / Clarity                                 | **File-project-owned and deferred** by FP-D14; network authority remains ADR 0024-bound.                                                                                                                       |
| §2.9 Media/report outputs                                       | **Owning result domains + File-project**; export honesty is FP-D5/FP-D6 and each report schema stays with its producer.                                                                                        |
| §2.10 Examiner/walkthrough/fly-to/transparency/shortcuts/themes | **View/UI-platform-owned** by VD-D5–VD-D10 and UIP gesture/theme contracts; not import-owned.                                                                                                                  |

#### RIB Civil dossier

| Dossier row                                                           | Disposition                                                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2.1 Punkt absolut/relativ/polar                                      | **Draw-owned and adopted** by DR-D1/DR-D3.                                                                                                                |
| §2.1 Kleinpunkt / Achskleinpunkt                                      | **Draw/civil-owned**; point construction adopted, alignment-station variant waits on DR-D8's alignment tranche.                                           |
| §2.1 Schnittpunkt / Mittelpunkt / Tangentenschnittpunkt / Lotfußpunkt | **Draw-owned and adopted** by DR-D1/DR-D2.                                                                                                                |
| §2.1 Teilungspunkte                                                   | **Draw-owned and cataloged**; implementation order remains Draw-owned.                                                                                    |
| §2.1 Gerade variants                                                  | **Draw-owned and adopted** by DR-D1/DR-D6/DR-D8.                                                                                                          |
| §2.1 Bogen variants                                                   | **Draw-owned and adopted** by DR-D1/DR-D6/DR-D8.                                                                                                          |
| §2.1 Klothoide                                                        | **Draw-owned and adopted** by DR-D8.                                                                                                                      |
| §2.1 Linienzug                                                        | **Draw-owned and adopted** by the Draw catalog/DR-D8.                                                                                                     |
| §2.1 Circle/spline/text/dimensions/areas/hatches                      | **Draw-owned** by its catalog; dimension values follow DR-D9 and specification presentation BS-D12/DR-D16.                                                |
| §2.1 Trimmen                                                          | **Draw-owned and adopted** by DR-D11.                                                                                                                     |
| §2.1 Copy/rotate/move/renumber/change                                 | **Select-edit/Draw-owned**; transformation and edit commands are not importer behavior.                                                                   |
| §2.1 UNDO                                                             | **File-project/UI-platform-owned**, universal through FP-D11/P6.                                                                                          |
| §2.2 Fangkreis                                                        | **Draw-owned and adopted** by DR-D2/DR-D12.                                                                                                               |
| §2.2 Punktauswahl                                                     | **Draw-owned and adopted** by DR-D2/DR-D6.                                                                                                                |
| §2.2 F5-Box                                                           | **Draw-owned class precedent**, adopted as numeric parity by DR-D1 and here for pair tables.                                                              |
| §2.2 F4-Box                                                           | **Draw-owned named-object selection**, governed by DR-D2; not imported.                                                                                   |
| §2.2 Tachobox                                                         | **Draw-owned and adopted** by DR-D1.                                                                                                                      |
| §2.2 Mehrdeutigkeit                                                   | **Draw-owned and adopted** by DR-D6.                                                                                                                      |
| §2.2 Hilfspunkte                                                      | **Draw-owned**, dispositioned by the Draw catalog.                                                                                                        |
| §2.3 Folien                                                           | **Draw-owned and adopted** by DR-D4.                                                                                                                      |
| §2.3 Folienhierarchie                                                 | **Draw-owned and adopted** by DR-D4.                                                                                                                      |
| §2.3 Elemente einer Folie zuordnen                                    | **Draw-owned and adopted** by DR-D4.                                                                                                                      |
| §2.3 Spezifikation                                                    | **BIM/spec-owned and expanded** by BS-D1–BS-D12 and DR-D16.                                                                                               |
| §2.3 HV-Planverwaltung                                                | **View/Plan-owned** by VD-D8/PE-D6; not import-owned.                                                                                                     |
| §2.3 Darstellung options                                              | **View-owned** by VD-D5/VD-D8.                                                                                                                            |
| §2.4 Achse erzeugen                                                   | **Civil-owned and adopted** by CIV-D2/CIV-D3; Draw DR-D8 retains primitive construction.                                                                  |
| §2.4 Automatic axis generation                                        | **Civil-owned and adopted** as constrained best fit by CIV-D2/CIV-D18.                                                                                    |
| §2.4 Axis check                                                       | **Civil-owned and adopted** through residual/constraint validation (CIV-D2/CIV-D18).                                                                      |
| §2.4 Axis optimization                                                | **Civil-owned and adopted** as explicit constrained fitting; arbitrary feasibility remains rejected.                                                      |
| §2.4 Lane widening                                                    | **Civil-owned and adopted** as editable width/crossfall bands (CIV-D4).                                                                                   |
| §2.4 Junction assistants                                              | **Civil-owned and deferred** by Civil §3.2 pending a sourced workflow.                                                                                    |
| §2.4 Superelevation-band generation                                   | **Civil-owned, partial:** table/graphic editing is adopted; regulation-driven generation waits for CIV-D19 standards data.                                |
| §2.4 Width/superelevation/curvature bands/pavement book               | **Civil-owned, partial:** width/crossfall and curvature display are adopted; pavement-book semantics remain deferred.                                     |
| §2.4 Swept path                                                       | **Civil analysis-owned and deferred** by Civil §3.2.                                                                                                      |
| §2.4 Sight-distance analysis                                          | **Civil analysis-owned and deferred** by Civil §3.2.                                                                                                      |
| §2.5 Long-profile window                                              | **Civil profile-owned and adopted** by CIV-D7/CIV-D12.                                                                                                    |
| §2.5 Automatic gradient polygon                                       | **Civil profile-owned and adopted** as constrained best fit (CIV-D17/CIV-D18).                                                                            |
| §2.5 Create/dissolve gradient                                         | **Civil profile-owned, partial:** create/update are adopted; dissolve is rejected in favor of explicit Draw export/copy.                                  |
| §2.5 TS-point editing                                                 | **Civil profile-owned and adopted** with grip/table parity.                                                                                               |
| §2.5 Parabolic rounding                                               | **Civil profile-owned and adopted** alongside distinct circular/clothoid members; infeasible cases reject.                                                |
| §2.5 Change tangent grade                                             | **Civil profile-owned and adopted** as typed percentage editing.                                                                                          |
| §2.5 Gradient cover                                                   | **Civil profile-owned and adopted** against exact source revisions.                                                                                       |
| §2.5 Optimized gradient generation                                    | **Civil profile-owned and adopted** as constrained best fit.                                                                                              |
| §2.6 Point database                                                   | **Draw/Mesh-owned**; imported survey points are admitted here by IF-D8, while surface consumption is MT-D2/MT-D9.                                         |
| §2.6 Breaklines/boundaries                                            | **Mesh consumes Draw curves**, adopted by MT-D2/MT-D5.                                                                                                    |
| §2.6 Triangulation                                                    | **Mesh-owned and adopted** by MT-D1–MT-D4.                                                                                                                |
| §2.6 Error list                                                       | **Mesh-owned and adopted** by MT-D3.                                                                                                                      |
| §2.6 Contours                                                         | **Mesh-owned and adopted** by MT-D7.                                                                                                                      |
| §2.6 Control section                                                  | **Mesh/civil-owned and queued** by MT-D14.                                                                                                                |
| §2.6 Slope plan                                                       | **Mesh-owned display** by MT-D6.                                                                                                                          |
| §2.6 Rain/flow tracing                                                | **Mesh-owned and queued** by MT-D14.                                                                                                                      |
| §2.6 Multiple horizons/soil layers                                    | **Mesh/civil-owned and deferred** by MT-D14.                                                                                                              |
| §2.6 Pointcloud app                                                   | **Split ownership**: ASCII import adopted here; cloud tools PC-D1–PC-D16; cloud-to-DGM MT-D9.                                                             |
| §2.6 Volume                                                           | **Mesh-owned and adopted** by MT-D8.                                                                                                                      |
| §2.7 RQ-Editor                                                        | **Civil cross-section-owned and deferred** by Civil §3.4 pending a sourced assembly/catalog contract.                                                     |
| §2.7 QP-Generator                                                     | **Civil cross-section-owned and adopted** by CIV-D12.                                                                                                     |
| §2.7 Stationsfenster                                                  | **Civil cross-section-owned and adopted** as checked station lists/range multi-apply; the pattern also informs IF-D2.                                     |
| §2.7 Konstruktionszuordnung                                           | **Civil cross-section-owned, partial:** band/crossfall/slope ranges are adopted; full RQ macros are deferred.                                             |
| §2.7 Point construction/intersection assistant                        | **Civil cross-section-owned, partial:** tri-modal station/offset/Z construction is adopted; arbitrary loci remain deferred.                               |
| §2.7 Ditches/slope rounding/parallels                                 | **Split:** Draw DR-D20/Civil adopt parallels; ditch and slope-rounding macros remain deferred with RQ assembly.                                           |
| §2.7 Accounting boundaries                                            | **Civil cross-section/quantity-owned and deferred**.                                                                                                      |
| §2.7 Fachbedeutungen                                                  | **BIM/spec-owned and adopted by consumption:** Civil uses the existing specification catalog under P7.                                                    |
| §2.7 Intelligent linkage                                              | **Civil cross-section-owned and adopted:** station-defined geometry is live and arbitrary projections are stale-with-sync under P10.                      |
| §2.8 CAD-plan quantities                                              | **Quantity domain-owned and deferred**; no importer invents LV mappings.                                                                                  |
| §2.8 DGM quantities                                                   | **Mesh-owned core compute** by MT-D8; billing semantics remain deferred.                                                                                  |
| §2.8 REB methods                                                      | **Quantity/civil-owned**; exchange waits on admitted consumers per IF-D9.                                                                                 |
| §2.8 AVA handoff                                                      | **File/quantity-owned and deferred**; CPIXML import is rejected while a future explicit export may be specified.                                          |
| §2.8 Earthworks                                                       | **Mesh/civil-owned and deferred** by MT-D14.                                                                                                              |
| §2.9 Plan frames                                                      | **Plan-owned and adopted** by PE-D1–PE-D7.                                                                                                                |
| §2.9 Print + scale                                                    | **Plan-owned and adopted** by PE-D11/PE-D12.                                                                                                              |
| §2.9 Plan decoration                                                  | **Plan-owned and adopted** by PE-D2/PE-D3.                                                                                                                |
| §2.9 Dynamic dimensions/alignment/detail drafting                     | **Draw/Plan/civil-owned**; DR-D9 and PE-D3 apply, civil depth deferred.                                                                                   |
| §2.9 RE-2012 plans                                                    | **Plan/civil-owned and deferred** until alignment/land-acquisition semantics exist.                                                                       |
| §2.9 Profile/cross-section plans                                      | **Plan/civil-owned and deferred** until their model owners exist.                                                                                         |
| §2.9 Lists                                                            | **Owning data domain + File export** under FP-D5/FP-D6; no generic import function.                                                                       |
| §2.9 Raster images                                                    | **Raster-owned and adopted** by RA-D2/RA-D8; GeoTIFF import exists, TFW/JGW remain Raster backlog.                                                        |
| §2.10 REB DA types                                                    | **Adopt staged here only at consumer readiness** as §2.2/IF-D9 specifies.                                                                                 |
| §2.10 LandXML                                                         | **Implemented here** through the registered canonical provider; fidelity remains provider-tested.                                                         |
| §2.10 DXF/DWG                                                         | **Implemented here** through registered providers; export stays FP-D5/FP-D6.                                                                              |
| §2.10 OKSTRA                                                          | **Deferred here** after the first usable REB subset because its consumer set is broader (§2.2/IF-D9).                                                     |
| §2.10 ALKIS-XML                                                       | **Deferred here** until a GIS/cadastre entity owner exists.                                                                                               |
| §2.10 ISYBAU                                                          | **Adapter-owned here after BIM BS-D22:** XML-2024 primary; DWA-M 145-3 research pending exact syntax/fixtures; DWA-M 150 legacy only; no `easyBAU` claim. |
| §2.10 CPIXML                                                          | **Reject import direction here**; dossier evidence is an export handoff to iTWO 5D.                                                                       |
| §2.10 IFC                                                             | **Adopt/deepen here**; import identity and classification merge follow IF-D4/BS-D13.                                                                      |
| §2.10 BCF                                                             | **Deferred** to an issue-management owner; it is not folded into IFC import.                                                                              |
| §2.10 PDF                                                             | **Deferred here** until the Draw/Plan vector-import consumer is specified; export is FP-D14.                                                              |
| §2.10 KML                                                             | **Deferred here** until WeltView publish/reference semantics are specified.                                                                               |
| §2.10 Messdaten                                                       | **Deferred here**; ASCII can preserve coded points but cannot substitute for traverse adjustment.                                                         |

## 3. Full user-perspective workflows

### 3.1 XYZ/CSV points with column mapping

The surveyor drops `absteckung_137.csv`: semicolon delimiter, decimal comma,
one header row, and columns `number;x;y;z;code`. A job exists immediately and
the registration island opens. Bounded content probing selects
`hcad.io.ascii-points@1`; ambiguous probing would instead show the IF-D13
provider-choice card.

The first card previews N real rows from a bounded prefix; it never labels that
sample as a file-wide validation. Delimiter, decimal separator, encoding,
header-row count, thousands-separator policy, and unit are visible editable
fields.
Each column has exactly one role: X, Y, Z, intensity, R/G/B, point number,
code, description, or Ignore. Suggested detection is never commitment: the
user confirms X/Y/Z and assigns number and code. Duplicate required roles,
missing X/Y, and non-finite values are field errors. Invalid sample cells are
marked. Exact file-wide valid/invalid counts come only from a subsequent
streaming, cancellable bytes/lines validation job with bounded memory; its
stable grammar is frozen with the accepted options. Continuing with bad rows
requires a reviewed `hcad.loss.ascii.invalid-row@1` consent after that job; the
exact count and examples are shown and stored in provenance. No row is
silently dropped. Unit is a user declaration; any conversion is explicit and
recorded, satisfying `PROJECT-FORMAT.md`'s never-silent unit rule.

The next card asks **Survey points** or **Point cloud**. **Point cloud** creates
exactly one `hcad.point-cloud@1` entity, one `potree@2` prepared dataset, the
immutable original source, and mapping/unit/CRS/loss provenance. **Survey
points** creates one `hcad.point@1` entity per valid row with point number,
code, and description, in one streamed canonical transaction whose entity
count, memory, tree virtualization, selection, journal, and undo costs must
pass G-IF-ASCII-LARGE before commit. The Draw workflow consumes those entities
at `draw.md` §3.1. Above the X6-tunable recommendation of 50,000 rows, the card
shows projected entity and disk cost and warns; it never auto-converts the
meaning. If the installed tier has not passed the large-point-list gate for
the projected count, Survey points is refused honestly while Point cloud
remains available. Code-to-style mapping stays the specifications domain;
import preserves codes without inventing styles.

Placement then follows ADR 0025's four choices: already in project coordinates,
transform file, horizontal and height separately, or together. ASCII supplies
no trusted CRS. The user chooses already-in-project coordinates and reviews a
project-view overlay of the staged bounds and points before **Import** enables.
Commit publishes one journaled transaction; the entity tree shows 137 points,
the console records source/provider/options/losses, and Ctrl+Z removes the
whole import. Cancel before commit removes only staging; the source is untouched.

### 3.2 Forty LAS files, answer once

The user selects or drops 40 LAS tiles. All 40 become UIP-D10 jobs at birth;
39 are visible as **Needs input** while the first island opens. The first file
is probed independently. The user explicitly chooses the source/target
horizontal and height operations; LAS metadata remains audit-only under ADR 0025. The preview overlays the transformed first tile in the project view,
shows source and transformed bounds and the frozen operation identifiers, and
the user commits it.

The completion card offers **Apply these answers to 39 similar files** only
after every candidate satisfies `ReusableInputSignature@1`. The mechanical
signature contains the exact provider id/version, format id, option-schema
version, chosen interpretation, source dimensionality/point-record schema,
the declared CRS and unit source (user declaration versus audited header),
axis posture, scale/offset records, and normalized header-derived audit
attributes. A preset declares numeric/string tolerances for each header-derived
attribute it permits to vary; an undeclared difference has zero tolerance.
Same provider or file extension alone is explicitly insufficient. Untrusted
CRS metadata never selects a transform, but any WKT/VLR/unit/axis mismatch
excludes that file from reuse and returns it to **Needs input**.

The review is a table with one row for every file: source bounds, transformed
bounds, declared frame and units plus their source, metadata agreement,
expected entity/dataset result, copied recipe/options, and outlier warnings.
Deviations are flagged and excluded; the user may exclude any remaining row.
One **Apply to N reviewed files** confirmation freezes exactly the included N
previews and their signatures. It never includes accepted loss codes, SLPK
layer ids, old point pairs, ICP samples, or any descriptor field marked
source-specific. Each child re-probes and checks its expected source token
before provider execution, then stages and commits as its own job/transaction
with concurrency initially capped at two. Any changed token, signature,
preview, or new semantic loss invalidates only that child and returns it to
Needs input; no old consent crosses the file boundary.

Tile 23 is truncated. It fails with its provider error while the other 38
finish; cancelling tile 12 likewise publishes nothing for tile 12 and leaves
siblings alone. The jobs island shows per-file state, progress, retry, cancel,
and completion. Renderer reload rehydrates the same jobs from UIP-D10's
main-process registry. The user can save the reusable setup as canonical
preset **UTM32 + DHHN2016 tiles**; next month's files still get a summary
confirmation and per-file probe, never recycled picks or loss consent.

### 3.3 Changed source: update in place

Project opening never waits on a source path. Builder renders from cached
source status immediately and schedules path liveness checks asynchronously
with bounded concurrency and an X6-tunable timeout. A confirmed path/size/mtime
mismatch adds **Source changed**; a missing file adds **Source unavailable**;
a timed-out SMB/NFS/removable path adds **Source check delayed**. None starts a
content hash or update. The imported geometry remains fully usable because its
canonical resources live in the project. The badge and entity context menu
offer **Update from source…** and **Relocate source…**.

Relocation uses a user-owned OS picker (or an exact ADR 0024 source grant),
then probes and hashes the candidate. Provider/format mismatch refuses with
**Import as new**. A compatible candidate enters the normal stable-key update
review; relocation alone journals only the new canonical path, expected source
token, and provenance and does not change geometry. It is undoable. This
preserves lineage without pretending that matching names or bytes establish
identity (FP-D7's missing-source/Relocate precedent).

Before either initial import staging or changed-source update, probe returns a
bounded `SourceToken@1`: canonical source-capability identity, platform file
identity where available, byte size, modification time, and prefix hash. The
token is revalidated before provider execution. While producing the
authoritative full source hash, the provider must either read from a verified
immutable snapshot/copy or compare identity before and after the read; a
mutation fails closed and publishes no mixed-byte artifact. The accepted
preview/update plan freezes the full hash. The current code freezes only
provider/version/format (`canonical_provider.rs:1026-1045`); the source token
and original-source race guard are required additions, not existing behavior.

An update is a provider-neutral three-way merge keyed only by
provider-declared stable keys:

- **source-old** — the imported baseline, including its full hash and a
  per-field/per-representation source-owned baseline;
- **source-new** — the newly staged baseline; and
- **canonical-edits-since-import** — journaled changes from source-old to the
  current canonical entity, keyed by the same stable provider key.

Valid keys include IFC `GlobalId` (`ifc_provider.rs:1989`), a DXF handle when
present (`dxf_provider.rs:788`), a unique declared ASCII point number, or the
single root of a one-entity import. Names, proximity, geometry, point/row order,
and current-value equality never infer identity or ownership. For each matched
field and representation, the plan classifies: unchanged; source-only change
(update in place); local-only change (keep canonical edit); equal source/local
change (accept once); or conflict (both changed differently). The entity
summary is consequently **Unchanged**, **Updated in place**, or **Conflict**.
Every conflict appears as an explicit row in the registration island with
**Keep local**, **Take source**, **Keep old import as local**, or **Import as
new** as applicable; unresolved rows disable Update. There is never a silent
winner. New and removed stable keys remain Add/Remove.

Point-index masks, compacted tiles, extracts, and other point-addressed edits
may transfer only when the provider declares a stable point identity mapping
from source-old to source-new. With no such mapping, in-place replay is
rejected; the review offers **Keep old import as local** or **Import as new**.
This covers LAS point reordering rather than treating the one root entity id as
point identity (PC-D1/PC-D7).

The update review freezes the following passive-consumer action matrix as part
of the plan; commit revalidates every captured revision:

| Consumer                                       | Required action                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity identity and references                 | Matched stable keys retain canonical ids; additions get new ids; a removed edited/referenced entity defaults to **Keep as local** and loses source membership only. Unreferenced removal deletes atomically.                                                                                                                      |
| Locked viewing-box bake                        | Any changed source entity/dataset revision invalidates its VB-D3 revision key; keep the last valid locked result only as explicitly stale, register one settled/debounced rebuild, and atomically swap the rebuilt bake. No stale points masquerade as current.                                                                   |
| Point masks, compactions, extracts             | PC-D1 revision masks/compactions replay only through declared stable point identity; otherwise block as above. PC-D7 extracts remain immutable products of the exact old source and show **Source changed**; they are never silently regenerated.                                                                                 |
| Draped rasters                                 | If the imported image or terrain revision changes, invalidate the exact `(image revision, terrain revision, evaluator)` key, suppress any unlabeled stale output, and rebuild/atomically swap per RA-D4.                                                                                                                          |
| Measurements and anchors                       | Fixed anchors are unchanged. Attached anchors follow/revalidate only if their MI-D3 provider/representation/primitive stable address maps to source-new; failure preserves the measurement as **Unresolved — source changed** and blocks update until the user accepts the named unresolved result or keeps the old source local. |
| Plan captures                                  | A linked viewport affected by the source revision becomes **Stale**, keeps its last good capture, and refreshes under PE-D5. A pinned capture remains fixed to its exact retained revisions/artifacts and never changes.                                                                                                          |
| Applied specifications / IFC classifications   | A matched entity keeps its explicit specification assignment and BS-D12 presentation identity. Newly derived IFC classification/property data is merged field-by-field; a classification-to-specification proposal is reviewed separately under BS-D13 and never silently replaces an explicit assignment.                        |
| Layer membership                               | A matched or kept-local entity retains its exactly-one-layer membership under DR-D4; a new entity uses the import's declared target layer or Default; deletion removes membership atomically. Update never moves an entity because the source changed.                                                                            |
| Attached-project references                    | This project does not push into external host projects. Their FP-D7 bake remains exact to its recorded source manifest and FP-D8 marks it stale on check; only that host's explicit Re-sync observes this committed update. An attached project inside this project remains an independent read-only reference entity.            |
| Selection, tree, properties, render, pick/snap | Matched/kept-local ids remain selected; removed ids prune at journal apply under UIP-D18. All readers see old generation or new generation, never a mix; P4 applies to subsequent geometry acts.                                                                                                                                  |
| Export, automation, console, journal/GC        | Existing export plans are invalidated and must replan. Automation sees the identical frozen diff and conflict list. One attributed command records the merge; all retained objects remain reachability roots as below.                                                                                                            |

Before staging, Builder computes a conservative disk plan by category and
shows **Required / Available / Retained for undo**. The physical steady peak is
old object-store datasets plus new datasets; the conservative start bound also
includes staging/`ready.json`, source snapshot/copy when required, new
inventories/provenance, changed dependent bakes, and filesystem safety margin.
The operation refuses to start before writes if that bound is unavailable and
offers **Import as new entity instead** (subject to its smaller independent
preflight). X2 deliberately spends disk; it does not assume infinite disk.

The prior source artifact, prepared datasets, inventories, provenance,
affected dependent objects, and keep-local detachments are physical retention
roots while reachable from the update command in the undo horizon or from any
snapshot/reference. Ctrl+Z restores exactly that affected set; redo restores
the new set. A root is released only after it has left the configured undo
horizon **and** no snapshot, reference, or other journal state reaches it.
Only an explicit history-retention operation may advance/truncate that horizon;
ordinary cleanup never does.
FP-D16 **Clean up unreachable data** labels these bytes **Protected by undo
history** and cannot collect them; it may remove them only after the release
condition makes them truly unreachable. Update, undo, and redo register as
UIP-D10 jobs whenever large inventories/dependent bakes must reattach; payload
bytes are never copied on the UI/render thread.

Commit is one journaled compare-and-swap transaction over the expected import,
source, and dependent revisions. Prepared datasets and the complete consumer
action plan swap only at publication. Cancellation before `ready.json` removes
scratch; cancellation after `ready.json` but before commit retains verified
staging only as an explicitly resumable job or releases it on explicit Cancel;
neither state publishes canonical results. The old generation remains safe on
every failure.

### 3.4 Registration preview, close, cancel, and recovery

Every UI import reaches review before canonical publication, including
identity placement. The island shows source view and project view when exact
picking or spatial review is needed. The project view renders the staged
candidate transformed as a neutral ghost distinct from committed geometry;
an on/off **Before / After** comparison and typed transform metrics share one
state. Point-pair/ICP previews show residual/overlap diagnostics. A changed
recipe, option, target entity revision, or newer preview invalidates the old
preview and disables Commit (`docs/TRANSFORMATIONS.md` lifecycle rule).

Every point-pair row has editable source X/Y/Z and project X/Y/Z cells in
project units/precision plus a pick button for either side. Picking, typing,
and validated tabular paste mutate the same transient pair and recompute the
same fit/preview. Escape in a cell reverts it; **Delete pair** is explicit.
Parameters and transform-file remain alternative methods, not substitutes for
the point-pair method's numeric twin.

The main process owns the durable UIP-D10 job record. The sidecar registration
session owns every transient value that renderer remount must reconstruct:
committed provider-option values, all complete point-pair rows, recipe, source
token/full hash, expected revisions, and accepted preview. Only half-typed
field text and an unmatched single pick may remain renderer-local and discard.
No transient observation or consent enters a saved preset.

Island X and the final applicable Escape rung mean **close**, not cancel, with
phase-specific behavior:

| Phase at close                                                            | Result                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Awaiting user input / reviewed preview                                    | island hides; job becomes **Needs input** and reopens exactly from the sidecar session                                                 |
| Probe, full validation, staging, ICP, artifact copy, or dependent rebuild | island hides; job remains **Running** in the jobs surface and may be cancelled there                                                   |
| Atomic journal publication                                                | island shows **Finishing…**; a cancel request is honored at the next safe boundary and never interrupts a partially visible generation |
| Done / failed / cancelled                                                 | close hides the terminal result; the jobs/console record remains under UIP-D10 retention                                               |

Renderer reload rehydrates the job mirror from main and reconstructs the exact
island from the sidecar session; it does not pretend React form state survived.
**Cancel import** is explicit and consequence-named: “Discard staged import of
<file>? The source file is untouched.” The existing runtime cancel path removes
non-previewing sessions and scratch (`import_registration_runtime.rs:574-587`),
but retaining complete rows/options across close/remount is a required runtime
extension. Project/app close revokes the session, records **Interrupted** in the
main job record, and leaves committed siblings untouched. After a crash,
verified project-managed staging may be offered for hash-checked resume;
otherwise the user restarts from source. Nothing partial becomes canonical.

## 4. Function contract answers by group

### 4.1 Provider discovery, formats, and option schemas

**A1.** The user sees installed formats and exact provider versions in
Settings, probes a file without importing, and gets the same provider/options
from UI, console, Python, and agent. During import, every provider option is
visible in a typed card before staging; §3.1 is the richest example.

**A2.** We adopt RealWorks' per-format import options (`realworks.md` §2.1)
but generate them from ADR 0018 descriptors rather than provider-specific UI.
RIB's exchange breadth (`rib-civil.md` §2.10) drives dispositions, not claims
of current support. §2.3 accounts for every catalog row in both dossiers.

**A3.** File-project Export uses the same provider registry and already
decides “no hand-built per-format forms” (§1.6); IF-D5 supplies the shared
renderer, without revising FP-D5/D6. PhotoLab shares `IoClient` and
`RegistrationClient` (`packages/@himmelcad/app/src/clients.ts:629`, `:718`),
so descriptor validation and shared CRS discovery must be adopted there too.
GCP CSV and photo discovery remain ADR 0021 input-artifact lifecycles, not
format-provider competitors.

**B1.** `import.formats` has Settings, console, and automation paths; no ribbon
or entity menu because it is configuration/reference, and no shortcut because
it is infrequent. `io.probe` is console/automation and an inline import step,
not a separate ribbon button. All call the canonical registry.

**B2.** Settings · Formats closes with the Settings window X/File toggle and
Escape per its platform surface. Option cards close with the import island;
uncommitted fields discard, committed fields persist in the session. Probe is
an inline action with cancel through its owning job.

**B3.** Read-only format inventory is a Settings page. Provider options are
chat cards in the focused registration island; a separate format dialog would
split one decision across surfaces.

**C1.** There is no direct manipulation. Every displayed numeric option is a
typed `NumberInput`, with schema bounds, units, project precision where
spatial, and Escape-revert. Enum/boolean/string/unique-string-list fields use
shared controls. Loss consent is a loss-review card, not a raw schema field.

**C2.** Discovery ignores selection. Format inventory is global to the
installed build. Options belong to one source job; changing selection cannot
retarget them.

**C3.** Current probe freezes only provider id/version/format
(`canonical_provider.rs:1026-1045`). IF-D14 adds `SourceToken@1`, option- and
presentation-schema versions, immutable-snapshot-or-pre/post verification, and
the final full source hash. These are required before execution and prevent a
plugin update or changing file from changing meaning mid-session.

**C4.** Descriptors are installed capability, not journaled project state.
The selected descriptor/options and accepted losses become hash-bound import
provenance. A preset is canonical under group 4.2.

**D1.** Probe reads a bounded host prefix (`main.rs:1945-1960`), though the
current host lacks IF-D14's token/race validation. Inventory, sample preview,
and option validation are bounded <1 s with inline busy. Exact file-wide ASCII
validation, hashing, parsing, and staging are long jobs, never performed to
render the form. Gate G-IF-1 proves prefix bounds; G-IF-ASCII-LARGE proves the
full-scan path.

**D2.** Weak hardware may take longer to stage; it never reduces prefix
bounds, schema validation, deterministic selection, hashes, or loss checks.

**E1.** §6 criteria 1-3 and 7.

**E2.** Consumers are the OS file filter, Settings inventory, option renderer,
registration stage request, provider registry, provenance, export's One-import
scope, presets, console, and automation SDK. An unknown schema version makes
interactive import unavailable with “Update Builder to configure this
provider”; no field is silently pruned. Executable class fixtures are LAS
empty; Gaussian-splat scalar budgets; ASCII dynamic column map/delimited
preview (largest); and atypical SLPK probe-derived layer enum. Each must prove
field order, keyboard/focus, overflow/scroll, validation, and no format-id
branch. Equal-confidence providers produce a choice, not an arbitrary winner.
New dependencies cannot publish until their complete evidence record passes.

**E3.** G-IF-1, G-IF-2, G-IF-7, G-IF-8 in §7.

### 4.2 Import, registration, jobs, batch reuse, and presets

**A1.** §3.1, §3.2, and §3.4 are the full outcomes.

**A2.** Dual-view point alignment, refinement, and visual check adopt the
source/moving/preview posture of RealWorks Cloud-Based Registration
(`realworks.md` §2.2). Import dialogs/options adopt §2.1. RIB's checkbox
station multi-apply is the batch pattern (`rib-civil.md` §4 design lesson 4),
bounded by ADR 0025's prohibition on replaying picks. Station registration is
explicitly deferred in §2.3 rather than silently catalog-pruned.

**A3.** UIP-D10/UIP-D11 own job birth, persistence, progress, and cancel;
this group supplies import job state. FP-D17 export presets are the P1-class
precedent; IF-D3 mirrors their canonical/stale behavior but stores import
decisions. Agent AG-D4/AG-D5 own the least-authority path grants and one
plan-bound product confirmation gate. This spec adopts their bounded public
`io.operation.status/cancel` projection while every `registration.*` method,
user pick, sample, preview, and commit remains inside this visible island.
Shared CRS work uses the existing offline runtime
(`crates/himmelcad-sidecar/src/crs_runtime.rs:289`) instead of a Builder fork.

**B1.** `file.import` paths are cataloged in §1. Context menu is absent for new
import and present for update only. Needs-input job rows reopen. Console and
automation resolve to the single public `io.probe`/`io.import` pair plus
bounded `io.operation.status/cancel`. The projection returns only operation id,
phase, bounded progress, `needsUserInput`, and final disposition; it exposes no
registration resource, sample, point pair, preview payload, grant, or nonce.
Capability negotiation and the host reject every `registration.*` name for
Agent/Python. No automation method can fabricate or respond to user approval.
No shortcut. Preset and apply-similar are visible
inside the flow and jobs island, plus console and automation; neither receives
unrelated ribbon chrome.

**B2.** §3.4 is phase-specific: X/Escape makes waiting work Needs input, leaves
running work Running, and shows Finishing through an atomic boundary. Explicit
Cancel requests the next safe boundary; Commit publishes and advances to the
next needs-input job. Jobs-island closing does nothing to jobs (UIP-D10).
App/project close revokes sessions and records interruption; already committed
siblings remain.

**B3.** Modal floating island: focused multistep registration and dual spatial
views outgrow a right panel. Closing removes modality while leaving a job. Jobs
remain in the platform island, never an import-private queue.

**C1.** Typed transform parameters, origin, north bearing, CRS selections,
units, and provider options are synchronized with the preview. Each point pair
has editable source and project X/Y/Z cells plus pick buttons; typed, picked,
and pasted values mutate the same fit and recompute the same diagnostics.
Parameters and transform-file are alternative methods. Project units/precision
apply.

**C2.** New import ignores project selection. Target picks bind exact entity
and revision when applicable. Selection changes do not change a live session.
Each job owns one source; a batch is an orchestration set, not one merged import.

**C3.** Presets freeze provider/format constraints, reusable provider options,
registration method/parameters, interpretation, and
`ReusableInputSignature@1` including declared tolerances. Apply-to-similar
freezes one explicitly reviewed per-file row for each included child.
They never contain point observations, ICP samples, loss consent, or
source-specific fields. The payoff is unattended eligibility and zero repeated
answers, while each source is still probed, token-checked, and
preview-validated.

**C4.** Each file commit is one journaled/undoable command. Presets have stable
ids and revisions; names are labels, not identity. `create`, CAS-guarded
`update`, `rename`, and `delete` are each one journaled undo step; `get` and
cursor-bounded `page` are queries. Same-scope name collision returns a named
error, never overwrite. Opening a stale provider/schema never mutates the
preset; explicit repair creates an updated revision. Presets are archived and
automation-visible (P1/X3/FP-D17 class). Main job metadata and sidecar session
state split as §3.4 specifies; accepted transform, provider/options, source
hash, and losses persist as provenance after commit.

**D1.** Prefix column preview and UI transitions are bounded; full ASCII
validation is long. Stage, transformation, ICP, commit, update/undo/redo with
large inventories, and batch children are UIP-D10 jobs with real phases.
Initial batch concurrency is two, reduced to one by the resource governor
(tunable X6). Initial budgets: first truthful progress ≤250 ms; cancel
acknowledgement ≤250 ms and stop/pause at a safe streaming boundary ≤2 s
outside the explicitly labelled atomic publication phase; importer working
memory ≤1 GiB per child excluding shared viewer cache. The final
non-interruptible journal-link publication is budgeted ≤5 s; work that cannot
meet it must be prepared before entering Finishing. Disk must pass the
preflight in §3.3. Completion means full source hash verified, every declared
artifact hash/length verified, and the canonical link committed last. Dual-view
navigation is continuous and inherits G-UIP-1; G-IF-4 proves imports do not
starve it. Values are X6-tunable, correctness and refuse-before-write are not.

**D2.** Viewer quality governor may reduce staged/target display density first;
exact picking still resolves source geometry as ADR 0025 requires. Concurrency
may fall, previews may take longer, but input response, coordinate correctness,
loss review, and atomicity never degrade.

**E1.** §6 criteria 4-8.

**E2.** Import writes canonical entities, immutable objects, prepared datasets,
provenance, journal, residency, tree/properties, picking/snapping, exporters,
specification derivation, and automation-visible state. Every consumer sees
nothing before commit and the whole transaction after. View clips/visibility
do not alter import content or preview truth; P4 applies later to geometry acts.
Concurrent sessions have separate scratch/capabilities; commits serialize at
the project journal. Same-source duplicate staging is allowed but review warns
of the existing import. Current `import_registration_runtime.rs:306-325` checks
already staged resource length/read completion, while `:1284` is only the
`ResourceChanged` display text; neither protects the original source during
probe→stage. IF-D14 adds that missing race guard. New preview supersedes old;
project replacement cancels all. Largest batch: 40 × 50 GB LAS—streamed,
bounded concurrency, per-child disk preflight and independent transactions.
Least typical: three-line XYZ—still reviewed, but UIP-D10 debounce prevents
chip flicker. Crash/reload behavior follows the phase table in §3.4; no
`ready.json` state is called committed before the journal link publishes.

#### Gesture arbitration against ui-platform §3.6

The point-pair tool is the only armed viewport mode. The modal prevents a
second tool from arming.

| Gesture                               | Import claim while point-pair tool is armed                                                                                | Reconciliation                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| LMB click below threshold / touch tap | exact pick on the currently requested source or project view                                                               | explicit claim of the map's claimable LMB; strict source→project order from ADR 0025 |
| Ctrl+LMB                              | same exact pick; never changes global selection                                                                            | explicit claim prevents selection mutation inside modal review                       |
| LMB drag                              | orbit (3D) / pan (plan), no pick on release above threshold                                                                | platform-owned, unchanged                                                            |
| RMB click                             | platform context surface; import contributes no menu item                                                                  | platform-owned, unchanged                                                            |
| RMB drag; MMB drag; wheel             | pan; pan; zoom                                                                                                             | platform-owned, unchanged                                                            |
| LMB double-click                      | no tool action; platform meaning remains, selection is irrelevant to import                                                | unclaimed; no hidden fit/commit gesture                                              |
| Tab / Shift+Tab                       | move focus between the two viewport headers and island controls; never accept a point                                      | armed tool owns Tab as required; visible focus prevents candidate-cycle ambiguity    |
| Escape                                | active drag reverts (UIP-D14 rung 2); unmatched source pick discards at tool rung 4; next press reaches modal close rung 5 | one rung per press; no global selection clear                                        |
| Typing                                | focused field/control wins; otherwise registry shortcuts are suppressed by modal                                           | platform typing rule; free text never discarded                                      |

**E3.** G-IF-2 through G-IF-8 and G-IF-ASCII-LARGE in §7.

### 4.3 Changed-source update

**A1.** §3.3 in full.

**A2.** No external reference behavior is claimed. The design derives from
the already-decided project-reference re-sync class (file-project FP-D7/D8),
with the stated difference that imports are self-contained canonical data.

**A3.** FP-D8 supplies cheap-on-open/manual-update/old-data-until-commit.
FP-D7 supplies missing-source honesty. FP-D16 supplies undo reachability.
Export plans consume the updated source resource after commit (FP-D5/D6).
VB-D3, PC-D1/PC-D7, RA-D4, MI-D3, PE-D5, BS-D12/BS-D13, DR-D4, UIP-D18,
and FP-D7/FP-D8 own the consumer behavior adopted in §3.3. BS-D13 owns IFC
classification mapping and now cites this spec's stable `GlobalId` re-import
identity boundary.

**B1.** Context menu and stale badge are primary; File · Import split menu is
the selection-sensitive accelerator; console and automation share
`import.update.plan`, `import.update.execute`, and `import.relocate_source`.
Relocate's UI path uses the OS picker; automation receives a user-issued exact
source grant, never a raw path. No quick surface or shortcut: update concerns a
known imported entity, not empty viewport space.

**B2.** The §3.4 phase table applies: waiting review becomes Needs input;
hash/stage/diff/rebuild remains Running; atomic commit shows Finishing. Cancel
releases staging at a safe boundary; Commit closes on success. A missing source
leaves the prior import and badge, with Relocate available. Project close
revokes the session and records interruption without touching committed data.

**B3.** The registration island is reused because placement preview and a
potentially long conflict list need focused review. It becomes wide for the
diff; it does not create a second updater window.

**C1.** Retained transform is shown numerically and spatially; editing it uses
the same typed/preview contract as import. Counts and bounds are read-only
diagnostics. Conflict choices are explicit, not direct manipulation.

**C2.** One import group per update. Multi-selection offers one row per group,
never merges unrelated sources. Target is captured by id+expected revision;
selection changes do not retarget. Reverse-reference scan covers every entity
in the group, not only the context-clicked child.

**C3.** The accepted update plan freezes source hash, provider/version/format,
source-old baseline/ownership map, source-new baseline, canonical-edit diff,
stable-key match map, options, registration transform, the complete consumer
action matrix, disk plan, expected project/dependent revisions, and every
conflict resolution. Any changed input invalidates the plan; this converts a
long compare into a short atomic commit without weakening correctness.

**C4.** One update transaction includes source replacements, keep-local
detachments, each §3.3 consumer action, provenance, and dataset inventory. Undo
restores that affected set exactly; preferences, unrelated imports, layout,
and selection are exempt, except UIP-D18 prunes entities actually removed.
The physical roots, old+new peak, preflight, release event, and FP-D16 cleanup
interaction are normative in §3.3/IF-D15.

**D1.** Project open does not call blocking `stat`; cached status renders first,
and asynchronous liveness checks time out to **Source check delayed**. Hash/
stage/diff is long with the §4.2 progress/cancel/memory budgets. Update refuses
before writes when the conservative disk plan fails. Commit is normally
bounded but registers as long when large inventories must publish; update,
undo, and redo never copy payload on the UI thread. G-IF-5 includes an 80
GB-class old+new disk-pressure case and both sides of `ready.json`.

**D2.** Weak hardware may delay hashing and reduce preview quality, not match
strictness, dependency enumeration, expected-revision checks, or undo data.

**E1.** §6 criteria 6, 7, and 9.

**E2.** §3.3's cited matrix is the normative effect for identity/references,
locked boxes, point edits/extracts, raster drapes, measurements, Plan captures,
specifications/IFC classification, layers, attached projects, selection,
viewer/picking, export, automation, journal/undo/GC, jobs, and console.
Concurrent update of the same import is rejected as `updateInProgress`;
another import may stage concurrently, but journal commits serialize. A source
mutation during update, provider change, target revision change, unmatched
referenced removal, unresolved merge row, missing point identity, failed disk
preflight, or unremappable anchor blocks publication with old state safe.
Largest member is a billion-point/80 GB LAS root swap with revision-keyed
dependents; least typical is a file whose new bytes probe as another format—
refuse update, offer import-as-new.

**E3.** G-IF-5, G-IF-6, G-IF-8 in §7.

## 5. Decision records

**IF-D1 — Every source is a job at birth.**
**Decision:** N selected/dropped files create N main-owned UIP-D10 jobs;
needs-input is explicit; staging runs at bounded concurrency, initially two.
**Derivation:** UIP-D10 and its review finding 13; SYSTEM-001; X2; X6/P3.
**Rejected:** renderer FIFO (files 2..N are invisible and reload-orphanable);
unbounded parallelism (disk/memory contention). **Tunable:** yes—limit/governor.

**IF-D2 — Similarity reuses decisions, never observations or consent.**
**Decision:** §3.2's `ReusableInputSignature@1` is mechanical: exact provider
id/version, format, option-schema version, interpretation, declared CRS/units
source, dimensionality/record schema, axis/scale/offset posture, and normalized
header attributes within preset-declared tolerances. Every included file has a
user-confirmed summary row; deviations are flagged and excluded. Only reusable
fields and non-interactive recipe parameters cross files. Each file remains
its own token check, transaction, and failure.
**Derivation:** ADR 0025 fresh-interaction/review rule; X1; RIB §4 batch
pattern; UIP-D10/UIP-D11. This adopts ui-platform review finding 16 in this
owning domain.
**Rejected:** provider+format similarity (can misplace a tile); copy all JSON
options (replays layer ids/loss approvals); batch atomicity (one corrupt tile
blocks valid work).
**Tunable:** only declared header tolerances under X6; signature fields and
per-file confirmation are not tunable.

**IF-D3 — Import presets are canonical, constrained recipes.**
**Decision:** named presets store provider/format constraints, schema version,
reusable options, recipe method/parameters, interpretation, and input signature;
stable id plus expected revision; canonical, journaled, archived, and
automation-visible through `create/update/rename/delete/get/page`. Names are
not identity; collision fails. Stale opens for explicit revisioned repair.
**Derivation:** P1/X3; cite-and-revise from FP-D17's export-preset class; ADR 0025. **Rejected:** preferences-only state; save-as-silent-overwrite; stale
nearest-match; stored picks or loss consent. **Tunable:** no.

**IF-D4 — Update is manual, identity-strict, dependency-safe, and undoable.**
**Decision:** §3.3/§4.3 define a three-way merge of source-old, source-new, and
canonical edits, keyed by provider-stable identity and explicit persisted field/
representation ownership. Every entity is Unchanged, Updated in place, or
Conflict; every conflict has an explicit user resolution. The frozen plan
includes the cited per-consumer action matrix and an atomic expected-revision
commit. Point-addressed edits require provider-declared stable point identity.
**Derivation:** X1/X5; FUNCTION-CONTRACT E2/C4; FP-D7/D8; VB-D3; PC-D1/PC-D7;
RA-D4; MI-D3; PE-D5; BS-D12/BS-D13; DR-D4; UIP-D18; ADR 0018/0025.
**Rejected:** delete/reimport (breaks references); current-value ownership or
geometric/name/order matching (invented identity); generic stale marker (each
consumer has different safety semantics); silent source/local winner.
**Tunable:** only optional watcher/debounce values; merge classes are not.

**IF-D5 — Provider descriptors own a renderable option dialect.**
**Decision:** value validation remains closed JSON Schema, while a separately
versioned presentation dialect supplies ordered labels/control metadata,
unit/precision, and reuse class. Provider-neutral controls include scalar/
enum/list fields, `columnMap` (source column id/name, exclusive role, preview
cells), file encoding and locale-aware numeric grammar, hash-bound dynamic
enums from probe results, and read-only validation summaries. Presentation
metadata references value fields and cannot change semantics. Unsupported
value or control version disables the provider honestly. Host validates before
stage; provider validates again. For coded XYZ/CSV, the dialect also carries
catalog id/revision, raw `code`, distinct `string`/`control`, and named typed
attributes. Resolution calls BIM `spec.resolve_code` (BS-D20) inside the one
Import transaction (BS-D21), with persistent raw-code review and plain-point
fallback; the catalog's grammar is editable data under P7. Every descriptor
renders without a format-id branch.
**Derivation:** ADR 0018; X1/X5; file-project §1.6 shared export rule;
DESIGN-SYSTEM shared controls; §3.1's ASCII and SLPK fixtures.
**Rejected:** current format-id switch (`ImportRegistrationWizard.tsx:503`),
opaque JSON/string-list encoding, hidden unknown fields, or raw JSON as primary
UX.
**Tunable:** no.

**IF-D6 — Every placement is honestly previewed; CRS is explicit.**
**Decision:** §3.4. Shared offline `crs.discover/freeze/cancel` replaces the
current dead end (`ImportRegistrationWizard.tsx:413`) and free-text CRS fields;
source CRS is user-stated, metadata audit-only. Identity and local-metric
remain valid explicit outcomes without invented EPSG/origin/north. Preview
must be current before UI commit. **Derivation:** ADR 0023/0025;
`docs/TRANSFORMATIONS.md`; X1/X5. **Rejected:** silent metadata CRS, a Builder
CRS fork, identity auto-commit without review. **Tunable:** no.

Plain TIFF/PNG/JPG plus optional TFW/JGW uses the same staged-source lifecycle:
it publishes no world entity until Raster `raster.georeference.apply`; close,
cancel, restart, and scratch cleanup follow RA-D13. File/Import never invents
origin, Z, CRS, or scale.

**IF-D7 — Close keeps; Cancel discards.**
**Decision:** §3.4 and B2; close makes only waiting phases Needs input, while
running phases continue and atomic publication shows Finishing. Main owns job
metadata; sidecar owns complete option/pair/recipe/token/preview session state
needed for renderer remount. Cancel alone requests cleanup at a safe boundary,
with named confirmation.
**Derivation:** X5; DESIGN-SYSTEM complete flows/input consistency; UIP-D10/
UIP-D11/UIP-D14; ADR 0025; SYSTEM-001 single-owner lifecycle.
**Rejected:** current X=Cancel (`ImportRegistrationWizard.tsx:257-269`);
inert island X (`App.tsx:862-867`); converting running work to Needs input;
claiming renderer-local state rehydrates.
**Tunable:** no.

**IF-D8 — ASCII mapping preserves meaning.**
**Decision:** provider schema covers delimiter, decimal separator, encoding,
thousands grammar, header count, structured column roles, unit, interpretation,
and invalid-row loss. Prefix sample and exact streaming full validation are
distinct. Point-cloud output is exactly one entity + `potree@2` dataset;
survey-point output is N point entities and must pass its large-entity gate.
When a code column is bound, each row retains the raw exact code and resolves
through the selected versioned BIM catalog to entity kind, specification, and
typed parameters (BS-D20/BS-D21); incomplete generated objects enter BIM's
named completion workflow rather than receiving invented cover/height values.
Suggestions require confirmation; 50,000 rows is a warning, never conversion.
**Derivation:** `rib-civil.md` §2.6; `realworks.md` §2.1; X1; ADR 0018;
PROJECT-FORMAT unit rule; D1 bounded/long distinction. **Rejected:** guessed
mapping/unit; point-cloud-only; exact count from prefix; millions of entities
without a gate; silent invalid rows. **Tunable:** preview rows and 50,000-row
recommendation only.

**IF-D9 — Format ordering is delegated calibration with dependency gates.**
**Decision:** §2.2 order follows consumer/dependency readiness: T1 ASCII,
`.hcap` registry, IFC gaps; mesh formats only after Mesh owner+corpus; first REB
subsets only after their Point/Alignment/ElevationSurface consumers; broader
OKSTRA follows a usable REB slice. Each parser remains absent until its complete
dependency-evidence record and corpus/fuzz/real-data gates pass.
**Derivation:** X6/P3 with the recorded readiness rationale; X1; X2 code reuse;
CURRENT-DIRECTION completion discipline; dependency policy.
**Rejected:** all-at-once breadth; format names without consumers; X6 as a
rationale substitute; asking owner to rank.
**Tunable:** yes—tranche order.

**IF-D10 — Opaque proprietary codecs fail closed in both directions.**
**Decision:** §2.2 proprietary row; imports and writers reopen only on a
documented format or dependency-policy-compatible codec plus a fidelity corpus.
This rejects a Perspective TDX measurement writer under MI-D8 until that gate
is met. **Derivation:** ADR 0025 `.dc` precedent; dependency policy; MI-D8; X1.
**Rejected:** guessed/reverse-engineered read or write semantics. **Tunable:** no.

**IF-D11 — `.hcap` joins the canonical registry.**
**Decision:** wrap the existing verified importer in a descriptor/provider so
probe, options, jobs, presets, and automation are uniform; behavior remains
ADR 0027's dedicated Cap-package import. **Derivation:** ADR 0018/0021/0027;
PROJECT-FORMAT Formats. **Rejected:** permanent tenth side path. **Tunable:** no.

**IF-D12 — Automation exposes one import verb plus bounded operation status,
never registration internals, under ADR 0024** (revised to adopt Agent
AG-D4/AG-D5).
**Decision:** `io.probe`/formats require a filesystem-read grant; `io.import`
requires source read, project write, expected revisions, and approval because
it is externally sourced and state-changing. A complete non-interactive recipe
runs unattended; otherwise it returns structured `needsUserInput` or, only when
requested, creates a Needs-input job. Public `io.operation.status/cancel`
provides only the bounded projection in B1; the registration island owns all
state/resources/samples/picks/preview and commit, and commit requires the exact
single-use product confirmation grant. `io.import.execute` remains an internal app facade,
not a peer public verb; approval responses remain user-only.
**Derivation:** X3; ADR 0021/0024/0025; Agent AG-D4/AG-D5 by cite-and-revise.
**Rejected:** public registration reads (unnecessary trust/data surface; X3
parity is the public outcome and status, not low-level method parity);
automation-owned viewport picks; automation approval responses;
ungranted paths; two public import verbs.
**Tunable:** no.

**IF-D13 — Probe ambiguity is explicit.**
**Decision:** user gets a provider/version/format choice card; automation gets
candidate details unless provider is pinned; choice enters provenance.
**Derivation:** ADR 0018 and X1; current tie failure
`canonical_provider.rs:1017`. **Rejected:** registration-order winner or asking
on unequal confidence. **Tunable:** no.

**IF-D14 — Source identity is frozen across probe, stage, and preview.**
**Decision:** §3.3's bounded `SourceToken@1` is checked before provider
execution; authoritative hashing reads an immutable snapshot/copy or verifies
pre/post identity; accepted plans freeze the full source hash. A mismatch fails
closed with no mixed-byte result.
**Derivation:** X1 data integrity; ADR 0018 verified staging; FUNCTION-CONTRACT
E2; current code evidence in §4.1/§4.2 shows the gap.
**Rejected:** size/mtime only; prefix hash as authoritative; assuming an open
file cannot change.
**Tunable:** prefix byte count and snapshot strategy, never the pre/post check.

**IF-D15 — Exact heavy-data undo reserves and retains physical roots.**
**Decision:** §3.3's preflight must fund old + new immutable datasets plus
conservative scratch; insufficient budget refuses before writes and offers
Import as new entity. Old/new source, dataset, inventory, provenance, dependent,
and keep-local roots remain pinned while the undo horizon, a snapshot, a
reference, or another journal state reaches them. Release requires all such
reachability to end, and only an explicit history-retention operation may
truncate the horizon; FP-D16 cleanup cannot collect protected roots. Large
update/undo/redo is a UIP-D10 job with no UI-thread payload copy.
**Derivation:** X1; X2; FUNCTION-CONTRACT C4/D1; FP-D16; UIP-D10/UIP-D11.
**Rejected:** optimistic mid-stage ENOSPC; metadata-only undo without retained
bytes; cleanup that ignores undo roots; infinite-disk assumption.
**Tunable:** safety margin, history horizon, and category granularity; exact
reachability and refuse-before-write are not.

**IF-D16 — Missing sources relocate without changing geometry.**
**Decision:** Relocate source binds a new path/token/provenance only after
probe, hash, stable-key update review, and explicit confirmation; it is one
undoable command and never updates geometry. Mismatch offers Import as new.
**Derivation:** X5 open/repair symmetry; X1; FP-D7's missing-source Relocate
precedent; X3/ADR 0024 parity and path grants.
**Rejected:** force re-import (breaks lineage); silent path substitution; path
edit text box.
**Tunable:** no.

**IF-D17 — Protocol names use lowercase snake_case segments on the wire.**
**Decision:** dotted namespaces use lowercase snake_case segments/leaves,
matching the checked automation schema, including
`import.apply_to_similar` and `import.relocate_source`; generated Python provides
snake-case aliases. Public import is `io.import`; `io.import.execute` remains
an internal facade.
**Derivation:** ADR 0024's single versioned protocol/generated clients; the
implemented app/registration convention cited by `REGISTRY.md` F8; X1 avoids
shipping an ambiguity into generated SDKs.
**Rejected:** mixed snake/camel wire leaves; exposing both facade and public
verb.
**Tunable:** no.

## 6. E1 visual and behavioral criteria

These written criteria are the repository artifact. Implementation review
captures both themes and fails on any mismatch.

1. Column mapping shows real rows, fixed headers, one role control per column,
   visible delimiter/decimal/encoding/thousands/unit, marked sample errors, and
   clearly distinguishes the bounded sample from the exact full-validation
   count; the screenshot alone reveals whether data would be skipped.
2. Option cards use `ImportChat` structure and shared controls with only theme
   tokens. LAS empty, Gaussian-splat scalar budgets, ASCII column-map, and SLPK
   dynamic-enum fixtures show all fields in descriptor order with correct
   focus, scrolling, and validation; no format-id branch or unnecessary chrome.
3. No CRS card labels metadata “detected” or preselects it. Audit metadata is
   visibly secondary. Missing grids and ballpark exclusions are named; the
   current “cannot yet be reprojected” card is absent.
4. Transformation review shows source/project labels, staged neutral ghost,
   Before/After control, source and transformed bounds, typed transform, and
   diagnostics. Ghost and committed geometry remain distinguishable in dense
   scenes; Commit is disabled for stale/rejected preview.
5. Jobs rows distinguish Needs input/running/failed/done, show real phase and
   per-file cancel. Apply-similar says “Apply these answers to 39 similar
   files” and shows one source/transformed-bounds, frame/units, metadata,
   expected-result, and warning row per file; deviations are flagged/excluded.
6. Update review shows Added, Matched, Remove, Keep local, Conflicts, and Needs
   repair counts; every field/representation conflict and every consumer action
   is reachable from the list. The disk card shows Required, Available, and
   Retained for undo. No generic “Update?” dialog can pass.
7. Close X, **Cancel import**, and **Import/Update** are distinct controls;
   cancellation confirmation names the file and says the source is untouched.
   Running close remains Running, waiting close becomes Needs input, and atomic
   publication says Finishing. Focus returns to the invoking item. All UI copy
   is English.
8. Point-pair rows expose editable source and project X/Y/Z plus pick buttons;
   pick, type, and paste visibly update the same fit and residuals.
9. Missing-source badges expose **Relocate source…**; delayed checks say
   **Source check delayed**, never hold the project-open surface.

## 7. Verification plan and named runnable gates

The implementation adds focused scripts/tests to the normal tiers; the commands
below are the agent-runnable gates and stable IDs required by E3.

- **G-IF-1 `import.provider-contract` (changed):**
  `cargo test -p himmelcad-io canonical_provider` plus new provider tests.
  Proves bounded prefix probe, `SourceToken@1`, deterministic choice/tie
  candidates, separate value/presentation dialect validation, dynamic-enum
  probe binding, cancellation, safe paths, and package atomicity. A race
  fixture rewrites the original during probe→stage and must fail without mixed
  bytes.
- **G-IF-2 `import.ui-contract` (changed):**
  `pnpm --filter @himmelcad/ui test`. Proves every shipped descriptor renders,
  host validation precedes stage, ASCII mapping/sample-versus-full counts,
  preset staleness, loss-consent exclusion, typed/picked/pasted pair parity,
  B2 ladder, focus/accessibility, overflow/scroll, and LAS empty,
  Gaussian-splat scalar, ASCII column-map, and SLPK dynamic-enum fixtures with
  no format-id branch.
- **G-IF-3 `import.registration-runtime` (changed):**
  `cargo test -p himmelcad-sidecar import_registration_runtime`. Proves session
  isolation, ownership of committed options/complete pairs/recipe/token/preview,
  preview supersession, target-revision invalidation, cancel cleanup,
  capability revocation, and exact close/remount/reload behavior in waiting,
  validation, staging, ICP, artifact-copy, ready, Finishing, failed, and cancelled
  phases; project close records interruption.
- **G-IF-4 `import.batch-e2e` (push):** extend
  `pnpm test:pointcloud-registration-import` to accept N real fixture paths.
  Proves N jobs at birth, bounded concurrency, exact
  `ReusableInputSignature@1`, every per-file review column and exclusion,
  one frozen confirmation, per-child token invalidation, failure/cancel
  isolation, loss return-to-input, renderer reload rehydration, and standard
  navigation frame gate while two imports run.
- **G-IF-5 `import.update-e2e` (push):** extend
  `pnpm test:dxf-registration-import`. Proves same-format re-probe, handle/IFC-key
  identity, source-old/source-new/local classification, explicit conflict rows,
  no heuristic match, stable-point-identity refusal, and every §3.3 consumer row
  against VB-D3/PC-D1/PC-D7/RA-D4/MI-D3/PE-D5/BS-D13/DR-D4/FP-D7/FP-D8.
  An 80 GB-class sparse fixture proves old+new peak planning, refuse-before-write,
  protected undo/snapshot roots, FP-D16 cleanup exclusion/release, exact undo/
  redo jobs, no UI-thread payload copy, and cancellation before/after
  `ready.json`.
- **G-IF-6 `import.real-data` (release, capability `real-data`):**
  `pnpm verify:release -- --capabilities=real-data` selects a new import-real
  task: 40 LAS files including WKT/VLR/unit/axis/scale/schema outliers, changed
  and point-reordered LAS, changed DXF, IFC type/mapped-item/GlobalId fixture,
  large E57, relocated/missing/hanging source paths, and cancellation on both
  sides of the ready boundary; missing capability fails.
- **G-IF-ASCII-LARGE `import.ascii-large` (push/release):** new provider/core/UI
  gate streams multi-million-line files with bounded memory and tests
  semicolon+decimal comma, comma+decimal point, quoted fields, thousands
  separators, UTF-8, Windows-1252, invalid rows near EOF, exact counts,
  cancellation, one point-cloud result contract, and Survey-points entity/tree/
  selection/journal/undo at and above the 50,000-row recommendation.
- **G-IF-7 `import.automation` (push/release):** existing stable gate
  `automation.sdk` (`python3 -m unittest discover -s sdk/python/tests`) plus
  automation-host tests. Proves AG-D4/AG-D5 session bounds, user-only approval,
  the single public `io.import`, snake_case wire/Python generation,
  preset create/update/rename/delete/get/page with expected revisions, undo/
  redo/archive/name collisions, apply-to-similar, update/relocate, structured
  needs-input, expected revisions, and generated SDK staleness.
- **G-IF-8 `import.dependencies` (release):** existing
  `licenses.cargo-deny` (`cargo deny check`) plus validation of one checked-in
  evidence record per provider/version: official source, lock/artifact hashes,
  license match, complete transitive/runtime closure, models/datasets/native/
  generated artifacts, attribution, source revision, modifications, and
  redistribution. Missing/uncertain evidence keeps it out of product/release.
- **Manual visual (push/review):** capture criteria 1-9 in dark and light and
  compare against §6; run the gesture table with mouse, keyboard, and emulated
  touch. The visual review records images in-repo before implementation is called
  complete.

For this documentation-only change, `pnpm verify:changed` is the proportional
gate per TEST-TIERS; compiler/runtime gates are implementation gates.

Explicitly unverified at spec time: delimiter-detection success rate beyond the
fixture corpus (tunable); real hardware weak-disk concurrency governor; native
touch behavior beyond pointer emulation; T2/T3 parser fidelity until their
provider workflow promotion and real-data corpora; subjective chat rhythm beyond
§6. None is represented as implemented.

## 8. Current-implementation delta

**Keep:** canonical descriptor/package/provider contract types and registry
(`canonical_provider.rs:109`, `:374`, `:851`, `:895`), bounded prefix probe and
ambiguity failure (`main.rs:1945-1968`, `canonical_provider.rs:1013-1023`), and
host staging/journal-last publication
(`canonical_app_runtime.rs:219-255`,
`canonical_project_store.rs:699-727`); nine providers/five exporters (§2.1);
multi-session point-pair/ICP preview, revocable staged-resource reads and
cleanup (`import_registration_runtime.rs:145`, `:306-325`, `:404`, `:443`,
`:574-587`, `:1152`); registration/IO RPC families (`main.rs:1687-1908`,
`:1944-1991`); wizard/dual-view components (`ImportRegistrationWizard.tsx:68`,
`:460`); staged residency/commit flow
(`BuilderImportRegistrationIsland.tsx:104-191`, `:342-371`); offline CRS
discovery/freeze (`crs_runtime.rs:289-434`).

**Change:** owning siblings/registry reconcile `file.import` and apply-similar
per §10; renderer FIFO to UIP-D10 jobs; source-coordinate auto-commit at
`BuilderImportRegistrationIsland.tsx:223-235` to reviewed preview; X→cancel at
`ImportRegistrationWizard.tsx:257-269` to the phase-specific close contract;
hard-coded format options beginning at `ImportRegistrationWizard.tsx:503` to
the versioned descriptor renderer; shared `crs.*` replaces the dead end;
`.hcap` becomes a provider; public `io.probe`/`io.import` and bounded Agent
registration reads gain ADR 0024 grants/confirmation while internal
`io.import.execute` remains; Python gains generated aliases.

**Add:** ASCII points/T1 providers and large-file gate; presentation dialect;
`SourceToken@1`; exact `ReusableInputSignature@1`; canonical preset lifecycle;
per-file apply-similar review; asynchronous source status and Relocate;
three-way update, consumer matrix, disk preflight/retention; ambiguity card;
Settings · Formats; complete provider evidence records; T2/T3 providers only at
recorded triggers.

## 9. Owner-decision items

None. Escalation candidates were dissolved in writing:

- **Which formats and order?** X6/P3 delegates calibration; §2.2 cites each
  disposition and IF-D9 keeps licensing facts as hard gates.
- **May proprietary formats be rejected?** ADR 0025's opaque-data precedent,
  X1, and dependency policy decide the class; no money/license is accepted.
- **Update or duplicate?** X1/X5 plus FP-D7/D8 decide update-in-place; IF-D4
  dissolves identity/reference risks through stable-key three-way merge and
  offers keep-local/import-as-new where identity cannot be proven.
- **Can exact 80 GB undo spend that disk?** X1 requires retained bytes, X2
  permits the old+new peak, current C4 requires the roots/release rule, and
  FP-D16 protects every reachable object. IF-D15 adds refuse-before-write, so
  no money/product-scope question survives.
- **What counts as similar?** X1 and ADR 0025 require reviewed placement truth;
  X6 delegates tolerances. IF-D2 fixes the signature and per-file review.
- **May automation import?** X3 and ADR 0021/0024 decide recipe-complete,
  approval-bound parity; AG-D4/AG-D5 bind session reads and confirmation; ADR
  0025 keeps user observations in the visible island.
- **Who owns apply-to-similar?** Registry routing, not an owner choice:
  ui-platform finding 16 registered the obligation, file-project owns only the
  launcher/export/lifecycle boundary, and this spec owns import registration.
- **Should close cancel?** X5, DESIGN-SYSTEM complete flows, UIP-D10/D14, and
  ADR 0025 distinguish reversible close from destructive cancellation; UIP-D10
  and SYSTEM-001 assign main/sidecar continuation ownership by phase.
- **May a missing source relocate?** X5 plus FP-D7's Relocate precedent and X1
  derive IF-D16; stable-key review prevents substitution.
- **Which public method spelling?** ADR 0024's one generated protocol plus the
  implemented registration convention and `REGISTRY.md` F8 derive IF-D17;
  Python aliases preserve language idiom without a second wire spelling.

No question survives all three doctrine escalation tests; there is no owner
item to batch.

## 10. Cross-spec cite-and-revise results

The owning-source changes requested during drafting landed in the consolidated
2026-09-02 reconciliation; the table preserves their trace.

| Owning source                  | Applied disposition                                                                                                                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-project/file-project.md` | **Applied:** `file.import` is partial and links this end-to-end owner; FP-D16 cites IF-D15 so Storage labels reachable update bytes **Protected by undo history**; FP-D7/FP-D8 remain source-missing/Relocate and manual-refresh precedents.                                     |
| `ui-platform/ui-platform.md`   | **Applied:** `import.apply_to_similar` routes to IF-D2 while UIP-D10/UIP-D11 retain job/cancel ownership.                                                                                                                                                                        |
| `agent/agent.md`               | Reconciled 2026-09-02: IF-D12 and AG-D4/AG-D5 expose only public `io.import` plus bounded `io.operation.status/cancel`; `io.import.execute` and every `registration.*` method stay app-private; confirmation remains user-only.                                                  |
| `bim-specs/bim-specs.md`       | **Applied:** BS-D13 cross-links IF-D4: valid IFC `GlobalId` preserves canonical entity id across update; classification/property fields use the three-way merge; explicit specification assignment remains and derived classification-to-spec proposals are reviewed separately. |
| `REGISTRY.md`                  | **Applied:** all Import and PhotoLab rows are registered, `file.import` is partial and shared, F3/F8 are closed, and duplicate-act/gesture/state checks pass.                                                                                                                    |

## 11. Disposition — adversarial review (2026-09-02)

All 16 findings are resolved in this specification; none is deferred. Finding
4 also created the explicit owning-source requests above; the consolidated
round-3 transaction has now landed them.

| Finding     | Disposition                                                                                                                                                                                                                                   | Spec section / decision                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1 — blocker | **Resolved:** concrete source-old/source-new/canonical-edit three-way merge, persisted ownership, stable-key entity outcomes, explicit conflict list, stable-point-identity refusal, and cited passive-consumer action matrix.                | §3.3; §4.3 C3–E2; IF-D4                                       |
| 2 — blocker | **Resolved:** conservative preflight, old+new physical peak plus scratch, exact retention roots, undo/snapshot reachability, release rule, FP-D16 protection, large undo/redo jobs, and Import-as-new fallback.                               | §3.3; §4.3 C4/D1; IF-D15; G-IF-5                              |
| 3 — blocker | **Resolved:** mechanical `ReusableInputSignature@1`, preset-declared tolerances, per-file bounds/frame/metadata/result review, deviation exclusion, one frozen confirmation, and per-child revalidation.                                      | §3.2; §4.2 C3/E2; IF-D2; G-IF-4                               |
| 4 — major   | **Resolved:** §1 adopts Agent bounds and correct rows; the round-3 transaction applied the mandatory File/UI/Agent/BIM/registry revisions.                                                                                                    | status/boundary; §1; §4.2 A3/B1; IF-D12/IF-D17; §10; REGISTRY |
| 5 — major   | **Resolved:** inaccurate code claims corrected or marked missing; `SourceToken@1`, immutable-snapshot-or-pre/post verification, final hash freeze, and mutation race gate added.                                                              | §2.1; §3.3; §4.1 C3/D1; §4.2 E2; §8; IF-D14; G-IF-1           |
| 6 — major   | **Resolved:** separately versioned presentation dialect adds structured column maps, hash-bound dynamic enums, encoding/locale grammar, summaries, honest unsupported-version failure, and no format-id branch.                               | §4.1 E2; IF-D5; G-IF-1/G-IF-2                                 |
| 7 — major   | **Resolved:** prefix sample separated from full streaming validation; exact point-cloud and survey-point results; 50,000-row warning/refusal gate; bounded memory and German/EOF/large-file fixtures.                                         | §3.1; §4.1 D1; §4.2 D1; IF-D8; G-IF-ASCII-LARGE               |
| 8 — major   | **Resolved:** phase-specific close semantics and explicit main/sidecar ownership; waiting, running, Finishing, reload/remount, project close, and crash recovery are distinguished.                                                           | §3.4; §4.2 B2/C4; IF-D7; G-IF-3                               |
| 9 — major   | **Resolved:** each point pair has editable source/project XYZ, picks, validated paste, shared fit, cell revert, and explicit deletion.                                                                                                        | §3.4; §4.2 C1; §6 criterion 8; G-IF-2                         |
| 10 — major  | **Resolved:** stable preset id/revision and create/update/rename/delete/get/page parity, CAS, collision, undo/archive, and explicit stale repair.                                                                                             | §1; §4.2 C4; IF-D3; G-IF-7                                    |
| 11 — major  | **Resolved reciprocally:** schema-matching snake_case wire names, Python aliases, `import.apply_to_similar`, and one public `io.import`; Registry and Agent consume the same names and bounds.                                                | §1; IF-D17; AG-D4/AG-D13; §10; G-IF-7                         |
| 12 — major  | **Resolved:** complete row-for-row dispositions for both dossiers; glTF/PLY/OBJ/3D Tiles identified as Himmel:CAD additions; tranche order tied to consumer/dependency readiness.                                                             | §2.2–§2.3; IF-D9                                              |
| 13 — major  | **Resolved:** Source unavailable exposes Relocate through UI/console/automation; probe/hash/stable-key review, mismatch refusal, provenance-only journal commit, and undo are explicit.                                                       | §1; §3.3; §4.3 B1/B2; IF-D16                                  |
| 14 — minor  | **Resolved:** cached status renders first; bounded-concurrency asynchronous liveness with timeout reports Source check delayed; hanging-path fixture added.                                                                                   | §3.3; §4.3 D1; §6 criterion 9; G-IF-6                         |
| 15 — minor  | **Resolved:** executable LAS, Gaussian-splat, ASCII, and SLPK fixtures replace the hypothetical extreme and assert ordering/focus/overflow/validation/no branches.                                                                            | §4.1 E2; §6 criterion 2; IF-D5; G-IF-2                        |
| 16 — minor  | **Resolved:** one complete checked-in dependency-evidence record per provider/version extends `cargo deny` across official source, hashes, licenses, runtime/transitives, data/native/generated artifacts, modifications, and redistribution. | §2.2; IF-D9; G-IF-8                                           |

## Cross-spec reconciliation 2026-09-02

| Item                 | Disposition                                                                                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent boundary       | IF-D12 now matches AG-D4/AG-D5: one public `io.import`, bounded `io.operation.status/cancel`, no public `registration.*`, and user-only confirmation.                                                                                                                                                   |
| Raster staging       | Plain image/world-file inputs retain IF lifecycle and RA-D13 recovery; publication waits for Raster georeferencing and never invents coordinates.                                                                                                                                                       |
| D6 coded import      | IF-D5/IF-D8 carry catalog revision, code/string/control/attributes, call BS-D20 inside BS-D21's transaction, and route incomplete objects to BIM completion. ISYBAU/DWA rows follow BS-D22; no `easyBAU` claim.                                                                                         |
| Codec class          | IF-D10 now covers readers and writers, including MI-D8's TDX rejection.                                                                                                                                                                                                                                 |
| File/UI ownership    | File marks `file.import` partial; UI Platform routes apply-to-similar to IF-D2/UIP-D10/UIP-D11.                                                                                                                                                                                                         |
| PhotoLab/P11 round 3 | IF-D19–IF-D25 and `import.photolab-product(s)` are registered. AG-D4/AG-D13 accept the generated `io.import.product_dataset.*` rows; FP-D5/FP-D22 accept Import-vs-Attach, `.hcadx`, reader, and loss rules; Pointcloud/Raster/Mesh accept IF-D19/IF-D20/IF-D23/IF-D25 arrivals without import aliases. |
| P10/G12 invalidation | IF-D18 invalidates MT-D25 plus DR-D20/CIV-D15/RA-D15/BS-D24 outputs once after a successful source-update transaction; Import never regenerates them.                                                                                                                                                   |
| Semantic cursor      | Import cites UIP-D24/§9.7: the Builder 3D armed vocabulary is `n/a`; the registration island uses ordinary 2D controls plus the shared prohibited/wait tokens.                                                                                                                                          |
| GAP §6 Civil inbound | IF-D4/IF-D9/IF-D12 are amended by IF-D18 citations to CIV-D2–CIV-D14/CIV-D23 for readiness, migration, source invalidation, and explicit LandXML circular-vertical loss.                                                                                                                                |
| Re-walk 2026-09-02   | Complies with P5/P6 and current C4/D1/X3/B1/A2 rules. P7 fix: column/code grammars, units, and mappings are provider/catalog mechanisms plus editable defaults, never fixed office conventions.                                                                                                         |

## Owner statements batch 2 — 2026-09-02

This section amends IF-D4/D5/D8/D9/D12. Imported types may map to canonical Civil
alignments (including circular vertical segments), slopes, rigid section definitions,
Mesh surfaces/solids, Raster difference Grids/legends, BIM stratum sets, and P10
recipes only when the provider supplies the required semantics and stable source
identity. DWG/DXF readiness includes closed-curve detection with tolerance and
explicit Z/common-height review for area/base-surface hand-off; it never invents
closure or elevation. LandXML loss planning names unsupported circular vertical
segments and every flattened/dropped recipe, slope, section, solid, Grid/legend, or
stratum field before write.

Changed-source update preserves stable ids where IF-D4 permits and invalidates
dependent profiles, labels, corridors, slopes/pits, surfaces, sections, solids,
difference Grids, drapes, Plan captures, and measurements at gesture/transaction end.
Each owner then applies P10; Import never regenerates these products or silently
prunes an admitted catalog row. Unknown recipe/type versions round-trip as opaque
preserved data when the format allows it or fail closed with an explicit loss.

**IF-D18 — Civil and batch-2 products are admitted with explicit readiness and
loss.** **Decision:** the type/consumer/invalidation/loss behavior above extends
IF-D4/D5/D8/D9/D12; owning domains validate meaning and regeneration. **Derivation:**
P10, X1, X3, Civil CIV-D2–D14, VD-D15, MT-D25–D27, RA-D14/D15, BS-D25,
FP-D22. **Rejected:** silent spline substitution for circular verticals; guessed
DWG heights/closure; import-owned regeneration; silent catalog pruning. **Tunable:**
closed-curve tolerance and provider rollout gates under X6.

Verification adds DWG nearly/open/closed and missing-Z fixtures; LandXML circular-
vertical round trips/loss; stable-id update invalidation for every consumer; linked/
detached/unknown recipe versions; cancel/restart; and format matrices proving every
admitted type is mapped, rejected, or disclosed before export.

| Work-order item                                              | Disposition                                   |
| ------------------------------------------------------------ | --------------------------------------------- |
| S7–S11 imported Civil/section/solid/difference/strata types  | Applied by IF-D18.                            |
| DWG closed-area readiness and LandXML circular-vertical loss | Applied by IF-D18.                            |
| P10 dependency invalidation/no silent catalog prune          | Applied by IF-D18; owning domains regenerate. |

## PhotoLab product datasets — 2026-09-02

This amendment specifies the Builder-owned capability **Register a PhotoLab
product dataset**. It does not make the source PhotoLab project mutable, add a
PhotoLab-specific viewer, or define PhotoLab-side production work. That work
remains with `docs/implementation-plans/2026-09-photolab-release-polish.md`
Phase G / WP-G1.

**Implementation readiness:** drafted and blocked. No row in this amendment is
implementation-ready until (1) DATA-MODEL, PROJECT-FORMAT, and an accepted ADR
admit the package and provenance schemas proposed below, and (2) the Registry,
Agent, Pointcloud, Raster, Mesh & Terrain, and File & project owners land the
cite-and-revise requests at the end of this amendment. These are explicit
dependencies, not permission to invent temporary package, provenance, entity,
or command contracts.

The R1 gate at `docs/ROADMAP.md` line 20 is **unmet today**. PhotoLab has
published products, but Builder's registration preview and canonical-residency
restore admit only `potree@2` datasets
(`apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:125,155`;
`apps/builder/renderer/src/App.tsx:1398-1416`), and the registration runtime can
sample only the first staged `potree@2` dataset
(`crates/himmelcad-sidecar/src/import_registration_runtime.rs:367-373`). The
gate closes only when every then-**Available** row below registers through the canonical
package/registration contract in Builder, reopens there with its immutable
lineage visible, and the same committed entities open read-only through the
shared canonical contracts in WeltView. A PhotoLab product merely existing, or
rendering inside PhotoLab, does not close the gate. Every renderable product
kind shipped by the PhotoLab release must first reach **Available**; leaving it
Deferred because its owner/admission work is missing keeps R1 gate 8 open rather
than shrinking the gate.

### Catalog rows

These are registry additions; they do not create a second general import act.
`import.photolab-product` is a source-kind specialization of `file.import` and
uses the same job, registration, commit, undo, and recovery lifecycle. The
round-3 registry records and counts both rows and P11 exposure. They remain
non-implementation-ready until the schema/package dependencies and runtime
gates land.

| Id                         | Tab · group                 | Access paths                                                                                                                                                                    | Surface                                                                                                  | Perf                                          | Canonical operation                  | Status vs current implementation                                                                                                                                                                                           |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import.photolab-product`  | File · Import               | ribbon **Import…** → **PhotoLab product dataset**; local project/product chooser; generated console `import product-dataset register`; agent/Python; no entity menu or shortcut | existing registration island with a product-selection card and the two source/project views; UIP-D10 job | bounded catalog/validate; long stage/register | `io.import.product_dataset.register` | **missing** — the Builder registration and restore branches accept only `potree@2` (`apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:124-137,153-173`; `apps/builder/renderer/src/App.tsx:1395-1417`)        |
| `import.photolab-products` | File · Import support query | product chooser; generated console `import product-dataset list`; agent/Python                                                                                                  | bounded paged list in the same island                                                                    | bounded                                       | `io.import.product_dataset.list`     | **partial, not automation-ready** — PhotoLab can enumerate product records (`crates/himmelcad-sidecar/src/project_runtime.rs:4505-4768`), but that product-owned projection is not a generated canonical command-table row |

The chooser lists every published record, including legacy, raw-mesh, and
unknown-future records. Each row shows stable product id/version, kind, label,
publication generation, dataset label, normalized ingress format when known,
package hash/size/count when published, provenance state, and exactly one
disposition: **Available**, **Needs preparation**, **Needs republish/recompute**,
or **Unsupported**, with a stable reason code. **Available** is legal only after
all admission and owner dependencies above land. A missing package inventory is
**Needs preparation**; `provenanceStatus: partial | unknown` is **Needs
republish/recompute**. Neither case offers Commit, and `list` never walks or
hashes the artifact hierarchy to improve the row. Preparation and
republish/recompute are separate visible PhotoLab jobs under WP-G1; Builder
never starts either inside listing or registration.

Disposition precedence is deterministic: a kind/format with no admitted owner
mapping is `unsupported`; otherwise incomplete lineage is
`needs_republish_recompute`; otherwise a missing/incomplete package or prepared
binding is `needs_preparation`; only a complete admitted package, complete
lineage, supported format, and accepted owner contract is `available`.

### Prepared-format and published-product dispositions

PhotoLab's `ProjectProductDatasetRecord.format` values are inventory labels,
not canonical prepared-dataset `formatId` values. Registration validates and
normalizes an eligible label to one of the exact canonical formats in this table;
it never passes a UI label into the renderer as a guessed format id.

| PhotoLab publication / candidate format                                                   | Resulting canonical entity and sibling owner                                                                                               | Disposition for this capability                                                                                                                                                          | Verified basis and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `potreeV2` sparse point cloud                                                             | `hcad.point-cloud@1`; Pointcloud                                                                                                           | **Eligible after package/provenance admission and Pointcloud acceptance; not implementation-ready**, normalized to `potree@2`                                                            | Sparse inventory requires a Potree hierarchy and reports `potreeV2` (`crates/himmelcad-sidecar/src/project_runtime.rs:4670-4700`); the shared Potree provider parses version 2 metadata and hierarchy (`crates/himmelcad-render/src/providers/potree.rs:350-405`) and decodes bounded nodes (`crates/himmelcad-render/src/providers/potree.rs:535-559`).                                                                                                                                                                                                                                                                                                                              |
| `potreeV2` sparse point cloud from a published overlap or shared-control merged alignment | `hcad.point-cloud@1`; Pointcloud                                                                                                           | **Adopted under the same manifest and normalized to `potree@2` after package/provenance admission**                                                                                      | This is not a new format or entity kind. `source_alignment_kind` is `merged_overlap` or `merged_shared_control`; the merge entity id/version/`lineage_sha256` and the ordered `source_alignment_inputs: [{id, sha256}]` list are mandatory. A mixed overlap/shared-control merge is not representable by this V1 enum and must be republished as one declared merge kind or wait for a later schema.                                                                                                                                                                                                                                                                                  |
| `potreeV2` prepared dense point cloud                                                     | `hcad.point-cloud@1`; Pointcloud                                                                                                           | **Eligible after package/provenance admission and Pointcloud acceptance; not implementation-ready**, normalized to `potree@2`                                                            | Dense inventory reports `potreeV2` only when `record.potree` exists (`crates/himmelcad-sidecar/src/project_runtime.rs:4637-4668`). The same exact canonical point-cloud admission and Potree decoder apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `binaryPly` dense fallback                                                                | none until prepared                                                                                                                        | **Deferred** — not a prepared dataset and there is no canonical non-splat PLY dataset admission in the current render path                                                               | Dense inventory explicitly falls back to `binaryPly` when `record.potree` is absent (`crates/himmelcad-sidecar/src/project_runtime.rs:4643-4649`). The chooser reports **Needs preparation**; it does not reinterpret this as splat PLY or load it monolithically.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rasterPyramid` DEM                                                                       | `hcad.elevation-surface@1` with `ElevationSurfaceGeometry::Grid`; Raster                                                                   | **Eligible only after the exact DEM facts and resources above are frozen; until then `package: null` and not Available**                                                                 | The admission object must declare `Grid { raster: GeometryResource, mapping: OrthoGridMapping, sampling: DepthSampling }` and the lineage must carry `PhotoLabDemFactsV1`: `ElevationZ`, exact `RasterInterpolation`, exact `RasterConnectivity`, source NoData semantics, mandatory validity resource, and conditional connectivity-mask resource. The representation slot binds those same resources to a hash-verified `himmelcad-prepared-hierarchy@1` Raster root. Nothing is inferred. The type and validation basis are `crates/himmelcad-core/src/entity_model.rs:465-495,561-715` and Raster's PhotoLab-arrival row (`docs/builder-program/specs/raster/raster.md:814-823`). |
| `rasterPyramid` orthomosaic                                                               | `hcad.raster-image@1`; Raster RA-D11                                                                                                       | **Needs canonical `PlanGrid2D` admission**; not implementation-ready until RA-D11's DATA-MODEL/generated-reader delta lands                                                              | The only R1 arrival is `RasterImageGeometry` plus `RasterMapping::PlanGrid2D`, carrying the source pixel-grid affine XY transform, frozen CRS, no depth, no entity placement, and `z: null`. It is a georeferenced XY grid; RA-D11's “plan-only” describes its view/coordinate authority without Z, not an unreferenced image or Plan-document artifact. RA-D11 rejects a zero-height `OrthoGrid`; the current PhotoLab `z: 0` bridge (`apps/photolab/renderer/src/PhotolabKernelViewport.tsx:290-347`) is display evidence only and is never an import mapping.                                                                                                                      |
| `tiledMesh` with `preparedMesh.canonicalDataset`                                          | `hcad.surface-3d@1`, or `hcad.object-3d@1` when the verified topology is closed; Mesh & Terrain                                            | **Eligible after package/provenance admission and Mesh acceptance; not implementation-ready**, using `himmelcad-prepared-hierarchy@1`                                                    | Product enumeration exposes the prepared canonical dataset only when all mesh contract parts are present (`crates/himmelcad-sidecar/src/project_runtime.rs:4529-4615`). The canonical adapter distinguishes open Surface3d from a closed-mesh solid (`crates/himmelcad-sidecar/src/project_runtime.rs:1203-1240`); shared admission requires the prepared-hierarchy render resource, preparation recipe, and section-topology index and verifies all three (`packages/@himmelcad/viewer/src/kernel/KernelPreparedMeshDatasetAdmission.ts:95-144`).                                                                                                                                    |
| legacy `tiledMesh` without that complete prepared contract                                | none                                                                                                                                       | **Deferred** — a legacy display manifest is not a complete ADR 0018 canonical package                                                                                                    | Enumeration deliberately leaves `preparedMesh` absent when the canonical parts cannot be assembled (`crates/himmelcad-sidecar/src/project_runtime.rs:4541-4597`). Registration fails closed instead of manufacturing mesh semantics or provenance.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mvsDepth`                                                                                | none as a standalone Builder product                                                                                                       | **Deferred** — `output/index.json` is a PhotoLab MVS artifact index, not a render-core prepared-dataset format or one of this amendment's pointcloud/raster/mesh/splat canonical results | MVS publication creates a `DepthMap` product and optionally a dense point cloud (`crates/himmelcad-sidecar/src/project_runtime.rs:5833-5915`); inventory points `mvsDepth` to `output/index.json` (`crates/himmelcad-sidecar/src/project_runtime.rs:4616-4636`). It may remain lineage input to an eligible raster/mesh product, but this capability does not invent a standalone Builder geometry kind.                                                                                                                                                                                                                                                                              |
| Gaussian-splat `prepared`                                                                 | `hcad.gaussian-splat-cloud@1`; Pointcloud (authoritative arrival ownership at `docs/builder-program/specs/pointcloud/pointcloud.md:65-74`) | **Eligible after the data-model and package/provenance admission; no unresolved owner choice remains**                                                                                   | Pointcloud already owns streamed render, entity/bounds pick and snap, P9 selection, whole-entity placement, tree/Properties, Plan, export-loss review, WeltView, and paged automation; per-point editing remains unsupported until stable point identity is admitted. ADR 0030 Decision 10 revision 3's “owner unresolved” wording is stale and must follow this owner row in revision 4.                                                                                                                                                                                                                                                                                             |
| Gaussian-splat `brushPly`                                                                 | none until prepared                                                                                                                        | **Deferred** — monolithic fallback is not interaction-ready prepared data                                                                                                                | Inventory labels an unprepared fallback `brushPly` (`crates/himmelcad-sidecar/src/project_runtime.rs:4702-4719`), and PhotoLab's current viewport refuses it for interactive viewing (`apps/photolab/renderer/src/PhotolabKernelViewport.tsx:356-359`). A bounded PLY decoder exists (`crates/himmelcad-render/src/providers/gaussian_splat.rs:78-95`), but its existence does not satisfy X2 or ADR 0018's prepared large-data publication contract.                                                                                                                                                                                                                                 |
| canonical `potree@2`                                                                      | point-cloud rows above                                                                                                                     | **Eligible ingress format after package admission; not a product disposition by itself**                                                                                                 | This is the exact existing canonical dataset format checked by the viewer admission (`packages/@himmelcad/viewer/src/kernel/KernelPotreeDatasetAdmission.ts:74-103`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| canonical `himmelcad-prepared-hierarchy@1`                                                | eligible raster, mesh, and Pointcloud-owned prepared-splat rows above; gated by matching canonical geometry and content kind               | **Eligible ingress format after package admission; not blanket adoption**                                                                                                                | The render-core parser names and validates this exact format (`crates/himmelcad-render/src/providers/prepared.rs:59-111`); exported providers cover raster, Gaussian splat, and glTF mesh decoding (`crates/himmelcad-render/src/providers/mod.rs:25-39`).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| claimed canonical `mesh@1`                                                                | none                                                                                                                                       | **Deferred as an unverified identifier; do not emit or accept it**                                                                                                                       | A repo-wide exact search on 2026-09-02 found no prepared-provider declaration or dataset decoder for `mesh@1`; its only exact occurrence is a test `render_proxy_id` (`crates/himmelcad-render/src/mesh_picking.rs:2155-2163`). Actual prepared mesh admission requires `himmelcad-prepared-hierarchy@1` (`packages/@himmelcad/viewer/src/kernel/KernelPreparedMeshDatasetAdmission.ts:114-122`).                                                                                                                                                                                                                                                                                     |

`himmelcad-prepared-hierarchy@1` is not blanket permission to accept arbitrary
contents. Validation requires the canonical entity kind, representation slot,
geometry/resource hash, root manifest, every referenced artifact, and every
tile `ContentKind` to agree. Unsupported or mixed semantics fail before review;
registration never relabels Raster, glTF mesh, or GaussianSplats content. All
otherwise eligible rows remain unavailable until the common package/provenance
admission and their named owner acceptance land.

### Pending package and provenance admission

Before conforming implementation, DATA-MODEL, PROJECT-FORMAT, and an accepted
ADR must admit the common `hcad.product-import-package-manifest@1` profile, the
`hcad.product-import-package-ready@1` ready record, the
`hcad.photolab-product-publication@1` publication record, and the
`hcad.photolab-product-provenance@1` component. This is a constrained
`CanonicalImportPackage`/fragment-like transfer profile under ADR 0018, not a
product-private viewer bridge. ADR 0030 revision 3 is an incomplete
cite-and-adopt: its revision 4 must adopt the exact identifiers and shapes below
without renaming or weakening them.

The wire primitives used below are exact:

- `u32` and `u64` are JSON integers in the inclusive ranges `0..2^32-1` and
  `0..2^64-1`; booleans are JSON booleans.
- `string` is a UTF-8 JSON string. An id, path, format, role, media type, or
  schema id is nonempty; labels may be empty only when the source label was
  empty at publication.
- `Sha256` is a JSON string of exactly 64 lowercase hexadecimal characters.
- `Decimal64` is the JSON string encoding defined under “Canonical decimal
  encoding” below. No JSON number with an `f64` meaning is legal in a manifest
  or lineage payload.
- `T[]` is a JSON array. Unless a field-specific order is stated, manifest
  arrays are sorted by the named id/path in ascending UTF-8 byte order and have
  no duplicate key. ProductLineage identity arrays retain their stated semantic
  order.
- A `?` member is omitted when inapplicable or unavailable; it is never encoded
  as JSON `null`. All members without `?` are present. The required `package`
  member of `PhotoLabProductPublicationRecordV1` is the sole nullable member in
  these schemas.

The closed enumerations are:

```text
ProductKind = "sparse" | "dense" | "dem" | "orthomosaic" |
              "mesh" | "gaussianSplat"
NormalizedFormatId = "potree@2" | "himmelcad-prepared-hierarchy@1"
ProvenanceStatus = "complete" | "partial" | "unknown"
ProductDatasetDisposition = "available" | "needs_preparation" |
                            "needs_republish_recompute" | "unsupported"
RepresentationKind = "canonical" | "body" | "axis" | "footprint" |
                     "boundary" | "alternate"
ResourceRole = "lineage" | "admission_entity" |
               "representation_object" | "canonical_object" |
               "registration_audit" | "dem_validity" |
               "dem_connectivity"
ArtifactRole = ResourceRole | "dataset"
ReasonCode = "available" | "needs_republish_recompute" |
             "needs_preparation" | "unsupported_format" | "no_package" |
             "invalid_package" | "unsupported_package_schema"
```

`ProductLineageIdentityV1` has one shape everywhere it is used. Version is part
of the stable `id`; producers do not add `version`, `configuration_sha256`, or
`binary_sha256` alternatives:

```text
ProductLineageIdentityV1 {
  id: string,
  sha256: Sha256
}
```

For `algorithms`, `id` is the versioned algorithm identifier and `sha256` hashes
the immutable implementation descriptor; for `configurations`, `id` is the
versioned configuration/profile identifier and `sha256` hashes its canonical
resolved bytes; for `tools`, `id` is the versioned executable/tool identifier
and `sha256` hashes the executable or immutable tool bundle. These arrays are
always present, may be empty only when the publication used no member of that
class, and preserve pipeline execution, configuration-application, and tool-
invocation order respectively. Repeated invocations therefore remain repeated
array entries.

The exact lineage wire shape is:

```text
ProductLineageV1 {
  source_project_id: string,
  source_project_fingerprint: Sha256,
  product_entity_id: string,
  product_entity_version_hash: Sha256,
  product_content_hash: Sha256,
  publication_generation: u64,
  product_kind: ProductKind,
  product_label: string,
  dataset_label: string,
  source_format: string,
  normalized_format_id?: NormalizedFormatId,
  source_alignment_kind: "single" | "merged_overlap" |
                         "merged_shared_control",
  source_alignment_entity_id: string,
  source_alignment_entity_version_hash: Sha256,
  source_alignment_content_hash: Sha256,
  source_alignment_inputs?: ProductLineageIdentityV1[],
  processing_set_choice:
    { kind: "selected", id: string, version_hash: Sha256,
      membership_sha256: Sha256 } |
    { kind: "none" } |
    { kind: "all_imported_cameras" },
  camera_selection_sha256: Sha256,
  image_mask_scope:
    { kind: "selected", scope_sha256: Sha256 } |
    { kind: "none" },
  gcp_choice:
    { kind: "selected", entity_id: string,
      entity_version_hash: Sha256, snapshot_sha256: Sha256 } |
    { kind: "none" },
  spatialReference:
    { kind: "localMetric",
      unit: "millimeter" | "centimeter" | "meter" | "inch" | "foot",
      axes: "rightHandedZUp" } |
    { kind: "crsBacked" },
  reference_frame:
    { kind: "local_frame" } |
    { kind: "frozen", project_reference_frame: {
        target: FrozenCrsEndpointV1,
        establishedByTransformationSha256: Sha256
      } },
  algorithms: ProductLineageIdentityV1[],
  configurations: ProductLineageIdentityV1[],
  tools: ProductLineageIdentityV1[],
  registration_audit?: ProductLineageIdentityV1,
  dem_facts?: PhotoLabDemFactsV1
}

FrozenCrsEndpointV1 {
  horizontal: {
    crs: { kind: "epsg", value: u32 } |
         { kind: "authority", value: string } |
         { kind: "wkt2", value: string } |
         { kind: "projJson", value: string },
    coordinateEpoch?: { decimalYear: Decimal64 }
  },
  vertical:
    { kind: "unknown" } |
    { kind: "ellipsoidal" } |
    { kind: "orthometric", verticalCrs: FrozenCrsEndpointV1.horizontal.crs } |
    { kind: "normalHeight", verticalCrs: FrozenCrsEndpointV1.horizontal.crs } |
    { kind: "deviceProfile", profileId: string }
}
```

`normalized_format_id` is present exactly when a canonical prepared format is
known; unsupported/unprepared publications retain `source_format` and omit it
without becoming incomplete. `source_alignment_inputs` is absent for `single`.
For either merged kind it is mandatory and contains at least two entries in the
published `MergedAlignmentRunRecord.input_alignment_entity_ids` order; each
entry is `{id: <input alignment entity id>, sha256: <that input entity version
hash>}`. The enclosing source-alignment id/version identify the published merge
entity and `source_alignment_content_hash` equals that merge record's
`lineage_sha256`. For `single`, `source_alignment_content_hash` is the immutable
alignment artifact content hash. `registration_audit.id` is the source
registration command/audit id and its `sha256` hashes the exact immutable audit
bytes; the member is absent if no source registration occurred. `dem_facts` is
mandatory only for `product_kind: "dem"` and absent for every other kind.

The DEM fact shape is exact and mirrors Raster's admitted types rather than
inventing an Import-owned sampling model:

```text
PhotoLabDemFactsV1 {
  semantics: "elevationZ",
  interpolation: "nearest" | "bilinear" | "discontinuityAware",
  connectivity:
    { kind: "pixelSteps" } |
    { kind: "continuous",
      diagonal: "topLeftToBottomRight" | "topRightToBottomLeft",
      maximumHeightJump?: Decimal64 } |
    { kind: "mask",
      resource: ResourceIdentityV1,
      encoding: "twoBitsPerCellLsb0",
      diagonal: "topLeftToBottomRight" | "topRightToBottomLeft" },
  source_no_data:
    { kind: "numeric", value: Decimal64 } |
    { kind: "nan" } |
    { kind: "alphaMask" },
  validity: {
    resource: ResourceIdentityV1,
    encoding: "bitsetLsb0"
  }
}

ResourceIdentityV1 {
  resource_id: Sha256,
  sha256: Sha256,
  byte_length: u64,
  media_type: string
}
```

For both DEM resources `resource_id == sha256`. The validity resource is always
present and authoritative: one LSB-first bit per row-major pixel, `1` meaning
valid, byte length `ceil(width * height / 8)`. Numeric, NaN, and alpha source
NoData are publication provenance only and are materialized into that separate
validity resource; alpha is never elevation validity after admission. A mask
connectivity resource has exactly two LSB-first triangle-admission bits per
row-major non-wrapping cell and byte length
`ceil(2 * (width - 1) * (height - 1) / 8)`. `nearest` requires `pixelSteps`;
`bilinear` forbids `pixelSteps`; `maximumHeightJump` is finite and non-negative.
The canonical Grid admission and prepared Raster root must reference these exact
resources and facts. Until all of them are frozen, a DEM publication has
`package: null`; PhotoLab must not emit a DEM import package or infer a default.

```text
ProductImportPackageManifestV1 {
  schema_id: "hcad.product-import-package-manifest@1",
  manifest_id: string,
  producer { product_id: string, product_version: string, build_hash: Sha256,
             canonical_schema_versions: string[] },
  source { project_id: string, project_fingerprint: Sha256,
           publication_generation: u64 },
  product { entity_id: string, entity_version_hash: Sha256,
            content_hash: Sha256, kind: ProductKind,
            label: string, dataset_label: string },
  lineage { schema_id: "hcad.photolab-product-lineage@1",
            lineage_object_sha256: Sha256, payload: ProductLineageV1 },
  admissions[{ entity_id: string, type_id: string, schema_version: u32,
               entity_object_path: string, entity_object_sha256: Sha256,
               representation_slots[{ slot: string, kind: RepresentationKind,
                                      object_sha256: Sha256 }] }],
  datasets[{ dataset_id: string, entity_id: string, slot: string,
             format_id: NormalizedFormatId,
             content_kind: "potreePoints" | "raster" | "gltf" |
                           "gaussianSplats",
             root_path: string, root_sha256: Sha256,
             artifact_paths: string[] }],
  resources[{ resource_id: Sha256, owner_entity_id: string,
              role: ResourceRole, object_path: string,
              sha256: Sha256, byte_length: u64, media_type: string }],
  artifacts[{ path: string, sha256: Sha256, byte_length: u64,
              media_type: string, role: ArtifactRole }],
  required_features: string[],
  counts { object_count: u64, artifact_count: u64, total_bytes: u64 },
  package_sha256: Sha256
}

ProductImportPackageReadyRecordV1 {
  schema_id: "hcad.product-import-package-ready@1",
  manifest_id: string,
  product_id: string,
  product_version_hash: Sha256,
  publication_generation: u64,
  normalized_format_id: NormalizedFormatId,
  manifest_sha256: Sha256,
  lineage_object_sha256: Sha256,
  provenance_status: ProvenanceStatus,
  missing_field_ids: string[],
  artifact_count: u64,
  object_count: u64,
  total_bytes: u64,
  package_sha256: Sha256
}

PhotoLabProductPublicationRecordV1 {
  schema_id: "hcad.photolab-product-publication@1",
  publication_id: string,
  product_id: string,
  product_version_hash: Sha256,
  product_content_hash: Sha256,
  publication_generation: u64,
  lineage { schema_id: "hcad.photolab-product-lineage@1",
            lineage_object_sha256: Sha256, payload: ProductLineageV1 },
  provenance_status: ProvenanceStatus,
  missing_field_ids: string[],
  disposition: ProductDatasetDisposition,
  reason_code: ReasonCode,
  package: null | {
    schema_id: "hcad.product-import-package-ready@1",
    manifest_id: string,
    package_relative_path: string,
    normalized_format_id: NormalizedFormatId,
    manifest_sha256: Sha256,
    artifact_count: u64,
    object_count: u64,
    total_bytes: u64,
    package_sha256: Sha256
  }
}
```

`publication_generation` is the PhotoLab project journal authority's next
committed command sequence: checked `current command_sequence + 1`. It is
allocated once before candidate-package creation and is identical in lineage,
manifest, ready record, publication record, and the eventual committed journal
entry. Overflow rejects publication; saturating/reusing a generation is
forbidden. The implementation's candidate-command-sequence approach is thereby
ratified, with checked arithmetic required.

`publication_id` and, when `package` is non-null, `manifest_id` are the same
deterministic id:

```text
"product-" + sha256(canonical_json([
  source_project_id,
  product_entity_id,
  product_entity_version_hash,
  publication_generation
]))
```

The preimage is a four-element JSON array in that order; its three identity/hash
members are JSON strings and its generation is a JSON `u64`. Determinism is
chosen over a UUID because X1 requires an identical committed publication to
have one detectable identity and because generation plus entity version keeps
distinct publications distinct. `datasets[].dataset_id` is copied unchanged
from the validated `CanonicalPreparedDataset`; Import never derives an alias.
Every `resources[].resource_id` equals that row's `sha256`. Resource and artifact
roles are exactly the enumerations above: `lineage` names `objects/lineage.json`;
`admission_entity` the canonical entity envelope; `representation_object` the
selected geometry; `canonical_object` another hash-bound object;
`registration_audit`, `dem_validity`, and `dem_connectivity` their named
resources; and `dataset` every prepared-dataset file including its root.

`admissions` contains the exact canonical entity envelope/object(s) Builder
will validate and commit; the product key is not permission to synthesize an
entity. Dataset `entity_id`/`slot`/`format_id`/root bindings must equal those in
the admission object. Every reachable non-streamed resource appears once in
`resources` and `artifacts`; every streamed dataset root and descendant appears
once in `datasets[].artifact_paths` and `artifacts`. Hashes are SHA-256, lengths
are exact non-negative byte counts, media types are registered nonempty values,
and counts equal the complete declared inventory. `package_sha256` is the one
SHA-256 over this canonical manifest payload with only the `package_sha256`
member omitted: UTF-8 JSON, object keys sorted by UTF-8 byte order, declared
array order retained, no insignificant whitespace, strings emitted by the
shared generated JSON serializer, integers in base-10 without leading zeroes,
and no floating-point manifest values. Because every object/resource/artifact
hash is inside that payload, it binds the complete package without depending on
filesystem enumeration order.

The admission object's semantic body, geometry/resource references, type,
schema version, and representation slots are immutable package truth. ADR 0025
may compose only the host-owned destination entity id, destination placement,
and destination registration/provenance component named in the reviewed plan;
the resulting final envelope and version hash are validated before commit. This
identity composition is recorded in provenance and cannot alter product bytes,
mapping, topology, sampling, CRS, or package-local ids. It is what permits a
later product version to import as a new destination entity without colliding
with the earlier destination id.

Artifact paths are normalized UTF-8 relative POSIX paths. Empty/absolute paths,
`.` or `..` segments, backslashes, NUL, duplicate normalized paths, and
platform-case-fold collisions are rejected before any copy. A declared path
must remain under its operation-owned package root after canonical resolution;
undeclared files are ignored and never staged, while a declared missing or
changed file fails the operation. Builder stages only declared hash-addressed
bytes, validates all objects through ADR 0016/0018, and commits the declared
entity plus its provenance component in one journal-last transaction.

PhotoLab publication always writes the publication record. Its `lineage` is the
same hash-bound envelope used by a package and is durable even when no package
is written; `package: null` then states that fact without a fabricated manifest
id or zero hash. When a package exists, PhotoLab creates the candidate package,
fsyncs its manifest and declared artifacts, writes `ready.json` in the exact
member order shown above with `package_sha256` physically last, then atomically
publishes a publication record whose `package` summary agrees field-for-field.
The ready record's distinct `hcad.product-import-package-ready@1` schema id is
not the manifest schema id. `list` reads only the bounded publication record and
ready summary. Builder never accepts an inventory assembled by walking a
product directory after publication.

Compatibility is fail-closed and lossless: an unknown manifest major/type id or
unknown `required_features` value returns `unsupported_package_schema`; unknown
non-required fields in a recognized `@1` manifest and lineage payload are not
semantic inputs but the original canonical manifest/lineage bytes are retained
byte-for-byte through import and native archive round-trip. Migration is owned
by the shared DATA-MODEL/PROJECT-FORMAT canonical-I/O layer, emits a new package
and provenance revision, preserves the source package, and requires its own ADR
rule; neither Builder nor PhotoLab privately rewrites an old package in place.

### Publication-time lineage and honest legacy state

For publications made after the package contract exists, PhotoLab must freeze
`ProductLineageV1` **before** the ready record and product record become visible.
The mandatory and conditional members, union tags, identity arrays, decimal
encoding, and absence rules are exactly the schema above. `unknown` is not legal
for a new publication: even an unsupported or not-yet-prepared product receives
a complete lineage-only publication record with `package: null`. Package
eligibility and lineage completeness are independent facts.

Builder creates `hcad.photolab-product-provenance@1` as a hash-bound envelope
containing the exact lineage payload bytes, `lineage_object_sha256`, the source
`package_sha256`, and the destination registration audit. It does not
deserialize and reserialize away unknown optional fields. Properties and
automation expose a read-only projection plus the exact component hash; generic
property mutation rejects the component.

Legacy records use an explicit `provenanceStatus`:

- `complete` means every post-contract mandatory field and package hash exists
  and validates;
- `partial` means at least one trustworthy publication-time lineage value
  exists but one or more mandatory field ids are absent; and
- `unknown` means no trustworthy publication-time lineage payload exists.

The `missing_field_ids` storage member and its `missingFieldIds` `products.list`
projection contain ProductLineageV1 member identifiers, not UI labels or reason
codes. The vocabulary and construction rules are closed:

1. A missing top-level member is its exact serialized identifier, for example
   `source_project_id`, `spatialReference`, or `algorithms`.
2. A missing member in a present object is a dot path of exact serialized
   identifiers, for example `processing_set_choice.membership_sha256`.
3. A missing member in a present array item is
   `<array-id>[<zero-based-index>].<member-id>`, for example
   `tools[1].sha256`. A missing whole array is only its top-level id; absent
   items are never guessed and therefore have no synthetic index.
4. A conditional member that is correctly inapplicable is absent and is not
   listed. A present member with the wrong primitive, tag, enum, hash, decimal,
   or array shape makes the record invalid; it is not converted to “missing.”
5. The list is de-duplicated and sorted in ascending UTF-8 byte order. It is
   empty if and only if `provenanceStatus` is `complete`. `unknown` lists every
   mandatory top-level member; `partial` lists exactly the unavailable members.

Missing fields are mandatory only for post-contract publications; legacy
absence is not rewritten as corruption. The pre-contract five-field
`ProductLineage` relation is a read-only legacy projection, not a second lineage
schema: `source_alignment_entity_id`, `processing_set_id`,
`gcp_optimization_entity_id`, `gcp_optimization_snapshot_sha256`, and
`image_mask_scope_sha256` expose only values actually frozen in the old product
record. If at least one is trustworthy the projection is `provenanceStatus:
partial`; if none is trustworthy it is `unknown`. It never manufactures a
tagged union, version/membership hash, `none` sentinel, current-project fact, or
`complete` status. Such rows list exact `missingFieldIds`, show **Needs
republish/recompute**, and cannot register. Builder never reads the current
alignment, processing set, GCP, masks, CRS, project manifest, or tool versions
to fill history. The implementation's legacy projection demonstrates the old
five-field source and incomplete member set
(`crates/himmelcad-sidecar/src/project_runtime.rs:1014-1097`); current
publications remain legacy unless PhotoLab republishes or recomputes them through
its WP-G1 work at
`docs/implementation-plans/2026-09-photolab-release-polish.md`.

The `reasonCode`/`reason_code` enumeration has one fixed meaning and base UI copy
per value. A UI may append a product label or diagnostic id after the sentence,
but may not replace it, imply recovery Builder cannot perform, or derive copy
from an unrecognized string.

| `ReasonCode`                 | Disposition                 | Exact meaning                                                                       | Required user-visible base copy                                                     |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `available`                  | `available`                 | Complete lineage and a validated, admitted package are ready.                       | **Ready to import.**                                                                |
| `needs_republish_recompute`  | `needs_republish_recompute` | Lineage is `partial`/`unknown`, or required publication-time facts are absent.      | **Republish or recompute this product in PhotoLab to capture complete provenance.** |
| `needs_preparation`          | `needs_preparation`         | Source product exists but lacks its required prepared canonical dataset.            | **Prepare this product in PhotoLab before importing.**                              |
| `no_package`                 | `needs_preparation`         | Lineage and prepared data can be complete, but the publication has `package: null`. | **No import package is available. Republish this product in PhotoLab.**             |
| `unsupported_format`         | `unsupported`               | The source format/product kind has no admitted canonical arrival mapping.           | **This product format is not supported by Builder.**                                |
| `invalid_package`            | `needs_republish_recompute` | A known package fails hash, inventory, path, binding, or ready-summary checks.      | **The import package is invalid. Republish or recompute this product in PhotoLab.** |
| `unsupported_package_schema` | `unsupported`               | Its manifest/ready major, type id, or required feature is unknown.                  | **This product package version is not supported by this version of Builder.**       |

Precedence remains deterministic but now produces only that enumeration:
unknown format/schema → `unsupported_format`/`unsupported_package_schema`;
invalid known package → `invalid_package`; incomplete lineage →
`needs_republish_recompute`; absent prepared binding → `needs_preparation`;
complete prepared publication with `package: null` → `no_package`; otherwise
`available`. No free-form reason code is legal.

For a complete publication, reopen, update, export, Properties, automation,
and WeltView read the component verbatim. A newer CRS database, renamed source
entity, changed GCP revision, later alignment, or missing source cannot change
the meaning or bytes of the registered product.

### Canonical decimal encoding

The package canonicalizer rejects floating-point JSON numbers
(`crates/himmelcad-core/src/canonical_json.rs:42-55`). Therefore every logical
`f64` that appears anywhere inside a package manifest—including
`FrozenCrsEndpointV1.horizontal.coordinateEpoch.decimalYear`, DEM numeric
NoData/height-jump values, and any admitted future lineage or manifest member—is
encoded as `Decimal64`, never as a JSON number.

`Decimal64` is ASCII matching `-?(0|[1-9][0-9]*)(\.[0-9]+)?`: no leading `+`,
exponent, leading integer zero, or trailing fractional zero is permitted;
negative zero is encoded as `"0"`. Starting from the authoritative finite
IEEE-754 binary64 value, the producer emits the shortest correctly rounded
decimal that parses with round-to-nearest, ties-to-even to the identical 64-bit
value; if a shortest implementation first emits exponent notation, it expands
that notation to the equivalent plain decimal and then removes only redundant
leading/trailing zeroes. NaN and infinities are invalid except that the DEM
source-NoData enum represents NaN by the tag `{kind: "nan"}` and no decimal
value. A consumer parses a `Decimal64`, verifies exact binary64 round-trip, and
rejects a noncanonical spelling even when its numeric value is equivalent.

This transfer encoding does not alter the model. In particular, the
`CoordinateEpoch.decimal_year: f64` owned by the transformation model
(`docs/TRANSFORMATIONS.md`, whose current contract makes the Rust types exact
implementation authority; `crates/himmelcad-core/src/photolab_crs.rs:31-44`)
remains the authoritative epoch. Publication projects those exact bits to
`decimalYear: Decimal64`; import may parse them for validation but preserves the
original lineage bytes and never rounds, normalizes, or writes the value back
into the source or destination model. Identical model bits therefore always
produce identical package bytes.

### Read-only source-package acquisition

Selecting a source grants an opaque broker handle, never a raw path. Listing a
`.hcad` uses a dedicated read-only package-catalog reader that takes the
exclusive project lock for one bounded page and then releases it. Registration
reacquires the same lock **before staging**. Neither path calls PhotoLab `open`,
creates a working session/copy, or updates clean-shutdown, modified, MRU, or
manifest state. If the lock is held, list/register returns `busy_source` before
staging with **Close PhotoLab or select a `.hcadx` archive.** While registering,
the reader pins the selected ready record, manifest, lineage, and all declared
artifact roots against maintenance/GC and holds the lock and pin until
destination staging contains independently verified copies. It then releases
the source lease before destination review/commit.

A selected `.hcadx` is an immutable archive input for the operation: Builder
holds the brokered file handle and its verified archive fingerprint for list and
registration, never opens it as a mutable project. A changed handle identity,
archive fingerprint, manifest, product version, or package hash returns
`stale_source` with no destination mutation. Shared live snapshot leases are a
possible later optimization; R1 neither requires nor emulates them.

Post-commit behavior belongs to the sibling entity owners. Pointcloud §1 and
its cross-spec reconciliation own `hcad.point-cloud@1` and prepared
Gaussian-splat arrivals from IF-D19/IF-D20/IF-D25.
Raster RA-D3/RA-D5/RA-D11 owns
`hcad.raster-image@1` and ElevationSurface Grid arrival semantics. Mesh &
Terrain MT-D12/MT-D17 owns `hcad.surface-3d@1` and closed-mesh
`hcad.object-3d@1` arrival behavior. Import owns only
source selection, validation, registration, atomic publication, immutable
lineage, changed-source behavior, and undo roots.

This operation is **Import**, not File D5 **Attach**, and not a P10/MT-D25
linked recipe. It copies one immutable published product into an ordinary
destination entity, editable under its owning domain. It creates no project-
reference entity, block-wide display override, source dependency edge, recipe
or reverse-index entry, re-sync action, or automatic stale/move response when
PhotoLab changes. Alignment, processing-set, mask, and GCP identities remain
immutable provenance only. This adopts File D5/§1.7 and MT-D25 rather than
re-dispositioning either class.

### Function-contract answers

**A1 — user outcome.** The user chooses **PhotoLab product dataset**, selects a
local PhotoLab project and one explicitly listed product, and sees its format,
lineage state, CRS, precomputed package size/count/hash, and disposition before
staging. A complete, admitted, owner-accepted product enters the existing
registration sequence: source/project preview, explicit CRS and placement
decisions where required, review, then Commit. Commit creates one ordinary
canonical point-cloud, Gaussian-splat, raster/elevation, or mesh/solid entity
with its prepared dataset and immutable provenance. Pointcloud's reciprocal
ownership row admits prepared splats after the common package/provenance
admission; per-point editing remains unsupported. Legacy partial/unknown products visibly require
republish/recompute; Cancel leaves the destination unchanged.

**A2 — reference grounding.** This is a Himmel:CAD family-integration
capability derived from the R1 gate and accepted canonical architecture; no new
third-party behavior claim is made. The existing RealWorks/RIB evidence already
cited by §4.2 remains interaction context, not evidence for the product-package
contract.

**A3 — siblings.** The lifecycle reuses `file.import`, the ADR 0025
registration island, UIP-D10/UIP-D11 jobs, IF-D14 source freezing, and IF-D15
heavy undo retention. File D5/§1.7 proves that whole-project Attach is a
different linked/read-only lifecycle; MT-D25 proves that a direct import with
no admitted reproducible mapping has no P10 recipe; RA-D11 exclusively supplies
the plan-only orthomosaic mapping. Post-commit owners are Pointcloud, Raster,
and Mesh & Terrain as stated above. Their reciprocal citations are recorded in
the 2026-09-02 reconciliation tables; implementation remains admission-gated.

**B1 — reachability.** Ribbon and chooser: present under the existing Import
entry. Entity context menu and viewport quick surface: absent because this
creates a destination entity from an external project, not an act on an
existing destination entity. Console and agent/Python: present from the same
generated command rows below. Shortcut: absent; File Import is already the
discoverable class entry. All paths dispatch the same canonical operation.

**B2 — open/close.** Picker Cancel exits without a job. Island X/Escape, explicit
Cancel, background continuation, Finishing, reload, and project-close semantics
are exactly §3.4/§4.2 B2; the specialization adds no hidden close path. Cancel
before publication removes staged copies and capabilities. A request during the
bounded journal-last publication waits for the terminal committed/failed result,
never rolls back a committed canonical entity.

**B3 — surface.** The existing floating registration island remains correct:
product selection is one card before the already spatial, multistep dual-view
review. No PhotoLab window or second registration wizard is embedded in Builder.

**C1 — numeric parity.** Product selection is an entity choice, not a numeric
gesture. Every placement/CRS parameter retains §4.2 C1 pick/type/paste parity.
Lineage ids, hashes, and frozen CRS are read-only exact values; they cannot be
edited to make an invalid product appear compatible.

**C2 — selection.** Destination selection is ignored. The source-product choice
freezes one exact source entity/version. Changing either project's selection
does not retarget a running registration. Registering several products creates
independent jobs and atomic commits; no product is silently bundled.

**C3 — freezability.** Publication freezes lineage and the package manifest;
Builder never reconstructs either. Registration additionally freezes the
broker handle, source fingerprint/generation, product id/version/content hash,
package hash, canonical admissions, placement choice, and destination expected
generation. A `.hcad` exclusive read lease pins every declared source root
until independently verified destination staging completes; `.hcadx` uses its
held immutable archive handle. Any changed token invalidates the plan. The
payoff is deterministic staging/replay without racing PhotoLab, GC, or mutable
current project truth.

**C4 — persistence and undo.** One accepted product is one journaled canonical
create transaction. Undo removes its entity/binding but keeps every imported
immutable object, prepared dataset, lineage object, and source snapshot root
reachable under IF-D15 until the undo/snapshot horizon releases it; redo restores
the exact same bytes. Registration does not mutate or journal into the source
PhotoLab project. Duplicate identity is exactly `(sourceProjectId, productId,
productVersionHash, packageSha256)`: registering it again returns
`already_registered` with existing destination ids and creates no entity or undo
step. A spatial copy uses the ordinary Duplicate/placement commands. A different
version/hash imports as a new entity by default.

An explicit replacement requires `import.update.plan` followed by
`import.update.execute`; the register request may carry an `updateTarget` only
as the hash-bound hand-off from that reviewed plan. It atomically creates a new
destination entity version with new immutable provenance. Undo restores the
old entity version, representation bindings, provenance bytes, and prepared
roots under IF-D15. `import.relocate_source` changes only a separate source-
location binding after source/project/product/package hash proof; it never
rewrites immutable provenance or geometry. Missing or changed source material
never changes an already committed entity.

**D1 — performance.** `list` reads only the publication index and small manifest
summary: default 50, maximum 200 rows per opaque cursor page; ≤1 s wall time and
≤16 MiB additional process RSS per page excluding returned strings and OS cache.
It performs zero artifact-directory walks and zero payload hashing. A page that
cannot meet the bound returns `source_unavailable`/`busy_source`, never silently
omits a row. These X6 values are tunable; pagination and complete disposition
are not.

Package payload verification, copying, preparation bridging, and registration
are long-running UIP-D10 jobs. First truthful progress is ≤250 ms; cancellation
is acknowledged ≤250 ms and reaches a safe streaming boundary ≤2 s outside the
≤5 s journal-last Finishing phase; working memory is ≤1 GiB per registration
excluding shared viewer cache. Disk preflight reserves destination staging,
final roots, and IF-D15 undo retention. Jobs estimated at ≥60 s checkpoint at
declared artifact boundaries; after restart they resume only after revalidating
the source handle/lease, package hash, checkpoint hashes, and destination
generation, otherwise they show **Restart required** and discard unreachable
partial staging. Completion means every declared artifact hash/length/media
type and admission binding verified and the one canonical link committed last.
The largest member is a multi-terabyte prepared dense cloud copied across
volumes; the least typical is a one-tile orthomosaic, which still validates the
complete package and commits once. Budgets are X6-tunable; bounded memory,
truthful progress, cancellation, and no partial canonical result are not.

**D2 — degradation.** The shared quality governor may reduce preview residency,
raster resolution, or splat/point density first. Hash validation, exact picks,
CRS/lineage truth, input response, and atomicity never degrade.

**E1 — visual quality.** Reuse §6's import cards, progress, error, dual-view,
focus, and theme criteria. The new product card uses normal design-system table
and code-value styles for kind, format, hashes, CRS, and disposition; no
PhotoLab-branded or default browser chrome is introduced.

**E2 — conflicts, failure, and consumers.** A busy `.hcad` fails before staging;
there is no source-write race while the exclusive read lease is held. Destination
commits serialize on the canonical journal. Same-product jobs may prepare
independently, but duplicate identity is checked again under the destination CAS
and the loser returns `already_registered`. Project replacement cancels the job.
Before commit, all consumers see nothing; render publication failure leaves the
canonical result committed and rebuildable under ADR 0019. Deferred or
unadmitted formats produce no entity.

The Import-owned arrival and provenance effects are exact below. Domain
interaction semantics are citations to their owner; a row whose owner has not
accepted the hand-off remains unavailable.

| Result                                             | Render / pick / snap / selection / edit                                                                                                                                                                                                                                                 | Tree and Properties                                                                                                             | Export, Plan, WeltView, automation                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hcad.point-cloud@1` + `potree@2`                  | Pointcloud's streamed renderer and exact point pick/snap apply; entity selection and Pointcloud edits are normal, with no source link or recipe. Unsupported provider/admission returns a typed error, never omission.                                                                  | Ordinary point-cloud row; package id/hash and `complete` provenance summary are read-only; generic mutation rejects provenance. | Native `.hcadx` retains entity, prepared binding, and provenance bytes. External export preserves provenance only through an admitted provider extension; otherwise `io.export.plan` reports `hcad.loss.photolab-product-provenance@1` before execute. Plan uses its ordinary point-cloud capture rule. WeltView streams the saved archive read-only. Paged automation exposes entity and provenance hashes. Reciprocal ownership is recorded in Pointcloud's PhotoLab-arrival row. |
| `hcad.gaussian-splat-cloud@1` + prepared hierarchy | Pointcloud's streamed renderer, entity/bounds pick and snap, P9 selection, and whole-entity placement apply. Per-point editing is a typed unsupported operation until stable point identity is admitted.                                                                                | Ordinary Pointcloud-owned row with display controls and the same read-only provenance rule.                                     | Native/loss/Plan/WeltView/paged-automation invariants match the point-cloud row; unsupported per-point consumers fail explicitly. Reciprocal ownership is recorded in Pointcloud's PhotoLab-arrival row.                                                                                                                                                                                                                                                                            |
| `hcad.elevation-surface@1` Grid                    | Raster-owned Grid render and authoritative terrain pick/snap apply from its exact `OrthoGridMapping`/`DepthSampling`; entity selection is normal; conversion/edit follows RA-D7, never raster-color authority (RA-D3/RA-D5).                                                            | Ordinary ElevationSurface row; exact resource/mapping/sampling and read-only provenance shown.                                  | Native/loss rule above; Plan and WeltView use the same Grid/prepared binding; automation returns mapping/sampling/resource hashes. RA-D11 and Raster's PhotoLab-arrival row record the reciprocal citation.                                                                                                                                                                                                                                                                         |
| georeferenced-XY `hcad.raster-image@1`             | RA-D11 only: plan-mode render, entity/footprint selection, no 3D world coordinate, measure, snap, terrain, depth, placement, or Z. Unsupported 3D consumers return the typed no-coordinate/unsupported result. `PlanGrid2D` preserves georeferencing; “plan-only” means no Z authority. | Ordinary raster row with **Georeferenced XY · No elevation** and read-only provenance.                                          | Native/loss rule above; Plan may place the raster by its `PlanGrid2D` XY mapping. WeltView either implements plan-mode admission or returns typed unsupported schema, never Z=0/omission. Automation returns XY mapping and `z: null`. Unavailable until RA-D11 admission and Raster citation land.                                                                                                                                                                                 |
| open `hcad.surface-3d@1`                           | MT-D12 prepared-mesh render and face/edge/vertex pick/snap; entity/part selection and Mesh edit semantics apply. It is open, has no solid-volume meaning, and has no MT-D25 recipe.                                                                                                     | Ordinary Surface3d row; topology state, prepared hashes, and read-only provenance shown.                                        | Native/loss rule above; mesh-capable external export declares provenance loss unless extended; Plan/section and WeltView use the same prepared binding; paged automation exposes parts/hashes. MT-D12 and Mesh's PhotoLab-arrival row record the reciprocal citation.                                                                                                                                                                                                               |
| closed `hcad.object-3d@1`                          | Mesh closed-manifold render, boundary pick/snap, selection, transform/edit semantics apply; it has solid-volume meaning but no MT-D25 recipe.                                                                                                                                           | Ordinary Object3d row; closed-manifold state, prepared hashes, and read-only provenance shown.                                  | Native/loss rule above; unsupported solid export refuses or reports both tessellation and provenance losses; Plan/section/WeltView/automation use the same committed entity. Mesh's PhotoLab-arrival row records the reciprocal citation.                                                                                                                                                                                                                                           |

Native Save As is always lossless for the component. Every external exporter
must either declare and test a namespaced extension that preserves the exact
component or include `hcad.loss.photolab-product-provenance@1` in the reviewed
loss plan; an exporter with no accepted-loss path refuses. No exporter silently
drops provenance.

**E3 — verification.** The named gates below prove the catalog, every format
disposition, lineage immutability, lifecycle, automation generation, and R1
cross-product outcome. Until they pass, the capability and R1 gate remain open.

### P11 command-table exposure

P11 applies here without paraphrase: **Product operations reach automation and
the console from one generated command table: every product capability
(Builder, PhotoLab, WeltView read-only queries) is a canonical command or query
with the validate/status/cancel lifecycle, generated from a single command table
that also drives the console vocabulary and the Python SDK; allowlisting raw
RPCs is never the exposure mechanism; approval, confirmation-grant, and
credential surfaces stay user-only (ADR 0024).**

The following entries live in the **one generated product command table**. The
table—not an automation-host allowlist, hand-written console switch, or private
sidecar RPC—generates the console vocabulary, protocol schemas, agent exposure,
and sync/async Python methods. `commandId` remains a per-invocation identity; it
is not a competing operation name.

| Generated command-table id           | Kind and result                                                                                                            | Generated surfaces                                                       | Validate / status / cancel                                                                                                         | ADR 0024 grants and commit boundary                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `io.import.product_dataset.list`     | `ProductDatasetListRequestV1` → `ProductDatasetListResultV1`; bounded and paged                                            | chooser; `import product-dataset list`; Python sync/async; agent         | schema validation; no long-operation status/cancel                                                                                 | opaque source-project/archive read grant; no raw path, write grant, or confirmation grant                                                                                           |
| `io.import.product_dataset.register` | `ProductDatasetRegisterRequestV1` → accepted operation/needs-input/terminal result; final `ProductDatasetRegisterResultV1` | ribbon flow; `import product-dataset register`; Python sync/async; agent | side-effect-free plan through `automation.commands.validate`; observe/cancel through generated `automation.commands.status/cancel` | same source grant/snapshot + destination write and expected generation; commit revalidates and consumes a short-lived single-use user confirmation grant bound to the complete plan |

The generated wire schemas are exact at contract level:

```text
ProductDatasetListRequestV1 {
  schema_version: 1,
  source_grant_id,
  cursor?,
  limit: 1..200 = 50
}

ProductDatasetListResultV1 {
  source_snapshot { source_kind: hcad | hcadx,
                    source_fingerprint, source_generation },
  products[{ product_id, product_version_hash, product_content_hash,
             publication_generation, kind, label, dataset_label,
             package_schema_id?, package_sha256?,
             artifact_count?, total_bytes?, normalized_format_id?,
             provenance_status: complete | partial | unknown,
             missing_field_ids[],
             disposition: available | needs_preparation |
                          needs_republish_recompute | unsupported,
             reason_code }],
  next_cursor?
}

ProductDatasetRegisterRequestV1 {
  schema_version: 1,
  command_id,
  source_grant_id,
  source_snapshot { source_fingerprint, source_generation },
  product { product_id, product_version_hash, product_content_hash,
            publication_generation, package_sha256 },
  destination { project_id, expected_generation },
  admission_choice { type_id, normalized_format_id, representation_slot,
                     raster_interpretation? },
  placement { kind: identity | registered,
              transform?, registration_audit_sha256? },
  update_target { update_plan_id, update_plan_sha256,
                  entity_id, expected_version_hash }?,
  confirmation_grant_id?
}

ProductDatasetRegisterResultV1 {
  disposition: completed | already_registered | needs_preparation |
               needs_republish_recompute | unsupported |
               stale_source | busy_source |
               cancelled_before_commit | failed_no_commit,
  operation_id?,
  destination_entity_ids[],
  destination_version_hashes[],
  provenance_component_sha256?,
  package_sha256?,
  reason_code?,
  error_id?
}
```

List cursors are opaque, expiry-bounded, and cryptographically bound to the
source grant, source fingerprint/generation, ordering key, and page size. A
cursor replay against a different or changed source returns `stale_source`.
Every publication record is ordered by `(publicationGeneration, productId,
productVersionHash)` and is eventually returned across pages; unsupported and
legacy rows are not filtered.

`admission_choice` must equal one choice returned by the selected list row and
validated package; it cannot override package semantics. For an orthomosaic it
is legal only with RA-D11 `PlanGrid2D`; for a DEM it includes the exact Grid
interpretation already declared in the admission object. `update_target` is
legal only when its plan was produced by `import.update.plan`; a bare entity id
is rejected. `needs_user_input` is the validation/operation state used before a
terminal result when placement or the user-issued confirmation is absent; it
is not a ninth successful disposition.

The confirmation grant is bound to `command_id`, canonical request/plan hash,
source grant and snapshot, product identity/package hash, admission/placement,
optional update plan/target, destination id/expected generation, actor/session,
and expiry. Commit revalidates every binding and consumes the grant once. A
replayed grant, changed request, expired session, source change, or destination
generation mismatch publishes nothing. Automation can request/observe the
operation but cannot issue the grant.

`command_id` is idempotent: replay with the identical canonical request hash
returns the existing operation or terminal result; reuse with different bytes
returns `command_replay_mismatch`. A crash resumes only hash-verified staging. If
the confirmation grant did not survive, the operation returns Needs input and
cannot commit. The normal operation log records request hash, actor, phases,
result, and failure/cancellation. Only `completed` creates a canonical document
journal transaction; an update uses the reviewed `import.update.execute`
transaction. `already_registered` and every failure disposition create no
document mutation or undo step. Raw paths, lease tokens, confirmation material,
private sidecar RPCs, and registration samples never enter results or journals.

Validation is side-effect free with respect to canonical state. An incomplete
interactive recipe returns `needs_user_input` and can create a visible Needs-input
job only when requested; automation never supplies viewport picks, approval
responses, confirmation grants, or credentials. A complete recipe may run
unattended after the user-owned grant. `registration.*`, the product-enumeration
RPC, and `io.import.execute` remain app-private implementation details.

This cite-and-revises IF-D12/IF-D17 for P11: `io.import` remains the public
namespace and there is still one semantic import path, but public product
capabilities are rows within that namespace rather than a single opaque import
verb. The common generated validate/status/cancel methods are lifecycle
facades, not extra product commands.

### Decision records

**IF-D19 — PhotoLab product registration uses canonical prepared formats and
freezes complete lineage.**
**Decision:** `potree@2` and validated `himmelcad-prepared-hierarchy@1` are
eligible ingress formats only after IF-D22 admission and the named entity owner
accepts the arrival; they are not independently Adopted product rows. DEM uses
the exact canonical Grid shape; orthomosaic requires RA-D11 `PlanGrid2D`;
Gaussian splat is eligible under Pointcloud's reciprocal ownership row but stays
implementation-blocked on the common package/provenance admission. `binaryPly`,
unprepared products, standalone `mvsDepth`, legacy/partial/unknown provenance,
and unverified `mesh@1` remain unavailable for the stated reasons. Complete
lineage is captured by PhotoLab at publication and copied byte-for-byte;
Builder never reconstructs missing history. Legacy `partial`/`unknown` is
visible as **Needs republish/recompute**.
**Derivation:** ROADMAP R1 gate 8; ADR 0012 lineage identity; ADR 0018 validated
canonical packages; ADR 0019 journal-last authority; ADR 0021/0025 lifecycle;
RA-D11; X1, X2, X3, X7, P5; program cite-and-revise rule.
**Rejected:** PhotoLab-format branching; treating a renderer decoder or
inventory label as semantic admission; zero-height orthomosaic; reading current
alignment/GCP/CRS to decorate old bytes; partial or viewer-only entities;
claiming `mesh@1` from a test proxy label.
**Tunable:** no.

**IF-D20 — Product-dataset import is generated once for UI, console, agent, and
Python.**
**Decision:** `ProductDatasetListRequest/ResultV1` and
`ProductDatasetRegisterRequest/ResultV1` above are the exact source for the two
`io.import.product_dataset.*` rows and every public surface. They bind the
opaque grant, source snapshot, product version/package hash, admission/
placement, optional reviewed update target, destination generation, terminal
dispositions, idempotent replay, and the ADR 0024 confirmation boundary. The
common generated `automation.commands.validate/status/cancel` lifecycle
applies. Private RPCs are not public command vocabulary.
**Derivation:** P11, X3, X7, ADR 0024, and IF-D12/IF-D17 by cite-and-revise.
**Rejected:** raw-RPC allowlisting; separately hand-maintained console commands;
SDK-only aliases; file paths in schemas; an unbound cursor or replayable grant;
automation-created approval or confirmation.
**Tunable:** no.

**IF-D21 — R1 gate 8 remains open until both consuming products prove the same
canonical result.**
**Decision:** the gate is not satisfied by PhotoLab publication or a PhotoLab
viewer. For every then-Available product row, Builder registers and reopens the
entity, performs canonical FP-D3 Save As to a complete `.hcadx`, and WeltView
opens that archive read-only through the canonical store/kernel path. The gate
compares entity ids, version/content hashes, prepared bindings, exact provenance
bytes, and the row's render/pick/snap/no-coordinate semantics. Direct access to
Builder's mutable `.hcad` and R3 network/range-publication choices are out of
scope. PhotoLab-side work is referenced only by the Phase G / WP-G1 path above.
Every renderable product kind in the PhotoLab release must reach Available;
missing owner/admission work cannot be used to remove it from the gate.
**Derivation:** ROADMAP R1 gate 8; X1; CURRENT-DIRECTION shared-core and WeltView
boundaries; ADR 0019 read-only snapshot consequence; File §E2 WeltView archive
consumer and FP-D3; PROJECT-FORMAT `.hcadx` archive/R3 boundary.
**Rejected:** marking R1 complete from one app; a Builder-only viewer adapter;
concurrent WeltView access to a mutable Builder project; choosing an R3 delivery
mode here.
**Tunable:** no.

**IF-D22 — One admitted, common product-import package precedes implementation.**
**Decision:** DATA-MODEL, PROJECT-FORMAT, and an accepted ADR must admit
`hcad.product-import-package-manifest@1` and
`hcad.photolab-product-provenance@1` with the exact schema shape, hash boundary,
safe-path rules, atomic ready record, compatibility, and migration ownership in
this amendment. Until admission, every otherwise eligible product row and both
commands remain non-implementation-ready.
**Derivation:** ADR 0018 canonical-package invariants; ADR 0019 immutable-before-
link publication; PROJECT-FORMAT's planned fragment precedent; X1; X7.
**Rejected:** a PhotoLab-private adapter; a directory walk as manifest;
unversioned component JSON; permissive future-version guessing; Builder-owned
in-place migration.
**Tunable:** package/list count and size ceilings may be calibrated under X6;
schema identity, complete inventory, hash/path checks, and atomicity are not.

**IF-D23 — Product registration is snapshot Import with identity-strict repeat,
not Attach or a linked recipe.**
**Decision:** one publication becomes one ordinary domain-owned destination
entity with no source dependency or MT-D25 recipe. Exact duplicate identity
returns `already_registered`; a different product version imports a new entity
unless an explicit `import.update.plan/execute` replacement creates a new
destination version. Undo and Relocate have the exact scopes in C4.
**Derivation:** File D5/§1.7 defines Attach as a linked whole-project reference;
P10 and MT-D25 restrict recipes to admitted reproducible mappings; X1/X5; IF-D4,
IF-D15, and IF-D16.
**Rejected:** source-linked product xref; automatic staleness/re-sync; silent
duplicate entity; in-place provenance mutation; treating source relocation as
product replacement.
**Tunable:** no.

**IF-D24 — R1 acquires a pinned read-only source and lists only precomputed
summaries.**
**Decision:** `.hcad` registration uses the existing exclusive lock through a
non-mutating package reader and pins declared roots until verified destination
staging; a busy source fails before staging with the stated action. `.hcadx`
uses a held immutable archive handle. Listing pages only precomputed publication
and package-summary records under the D1 budgets; it never walks or hashes the
payload and never filters unsupported/legacy rows.
**Derivation:** X1; X2; X6/P3; SYSTEM-001; File §1.2/E2 exclusive-lock behavior;
FUNCTION-CONTRACT D1; IF-D14.
**Rejected:** PhotoLab `open` as a reader; fingerprint-at-end without GC pin;
live shared snapshot leasing as an R1 dependency; unbounded list-time hashing;
omitting raw-mesh or legacy rows.
**Tunable:** page size, 1 s/16 MiB list budget, checkpoint threshold, and the
inherited long-job numeric budgets under X6; exclusive acquisition, pinning,
and complete listing are not.

**IF-D25 — Import specifies the arrival matrix; entity owners remain
authoritative.**
**Decision:** the E2 matrix enumerates every result and provenance consumer.
Native `.hcadx` preserves provenance byte-for-byte; external export either uses
an admitted preservation extension or reports
`hcad.loss.photolab-product-provenance@1` before execution. Raster semantics
cite RA-D3/RA-D5/RA-D11, Mesh semantics cite MT-D12/MT-D17/MT-D25, and
Pointcloud must accept its cloud/splat obligations before those rows become
Available. Unsupported consumers fail explicitly and never omit an entity.
**Derivation:** FUNCTION-CONTRACT E2; X1, X3, X7; ADR 0019; FP-D5 export-plan
honesty; RA-D3/RA-D5/RA-D11; MT-D12/MT-D17/MT-D25; program cite-and-revise rule.
**Rejected:** generic "where the kind permits" wording; decoder-defined
ownership; silent provenance loss; private Import definitions of Raster,
Pointcloud, or Mesh interaction behavior.
**Tunable:** no.

**IF-D26 — ProductLineageV1 has one exact serialized shape.**
**Decision:** `ProductLineageV1` uses the exact field identifiers, JSON
primitive types, tagged unions, and `ProductLineageIdentityV1 { id: string,
sha256: Sha256 }` shape specified above. `algorithms`, `configurations`, and
`tools` are always-present ordered identity arrays; repeated invocations remain
repeated entries. A `?` member is omitted, never `null`, and every unmarked
member is present.
**Derivation:** X1 immutable lineage, ADR 0012 identity, and the shared
canonical-JSON boundary require one byte-stable producer/consumer shape.
**Rejected:** map-shaped identities; unordered or de-duplicated identity arrays;
alternate version/hash member names; `null` as optional-field encoding.
**Tunable:** no.

**IF-D27 — Missing lineage fields use a closed member-id vocabulary.**
**Decision:** `missing_field_ids` and its `missingFieldIds` projection contain
only exact `ProductLineageV1` serialized member ids: top-level ids, dot paths
for members of present objects, and zero-based bracket paths for members of
present array items. Whole missing arrays use only their top-level id;
inapplicable conditionals are not missing; values with invalid types or shapes
are invalid rather than missing; the list is de-duplicated and UTF-8-byte-order
sorted.
**Derivation:** honest legacy state must be machine-actionable and identical in
storage, UI, and automation without guessing absent array elements.
**Rejected:** UI labels, reason codes, JSON Pointer aliases, synthetic array
indices, and treating malformed values as absent.
**Tunable:** no.

**IF-D28 — Product dispositions use one closed reason-code enumeration.**
**Decision:** the only reason codes are `available`,
`needs_republish_recompute`, `needs_preparation`, `no_package`,
`unsupported_format`, `invalid_package`, and
`unsupported_package_schema`, with the disposition, meaning, precedence, and
required base copy in the table above. UI may only append a product label or
diagnostic id; it may not replace the base sentence or derive copy from an
unknown string.
**Derivation:** deterministic listing and P11 parity require one stable code to
carry the same recovery meaning on every surface.
**Rejected:** free-form codes; copy-derived semantics; collapsing preparation,
republish/recompute, and absent-package recovery into one reason.
**Tunable:** no.

**IF-D29 — Publication identity and generation have one authority and
derivation.**
**Decision:** `publication_generation` is the checked next PhotoLab journal
command sequence and is identical in lineage, manifest, ready record,
publication record, and committed journal entry. `publication_id` and a
non-null package's `manifest_id` equal `"product-" +
sha256(canonical_json([source_project_id, product_entity_id,
product_entity_version_hash, publication_generation]))`. The ready record uses
`hcad.product-import-package-ready@1`; dataset ids are copied from admitted
prepared datasets; resource ids equal their SHA-256; and resource/artifact
roles use only the closed role enumerations above.
**Derivation:** ADR 0019 journal-last publication and X1 identity require one
collision-resistant, replay-detectable publication identity.
**Rejected:** UUIDs; independently allocated generations; manifest-schema ids
on ready records; importer-created dataset aliases; arbitrary ids or roles.
**Tunable:** no.

**IF-D30 — A DEM package requires every Raster sampling and validity fact.**
**Decision:** `product_kind: "dem"` requires `PhotoLabDemFactsV1` with
`elevationZ`, exact `RasterInterpolation`, exact `RasterConnectivity`, explicit
source NoData semantics, the mandatory validity resource, and a connectivity
resource for mask connectivity. The canonical Grid and prepared Raster root
bind the same facts and resources. Until all are frozen, the publication has
`package: null` and is not Available.
**Derivation:** Raster's Grid contract makes interpolation, connectivity,
NoData, and validity domain truth that Import may preserve but never infer.
**Rejected:** relaxing the DEM catalog row; default interpolation or
connectivity; treating alpha as admitted elevation validity; omitting required
validity/connectivity bytes.
**Tunable:** no.

**IF-D31 — Pointcloud is the authoritative owner of prepared Gaussian splats.**
**Decision:** the Pointcloud specification's PhotoLab-arrival registry row is
authoritative for `hcad.gaussian-splat-cloud@1`. A prepared splat becomes
eligible only after common data-model and package/provenance admission; no
owner choice remains. ADR 0030 Decision 10 revision 4 must follow that registry
row and remove revision 3's stale unresolved-owner wording.
**Derivation:** the reciprocal Pointcloud row already owns streamed rendering
and the complete post-commit consumer contract, while Import owns only arrival.
**Rejected:** an Import-owned splat entity, decoder-defined ownership, or
keeping the owner question open after reciprocal registry acceptance.
**Tunable:** no.

**IF-D32 — Merged-alignment products use the ordinary manifest and ordered
merge lineage.**
**Decision:** a published overlap or shared-control merged alignment uses the
same product-import manifest as every other eligible `potree@2` point cloud.
Its lineage identifies the merge entity with id, version hash, and
`lineage_sha256`, and `source_alignment_inputs` contains at least two `{id,
sha256}` identities in published input-alignment order. V1 does not represent a
mixed overlap/shared-control merge.
**Derivation:** a merge changes lineage inputs, not canonical point-cloud format
or package identity.
**Rejected:** a merge-specific manifest; unordered or id-only inputs; inferred
input versions; a mixed-kind V1 value.
**Tunable:** no.

**IF-D33 — Lineage remains resident when no import package exists.**
**Decision:** every post-contract publication writes the complete hash-bound
lineage envelope in `PhotoLabProductPublicationRecordV1`; if no package exists,
the required member is exactly `package: null`, with no fabricated manifest id
or zero hash. The legacy five-field relation is only a read-only projection and
can produce `partial` or `unknown`, never `complete` or reconstructed history.
**Derivation:** package readiness and provenance completeness are independent,
and X1 forbids loss or invention of publication-time truth.
**Rejected:** storing lineage only inside packages; omitting the publication
record; zero-value package summaries; upgrading legacy records from current
project state.
**Tunable:** no.

**IF-D34 — Every manifest-level f64 uses canonical Decimal64 strings.**
**Decision:** every logical `f64` in a package manifest or lineage payload,
including `FrozenCrsEndpointV1.horizontal.coordinateEpoch.decimalYear`, is a
canonical JSON `Decimal64` string: the finite binary64 value's shortest
round-tripping, ties-to-even decimal expanded without exponent notation and
normalized by the exact rule above. Packages preserve the original lineage
bytes and never round, normalize, or write the projected epoch back into the
authoritative transformation model.
**Derivation:** the canonical JSON layer rejects floating-point JSON numbers,
while lossless binary64 round-trip preserves the transformation model's exact
epoch authority.
**Rejected:** JSON floating-point numbers; fixed decimal-place rounding;
exponent spellings; package-owned epoch normalization or model rewrite.
**Tunable:** no.

### WP-G1a contract gaps — 2026-09-02

| Gap                                             | Disposition                                                                                                                    | Decision record |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 1 — `ProductLineageV1` serialized shape         | **Resolved:** exact ids, primitives, ordered `{id, sha256}` arrays, and omission encoding are closed.                          | IF-D26          |
| 2 — `missingFieldIds` vocabulary                | **Resolved:** exact top-level, nested-object, and array-item member paths are closed.                                          | IF-D27          |
| 3 — `reason_code` enumeration                   | **Resolved:** codes, precedence, meanings, and required base copy are closed.                                                  | IF-D28          |
| 4 — manifest/publication identity and authority | **Resolved:** manifest id, ready schema id, journal generation, dataset/resource ids, and roles are exact.                     | IF-D29          |
| 5 — DEM required facts                          | **Resolved without relaxing the row:** sampling, NoData, validity, and conditional connectivity resources are mandatory.       | IF-D30          |
| 6 — prepared Gaussian-splat ownership           | **Resolved:** Pointcloud's registry row is authoritative after common admission; ADR 0030 must follow it.                      | IF-D31          |
| 7 — merged-alignment datasets                   | **Resolved:** the ordinary manifest carries ordered, hash-bound merge inputs.                                                  | IF-D32          |
| 8 — lineage without a package                   | **Resolved:** the publication record retains lineage with `package: null`; legacy five-field data remains `partial`/`unknown`. | IF-D33          |
| 9 — floats and CRS epoch                        | **Resolved:** all manifest logical f64 values use canonical `Decimal64` strings and never rewrite the model epoch.             | IF-D34          |

### Current-implementation delta with verified code evidence

| Disposition      | Exact delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep**         | Builder's working Potree canonical admission (`apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:124-137`; `apps/builder/renderer/src/App.tsx:1398-1408`), ADR 0025 session/cancel/commit lifecycle, the Potree provider (`crates/himmelcad-render/src/providers/potree.rs:350-405,535-559`), the provider-neutral prepared hierarchy (`crates/himmelcad-render/src/providers/prepared.rs:59-111`), and mesh admission's hash/topology checks (`packages/@himmelcad/viewer/src/kernel/KernelPreparedMeshDatasetAdmission.ts:95-144`). |
| **Change**       | After all admission/owner prerequisites land, replace Builder's `potree@2`-only source/target preview and restore branches (`apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx:124-137,153-173`; `apps/builder/renderer/src/App.tsx:1395-1417`) with canonical-format dispatch for then-Available rows. Generalize source sampling beyond the first Potree dataset only where the owning format supplies exact picking; today it hard-matches `potree@2` (`crates/himmelcad-sidecar/src/import_registration_runtime.rs:367-373`).     |
| **Add**          | After IF-D22 admission, a shared product-import package reader/validator, complete prepared artifact inventory, format normalization, `hcad.photolab-product-provenance@1`, product chooser/disposition UI, sibling-owned post-commit projections, and generated command-table rows. Current enumeration exposes publication labels and incomplete lineage only (`crates/himmelcad-sidecar/src/project_runtime.rs:888-915,4505-4768`).                                                                                                            |
| **Do not claim** | `mesh@1` support: the only exact current hit is a test render proxy (`crates/himmelcad-render/src/mesh_picking.rs:2155-2163`). Dense `potreeV2` is conditional and otherwise `binaryPly` (`crates/himmelcad-sidecar/src/project_runtime.rs:4637-4649`). Current automation exposes generic lifecycle RPCs (`schemas/automation/himmelcad-automation-v1.schema.json:121-145`) through a hand allowlist (`packages/@himmelcad/automation-host/index.cjs:79-100`), not P11's generated product command table.                                        |

### Verification plan

- **G-IF-PD-1 `import.photolab-product-contract` (push):** sidecar/core fixtures
  enumerate sparse/dense Potree, DEM, orthomosaic, prepared/legacy mesh, depth,
  prepared/unprepared splat, and unknown future labels. They assert every row's
  exact available/deferred/blocked disposition, `potreeV2` normalization,
  `binaryPly` refusal, no `mesh@1`, RA-D11 `PlanGrid2D`/`z: null`, exact DEM
  Grid resource/mapping/sampling binding, complete safe-path rejection corpus,
  all object/artifact hashes/lengths/media types/counts, manifest/package hash,
  ready-record-last atomicity, unknown-field byte preservation, future-version/
  required-feature rejection, and no canonical mutation before reviewed commit.
- **G-IF-PD-2 `import.photolab-product-builder-e2e` (push, capabilities
  `browser-gpu`):** register one fixture of each Available kind through Builder's
  existing island; exercise point/type/paste placement, close/reopen, cancel in
  every phase, project replacement, render failure recovery, exact duplicate →
  `already_registered`, version-changed import-as-new, reviewed
  `import.update.plan/execute`, undo/redo, Relocate-without-provenance-change,
  tree/Properties, every E2 matrix cell, and destination reload. Deferred rows
  show their reason and produce no entity.
- **G-IF-PD-3 `import.photolab-product-lineage` (push):** mutate the live source
  alignment, GCP entity, CRS database, source path, and source project after
  commit. The destination must retain byte-identical alignment id/hash, GCP
  revision/snapshot, processing-set/version/membership, camera/mask hashes,
  algorithm/config/tool identities, frozen reference frame/transformation hash,
  source package hash, and registration audit across save/reopen, automation,
  export planning, undo, and redo. Legacy complete/partial/unknown fixtures prove
  missing-field display, **Needs republish/recompute**, and zero current-state
  reconstruction. Pre-commit mutation invalidates the plan.
- **G-IF-PD-4 `import.command-table-parity` (push/release):** generate protocol,
  console vocabulary, agent descriptors, and Python sync/async clients from one
  table; fail on generated drift, missing `io.import.product_dataset.*` rows,
  hand-added aliases, or raw-RPC exposure. Round-trip every exact request/result
  field and disposition; exercise cursor/source binding, command idempotence and
  replay mismatch, validate/status/cancel, needs-input, expected-generation and
  update-plan conflicts, grant scope/expiry/single use/revalidation, restart with
  an expired confirmation, and the impossibility of automation issuing approval.
- **G-IF-PD-5 `import.photolab-product-source-and-bounds` (push/release):** a
  busy `.hcad` fails before staging with the exact action; the dedicated reader
  produces no project/MRU/clean-shutdown/manifest mutation and a concurrent GC
  cannot collect pinned roots. Release occurs only after independently verified
  staging. `.hcadx` uses an immutable held handle and detects replacement. A
  100,000-record catalog pages every record, including raw mesh/legacy/unknown,
  at ≤200 rows, ≤1 s, and ≤16 MiB additional RSS per page with zero artifact
  opens/hashes. A multi-terabyte synthetic inventory proves ≤1 GiB worker RSS,
  truthful progress/cancel bounds, artifact-boundary restart, disk preflight,
  and one journal-last commit.
- **G-IF-PD-6 `import.photolab-product-export-consumers` (push/release):** one
  fixture per E2 row exercises render/pick/snap/selection/edit refusal or owner
  behavior, tree/Properties read-only provenance, generic-mutation rejection,
  Plan, paged automation, native `.hcadx` byte preservation, admitted external
  provenance extension, explicit lineage-loss acceptance/refusal, and typed
  unsupported sibling behavior. No entity may disappear from a consumer.
- **G-R1-8 `photolab-products-canonical-consumers` (release, capabilities
  `real-data` + `browser-gpu`):** from the release smoke project, register and
  reopen every Available product in Builder, verify immutable provenance in
  Properties/automation, perform canonical Save As to one complete `.hcadx`,
  then have WeltView open that archive read-only through the canonical
  store/kernel. Compare entity ids, version/content hashes, prepared bindings,
  provenance bytes, and each row's expected render/pick/snap/no-coordinate
  semantics. Mutable `.hcad` access, a skipped/relabeled row, or product-private
  state keeps R1 gate 8 open.
- **Manual visual (push/review):** dark/light and keyboard-only captures prove
  the product chooser, long hash/CRS values, deferred reasons, progress, focus,
  Escape ladder, and final Properties provenance meet §6 without clipping or
  unstyled controls.

For this documentation-only amendment, verify Markdown structure, links, exact
identifiers, and every cited line against the current tree. Runtime gates remain
implementation work; none is represented as passing today.

### Cross-spec cite-and-revise results

The 2026-09-02 reconciliation applied every repository-spec and registry request
below. The architect admission, PhotoLab implementation, and WeltView runtime
work remain explicitly outside this spec-only transaction; none creates an
additional semantic import act.

| Owning sibling spec                                                              | Applied disposition / remaining external gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect / `docs/DATA-MODEL.md`, `docs/PROJECT-FORMAT.md`, ADR 0030             | DATA-MODEL now points item 8 to proposed ADR 0030. Owner acceptance remains pending; implementation must use the accepted shape or wait, never invent a substitute.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PhotoLab WP-G1 at `docs/implementation-plans/2026-09-photolab-release-polish.md` | Publish the IF-D22 package atomically and the complete publication-time IF-D19 lineage fields: project/product identity and fingerprints/hashes/generation/kind/labels; alignment id/version; processing-set id/version/membership or explicit sentinel; camera/mask hashes; GCP id/version/snapshot or none; frozen spatial reference/reference frame/transformation or local marker; algorithm/config/tool identities; package hash; summary counts. Existing records must expose `partial`/`unknown` plus missing fields and a republish/recompute path, never backfill from current state. |
| `../../REGISTRY.md`                                                              | **Applied:** counts `import.photolab-product(s)` under the one `file.import` act, registers both `io.import.product_dataset.*` rows and P11, records their implementation gates, and publishes clean standing checks.                                                                                                                                                                                                                                                                                                                                                                          |
| `../agent/agent.md`                                                              | **Applied:** AG-D4/AG-D13 and the public-method matrix cite IF-D20 and include list/register authority, cursor, replay, status, cancel, and user-only confirmation without private RPCs or trust responses.                                                                                                                                                                                                                                                                                                                                                                                    |
| `../file-project/file-project.md`                                                | **Applied:** FP-D5/FP-D22 cite IF-D21/IF-D23–IF-D25 for Import-vs-Attach, Save As `.hcadx`, the non-mutating source reader, and provenance-preserve/loss-or-refuse export.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `../pointcloud/pointcloud.md`                                                    | **Applied:** cites IF-D19/IF-D20/IF-D25 for point-cloud and Gaussian-splat arrivals, accepts the E2 consumer contract, and adds no import alias. Per-point splat editing is explicitly unsupported pending stable identity.                                                                                                                                                                                                                                                                                                                                                                    |
| `../raster/raster.md`                                                            | **Applied:** RA-D11 and Raster's arrival row cite IF-D19/IF-D20/IF-D25, keep `PlanGrid2D` with `z: null`, reject the zero-height bridge, accept Grid/provenance consumers, and add no import command.                                                                                                                                                                                                                                                                                                                                                                                          |
| `../mesh-terrain/mesh-terrain.md`                                                | **Applied:** MT-D12/MT-D17/MT-D25 and Mesh's arrival row cite IF-D19/IF-D20/IF-D23/IF-D25, keep direct arrivals recipe-free, accept provenance consumers, and add no import command.                                                                                                                                                                                                                                                                                                                                                                                                           |
| WeltView owner                                                                   | Implement or explicitly reject each admitted entity/schema through the shared canonical store/kernel; G-R1-8 uses only the complete Builder Save As `.hcadx`, not a mutable project or R3 delivery mode. Preserve unknown optional package/provenance fields byte-for-byte where compatible and return typed unsupported schema otherwise.                                                                                                                                                                                                                                                     |

### Disposition of this amendment

| Required item                       | Disposition                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Register a PhotoLab product dataset | **Contract specified but implementation blocked:** IF-D19/IF-D22–D24 define publication, acquisition, review, cancel, package validation, repeat/update, and one journal-last commit.                                                                                          |
| Every renderable prepared format    | **Dispositioned without premature adoption:** exact eligible/deferred reason per row; `PlanGrid2D`, owner acceptance, and common package/provenance admission are hard gates; `mesh@1` remains rejected as unverified.                                                         |
| Immutable lineage                   | **Specified:** publication-time complete lineage, explicit legacy `partial`/`unknown`, exact missing-field UX, package hash, and zero reconstruction from current state.                                                                                                       |
| Canonical result ownership          | **Specified reciprocally by IF-D25 and sibling owner rows:** Pointcloud owns point clouds and prepared Gaussian splats; Raster owns raster/Grid semantics; Mesh owns prepared Surface3d/Object3d semantics. Canonical package/provenance admission still gates implementation. |
| P11 automation/console parity       | **Specified by IF-D20 and reconciled:** exact generated schemas, grants, cursors, replay, outcomes, and common validate/status/cancel lifecycle are cited by Agent, File/Project, UI Platform, and the Registry.                                                               |
| R1 gate 8                           | **Open:** IF-D21/G-R1-8 require Builder Save As to a complete `.hcadx` and WeltView canonical read-only parity; mutable-project/R3 modes do not count.                                                                                                                         |
| Owner questions                     | **None.** X1/X2/X3/X7, P5/P11, the accepted ADRs, and the roadmap decide the class.                                                                                                                                                                                            |

**Zero-owner-question dissolution.** The apparent provenance choice dissolves
under X1 plus ADR 0012/0019: unknown history is represented as unknown, never
invented. Package/versioning dissolves under ADR 0018 and the PROJECT-FORMAT
fragment precedent; implementation waits for the required admission. Arrival
semantics dissolve under X7 and the existing owners: RA-D11, Pointcloud's
ordinary cloud contract, and MT-D12/MT-D25. Import/Attach/recipe and repeat
behavior dissolve under File D5, P10/MT-D25, IF-D4/IF-D15/IF-D16, and X5.
Exclusive acquisition and listing budgets dissolve under X1, SYSTEM-001, and
X6/P3. Automation and WeltView dissolve under P11/X3 and FP-D3/IF-D21. No
axioms conflict, no product identity/scope/licensing choice is introduced, and
no reserved boundary survives; the escalation protocol therefore yields zero
owner questions.

### Disposition — PhotoLab amendment review 2026-09-02

All **11 findings are resolved in this specification; 0 are deferred**. The
feature remains deliberately non-implementation-ready until the external
admissions and owner-file requests above land. That dependency status is not a
license to reopen or improvise the resolved contracts.

| Finding id                                          | Disposition                                                                                                                                                                                                                                                                                                                            | Spec section / decision id                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1 — blocker, unreconstructible lineage              | **Resolved:** complete lineage is captured at publication; Builder copies exact bytes. Legacy publications are explicitly `partial`/`unknown`, list missing fields, require republish/recompute, and are never backfilled from current state.                                                                                          | “Publication-time lineage and honest legacy state”; IF-D19; G-IF-PD-3                      |
| 2 — blocker, no versioned package/provenance schema | **Resolved as an admission-gated contract:** exact manifest/component ids, fields, object graph/bindings, inventory, safe paths, hashes/counts, atomic ready record, compatibility, and migration ownership are specified; DATA-MODEL points to proposed ADR 0030 and implementation remains blocked pending its acceptance/admission. | “Pending package and provenance admission”; IF-D22; G-IF-PD-1                              |
| 3 — blocker, orthomosaic mapping contradiction      | **Resolved:** the row adopts Raster RA-D11 as authority and is **Needs canonical PlanGrid2D admission**; `z: 0` `OrthoGrid` is explicitly rejected. DEM Grid mapping/resource/sampling/prepared binding is exact.                                                                                                                      | format table; A3; IF-D19/IF-D25; G-IF-PD-1                                                 |
| 4 — blocker, registry/owner obligations absent      | **Resolved reciprocally:** Registry, Agent, File, Pointcloud, Raster, and Mesh citations are landed; DATA-MODEL points to proposed ADR 0030; PhotoLab/WeltView remain implementation consumers. Prepared splat ownership is explicitly Pointcloud's.                                                                                   | amendment “Implementation readiness”; “Cross-spec cite-and-revise requests”; IF-D22/IF-D25 |
| 5 — major, Import vs Attach vs recipe               | **Resolved:** one-product snapshot is Import, not File D5 Attach and not P10/MT-D25 recipe; editability and absence of link/re-sync/stale/DAG behavior are explicit.                                                                                                                                                                   | boundary before function answers; A3; IF-D23                                               |
| 6 — major, consistent source snapshot               | **Resolved:** dedicated non-mutating `.hcad` reader takes the exclusive lock and pins roots through verified staging; busy source fails before staging; `.hcadx` uses an immutable held handle.                                                                                                                                        | “Read-only source-package acquisition”; C3/E2; IF-D24; G-IF-PD-5                           |
| 7 — major, bounded complete listing                 | **Resolved:** list uses precomputed summary fields only, pages every record including unsupported/legacy, performs no payload walk/hash, and has explicit ≤200-row/≤1 s/≤16 MiB budgets.                                                                                                                                               | chooser contract; D1; IF-D24; G-IF-PD-5                                                    |
| 8 — major, exact P11 schemas                        | **Resolved:** exact request/result fields, grants, cursors, replay/idempotence, expected generations, update target, terminal outcomes, journal split, and trust boundary are specified.                                                                                                                                               | “P11 command-table exposure”; IF-D20; G-IF-PD-4                                            |
| 9 — major, passive consumers/provenance export      | **Resolved reciprocally:** the E2 matrix covers render, pick, snap, selection/edit, tree, Properties, native/external export, Plan, WeltView, and automation; provenance is immutable/read-only and silent loss/omission is forbidden. Pointcloud accepts prepared-splat ownership with per-point editing explicitly unsupported.      | E2 matrix; IF-D25; Pointcloud PhotoLab-arrival row; G-IF-PD-6                              |
| 10 — major, repeated registration/update            | **Resolved:** exact duplicate tuple returns `already_registered`; new version imports as new by default; reviewed update, undo roots, spatial Duplicate, and locator-only Relocate are explicit.                                                                                                                                       | C4; request/result schemas; IF-D23; G-IF-PD-2                                              |
| 11 — major, exact WeltView artifact/parity          | **Resolved:** Builder Save As produces the complete `.hcadx` WeltView opens read-only; parity fields and semantics are enumerated, mutable `.hcad` and R3 modes excluded.                                                                                                                                                              | IF-D21; G-R1-8                                                                             |
