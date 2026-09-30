# Assembler — own OCCT WebAssembly build (spike, 2026-09-30)

Status: **integrated behind a build flag** (`HIMMELCAD_OCCT=himmelcad`,
default stays `replicad-opencascadejs` 1.1.0). Recipe and records:
`vendor/occt-wasm/` (README, `build.sh`, `artifacts.sha256`),
`LICENSES/THIRD_PARTY.md` ("`@himmelcad/occt-wasm` 8.0.1-hc.1"),
`scripts/check-licenses.mjs`.

## Question

`replicad-opencascadejs` 1.1.0 (OCCT 8.0.1) lacks OCCT classes the
Assembler needs (`KERNEL-SPIKE.md` "Limits"): per-face offsets
(`BRepOffset_MakeOffset::SetOffsetOnFace` — true Offset Face, variable shell
walls), `BRepAlgoAPI_Defeaturing` (Delete Face in general),
`IGESControl_Reader/Writer`, and the STEP XCAF reader. Can we build our own
module with them, on this host, as a drop-in replacement?

## How (what worked)

- **Toolchain without Docker.** replicad builds its module by running
  opencascade.js's published toolchain image
  (`ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded`) with
  `link custom_build_single.yml`. The image contains OCCT V8_0_1 compiled to
  static libraries and **every generated binding already compiled** (5 352
  objects). No Docker on the host, so `vendor/occt-wasm/tools/pull-image.py`
  fetches the linux/amd64 manifest by digest from ghcr.io (2.37 GB, every
  blob SHA-256-checked), unpacks it with OCI whiteouts (7.7 GB) under
  `/root/occt-asm/image/rootfs` in the WSL2 distro, and `build.sh` runs the
  same `./build-wasm.sh link <yaml>` in a `chroot` with the image's
  environment. Nothing under `/opt/fernwork` or `/workspace` was touched;
  the image brings its own emsdk 5.0.1.
- **Reproduction first.** Relinking replicad's unmodified configuration
  (`build-config/custom_build_single.yml` at `e4b05f67`) gave
  `replicad_single.js` and `replicad_single.d.ts` **byte-identical** to the
  npm package, and a `replicad_single.wasm` of 22 980 273 bytes vs 22 980 267:
  all sections identical (types, imports, functions, exports, data) except
  the code section, 6 bytes longer. Two relinks here are bit-identical to
  each other, so the recipe is deterministic; the published file was most
  likely linked from the image's arm64 variant (opencascade.js documents that
  native toolchains are not byte-reproducible across architectures). Same API
  surface, same bindings.
- **Extra classes.** `BRepAlgoAPI_Defeaturing`, `IGESControl_Reader`,
  `IGESControl_Writer`, `IGESControl_Controller` and `STEPCAFControl_Reader`
  are generated and precompiled in the image — adding them to the YAML is
  enough (`vendor/occt-wasm/build-config/extra-bindings.yml`, applied by
  `render-config.py`). `BRepOffset_MakeOffset` is excluded from generation by
  opencascade.js (`bindgen-filters.yaml`, "Undefined symbols"), so a small
  C++ facade `HimmelcadOffset` (`build-config/wrappers/himmelcad-offset.cpp`,
  LGPL-2.1-only) exposes the defined members (Initialize, SetOffsetOnFace,
  AddFace, MakeOffsetShape, MakeThickSolid, Shape, Error, history); the
  opencascade.js link step generates its embind code like replicad's own
  wrappers. The facade catches `Standard_Failure` instead of letting it cross
  into JS.

Nothing failed that needed a workaround beyond these; the only operational
issue: WSL stops the distro (killing `nohup` jobs) when no `wsl.exe` session
is attached, so builds run in a foreground `wsl` session.

## Sizes and times (this host: Ryzen 3 PRO 3200G, WSL2 with 2 cores / 7.8 GB, shared with other agents)

