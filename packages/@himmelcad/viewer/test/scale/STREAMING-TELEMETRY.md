# Streaming telemetry gate

`KernelStreamingDriver.diagnostics().streamingTelemetry` is cumulative for one
driver lifetime and records the real provider-neutral host phases:

- `transport` counts requests only after they acquire the live request permit;
  full and byte-range requests, returned bytes, failures, cancellation and
  elapsed request time stay separate.
- `lifecycle.point`, `.mesh` and `.other` distinguish first loads, post-eviction
  revisit attempts, render-plan residency hits, evictions and successful
  revisit residency. Fetch, worker decode and atomic publication each retain
  their own counters, bytes and timings.
- A residency hit is one rendered tile reference already resident when the
  driver executes the frame plan. It is not a draw-call count.
- Tile history is bounded to the newest 262,144 identities. This keeps
  diagnostics from becoming an unbounded cache; a forgotten identity starts a
  new observation window.

Run the deterministic mixed point/mesh gate without project data, a browser or
a GPU:

```sh
pnpm --filter @himmelcad/viewer test:streaming-telemetry-scale
```

`HCAD_STREAMING_TELEMETRY_TILE_PAIRS` changes the default 64 point and 64 mesh
tiles. Its injected clock makes the timing fields reproducible structural
evidence, not a hardware benchmark. The existing `viewer-scale-gate.mjs` uses
the same diagnostics with real browser transport, workers and GPU publication.

## M2.2/M2.3 evidence

The fixture uses 64 point and 64 mesh tiles. Its baseline before caching was
256 requests: 128 byte ranges and 128 full payloads. Every revisit repeated its
fetch and worker decode.

The current gate makes 65 requests: one 1 MiB physical point page plus 64 full
mesh payloads. Sixty-three logical point reads hit that page, and every point
and mesh revisit hits the 512 MiB decoded-artifact LRU. Revisit fetches and
worker decodes therefore fall from 128 to zero while atomic restaging/upload
and the kernel residency transitions remain intact.

Physical pages are explicitly advertised by a provider through versioned
decoder parameters and validated to 0.5–4 MiB. This prevents generic HTTP
resources or servers with exact-range semantics from being silently
over-fetched. Pages share a 128 MiB byte-LRU and concurrent reads of one page
share one in-flight request.

The Rust selector already preserves additive parent coverage and reveals a
replacement frontier only when its children are completely covered. Incomplete
bounded traversals retain the last complete render frontier. Motion prediction
adds a clamped camera extrapolation only as auxiliary admission; it can prewarm
the direction of travel but never changes the current render frontier.

GPU upload publication is still per logical tile. The WebGPU/WASM renderer owns
typed GPU buffers and their destruction behind the atomic publication boundary;
the TypeScript driver has neither allocator handles nor safe suballocation
lifetimes. A shared GPU arena therefore belongs in the Rust renderer resource
allocator, with generation/fence-aware free lists and device-recovery replay.
Adding an apparent host-side arena would only add another copy and break the
single renderer owner. The existing `uploadedBytes`, draw-call and revisit
telemetry is the before-measurement for that later renderer change.
