# G1b — Builder PhotoLab product import evidence

Date: 2026-09-09  
Owner: `import-formats`  
Result: implementation and non-visual gates pass; rendered UI capture remains unverified because no browser session was available

## Delivered path

Builder now exposes **Import… → PhotoLab product dataset**. The 640 px chooser accepts a
PhotoLab project or one package directory, reads at most 200 publication rows, and shows product
kind, label, producer, object/artifact counts, declared bytes, and a Ready/Not ready badge with the
IF-D28 recovery sentence. A package becomes selectable only when the V1 manifest and ready schemas
match, the ready record declares complete provenance with no missing fields, and the raw manifest
SHA-256 and package SHA-256 agree. The canonical I/O reader repeats the full admission check,
including every declared artifact hash and length, before commit.

Import runs as a registered cancellable job with the visible S-05 phases **Verify manifest / SHA-256
→ Verify ready record → Stage / copy → Register dataset → Create entity**. Commit copies every
declared package artifact into the destination project's content-addressed object store. A repeated
package SHA-256 returns the existing package-derived entity without changing the document generation;
the chooser reports `already imported as …`. The ordinary import journal owns undo/redo: undo removes
the entity while immutable CAS objects remain eligible for the normal S-07 retention/GC policy.

`potree@2` products rehydrate through Builder's existing V-02 Potree stream and D-02 point-cloud
display state. `himmelcad-prepared-hierarchy@1` now rehydrates through the shared prepared-hierarchy
session API; the DEM tile decoder therefore receives its published `validityReference` and numeric
NoData policy and does not turn invalid cells into elevation samples. Selected imported products show
a monospace **Lineage** group with source project, processing-set choice, mask scope, tool IDs,
package/component hashes, and the published DEM validity/NoData facts.

The generated command table contains `io.import.product_dataset.list` and
`io.import.product_dataset.register`, both with `owner: import-formats`, console and automation
surfaces, exact P11 request/result model names, and Builder-only product scope. The same regeneration
updated the automation host and Python sync/async SDK surface. The gallery has serial states for the
chooser with a refusal row, importing progress, and Lineage properties.

## Specification finding: Attach request conflicts with IF-D23

The work-package prose requests **Import vs Attach** and changed-on-disk detection. IF-D23 and ADR
0030 require the opposite for this profile: registration is a snapshot import, copies the exact
hash-addressed package bytes into the destination, has no continuing source dependency, and has no
staleness/re-sync lifecycle. Implementing Attach would diverge from the named authoritative contract.
This implementation therefore exposes only Import and does not create external references. The
legacy `externalObjects` inventory field remains readable for older projects, but new registrations
leave it empty. Consequently “Attach vs Import both journaled” and post-attach changed-source detection
are **not applicable under the accepted profile**, not silently approximated.

## Fixtures and observed facts

The source fixture tree was read in place and was never copied or modified. The tamper test copied
only the sparse package into a temporary `.build/g1b/tampered-sparse-*` directory (under 2 MiB),
changed its manifest, observed `invalid_package`, and removed the temporary package.

| Product | Format | Objects | Artifacts | Declared bytes | Package SHA-256 | Builder result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Dense point cloud | `potree@2` | 6 | 10 | 1,239,132,945 | `dc6cf2f9e04648d4af75ed9e4f89a701c626a0246a45c8bc3b1681c95f559ef2` | Ready; point-cloud entity; D-02 defaults; V-02 stream |
| Sparse point cloud | `potree@2` | 6 | 10 | 480,204 | `6dce58464a1931fdbb7489c2ba0ca58e8de14d69df5cff45f8302183f8609298` | Ready; point-cloud entity; D-02 defaults; V-02 stream |
| DEM | `himmelcad-prepared-hierarchy@1` | 7 | 71 | 22,906,487 | `889e2ae68b4b9e35215bf5c050d7eaeb24b78fc682db0927e04601f5a731560a` | Ready; elevation-surface Grid; native hierarchy and validity bitset |

The bounded catalog/tamper tests completed in 85 ms and 51 ms respectively. The real sparse
registration/idempotency/CAS test completed in 0.29 s after compilation. At the final check this
machine had 31 GiB RAM, 27 GiB available, 971 MiB swap in use, and load averages 6.48 / 7.71 / 6.47;
other compilation lanes were active. Dense copy time, first rendered frame, and peak RSS were not
measured because the required UI browser lane was unavailable. No bounded-time or peak-RSS claim is
made for that fixture.

## PhotoLab note

For PhotoLab producers, Builder shows sparse and dense publications as point-cloud rows with the
published product/dataset labels, producer version, counts, package size, and complete lineage; it
shows the DEM as an elevation-surface/Grid row and exposes its published validity-bitset and NoData
policy in Lineage while the shared renderer treats invalid cells as transparent. Unprepared depth-map
publications stay visible in the chooser as **Not ready** with PhotoLab's generated recovery reason.

## Verification

| Gate | Result |
| --- | --- |
| `cargo test -p himmelcad-io product_import -- --nocapture` | **PASS**, 4/4, first run |
| `pnpm --filter @himmelcad/app test` | **PASS**, 77/77, second/final run; rerun followed SDK convenience-method generation and generated-table freshness is included |
| `pnpm --filter @himmelcad/builder test` | **PASS**, 25/25, third/final run; first run had path-relative skips, second exposed the catalog/project-root ambiguity, both corrected |
| `pnpm --filter @himmelcad/builder typecheck` | **PASS**, second run |
| `pnpm --filter @himmelcad/photolab typecheck` | **PASS**, first run, English UI check included |
| `pnpm --filter @himmelcad/photolab test` | **PASS**, 86 renderer + 8 Electron + contract checks, first run |
| `pnpm --filter @himmelcad/theme lint:tokens` | **PASS**, first run |
| `pnpm registry:lint` | **PASS**, all seven checks, first run |
| `cargo check -p himmelcad-sidecar --tests --bins` | **PASS**, second run; first found and drove correction of the focused test's inventory field |
| focused sparse registration/idempotency/CAS sidecar test | **PASS**, 1/1; 327 filtered |
| generated command table and Python SDK regeneration | **PASS**; `@himmelcad/app` freshness test green |
| `PYTHONPATH=sdk/python/src python3.12 -m unittest discover -s sdk/python/tests -p 'test_*.py'` | **PASS**, 14/14 including generated-SDK freshness |
| `git diff --check` | **PASS** |

The in-app Browser reported that no browser was available. Therefore the required screenshots of the
dense cloud, sparse cloud, DEM transparency, chooser/importing states, and Lineage panel were not
captured, and the three packages were not driven through the literal UI in this run. Code-level
catalog coverage includes all three real fixtures; native registration/idempotency/CAS coverage uses
the real sparse fixture; the existing I/O suite covers manifest/ready/refusal rules. Visual/GPU
acceptance, dense copy timing/peak RSS, and literal UI undo/redo remain open verification items.
