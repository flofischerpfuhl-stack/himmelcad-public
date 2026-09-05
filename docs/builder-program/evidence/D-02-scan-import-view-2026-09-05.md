# D-02 — scan import and view subset — 2026-09-05

Status: **IMPLEMENTED; functional import/cancel/reopen evidence passes. The live
GPU frame-latency gate remains BLOCKED because Builder created no renderer CDP
target. No p95 is claimed.**

## Outcome

D-02 connects `.las`, `.laz`, and `.e57` file-picker and drag/drop arrival to
the S-05 job registry, reviewed inline placement, atomic canonical publication,
S-07 durability, residency bootstrap, the point-cloud tree/Properties surfaces,
and first presented frame. The visible job phases are `Reading header`,
`Preparing hierarchy`, `Registering dataset`, `Registering journal head`, and
`First frame`. Determinate Jobs-island rows show the numeric percentage and a
working Cancel action.

Import preparation is capped at two concurrent providers. Cancellation is
registered before provider work begins. Provider hashing, E57's two bounded
passes, Potree conversion, prepared-artifact hashing, resource verification,
preview, and canonical staging all observe the same generation-scoped token.
Waiting sessions are removed synchronously. Preview and commit workers receive
the request and own cleanup. The canonical store removes incomplete staging up
to its durable ready-marker boundary; after that boundary the operation is an
atomic recoverable publication and the UI says cancellation is deferred rather
than reporting a false terminal result.

The arrival review is non-modal. It shows the source declaration and accepted
offset (`CRS: … · offset … · source units …`) and keeps unknown CRS/unit values
explicitly `Not declared`. `Change…` revokes the current stage and returns to
the registration methods. Source-coordinate placement is not committed until
the user accepts that review.

The residency contract now carries exact point count, declared source CRS and
units, accepted placement offset, and the canonical point-cloud display
resource. Builder projects the count as a muted monospaced tree suffix such as
`103.7 M`. The Properties panel exposes a 1–8 px slider, RGB/intensity/
classification/elevation modes, LAS class names/codes, and P9 mixed checkboxes.
`pointcloud.display.set` writes one validated immutable style object and one
exact-version canonical transaction for the selected clouds. The edit survives
flush, close, and reopen.

## Source truth and prepared data

The LAS/LAZ provider reads the real header before conversion. It streams a full
SHA-256 and byte count before PotreeConverter, re-streams both afterward, and
fails closed if the raw file changed. Canonical attributes retain the canonical
host path, SHA-256, byte length, header point count, declared CRS, and declared
units. WKT/GeoTIFF declarations are retained; absent declarations remain absent.

E57 retains the original `.e57` identity rather than the temporary posed LAZ.
Its coordinate metadata, scan GUID/name/pose, record counts, images, and the
standard metre coordinate unit are retained. The temporary LAZ is bounded
staging only. Prepared Potree and E57 image artifacts are hash-verified and
published to the canonical content-addressed object store. The raw source is
never copied into or rewritten by that store.

## Real fixture evidence

| Source | Identity | Result |
| --- | --- | --- |
| `libs/CloudCompare-master/plugins/core/Standard/qCompass/sample data/example_data.laz` | 3,403,330 bytes; 268,035 points; SHA-256 `ec0a8547c840d754203263be459becd39f00f1d6e3a892e659bf90a760f00969` | PASS through probe, E57/LAS registry selection, Potree conversion, reviewed point-pair placement, commit, stored durable head, close/open, identical residency/display, and bounded project-cloud sampling. |
| Generated ASTM E57 fixture | 2,048 bytes; four non-collinear Cartesian points; coordinate metadata `LOCAL_CS["D-02 generated fixture"]`; SHA-256 `b13983050df86da4ca098a1009000dd71ac7dd0383d80e58df20e41e81d0d73e` | PASS through the same sidecar path as `e57@1.0`, including posed-LAZ staging, Potree conversion, placement, commit, durability, close/open, and identical residency/display. It was generated with the pinned `e57` 0.11.13 writer because the repository contains no physical `.e57` file. |
| `libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las` | 3,111,413,830 bytes; 103,713,735 LAS points; SHA-256 `40ab61b68759d936553c5050f9be3ad84793e349828dfd5504472c0caec859f7` | PASS through full Potree conversion, source verification, canonical commit, stored durable head, close/open, identical residency/display, and cleanup of the approximately 3.0 GiB transient stage/project. The prepared point count matches V-02's independent fixture evidence. |

