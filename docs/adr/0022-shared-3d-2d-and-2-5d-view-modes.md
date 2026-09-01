# ADR 0022: Shared 3D, 2D and 2.5D view modes

- Status: Accepted
- Date: 2026-07-19
- Depends on: ADR 0016, ADR 0017

## Context

Himmel:CAD needs a true plan view and a plan-navigation mode that can still
acquire height from visible geometry. Existing code has one locked top-down
mode and restores a previously captured orbit camera when leaving it. That
makes a plan-to-3D transition jump to stale orientation and risks creating a
second snapping path for 2.5D.

## Decision

The shared view contract has three modes:

- `3d`: ordinary perspective/orbit scene and spatial entities.
- `2d`: locked top-down plan camera. The ordinary ranked snapping providers
  select one winning geometry target; the acquisition result deliberately
  exposes XY with `z: null`.
- `2.5d`: the identical locked camera, scene admission and ranked winner as
  `2d`, but acquisition retains the winner's source Z when it has one.

No mode selects an implicit reference surface or invents zero height. Switching
between `2d` and `2.5d` changes acquisition semantics only. It does not reload
representations, change visibility or move the camera.

Plan-only representations include entities whose required support positions
have unknown Z and rasters explicitly classified as unknown plan height. They
are admitted and prewarmed during the 3D-to-plan transition, then revealed
without a blank intermediate frame. They are not rendered in 3D until an
explicit command assigns finite height or a valid elevation/depth authority.

Entering plan mode preserves current target, top-down north orientation and
visible span. Leaving it unlocks that current camera state into 3D at the same
target, scale and north; it never restores an old orbit orientation. Explicit
temporary local profile/section frames may still capture and restore a camera,
because they are a different scoped navigation operation.

## Consequences

- Cursor providers, Tab cycling and geometry revalidation remain single-source.
- Tests compare the same winning target in both plan modes and only vary Z.
- Camera transitions can prewarm plan-only content once for both plan modes.
- Builder adapters must preserve `z: null` and may not replace it with a
  presentation plane or zero.

## Implementation mapping

- `KernelNavigationController` owns the three-mode acquisition state. It ranks
  once, preserves the selected address and presentation position, and projects
  only the returned Source coordinate for 2D.
- `KernelCameraController` morphs across the 3D/plan boundary. Plan exit derives
  a north-up perspective endpoint from the current target and orthographic span;
  it has no stored global orbit camera to restore.
- `KernelViewerScene` keeps view availability and Source-height authority out of
  canonical geometry. Plan-only entities are hidden in 3D, prewarmed once and
  revealed only after preparation. A 2D/2.5D switch performs no visibility
  writes.
- Product adapters must forward `KernelPickCandidate.worldPosition`. The numeric
  `presentationPosition` remains navigation/render state and is never committed
  as an acquired coordinate.
