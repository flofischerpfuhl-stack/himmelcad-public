# S-10 Release 0.5 interaction subset — evidence (2026-09-06)

Status: **partially landed, with the renderer-facing payload seams explicit**.

This package lands the view-local P9 resolver and Builder wiring, selection-local
segment/filter state, the shared construction and viewport bars, semantic
selection-visual policy, automation routing, component gallery records, and the
requested focused gates. It does not claim the unlanded S-08b support-role or
label-pass payloads, and it does not modify the concurrently owned Rust render
crate.

## Landed behavior

### P9 tree and layers

- `InteractionStateStore` is the requested/effective resolver for hidden,
  reference, editable, inert, and mixed presentation. Parent state is an
  effective permission ceiling; parent checkbox writes propagate to the
  subtree; Ctrl+click writes only the node; Ctrl+A applies the explicit bulk
  choice. Global defaults are stored separately and never erase overrides.
- The resolver consumes `ViewDisplayStore` snapshots through a read-only bridge.
  Builder applies subtree/all writes with one `replaceState` call, hence one P8
  display undo and no document-journal write.
- Effective renderable/selectable/snappable/editable sets feed Builder viewport
  visibility, kernel gesture picking, snapping, and the selectable-kind filter.
- `EntityTree` and its Layers view expose the four states through the shared
  Checkbox. Mixed is the neutral grey indeterminate dash.

Primary files:

- `packages/@himmelcad/app/src/interaction.ts`
- `packages/@himmelcad/ui/src/InteractionStateCheckbox.tsx`
- `packages/@himmelcad/ui/src/EntityTree.tsx`
- `apps/builder/renderer/src/App.tsx`

### Selection and curve subentities

- Whole/segment granularity and per-kind selection admission live in the S-04
  selection store, persistence record, local history, and automation executor.
- A renderer primitive slot is accepted only with a validated
  `CurveSegmentIndex`; the stored member is the canonical
  `hcad.curve-subentity-ref@1`, never a transient primitive index.
- Source edits remap only the same stable member with the same hash or an
  explicit previous-hash admission. Missing or ambiguous members are pruned
  with typed reason `Segment no longer exists`.
- Tool-specific topology-index production remains a clean input seam. It cannot
  be inferred from the current canonical polyline position array without
  inventing stable identity.

Primary file: `packages/@himmelcad/app/src/selection.ts`.

### Construction input and bottom bar

- `ConstructionInputController` makes click, polar constraint, and typed
  absolute input converge on one preview point. Fixed-fixture agreement is
  tested to `1e-6 m`.
- `ConstructionBar` is a 32 px docked/detachable strip above the 28 px viewport
  bottom bar. It renders tool-declared NumberInputs, live polar values, active
  field accent, and a fixed candidate-indicator slot.
- Viewing-box center placement is the first live Builder consumer. While armed,
  S-03 owns viewport typing, Tab/Shift+Tab traversal, candidate Up/Down, LMB, and
  the tool Escape rung. NumberInput yields after its dirty field has been
  reverted, so the next Escape cancels the tool.
- The bottom bar wires support overlay and labels to the S-08 display stream,
  whole/segments and Kinds to selection history, and 3D/2.5D/2D to camera
  history. PhotoLab receives no bar because it arms no coordinate tool and does
  not mount Builder viewport chrome.

Primary files:

- `packages/@himmelcad/app/src/constructionInput.ts`
- `packages/@himmelcad/ui/src/InteractionBars.tsx`
- `apps/builder/renderer/src/BuilderKernelViewport.tsx`
- `apps/builder/renderer/src/App.tsx`

### Selection visual contract

- Theme tokens define selection orange, its halo, and support blue in light
  and dark themes.
- `kernelSelectionVisualPolicy` resolves directed-line end arrows with bounded
  tunable pixel size, point squares, symbol anchor-only highlight, support-role
  visibility, and entity-bounds selection for clouds. Hover is suppressed for
  non-pickable entities and always for cloud/splat classes.