The smoke harness is `scripts/test-pointcloud-registration-import.mjs`. It uses
the renderer's exact JSON-RPC methods, creates a disposable canonical project,
asserts point-cloud metadata and accepted placement, flushes, closes, reopens,
asserts identical residency, then removes the project. UI reachability is
covered separately by the generated command registry, app tests, Builder
typecheck, and gallery. A literal Electron file-dialog click could not be
automated because the renderer target blocker below occurs before a page exists.

## Extreme-member cancellation measurement

Ten cold sidecar processes staged the 103,713,735-point LAS. Each cancellation
was issued on the provider's `reading source header` progress event, while the
full raw-source hash was active. All ten returned `cancellationRequested: true`,
rejected the stage as cancelled, exposed zero residency entries, and left no
process-owned registration scratch.

| Metric | Min | Max / conservative p95 |
| --- | ---: | ---: |
| cancel RPC round trip | 0.52 ms | 3.44 ms |
| provider stop plus scratch cleanup | 59.59 ms | 85.84 ms |

This passes the 250 ms cancellation bound at the expensive pre-conversion
boundary. Unit tests additionally cover cancellation before a session exists,
while waiting for placement, during commit, and in canonical object staging.

Machine state during the measurements:

- Intel Core i7-7820HQ, 4 cores / 8 threads, up to 3.9 GHz;
- NVIDIA Quadro M2200, 4,096 MiB, driver 580.173.02 (V-02 Class W);
- 31 GiB RAM, 16–18 GiB reported available around the cancellation runs;
- 2 GiB swap was effectively full;
- NVMe workspace filesystem started with 29 GiB free and reached 19 GiB free
  during overlapping large conversion/publication;
- a separately owned PhotoLab DeDoDe worker was already active and was observed
  near 7.4 GiB RSS and 352% CPU. It was not stopped or modified.

## View/HUD and V-02 integration

D-02 did not edit V-02's selector, streaming, scheduler, residency, or render
policy source. It consumes the additive `prepared_point_metadata` descriptor
field at non-point providers with `None`, passes Potree admissions through the
existing viewer API, and maps V-02's `budget:points`, `budget:bytes`,
`decode:backlog`, and `upload:backlog` reason codes into the S-08 HUD. Completion
waits for `waitForNextPresentedFrame()` after committed residency is loaded.

The timed V-01 run was launched with 180 frames and the already prepared
matching 103,713,735-point dataset while the full D-02 import was active. It
wrote `.build/perf/viewer-baseline-2026-09-05-d02-import-load.{json,md}` but was
BLOCKED: Electron exposed CDP on port 9223 yet attached no renderer target within
120 seconds. Therefore presented-frame p95, the `<= 2x target` comparison, and a
live HUD observation are unavailable. This reproduces the same class of Builder
startup blocker recorded by V-02; no latency value is inferred from it.

One V-02 API limitation remains visible: the current kernel point-size setter is
global. D-02 persists an exact per-cloud point size and applies the selected
cloud's value, but simultaneous clouds with different persisted sizes cannot be
rendered independently until the renderer exposes per-entity point size. Color
mode and classification alpha are already per-entity. D-02 did not violate the
render-lane ownership restriction to add that API.

## Command and visual surfaces

