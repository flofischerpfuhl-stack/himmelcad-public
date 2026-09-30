# Assembler — own OCCT WebAssembly build (spike, 2026-09-30)

Status: **integrated behind a build flag** (`HIMMELCAD_OCCT=himmelcad`,
default stays `replicad-opencascadejs` 1.1.0), merged into
`feat/assembler-phase0-20260929` together with the interop work (IGES and the
XCAF STEP reader are wired, see "Integration"). Recipe and records:
`vendor/occt-wasm/` (README, `build.sh`, `artifacts.sha256`),
`LICENSES/THIRD_PARTY.md` ("`@himmelcad/occt-wasm` 8.0.1-hc.2"),
`scripts/check-licenses.mjs`. The built module lives in a local artifact cache
outside git (owner decision 2026-09-30, see "Switching the default").

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

## Integration (2026-09-30, `feat/assembler-phase0-20260929`)

- **XCAF STEP reader** (`renderer/src/kernel/stepXcafImport.ts`): with the
  HimmelCAD module, STEP assemblies are read by `STEPCAFControl_Reader`; the
  text-parser route of the interop work stays the default-module path and the
  fallback. Both routes give identical bodies (names, colours, folders, face
  order/keys, placements; `test/kernel/occtInterop.test.ts`), so a project
  replays to the same body ids on either module. The stock bindings could not
  read XCAF names (`Standard_GUID` unbound, so no `TDF_Label::FindAttribute`)
  nor list components (`TDF_LabelSequence`'s base unbound), so the recipe got
  a second facade, `build-config/wrappers/himmelcad-xcaf.cpp`
  (`HimmelcadXcaf`: label name as UTF-8, child labels) → version
  **8.0.1-hc.2** (one ~21 min relink; `.js` loader byte-identical to hc.1,
  `.wasm` +1.2 kB).
- **IGES** (`renderer/src/kernel/igesExchange.ts`): import as one Import step
  (`importStep` with `format: "iges"`; surfaces sewn, closed shells → solids),
  export as trimmed surfaces or MSBO solids with a unit. File menu / command
  search / drop target, agent API `import.iges` / `export.iges`,
  `interop.formats` availability, Python `import_iges` / `export_iges`. On the
  default module everything IGES stays disabled with "not in this build"
  (`unsupported` in the API). Details: `INTEROP.md` "IGES".
- **Local artifact cache + verification** (`apps/assembler/headless/occtModule.ts`,
  shared by `vite.config.ts`): `HIMMELCAD_OCCT_DIR`, else
  `<cache root>/<version>` (Windows `D:\AgentWork\HimmelCAD-Assembler\occt-wasm`,
  elsewhere `~/.cache/himmelcad/occt-wasm`, `HIMMELCAD_OCCT_CACHE` overrides);
  `himmelcad_occt.{js,wasm}` must match `artifacts.sha256`, otherwise the build
  or headless load stops with "custom OCCT module missing or wrong hash — run
  vendor/occt-wasm/build.sh or set HIMMELCAD_OCCT_DIR" (never a silent fallback;
  `test/kernel/occtModule.test.ts`: override, default path, missing dir,
  missing file, wrong hash). `build.sh --install <cache root>` fills the cache.
  Verification costs 40–60 ms per Node load (SHA-256 of 25 MB); the app build
  bundles the module into its assets, so installed apps do not need the cache.
- Dev server fix: Vite's raw `/@fs/` middleware cannot serve a file on another
  drive than the working copy on Windows; `vite.config.ts` serves the cached
  `.wasm` itself (dev only).

## Not done (follow-up)

- **Default switch**: prepared, not done (see "Switching the default").
- IGES keeps geometry only (`IGESCAFControl_Writer/Reader` are not bound):
  names/colours through IGES would need those classes in the recipe.
- Offset Face with tangent neighbours still uses the slab route; offering the
  OCCT tangent-chain offset as an explicit option is a product decision.
- Delete Face of faces OCCT cannot heal (e.g. a plain box top) still fails;
  that is geometry, not the build.
- `BRepOffset_MakeOffset` members OCCT declares but does not define stay
  unexposed; `GetAnalyse`, `OffsetFacesFromShapes` could be added to the facade
  if needed.

## Switching the default (decision memo, 2026-09-30)

**Owner decision (2026-09-30):** no artifact hosting, nothing in git or LFS.
The module lives in a local cache per machine, is SHA-256-verified against
`vendor/occt-wasm/artifacts.sha256`, and a missing or wrong module fails
loudly; `HIMMELCAD_OCCT=replicad` stays the explicit opt-out. The default is
switched in the final Block-6 integration after an A/B benchmark on a quiet
host — **not in this integration** (`DEFAULT_OCCT_MODULE` is still
`replicad`).

**Ready now:** the resolver and its checks
(`apps/assembler/headless/occtModule.ts`, used by the app build and the
headless CLI/tests/bench; tests for override, default path, missing
directory/file and hash mismatch), versioned cache directories
(`D:\AgentWork\HimmelCAD-Assembler\occt-wasm\8.0.1-hc.2` on this host; hc.1
kept for reference), `build.sh --install`, and both module variants green on
the full suite (see "Verification").

**What the switch needs:**

1. `DEFAULT_OCCT_MODULE = 'himmelcad'` (one line) and the "opt-in" wording in
   `vendor/occt-wasm/README.md`, `LICENSES/THIRD_PARTY.md`,
   `docs/DEPENDENCY-POLICY.md`.
