# PL-I3 PhotoLab generated-console evidence

Date: 2026-09-19  
Repository base: `b2752d11545a6d92fd1a6fad7f820f5ab12bf73a` plus the uncommitted PL-I3 changes described here  
Machine: Linux 6.8.0-139-generic x86_64  
Runtime: Node 22.18.0, pnpm 9.12.0

## Outcome

WP-G2's remaining console-adapter gap is closed.

- The shared command-table generator now emits request/result schema identity,
  console argument help and aliases, execution kind (`query`, `transaction`, or
  `job`), and the owning cancellation route. The generated TypeScript and
  automation-host tables carry the same metadata.
- PhotoLab filters that table with `products: photolab` and
  `surfaces.console`. Its help output is one line per generated row, in table
  order. There is no PhotoLab-private command-name list.
- The resulting surface has 100 canonical rows: 72 `photolab.*` rows and 28
  shared rows. Nineteen are jobs and 22 declare a cancellation route.
- The five historical shorthand commands are generated aliases; the sixth
  historical command, `project.save`, is already a shared canonical row. Their
  existing renderer actions are unchanged. Canonical sidecar commands use the
  generated RPC method and JSON payload, and job results print the generated
  cancel route.
- The adapter test compares the exposed row IDs and help-line count with the
  generated PhotoLab table and independently compares the full accepted
  vocabulary with generated IDs plus aliases. A missing PhotoLab row or a
  private extra command therefore fails the test.

No dependency, project-format, migration, persistence, or undo/redo change was
introduced. The one launcher correction changes the private-display target
from the hard-coded `target/builder` to `target/${app}`, so a PhotoLab proof
really uses the required `target/photolab` lane.

## Help snapshot: before and after

Before PL-I3, the fallback help text named these six accepted commands from a
hand-written `if`/`else` dispatcher:

```text
alignment.resolve
alignment.run
alignment.profile qualityHybrid|maximumRobustness|fast
product.run depth|dense|dem|ortho|mesh|splat
batch.run
project.save
```

After PL-I3, `help` contains exactly 100 generated table rows. Each line has
the generated canonical ID, typed argument help, label, execution kind,
optional cancel route, and optional generated alias. The six pre-existing
commands map as follows:

| Before | Generated row after PL-I3 | Mapping |
| --- | --- | --- |
| `alignment.resolve` | `photolab.alignment.resolve` | generated alias → existing `resolveAlignment` action |
| `alignment.run` | `photolab.alignment.start` | generated alias → existing `startAlignment` action |
| `alignment.profile …` | `photolab.alignment.settings.update` | generated alias → existing `setAlignmentProfile` action and exact enum help |
| `product.run …` | `photolab.products.start` | generated alias → existing `startProduct` action and exact enum help |
| `batch.run` | `photolab.batch.start` | generated alias → existing `openBatch` action |
| `project.save` | `project.save` | existing shared row → existing `saveProject` action |

Normalized by accepted command name, the before set is a subset of the after
set: removed `[]`, changed `[]`, added 99 generated names. Normalized by command
capability, the same six capabilities remain and 94 previously missing table
rows are added to help. The exact-row and exact-vocabulary tests enforce both
statements. The visible after snapshot is
`.build/pl-i3/01-help.png` (SHA-256
`dc6fd4ba36d7d104b07fd4f111c8148008fb721cfcc77d94ec8ef4e406a9b63d`).

## Visible UI proof

The proof ran only through `scripts/ui-test-display.sh photolab` on private
display `:91`; `DISPLAY=:0` was neither inherited nor contacted. Process proof
records the real sidecar as:

```text
/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab/debug/himmelcad-sidecar
```

The selected `vulkan-webgl2` attempt was accepted as hardware WebGL2. Chromium
reported ANGLE/Vulkan on the NVIDIA Quadro M2200, driver 580.173.2.0. The proof
directory is `.build/ui-test-display/20260919T184000Z-404539/`.

Eight locally generated 1280×720 PNGs under `.build/pl-i3/synthetic/` seeded a
tiny untitled project. No repository dataset was copied. Image inspect/commit
was setup only; the commands under test were entered into the visible PhotoLab
console.

| Screenshot | Visible action and result | SHA-256 |
| --- | --- | --- |
| `.build/pl-i3/01-help.png` | `help`; generated table rows are visible | `dc6fd4ba36d7d104b07fd4f111c8148008fb721cfcc77d94ec8ef4e406a9b63d` |
| `.build/pl-i3/02-query-jobs-list.png` | `photolab.jobs.list {}` → `[]` | `371437b917743cf7b686730cb209f3dbe5d3ec1879f07cbc694ca473ad563762` |
| `.build/pl-i3/03-job-start.png` | `photolab.images.quality.start {"operationId":"pl-i3-final-cancelled-4","cameraEntityIds":[]}` → queued job plus `Cancel: photolab.jobs.cancel …` | `57af8f331dc2b038a696c42f4b821ced8f1a5f64d714f6f4d680020d6765d2ed` |
| `.build/pl-i3/04-job-cancel.png` | `photolab.jobs.cancel {"jobId":"pl-i3-final-cancelled-4"}` → `firstRequest: true`, `cancelRequested` after 2/8 images, then `Analyze image quality cancelled` | `ab3fff60107a93ccc891b3e544788cf29bfb95d0d33c279d8492c6ee54248f37` |

No COLMAP, ALIKED, or MVS operation ran.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS on final attempt 3; the first attempt found three local TypeScript errors, attempt 2 passed, and the final exact-tree attempt passed. The command includes the English UI check. |
| `CARGO_TARGET_DIR=target/photolab CARGO_BUILD_JOBS=4 pnpm --filter @himmelcad/photolab test` | PASS on final attempt 3 — renderer 94/94, Electron 10/10, processing-report contract, and Cap-import architecture contract. Attempt 1 exposed a Node test-resolution issue; attempt 2 and the final exact-tree attempt passed. |
| `pnpm --filter @himmelcad/app test` | PASS on attempts 1 and 2 — 83/83; generated-table freshness included. |
| G-1 PhotoLab command-row coverage | PASS — all three G-1 assertions; also included in the final 94-test renderer run. |
| `node scripts/check-photolab-english-ui.mjs` | PASS; also passed inside the final PhotoLab typecheck. |
| `node scripts/generate-command-table.mjs --check` | PASS — generated outputs current. |
| `git diff --check` | PASS. |

Every gate stayed within the three-attempt limit. Commands that could invoke
Rust inherited `CARGO_TARGET_DIR=target/photolab` and a four-job limit; this
package did not run a Rust build or photogrammetry pipeline.

## Change surface

The automation schema and generator own the new metadata; both generated table
outputs changed. The shared app runtime exposes it, and PhotoLab's adapter,
renderer integration, Vite source alias, tests, private-display launcher,
WP-G2 status row, and release checklist consume or verify it. Builder's console
adapter remains a consumer of the same generated table and its app tests pass.
The Python SDK/router surface from PL-I2 is unchanged.