|                                                                     | replicad-opencascadejs 1.1.0 |        HimmelCAD build |
| ------------------------------------------------------------------- | ---------------------------: | ---------------------: |
| `.wasm`                                                             |                 22 980 267 B | 25 348 445 B (+10.3 %) |
| gzip -9 / brotli                                                    |            7.25 MB / 5.01 MB |      7.78 MB / 5.34 MB |
| loader `.js`                                                        |                     60 124 B |               60 121 B |
| bindings linked                                                     |                          317 |                    324 |
| Node load (compile + init), median of 5 alternating fresh processes |             422 ms (396–551) |       480 ms (381–954) |
| wasm load inside `bench:kernel`, median of 7 runs                   |                       330 ms |                 445 ms |
| link time (one link, 1 job)                                         |                   ~16–19 min |                ~20 min |

The download + unpack (~25 min on this line) is a one-off per toolchain
revision; every later change of the binding list is one ~20 min link. Peak
memory of the link was < 2 GB (wasm-opt `-O4 --converge`), well inside the
7.8 GB limit; one link at a time, no parallel compile.

`bench:kernel` (7 alternating runs per module, host CPU 28–96 % busy with
other agents' test suites — recorded per run): medians replicad → HimmelCAD
demo full 151 → 153 ms, edit #2 91 → 107, last-feature edit 26 → 35;
features part full 127 → 170, edit #2 100 → 124, last edit 31 → 36; 60-feature
plate full 2 959 → 3 819, edit #2 3 011 → 3 302, last edit 55 → 66, preview
67 → 65 ms. The per-run spread is larger than the differences (the third
series alone had HimmelCAD 25 % _faster_ on the demo, the first 45 % slower),
and an interleaved in-process A/B of full evaluations (fresh evaluator,
median of 15, 4 alternating pairs) gave demo 129/106, 65/141, 82/71, 72/69 ms
(replicad/HimmelCAD). Verdict: **no evaluation regression demonstrated, but
the "< 20 %" criterion could not be confirmed on this host**; the wasm
compile/load is ~15–35 % slower (10 % bigger module). Re-measure on a quiet
host before switching the default. The default (`replicad`) path is
unchanged: its numbers match `KERNEL-SPIKE.md` (demo last edit 26 ms, plate
last edit 53–55 ms).

## New capabilities (kernel tests)

`apps/assembler/test/kernel/occtExtras.test.ts` (runs with
`HIMMELCAD_OCCT=himmelcad`, skipped on the replicad build), all against hand
calculations:

| Case                                                                                                                                                   | Result                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offset Face +2 mm on the top of a trapezoid prism** (bottom 20, top 10, height 10, depth 10; sides inclined)                                         | volume **1 680** mm³ = (20 + 8)/2 · 12 · 10 (the slab route gives 1 700 with a step), still **6 faces**, top 8 × 10 keeps its key, both inclined sides keep their keys and grew; inward −2: 1 280 mm³, 6 faces |
| **Delete Face**: a 20 × 5 × 4 notch (its 2 faces) on a 20 × 20 × 10 block                                                                              | 4 000 mm³, 6 faces, valid                                                                                                                                                                                      |
| **Delete Face**: a 6 × 6 × 5 boss (top + 4 sides)                                                                                                      | 4 000 mm³, 6 faces, the block top is whole again (400 mm²) and keeps its key                                                                                                                                   |
| Delete Face on a plain box top (no neighbour can close it)                                                                                             | clear error "Delete Face could not remove this face: …"                                                                                                                                                        |
| **Shell with per-wall thickness** in one `MakeThickSolid` (30 × 20 × 20, open top, 2 mm; left wall 4 mm, right wall **1 mm — thinner than the shell**) | 12 000 − 25·16·18 = **4 800** mm³, valid                                                                                                                                                                       |
| **IGES round trip** (writer → file in the wasm FS → reader) of a 10 × 20 × 30 box                                                                      | surface area 2 200 mm² back                                                                                                                                                                                    |

Kernel wiring (`renderer/src/kernel/features/exactFaceOps.ts`, detection in
`kernel/occtExtras.ts`): Offset Face tries `BRepOffset_MakeOffset` (skin,
intersection joins, 0 on all other faces, `SetOffsetOnFace` on the picked
ones) and accepts it only when the solid is valid, grew/shrank as expected
and **every other face still lies on its own surface** — OCCT offsets
tangent-continuous neighbours (a fillet and the face beyond it) together with
the face, which is a different edit than "move this face"; then the existing
slab route runs (the fillet-next-to-offset reference test keeps its result).
Delete Face tries `BRepAlgoAPI_Defeaturing` first (accepted only if OCCT
reports every picked face deleted and the solid is valid), then the existing
hole/fillet/chamfer patches. Shell with per-wall thicknesses uses one
`MakeThickSolid` with `SetOffsetOnFace`, else the old shell + slabs. Names
come from OCCT's history as before; the offset face itself is not reported
as modified by `BRepOffset_MakeOffset`, so it is found on its offset surface
and keeps its key (like push/pull).

The whole assembler suite passes on both modules (see "Verification").

## Not done in the spike (follow-up)

- **IGES and STEP-assembly import/export in the product**: only the kernel
  capability is proven (test above). Menu entries, agent-API commands
  (`export.iges`, `import.iges`, STEP with names/colours via
  `STEPCAFControl_Reader` + `XCAFDoc_*`) and the Python SDK are not added.
- **Default switch**: the module is not committed (25 MB) and has no fetch
  URL; CI and other machines keep `replicad-opencascadejs` until the
  artefact is hosted (e.g. a release asset fetched and SHA-256-checked by
  `scripts/fetch-vendor.mjs`, like PotreeConverter) or built in CI.
- Offset Face with tangent neighbours still uses the slab route; offering the
  OCCT tangent-chain offset as an explicit option is a product decision.
- Delete Face of faces OCCT cannot heal (e.g. a plain box top) still fails;
  that is geometry, not the build.
- `BRepOffset_MakeOffset` members OCCT declares but does not define stay
  unexposed; `GetAnalyse`, `OffsetFacesFromShapes` could be added to the facade
  if needed.

## Risks

- **Toolchain source**: the recipe links against the published opencascade.js
  image (precompiled OCCT + bindings) — the same inputs replicad uses, pinned
  by digest, but a from-source rebuild of that image (OCCT + ~5 000 bindings)
  was not attempted here (hours on 2 cores; opencascade.js `Dockerfile` /
  `build-wasm.sh full` at `ebd263f1`). If ghcr.io drops the canary tag, the
  digest still pins the content only as long as the registry keeps it —
  mirror the image (or build it) before relying on it.
- **Byte difference to npm**: 6 bytes of code differ from the published
  replicad wasm (architecture of the linking host); functionally equivalent
  by construction, not proven by execution beyond the full test suite.
- **LGPL condition 3**: this is a modified build. Any release that ships it
  must publish `vendor/occt-wasm` at that commit (notice text already says so).
- **Size**: +2.37 MB raw / +0.33 MB brotli for the worker download.

## Verification

`vendor/occt-wasm/build.sh` was run end to end in the WSL distro after the
exploratory builds (image unpacked again from the cached, re-verified
blobs; link 1 250 s): all four outputs are **bit-identical** to
`artifacts.sha256`.

| Check                                                                           | replicad (default)                                       | HimmelCAD (`HIMMELCAD_OCCT=himmelcad`)                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm --filter @himmelcad/assembler typecheck`                                  | pass                                                     | (same sources)                                                           |
| `test` (assembler suite)                                                        | 483 tests: 478 pass, 5 skipped (the new extras tests)    | 483 pass                                                                 |
| `build`                                                                         | pass                                                     | pass; `assets/himmelcad_occt-<hash>.{js,wasm}` replace the replicad pair |
| `test:electron` (production Electron, incl. browser-worker vs Node determinism) | 5/5 pass                                                 | 5/5 pass                                                                 |
| `test:acceptance`                                                               | 14/14 pass                                               | not run                                                                  |
| `bench:kernel`                                                                  | see "Sizes and times"                                    | see "Sizes and times"                                                    |
| `node scripts/check-licenses.mjs --pnpm`                                        | pass (236 packages incl. `vendor/occt-wasm`)             |                                                                          |
| replicad relink vs npm                                                          | `.js`, `.d.ts` identical; `.wasm` 6 bytes of code differ |                                                                          |
