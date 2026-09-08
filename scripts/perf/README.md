# Performance measurements

Run the real Viewer Core baseline from the repository root:

```sh
node scripts/perf/viewer-baseline.mjs
```

Run the baseline alone on an idle machine. The default run converts the largest
real repository fixture (103,713,735-point LAS), launches Builder with its
existing Electron/CDP browser-GPU path, rejects software adapters, and writes
JSON plus Markdown to `.build/perf/viewer-baseline-<date>.*`. Its measurements
come from the kernel's exact 2,048-frame diagnostic ring: the declared present
source is `raf-render-complete`, input and workload belong to the same presented
frame, and asynchronous GPU timestamps are matched by sequence when the adapter
supports them. It does not describe rAF alone or an OS compositor timestamp as
displayed presentation.

Reuse prepared data with `--metadata <metadata.json>`, or measure another real
LAZ/LAS with `--dataset </absolute/path/to/cloud.laz>`. Use `--no-launch --cdp
http://127.0.0.1:9223` only when Builder is already running with
`window.__hcadBuilderKernel` available; as with the existing CDP benchmark, the
script closes that browser when capture ends.

Auto-launches own the complete Builder development process group. The harness
terminates that group before closing CDP, including after an attachment
failure, so a zero-page Electron browser cannot be stranded on port 9223. Page
attachment failures include the observed page URLs and the tail of Builder's
captured output.

The pre-CDP startup allowance is 15 minutes because the normal Builder command
first performs the serialized Rust/WASM staging build and may wait behind an
active `target/builder` Cargo owner. Once CDP exists, the renderer target and
kernel still have independent 120-second bounds.

Auto-launched measurements also use a fresh temporary Electron user-data
directory and remove it after shutdown. This prevents a previously opened
Builder project from adding its own residency and fetch work to the measured
dataset. `--no-launch` deliberately uses the already-running Builder profile.

On a hybrid NVIDIA Linux workstation, select the discrete adapter through the
normal PRIME environment when that is the hardware class being qualified:

```sh
DISPLAY=:0 __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia \
  node scripts/perf/viewer-baseline.mjs
```

The adapter recorded in the resulting report is authoritative; the presence of
an NVIDIA device in `nvidia-smi` alone is not evidence that Chromium used it.
