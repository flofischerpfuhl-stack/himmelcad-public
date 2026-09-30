# `vendor/occt-wasm` — HimmelCAD build of OCCT 8.0.1 as WebAssembly

LGPL-2.1-only (OCCT with the Open CASCADE exception 1.0; opencascade.js
bindings). Record: `LICENSES/THIRD_PARTY.md` ("`@himmelcad/occt-wasm`").
Spike report: `assembler/OCCT-BUILD-SPIKE.md`.

A drop-in replacement for npm `replicad-opencascadejs` 1.1.0 (same OCCT
revision, same opencascade.js toolchain and flags, same Emscripten loader
contract, every replicad binding kept) with these OCCT classes added:

| Binding                                                  | Used for                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `HimmelcadOffset` (facade over `BRepOffset_MakeOffset`) | Offset Face with neighbour re-extension, per-wall shell thickness (`SetOffsetOnFace`)        |
| `BRepAlgoAPI_Defeaturing`                                | Delete Face / remove features                                                                |
| `IGESControl_Reader`, `IGESControl_Writer`, `IGESControl_Controller` | IGES exchange                                                                     |
| `STEPCAFControl_Reader`                                  | STEP assemblies with names/colours (the XCAF writer side is already in replicad's build)     |
| `HimmelcadXcaf` (facade, since 8.0.1-hc.2)               | XCAF label names (UTF-8) and child labels for the STEP assembly reader                       |

`BRepOffset_MakeOffset` itself is excluded from opencascade.js binding
generation (its `bindgen-filters.yaml` lists it under "Undefined symbols"), so
`build-config/wrappers/himmelcad-offset.cpp` exposes only members OCCT defines
(LGPL like the module it is compiled into). `wrappers/himmelcad-xcaf.cpp`
exists because the stock bindings lack `Standard_GUID` (so no
`TDF_Label::FindAttribute`, i.e. no `TDataStd_Name` read) and the base class
of `TDF_LabelSequence` (so no `GetComponents`/`GetFreeShapes`).

Versions: `8.0.1-hc.1` (Offset/Defeaturing/IGES/XCAF reader classes),
`8.0.1-hc.2` (+ `HimmelcadXcaf`; the `.js` loader is byte-identical, the
`.wasm` differs). `package.json` carries the current version;
`artifacts.sha256` its hashes.

## Files

| Path                                   | What                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `build.sh`                             | The recipe (Linux x86_64 as root; used in WSL2 Ubuntu 22.04). Pins every input.                   |
| `build-config/extra-bindings.yml`      | The only change to replicad's consumer YAML: 7 bindings + 2 C++ files, output name.               |
| `build-config/render-config.py`        | Applies `extra-bindings.yml` to replicad's `build-config/custom_build_single.yml` (text, no ytt). |
| `build-config/wrappers/*.cpp`          | HimmelCAD C++ wrappers compiled into the module.                                                  |
| `tools/pull-image.py`                  | Fetches the opencascade.js toolchain image by digest without Docker (every blob SHA-256-checked). |
| `artifacts.sha256`                     | SHA-256 of the recorded build outputs.                                                            |
| `dist/` (gitignored)                   | Build output: `himmelcad_occt.{js,wasm,d.ts}`, rendered YAML, build manifest. Not read by the app. |

## Rebuild / replace

```bash
# WSL2 or any x86_64 Linux, as root; ~2.4 GB download, ~8 GB unpacked, ~20 min link on 2 cores
sudo vendor/occt-wasm/build.sh --verify-replicad   # also relinks replicad's own config and checks it
```

Inputs (all public, pinned in `build.sh`): replicad commit `e4b05f67…`
(`packages/replicad-opencascadejs/build-config/`), the opencascade.js
toolchain image `ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded`
(linux/amd64 manifest `sha256:deb9be84…`; opencascade.js commit `ebd263f1…`,
OCCT `V8_0_1` = `b8f597c6…`, Emscripten 5.0.1) — the exact image replicad
used for `replicad-opencascadejs` 1.1.0. The image contains OCCT and the
generated bindings precompiled; `build.sh` performs the same `link` step
replicad's `package.json` runs in Docker, in a chroot of the unpacked image.
Building that image from source instead (OCCT + all bindings, hours on 2
cores) is opencascade.js's `Dockerfile` / `build-wasm.sh full` at the same
commit.

```bash
# … and install into the local artifact cache (Windows host via WSL):
sudo vendor/occt-wasm/build.sh --install /mnt/d/AgentWork/HimmelCAD-Assembler/occt-wasm
```

## Where the module lives: the local artifact cache (never git)

The built module is **not committed** (no git, no LFS; owner decision
2026-09-30). It lives in a local cache outside the repository, one directory
per recipe version:

- Windows default: `D:\AgentWork\HimmelCAD-Assembler\occt-wasm\<version>\`
- elsewhere: `~/.cache/himmelcad/occt-wasm/<version>/`
- `HIMMELCAD_OCCT_CACHE` overrides the root, `HIMMELCAD_OCCT_DIR` points at
  one directory directly (e.g. a module built on another machine).

Before use, `himmelcad_occt.js` and `himmelcad_occt.wasm` are checked
against `artifacts.sha256`. A missing directory, a missing file or a
different hash stops the app build / headless load with "custom OCCT module
missing or wrong hash — run vendor/occt-wasm/build.sh or set
HIMMELCAD_OCCT_DIR" — never a silent fallback to the other module.

To use a modified module deliberately: rebuild with the changed recipe
(the new hashes go into `artifacts.sha256` with a new version), or, in an
installed app, replace the `assets/himmelcad_occt-<hash>.{js,wasm}` pair
(see `LICENSES/THIRD_PARTY.md`).

## Selecting it in the app

`HIMMELCAD_OCCT=himmelcad` selects it, `HIMMELCAD_OCCT=replicad` the npm
module; unset means `DEFAULT_OCCT_MODULE` in
`apps/assembler/headless/occtModule.ts` (currently `replicad`). The same
resolver serves `apps/assembler/vite.config.ts` (app build: aliases
`replicad-opencascadejs` and its `/wasm` to the cache directory) and the
headless CLI, tests and `bench:kernel`. The kernel detects the extra classes
at runtime (`renderer/src/kernel/occtExtras.ts`,
`renderer/src/kernel/stepXcafImport.ts#xcafClasses`) and falls back to the
replicad-build routes when they are missing.
