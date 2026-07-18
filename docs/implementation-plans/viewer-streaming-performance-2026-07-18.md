# Viewer streaming performance pass

Status: safe pass implemented; invasive follow-ups deferred until subjective
viewer validation

## Constraints

- Keep the compositor-mask resize behavior. Panel animation must not resize the
  camera or recreate the presentation targets.
- Keep large geometry streamed and globally budgeted. Do not add a whole-cloud
  resident RAM shortcut.
- Keep one provider-neutral scheduler and the shared WebGPU/WebGL2 render core.

## Implemented

- Carry current-view benefit through hierarchy, fetch, decode and upload work.
  Cancel stale non-resident work, retry visible failures with bounded backoff,
  and guarantee progress for work larger than a nominal per-frame allowance.
- Use the native point-list pipeline at exactly `1.0 px`; retain portable point
  sprites for all other sizes so subpixel and larger-point semantics remain
  unchanged.
- Widen the interactive request and traversal frontier while retaining global,
  per-frame and per-dataset budgets.
- Isolate Potree's screen-space-error tuning from meshes, raster and other
  providers so point-cloud quality does not over-refine unrelated entities.
- Share immutable solid texture/sampler resources instead of allocating an
  identical pair per resident tile.
- Release compressed Brotli node payloads after decode while retaining the
  decoded data required for exact picking.

## Deliberately deferred

- A compact point GPU layout, direct GPU-ready cache artifacts and a reusable
  buffer arena. These change persistent data contracts and need a dedicated
  migration and validation pass.
- An additional visible-point cap or coverage-only refinement policy. The
  additive hierarchy already supplies coarse coverage first, and a new visual
  cap could regress the improved one-pixel quality.
- Scissoring tile selection or raster work to the currently revealed panel
  rectangle. The full-window compositor-mask architecture remains untouched so
  panel animation cannot reveal stale or blank regions.

## Verification

- Deterministic Rust scheduler and renderer tests.
- Viewer TypeScript typecheck and kernel unit suite.
- WebGL2 browser/dev run with the Sulzberg Potree fixture.
- Dev-process restart for staged WASM and Electron main-process changes.
- No synthetic performance benchmark in this pass; subjective interaction and
  settling quality are the acceptance test requested for this iteration.