- The existing viewport interaction path continues to recolor selected loaded
  entities. The new semantic policy is the clean adapter for the later
  renderer payload. End-arrow, point-square, support-role geometry, and label
  pass are not falsely reported as rendered in the production viewport: their
  canonical payload/batch consumption is still outside S-10 because the Rust
  render crate and unlanded S-08b internals were explicitly excluded.

Primary files:

- `packages/@himmelcad/theme/src/tokens.css`
- `packages/@himmelcad/viewer/src/kernel/KernelSelectionVisualPolicy.ts`
- `packages/@himmelcad/ui/src/SelectionVisuals.tsx`

## Focused gates

| Gate                    | Result                                                                      | Evidence                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `G-B2-P9-TREE`          | PASS                                                                        | App tests cover propagation, mixed state, node-only changes, non-destructive global defaults, S-08 snapshot consumption, and render/pick/snap eligibility; UI test covers four-state/mixed ARIA. |
| `G-B2-SELECTION-VISUAL` | PASS for semantic policy and UI fixture; production overlay payload pending | Viewer tests cover token names, direction glyph, point square, anchor-only symbol handling, support toggle, and cloud hover suppression. UI test covers the rendered fixture.                    |
| `G-B2-SEGMENTS`         | PASS for store/adapter seam                                                 | App test covers primitive pick to stable locator, explicit edit remap, and typed deletion prune. Live tool producers remain as described above.                                                  |
| `G-B2-INPUT`            | PASS                                                                        | App tests cover tri-modal `1e-6 m` equivalence and two-stage Escape. Viewer S-03 tests cover Tab ownership and live-indicator-only Up/Down. UI test covers declared fields/polar/indicator.      |

## Verification

Commands were run from the repository root.

| Command                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @himmelcad/app test`           | **54/55 pass; one concurrent S-08 test assertion is inconsistent with its three committed history actions.** `viewRuntime.test.ts` performs `setOverride`, `setGlobalDefault`, and `replaceState`, calls `undo()` once, then expects the pre-`setGlobalDefault` value. The store correctly reverses only `replaceState`, leaving the global value hidden. S-08 files were left untouched per the concurrency instruction. All S-10 app gates pass. |
| `pnpm --filter @himmelcad/ui test`            | PASS — 41/41.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm --filter @himmelcad/viewer test`        | PASS — 139/139.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm --filter @himmelcad/builder typecheck`  | PASS.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm --filter @himmelcad/photolab typecheck` | PASS; English UI check also passed.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm registry:lint`                          | PASS — all seven registry checks green.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm --filter @himmelcad/ui gallery:shots`   | PASS — 76 screenshots for 37 sections, captured serially.                                                                                                                                                                                                                                                                                                                                                                                          |

## Gallery review

Reviewed with own eyes in both themes:

- `packages/@himmelcad/ui/gallery/shots/{light,dark}/bottom-bar.png`
- `packages/@himmelcad/ui/gallery/shots/{light,dark}/construction-bar.png`
- `packages/@himmelcad/ui/gallery/shots/{light,dark}/tree-states.png`
- `packages/@himmelcad/ui/gallery/shots/{light,dark}/selection-visuals.png`

Accepted for the S-10 component record: dimensions and clustering match G17;
focus/mixed states remain legible; orange selection and blue support roles are
visually distinct; the symbol retains its base glyph with only the anchor
selected.

## Concurrency record

- S-08 display/ViewState/bookmark work was consumed only through its public
  `ViewDisplayStore`/ViewState APIs. No S-08 display-history implementation file
  was edited for S-10.
- No file under `crates/himmelcad-render` was edited for S-10. Concurrent V-03
  render/scheduler changes visible in the shared worktree were preserved.
- Unrelated PhotoLab baseline changes and other pre-existing/shared-worktree
  changes were preserved.