The authoritative P11 act is `file.import`, so D-02 uses that ID rather than
introducing `import.open`. It is available from the File ribbon, console, and
automation; an omitted path opens the native picker and an explicit bounded path
list goes directly to registered jobs. `pointcloud.display.set` is scoped to
PointCloud selection and is available from the entity context menu, console,
and automation. Cancellation reuses S-05 `jobs.cancel` and the existing
`registration.session.cancel` host contract instead of creating a divergent
second command.

The `Import surfaces` gallery section covers all requested phases, visible
percentages and Cancel controls, the inline placement row, the complete point-
cloud editor, and a real P9 mixed class state. Light and dark captures were run
serially and visually inspected at:

- `packages/@himmelcad/ui/gallery/shots/light/import-surfaces.png`
- `packages/@himmelcad/ui/gallery/shots/dark/import-surfaces.png`

## Shared-substrate change map

`himmelcad-io` and the sidecar are shared with PhotoLab. All changes are
additive; no PhotoLab provider or route was removed.

- `himmelcad-io::las_import`: `LasCanonicalProvider::import`,
  `import_las_file_with_progress_and_cancel`, `inspect_las_header`,
  `streaming_file_hash`, and `canonical_point_cloud_admission`.
- `himmelcad-io::e57_import`: `E57CanonicalProvider::import`,
  `transcode_e57_to_laz`, and `canonicalize_e57_package_with_source_truth`.
- `himmelcad-sidecar::import_registration_runtime`:
  `begin_preparation`, `begin_with_cancellation`, `take_ready`,
  `cancel_with_outcome`, `finish_preparation`, and `finish_commit`.
- `himmelcad-sidecar::canonical_project_store`:
  `publish_import_package_with_progress_and_cancel` and cancellable bounded
  artifact staging.
- `himmelcad-sidecar::canonical_app_runtime`:
  `publish_staged_import_with_progress_and_cancel`, `residency_bootstrap`,
  `point_cloud_metadata`, and `set_point_cloud_display`.
- sidecar host: `RegistrationProviderContext`, registration stage/commit/cancel
  RPC handlers, point-cloud display RPC, and import progress mapping.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @himmelcad/app test` | PASS — 44 tests. |
| `pnpm --filter @himmelcad/builder typecheck` | PASS. |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS; English UI check passed. |
| `pnpm --filter @himmelcad/ui test` | PASS — 37 tests, including bounded display/P9 and visible job-percentage coverage. |
| `cargo test -p himmelcad-core point_cloud_display` in `target/builder` | PASS — 1 test. |
| `cargo test -p himmelcad-io las_import::tests` in `target/builder` | PASS — 6 tests. |
| `cargo test -p himmelcad-io e57_import::tests` in `target/builder` | PASS — 9 tests. |
| `cargo test -p himmelcad-sidecar import` in `target/builder` | PASS — 15 library tests and 1 main-sidecar test. The first release-filter attempt exposed two stale test-fixture expectations; both were corrected and the final filter is green. |
| small LAZ, generated E57, and full 103.7M LAS smoke/reopen | PASS for all three. |
| ten-run 103.7M cancellation probe | PASS; 3.44 ms max request acknowledgement, 85.84 ms max stop/cleanup. |
| command-table and Python SDK generator checks | PASS/current. |
| `git diff --check` | PASS. |
| 180-frame V-01 p95 under concurrent import | BLOCKED before frame 1: no Builder renderer CDP target; no p95 claimed. |

## Architect acceptance (G17, 2026-09-06)

`gallery/shots/dark/import-surfaces.png`: jobs island rows with the four import phases and cancel, placement row "CRS: EPSG:25832 · offset 0 0 0 · source units m" with the secondary Change… button, cloud Properties with point-size Slider, color-mode Select and P9 tri-state class checkboxes — matches the brief. Accepted. Open: the live V-01 p95 gate (Electron CDP target did not appear in the run's contended environment) is covered by the architect's baseline run; per-entity point size awaits a renderer API (queued under V-05).
