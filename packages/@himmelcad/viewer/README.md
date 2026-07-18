# @himmelcad/viewer

New product hosts use `@himmelcad/viewer/kernel`. It is the framework-free,
stable facade over the shared Rust/wgpu engine for WebGPU and WebGL2. Builder,
PhotoLab and WeltView must add only document-command, resource-URL and UI-state
adapters around this package.

## Create and dispose

```ts
import { KernelViewerSession } from '@himmelcad/viewer/kernel';

const session = await KernelViewerSession.create({
  canvas,
  wasmLoader: () => import(viewerWasmUrl),
  decodeWasmModuleUrl,
  requestFrame,
});

const navigation = session.attachNavigation({
  onActivePick(candidate) {
    selection.show(candidate?.address.entityId ?? null);
  },
});

// The host schedules this through requestAnimationFrame.
session.frame(uiIsInteracting);

// The session releases navigation, requests, workers and its GPU owner.
session.dispose();
```

One session owns one canvas/device lifetime, the global streaming scheduler,
decode workers, hardware calibration, device recovery and canonical scene. A
host must not create a second renderer or retain an internal GPU owner.

## Load canonical entities

Register immutable definitions before publishing entities that reference them:

```ts
session.registerImageResource(imageHash, width, height, rgba8);
session.registerDepthResource(depthHash, width, height, depth);
session.registerCanonicalTextureResource(texture, width, height, rgba8);
session.registerCanonicalMaterialResourceSet(materials);

const [handle] = session.loadCanonical(canonicalAdmissions);
handle.setVisible(false);
handle.setVisible(true);
handle.unload();
```

The same entity/representation lifecycle accepts:

- inline canonical geometry through `loadCanonical`;
- prepared raster and splat hierarchies through `loadPreparedHierarchy`;
- Potree through `loadPotree`;
- prepared triangle meshes and Civil TINs through `loadPreparedMesh` and
  `loadPreparedTin`.

Provider preparation stays outside the renderer. Every admission contains
stable entity and definition identities, revisions, content hashes, resource
references, relationships and placement from the canonical project model.

## Abort, progress and atomic publication

Provider loads accept `KernelViewerLoadOptions`:

```ts
const controller = new AbortController();
const handle = await session.loadPotree(input, {
  operationId: 'load/site-scan',
  signal: controller.signal,
  onProgress(progress) {
    jobs.update(progress.phase, progress.completed, progress.total);
  },
});
```

Progress is monotonic through `validating`, `fetching`, `verifying`,
`publishing` and `complete`. Abort is checked again after asynchronous resource
work and before atomic registration/publication. Failures use
`KernelViewerSessionError` with `aborted`, `loadFailed`, lifecycle or recovery
codes. Observer exceptions cannot alter viewer state.

## Source coordinates and missing Z

Picking, measurement and clipping use canonical f64 Source coordinates.
Floating origin, exaggeration and camera transforms are presentation only.

A canonical entity with any support point whose Z is absent is visible only in
locked top-down/plan mode. It is never shown in 3D orbit, flattened, draped,
projected or interpolated by the viewer. A later explicit CAD operation may
commit a new canonical revision with fully materialized XYZ positions; that new
revision becomes 3D-visible while the original revision remains unchanged.

Use `session.pick`, `measureRasterDepthSample`,
`measureRasterDepthDistance`, `setClipVolumes`, `upsertSection` and
`removeSection` for source-authoritative interaction and analysis.

## Events, diagnostics and recovery

`session.subscribe` reports frames, hardware policy, adaptive runtime quality,
load progress, typed errors, device recovery and disposal. `session.diagnostics`
aggregates capabilities, hardware policy, runtime quality, residency,
transport/decode occupancy, GPU cache costs and timing. `deviceGeneration`
increments only after a replacement GPU device has been created and canonical
definitions, live entities and presentation state have been replayed.

Entity handles, the scene, session and attached navigation remain stable across
device recovery. They become invalid after unload or session disposal as
appropriate.

## React and legacy compatibility

`KernelViewport` is a thin optional React adapter over `KernelViewerSession`.
It owns only canvas/RAF/resize and callback wiring. New framework-independent
hosts should use the session directly.

The previous Three/React package surface is isolated as
`@himmelcad/viewer/legacy`; the root import remains a deprecated compatibility
shim until the three product UI lanes finish their adapter migration. It must
not be used for new viewer work.