2. The cache on every machine that builds or tests: `build.sh --install`
   (Linux/WSL as root: one-off ~2.4 GB download, 8.6 GB unpacked, ~25 min;
   then ~21 min link on 2 cores), or a copy of a cache directory from another
   machine — the hash check makes a copy as trustworthy as a local build.
   Machines without it must set `HIMMELCAD_OCCT=replicad` (and then skip the
   HimmelCAD-only tests).
3. CI, without hosting or purchased services, has two options for the owner:
   (a) build the module in CI on a cache miss and keep it in the CI's own
   cache keyed by `artifacts.sha256` (first run ~45 min, then a restore);
   (b) keep CI on `replicad` explicitly and run the HimmelCAD suite on the
   Windows host / dev machines — then CI does not cover the default module.
4. Releases: the app build bundles the verified module into its assets
   (`assets/himmelcad_occt-<hash>.{js,wasm}`), so installed apps need no cache.
5. The quiet-host A/B benchmark (below: this host was 31–100 % busy).

**LGPL-2.1 (modified build):** releases that ship the module must make the
corresponding source available. Publishing the recipe — `vendor/occt-wasm`
at the release commit (build script, binding list, the two C++ facades, the
pinned public inputs: OCCT V8_0_1 via the opencascade.js image digest,
replicad's build configuration at `e4b05f67`) — satisfies that source
obligation; the binary is not stored in the repository. Already in place:
the notice in `THIRD-PARTY-NOTICES.txt`, and the module stays a separately
replaceable asset pair (the user's right to relink/replace). Residual risk:
the pinned inputs must stay obtainable for as long as the source is offered
(mirror the toolchain image, or document the from-source image build, before
the first release with the module).

**Measured cost / benefit** (this integration, `bench:kernel`, 4 interleaved
pairs of fresh processes, order alternated, host CPU 31–100 % busy from other
agents; median and range):

| Part                              |         replicad full / edit #2 / last edit (ms) |        HimmelCAD full / edit #2 / last edit (ms) |
| --------------------------------- | -----------------------------------------------: | -----------------------------------------------: |
| demo bracket (7 features)         |         140 (102–188) / 98 (73–153) / 30 (23–47) |         136 (102–212) / 99 (72–107) / 27 (23–54) |
| features-branch part (9 features) |       139 (124–249) / 123 (101–273) / 29 (26–62) |        127 (108–170) / 118 (90–151) / 29 (24–34) |
| synthetic plate (60 features)     | 3247 (2816–6045) / 3201 (2669–5667) / 59 (53–89) | 3287 (2644–3539) / 2779 (2689–2983) / 52 (51–66) |
| preview, plate                    |                                      65 (54–111) |                                       56 (53–65) |
| wasm load in the bench            |                                    362 (291–647) |               379 (332–833), incl. 40–60 ms hash |

- Cost: +2.37 MB `.wasm` (+10.3 %), +0.33 MB brotli for the worker
  download; load +5 % here (+15–35 % compile in the spike's quieter runs);
  40–60 ms SHA-256 check per Node load; the build infrastructure (Linux/WSL
  root, 8.6 GB, ~45 min first build) and a cache on every machine; the recipe
  must follow replicad's toolchain on upgrades.
- Evaluation: no regression demonstrated — every median difference is inside
  the run-to-run spread (the plate's edit #2 median is 13 % faster on the
  HimmelCAD module, which is noise on this host). Confirm on a quiet host.
- Benefit (all with fallbacks on the default module): true Offset Face
  (trapezoid top +2 mm: 1 680 mm³, 6 faces, no step — the slab route gives
  1 700 with a step), Delete Face by defeaturing (a boss removed: 4 180 →
  4 000 mm³, 6 faces), per-wall shell thickness in one operation (walls
  thinner than the shell), IGES import/export, OCCT's XCAF STEP reader
  (instance colours; structures the text parser does not follow).

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
| `test:acceptance`                                                               | 14/14 pass                                               | not run (spike); 14/14 (integration)                                     |
| `bench:kernel`                                                                  | see "Sizes and times"                                    | see "Sizes and times"                                                    |
| `node scripts/check-licenses.mjs --pnpm`                                        | pass (236 packages incl. `vendor/occt-wasm`)             |                                                                          |
| replicad relink vs npm                                                          | `.js`, `.d.ts` identical; `.wasm` 6 bytes of code differ |                                                                          |

Integration run (2026-09-30, `feat/assembler-phase0-20260929` after the
interop + OCCT-build merges, module 8.0.1-hc.2 from the cache):

| Check                                | replicad (default)                         | HimmelCAD                                      |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------------- |
| typecheck, `build`, eslint, prettier | pass                                       | pass                                           |
| `test`                               | 537: 526 pass, 11 skipped (HimmelCAD-only) | 537: 535 pass, 2 skipped (default-module-only) |
| `test:electron`                      | 7/7                                        | 7/7 (incl. packaged-app IGES drag & drop)      |
| `test:acceptance`                    | 14/14                                      | 14/14                                          |
| Python `test_assembler`              | 22/22                                      | 22/22 (incl. IGES round trip)                  |
| license check                        | pass (236 packages)                        |                                                |
| `dev:web` smoke (`shots/k7-*.png`)   |                                            | Offset Face, Delete Face, XCAF STEP, IGES pass |
